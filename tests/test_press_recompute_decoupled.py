"""Stream 30.09. (F10): Die Druckantwort wartete auf die Neuberechnung ALLER Tasten (im Stream
3-6 s je Druck). Jetzt antwortet der Druck direkt nach der Aktion; die Anzeigen rechnet der EINE
Eval-Loop als angeforderten Lauf neu (Folge-Druecke zusammengefasst, nie zwei Schreiber), und
jede Neuberechnung misst die Dauer je Monitor-Art."""
import asyncio
import logging
import time

from deckcore.service import DeckCoreService


class Bus:
    def __init__(self):
        self.published = []

    def publish(self, topic, payload):
        self.published.append((topic, payload))


def _svc(tmp_path, *, slow_s=0.0):
    svc = DeckCoreService(Bus(), runtime_dir=tmp_path / "rt", default_buttons=[])
    state = {"count": 0}

    def bump(action, btn):
        if action.get("fail"):
            return {"success": False, "message": "kaputt"}
        state["count"] += 1
        return {"success": True, "message": str(state["count"])}

    def slow(mon, btn):
        time.sleep(slow_s)
        return state["count"]

    svc.register_action("bump", bump)
    svc.register_monitor("slowcount", slow)
    svc._buttons = [
        {"id": "inc", "default": {"title": "{value}"}, "action": {"type": "bump"},
         "monitor": {"type": "slowcount", "interval": 3600}},
        {"id": "other", "default": {"title": "{value}"}, "action": {"type": "bump", "fail": True},
         "monitor": {"type": "slowcount", "interval": 3600}},
    ]
    return svc, state


async def _run_loop(svc):
    """Nur der Eval-Loop — wie start(), ohne Integrationen (OBS, SSE, Audio)."""
    svc._loop = asyncio.get_running_loop()
    svc._recompute_wake = asyncio.Event()
    svc._stop.clear()
    return asyncio.create_task(svc._eval_loop())


async def _settle(svc, predicate, timeout=5.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return True
        await asyncio.sleep(0.02)
    return False


def test_slow_monitor_does_not_delay_the_press_response(tmp_path):
    svc, _state = _svc(tmp_path, slow_s=0.4)          # 2 Tasten x 0,4 s = 0,8 s je Lauf

    async def scenario():
        task = await _run_loop(svc)
        await _settle(svc, lambda: "inc" in svc._resolved)   # erster Takt ist durch
        t0 = time.perf_counter()
        result = await asyncio.to_thread(svc.press, "inc", "short", "panel")
        elapsed = time.perf_counter() - t0
        assert result["success"] is True and result["message"] == "1"
        assert elapsed < 0.3, f"Druckantwort wartete auf die Neuberechnung ({elapsed:.2f} s)"
        assert await _settle(svc, lambda: svc._resolved.get("inc", {}).get("title") == "1")
        await svc.stop()
        await task

    asyncio.run(scenario())


def test_quick_presses_lose_no_state_and_share_one_writer(tmp_path):
    svc, state = _svc(tmp_path, slow_s=0.15)

    async def scenario():
        task = await _run_loop(svc)
        await _settle(svc, lambda: "inc" in svc._resolved)
        for _ in range(5):
            await asyncio.to_thread(svc.press, "inc", "short", "panel")
        assert state["count"] == 5
        assert await _settle(svc, lambda: svc._resolved.get("inc", {}).get("title") == "5"), \
            svc._resolved.get("inc")
        await svc.stop()
        await task

    asyncio.run(scenario())


def test_a_failed_action_stays_a_visible_failure(tmp_path, caplog):
    svc, _state = _svc(tmp_path, slow_s=0.2)
    caplog.set_level(logging.INFO, logger="deckcore")

    async def scenario():
        task = await _run_loop(svc)
        result = await asyncio.to_thread(svc.press, "other", "short", "panel")
        assert result == {"id": "other", "success": False, "message": "kaputt", "variant": "short"}
        await svc.stop()
        await task

    asyncio.run(scenario())
    line = [r.getMessage() for r in caplog.records if r.getMessage().startswith("deck press ")][0]
    assert "success=False" in line and "msg=kaputt" in line


def test_without_a_running_loop_the_recompute_stays_synchronous_and_is_measured(tmp_path, caplog):
    svc, _state = _svc(tmp_path, slow_s=0.05)
    caplog.set_level(logging.INFO, logger="deckcore")
    svc.press("inc", "short", "panel")
    assert svc._resolved["inc"]["title"] == "1"                 # bisheriger Vertrag
    line = [r.getMessage() for r in caplog.records if r.getMessage().startswith("deck recompute ")][0]
    assert "kind=sync" in line and "buttons=2" in line and "top=slowcount:2/" in line


def test_press_passes_are_logged_with_the_cost_per_monitor_type(tmp_path, caplog):
    svc, _state = _svc(tmp_path, slow_s=0.05)
    caplog.set_level(logging.INFO, logger="deckcore")

    async def scenario():
        task = await _run_loop(svc)
        await _settle(svc, lambda: "inc" in svc._resolved)
        await asyncio.to_thread(svc.press, "inc", "short", "panel")
        assert await _settle(svc, lambda: any("kind=press" in r.getMessage() for r in caplog.records))
        await svc.stop()
        await task

    asyncio.run(scenario())
    line = [r.getMessage() for r in caplog.records if "kind=press" in r.getMessage()][0]
    assert "top=slowcount:2/" in line and "publish_ms=" in line


def _pass_recorder(svc):
    """Zeichnet jeden Lauf des Eval-Loops auf: (forced, start, ende)."""
    passes = []
    original = svc._recompute_pass

    def recorded(forced):
        start = time.monotonic()
        try:
            return original(forced)
        finally:
            passes.append((bool(forced), start, time.monotonic()))

    svc._recompute_pass = recorded
    return passes


def test_a_press_during_a_slow_tick_adds_exactly_one_press_pass(tmp_path):
    """Codex R2: tick -> press -> SOFORT noch ein tick war ein unnoetiger Live-Lauf, weil das
    Wake-Signal des Drucks liegen blieb. Nach dem Druck-Lauf wartet der Loop wieder normal."""
    svc, _state = _svc(tmp_path, slow_s=0.3)
    svc._buttons[0]["monitor"]["interval"] = 0.3           # Takt-Lauf ist langsam (0,3 s)
    passes = _pass_recorder(svc)

    async def scenario():
        task = await _run_loop(svc)
        await _settle(svc, lambda: len(passes) >= 1)
        # mitten in einen Takt druecken
        await _settle(svc, lambda: False, timeout=0.1)
        await asyncio.to_thread(svc.press, "inc", "short", "panel")
        assert await _settle(svc, lambda: any(f for f, _s, _e in passes))
        forced_at = next(i for i, (f, _s, _e) in enumerate(passes) if f)
        await _settle(svc, lambda: len(passes) > forced_at + 1, timeout=3.0)
        await svc.stop()
        await task
        return forced_at

    forced_at = asyncio.run(scenario())
    assert sum(1 for f, _s, _e in passes if f) == 1, passes
    if len(passes) > forced_at + 1:
        gap = passes[forced_at + 1][1] - passes[forced_at][2]
        assert gap >= 0.2, f"Zusatzlauf direkt nach dem Druck-Lauf ({gap:.3f} s)"


def test_a_press_during_a_press_pass_still_triggers_a_follow_up(tmp_path):
    svc, state = _svc(tmp_path, slow_s=0.3)
    passes = _pass_recorder(svc)

    async def scenario():
        task = await _run_loop(svc)
        await _settle(svc, lambda: len(passes) >= 1)
        await asyncio.to_thread(svc.press, "inc", "short", "panel")
        assert await _settle(svc, lambda: any(f for f, _s, _e in passes) or svc._recompute_requested.is_set() is False)
        await asyncio.sleep(0.1)                              # erster Druck-Lauf laeuft
        await asyncio.to_thread(svc.press, "inc", "short", "panel")
        assert await _settle(svc, lambda: svc._resolved.get("inc", {}).get("title") == "2")
        await svc.stop()
        await task

    asyncio.run(scenario())
    assert state["count"] == 2
    assert sum(1 for f, _s, _e in passes if f) >= 2, passes

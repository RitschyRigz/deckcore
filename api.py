"""
Shared FastAPI route layer for DeckCore.

A host application (e.g. RigzDeck) calls ``build_streamdeck_router(...)`` and mounts the
returned ``APIRouter`` — so every host exposes the SAME deck API (registry / resolved / stream /
press / buttons / decks + per-deck CRUD / displayfusion / icon helpers) without re-implementing
the HTTP glue. The actual logic lives in ``DeckCoreService``.

Host-specific bits are injected as hooks (so the core stays host-agnostic):
  • ``get_service(request) -> DeckCoreService`` — resolve the service for a request.
  • ``sse_response(request, topics, initial) -> Response`` — the host's SSE mechanism for
    ``GET /api/streamdeck/stream`` (e.g. sse-starlette EventSourceResponse). Optional; if omitted
    the /stream route is not mounted (the host can mount its own / clients fall back to /resolved).
  • ``static_dir: Path`` — where ``upload_icon`` / ``pick_file`` write icons (served at
    ``/static/sd_icons/user/…``). Optional; those two routes are skipped if not given.
  • ``obs_scenes() -> list[str]`` — current OBS scene names for ``populate_obs_scenes``. Optional;
    that route returns 503 if not provided.

fastapi is an optional dependency of deckcore (only needed when using this module).
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
from pathlib import Path
from typing import Callable, Optional

from fastapi import APIRouter, Body, File, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, Response


def build_streamdeck_router(
    get_service: Callable[[Request], object],
    *,
    sse_response: Optional[Callable] = None,
    static_dir: Optional[Path] = None,
    obs_scenes: Optional[Callable[[], list]] = None,
) -> APIRouter:
    """Build the shared DeckCore HTTP routes. Mount with ``app.include_router(router)``."""
    r = APIRouter(tags=["streamdeck"])

    # ── Live / Snapshot ───────────────────────────────────────────────────
    if sse_response is not None:
        @r.get("/api/streamdeck/stream")
        async def streamdeck_stream(request: Request):
            """SSE-Stream der aufgelösten Button-Visuals (fürs Plugin/Panel)."""
            svc = get_service(request)
            return sse_response(request, ["streamdeck:buttons"],
                                [("streamdeck:buttons", svc.resolved())])

    @r.get("/api/streamdeck/registry")
    def streamdeck_registry(request: Request) -> JSONResponse:
        """Volle Button-Definitionen (Pool) + Decks + Auswahl-Optionen für den Editor."""
        return JSONResponse(get_service(request).registry())

    @r.get("/api/streamdeck/resolved")
    def streamdeck_resolved(request: Request) -> JSONResponse:
        """Aktuell aufgelöste Visuals als Snapshot (Plugin-Fallback ohne SSE)."""
        return JSONResponse(get_service(request).resolved())

    @r.post("/api/streamdeck/settings")
    def streamdeck_settings(request: Request, body: dict = Body(...)) -> JSONResponse:
        """Globale Aktualisierungs-Rate setzen (ein Push für ALLE Buttons)."""
        if "tick_seconds" not in (body or {}):
            raise HTTPException(status_code=400, detail="tick_seconds fehlt")
        return JSONResponse(get_service(request).set_tick(body["tick_seconds"]))

    @r.post("/api/streamdeck/press/{bid}")
    async def streamdeck_press(bid: str, request: Request) -> JSONResponse:
        """Aktion eines Buttons ausführen (Tastendruck)."""
        svc = get_service(request)
        try:
            res = await asyncio.to_thread(svc.press, bid)
        except KeyError as e:
            raise HTTPException(status_code=404, detail=str(e))
        return JSONResponse(res)

    # ── Pool: Button anlegen/ändern/löschen ───────────────────────────────
    @r.post("/api/streamdeck/buttons")
    def streamdeck_upsert(request: Request, body: dict = Body(...)) -> JSONResponse:
        """Funktions-Button im Pool anlegen oder ändern."""
        try:
            btn = get_service(request).upsert_button(body or {})
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        return JSONResponse(btn)

    @r.delete("/api/streamdeck/buttons/{bid}")
    def streamdeck_delete(bid: str, request: Request) -> JSONResponse:
        return JSONResponse(get_service(request).delete_button(bid))

    # ── Decks: Liste + literale Routen (VOR den /{deck_id}-Routen) ─────────
    @r.post("/api/streamdeck/decks")
    def streamdeck_decks(request: Request, body: dict = Body(...)) -> JSONResponse:
        """Deck-Liste (Existenz + Reihenfolge + Label/Icon) setzen."""
        return JSONResponse(get_service(request).set_decks((body or {}).get("decks") or []))

    @r.post("/api/streamdeck/deck/add")
    def streamdeck_deck_add(request: Request, body: dict = Body(...)) -> JSONResponse:
        """Neues Deck. ``copy_from`` (optional) = Deck duplizieren. ``folder`` (optional) =
        als Ordner anlegen (nicht in der Panel-Tableiste, nur per open_deck erreichbar)."""
        b = body or {}
        return JSONResponse(get_service(request).add_deck(
            b.get("label", ""), b.get("icon", "🎛"), b.get("copy_from", ""), b.get("folder")))

    @r.post("/api/streamdeck/deck/delete")
    def streamdeck_deck_delete(request: Request, body: dict = Body(...)) -> JSONResponse:
        return JSONResponse(get_service(request).delete_deck((body or {}).get("id", "")))

    @r.post("/api/streamdeck/deck/{deck_id}/folder")
    def streamdeck_deck_folder(deck_id: str, request: Request, body: dict = Body(...)) -> JSONResponse:
        """Deck ↔ Ordner umschalten (Ordner = nicht in der Panel-Tableiste)."""
        return JSONResponse(get_service(request).set_deck_folder(deck_id, bool((body or {}).get("folder"))))

    @r.post("/api/streamdeck/deck/populate_obs_scenes")
    def streamdeck_deck_populate_scenes(request: Request, body: dict = Body(...)) -> JSONResponse:
        """Pro OBS-Szene einen Szenen-Wechsel-Button im Ziel-Deck (idempotent). Szenenquelle =
        injizierter ``obs_scenes``-Hook (Core bleibt OBS-entkoppelt)."""
        svc = get_service(request)
        b = body or {}
        if obs_scenes is None:
            raise HTTPException(status_code=503, detail="Keine OBS-Quelle konfiguriert.")
        try:
            scenes = obs_scenes() or []
        except Exception as e:  # noqa: BLE001
            raise HTTPException(status_code=503, detail=f"OBS nicht erreichbar: {e}")
        if not scenes:
            raise HTTPException(status_code=503, detail="Keine OBS-Szenen gefunden (ist OBS verbunden?).")
        deck_id = (b.get("deck_id") or "").strip()
        if not deck_id:
            label = (b.get("deck_label") or "Szenen").strip() or "Szenen"
            existing = next((d for d in svc.decks() if d["label"].lower() == label.lower()), None)
            deck_id = existing["id"] if existing else svc.add_deck(label, b.get("deck_icon") or "🎬")["id"]
        res = svc.populate_obs_scenes(deck_id, scenes)
        if not res.get("ok"):
            raise HTTPException(status_code=400, detail=res.get("reason", "populate fehlgeschlagen"))
        return JSONResponse(res)

    # ── Pro Deck: Layout / Kategorien / Reihenfolge / Items ───────────────
    @r.post("/api/streamdeck/deck/{deck_id}/layout")
    def streamdeck_deck_layout(deck_id: str, request: Request, body: dict = Body(...)) -> JSONResponse:
        return JSONResponse(get_service(request).set_deck_layout(deck_id, body or {}))

    @r.post("/api/streamdeck/deck/{deck_id}/categories")
    def streamdeck_deck_categories(deck_id: str, request: Request, body: dict = Body(...)) -> JSONResponse:
        return JSONResponse(get_service(request).set_deck_categories(deck_id, (body or {}).get("categories") or []))

    @r.post("/api/streamdeck/deck/{deck_id}/category/rename")
    def streamdeck_deck_cat_rename(deck_id: str, request: Request, body: dict = Body(...)) -> JSONResponse:
        b = body or {}
        return JSONResponse(get_service(request).rename_deck_category(deck_id, b.get("old", ""), b.get("new", "")))

    @r.post("/api/streamdeck/deck/{deck_id}/category/delete")
    def streamdeck_deck_cat_delete(deck_id: str, request: Request, body: dict = Body(...)) -> JSONResponse:
        return JSONResponse(get_service(request).delete_deck_category(deck_id, (body or {}).get("name", "")))

    # ── Pool-Kategorien (klappbare Gruppen des Button-Pools im Editor) ──────────────────────
    @r.post("/api/streamdeck/pool_categories")
    def streamdeck_pool_categories(request: Request, body: dict = Body(...)) -> JSONResponse:
        return JSONResponse(get_service(request).set_pool_categories((body or {}).get("categories") or []))

    @r.post("/api/streamdeck/pool_category/add")
    def streamdeck_pool_cat_add(request: Request, body: dict = Body(...)) -> JSONResponse:
        return JSONResponse(get_service(request).add_pool_category((body or {}).get("name", "")))

    @r.post("/api/streamdeck/pool_category/rename")
    def streamdeck_pool_cat_rename(request: Request, body: dict = Body(...)) -> JSONResponse:
        b = body or {}
        return JSONResponse(get_service(request).rename_pool_category(b.get("old", ""), b.get("new", "")))

    @r.post("/api/streamdeck/pool_category/delete")
    def streamdeck_pool_cat_delete(request: Request, body: dict = Body(...)) -> JSONResponse:
        return JSONResponse(get_service(request).delete_pool_category((body or {}).get("name", "")))

    @r.post("/api/streamdeck/buttons/{bid}/pool_category")
    def streamdeck_button_pool_cat(bid: str, request: Request, body: dict = Body(...)) -> JSONResponse:
        return JSONResponse(get_service(request).set_button_pool_category(bid, (body or {}).get("category", "")))

    @r.post("/api/streamdeck/deck/{deck_id}/reorder")
    def streamdeck_deck_reorder(deck_id: str, request: Request, body: dict = Body(...)) -> JSONResponse:
        return JSONResponse(get_service(request).reorder_deck(deck_id, (body or {}).get("ids") or []))

    @r.post("/api/streamdeck/deck/{deck_id}/item")
    def streamdeck_deck_item_add(deck_id: str, request: Request, body: dict = Body(...)) -> JSONResponse:
        b = body or {}
        return JSONResponse(get_service(request).add_item(
            deck_id, b.get("button", ""), b.get("category", ""), b.get("index")))

    @r.delete("/api/streamdeck/deck/{deck_id}/item/{button_id}")
    def streamdeck_deck_item_remove(deck_id: str, button_id: str, request: Request) -> JSONResponse:
        return JSONResponse(get_service(request).remove_item(deck_id, button_id))

    @r.post("/api/streamdeck/deck/{deck_id}/item/{button_id}")
    def streamdeck_deck_item_patch(deck_id: str, button_id: str, request: Request, body: dict = Body(...)) -> JSONResponse:
        """Item EINES Decks ändern: beliebige Kombination aus category / style / hidden / Größe (w/h) / Position (x/y)."""
        svc = get_service(request)
        b = body or {}
        res = {"ok": True}
        if "category" in b:
            res = svc.assign_item_category(deck_id, button_id, b.get("category", ""))
        if "style" in b:
            res = svc.set_item_style(deck_id, button_id, b.get("style") or {})
        if "hidden" in b:
            res = svc.set_item_hidden(deck_id, button_id, bool(b.get("hidden")))
        if "w" in b or "h" in b:
            res = svc.set_item_size(deck_id, button_id, b.get("w"), b.get("h"))
        if "x" in b or "y" in b:
            res = svc.set_item_pos(deck_id, button_id, b.get("x"), b.get("y"))
        return JSONResponse(res)

    @r.post("/api/streamdeck/deck/{deck_id}/positions")
    def streamdeck_deck_positions(deck_id: str, request: Request, body: dict = Body(...)) -> JSONResponse:
        """Bulk-Positionen aus dem gridstack-Editor (ein Save): {positions:[{button,x,y,w,h}, …]}."""
        return JSONResponse(get_service(request).set_deck_positions(deck_id, (body or {}).get("positions") or []))

    # ── DisplayFusion ─────────────────────────────────────────────────────
    @r.get("/api/displayfusion/profiles")
    def displayfusion_profiles(request: Request) -> JSONResponse:
        return JSONResponse(get_service(request).displayfusion_profiles())

    @r.get("/api/hwinfo/sensors")
    def hwinfo_sensors(request: Request) -> JSONResponse:
        """HWiNFO-Sensorliste fürs Editor-Dropdown (leer, wenn HWiNFO/Quelle nicht verfügbar)."""
        return JSONResponse(get_service(request).hwinfo_sensors())

    @r.get("/api/frametime/status")
    def frametime_status(request: Request) -> JSONResponse:
        """PresentMon-FPS/Frametime-Status (available/presenting/reason) — startet den Sampler lazy."""
        return JSONResponse(get_service(request).frametime_status())

    @r.get("/api/frametime/series")
    def frametime_series(request: Request) -> JSONResponse:
        """High-Rate-Verlauf für die Graph-Kachel. ``?kind=fps|frametime``."""
        kind = "frametime" if request.query_params.get("kind") == "frametime" else "fps"
        return JSONResponse(get_service(request).frametime_series(kind))

    @r.post("/api/streamdeck/deck/{deck_id}/populate_displayfusion")
    def streamdeck_deck_populate_df(deck_id: str, request: Request) -> JSONResponse:
        res = get_service(request).populate_displayfusion_profiles(deck_id)
        if not res.get("ok"):
            raise HTTPException(status_code=400, detail=res.get("reason", "keine Profile / unbekanntes Deck"))
        return JSONResponse(res)

    @r.post("/api/streamdeck/wavelink/build")
    def streamdeck_wavelink_build(request: Request, body: dict = Body(default={})) -> JSONResponse:
        """Legt die Wave-Link-Buttons (Geräte/Mixes/Channels) aus dem Live-Zustand IM POOL an
        (Pool-Kategorie „Wave Link") — KEINE Deck-Anlage. Platzierung per Drag&Drop im Decks-Tab."""
        res = get_service(request).populate_wavelink()
        if not res.get("ok"):
            raise HTTPException(status_code=400, detail=res.get("reason", "fehlgeschlagen"))
        return JSONResponse(res)

    @r.post("/api/streamdeck/winaudio/build")
    def streamdeck_winaudio_build(request: Request, body: dict = Body(default={})) -> JSONResponse:
        """Legt einen „Windows-Lautstärke-Regler" (Master-Fader + VU) IM POOL an (Pool-Kategorie
        „Audio") — KEINE Deck-Anlage. Platzierung per Drag&Drop im Decks-Tab."""
        res = get_service(request).populate_winaudio_volume()
        if not res.get("ok"):
            raise HTTPException(status_code=400, detail=res.get("reason", "fehlgeschlagen"))
        return JSONResponse(res)

    # ── Presets NUR in den Pool generieren (keine Deck-Platzierung) — für die Button-Pool-Ansicht ──
    @r.post("/api/streamdeck/generate/displayfusion")
    def streamdeck_generate_df(request: Request) -> JSONResponse:
        res = get_service(request).generate_displayfusion_buttons()
        if not res.get("ok"):
            raise HTTPException(status_code=400, detail=res.get("reason", "keine Profile"))
        return JSONResponse(res)

    @r.post("/api/streamdeck/generate/hwinfo")
    def streamdeck_generate_hwinfo(request: Request, body: dict = Body(default={})) -> JSONResponse:
        """Pro freigegebenem HWiNFO-Sensor einen Anzeige-Button im Pool (Kategorie „HWiNFO").
        body.render = 'value' | 'graph'."""
        res = get_service(request).generate_hwinfo_buttons((body or {}).get("render", "value"))
        if not res.get("ok"):
            raise HTTPException(status_code=400, detail=res.get("reason", "keine Sensoren"))
        return JSONResponse(res)

    @r.post("/api/streamdeck/generate/obs_scenes")
    def streamdeck_generate_obs(request: Request) -> JSONResponse:
        if obs_scenes is None:
            raise HTTPException(status_code=503, detail="Keine OBS-Quelle konfiguriert.")
        try:
            scenes = obs_scenes() or []
        except Exception as e:  # noqa: BLE001
            raise HTTPException(status_code=503, detail=f"OBS nicht erreichbar: {e}")
        if not scenes:
            raise HTTPException(status_code=503, detail="Keine OBS-Szenen gefunden (ist OBS verbunden?).")
        res = get_service(request).generate_obs_scene_buttons(scenes)
        if not res.get("ok"):
            raise HTTPException(status_code=400, detail=res.get("reason", "fehlgeschlagen"))
        return JSONResponse(res)

    # ── Wave Link (Audio-Mischpult, direkter JSON-RPC-Client) ─────────────
    @r.get("/api/wavelink/status")
    def wavelink_status(request: Request) -> JSONResponse:
        """Wave-Link-Verbindungs-/App-Status. ``?probe=1`` erzwingt einen Verbindungsversuch."""
        probe = request.query_params.get("probe") in ("1", "true", "yes")
        return JSONResponse(get_service(request).wavelink_status(probe=probe))

    @r.get("/api/wavelink/state")
    def wavelink_state(request: Request) -> JSONResponse:
        """{app, mixes, channels, outputDevices, mainOutput} — Editor-Auswahllisten + Generator."""
        return JSONResponse(get_service(request).wavelink_snapshot())

    @r.get("/api/wavelink/meters")
    def wavelink_meters(request: Request) -> JSONResponse:
        """Aktuelle VU-Pegel {meters:{id:0..1}} — das Panel pollt das schnell. ``?ids=a,b`` filtert."""
        ids_q = request.query_params.get("ids") or ""
        ids = [s for s in ids_q.split(",") if s] or None
        return JSONResponse(get_service(request).wavelink_meters(ids))

    @r.post("/api/wavelink/config")
    def wavelink_config(request: Request, body: dict = Body(...)) -> JSONResponse:
        """Wave-Link-Host/Port überschreiben (sonst Auto-Discovery) → neu verbinden + Status."""
        b = body or {}
        return JSONResponse(get_service(request).set_wavelink_config(host=b.get("host"), port=b.get("port")))

    @r.post("/api/wavelink/level")
    def wavelink_level(request: Request, body: dict = Body(...)) -> JSONResponse:
        """Stufenloser Fader: Mix-/Channel-Level (0..100) setzen.
        {target_type:'mix'|'channel', id, level, mix_id?}"""
        b = body or {}
        if "id" not in b or "level" not in b:
            raise HTTPException(status_code=400, detail="id und level erforderlich")
        return JSONResponse(get_service(request).wavelink_set_level(
            b.get("target_type", "mix"), b.get("id", ""), b.get("level", 0), b.get("mix_id", "")))

    @r.post("/api/wavelink/mute")
    def wavelink_mute(request: Request, body: dict = Body(...)) -> JSONResponse:
        """Mix-/Channel-Mute setzen/toggeln. {target_type, id, muted?, mix_id?}"""
        b = body or {}
        if "id" not in b:
            raise HTTPException(status_code=400, detail="id erforderlich")
        return JSONResponse(get_service(request).wavelink_set_mute(
            b.get("target_type", "mix"), b.get("id", ""), b.get("muted"), b.get("mix_id", "")))

    @r.post("/api/wavelink/main_output")
    def wavelink_main_output(request: Request, body: dict = Body(...)) -> JSONResponse:
        """Monitor-Hauptausgang auf ein Gerät setzen. {output_device_id, output_id?}"""
        b = body or {}
        if not b.get("output_device_id"):
            raise HTTPException(status_code=400, detail="output_device_id erforderlich")
        return JSONResponse(get_service(request).wavelink_set_main_output(
            b.get("output_device_id", ""), b.get("output_id", "")))

    # ── Windows-Standard-Ausgabegerät (winaudio) — Editor-Dropdown ────────
    @r.get("/api/winaudio/devices")
    def winaudio_devices(request: Request) -> JSONResponse:
        """Aktive Windows-Ausgabegeräte {available, devices:[{id,name}]} fürs Editor-Dropdown
        (winaudio-Action „Windows-Standard setzen" + winaudio_default-Monitor)."""
        return JSONResponse(get_service(request).winaudio_devices())

    # ── Windows-Master-Lautstärke + VU (Volume-Fader-Kachel) ──────────────
    @r.get("/api/winaudio/volume")
    def winaudio_volume(request: Request) -> JSONResponse:
        """{available, level(0..100), muted, peak(0..1)} des Master-Reglers — das Panel pollt das
        schnell fürs Live-VU + den Reglerstand. ``?device=<id>`` = bestimmtes Gerät (sonst Standard)."""
        dev = request.query_params.get("device") or ""
        return JSONResponse(get_service(request).winaudio_volume(dev))

    @r.post("/api/winaudio/volume")
    def winaudio_set_volume(request: Request, body: dict = Body(...)) -> JSONResponse:
        """Stufenloser Master-Fader: Lautstärke (0..100) setzen. {level, device_id?}"""
        b = body or {}
        if "level" not in b:
            raise HTTPException(status_code=400, detail="level erforderlich")
        return JSONResponse(get_service(request).winaudio_set_volume(b.get("level"), b.get("device_id", "")))

    @r.post("/api/winaudio/mute")
    def winaudio_set_mute(request: Request, body: dict = Body(default={})) -> JSONResponse:
        """Master-Mute setzen/umschalten. {muted?, device_id?} (muted weglassen = toggle)."""
        b = body or {}
        return JSONResponse(get_service(request).winaudio_set_mute(b.get("muted"), b.get("device_id", "")))

    @r.post("/api/streamdeck/preset")
    def streamdeck_preset(request: Request, body: dict = Body(...)) -> JSONResponse:
        """Editor-Vorlage für eine Aktion: {monitor, states, default} (+ render?) — füllt Symbol +
        Logik vor. Body {action:{…}}."""
        return JSONResponse(get_service(request).button_preset((body or {}).get("action") or {}))

    @r.post("/api/streamdeck/pick_folder")
    async def streamdeck_pick_folder() -> JSONResponse:
        """Nativer Ordner-Dialog (Windows) für die open_folder-Aktion. {path, name} (cancelled=true)."""
        ps = r'''
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.FolderBrowserDialog
$f.Description = 'Ordner waehlen'
if ($f.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { '{}'; exit }
(@{ path = $f.SelectedPath } | ConvertTo-Json -Compress)
'''
        import subprocess

        def _run() -> str:
            try:
                pr = subprocess.run(["powershell", "-NoProfile", "-STA", "-Command", ps],
                                    capture_output=True, text=True, timeout=180,
                                    creationflags=0x08000000)
                return (pr.stdout or "").strip()
            except Exception:  # noqa: BLE001
                return ""
        out = await asyncio.to_thread(_run)
        try:
            data = json.loads(out) if out else {}
        except Exception:  # noqa: BLE001
            data = {}
        path = (data.get("path") or "").strip()
        if not path:
            return JSONResponse({"ok": False, "cancelled": True})
        return JSONResponse({"ok": True, "path": path, "name": Path(path).name})

    # ── Backup / Umzug: portable Export-Datei (Config + Icons) + Import + Auto-Snapshots ──
    def _icd():
        return (Path(static_dir) / "sd_icons" / "user") if static_dir is not None else None

    @r.get("/api/streamdeck/export")
    def streamdeck_export(request: Request) -> Response:
        """Portable Backup-Datei (ZIP: Config + Custom-Icons) als Download — für Umzug/Sicherung."""
        import time as _t
        data = get_service(request).export_zip(_icd())
        fname = "rigzdeck-backup-" + _t.strftime("%Y%m%d-%H%M%S") + ".zip"
        return Response(content=data, media_type="application/zip",
                        headers={"Content-Disposition": f'attachment; filename="{fname}"'})

    @r.post("/api/streamdeck/import")
    async def streamdeck_import(request: Request, file: UploadFile = File(...)) -> JSONResponse:
        """Backup-Datei (ZIP) zurückspielen: Decks + Buttons + Icons (vorher Auto-Snapshot)."""
        raw = await file.read()
        try:
            return JSONResponse(get_service(request).import_zip(raw, _icd()))
        except Exception as e:  # noqa: BLE001
            raise HTTPException(status_code=400, detail=f"Import fehlgeschlagen: {e}")

    @r.get("/api/streamdeck/backups")
    def streamdeck_backups(request: Request) -> JSONResponse:
        return JSONResponse({"backups": get_service(request).list_backups()})

    @r.post("/api/streamdeck/backups/restore")
    def streamdeck_backups_restore(request: Request, body: dict = Body(...)) -> JSONResponse:
        try:
            return JSONResponse(get_service(request).restore_backup((body or {}).get("name", "")))
        except ValueError as e:
            raise HTTPException(status_code=404, detail=str(e))

    # ── Icon-Helfer (nur wenn static_dir gesetzt) ─────────────────────────
    if static_dir is not None:
        icon_dir = Path(static_dir) / "sd_icons" / "user"

        @r.post("/api/streamdeck/upload_icon")
        async def streamdeck_upload_icon(file: UploadFile = File(...)) -> dict:
            """Eigenes Button-Bild hochladen → static/sd_icons/user/ (URL per Inhalts-Hash)."""
            raw = await file.read()
            if not raw:
                raise HTTPException(status_code=400, detail="Leere Datei")
            if len(raw) > 4_000_000:
                raise HTTPException(status_code=413, detail="Bild zu groß (max 4 MB)")
            fname = file.filename or "icon.png"
            ext = fname.rsplit(".", 1)[-1].lower() if "." in fname else "png"
            if ext not in ("png", "jpg", "jpeg", "gif", "webp"):
                raise HTTPException(status_code=415, detail="Nur PNG/JPG/GIF/WEBP")
            stem = re.sub(r"[^a-z0-9_-]+", "-", fname.rsplit(".", 1)[0].lower()).strip("-") or "icon"
            h = hashlib.sha1(raw).hexdigest()[:8]
            icon_dir.mkdir(parents=True, exist_ok=True)
            name = f"{stem}-{h}.{ext}"
            (icon_dir / name).write_bytes(raw)
            return {"ok": True, "url": f"/static/sd_icons/user/{name}", "name": name}

        @r.post("/api/streamdeck/pick_file")
        async def streamdeck_pick_file() -> JSONResponse:
            """Nativer Datei-Dialog (Windows) zum Wählen einer .exe/.py/.lnk… für die launch-Aktion;
            extrahiert zugleich das Icon als PNG. {path, name, icon_url} (cancelled=true bei Abbruch)."""
            ps = r'''
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$f = New-Object System.Windows.Forms.OpenFileDialog
$f.Title = 'Programm oder Script waehlen'
$f.Filter = 'Programme und Scripts|*.exe;*.bat;*.cmd;*.lnk;*.py;*.ps1;*.com|Alle Dateien|*.*'
if ($f.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { '{}'; exit }
$path = $f.FileName
$icon = ''
try {
  $tmp = Join-Path $env:TEMP ('sdicon_' + [guid]::NewGuid().ToString('N') + '.png')
  $ic = [System.Drawing.Icon]::ExtractAssociatedIcon($path)
  $ic.ToBitmap().Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
  $icon = $tmp
} catch {}
(@{ path = $path; icon = $icon } | ConvertTo-Json -Compress)
'''
            import subprocess

            def _run() -> str:
                try:
                    pr = subprocess.run(["powershell", "-NoProfile", "-STA", "-Command", ps],
                                        capture_output=True, text=True, timeout=180,
                                        creationflags=0x08000000)
                    return (pr.stdout or "").strip()
                except Exception:  # noqa: BLE001
                    return ""
            out = await asyncio.to_thread(_run)
            try:
                data = json.loads(out) if out else {}
            except Exception:  # noqa: BLE001
                data = {}
            path = (data.get("path") or "").strip()
            if not path:
                return JSONResponse({"ok": False, "cancelled": True})
            icon_url = ""
            tmp_icon = (data.get("icon") or "").strip()
            try:
                if tmp_icon and Path(tmp_icon).exists():
                    raw = Path(tmp_icon).read_bytes()
                    if raw:
                        h = hashlib.sha1(raw).hexdigest()[:12]
                        icon_dir.mkdir(parents=True, exist_ok=True)
                        dest = icon_dir / f"exe-{h}.png"
                        if not dest.exists():
                            dest.write_bytes(raw)
                        icon_url = f"/static/sd_icons/user/{dest.name}"
                    try:
                        Path(tmp_icon).unlink()
                    except Exception:  # noqa: BLE001
                        pass
            except Exception:  # noqa: BLE001
                pass
            return JSONResponse({"ok": True, "path": path, "name": Path(path).stem, "icon_url": icon_url})

    return r

"""
Shared FastAPI route layer for DeckCore.

A host (RitschyBot Cockpit, RigzDeck, …) calls ``build_streamdeck_router(...)`` and mounts the
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
from fastapi.responses import JSONResponse


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
        """Neues Deck. ``copy_from`` (optional) = Deck duplizieren."""
        b = body or {}
        return JSONResponse(get_service(request).add_deck(
            b.get("label", ""), b.get("icon", "🎛"), b.get("copy_from", "")))

    @r.post("/api/streamdeck/deck/delete")
    def streamdeck_deck_delete(request: Request, body: dict = Body(...)) -> JSONResponse:
        return JSONResponse(get_service(request).delete_deck((body or {}).get("id", "")))

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
        """Item EINES Decks ändern: beliebige Kombination aus category / style / hidden."""
        svc = get_service(request)
        b = body or {}
        res = {"ok": True}
        if "category" in b:
            res = svc.assign_item_category(deck_id, button_id, b.get("category", ""))
        if "style" in b:
            res = svc.set_item_style(deck_id, button_id, b.get("style") or {})
        if "hidden" in b:
            res = svc.set_item_hidden(deck_id, button_id, bool(b.get("hidden")))
        return JSONResponse(res)

    # ── DisplayFusion ─────────────────────────────────────────────────────
    @r.get("/api/displayfusion/profiles")
    def displayfusion_profiles(request: Request) -> JSONResponse:
        return JSONResponse(get_service(request).displayfusion_profiles())

    @r.post("/api/streamdeck/deck/{deck_id}/populate_displayfusion")
    def streamdeck_deck_populate_df(deck_id: str, request: Request) -> JSONResponse:
        res = get_service(request).populate_displayfusion_profiles(deck_id)
        if not res.get("ok"):
            raise HTTPException(status_code=400, detail=res.get("reason", "keine Profile / unbekanntes Deck"))
        return JSONResponse(res)

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

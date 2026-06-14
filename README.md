# deckcore

**Generic Stream-Deck engine** — a config-driven button registry with a pluggable
capability system, a "decks" view-template model, and Preact UI modules (editor + touch
panel). deckcore is a *library*, not a standalone app: a host application embeds
`DeckCoreService`, injects its own capabilities/paths, seeds its own buttons, and serves
the UI.

It is the shared core behind two apps:

- **RigzDeck** — a lightweight standalone stream-deck app (turn any tablet into a deck).
- **RitschyBot Cockpit** — a streaming control center (private).

One engine, two apps, no double development.

## What's inside

- **`service.py`** — `DeckCoreService`:
  - eval engine (resolve-by-id) + async eval loop, publishes resolved button visuals on an
    event bus (topic `streamdeck:buttons`);
  - **capability registry** — `register_action(type, fn)` / `register_monitor(type, fn)`;
  - **deck-v2 data model** — a shared button *pool* (function only) + independent deck
    *templates* (each with its own layout / categories / ordered items); one button may live
    on many decks;
  - **generic capabilities** — actions `launch` · `http` · `flag_toggle/set` · `displayfusion`
    · `media` · `hotkey`; monitors `flag` · `file_field` · `poll` · `sse_field` ·
    `displayfusion_profile`.
- **`web/`** — Preact UI modules: `StreamDeck.jsx` (editor), `TouchDeck.jsx` (touch panel),
  `deckstyle.js`, `deck.css`, plus minimal same-origin `api.js` / `sse.js` helpers.

## Pluggable by design

The core ships only host-agnostic capabilities. A host registers extra ones via
`register_action()` / `register_monitor()` and seeds its own default buttons through the
`default_buttons=` constructor argument — so the same engine powers very different decks
**without any `if host == "..."` branching**.

```python
from deckcore.service import DeckCoreService

svc = DeckCoreService(bus, runtime_dir=..., default_buttons=[...])
svc.register_action("my_thing", lambda action, btn: {"success": True, "message": "ok"})
```

## Status

v0.1.0 — extracted from the RitschyBot project as a clean, shared core.

## License

MIT — see [LICENSE](LICENSE).

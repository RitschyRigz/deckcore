"""DeckCore — generischer Stream-Deck-Kern (Engine + Capability-Registry + Deck-v2-Modell).

Standalone-fähig, kennt keine konkrete Host-App. Hüllen instanziieren ``DeckCoreService``
und registrieren über ``register_action``/``register_monitor`` (bzw. den Hook
``_register_extra_handlers``) ihre eigenen Capabilities. Siehe ``deckcore/service.py``.

Eine Hülle ist z.B. die RigzDeck-Standalone-App — EIN geteilter Kern (kein Doppel-Dev).
"""
from .service import DeckCoreService  # noqa: F401

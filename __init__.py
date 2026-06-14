"""DeckCore — generischer Stream-Deck-Kern (Engine + Capability-Registry + Deck-v2-Modell).

Standalone-fähig, kennt KEIN RitschyBot. Hüllen instanziieren ``DeckCoreService`` und
registrieren über ``register_action``/``register_monitor`` (bzw. den Hook
``_register_extra_handlers``) ihre eigenen Capabilities. Siehe ``deckcore/service.py``.

Hüllen heute: RitschyBot-Cockpit (``cockpit/services/streamdeck.py``) und künftig die
RigzDeck-Standalone-App. Geteilt = EIN Kern (kein Doppel-Dev).
"""
from .service import DeckCoreService  # noqa: F401

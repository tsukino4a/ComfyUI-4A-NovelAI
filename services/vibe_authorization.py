from __future__ import annotations

import threading
import time


_LOCK = threading.Lock()
_TICKETS: dict[str, float] = {}
_TTL_SECONDS = 120.0


def authorization_key(node_id: str, card_id: str) -> str:
    node = str(node_id or "").strip()
    card = str(card_id or "").strip()
    if not node or len(node) > 128 or not card or len(card) > 128:
        raise ValueError("Vibe 编码授权标识无效。")
    return f"{node}:{card}"


def authorize_vibe_encode(node_id: str, card_id: str) -> None:
    key = authorization_key(node_id, card_id)
    now = time.monotonic()
    with _LOCK:
        _TICKETS[key] = now + _TTL_SECONDS
        _purge_expired(now)


def consume_vibe_encode_authorization(node_id: str, card_id: str) -> bool:
    key = authorization_key(node_id, card_id)
    now = time.monotonic()
    with _LOCK:
        expires_at = _TICKETS.pop(key, None)
        _purge_expired(now)
    return expires_at is not None and expires_at >= now


def revoke_vibe_encode_authorization(node_id: str, card_id: str) -> None:
    try:
        key = authorization_key(node_id, card_id)
    except ValueError:
        return
    with _LOCK:
        _TICKETS.pop(key, None)


def _purge_expired(now: float) -> None:
    for key in [
        key
        for key, expires_at in _TICKETS.items()
        if expires_at < now
    ]:
        _TICKETS.pop(key, None)

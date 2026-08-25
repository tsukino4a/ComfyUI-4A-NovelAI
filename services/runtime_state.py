from __future__ import annotations

from .auth import AccountCache, TokenStore


TOKEN_STORE = TokenStore()
ACCOUNT_CACHE = AccountCache(TOKEN_STORE.get_token)

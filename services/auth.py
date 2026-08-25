from __future__ import annotations

import json
import math
import os
import threading
import time
from copy import deepcopy
from pathlib import Path
from typing import Any, Callable

import requests

from .core import NovelAIError


PLUGIN_PRIVATE_DIR = "ComfyUI-4A-NovelAI"
TOKEN_FILENAME = "credentials.json"
SUBSCRIPTION_ENDPOINTS = (
    "https://image.novelai.net/user/subscription",
    "https://api.novelai.net/user/subscription",
)
TIER_NAMES = {
    0: "Paper",
    1: "Tablet",
    2: "Scroll",
    3: "Opus",
}


def comfy_user_directory() -> Path:
    try:
        import folder_paths
    except ImportError as exc:
        raise NovelAIError("当前环境无法定位 ComfyUI user 目录。") from exc
    getter = getattr(folder_paths, "get_user_directory", None)
    if getter is None:
        raise NovelAIError("当前 ComfyUI 版本不提供 user 目录接口。")
    return Path(getter())


class TokenStore:
    """Atomic local storage for a persistent API token.

    The token is intentionally stored as plaintext because it must be sent to
    NovelAI. The file is kept outside workflows and receives owner-only POSIX
    permissions where the platform supports them.
    """

    def __init__(self, user_root: Path | str | None = None):
        self._user_root = Path(user_root) if user_root is not None else None
        self._lock = threading.RLock()

    @property
    def path(self) -> Path:
        root = self._user_root if self._user_root is not None else comfy_user_directory()
        return root / PLUGIN_PRIVATE_DIR / TOKEN_FILENAME

    @staticmethod
    def _normalize(token: Any, *, allow_empty: bool = False) -> str:
        if not isinstance(token, str):
            raise NovelAIError("NovelAI Token 必须是字符串。")
        value = token.strip()
        if not value and allow_empty:
            return ""
        if not value:
            raise NovelAIError("NovelAI Token 不能为空。")
        if len(value) > 4096 or any(character in value for character in "\r\n\0"):
            raise NovelAIError("NovelAI Token 格式无效。")
        return value

    def get_token(self) -> str:
        with self._lock:
            path = self.path
            if not path.is_file():
                return ""
            try:
                document = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, UnicodeError, json.JSONDecodeError) as exc:
                raise NovelAIError("NovelAI 私有凭据文件无法读取或已经损坏。") from exc
            if not isinstance(document, dict):
                raise NovelAIError("NovelAI 私有凭据文件格式无效。")
            return self._normalize(
                document.get("persistent_api_token", ""), allow_empty=True
            )

    def configured(self) -> bool:
        return bool(self.get_token())

    def set_token(self, token: str) -> None:
        value = self._normalize(token)
        with self._lock:
            target = self.path
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
            payload = json.dumps(
                {"schema_version": 1, "persistent_api_token": value},
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")
            descriptor = os.open(
                temporary,
                os.O_WRONLY | os.O_CREAT | os.O_TRUNC,
                0o600,
            )
            try:
                with os.fdopen(descriptor, "wb") as stream:
                    stream.write(payload)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.chmod(temporary, 0o600)
                os.replace(temporary, target)
                try:
                    os.chmod(target, 0o600)
                except OSError:
                    pass
            finally:
                try:
                    temporary.unlink()
                except FileNotFoundError:
                    pass

    def clear(self) -> None:
        with self._lock:
            try:
                self.path.unlink()
            except FileNotFoundError:
                pass


def _as_nonnegative_int(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def normalize_opus_usage(payload: dict[str, Any]) -> dict[str, Any]:
    """Normalize NovelAI's rolling V5 Opus allowance."""
    usage = payload.get("usage")
    if not isinstance(usage, dict) or "percent" not in usage:
        return {"available": False}
    try:
        raw_percent = float(usage.get("percent") or 0)
    except (TypeError, ValueError):
        return {"available": False}
    if not math.isfinite(raw_percent):
        return {"available": False}
    is_negative = bool(usage.get("isNegative", usage.get("is_negative", False)))
    percent = 0.0 if is_negative else max(0.0, raw_percent)
    try:
        seconds = float(
            usage.get(
                "timeUntilNextPercent",
                usage.get("time_until_next_percent", 0),
            )
            or 0
        )
    except (TypeError, ValueError):
        seconds = 0.0
    if not math.isfinite(seconds) or seconds <= 0:
        seconds = 0.0
    refill_percent = round(86_400.0 / seconds, 1) if seconds else 0.0

    def image_estimate(value: float) -> int:
        return int(math.floor(17.3 * value + 0.5))

    return {
        "available": True,
        "percent": percent,
        "remaining_images": image_estimate(percent),
        "refill_percent_per_day": refill_percent,
        "refill_images_per_day": image_estimate(refill_percent),
        "is_negative": is_negative,
    }


def normalize_subscription(
    payload: dict[str, Any],
    *,
    updated_at: int | None = None,
) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise NovelAIError("NovelAI 账户响应不是有效对象。")
    balance = payload.get("trainingStepsLeft") or payload.get("training_steps_left")
    if not isinstance(balance, dict):
        balance = {}
    fixed = _as_nonnegative_int(
        balance.get(
            "fixedTrainingStepsLeft",
            balance.get("fixed_training_steps_left", payload.get("anlas", 0)),
        )
    )
    purchased = _as_nonnegative_int(
        balance.get(
            "purchasedTrainingSteps",
            balance.get("purchased_training_steps", payload.get("paidAnlas", 0)),
        )
    )
    raw_tier = payload.get(
        "tier",
        payload.get(
            "subscriptionTier",
            (payload.get("perks") or {}).get("tier")
            if isinstance(payload.get("perks"), dict)
            else None,
        ),
    )
    tier = TIER_NAMES.get(raw_tier, str(raw_tier or "Unknown"))
    total = fixed + purchased
    opus_usage = normalize_opus_usage(payload)
    result = {
        "configured": True,
        "tier": tier,
        "subscription_anlas": fixed,
        "paid_anlas": purchased,
        "total_anlas": total,
        "opus_usage": opus_usage,
        "updated_at": int(time.time() if updated_at is None else updated_at),
        "summary": (
            f"Subscription: {tier} | Included Anlas: {fixed} | "
            f"Purchased Anlas: {purchased} | Total: {total}"
        ),
    }
    if opus_usage["available"]:
        result["usage_percent"] = opus_usage["percent"]
        result["summary"] += (
            f" | V5 free allowance: {opus_usage['percent']:g}% "
            f"(~{opus_usage['remaining_images']} images)"
        )
    return result


class AccountCache:
    def __init__(
        self,
        token_provider: Callable[[], str],
        *,
        ttl: float = 60.0,
        session: requests.Session | Any | None = None,
        clock: Callable[[], float] = time.monotonic,
    ):
        self._token_provider = token_provider
        self._ttl = max(0.0, float(ttl))
        self._session = session or requests.Session()
        self._clock = clock
        self._lock = threading.RLock()
        self._cached: dict[str, Any] | None = None
        self._cached_at = 0.0

    def clear(self) -> None:
        with self._lock:
            self._cached = None
            self._cached_at = 0.0

    def get(self, *, force: bool = False) -> dict[str, Any]:
        now = self._clock()
        with self._lock:
            if (
                not force
                and self._cached is not None
                and now - self._cached_at < self._ttl
            ):
                return deepcopy(self._cached)
        token = self._token_provider().strip()
        if not token:
            return {
                "configured": False,
                "summary": "NovelAI Token is not configured.",
            }
        headers = {"Authorization": f"Bearer {token}"}
        last_error: Exception | None = None
        for endpoint in SUBSCRIPTION_ENDPOINTS:
            try:
                response = self._session.get(endpoint, headers=headers, timeout=30)
            except requests.RequestException as exc:
                last_error = exc
                continue
            status = int(getattr(response, "status_code", 0))
            if status in {404, 405}:
                continue
            if status == 401:
                raise NovelAIError("NovelAI Token 无效或已经失效。")
            if not 200 <= status < 300:
                last_error = NovelAIError(
                    f"NovelAI 账户查询失败（HTTP {status}）。"
                )
                continue
            try:
                normalized = normalize_subscription(response.json())
            except (ValueError, TypeError) as exc:
                last_error = exc
                continue
            with self._lock:
                self._cached = normalized
                self._cached_at = self._clock()
                return deepcopy(normalized)
        raise NovelAIError("无法读取 NovelAI 订阅与 Anlas 信息。") from last_error

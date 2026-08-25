"""HTTP routes for scheduler counts and prepared run snapshots."""

from __future__ import annotations

import logging
from typing import Any

from aiohttp import web

try:
    from ..services import scheduler
except ImportError:  # pragma: no cover - standalone test collection
    from services import scheduler  # type: ignore


logger = logging.getLogger("ComfyUI4ANovelAI")
_registered_app_ids: set[int] = set()


def _json_error(message: str, status: int = 400) -> web.Response:
    return web.json_response({"success": False, "error": message}, status=status)


async def _request_object(request: web.Request) -> dict[str, Any]:
    try:
        data = await request.json()
    except Exception as exc:
        raise ValueError("invalid json") from exc
    if not isinstance(data, dict):
        raise ValueError("json body must be object")
    return data


async def handle_scheduler_counts(request: web.Request) -> web.Response:
    try:
        data = await _request_object(request)
        result = scheduler.cycle_summary(data.get("config", {}))
        return web.json_response({"success": True, **result})
    except (ValueError, LookupError, FileNotFoundError) as exc:
        return _json_error(str(exc))
    except Exception as exc:  # pragma: no cover - runtime diagnostics
        logger.exception("NAI scheduler counts failed")
        return _json_error(f"读取 NAI 循环统计失败：{exc}", 500)


async def handle_scheduler_prepare(request: web.Request) -> web.Response:
    try:
        data = await _request_object(request)
        seed = data.get("selection_seed", data.get("seed", 0))
        prepared = scheduler.prepare_run(
            data.get("config", {}),
            data.get("task_count"),
            seed=seed,
        )
        return web.json_response({"success": True, **prepared})
    except (ValueError, LookupError, FileNotFoundError) as exc:
        return _json_error(str(exc))
    except Exception as exc:  # pragma: no cover - runtime diagnostics
        logger.exception("NAI scheduler prepare failed")
        return _json_error(f"准备 NAI 批量运行失败：{exc}", 500)


_API_ROUTES = (
    ("POST", "/nai4a/api/scheduler/counts", handle_scheduler_counts),
    ("POST", "/nai4a/api/scheduler/prepare", handle_scheduler_prepare),
)


def register_routes(app: web.Application) -> None:
    identity = id(app)
    if identity in _registered_app_ids:
        return
    for method, path, handler in _API_ROUTES:
        app.router.add_route(method, path, handler)
    _registered_app_ids.add(identity)


def add_routes() -> None:
    """Register on ComfyUI's PromptServer when running inside ComfyUI."""
    try:
        from server import PromptServer
    except (ImportError, AttributeError):
        return
    register_routes(PromptServer.instance.app)

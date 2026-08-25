from __future__ import annotations

import asyncio
import hashlib
import io
from pathlib import Path

from .client import NovelAIClient
from .core import V45_MODELS, NovelAIError, model_id
from .image_metadata import extract_image_metadata
from .reference_files import (
    MAX_REFERENCE_IMAGE_BYTES,
    load_reference_image,
    save_reference_image,
)
from .runtime_state import ACCOUNT_CACHE, TOKEN_STORE
from .vibe import (
    MAX_VIBE_BYTES,
    VIBE_EXTENSIONS,
    choose_vibe_encoding,
    find_matching_vibe,
    inspect_vibe_file,
    inspect_official_vibe_bytes,
    list_vibe_summaries,
    save_encoded_vibe,
    vibe_directory,
    vibe_preview_bytes,
)
from .vibe_authorization import (
    authorize_vibe_encode,
    consume_vibe_encode_authorization,
    revoke_vibe_encode_authorization,
)

_REGISTERED = False


def register_routes() -> None:
    global _REGISTERED
    if _REGISTERED:
        return
    try:
        from aiohttp import web
        from server import PromptServer

        routes = PromptServer.instance.routes
    except (ImportError, AttributeError):
        return

    @routes.post("/novelai4a/image/metadata")
    async def image_metadata(request):
        try:
            reader = await request.multipart()
            field = await reader.next()
            if field is None or field.name != "image":
                raise NovelAIError("缺少元数据图片。")
            data = bytearray()
            while True:
                chunk = await field.read_chunk(size=1024 * 1024)
                if not chunk:
                    break
                data.extend(chunk)
                if len(data) > 64 * 1024 * 1024:
                    raise NovelAIError("元数据图片不能超过 64 MB。")
            from PIL import Image

            with Image.open(io.BytesIO(data)) as image:
                metadata = extract_image_metadata(image)
            return web.json_response({"metadata": metadata})
        except (NovelAIError, OSError, ValueError) as exc:
            return web.json_response({"error": str(exc)}, status=400)

    @routes.get("/novelai4a/token/status")
    async def token_status(_request):
        try:
            configured = TOKEN_STORE.configured()
        except NovelAIError as exc:
            return web.json_response({"error": str(exc)}, status=500)
        return web.json_response({"configured": configured})

    @routes.post("/novelai4a/token")
    async def save_token(request):
        try:
            document = await request.json()
        except Exception:
            return web.json_response({"error": "请求必须是 JSON。"}, status=400)
        token = document.get("token") if isinstance(document, dict) else None
        if not isinstance(token, str):
            return web.json_response({"error": "token 必须是字符串。"}, status=400)
        try:
            if token.strip():
                TOKEN_STORE.set_token(token)
            else:
                TOKEN_STORE.clear()
            ACCOUNT_CACHE.clear()
            return web.json_response({"configured": TOKEN_STORE.configured()})
        except NovelAIError as exc:
            return web.json_response({"error": str(exc)}, status=400)

    @routes.delete("/novelai4a/token")
    async def delete_token(_request):
        TOKEN_STORE.clear()
        ACCOUNT_CACHE.clear()
        return web.json_response({"configured": False})

    @routes.get("/novelai4a/account")
    async def account(request):
        force = request.query.get("force", "").lower() in {"1", "true", "yes"}
        try:
            account_data = await asyncio.to_thread(ACCOUNT_CACHE.get, force=force)
            return web.json_response(account_data)
        except NovelAIError as exc:
            return web.json_response({"error": str(exc)}, status=502)

    @routes.get("/novelai4a/vibes")
    async def vibe_list(_request):
        return web.json_response({"items": list_vibe_summaries()})

    @routes.get("/novelai4a/references/image")
    async def reference_image(request):
        try:
            content = load_reference_image(request.query.get("name", ""))
            return web.Response(
                body=content,
                content_type="image/png",
                headers={
                    "Cache-Control": "no-store",
                    "X-Content-Type-Options": "nosniff",
                },
            )
        except NovelAIError as exc:
            return web.json_response({"error": str(exc)}, status=404)

    @routes.post("/novelai4a/references/upload-image")
    async def reference_image_upload(request):
        try:
            reader = await request.multipart()
            field = await reader.next()
            if field is None or field.name != "file":
                raise NovelAIError("缺少参考图片。")
            original = str(field.filename or "reference.png")
            data = bytearray()
            while True:
                chunk = await field.read_chunk(size=1024 * 1024)
                if not chunk:
                    break
                data.extend(chunk)
                if len(data) > MAX_REFERENCE_IMAGE_BYTES:
                    raise NovelAIError("参考图片不能超过 32 MB。")
            filename = save_reference_image(bytes(data), original)
            return web.json_response(
                {
                    "filename": filename,
                    "name": Path(original).stem or "参考图片",
                }
            )
        except (NovelAIError, OSError, ValueError) as exc:
            return web.json_response({"error": str(exc)}, status=400)

    @routes.get("/novelai4a/vibes/match")
    async def vibe_match(request):
        try:
            image_name = request.query.get("image", "")
            vibe_name = request.query.get("vibe", "")
            selected_model = request.query.get("model", "")
            information = float(request.query.get("information", "0.7"))
            if image_name:
                image = load_reference_image(image_name)
            elif vibe_name:
                source = inspect_vibe_file(vibe_name)
                try:
                    choose_vibe_encoding(
                        source["records"],
                        selected_model,
                        information,
                    )
                    return web.json_response(
                        {
                            "matched": True,
                            "can_encode": bool(source["images"]),
                        }
                    )
                except NovelAIError:
                    image = source["images"][0] if source["images"] else None
            else:
                raise NovelAIError("缺少要检查的图片或 Vibe 文件。")
            if image is None:
                return web.json_response({"matched": False, "can_encode": False})
            matched = find_matching_vibe(image, selected_model, information)
            if matched is None:
                return web.json_response({"matched": False, "can_encode": True})
            return web.json_response(
                {
                    "matched": True,
                    "can_encode": True,
                }
            )
        except (NovelAIError, TypeError, ValueError) as exc:
            return web.json_response({"error": str(exc)}, status=400)

    @routes.get("/novelai4a/vibes/preview")
    async def vibe_preview(request):
        try:
            content, mime = vibe_preview_bytes(
                request.query.get("name", ""),
                int(request.query.get("index", "0")),
            )
            return web.Response(
                body=content,
                content_type=mime,
                headers={
                    "Cache-Control": "no-store",
                    "X-Content-Type-Options": "nosniff",
                },
            )
        except (NovelAIError, TypeError, ValueError) as exc:
            return web.json_response({"error": str(exc)}, status=404)

    @routes.post("/novelai4a/vibes/upload")
    async def vibe_upload(request):
        try:
            reader = await request.multipart()
            field = await reader.next()
            if field is None or field.name != "file":
                raise NovelAIError("缺少 Vibe 上传文件。")
            original = str(field.filename or "vibe.naiv4vibe")
            suffix = Path(original).suffix.lower()
            if suffix not in VIBE_EXTENSIONS:
                raise NovelAIError("只支持 .naiv4vibe 和 .naiv4vibeBundle 文件。")
            data = bytearray()
            while True:
                chunk = await field.read_chunk(size=1024 * 1024)
                if not chunk:
                    break
                data.extend(chunk)
                if len(data) > MAX_VIBE_BYTES:
                    raise NovelAIError("Vibe 文件超过 128 MB 安全限制。")
            inspect_official_vibe_bytes(bytes(data), source_name=original)
            safe_name = "".join(
                "_" if char in '<>:"/\\|?*' else char
                for char in Path(original).name
            ).strip(" .")
            target = vibe_directory() / (safe_name or f"vibe{suffix}")
            if target.exists():
                digest = hashlib.sha256(data).hexdigest()[:8]
                target = target.with_name(f"{target.stem}-{digest}{target.suffix}")
            temporary = target.with_suffix(target.suffix + ".tmp")
            temporary.write_bytes(data)
            temporary.replace(target)
            return web.json_response(
                {
                    "filename": target.name,
                    "items": list_vibe_summaries(),
                }
            )
        except (NovelAIError, OSError, ValueError) as exc:
            return web.json_response({"error": str(exc)}, status=400)

    @routes.post("/novelai4a/vibes/authorize")
    async def vibe_authorize(request):
        try:
            document = await request.json()
            node_id = str(document.get("node_id") or "")
            card_id = str(document.get("card_id") or "")
            if document.get("action") == "revoke":
                revoke_vibe_encode_authorization(node_id, card_id)
                return web.json_response({"ok": True})
            authorize_vibe_encode(node_id, card_id)
            return web.json_response({"ok": True})
        except (AttributeError, ValueError) as exc:
            return web.json_response({"error": str(exc)}, status=400)

    @routes.post("/novelai4a/vibes/encode")
    async def vibe_encode(request):
        try:
            document = await request.json()
            if not isinstance(document, dict):
                raise NovelAIError("请求必须是 JSON 对象。")
            node_id = str(document.get("node_id") or "")
            card_id = str(document.get("card_id") or "")
            image_name = str(document.get("image_file") or "")
            vibe_name = str(document.get("vibe_file") or "")
            selected_model = str(document.get("model") or "")
            information = float(document.get("information_extracted", 0.7))
            strength = float(document.get("strength", 0.6))
            name = str(document.get("name") or "Vibe")
            if not 0.01 <= information <= 1:
                raise NovelAIError("Information Extracted 必须在 0.01 到 1 之间。")
            if not 0.01 <= strength <= 1:
                raise NovelAIError("Reference Strength 必须在 0.01 到 1 之间。")
            if model_id(selected_model) not in V45_MODELS:
                raise NovelAIError("当前模型不支持 V4.5 Vibe 编码。")
            if image_name:
                image = load_reference_image(image_name)
            elif vibe_name:
                source = inspect_vibe_file(vibe_name)
                try:
                    choose_vibe_encoding(
                        source["records"],
                        selected_model,
                        information,
                    )
                    return web.json_response(
                        {
                            "filename": source["filename"],
                            "cached": True,
                            "items": list_vibe_summaries(),
                        }
                    )
                except NovelAIError:
                    if not source["images"]:
                        raise NovelAIError(
                            "该 Vibe 文件不包含原图，无法补充新的 Information Extracted 编码。"
                        )
                    image = source["images"][0]
            else:
                raise NovelAIError("缺少用于 Vibe 编码的图片。")
            matched = find_matching_vibe(image, selected_model, information)
            if matched is not None:
                descriptor, _record = matched
                return web.json_response(
                    {
                        "filename": descriptor["filename"],
                        "cached": True,
                        "items": list_vibe_summaries(),
                    }
                )
            if not consume_vibe_encode_authorization(node_id, card_id):
                raise NovelAIError("Vibe 编码授权已失效，请重新点击编码按钮。")
            client = NovelAIClient(TOKEN_STORE.get_token)
            encoding = await asyncio.to_thread(
                client.encode_vibe,
                image,
                information_extracted=information,
                selected_model=selected_model,
            )
            filename = save_encoded_vibe(
                image,
                encoding,
                selected_model=selected_model,
                information_extracted=information,
                strength=strength,
                name=name,
            )
            return web.json_response(
                {
                    "filename": filename,
                    "cached": False,
                    "items": list_vibe_summaries(),
                }
            )
        except (AttributeError, NovelAIError, OSError, TypeError, ValueError) as exc:
            return web.json_response({"error": str(exc)}, status=400)

    _REGISTERED = True

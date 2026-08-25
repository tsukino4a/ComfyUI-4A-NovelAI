from __future__ import annotations

import base64
import binascii
import json
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Callable

import requests

from .core import NovelAIError, model_id
from .image_io import ImageResult, parse_image_response


GENERATION_ENDPOINT = "https://image.novelai.net/ai/generate-image"
STREAM_GENERATION_ENDPOINT = "https://image.novelai.net/ai/generate-image-stream"
VIBE_ENDPOINT = "https://image.novelai.net/ai/encode-vibe"


def _http_error(status: int) -> NovelAIError:
    if status == 400:
        return NovelAIError("NovelAI 拒绝了请求参数（HTTP 400）。")
    if status == 401:
        return NovelAIError("NovelAI Token 无效或已经失效（HTTP 401）。")
    if status == 402:
        return NovelAIError("NovelAI 订阅无效或 Anlas 不足（HTTP 402）。")
    if status == 429:
        return NovelAIError("NovelAI 请求过于频繁（HTTP 429）。")
    return NovelAIError(f"NovelAI 请求失败（HTTP {status}）。")


def _generation_retry_delays(payload: dict) -> tuple[int, ...]:
    parameters = payload.get("parameters")
    if not isinstance(parameters, dict):
        return ()
    try:
        width = int(parameters["width"])
        height = int(parameters["height"])
        steps = int(parameters["steps"])
        samples = int(parameters["n_samples"])
    except (KeyError, TypeError, ValueError):
        return ()
    vibe_count = max(
        len(parameters.get("reference_image_multiple") or ()),
        len(parameters.get("reference_image_multiple_cached") or ()),
    )
    if (
        width > 0
        and height > 0
        and width * height <= 1024 * 1024
        and 0 < steps <= 28
        and samples == 1
        and not parameters.get("image")
        and not parameters.get("director_reference_images")
        and vibe_count <= 4
    ):
        return (1, 2)
    return ()


def _is_transient_status(status: int) -> bool:
    return status in {408, 429} or 500 <= status < 600


def _connection_error(delays: tuple[int, ...]) -> NovelAIError:
    detail = (
        f"普通像素预算请求已重试 {len(delays)} 次。"
        if delays
        else "未自动重试以避免重复计费。"
    )
    return NovelAIError(f"连接 NovelAI 失败；{detail}")


def _parse_stream_response(
    response,
    on_preview: Callable[[bytes, dict[str, Any]], None] | None,
) -> list[ImageResult]:
    final_images: dict[int, bytes] = {}
    for raw_line in response.iter_lines(decode_unicode=True):
        line = (
            raw_line.decode("utf-8", errors="replace")
            if isinstance(raw_line, bytes)
            else str(raw_line or "")
        )
        if not line.startswith("data:"):
            continue
        raw_data = line[5:].strip()
        if not raw_data:
            continue
        try:
            event = json.loads(raw_data)
        except json.JSONDecodeError as exc:
            raise NovelAIError("NovelAI 流式响应包含无效 JSON。") from exc
        if not isinstance(event, dict):
            continue
        if event.get("event_type") == "error" or event.get("error"):
            raise NovelAIError(
                str(event.get("error") or event.get("message") or "流式生成失败。")
            )
        event_type = str(event.get("event_type", ""))
        if event_type not in {"intermediate", "final"}:
            continue
        image = event.get("image")
        if not isinstance(image, str) or not image:
            if event_type == "final":
                raise NovelAIError("NovelAI 最终流事件缺少图片。")
            continue
        try:
            content = base64.b64decode(image, validate=True)
        except (ValueError, binascii.Error) as exc:
            if event_type == "final":
                raise NovelAIError("NovelAI 最终流图片格式无效。") from exc
            continue
        if on_preview is not None:
            try:
                on_preview(content, event)
            except Exception:
                # Preview rendering must never invalidate a generation.
                pass
        if event_type == "final":
            final_images[int(event.get("samp_ix", len(final_images)))] = content
    if not final_images:
        raise NovelAIError("NovelAI 流式响应没有最终图片。")
    results: list[ImageResult] = []
    for index in sorted(final_images):
        results.extend(parse_image_response(final_images[index]))
    return results


class NovelAIClient:
    def __init__(
        self,
        token_provider: Callable[[], str],
        *,
        session: requests.Session | Any | None = None,
        timeout: float = 180.0,
        generation_endpoint: str = GENERATION_ENDPOINT,
        stream_generation_endpoint: str = STREAM_GENERATION_ENDPOINT,
        vibe_endpoint: str = VIBE_ENDPOINT,
    ):
        self._token_provider = token_provider
        self._session = session or requests.Session()
        self._timeout = float(timeout)
        self._generation_endpoint = generation_endpoint
        self._stream_generation_endpoint = stream_generation_endpoint
        self._vibe_endpoint = vibe_endpoint

    def _headers(self) -> dict[str, str]:
        token = self._token_provider().strip()
        if not token:
            raise NovelAIError(
                "尚未配置 NovelAI Persistent API Token，请在 ComfyUI 设置中配置。"
            )
        return {
            "Authorization": f"Bearer {token}",
            "x-correlation-id": uuid.uuid4().hex[:6],
            "x-initiated-at": datetime.now(timezone.utc).isoformat(),
        }

    def _post_multipart(
        self,
        endpoint: str,
        payload: dict,
        attachments: dict[str, bytes] | None = None,
        *,
        retry_generation: bool = False,
    ):
        files: dict[str, tuple[str, bytes | str, str]] = {
            "request": (
                "request.json",
                json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                "application/json",
            )
        }
        for field, content in (attachments or {}).items():
            if not isinstance(content, (bytes, bytearray, memoryview)) or not content:
                raise NovelAIError(f"请求附件 {field} 为空或格式无效。")
            files[field] = (f"{field}.png", bytes(content), "image/png")
        delays = _generation_retry_delays(payload) if retry_generation else ()
        for attempt in range(len(delays) + 1):
            try:
                response = self._session.post(
                    endpoint,
                    headers=self._headers(),
                    files=files,
                    timeout=self._timeout,
                )
            except requests.RequestException as exc:
                if attempt >= len(delays):
                    raise _connection_error(delays) from exc
            else:
                status = int(getattr(response, "status_code", 0))
                if 200 <= status < 300:
                    return response
                if attempt >= len(delays) or not _is_transient_status(status):
                    raise _http_error(status)
                close = getattr(response, "close", None)
                if callable(close):
                    close()
            time.sleep(delays[attempt])
        raise AssertionError("unreachable")

    def generate(
        self,
        payload: dict,
        attachments: dict[str, bytes] | None = None,
    ) -> list[ImageResult]:
        response = self._post_multipart(
            self._generation_endpoint,
            payload,
            attachments,
            retry_generation=True,
        )
        return parse_image_response(bytes(response.content))

    @staticmethod
    def _stream_payload(
        payload: dict,
        attachments: dict[str, bytes] | None,
    ) -> dict:
        encoded = {
            field: base64.b64encode(bytes(content)).decode("ascii")
            for field, content in (attachments or {}).items()
        }

        def replace(value):
            if isinstance(value, str) and value in encoded:
                return encoded[value]
            if isinstance(value, list):
                return [replace(item) for item in value]
            if isinstance(value, dict):
                return {key: replace(item) for key, item in value.items()}
            return value

        document = replace(payload)
        parameters = document.setdefault("parameters", {})
        parameters["stream"] = "sse"
        return document

    def generate_stream(
        self,
        payload: dict,
        attachments: dict[str, bytes] | None = None,
        on_preview: Callable[[bytes, dict[str, Any]], None] | None = None,
    ) -> list[ImageResult]:
        document = self._stream_payload(payload, attachments)
        delays = _generation_retry_delays(document)
        for attempt in range(len(delays) + 1):
            response = None
            retry = False
            try:
                headers = self._headers()
                headers["Accept"] = "text/event-stream"
                response = self._session.post(
                    self._stream_generation_endpoint,
                    headers=headers,
                    json=document,
                    stream=True,
                    timeout=self._timeout,
                )
                status = int(getattr(response, "status_code", 0))
                if not 200 <= status < 300:
                    if attempt < len(delays) and _is_transient_status(status):
                        retry = True
                    else:
                        raise _http_error(status)
                if not retry:
                    return _parse_stream_response(response, on_preview)
            except requests.RequestException as exc:
                if attempt >= len(delays):
                    raise _connection_error(delays) from exc
                retry = True
            finally:
                close = getattr(response, "close", None)
                if callable(close):
                    close()
            if retry:
                time.sleep(delays[attempt])
        raise AssertionError("unreachable")

    def encode_vibe(
        self,
        image_png: bytes,
        *,
        information_extracted: float,
        selected_model: str,
    ) -> bytes:
        payload = {
            "image": "image",
            "information_extracted": float(information_extracted),
            "model": model_id(selected_model),
        }
        response = self._post_multipart(
            self._vibe_endpoint, payload, {"image": image_png}
        )
        content = bytes(response.content)
        if not content:
            raise NovelAIError("NovelAI Vibe 编码接口返回了空响应。")
        content_type = str(getattr(response, "headers", {}).get("Content-Type", ""))
        if "json" in content_type:
            try:
                document = response.json()
                encoded = document.get("encoding", "")
                content = base64.b64decode(encoded, validate=True)
            except Exception as exc:
                raise NovelAIError("NovelAI Vibe 编码响应格式无效。") from exc
        return content

from __future__ import annotations

import json
from io import BytesIO
from pathlib import Path
from typing import Any

from PIL import Image

from ..services.client import NovelAIClient
from ..services.core import (
    IMAGE_UPSCALE_SCALES,
    IMAGE_SIZE_CLASSES,
    MODEL_LABELS,
    SAMPLERS,
    SCHEDULERS,
    V5_MODELS,
    NovelAIError,
    build_generation_request,
    detect_mode,
    model_id,
    resolve_image_dimensions,
    validate_sampling,
)
from ..services.image_io import (
    image_dimensions,
    mask_has_content,
    prepare_precise_reference_png,
    prepare_precise_reference_png_bytes,
    results_to_tensor,
    save_original_previews,
    tensor_to_png,
)
from ..services.reference_files import load_reference_image
from ..services.runtime_state import ACCOUNT_CACHE, TOKEN_STORE
from ..services.vibe import (
    choose_vibe_encoding,
    find_matching_vibe,
    load_official_vibe,
)


CATEGORY = "4A NovelAI"


def _create_stream_previewer(total_steps: int):
    try:
        from comfy.utils import ProgressBar
    except ImportError:
        return None

    total = max(1, int(total_steps))
    progress = ProgressBar(total)

    def show_preview(content: bytes, event: dict[str, Any]) -> None:
        try:
            with Image.open(BytesIO(content)) as source:
                source.load()
                preview = source.copy()
                image_format = str(source.format or "PNG").upper()
            if image_format not in {"JPEG", "PNG"}:
                image_format = "PNG"
            if str(event.get("event_type", "")) == "final":
                completed = total
            else:
                completed = max(1, min(total, int(event.get("step_ix", 0)) + 1))
            progress.update_absolute(
                completed,
                total,
                (image_format, preview, 768),
            )
        except Exception:
            # A malformed preview must not cancel a paid NovelAI generation.
            return

    return show_preview


class NAIModelNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": (
                    list(MODEL_LABELS),
                    {"default": "V5 Full"},
                )
            }
        }

    RETURN_TYPES = ("NAI_MODEL",)
    RETURN_NAMES = ("model",)
    FUNCTION = "select"
    CATEGORY = CATEGORY

    def select(self, model: str):
        return (model_id(model),)


class NAIUsageMonitorNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    FUNCTION = "monitor"
    CATEGORY = CATEGORY

    def monitor(self):
        return ()


def _existing_references(value: Any) -> list[dict]:
    if value is None:
        return []
    if not isinstance(value, (list, tuple)):
        raise NovelAIError("references 输入不是有效参考资源列表。")
    if not all(isinstance(item, dict) for item in value):
        raise NovelAIError("references 输入包含无效资源。")
    return list(value)


REFERENCE_IMAGE_PREFIX = "nai_ref_"
REFERENCE_DEFAULT_CONFIG = json.dumps(
    {
        "mode": "vibe",
        "encode_model": "V4.5 Full",
        "vibe_items": [],
        "precise_items": [],
    },
    ensure_ascii=False,
    separators=(",", ":"),
)


def _reference_number(
    value: Any,
    fallback: float,
    minimum: float = -5.0,
    maximum: float = 5.0,
) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = fallback
    return max(minimum, min(maximum, number))


def _normalize_reference_config(value: Any) -> dict[str, Any]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError as exc:
            raise NovelAIError(
                f"参考资源配置解析失败：第 {exc.lineno} 行第 {exc.colno} 列。"
            ) from exc
    if not isinstance(value, dict):
        raise NovelAIError("参考资源配置必须是对象。")
    mode = value.get("mode")
    if mode not in {"vibe", "precise"}:
        raise NovelAIError("参考资源配置的 mode 无效。")
    vibe_items = value.get("vibe_items")
    precise_items = value.get("precise_items")
    if not isinstance(vibe_items, list) or not isinstance(precise_items, list):
        raise NovelAIError("参考资源配置必须包含 vibe_items 和 precise_items 数组。")
    items = []
    seen = set()
    raw_items = precise_items if mode == "precise" else vibe_items
    for index, raw in enumerate(raw_items):
        if not isinstance(raw, dict):
            raise NovelAIError(f"第 {index + 1} 个参考资源必须是对象。")
        base = str(raw.get("id") or f"reference-{index + 1}").strip()
        identifier = base or f"reference-{index + 1}"
        suffix = 2
        while identifier in seen:
            identifier = f"{base}-{suffix}"
            suffix += 1
        seen.add(identifier)
        reference_content = str(
            raw.get("reference_content", "character&style")
        ).lower()
        if reference_content not in {"character", "style", "character&style"}:
            raise NovelAIError(f"第 {index + 1} 个参考资源的 reference_content 无效。")
        filename = str(raw.get("vibe_file") or "").strip()
        if filename:
            filename = filename if Path(filename).name == filename else ""
        image_filename = str(raw.get("image_file") or "").strip()
        if image_filename:
            image_filename = (
                image_filename
                if Path(image_filename).name == image_filename
                else ""
            )
        source = raw.get("source")
        if source not in {"file", "image"}:
            raise NovelAIError(f"第 {index + 1} 个参考资源的 source 无效。")
        strength = _reference_number(
            raw.get("strength"), 0.6, 0.01 if mode == "vibe" else 0.0, 1.0
        )
        fidelity = _reference_number(raw.get("fidelity"), 1.0, 0.0, 1.0)
        item = {
            "id": identifier,
            "name": str(raw.get("name") or f"参考 {index + 1}").strip()
            or f"参考 {index + 1}",
            "enabled": raw.get("enabled") is not False,
            "source": source,
            "vibe_file": filename,
            "image_file": image_filename,
            "strength": strength,
            "reference_content": reference_content,
            "fidelity": fidelity,
        }
        if mode == "vibe":
            item["information_extracted"] = _reference_number(
                raw.get("information_extracted"), 0.7, 0.01, 1.0
            )
        items.append(item)
    return {
        "mode": mode,
        "items": items,
    }


class NAIReferenceNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "config_json": (
                    "STRING",
                    {
                        "default": REFERENCE_DEFAULT_CONFIG,
                        "multiline": True,
                        "dynamicPrompts": False,
                    },
                ),
            },
        }

    RETURN_TYPES = ("NAI_REFERENCES",)
    RETURN_NAMES = ("references",)
    FUNCTION = "build"
    CATEGORY = CATEGORY

    def build(
        self,
        config_json: str,
        **dynamic_images,
    ):
        return self._build_current(
            _normalize_reference_config(config_json),
            dynamic_images=dynamic_images,
        )

    def _build_current(
        self,
        config: dict[str, Any],
        *,
        dynamic_images: dict[str, Any],
    ):
        result = []
        mode = config["mode"]
        enabled_items = [item for item in config["items"] if item["enabled"]]
        if mode == "vibe" and len(enabled_items) > 16:
            raise NovelAIError("Vibe 最多支持 16 个资源。")
        for item in enabled_items:
            card_id = item["id"]
            image_value = dynamic_images.get(f"{REFERENCE_IMAGE_PREFIX}{card_id}")
            image_png = (
                load_reference_image(item["image_file"])
                if item["image_file"]
                else None
            )
            if mode == "precise":
                if image_png is None and image_value is None:
                    raise NovelAIError(f"{item['name']} 缺少拖入的参考图片。")
                result.append(
                    {
                        "kind": "precise",
                        "source": "precise_reference",
                        "image": image_value,
                        "image_png": image_png,
                        "description": item["reference_content"],
                        "strength": float(item["strength"]),
                        "fidelity": float(item["fidelity"]),
                    }
                )
                continue

            filename = item["vibe_file"] if item["source"] == "file" else ""
            if filename:
                result.append(
                    {
                        "kind": "vibe",
                        "source": "file",
                        "records": load_official_vibe(filename),
                        "strength": float(item["strength"]),
                        "information_extracted": float(
                            item["information_extracted"]
                        ),
                    }
                )
            elif image_png is not None or image_value is not None:
                result.append(
                    {
                        "kind": "vibe",
                        "source": "image_file" if image_png is not None else "image_cache",
                        "image": image_value,
                        "image_png": image_png,
                        "strength": float(item["strength"]),
                        "information_extracted": float(
                            item["information_extracted"]
                        ),
                    }
                )
            else:
                raise NovelAIError(
                    f"{item['name']} 缺少拖入的图片或 .naiv4vibe 文件。"
                )
        return (result,)


class NAIImageInputNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "strength": (
                    "FLOAT",
                    {"default": 0.7, "min": 0.0, "max": 1.0, "step": 0.01},
                ),
                "noise": (
                    "FLOAT",
                    {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.01},
                ),
                "scale_to_budget": ("BOOLEAN", {"default": True}),
                "size_class": (list(IMAGE_SIZE_CLASSES), {"default": "Normal"}),
                "upscale": ("BOOLEAN", {"default": False}),
                "upscale_scale": (list(IMAGE_UPSCALE_SCALES), {"default": "1.5"}),
            },
            "optional": {
                "mask": ("MASK",),
            },
        }

    RETURN_TYPES = ("NAI_IMAGE_SOURCE",)
    RETURN_NAMES = ("image_source",)
    FUNCTION = "build"
    CATEGORY = CATEGORY

    def build(
        self,
        image,
        strength,
        noise,
        scale_to_budget=True,
        size_class="Normal",
        upscale=False,
        upscale_scale="1.5",
        mask=None,
    ):
        source_width, source_height = image_dimensions(image)
        width, height = resolve_image_dimensions(
            source_width,
            source_height,
            scale_to_budget=bool(scale_to_budget),
            size_class=str(size_class),
            upscale=bool(upscale),
            upscale_scale=str(upscale_scale),
        )
        return (
            {
                "image": image,
                "mask": mask if mask_has_content(mask) else None,
                "strength": float(strength),
                "noise": float(noise),
                "width": width,
                "height": height,
            },
        )


def _preflight_references(resources: list[dict]) -> None:
    kinds = [item.get("kind") for item in resources]
    if any(kind not in {"vibe", "precise"} for kind in kinds):
        raise NovelAIError("references 中包含未知资源类型。")
    if kinds.count("vibe") > 16:
        raise NovelAIError("Vibe 最多支持 16 个资源。")
    if "vibe" in kinds and "precise" in kinds:
        raise NovelAIError("NovelAI 不允许同时使用 Vibe 与 Precise Reference。")


def _resolve_references(
    resources: list[dict],
    selected_model: str,
) -> list[dict]:
    resolved = []
    for resource in resources:
        if resource["kind"] == "vibe":
            information = float(resource.get("information_extracted", 0.7))
            if resource.get("source") == "file":
                record = choose_vibe_encoding(
                    resource.get("records", []), selected_model, information
                )
                encoding = record["encoding"]
                actual_information = float(
                    record.get("information_extracted", information)
                )
            elif resource.get("source") in {"image", "image_cache", "image_file"}:
                image_png = resource.get("image_png")
                if image_png is None:
                    image_png = tensor_to_png(resource.get("image"))
                matched = find_matching_vibe(
                    image_png,
                    selected_model,
                    information,
                )
                if matched is None:
                    raise NovelAIError(
                        "图片 Vibe 没有匹配的本地编码；请在参考资源节点中"
                        "点击“编码并保存（预计 2 Anlas）”。"
                    )
                _descriptor, record = matched
                encoding = record["encoding"]
                actual_information = float(record["information_extracted"])
            else:
                raise NovelAIError("Vibe 资源来源无效。")
            resolved.append(
                {
                    "kind": "vibe",
                    "encoding": encoding,
                    "strength": float(resource.get("strength", 0.6)),
                    "information_extracted": actual_information,
                }
            )
        else:
            image_png = resource.get("image_png")
            resolved.append(
                {
                    "kind": "precise",
                    "image_png": (
                        prepare_precise_reference_png_bytes(image_png)
                        if image_png is not None
                        else prepare_precise_reference_png(resource.get("image"))
                    ),
                    "description": resource.get("description", "character&style"),
                    "strength": float(resource.get("strength", 1.0)),
                    "fidelity": float(resource.get("fidelity", 1.0)),
                }
            )
    return resolved


def _character_document(value: Any) -> dict[str, Any]:
    if not isinstance(value, str):
        raise NovelAIError("characters 必须是角色 JSON 字符串。")
    try:
        document = json.loads(value or "{}")
    except json.JSONDecodeError as exc:
        raise NovelAIError(
            f"角色提示词 JSON 解析失败：第 {exc.lineno} 行第 {exc.colno} 列。"
        ) from exc
    if not isinstance(document, dict):
        raise NovelAIError("角色提示词 JSON 顶层必须是对象。")
    if not isinstance(document.get("use_coords"), bool):
        raise NovelAIError("角色提示词 JSON 的 use_coords 必须是布尔值。")
    characters = document.get("characters")
    if not isinstance(characters, list):
        raise NovelAIError("角色提示词 JSON 的 characters 必须是数组。")
    for index, item in enumerate(characters):
        label = f"第 {index + 1} 个角色"
        if not isinstance(item, dict):
            raise NovelAIError(f"{label}必须是对象。")
        if not isinstance(item.get("positive", ""), str):
            raise NovelAIError(f"{label}的 positive 必须是字符串。")
        if not isinstance(item.get("negative", ""), str):
            raise NovelAIError(f"{label}的 negative 必须是字符串。")
        if "x" not in item or "y" not in item:
            raise NovelAIError(f"{label}必须同时包含 x 和 y。")
    return document


def _image_source(value: Any) -> tuple[Any, Any, float, float, int | None, int | None]:
    if value is None:
        return None, None, 0.7, 0.0, None, None
    if not isinstance(value, dict) or value.get("image") is None:
        raise NovelAIError("image_source 必须连接 NAI 图像输入节点。")
    mask = value.get("mask")
    return (
        value["image"],
        mask if mask_has_content(mask) else None,
        float(value.get("strength", 0.7)),
        float(value.get("noise", 0.0)),
        int(value["width"]),
        int(value["height"]),
    )


class NAISamplerNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("NAI_MODEL",),
                "positive": ("STRING", {"forceInput": True}),
                "negative": ("STRING", {"forceInput": True}),
                "characters": ("STRING", {"forceInput": True}),
                "streaming": ("BOOLEAN", {"default": True}),
                "steps": (
                    "INT",
                    {"default": 28, "min": 1, "max": 50, "step": 1},
                ),
                "cfg": (
                    "FLOAT",
                    {"default": 5.0, "min": 0.0, "max": 10.0, "step": 0.1},
                ),
                "sampler": (list(SAMPLERS), {"default": "k_euler_ancestral"}),
                "scheduler": (list(SCHEDULERS), {"default": "karras"}),
                "cfg_rescale": (
                    "FLOAT",
                    {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.01},
                ),
                "width": (
                    "INT",
                    {"default": 832, "min": 64, "max": 2048, "step": 64},
                ),
                "height": (
                    "INT",
                    {"default": 1216, "min": 64, "max": 2048, "step": 64},
                ),
                "seed": (
                    "INT",
                    {"default": 0, "min": 0, "max": 0xFFFFFFFF},
                ),
            },
            "optional": {
                "references": ("NAI_REFERENCES",),
                "image_source": ("NAI_IMAGE_SOURCE",),
            },
        }

    RETURN_TYPES = ("IMAGE", "NAI_RESULT")
    RETURN_NAMES = ("image", "result")
    FUNCTION = "sample"
    CATEGORY = CATEGORY
    OUTPUT_NODE = True

    @staticmethod
    def _client() -> NovelAIClient:
        return NovelAIClient(TOKEN_STORE.get_token)

    def sample(
        self,
        model,
        positive,
        negative,
        characters,
        width,
        height,
        seed,
        steps,
        cfg,
        sampler,
        scheduler,
        cfg_rescale,
        streaming=True,
        references=None,
        image_source=None,
    ):
        selected = model_id(model)
        character_data = _character_document(characters)
        image, mask, strength, noise, image_width, image_height = _image_source(
            image_source
        )
        mode = detect_mode(image is not None, mask is not None)
        effective_width = image_width if image is not None else width
        effective_height = image_height if image is not None else height
        settings = validate_sampling(
            {
                "width": effective_width,
                "height": effective_height,
                "seed": seed,
                "steps": steps,
                "cfg": cfg,
                "sampler": sampler,
                "scheduler": scheduler,
                "cfg_rescale": cfg_rescale,
                "strength": strength,
                "noise": noise,
            }
        )
        resources = _existing_references(references)
        if selected in V5_MODELS:
            resources = []
        else:
            _preflight_references(resources)
        image_png = (
            tensor_to_png(image, width=settings["width"], height=settings["height"])
            if image is not None
            else None
        )
        mask_png = (
            tensor_to_png(
                mask,
                width=settings["width"],
                height=settings["height"],
                mask=True,
            )
            if mask is not None
            else None
        )
        client = self._client()
        resolved_references = _resolve_references(resources, selected)
        payload, attachments = build_generation_request(
            selected,
            str(positive),
            str(negative),
            settings,
            mode,
            image_png=image_png,
            mask_png=mask_png,
            characters=character_data,
            references=resolved_references,
        )
        if streaming:
            results = client.generate_stream(
                payload,
                attachments,
                on_preview=_create_stream_previewer(settings["steps"]),
            )
        else:
            results = client.generate(payload, attachments)
        ACCOUNT_CACHE.clear()
        raw_result = tuple(result.png for result in results)
        return {
            "ui": {"images": save_original_previews(results)},
            "result": (results_to_tensor(results), raw_result),
        }

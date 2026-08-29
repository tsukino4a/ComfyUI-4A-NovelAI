from __future__ import annotations

import base64
import hashlib
import hmac
import math
import os
from copy import deepcopy
from typing import Any, Iterable


class NovelAIError(RuntimeError):
    """A user-facing NovelAI request or validation error."""


MODEL_LABELS = {
    "V5 Full": "nai-diffusion-5-full",
    "V5 Curated": "nai-diffusion-5-curated",
    "V4.5 Full": "nai-diffusion-4-5-full",
    "V4.5 Curated": "nai-diffusion-4-5-curated",
}
MODEL_IDS = frozenset(MODEL_LABELS.values())
V5_MODELS = frozenset(
    {"nai-diffusion-5-full", "nai-diffusion-5-curated"}
)
V45_MODELS = MODEL_IDS - V5_MODELS
INPAINT_MODELS = {
    "nai-diffusion-5-full": "nai-diffusion-5-full-inpainting",
    # NovelAI currently routes Curated V5 infill through Curated V4.5.
    "nai-diffusion-5-curated": "nai-diffusion-4-5-curated-inpainting",
    "nai-diffusion-4-5-full": "nai-diffusion-4-5-full-inpainting",
    "nai-diffusion-4-5-curated": "nai-diffusion-4-5-curated-inpainting",
}

SAMPLERS = (
    "k_euler_ancestral",
    "k_euler",
    "k_dpmpp_2m",
    "k_dpmpp_2m_sde",
    "k_dpmpp_2s_ancestral",
    "k_dpmpp_sde",
    "k_dpm_2",
)
SCHEDULERS = ("karras", "exponential", "polyexponential")
SIZE_CLASSES = ("Normal", "Large", "Wallpaper", "Small")
ASPECT_RATIOS = ("Portrait", "Landscape", "Square")
_VIBE_CACHE_HMAC_KEY = os.urandom(32)
SIZE_PRESETS = {
    ("Small", "Portrait"): (512, 768),
    ("Small", "Landscape"): (768, 512),
    ("Small", "Square"): (640, 640),
    ("Normal", "Portrait"): (832, 1216),
    ("Normal", "Landscape"): (1216, 832),
    ("Normal", "Square"): (1024, 1024),
    ("Large", "Portrait"): (1024, 1536),
    ("Large", "Landscape"): (1536, 1024),
    ("Large", "Square"): (1472, 1472),
    ("Wallpaper", "Portrait"): (1088, 1920),
    ("Wallpaper", "Landscape"): (1920, 1088),
}
IMAGE_SIZE_CLASSES = ("Small", "Normal", "Large", "Wallpaper")
IMAGE_UPSCALE_FACTORS = {"1.5": 1.5}
IMAGE_UPSCALE_SCALES = tuple(IMAGE_UPSCALE_FACTORS)
IMAGE_RESOLUTION_PRESETS = {
    size_class: tuple(
        SIZE_PRESETS[(size_class, aspect_ratio)]
        for aspect_ratio in ("Portrait", "Square", "Landscape")
        if (size_class, aspect_ratio) in SIZE_PRESETS
    )
    for size_class in IMAGE_SIZE_CLASSES
}


def model_id(value: str) -> str:
    resolved = MODEL_LABELS.get(str(value), str(value))
    if resolved not in MODEL_IDS:
        raise NovelAIError(f"不支持的 NovelAI 模型：{value}")
    return resolved


def _round_image_dimension(value: float) -> int:
    rounded = int((float(value) / 64.0) + 0.5) * 64
    return max(64, min(2048, rounded))


def _ceil_image_dimension(value: float) -> int:
    rounded = int(math.ceil(float(value) / 64.0)) * 64
    return max(64, min(2048, rounded))


def resolve_image_dimensions(
    source_width: int,
    source_height: int,
    *,
    scale_to_budget: bool,
    size_class: str,
    upscale: bool = False,
    upscale_scale: str = "1.5",
) -> tuple[int, int]:
    width = int(source_width)
    height = int(source_height)
    if width < 1 or height < 1:
        raise NovelAIError("输入图像尺寸无效。")
    if upscale:
        factor = IMAGE_UPSCALE_FACTORS.get(str(upscale_scale))
        if factor is None:
            raise NovelAIError(f"未知放大倍率：{upscale_scale}")
        target_width = width * factor
        target_height = height * factor
        longest = max(target_width, target_height)
        if longest > 2048:
            scale = 2048 / longest
            return (
                _round_image_dimension(target_width * scale),
                _round_image_dimension(target_height * scale),
            )
        return (
            _ceil_image_dimension(target_width),
            _ceil_image_dimension(target_height),
        )
    ratio = width / height
    if scale_to_budget:
        anchors = IMAGE_RESOLUTION_PRESETS.get(str(size_class))
        if anchors is None:
            raise NovelAIError(f"未知图像预算档位：{size_class}")
        anchor = min(
            anchors,
            key=lambda item: abs(math.log(ratio / (item[0] / item[1]))),
        )
        area = anchor[0] * anchor[1]
    else:
        area = width * height
    target_width = math.sqrt(area * ratio)
    target_height = math.sqrt(area / ratio)
    longest = max(target_width, target_height)
    if longest > 2048:
        scale = 2048 / longest
        target_width *= scale
        target_height *= scale
    return (
        _round_image_dimension(target_width),
        _round_image_dimension(target_height),
    )


def detect_mode(image_present: bool, mask_present: bool) -> str:
    if mask_present and not image_present:
        raise NovelAIError("MASK 不能单独使用；局部重绘必须同时连接 IMAGE。")
    if image_present and mask_present:
        return "infill"
    if image_present:
        return "img2img"
    return "generate"


def resolve_size(
    size_class: str,
    aspect_ratio: str,
    custom_width: int,
    custom_height: int,
) -> tuple[int, int]:
    if size_class != "Custom" and size_class not in SIZE_CLASSES:
        raise NovelAIError(f"未知尺寸类别：{size_class}")
    if aspect_ratio not in ASPECT_RATIOS:
        raise NovelAIError(f"未知画面比例：{aspect_ratio}")
    if size_class == "Custom":
        width, height = int(custom_width), int(custom_height)
        if not 64 <= width <= 2048 or not 64 <= height <= 2048:
            raise NovelAIError("自定义宽高必须在 64 到 2048 像素之间。")
        if width % 64 or height % 64:
            raise NovelAIError("自定义宽高必须都是 64 的倍数。")
        return width, height
    try:
        return SIZE_PRESETS[(size_class, aspect_ratio)]
    except KeyError as exc:
        raise NovelAIError(
            f"{size_class} 没有 {aspect_ratio} 预设，请改用 Custom。"
        ) from exc


def _number(
    name: str,
    value: Any,
    minimum: float,
    maximum: float,
    integer: bool = False,
) -> int | float:
    try:
        parsed = int(value) if integer else float(value)
    except (TypeError, ValueError) as exc:
        raise NovelAIError(f"{name} 必须是数字。") from exc
    if not minimum <= parsed <= maximum:
        raise NovelAIError(f"{name} 必须在 {minimum:g} 到 {maximum:g} 之间。")
    return parsed


def validate_sampling(settings: dict[str, Any]) -> dict[str, Any]:
    result = deepcopy(settings)
    result["width"] = int(_number("width", result["width"], 64, 2048, True))
    result["height"] = int(_number("height", result["height"], 64, 2048, True))
    if result["width"] % 64 or result["height"] % 64:
        raise NovelAIError("width 和 height 必须都是 64 的倍数。")
    result["seed"] = int(_number("seed", result["seed"], 0, 0xFFFFFFFF, True))
    result["steps"] = int(_number("steps", result["steps"], 1, 50, True))
    result["cfg"] = float(_number("cfg", result["cfg"], 0, 10))
    result["cfg_rescale"] = float(
        _number("cfg_rescale", result["cfg_rescale"], 0, 1)
    )
    result["strength"] = float(
        _number("strength", result.get("strength", 0.7), 0, 1)
    )
    result["noise"] = float(_number("noise", result.get("noise", 0.0), 0, 1))
    if result["sampler"] not in SAMPLERS:
        raise NovelAIError(f"不支持的 sampler：{result['sampler']}")
    if result["scheduler"] not in SCHEDULERS:
        raise NovelAIError(f"不支持的 scheduler：{result['scheduler']}")
    return result


def normalize_characters(
    value: Any,
    selected_model: str,
) -> list[dict[str, Any]]:
    if value is None:
        return []
    if not isinstance(value, dict):
        raise NovelAIError("characters 必须是角色配置对象。")
    group_use_coords = value.get("use_coords")
    if not isinstance(group_use_coords, bool):
        raise NovelAIError("characters.use_coords 必须是布尔值。")
    value = value.get("characters")
    if not isinstance(value, list):
        raise NovelAIError("characters.characters 必须是角色数组。")

    limit = 32 if model_id(selected_model) in V5_MODELS else 6
    normalized: list[dict[str, Any]] = []
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            raise NovelAIError(f"第 {index + 1} 个角色不是有效字典。")
        if not item.get("enabled", True):
            continue
        x = float(_number("角色 x", item.get("x", 0.5), 0, 1))
        y = float(_number("角色 y", item.get("y", 0.5), 0, 1))
        normalized.append(
            {
                "prompt": str(item.get("positive", "")),
                "negative": str(item.get("negative", "")),
                "x": x,
                "y": y,
                "automatic": not group_use_coords,
            }
        )
    if len(normalized) > limit:
        raise NovelAIError(f"当前模型最多支持 {limit} 个角色。")
    return normalized


def _v4_prompts(
    positive: str,
    negative: str,
    characters: Iterable[dict[str, Any]],
) -> tuple[dict[str, Any], dict[str, Any]]:
    positive_characters = []
    negative_characters = []
    use_coords = False
    for item in characters:
        center = {"x": item["x"], "y": item["y"]}
        use_coords = use_coords or not item["automatic"]
        positive_characters.append(
            {"char_caption": item["prompt"], "centers": [center]}
        )
        negative_characters.append(
            {"char_caption": item["negative"], "centers": [center]}
        )
    positive_v4 = {
        "caption": {
            "base_caption": positive,
            "char_captions": positive_characters,
        },
        "use_coords": use_coords,
        "use_order": True,
        "legacy_uc": False,
    }
    negative_v4 = {
        "caption": {
            "base_caption": negative,
            "char_captions": negative_characters,
        },
        "use_coords": use_coords,
        "use_order": False,
        "legacy_uc": False,
    }
    return positive_v4, negative_v4


def _validate_resolved_references(
    references: Any,
    selected_model: str,
) -> list[dict[str, Any]]:
    if references is None:
        return []
    if not isinstance(references, (list, tuple)):
        raise NovelAIError("references 必须是参考资源列表。")
    if not all(isinstance(item, dict) for item in references):
        raise NovelAIError("references 输入包含无效资源。")
    result = list(references)
    if selected_model in V5_MODELS:
        return []
    vibes = [item for item in result if item.get("kind") == "vibe"]
    precise = [item for item in result if item.get("kind") == "precise"]
    unknown = [
        item for item in result if item.get("kind") not in {"vibe", "precise"}
    ]
    if unknown:
        raise NovelAIError("references 中包含未知资源类型。")
    if len(vibes) > 16:
        raise NovelAIError("Vibe 最多支持 16 个资源。")
    if vibes and precise:
        raise NovelAIError("NovelAI 不允许同时使用 Vibe 与 Precise Reference。")
    return result


def _vibe_cache_key(encoding: bytes) -> str:
    normalized = base64.b64encode(encoding).decode("ascii")
    return hmac.new(
        _VIBE_CACHE_HMAC_KEY,
        normalized.encode("ascii"),
        hashlib.sha256,
    ).hexdigest()


def build_generation_request(
    selected_model: str,
    positive: str,
    negative: str,
    settings: dict[str, Any],
    mode: str,
    *,
    image_png: bytes | None = None,
    mask_png: bytes | None = None,
    characters: Any = None,
    references: Any = None,
) -> tuple[dict[str, Any], dict[str, bytes]]:
    selected = model_id(selected_model)
    if mode not in {"generate", "img2img", "infill"}:
        raise NovelAIError(f"未知生成模式：{mode}")
    if mode == "generate" and (image_png is not None or mask_png is not None):
        raise NovelAIError("文生图请求不能携带 IMAGE 或 MASK。")
    if mode == "img2img" and image_png is None:
        raise NovelAIError("图生图请求缺少 IMAGE。")
    if mode == "infill" and (image_png is None or mask_png is None):
        raise NovelAIError("局部重绘请求必须同时包含 IMAGE 和 MASK。")

    clean = validate_sampling(settings)
    character_items = normalize_characters(characters, selected)
    if (
        mode == "infill"
        and selected == "nai-diffusion-5-curated"
        and len(character_items) > 6
    ):
        raise NovelAIError(
            "V5 Curated 局部重绘当前回退到 V4.5 Curated，最多支持 6 个角色。"
        )
    reference_items = _validate_resolved_references(references, selected)
    positive_v4, negative_v4 = _v4_prompts(
        str(positive), str(negative), character_items
    )
    parameters: dict[str, Any] = {
        "params_version": 4,
        "width": clean["width"],
        "height": clean["height"],
        "steps": clean["steps"],
        "scale": clean["cfg"],
        "cfg_rescale": clean["cfg_rescale"],
        "sampler": clean["sampler"],
        "noise_schedule": clean["scheduler"],
        "seed": clean["seed"],
        "n_samples": 1,
        "negative_prompt": str(negative),
        "qualityToggle": False,
        "ucPreset": 0,
        "dynamic_thresholding": False,
        "sm": False,
        "sm_dyn": False,
        "legacy_v3_extend": False,
        "image_format": "png",
        "v4_prompt": positive_v4,
        "v4_negative_prompt": negative_v4,
        "use_coords": positive_v4["use_coords"],
    }
    attachments: dict[str, bytes] = {}
    effective_model = selected
    if mode in {"img2img", "infill"}:
        attachments["image"] = bytes(image_png or b"")
        parameters.update(
            {
                "image": "image",
                "strength": clean["strength"],
                "noise": clean["noise"],
                "add_original_image": mode == "img2img",
                "request_type": (
                    "NativeInfillingRequest"
                    if mode == "infill"
                    else "Img2ImgRequest"
                ),
            }
        )
    else:
        parameters["request_type"] = "PromptGenerateRequest"
    if mode == "infill":
        effective_model = INPAINT_MODELS[selected]
        attachments["mask"] = bytes(mask_png or b"")
        parameters["mask"] = "mask"
        parameters["inpaintImg2ImgStrength"] = clean["strength"]
        if abs(clean["strength"] - 1.0) > 1e-8:
            parameters["img2img"] = {
                "strength": clean["strength"],
                "color_correct": True,
            }

    vibes = [item for item in reference_items if item["kind"] == "vibe"]
    if vibes:
        cached_references = []
        strengths = []
        information = []
        for index, item in enumerate(vibes):
            encoded = item.get("encoding")
            if not isinstance(encoded, (bytes, bytearray, memoryview)) or not encoded:
                raise NovelAIError("Vibe 资源缺少有效编码。")
            raw_encoding = bytes(encoded)
            field = f"ref_multiple_{index}"
            attachments[field] = raw_encoding
            cached_references.append(
                {
                    "cache_secret_key": _vibe_cache_key(raw_encoding),
                    "data": field,
                }
            )
            strengths.append(
                float(_number("Vibe strength", item.get("strength", 0.6), 0.01, 1))
            )
            information.append(
                float(
                    _number(
                        "Vibe information_extracted",
                        item.get("information_extracted", 0.7),
                        0.01,
                        1,
                    )
                )
            )
        parameters["reference_image_multiple_cached"] = cached_references
        parameters["reference_strength_multiple"] = strengths
        parameters["reference_information_extracted_multiple"] = information
        parameters["normalize_reference_strength_multiple"] = True

    precise = [item for item in reference_items if item["kind"] == "precise"]
    if precise:
        images = []
        descriptions = []
        strengths = []
        secondary = []
        information = []
        for index, item in enumerate(precise):
            image = item.get("image_png")
            if not isinstance(image, (bytes, bytearray, memoryview)) or not image:
                raise NovelAIError("精准参考资源缺少有效图片。")
            fidelity = float(
                _number("Reference fidelity", item.get("fidelity", 1.0), 0, 1)
            )
            field = f"director_reference_{index}"
            attachments[field] = bytes(image)
            images.append(field)
            descriptions.append(
                {
                    "caption": {
                        "base_caption": str(
                            item.get("description", "character&style")
                        ),
                        "char_captions": [],
                    },
                    "legacy_uc": False,
                }
            )
            strengths.append(
                float(
                    _number(
                        "Reference strength",
                        item.get("strength", 1.0),
                        0,
                        1,
                    )
                )
            )
            secondary.append(1.0 - fidelity)
            information.append(1.0)
        parameters["director_reference_images"] = images
        parameters["director_reference_descriptions"] = descriptions
        parameters["director_reference_strength_values"] = strengths
        parameters["director_reference_secondary_strength_values"] = secondary
        parameters["director_reference_information_extracted"] = information

    payload = {
        "input": str(positive),
        "model": effective_model,
        "action": mode,
        "parameters": parameters,
        "use_new_shared_trial": True,
    }
    return payload, attachments

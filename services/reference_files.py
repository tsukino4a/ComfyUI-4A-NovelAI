from __future__ import annotations

import hashlib
import io
from pathlib import Path

from PIL import Image

from .core import NovelAIError


MAX_REFERENCE_IMAGE_BYTES = 32 * 1024 * 1024
MAX_REFERENCE_PIXELS = 64 * 1024 * 1024


def reference_image_directory() -> Path:
    try:
        import folder_paths
    except ImportError as exc:
        raise NovelAIError("当前环境无法定位 ComfyUI input 目录。") from exc
    target = Path(folder_paths.get_input_directory()) / "novelai_references"
    target.mkdir(parents=True, exist_ok=True)
    return target


def _safe_stem(value: str, fallback: str) -> str:
    invalid = '<>:"/\\|?*'
    stem = Path(str(value or "")).stem
    name = "".join("_" if char in invalid else char for char in stem).strip(" .")
    return (name or fallback)[:96]


def normalize_reference_image(data: bytes) -> bytes:
    if not data:
        raise NovelAIError("参考图片为空。")
    if len(data) > MAX_REFERENCE_IMAGE_BYTES:
        raise NovelAIError("参考图片不能超过 32 MB。")
    try:
        with Image.open(io.BytesIO(data)) as image:
            if image.width * image.height > MAX_REFERENCE_PIXELS:
                raise NovelAIError("参考图片像素量过大。")
            rgb = image.convert("RGB")
            output = io.BytesIO()
            rgb.save(output, format="PNG")
            return output.getvalue()
    except NovelAIError:
        raise
    except Exception as exc:
        raise NovelAIError("无法解码参考图片。") from exc


def save_reference_image(data: bytes, original_name: str = "") -> str:
    normalized = normalize_reference_image(data)
    digest = hashlib.sha256(normalized).hexdigest()
    root = reference_image_directory()
    target = root / f"{_safe_stem(original_name, 'reference')}-{digest[:12]}.png"
    if not target.exists():
        temporary = target.with_suffix(target.suffix + ".tmp")
        temporary.write_bytes(normalized)
        temporary.replace(target)
    return target.name


def load_reference_image(filename: str) -> bytes:
    if not isinstance(filename, str) or Path(filename).name != filename:
        raise NovelAIError("参考图片文件名无效。")
    path = reference_image_directory() / filename
    if not path.is_file() or path.suffix.lower() != ".png":
        raise NovelAIError(f"找不到参考图片：{filename}")
    data = path.read_bytes()
    if len(data) > MAX_REFERENCE_IMAGE_BYTES:
        raise NovelAIError("参考图片不能超过 32 MB。")
    return data

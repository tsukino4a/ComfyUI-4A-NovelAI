from __future__ import annotations

import io
import tempfile
import uuid
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

from .core import NovelAIError


PRECISE_REFERENCE_SIZES = ((1024, 1536), (1536, 1024), (1472, 1472))


def _numpy(value: Any) -> np.ndarray:
    if hasattr(value, "detach"):
        value = value.detach()
    if hasattr(value, "cpu"):
        value = value.cpu()
    if hasattr(value, "numpy"):
        value = value.numpy()
    return np.asarray(value)


def _image_array(value: Any) -> np.ndarray:
    array = _numpy(value)
    if array.ndim == 4:
        if array.shape[0] < 1:
            raise NovelAIError("IMAGE 批次为空。")
        array = array[0]
    if array.ndim != 3 or array.shape[2] < 3:
        raise NovelAIError("IMAGE 必须是 ComfyUI 的 RGB/RGBA 图像。")
    return np.asarray(np.clip(array[..., :3], 0.0, 1.0), dtype=np.float32)


def image_dimensions(value: Any) -> tuple[int, int]:
    array = _image_array(value)
    return int(array.shape[1]), int(array.shape[0])


MASK_PAINT_THRESHOLD = 0.5
MASK_MIN_PAINTED_PIXELS = 16


def mask_has_content(value: Any) -> bool:
    if value is None:
        return False
    # Ignore Load Image alpha LSB fringe and one- or two-pixel clicks.
    painted = int(np.count_nonzero(_mask_array(value) > MASK_PAINT_THRESHOLD))
    return painted >= MASK_MIN_PAINTED_PIXELS


def _mask_array(value: Any) -> np.ndarray:
    array = _numpy(value)
    if array.ndim == 3:
        if array.shape[-1] in {1, 3, 4}:
            array = array[..., 0]
        else:
            if array.shape[0] < 1:
                raise NovelAIError("MASK 批次为空。")
            array = array[0]
    if array.ndim != 2:
        raise NovelAIError("MASK 必须是 ComfyUI 的单通道遮罩。")
    return np.asarray(np.clip(array, 0.0, 1.0), dtype=np.float32)


def tensor_to_png(
    value: Any,
    *,
    width: int | None = None,
    height: int | None = None,
    mask: bool = False,
) -> bytes:
    if mask:
        array = np.clip(_mask_array(value) * 255.0, 0.0, 255.0).astype(np.uint8)
        image = Image.fromarray(array, mode="L")
        if width is not None and height is not None:
            target = (int(width), int(height))
            latent = (
                max(1, int(np.ceil(target[0] / 64.0) * 8)),
                max(1, int(np.ceil(target[1] / 64.0) * 8)),
            )
            image = image.resize(latent, Image.Resampling.NEAREST)
            image = image.resize(target, Image.Resampling.NEAREST)
        intensity = np.asarray(image, dtype=np.uint8)
        alpha = np.where(intensity > 0, 255, 0).astype(np.uint8)
        rgba = np.dstack((intensity, intensity, intensity, alpha))
        image = Image.fromarray(rgba, mode="RGBA")
        resampling = Image.Resampling.NEAREST
    else:
        array = np.rint(_image_array(value) * 255.0).astype(np.uint8)
        image = Image.fromarray(array, mode="RGB")
        resampling = Image.Resampling.LANCZOS
    if width is not None and height is not None and image.size != (width, height):
        image = image.resize((int(width), int(height)), resampling)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def prepare_precise_reference_png(value: Any) -> bytes:
    array = np.rint(_image_array(value) * 255.0).astype(np.uint8)
    source = Image.fromarray(array, mode="RGB")
    return _prepare_precise_source(source)


def prepare_precise_reference_png_bytes(value: bytes) -> bytes:
    try:
        with Image.open(io.BytesIO(value)) as image:
            source = image.convert("RGB")
            return _prepare_precise_source(source)
    except Exception as exc:
        raise NovelAIError("无法解码 Precise Reference 图片。") from exc


def _prepare_precise_source(source: Image.Image) -> bytes:
    source_ratio = source.width / source.height
    target_width, target_height = min(
        PRECISE_REFERENCE_SIZES,
        key=lambda size: abs(size[0] / size[1] - source_ratio),
    )
    scale = min(target_width / source.width, target_height / source.height)
    resized = source.resize(
        (
            max(1, round(source.width * scale)),
            max(1, round(source.height * scale)),
        ),
        Image.Resampling.LANCZOS,
    )
    canvas = Image.new("RGB", (target_width, target_height), "black")
    canvas.paste(
        resized,
        ((target_width - resized.width) // 2, (target_height - resized.height) // 2),
    )
    buffer = io.BytesIO()
    canvas.save(buffer, format="PNG")
    return buffer.getvalue()


@dataclass(frozen=True)
class ImageResult:
    filename: str
    png: bytes
    pixels: np.ndarray


def _decode_png(name: str, content: bytes) -> ImageResult:
    try:
        with Image.open(io.BytesIO(content)) as image:
            if image.format != "PNG":
                raise NovelAIError("NovelAI 返回了非 PNG 图片。")
            rgb = image.convert("RGB")
            pixels = np.asarray(rgb, dtype=np.float32) / 255.0
    except NovelAIError:
        raise
    except Exception as exc:
        raise NovelAIError("无法解码 NovelAI 返回的 PNG 图片。") from exc
    return ImageResult(
        filename=Path(name).name or "image.png",
        png=bytes(content),
        pixels=np.ascontiguousarray(pixels),
    )


def parse_image_response(content: bytes) -> list[ImageResult]:
    if not content:
        raise NovelAIError("NovelAI 返回了空响应。")
    stream = io.BytesIO(content)
    if zipfile.is_zipfile(stream):
        try:
            with zipfile.ZipFile(stream) as archive:
                names = sorted(
                    name
                    for name in archive.namelist()
                    if not name.endswith("/") and name.lower().endswith(".png")
                )
                if not names:
                    raise NovelAIError("NovelAI ZIP 响应中没有 PNG 图片。")
                return [_decode_png(name, archive.read(name)) for name in names]
        except zipfile.BadZipFile as exc:
            raise NovelAIError("NovelAI 返回了损坏的 ZIP 响应。") from exc
    return [_decode_png("image.png", content)]


def results_to_tensor(results: list[ImageResult]):
    if not results:
        raise NovelAIError("没有可输出的 NovelAI 图片。")
    shapes = {result.pixels.shape for result in results}
    if len(shapes) != 1:
        raise NovelAIError("NovelAI 返回图片尺寸不一致，无法组成 IMAGE 批次。")
    try:
        import torch
    except ImportError as exc:
        raise NovelAIError("当前 ComfyUI 环境缺少 torch。") from exc
    return torch.from_numpy(np.stack([item.pixels for item in results], axis=0))


def save_original_previews(
    results: list[ImageResult],
    *,
    temp_root: Path | str | None = None,
) -> list[dict[str, str]]:
    if temp_root is None:
        try:
            import folder_paths

            temp_root = Path(folder_paths.get_temp_directory())
        except (ImportError, AttributeError):
            temp_root = Path(tempfile.gettempdir())
    root = Path(temp_root)
    subfolder = "novelai_4a"
    target_directory = root / subfolder
    target_directory.mkdir(parents=True, exist_ok=True)
    descriptors = []
    for index, result in enumerate(results):
        filename = f"novelai_{uuid.uuid4().hex}_{index:02d}.png"
        target = target_directory / filename
        target.write_bytes(result.png)
        descriptors.append(
            {"filename": filename, "subfolder": subfolder, "type": "temp"}
        )
    return descriptors

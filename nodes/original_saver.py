"""Save NovelAI's returned PNG bytes without re-encoding them."""

from __future__ import annotations

import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any

try:
    import folder_paths
except ImportError:  # pragma: no cover - standalone test collection
    folder_paths = None  # type: ignore

from ..services.core import NovelAIError


_UNSAFE_FILENAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def _render_time(value: str, now: datetime, time_format: str) -> str:
    try:
        rendered_time = now.strftime(str(time_format or "%Y-%m-%d_%H-%M-%S"))
    except (TypeError, ValueError):
        rendered_time = now.strftime("%Y-%m-%d_%H-%M-%S")
    return (
        str(value or "")
        .replace("%date", now.strftime("%Y-%m-%d"))
        .replace("%time", rendered_time)
    )


def _output_root() -> Path:
    if folder_paths is None:
        raise NovelAIError("ComfyUI folder_paths 不可用，无法确定输出目录。")
    value = (
        folder_paths.get_output_directory()
        if hasattr(folder_paths, "get_output_directory")
        else folder_paths.output_directory
    )
    return Path(value).resolve()


def _output_directory(value: str, now: datetime, time_format: str) -> Path:
    root = _output_root()
    rendered = _render_time(value, now, time_format).strip()
    requested = Path(rendered)
    if requested.is_absolute() or any(part == ".." for part in requested.parts):
        raise NovelAIError("保存路径必须位于 ComfyUI output 目录内。")
    target = (root / requested).resolve()
    if os.path.commonpath((str(root), str(target))) != str(root):
        raise NovelAIError("保存路径不能离开 ComfyUI output 目录。")
    return target


def _filename_stem(value: str, now: datetime, time_format: str) -> str:
    rendered = _render_time(value, now, time_format).strip()
    if rendered.lower().endswith(".png"):
        rendered = rendered[:-4]
    rendered = _UNSAFE_FILENAME.sub("_", rendered).strip(". ")
    if not rendered:
        rendered = _UNSAFE_FILENAME.sub("_", _render_time("%time", now, time_format))
    return rendered or "NovelAI"


def _result_images(value: Any) -> list[bytes]:
    if not isinstance(value, (list, tuple)) or not value:
        raise NovelAIError("result 必须连接 NAI 采样器的 NAI_RESULT 输出。")
    images: list[bytes] = []
    for index, png in enumerate(value):
        if not isinstance(png, (bytes, bytearray, memoryview)):
            raise NovelAIError(f"NAI_RESULT 第 {index + 1} 张图片缺少原始 PNG。")
        content = bytes(png)
        if not content.startswith(_PNG_SIGNATURE):
            raise NovelAIError(f"NAI_RESULT 第 {index + 1} 张图片不是有效 PNG。")
        images.append(content)
    return images


def _write_unique(parent: Path, stem: str, png: bytes, index: int, total: int) -> Path:
    base = stem if total == 1 else f"{stem}_{index + 1:02d}"
    attempt = 0
    while True:
        suffix = "" if attempt == 0 else f"_{attempt:02d}"
        target = parent / f"{base}{suffix}.png"
        try:
            with target.open("xb") as handle:
                handle.write(png)
            return target
        except FileExistsError:
            attempt += 1


class NAIOriginalImageSaverNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "result": ("NAI_RESULT",),
                "filename": (
                    "STRING",
                    {"default": "NAI_%time", "multiline": False},
                ),
                "path": (
                    "STRING",
                    {"default": "NovelAI", "multiline": False},
                ),
                "time_format": (
                    "STRING",
                    {"default": "%Y-%m-%d_%H-%M-%S", "multiline": False},
                ),
            }
        }

    RETURN_TYPES = ()
    FUNCTION = "save"
    OUTPUT_NODE = True
    CATEGORY = "4A NovelAI"

    def save(
        self,
        result: Any,
        filename: str,
        path: str,
        time_format: str,
    ) -> dict[str, Any]:
        images = _result_images(result)
        now = datetime.now()
        output_root = _output_root()
        output_directory = _output_directory(path, now, time_format)
        output_directory.mkdir(parents=True, exist_ok=True)
        stem = _filename_stem(filename, now, time_format)
        previews: list[dict[str, str]] = []
        for index, png in enumerate(images):
            target = _write_unique(
                output_directory,
                stem,
                png,
                index,
                len(images),
            )
            subfolder = os.path.relpath(target.parent, output_root)
            previews.append(
                {
                    "filename": target.name,
                    "subfolder": "" if subfolder == "." else subfolder,
                    "type": "output",
                }
            )
        return {"ui": {"images": previews}, "result": ()}

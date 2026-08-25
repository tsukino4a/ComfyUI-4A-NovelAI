from __future__ import annotations

import base64
import hashlib
import io
import json
import time
import zipfile
from pathlib import Path
from typing import Any

from PIL import Image

from .core import NovelAIError, model_id


VIBE_EXTENSIONS = {".naiv4vibe", ".naiv4vibebundle"}
MAX_VIBE_BYTES = 128 * 1024 * 1024
MODEL_TO_VIBE_KEY = {
    "nai-diffusion-4-5-full": "v4-5full",
    "nai-diffusion-4-5-curated": "v4-5curated",
}
ENCODING_FIELDS = {"encoding", "encodedVibe", "vibeEncoding"}
SKIPPED_FIELDS = {"image", "thumbnail", "preview"}
_VIBE_CACHE: dict[Path, tuple[int, int, dict[str, Any]]] = {}


def vibe_directory() -> Path:
    try:
        import folder_paths
    except ImportError as exc:
        raise NovelAIError("当前环境无法定位 ComfyUI input 目录。") from exc
    root = Path(folder_paths.get_input_directory())
    target = root / "novelai_vibes"
    target.mkdir(parents=True, exist_ok=True)
    return target


def list_vibe_files() -> list[str]:
    try:
        root = vibe_directory()
    except NovelAIError:
        return ["None"]
    names = sorted(
        (
            item.name
            for item in root.iterdir()
            if item.is_file() and item.suffix.lower() in VIBE_EXTENSIONS
        ),
        key=str.casefold,
    )
    return ["None", *names]


def _binary(value: Any) -> bytes | None:
    if isinstance(value, (bytes, bytearray, memoryview)):
        result = bytes(value)
        return result or None
    if (
        isinstance(value, list)
        and value
        and all(isinstance(item, int) and 0 <= item <= 255 for item in value)
    ):
        return bytes(value)
    return None


def _base64_bytes(value: Any) -> bytes | None:
    raw = _binary(value)
    if raw is not None:
        return raw
    if not isinstance(value, str):
        return None
    normalized = "".join(value.split())
    if "," in normalized and normalized.lower().startswith("data:"):
        normalized = normalized.split(",", 1)[1]
    try:
        decoded = base64.b64decode(
            normalized + ("=" * (-len(normalized) % 4)),
            validate=True,
        )
    except Exception:
        return None
    return decoded or None


def _decode_document(data: bytes) -> Any:
    try:
        return json.loads(data.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        pass
    stream = io.BytesIO(data)
    if zipfile.is_zipfile(stream):
        try:
            with zipfile.ZipFile(stream) as archive:
                candidates = [
                    name
                    for name in archive.namelist()
                    if not name.endswith("/")
                    and Path(name).suffix.lower() in VIBE_EXTENSIONS | {".json"}
                ]
                if not candidates:
                    raise NovelAIError("Vibe 压缩包中没有可解析的文件。")
                return _decode_document(archive.read(candidates[0]))
        except (zipfile.BadZipFile, KeyError) as exc:
            raise NovelAIError("Vibe 压缩包已经损坏。") from exc
    try:
        import msgpack
    except ImportError as exc:
        raise NovelAIError(
            "解析旧版 Vibe 文件需要 msgpack；请安装 requirements.txt 后重启 ComfyUI。"
        ) from exc
    try:
        return msgpack.unpackb(data, raw=False, strict_map_key=False)
    except Exception as exc:
        raise NovelAIError("无法解析 Vibe 文件；文件可能损坏或格式暂不受支持。") from exc


def _float(value: Any, fallback: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def parse_official_vibe_bytes(data: bytes, *, source_name: str = "Vibe") -> list[dict]:
    if not data:
        raise NovelAIError("Vibe 文件为空。")
    if len(data) > MAX_VIBE_BYTES:
        raise NovelAIError("Vibe 文件超过 128 MB 安全限制。")
    document = _decode_document(data)

    records: list[dict[str, Any]] = []

    def visit(
        value: Any,
        *,
        name: str,
        model_key: str | None,
        information: float,
        inside_encodings: bool,
    ) -> None:
        raw = _binary(value)
        if raw is not None:
            if inside_encodings and model_key:
                records.append(
                    {
                        "name": name,
                        "model_key": model_key,
                        "information_extracted": information,
                        "encoding": raw,
                    }
                )
            return
        if isinstance(value, (list, tuple)):
            for item in value:
                visit(
                    item,
                    name=name,
                    model_key=model_key,
                    information=information,
                    inside_encodings=inside_encodings,
                )
            return
        if not isinstance(value, dict):
            return

        local_name = str(
            value.get("name")
            or value.get("displayName")
            or value.get("label")
            or name
        )
        params = value.get("params")
        params = params if isinstance(params, dict) else {}
        local_information = _float(
            value.get(
                "information_extracted",
                value.get(
                    "informationExtracted",
                    value.get(
                        "information",
                        params.get(
                            "information_extracted",
                            params.get("informationExtracted", information),
                        ),
                    ),
                ),
            ),
            information,
        )
        for field in ENCODING_FIELDS:
            raw_encoding = _base64_bytes(value.get(field))
            if raw_encoding is not None:
                records.append(
                    {
                        "name": local_name,
                        "model_key": model_key,
                        "information_extracted": local_information,
                        "encoding": raw_encoding,
                    }
                )
        for key, child in value.items():
            if key in ENCODING_FIELDS or key in SKIPPED_FIELDS:
                continue
            if key == "encodings" and isinstance(child, dict):
                for child_model_key, variants in child.items():
                    visit(
                        variants,
                        name=local_name,
                        model_key=str(child_model_key),
                        information=local_information,
                        inside_encodings=True,
                    )
                continue
            visit(
                child,
                name=local_name,
                model_key=model_key,
                information=local_information,
                inside_encodings=inside_encodings,
            )

    visit(
        document,
        name=source_name,
        model_key=None,
        information=0.7,
        inside_encodings=False,
    )
    unique = []
    seen = set()
    for record in records:
        marker = (
            record["model_key"],
            round(float(record["information_extracted"]), 6),
            record["encoding"],
        )
        if marker not in seen:
            seen.add(marker)
            unique.append(record)
    if not unique:
        raise NovelAIError(
            "Vibe 文件中没有找到可用编码；该官方文件变体可能尚未支持。"
        )
    return unique


def load_official_vibe(filename: str) -> list[dict]:
    if not isinstance(filename, str) or Path(filename).name != filename:
        raise NovelAIError("Vibe 文件名无效。")
    suffix = Path(filename).suffix.lower()
    if suffix not in VIBE_EXTENSIONS:
        raise NovelAIError("只支持 .naiv4vibe 和 .naiv4vibeBundle 文件。")
    path = vibe_directory() / filename
    if not path.is_file():
        raise NovelAIError(f"找不到 Vibe 文件：{filename}")
    return parse_official_vibe_bytes(path.read_bytes(), source_name=path.stem)


def _vibe_documents(value: Any) -> list[dict[str, Any]]:
    documents: list[dict[str, Any]] = []
    if isinstance(value, dict):
        if value.get("identifier") == "novelai-vibe-transfer":
            documents.append(value)
        for child in value.values():
            documents.extend(_vibe_documents(child))
    elif isinstance(value, (list, tuple)):
        for child in value:
            documents.extend(_vibe_documents(child))
    return documents


def _embedded_image(value: Any) -> bytes | None:
    raw = _base64_bytes(value)
    if raw is None:
        return None
    try:
        with Image.open(io.BytesIO(raw)) as image:
            image.verify()
    except Exception:
        return None
    return raw


def canonical_image_hash(image_bytes: bytes) -> str:
    try:
        with Image.open(io.BytesIO(image_bytes)) as image:
            rgb = image.convert("RGB")
            digest = hashlib.sha256()
            digest.update(f"{rgb.width}x{rgb.height}:RGB:".encode("ascii"))
            digest.update(rgb.tobytes())
            return digest.hexdigest()
    except Exception as exc:
        raise NovelAIError("无法计算 Vibe 参考图哈希。") from exc


def inspect_official_vibe_bytes(
    data: bytes,
    *,
    source_name: str = "Vibe",
) -> dict[str, Any]:
    document = _decode_document(data)
    documents = _vibe_documents(document)
    records = parse_official_vibe_bytes(data, source_name=source_name)
    previews: list[bytes] = []
    images: list[bytes] = []
    for item in documents:
        thumbnail = _embedded_image(item.get("thumbnail"))
        image = _embedded_image(item.get("image"))
        if thumbnail is not None:
            previews.append(thumbnail)
        elif image is not None:
            previews.append(image)
        if image is not None:
            images.append(image)
    primary = documents[0] if documents else {}
    return {
        "records": records,
        "name": str(primary.get("name") or source_name),
        "previews": previews,
        "images": images,
        "pixel_hashes": [canonical_image_hash(image) for image in images],
    }


def inspect_vibe_file(filename: str) -> dict[str, Any]:
    if not isinstance(filename, str) or Path(filename).name != filename:
        raise NovelAIError("Vibe 文件名无效。")
    path = vibe_directory() / filename
    if not path.is_file() or path.suffix.lower() not in VIBE_EXTENSIONS:
        raise NovelAIError(f"找不到 Vibe 文件：{filename}")
    stat = path.stat()
    cached = _VIBE_CACHE.get(path)
    marker = (stat.st_mtime_ns, stat.st_size)
    if cached is not None and cached[:2] == marker:
        return cached[2]
    descriptor = inspect_official_vibe_bytes(
        path.read_bytes(),
        source_name=path.stem,
    )
    descriptor.update(
        {
            "filename": path.name,
        }
    )
    _VIBE_CACHE[path] = (stat.st_mtime_ns, stat.st_size, descriptor)
    return descriptor


def list_vibe_summaries() -> list[dict[str, Any]]:
    summaries = []
    for filename in list_vibe_files()[1:]:
        try:
            descriptor = inspect_vibe_file(filename)
            records = descriptor["records"]
            summaries.append(
                {
                    "filename": filename,
                    "name": descriptor["name"],
                    "has_preview": bool(descriptor["previews"]),
                    "information_extracted": sorted(
                        {
                            round(float(record["information_extracted"]), 6)
                            for record in records
                        }
                    ),
                }
            )
        except NovelAIError:
            summaries.append(
                {
                    "filename": filename,
                    "name": Path(filename).stem,
                }
            )
    return summaries


def vibe_preview_bytes(filename: str, index: int = 0) -> tuple[bytes, str]:
    previews = inspect_vibe_file(filename)["previews"]
    if not previews:
        raise NovelAIError("该 Vibe 文件没有内嵌预览图。")
    selected = previews[max(0, min(len(previews) - 1, int(index)))]
    try:
        with Image.open(io.BytesIO(selected)) as image:
            mime = Image.MIME.get(image.format, "image/png")
    except Exception:
        mime = "image/png"
    return selected, mime


def _js_number(value: float) -> str:
    number = float(value)
    return str(int(number)) if number.is_integer() else format(number, ".15g")


def official_params_key(information_extracted: float) -> str:
    source = f"information_extracted:{_js_number(information_extracted)}"
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


def _thumbnail_data_url(image_png: bytes, maximum: int = 256) -> str:
    with Image.open(io.BytesIO(image_png)) as image:
        thumbnail = image.convert("RGB")
        thumbnail.thumbnail((maximum, maximum), Image.Resampling.LANCZOS)
        buffer = io.BytesIO()
        thumbnail.save(buffer, format="JPEG", quality=88, optimize=True)
    return "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode(
        "ascii"
    )


def _safe_vibe_stem(value: str, fallback: str) -> str:
    invalid = '<>:"/\\|?*'
    name = "".join("_" if char in invalid else char for char in str(value or "").strip())
    name = name.strip(" .")
    return (name or fallback)[:96]


def save_encoded_vibe(
    image_png: bytes,
    encoding: bytes,
    *,
    selected_model: str,
    information_extracted: float,
    strength: float = 0.6,
    name: str = "",
) -> str:
    resolved_model = model_id(selected_model)
    model_key = MODEL_TO_VIBE_KEY.get(resolved_model)
    if model_key is None:
        raise NovelAIError("只有 V4.5 模型可以保存当前 Vibe 编码。")
    if not image_png or not encoding:
        raise NovelAIError("保存 Vibe 文件时缺少图片或编码。")
    image_b64 = base64.b64encode(image_png).decode("ascii")
    identifier = hashlib.sha256(image_b64.encode("ascii")).hexdigest()
    pixel_hash = canonical_image_hash(image_png)
    information = float(information_extracted)
    display_name = _safe_vibe_stem(
        name,
        f"{identifier[:6]}-{identifier[-6:]}",
    )
    entry = {
        "encoding": base64.b64encode(bytes(encoding)).decode("ascii"),
        "params": {"information_extracted": information},
    }
    new_document: dict[str, Any] = {
        "identifier": "novelai-vibe-transfer",
        "version": 1,
        "type": "image",
        "image": image_b64,
        "id": identifier,
        "encodings": {
            model_key: {official_params_key(information): entry},
        },
        "name": display_name,
        "thumbnail": _thumbnail_data_url(image_png),
        "createdAt": int(time.time() * 1000),
        "importInfo": {
            "model": resolved_model,
            "information_extracted": information,
            "strength": float(strength),
            "sourcePixelHash": pixel_hash,
        },
    }
    root = vibe_directory()
    target: Path | None = None
    stored_document: Any = new_document
    for candidate in root.glob("*.naiv4vibe"):
        try:
            parsed = _decode_document(candidate.read_bytes())
            matching = next(
                (
                    item
                    for item in _vibe_documents(parsed)
                    if any(
                        canonical_image_hash(image) == pixel_hash
                        for image in [_embedded_image(item.get("image"))]
                        if image is not None
                    )
                ),
                None,
            )
        except Exception:
            continue
        if matching is None:
            continue
        matching.setdefault("encodings", {}).setdefault(model_key, {})[
            official_params_key(information)
        ] = entry
        matching.update(
            {
                "name": display_name,
                "thumbnail": new_document["thumbnail"],
                "importInfo": new_document["importInfo"],
            }
        )
        stored_document = parsed
        target = candidate
        break
    if target is None:
        target = root / f"{display_name}.naiv4vibe"
        if target.exists():
            target = root / f"{display_name}-{identifier[:8]}.naiv4vibe"
    data = json.dumps(
        stored_document,
        ensure_ascii=False,
        indent=2,
    ).encode("utf-8")
    if len(data) > MAX_VIBE_BYTES:
        raise NovelAIError("导出的 Vibe 文件超过 128 MB 安全限制。")
    temporary = target.with_suffix(target.suffix + ".tmp")
    temporary.write_bytes(data)
    temporary.replace(target)
    _VIBE_CACHE.pop(target, None)
    return target.name


def find_matching_vibe(
    image_png: bytes,
    selected_model: str,
    information_extracted: float,
) -> tuple[dict[str, Any], dict[str, Any]] | None:
    target_hash = canonical_image_hash(image_png)
    for filename in list_vibe_files()[1:]:
        try:
            descriptor = inspect_vibe_file(filename)
        except NovelAIError:
            continue
        if target_hash not in descriptor["pixel_hashes"]:
            continue
        try:
            record = choose_vibe_encoding(
                descriptor["records"],
                selected_model,
                information_extracted,
            )
        except NovelAIError:
            continue
        return descriptor, record
    return None


def choose_vibe_encoding(
    records: list[dict],
    selected_model: str,
    information_extracted: float,
) -> dict:
    selected = model_id(selected_model)
    expected = MODEL_TO_VIBE_KEY.get(selected)
    if expected is None:
        raise NovelAIError("当前模型不支持 V4.5 Vibe 编码。")
    exact = [record for record in records if record.get("model_key") == expected]
    unscoped = [record for record in records if not record.get("model_key")]
    candidates = exact or unscoped
    if not candidates:
        available = ", ".join(
            sorted({str(item.get("model_key")) for item in records if item.get("model_key")})
        )
        raise NovelAIError(
            f"Vibe 文件没有 {expected} 编码"
            + (f"；现有编码：{available}。" if available else "。")
        )
    target = float(information_extracted)
    exact = [
        item
        for item in candidates
        if abs(float(item.get("information_extracted", target)) - target) <= 1e-6
    ]
    if exact:
        return exact[0]
    available_information = ", ".join(
        _js_number(float(item.get("information_extracted", target)))
        for item in candidates
    )
    raise NovelAIError(
        f"Vibe 文件没有 Information Extracted={_js_number(target)} 的精确编码"
        + (
            f"；当前模型可用值：{available_information}。"
            if available_information
            else "。"
        )
    )

"""Read text generation metadata without decoding or rewriting image pixels."""

from __future__ import annotations

from typing import Any
from xml.etree import ElementTree


_BINARY_KEYS = {"exif", "icc_profile", "transparency"}
_MAX_TEXT_BYTES = 16 * 1024 * 1024


def _clean(value: str) -> str:
    return value.replace("\x00", "").strip("\ufeff\ufffe\x00 \t\r\n")


def decode_metadata_bytes(value: bytes, key: str = "") -> str:
    raw = bytes(value)
    if len(raw) > _MAX_TEXT_BYTES:
        return ""
    if key.lower().replace(" ", "") == "usercomment" and len(raw) >= 8:
        prefix, body = raw[:8], raw[8:]
        if prefix.startswith(b"ASCII"):
            return _clean(body.decode("utf-8", errors="replace"))
        if prefix.startswith(b"JIS"):
            return _clean(body.decode("shift_jis", errors="replace"))
        if prefix.startswith(b"UNICODE"):
            raw = body
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        return _clean(raw.decode("utf-16", errors="replace"))
    try:
        return _clean(raw.decode("utf-8"))
    except UnicodeDecodeError:
        even_zeros = raw[0::2].count(0)
        odd_zeros = raw[1::2].count(0)
        if max(even_zeros, odd_zeros) >= max(2, len(raw) // 8):
            encoding = "utf-16-be" if even_zeros > odd_zeros else "utf-16-le"
            return _clean(raw.decode(encoding, errors="replace"))
        return _clean(raw.decode("latin-1", errors="replace"))


def _json_safe(value: Any, key: str = "") -> Any:
    if isinstance(value, bytes):
        return decode_metadata_bytes(value, key)
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(k): _json_safe(v, str(k)) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item, key) for item in value]
    return str(value)


def _put(payload: dict[str, Any], key: str, value: Any) -> None:
    name = str(key).strip()
    if not name:
        return
    safe = _json_safe(value, name)
    if safe not in (None, "", [], {}):
        payload.setdefault(name, safe)


def _local_xml_name(value: str) -> str:
    return value.rsplit("}", 1)[-1].rsplit(":", 1)[-1]


def _flatten_xmp(payload: dict[str, Any]) -> None:
    candidates = [
        value
        for key, value in list(payload.items())
        if "xmp" in key.lower() or (isinstance(value, str) and "<x:xmpmeta" in value)
    ]
    for candidate in candidates:
        if not isinstance(candidate, str) or "<" not in candidate:
            continue
        try:
            root = ElementTree.fromstring(candidate[candidate.find("<") :])
        except (ElementTree.ParseError, ValueError):
            continue
        for element in root.iter():
            for key, value in element.attrib.items():
                _put(payload, _local_xml_name(key), value)
            if (element.text or "").strip():
                _put(payload, _local_xml_name(element.tag), element.text.strip())


def _flatten_iptc(image: Any, payload: dict[str, Any]) -> None:
    try:
        from PIL.IptcImagePlugin import getiptcinfo

        values = getiptcinfo(image) or {}
    except Exception:
        return
    aliases = {
        (2, 5): "Title",
        (2, 25): "Keywords",
        (2, 80): "Artist",
        (2, 120): "Description",
    }
    for tag, value in values.items():
        _put(payload, aliases.get(tag, f"IPTC {tag}"), value)


def extract_image_metadata(image: Any) -> dict[str, Any]:
    """Flatten Pillow info and EXIF fields into JSON-safe metadata."""
    payload: dict[str, Any] = {}
    for key, value in dict(getattr(image, "info", {}) or {}).items():
        if str(key).lower() not in _BINARY_KEYS:
            _put(payload, str(key), value)
    try:
        from PIL import ExifTags

        exif = image.getexif()
        for tag, value in dict(exif or {}).items():
            _put(payload, ExifTags.TAGS.get(tag, str(tag)), value)
        if exif and hasattr(exif, "get_ifd"):
            for ifd_id in (0x8769, 0x8825, 0xA005):
                try:
                    values = exif.get_ifd(ifd_id)
                except Exception:
                    continue
                for tag, value in dict(values or {}).items():
                    _put(payload, ExifTags.TAGS.get(tag, str(tag)), value)
    except Exception:
        pass
    _flatten_iptc(image, payload)
    _flatten_xmp(payload)
    return payload

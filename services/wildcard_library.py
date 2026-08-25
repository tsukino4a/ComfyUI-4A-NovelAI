"""Reuse 4A Prompt Manager's in-memory wildcard resolver when it is loaded."""

from __future__ import annotations

import logging
import re
import sys
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any, Iterable, Mapping

try:
    from ..domain.wildcard_syntax import WildcardCandidate
except ImportError:  # pragma: no cover - standalone test collection
    from domain.wildcard_syntax import WildcardCandidate  # type: ignore


ROOT_WILDCARD_KEY = "*"
logger = logging.getLogger("ComfyUI4ANovelAI")


class _PassthroughWildcardResolver:
    """Marker resolver used when 4APM is not loaded."""

    def resolve(self, _key: str) -> tuple[Any, ...]:
        return ()


PASSTHROUGH_RESOLVER = _PassthroughWildcardResolver()
_PM4A_LIBRARY_MODULE = ""


def normalize_key(value: str) -> str:
    return (
        str(value)
        .strip()
        .replace("\\", "/")
        .replace(" ", "-")
        .strip("/")
        .lower()
    )


def _natural_key(value: str) -> tuple[tuple[int, object], ...]:
    return tuple(
        (1, int(part)) if part.isdigit() else (0, part.casefold())
        for part in re.split(r"(\d+)", value.replace("\\", "/"))
        if part
    )


def is_passthrough_resolver(resolver: object) -> bool:
    return resolver is PASSTHROUGH_RESOLVER


@dataclass(frozen=True)
class WildcardLibraryResolver:
    """In-memory index used by tests and injected scheduler resolvers."""

    candidates: Mapping[str, tuple[WildcardCandidate, ...]]
    display_paths: Mapping[str, str]

    @classmethod
    def from_entries(
        cls,
        entries: Mapping[str, Iterable[WildcardCandidate | str]],
    ) -> "WildcardLibraryResolver":
        candidates: dict[str, tuple[WildcardCandidate, ...]] = {}
        displays: dict[str, str] = {}
        for raw_key, raw_values in entries.items():
            key = normalize_key(raw_key)
            values: list[WildcardCandidate] = []
            for raw in raw_values:
                if isinstance(raw, WildcardCandidate):
                    values.append(raw)
                else:
                    values.append(WildcardCandidate(key=key, content=str(raw)))
            if values:
                candidates[key] = tuple(values)
                displays[key] = str(raw_key).replace("\\", "/")
        ordered_keys = sorted(
            candidates,
            key=lambda item: (_natural_key(displays.get(item, item)), item),
        )
        return cls(
            candidates=MappingProxyType(
                {key: candidates[key] for key in ordered_keys}
            ),
            display_paths=MappingProxyType(dict(displays)),
        )

    def resolve(self, raw_key: str) -> tuple[WildcardCandidate, ...]:
        key = normalize_key(raw_key)
        if key.startswith("*/"):
            basename = key[2:].rsplit("/", 1)[-1]
            matches = sorted(
                (
                    candidate_key
                    for candidate_key in self.candidates
                    if candidate_key.rsplit("/", 1)[-1] == basename
                ),
                key=lambda item: (_natural_key(self.display_paths.get(item, item)), item),
            )
            return tuple(
                candidate
                for match in matches
                for candidate in self.candidates[match]
            )
        direct = self.candidates.get(key)
        if direct is not None:
            return direct
        prefix = "" if key == ROOT_WILDCARD_KEY else f"{key}/"
        matches = (
            self.candidates
            if key == ROOT_WILDCARD_KEY
            else (
                candidate_key
                for candidate_key in self.candidates
                if candidate_key.startswith(prefix)
            )
        )
        return tuple(
            candidate
            for candidate_key in matches
            for candidate in self.candidates[candidate_key]
        )


def _is_pm4a_prompt_library_name(name: str) -> bool:
    return name == "services.prompt_library" or name.endswith(".services.prompt_library")


def _pm4a_prompt_library_module() -> Any | None:
    global _PM4A_LIBRARY_MODULE
    if _PM4A_LIBRARY_MODULE:
        cached = sys.modules.get(_PM4A_LIBRARY_MODULE)
        if cached is not None:
            return cached
        _PM4A_LIBRARY_MODULE = ""
    for name, module in tuple(sys.modules.items()):
        if module is None or not _is_pm4a_prompt_library_name(name):
            continue
        if (
            not callable(getattr(module, "snapshot_resolver", None))
            or not hasattr(module, "create_entry")
            or not hasattr(module, "ensure_loaded")
            or not hasattr(module, "get_wildcards_path")
        ):
            continue
        _PM4A_LIBRARY_MODULE = name
        return module
    return None


def snapshot_resolver() -> Any:
    """Return 4APM's live resolver, or a no-op when that plugin is not loaded."""
    module = _pm4a_prompt_library_module()
    if module is None:
        return PASSTHROUGH_RESOLVER
    try:
        return module.snapshot_resolver()
    except Exception as exc:
        logger.warning("4APM in-memory wildcard snapshot is unavailable: %s", exc)
        return PASSTHROUGH_RESOLVER

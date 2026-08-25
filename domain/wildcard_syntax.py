"""Shared value objects for the isolated NovelAI wildcard engine."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol, Sequence


@dataclass(frozen=True)
class WildcardCandidate:
    """One selectable TXT line or JSON prompt card."""

    key: str
    content: str
    negative: str = ""
    parameters: dict[str, Any] = field(default_factory=dict)
    nai: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ExpansionResult:
    """Expanded text plus metadata from the selected JSON cards."""

    text: str
    negatives: tuple[str, ...] = ()
    selected_keys: tuple[str, ...] = ()
    parameters: dict[str, Any] = field(default_factory=dict)
    nai: dict[str, Any] = field(default_factory=dict)
    negative_keys: tuple[str, ...] = ()
    characters: tuple[dict[str, Any], ...] = ()


@dataclass(frozen=True)
class ExpansionContext:
    seed: int
    mode: str = "random"
    execution_index: int = 0
    track_id: str = ""
    max_depth: int = 100


class WildcardResolver(Protocol):
    def resolve(self, key: str) -> Sequence[WildcardCandidate]: ...


class WildcardSyntaxError(ValueError):
    """Wildcard source text is malformed."""


class WildcardResolutionError(LookupError):
    """A syntactically valid wildcard cannot be expanded."""

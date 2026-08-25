"""NovelAI-only wildcard parsing and deterministic expansion.

Only plain ``__key__`` references are executable syntax. Braces, brackets,
weights, and Impact-style ``N#__key__`` expressions remain literal text.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from hashlib import sha256
from random import Random
from typing import Any, Sequence

try:
    from .anima_to_nai import PromptSyntaxError, convert_prompt
    from .wildcard_syntax import (
        ExpansionContext,
        ExpansionResult,
        WildcardCandidate,
        WildcardResolutionError,
        WildcardResolver,
        WildcardSyntaxError,
    )
except ImportError:  # pragma: no cover - standalone import convenience
    from domain.anima_to_nai import PromptSyntaxError, convert_prompt  # type: ignore
    from domain.wildcard_syntax import (  # type: ignore
        ExpansionContext,
        ExpansionResult,
        WildcardCandidate,
        WildcardResolutionError,
        WildcardResolver,
        WildcardSyntaxError,
    )


NAI_PARAMETER_KEYS = (
    "steps",
    "cfg",
    "sampler",
    "scheduler",
    "cfg_rescale",
)
_MODES = {"random", "sequence", "shuffle"}


@dataclass(frozen=True)
class _Literal:
    text: str


@dataclass(frozen=True)
class _Reference:
    key: str
    position: int


_Node = _Literal | _Reference
_Sequence = tuple[_Node, ...]


@dataclass
class _RuntimeState:
    occurrences: dict[str, int]


@dataclass
class _ResultAccumulator:
    negatives: list[str]
    negative_keys: list[str]
    selected_keys: list[str]
    parameters_list: list[dict[str, Any]]
    nai_list: list[dict[str, Any]]
    characters: list[dict[str, Any]]


def copy_nai_payload(value: Any) -> dict[str, Any]:
    """Copy only the five card-controlled NovelAI sampler fields."""
    if not isinstance(value, dict):
        return {}
    raw_parameters = value.get("parameters")
    if not isinstance(raw_parameters, dict):
        return {}
    parameters = {
        key: raw_parameters[key]
        for key in NAI_PARAMETER_KEYS
        if key in raw_parameters
    }
    return {"parameters": parameters} if parameters else {}


def merge_nai_payloads(*items: Any) -> dict[str, Any]:
    """Merge sparse NAI settings in selection order; first value wins."""
    parameters: dict[str, Any] = {}
    for item in items:
        copied = copy_nai_payload(item)
        for key, value in copied.get("parameters", {}).items():
            parameters.setdefault(key, value)
    return {"parameters": parameters} if parameters else {}


def _character_templates(
    candidate: WildcardCandidate,
    mode: str,
) -> tuple[dict[str, Any], ...]:
    raw = candidate.nai.get("characters") if isinstance(candidate.nai, dict) else ()
    if not isinstance(raw, (list, tuple)):
        return ()
    templates: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        has_position = "x" in item and "y" in item
        templates.append(
            {
                "positive": str(item.get("positive", "")),
                "negative": str(item.get("negative", "")),
                "use_position": has_position,
                "x": float(item["x"]) if has_position else 0.5,
                "y": float(item["y"]) if has_position else 0.5,
                "_mode": mode,
                "_source_key": candidate.key,
            }
        )
    return tuple(templates)


def _nai_block(candidate: Any) -> dict[str, Any]:
    nai = getattr(candidate, "nai", None)
    return nai if isinstance(nai, dict) else {}


def _nai_or_converted(nai_value: Any, fallback: Any) -> str:
    if isinstance(nai_value, str) and nai_value.strip():
        return nai_value
    text = fallback if isinstance(fallback, str) else ""
    if not text:
        return ""
    try:
        return convert_prompt(text)
    except PromptSyntaxError as exc:
        raise ValueError(f"无法将提示词从 Comfy/Anima 权重语法转换为 NAI：{exc}") from exc


def prompt_for_nai(candidate: Any) -> str:
    """Prefer stored NAI text; otherwise convert Comfy/Anima weights."""
    return _nai_or_converted(
        _nai_block(candidate).get("content"),
        getattr(candidate, "content", ""),
    )


def negative_for_nai(candidate: Any) -> str:
    """Prefer stored NAI negative; otherwise convert Comfy/Anima weights."""
    return _nai_or_converted(
        _nai_block(candidate).get("negative"),
        getattr(candidate, "negative", ""),
    )


def candidate_character_texts(candidate: WildcardCandidate) -> tuple[str, ...]:
    """Return card character prompt texts for cycle counting."""
    texts: list[str] = []
    for item in _character_templates(candidate, "sequence"):
        if item["positive"].strip():
            texts.append(item["positive"])
        if item["negative"].strip():
            texts.append(item["negative"])
    return tuple(texts)


def _without_comment_lines(text: str) -> tuple[str, tuple[int, ...]]:
    kept: list[str] = []
    positions: list[int] = []
    offset = 0
    for line in text.splitlines(keepends=True):
        if not line.lstrip().startswith("#"):
            kept.append(line)
            positions.extend(range(offset, offset + len(line)))
        offset += len(line)
    return "".join(kept), tuple(positions)


def _source_position(positions: tuple[int, ...], index: int) -> int:
    if index < len(positions):
        return positions[index] + 1
    if positions:
        return positions[-1] + 2
    return index + 1


def _parse_reference(
    text: str,
    positions: tuple[int, ...],
    opening: int,
) -> tuple[_Reference, int]:
    index = opening
    while index < len(text) and text[index] == "_":
        index += 1
    key_start = index
    while index < len(text):
        if text[index : index + 2] == "__":
            break
        index += 1
    if index == len(text):
        message = (
            "空通配符键"
            if key_start == index and index - opening >= 4
            else "未闭合的通配符引用"
        )
        raise WildcardSyntaxError(
            f"{message}，位置 {_source_position(positions, opening)}"
        )
    key = text[key_start:index].strip()
    if not key:
        raise WildcardSyntaxError(
            f"空通配符键，位置 {_source_position(positions, opening)}"
        )
    while index < len(text) and text[index] == "_":
        index += 1
    return _Reference(key, _source_position(positions, opening)), index


def _n_hash_digit_start(text: str, opening: int) -> int | None:
    if opening < 2 or text[opening - 1] != "#":
        return None
    position = opening - 2
    if position < 0 or not text[position].isascii() or not text[position].isdigit():
        return None
    while (
        position >= 0
        and text[position].isascii()
        and text[position].isdigit()
    ):
        position -= 1
    return position + 1


def _skip_n_hash_literal(text: str, opening: int) -> int:
    index = opening + 2
    while index < len(text):
        if text[index : index + 2] == "__":
            index += 2
            while index < len(text) and text[index] == "_":
                index += 1
            return index
        index += 1
    return len(text)


def _scan(text: str, positions: tuple[int, ...]) -> _Sequence:
    nodes: list[_Node] = []
    literal_start = 0
    index = 0
    while index < len(text):
        if text[index : index + 2] != "__":
            index += 1
            continue
        if _n_hash_digit_start(text, index) is not None:
            index = _skip_n_hash_literal(text, index)
            continue
        if literal_start < index:
            nodes.append(_Literal(text[literal_start:index]))
        reference, index = _parse_reference(text, positions, index)
        nodes.append(reference)
        literal_start = index
    if literal_start < len(text):
        nodes.append(_Literal(text[literal_start:]))
    return tuple(nodes)


def parse(text: str) -> _Sequence:
    if not isinstance(text, str):
        raise TypeError("wildcard text must be a string")
    uncommented, positions = _without_comment_lines(text)
    return _scan(uncommented, positions)


def reference_keys(text: str) -> tuple[str, ...]:
    return tuple(node.key for node in parse(text) if isinstance(node, _Reference))


def _product(sizes: Sequence[int]) -> int:
    total = 1
    for size in sizes:
        total *= size
    return total


def _decode_product_coords(index: int, sizes: Sequence[int]) -> tuple[int, ...]:
    coords = [0] * len(sizes)
    remaining = int(index)
    for axis in range(len(sizes) - 1, -1, -1):
        coords[axis] = remaining % sizes[axis]
        remaining //= sizes[axis]
    return tuple(coords)


def _option_stack_entry(candidate_key: str, option_index: int) -> str:
    return f"{candidate_key}#{option_index}"


def _leaf_count_key(
    key: str,
    resolver: WildcardResolver,
    stack: tuple[str, ...],
    max_depth: int,
) -> int:
    if not key or key in stack or len(stack) >= max_depth:
        return 0
    candidates = tuple(resolver.resolve(key))
    if not candidates:
        return 0
    next_stack = stack + (key,)
    total = 0
    for option_index, candidate in enumerate(candidates):
        nested = _leaf_count_nodes(
            parse(prompt_for_nai(candidate)),
            resolver,
            next_stack + (_option_stack_entry(candidate.key, option_index),),
            max_depth,
        )
        total += nested if nested > 0 else 1
    return total


def _leaf_count_nodes(
    nodes: _Sequence,
    resolver: WildcardResolver,
    stack: tuple[str, ...],
    max_depth: int,
) -> int:
    axes = [
        count
        for node in nodes
        if isinstance(node, _Reference)
        and (count := _leaf_count_key(node.key, resolver, stack, max_depth)) > 0
    ]
    return _product(axes) if axes else 0


def sequential_leaf_count(
    text: str,
    resolver: WildcardResolver,
    *,
    max_depth: int = 100,
    stack: tuple[str, ...] = (),
) -> int:
    if not isinstance(text, str) or not text.strip() or max_depth < 1:
        return 0
    return _leaf_count_nodes(parse(text), resolver, stack, max_depth)


def _seed(context: ExpansionContext, occurrence: int, purpose: str) -> int:
    payload = "\x1f".join(
        (
            str(context.seed),
            context.track_id,
            str(context.execution_index),
            str(occurrence),
            purpose,
        )
    )
    return int.from_bytes(sha256(payload.encode("utf-8")).digest(), "big")


def _shuffle_seed(context: ExpansionContext, cycle: int, purpose: str) -> int:
    payload = "\x1f".join(
        (str(context.seed), context.track_id, str(cycle), purpose)
    )
    return int.from_bytes(sha256(payload.encode("utf-8")).digest(), "big")


@lru_cache(maxsize=32)
def _shuffled_order(size: int, seed: int) -> tuple[int, ...]:
    order = list(range(size))
    Random(seed).shuffle(order)
    return tuple(order)


def _pick_leaf_index(size: int, context: ExpansionContext) -> int:
    if context.mode == "sequence":
        return context.execution_index % size
    if context.mode == "shuffle":
        cycle, offset = divmod(context.execution_index, size)
        return _shuffled_order(
            size,
            _shuffle_seed(context, cycle, "leaf-space"),
        )[offset]
    return Random(_seed(context, 0, "leaf-space")).randrange(size)


def _next_occurrence(state: _RuntimeState, purpose: str) -> int:
    occurrence = state.occurrences.get(purpose, 0)
    state.occurrences[purpose] = occurrence + 1
    return occurrence


def _choose_candidate(
    size: int,
    context: ExpansionContext,
    occurrence: int,
    purpose: str,
) -> int:
    if context.mode == "sequence":
        return (context.execution_index + occurrence) % size
    if context.mode == "shuffle":
        absolute = context.execution_index + occurrence
        cycle, offset = divmod(absolute, size)
        return _shuffled_order(
            size,
            _shuffle_seed(context, cycle, f"{purpose}:shuffle"),
        )[offset]
    return Random(_seed(context, occurrence, f"{purpose}:random")).randrange(size)


def _candidate_content(
    candidate: WildcardCandidate,
    reference: _Reference,
    resolver: WildcardResolver,
    context: ExpansionContext,
    state: _RuntimeState,
    accumulator: _ResultAccumulator,
    stack: tuple[str, ...],
    *,
    content_leaf_index: int | None,
) -> str:
    if candidate.key in stack:
        raise WildcardResolutionError(
            f"检测到循环通配符引用 {reference.key!r}，位置 {reference.position}"
        )
    negative = negative_for_nai(candidate)
    if negative:
        accumulator.negatives.append(negative)
        accumulator.negative_keys.append(candidate.key)
    accumulator.selected_keys.append(candidate.key)
    if candidate.parameters:
        accumulator.parameters_list.append(dict(candidate.parameters))
    if candidate.nai:
        copied = copy_nai_payload(candidate.nai)
        if copied:
            accumulator.nai_list.append(copied)
        accumulator.characters.extend(_character_templates(candidate, context.mode))
    return _expand_nodes(
        parse(prompt_for_nai(candidate)),
        resolver,
        context,
        state,
        accumulator,
        stack + (candidate.key,),
        leaf_index=content_leaf_index,
    )


def _resolve_reference(
    reference: _Reference,
    resolver: WildcardResolver,
    context: ExpansionContext,
    state: _RuntimeState,
    accumulator: _ResultAccumulator,
    stack: tuple[str, ...],
) -> str:
    if len(stack) >= context.max_depth:
        raise WildcardResolutionError(
            f"通配符引用超过最大深度 {context.max_depth}，位置 {reference.position}"
        )
    candidates = tuple(resolver.resolve(reference.key))
    if not candidates:
        raise WildcardResolutionError(
            f"无法解析通配符 {reference.key!r}，位置 {reference.position}"
        )
    purpose = f"wildcard:{reference.key}"
    occurrence = _next_occurrence(state, purpose)
    chosen = _choose_candidate(len(candidates), context, occurrence, purpose)
    return _candidate_content(
        candidates[chosen],
        reference,
        resolver,
        context,
        state,
        accumulator,
        stack,
        content_leaf_index=None,
    )


def _resolve_reference_at_leaf(
    reference: _Reference,
    leaf_index: int,
    resolver: WildcardResolver,
    context: ExpansionContext,
    state: _RuntimeState,
    accumulator: _ResultAccumulator,
    stack: tuple[str, ...],
) -> str:
    if len(stack) >= context.max_depth:
        raise WildcardResolutionError(
            f"通配符引用超过最大深度 {context.max_depth}，位置 {reference.position}"
        )
    if reference.key in stack:
        raise WildcardResolutionError(
            f"检测到循环通配符引用 {reference.key!r}，位置 {reference.position}"
        )
    candidates = tuple(resolver.resolve(reference.key))
    if not candidates:
        raise WildcardResolutionError(
            f"无法解析通配符 {reference.key!r}，位置 {reference.position}"
        )
    next_stack = stack + (reference.key,)
    remaining = int(leaf_index)
    for option_index, candidate in enumerate(candidates):
        nested = _leaf_count_nodes(
            parse(prompt_for_nai(candidate)),
            resolver,
            next_stack + (_option_stack_entry(candidate.key, option_index),),
            context.max_depth,
        )
        branch_size = nested if nested > 0 else 1
        if remaining < branch_size:
            return _candidate_content(
                candidate,
                reference,
                resolver,
                context,
                state,
                accumulator,
                stack,
                content_leaf_index=remaining if nested > 0 else None,
            )
        remaining -= branch_size
    total = _leaf_count_key(reference.key, resolver, stack, context.max_depth)
    if total < 1:
        raise WildcardResolutionError(
            f"无法解析通配符 {reference.key!r}，位置 {reference.position}"
        )
    return _resolve_reference_at_leaf(
        reference,
        leaf_index % total,
        resolver,
        context,
        state,
        accumulator,
        stack,
    )


def _expand_nodes(
    nodes: _Sequence,
    resolver: WildcardResolver,
    context: ExpansionContext,
    state: _RuntimeState,
    accumulator: _ResultAccumulator,
    stack: tuple[str, ...],
    *,
    leaf_index: int | None,
) -> str:
    references = [node for node in nodes if isinstance(node, _Reference)]
    coordinates: tuple[int, ...] | None = None
    if references and leaf_index is not None:
        sizes = [
            _leaf_count_key(node.key, resolver, stack, context.max_depth)
            for node in references
        ]
        missing = next((node for node, size in zip(references, sizes) if size < 1), None)
        if missing is not None:
            raise WildcardResolutionError(
                f"无法解析通配符 {missing.key!r}，位置 {missing.position}"
            )
        coordinates = _decode_product_coords(leaf_index % _product(sizes), sizes)

    parts: list[str] = []
    reference_index = 0
    for node in nodes:
        if isinstance(node, _Literal):
            parts.append(node.text)
            continue
        if coordinates is None:
            parts.append(
                _resolve_reference(
                    node,
                    resolver,
                    context,
                    state,
                    accumulator,
                    stack,
                )
            )
        else:
            parts.append(
                _resolve_reference_at_leaf(
                    node,
                    coordinates[reference_index],
                    resolver,
                    context,
                    state,
                    accumulator,
                    stack,
                )
            )
            reference_index += 1
    return "".join(parts)


def _merge_parameters(*items: dict[str, Any]) -> dict[str, Any]:
    """Merge first-win metadata while keeping width/height from one card."""
    merged: dict[str, Any] = {}
    claimed: set[str] = set()
    size_claimed = False
    for item in items:
        if not isinstance(item, dict) or not item:
            continue
        if not size_claimed and ("width" in item or "height" in item):
            if "width" in item:
                merged["width"] = item["width"]
            if "height" in item:
                merged["height"] = item["height"]
            size_claimed = True
        for key, value in item.items():
            if key in {"width", "height"} or key in claimed:
                continue
            claimed.add(key)
            merged[key] = value
    return merged


def expand(
    text: str,
    resolver: WildcardResolver,
    context: ExpansionContext,
) -> ExpansionResult:
    if context.mode not in _MODES:
        raise WildcardSyntaxError(f"无效的通配符选择模式：{context.mode}")
    if context.max_depth < 1:
        raise WildcardSyntaxError("通配符最大递归深度必须至少为 1")
    nodes = parse(text)
    leaf_size = _leaf_count_nodes(nodes, resolver, (), context.max_depth)
    leaf_index = _pick_leaf_index(leaf_size, context) if leaf_size > 0 else None
    accumulator = _ResultAccumulator([], [], [], [], [], [])
    expanded = _expand_nodes(
        nodes,
        resolver,
        context,
        _RuntimeState({}),
        accumulator,
        (),
        leaf_index=leaf_index,
    )
    return ExpansionResult(
        text=expanded,
        negatives=tuple(accumulator.negatives),
        negative_keys=tuple(accumulator.negative_keys),
        selected_keys=tuple(accumulator.selected_keys),
        parameters=_merge_parameters(*accumulator.parameters_list),
        nai=merge_nai_payloads(*accumulator.nai_list),
        characters=tuple(accumulator.characters),
    )

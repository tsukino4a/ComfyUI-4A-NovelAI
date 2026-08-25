"""Independent NovelAI prompt planning and single-use run snapshots."""

from __future__ import annotations

import copy
import json
import math
import re
import threading
import time
import uuid
from collections import OrderedDict
from typing import Any, Iterable, Mapping

try:
    from ..domain import nai_wildcard_syntax
    from ..domain.wildcard_syntax import (
        ExpansionContext,
        ExpansionResult,
        WildcardResolutionError,
        WildcardResolver,
    )
    from . import wildcard_library
except ImportError:  # pragma: no cover - standalone test collection
    from domain import nai_wildcard_syntax  # type: ignore
    from domain.wildcard_syntax import (  # type: ignore
        ExpansionContext,
        ExpansionResult,
        WildcardResolutionError,
        WildcardResolver,
    )
    from services import wildcard_library  # type: ignore


TRACK_MODES = {"sequence", "random", "shuffle"}
RUN_TTL_SECONDS = 24 * 60 * 60
MAX_CACHED_RUNS = 128
EXTERNAL_TRACK_PREFIX = "pm4a_track_"

_run_lock = threading.RLock()
_runs: "OrderedDict[str, dict[str, Any]]" = OrderedDict()


def _string_field(
    raw: Mapping[str, Any],
    field: str,
    *,
    default: str,
    label: str,
    strip: bool = False,
) -> str:
    value = raw[field] if field in raw else default
    if not isinstance(value, str):
        raise ValueError(f"{label}必须是字符串")
    return value.strip() if strip else value


def _bool_field(
    raw: Mapping[str, Any],
    field: str,
    *,
    default: bool,
    label: str,
) -> bool:
    value = raw[field] if field in raw else default
    if type(value) is not bool:
        raise ValueError(f"{label}必须是布尔值")
    return value


def _integer_field(
    raw: Mapping[str, Any],
    field: str,
    *,
    default: int,
    minimum: int,
    label: str,
) -> int:
    value = raw[field] if field in raw else default
    if type(value) is not int:
        raise ValueError(f"{label}必须是整数")
    return max(minimum, value)


def _coordinate_field(
    raw: Mapping[str, Any],
    field: str,
    *,
    default: float,
    label: str,
) -> float:
    value = raw[field] if field in raw else default
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label}必须是数字")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"{label}必须是有限数字")
    return max(0.0, min(1.0, number))


def _normalize_mode(raw: Mapping[str, Any], label: str) -> str:
    mode = _string_field(
        raw,
        "mode",
        default="sequence",
        label=f"{label}循环模式",
        strip=True,
    ).lower()
    if mode not in TRACK_MODES:
        raise ValueError(f"{label}循环模式无效")
    return mode


def _normalize_id(
    raw: Mapping[str, Any],
    *,
    default: str,
    label: str,
    seen: set[str],
) -> str:
    item_id = _string_field(
        raw,
        "id",
        default=default,
        label=f"{label} ID",
        strip=True,
    )
    if not item_id:
        raise ValueError(f"{label} ID 不能为空")
    if item_id in seen:
        raise ValueError(f"{label} ID 不能重复")
    seen.add(item_id)
    return item_id


def normalize_config(value: Any) -> dict[str, Any]:
    """Strictly validate the scheduler widget's JSON contract."""
    if isinstance(value, str):
        try:
            value = json.loads(value or "{}")
        except json.JSONDecodeError as exc:
            raise ValueError(f"NAI 循环节点配置无法解析：{exc}") from exc
    if not isinstance(value, dict):
        raise ValueError("NAI 循环节点配置必须是对象")

    tracks_raw = value.get("tracks", [])
    if not isinstance(tracks_raw, list):
        raise ValueError("NAI 栏目配置必须是数组")
    tracks: list[dict[str, Any]] = []
    track_ids: set[str] = set()
    for index, raw in enumerate(tracks_raw):
        if not isinstance(raw, dict):
            raise ValueError(f"第 {index + 1} 个 NAI 栏目配置无效")
        label = f"第 {index + 1} 个 NAI 栏目"
        item_id = _normalize_id(
            raw,
            default=f"track-{index + 1}",
            label="栏目",
            seen=track_ids,
        )
        name = _string_field(
            raw,
            "name",
            default=f"栏目 {index + 1}",
            label=f"{label}名称",
            strip=True,
        )
        tracks.append(
            {
                "id": item_id,
                "name": name or f"栏目 {index + 1}",
                "enabled": _bool_field(
                    raw,
                    "enabled",
                    default=True,
                    label=f"{label}启用状态",
                ),
                "text": _string_field(
                    raw,
                    "text",
                    default="",
                    label=f"{label}提示词",
                ),
                "mode": _normalize_mode(raw, label),
            }
        )

    characters_raw = value.get("characters", [])
    if not isinstance(characters_raw, list):
        raise ValueError("NAI 角色配置必须是数组")
    characters: list[dict[str, Any]] = []
    character_ids: set[str] = set()
    for index, raw in enumerate(characters_raw):
        if not isinstance(raw, dict):
            raise ValueError(f"第 {index + 1} 个 NAI 角色配置无效")
        label = f"第 {index + 1} 个 NAI 角色"
        item_id = _normalize_id(
            raw,
            default=f"char-{index + 1}",
            label="角色",
            seen=character_ids,
        )
        name = _string_field(
            raw,
            "name",
            default=f"角色 {index + 1}",
            label=f"{label}名称",
            strip=True,
        )
        characters.append(
            {
                "id": item_id,
                "name": name or f"角色 {index + 1}",
                "enabled": _bool_field(
                    raw,
                    "enabled",
                    default=True,
                    label=f"{label}启用状态",
                ),
                "positive": _string_field(
                    raw,
                    "positive",
                    default="",
                    label=f"{label}正面提示词",
                ),
                "negative": _string_field(
                    raw,
                    "negative",
                    default="",
                    label=f"{label}负面提示词",
                ),
                "mode": _normalize_mode(raw, label),
                "use_position": _bool_field(
                    raw,
                    "use_position",
                    default=False,
                    label=f"{label}位置开关",
                ),
                "x": _coordinate_field(
                    raw,
                    "x",
                    default=0.5,
                    label=f"{label}横坐标",
                ),
                "y": _coordinate_field(
                    raw,
                    "y",
                    default=0.5,
                    label=f"{label}纵坐标",
                ),
                "use_order": _bool_field(
                    raw,
                    "use_order",
                    default=False,
                    label=f"{label}顺序开关",
                ),
            }
        )

    return {
        "start_index": _integer_field(
            value,
            "start_index",
            default=0,
            minimum=0,
            label="起始位置",
        ),
        "task_count": _integer_field(
            value,
            "task_count",
            default=1,
            minimum=1,
            label="任务数量",
        ),
        "negative": _string_field(
            value,
            "negative",
            default="",
            label="固定负面提示词",
        ),
        "tracks": tracks,
        "characters": characters,
        "use_coords": _bool_field(
            value,
            "use_coords",
            default=False,
            label="角色位置开关",
        ),
        "positions_initialized": _bool_field(
            value,
            "positions_initialized",
            default=False,
            label="角色位置初始化状态",
        ),
        "settings_apply_nai": _bool_field(
            value,
            "settings_apply_nai",
            default=False,
            label="NAI 设置应用开关",
        ),
    }


def external_track_input_name(track_id: str) -> str:
    """Encode an arbitrary track id into a safe ComfyUI input name."""
    return f"{EXTERNAL_TRACK_PREFIX}{str(track_id).encode('utf-8').hex()}"


def wildcard_keys(text: str) -> list[str]:
    if not isinstance(text, str) or not text:
        return []
    return list(
        dict.fromkeys(
            wildcard_library.normalize_key(key)
            for key in nai_wildcard_syntax.reference_keys(text)
            if key.strip()
        )
    )


def folder_counts(
    folder_keys: Iterable[str],
    resolver: WildcardResolver | None = None,
) -> dict[str, int]:
    keys = list(
        dict.fromkeys(
            wildcard_library.normalize_key(key)
            for key in folder_keys
            if isinstance(key, str) and key.strip()
        )
    )
    if not keys:
        return {}
    active = resolver or wildcard_library.snapshot_resolver()
    if wildcard_library.is_passthrough_resolver(active):
        return {}
    return {
        key: len(active.resolve(key))
        for key in keys
    }


def _sequence_texts(clean: Mapping[str, Any]) -> Iterable[str]:
    for track in clean["tracks"]:
        if track["enabled"] and track["mode"] == "sequence":
            yield track["text"]
    for character in clean["characters"]:
        if character["enabled"] and character["mode"] == "sequence":
            yield character["positive"]
            yield character["negative"]


def _cycle_references_and_companions(
    text: str,
    *,
    resolver: WildcardResolver,
    max_depth: int = 100,
) -> tuple[list[str], list[str]]:
    keys: list[str] = []
    companions: list[str] = []

    def visit(source: str, stack: tuple[str, ...], depth: int) -> None:
        if not source.strip() or depth >= max_depth:
            return
        for raw_key in nai_wildcard_syntax.reference_keys(source):
            key = wildcard_library.normalize_key(raw_key)
            if not key:
                continue
            keys.append(key)
            if key in stack:
                continue
            for candidate in resolver.resolve(key):
                marker = wildcard_library.normalize_key(candidate.key) or key
                next_stack = stack + (marker,)
                visit(nai_wildcard_syntax.prompt_for_nai(candidate), next_stack, depth + 1)
                negative = nai_wildcard_syntax.negative_for_nai(candidate)
                if negative:
                    companions.append(negative)
                    visit(negative, next_stack, depth + 1)
                for text in nai_wildcard_syntax.candidate_character_texts(candidate):
                    companions.append(text)
                    visit(text, next_stack, depth + 1)

    visit(text, (), 0)
    return keys, companions


def cycle_summary(
    config: Any,
    *,
    resolver: WildcardResolver | None = None,
) -> dict[str, Any]:
    """Use the longest sequential field as the scheduler cycle length."""
    clean = normalize_config(config)
    sequence_texts = [text for text in _sequence_texts(clean) if text.strip()]
    active = _resolver_for_texts(sequence_texts, resolver)
    if wildcard_library.is_passthrough_resolver(active):
        return {"counts": {}, "maximum": 0}
    keys: list[str] = []
    companion_texts: list[str] = []
    lengths: list[int] = []
    for text in sequence_texts:
        reachable, companions = _cycle_references_and_companions(
            text,
            resolver=active,
        )
        keys.extend(reachable)
        companion_texts.extend(companions)
        lengths.append(nai_wildcard_syntax.sequential_leaf_count(text, active))
    for companion in dict.fromkeys(companion_texts):
        if companion.strip():
            lengths.append(
                nai_wildcard_syntax.sequential_leaf_count(companion, active)
            )
    return {
        "counts": folder_counts(dict.fromkeys(keys), resolver=active),
        "maximum": max(lengths, default=0),
    }


def _expand(
    text: str,
    *,
    resolver: WildcardResolver,
    seed: int,
    mode: str,
    execution_index: int,
    track_id: str,
    max_depth: int = 100,
) -> ExpansionResult:
    if wildcard_library.is_passthrough_resolver(resolver):
        return ExpansionResult(text=text)
    return nai_wildcard_syntax.expand(
        text,
        resolver,
        ExpansionContext(
            seed=int(seed),
            mode=mode,
            execution_index=int(execution_index),
            track_id=track_id,
            max_depth=max_depth,
        ),
    )


def cleanup_prompt_commas(text: str) -> str:
    if not isinstance(text, str) or not text.strip():
        return ""
    cleaned = re.sub(r",(?:\s*,)+", ",", text)
    return re.sub(r"^(?:\s*,\s*)+", "", cleaned)


def join_prompt_parts(*parts: str) -> str:
    cleaned = [
        value
        for value in (
            cleanup_prompt_commas(part)
            for part in parts
            if isinstance(part, str)
        )
        if value.strip()
    ]
    if not cleaned:
        return ""
    joined = cleaned[0]
    for part in cleaned[1:]:
        joined += (" " if joined.rstrip().endswith(",") else ", ") + part
    return cleanup_prompt_commas(joined)


def _companion_ancestry(
    result: ExpansionResult,
    index: int,
    stack: tuple[str, ...] = (),
) -> tuple[str, ...]:
    owner = ""
    if index < len(result.negative_keys):
        owner = result.negative_keys[index]
    if not owner and len(result.selected_keys) == 1:
        owner = result.selected_keys[0]
    return stack + ((owner,) if owner else ())


def _negative_expansion(
    text: str,
    *,
    resolver: WildcardResolver,
    seed: int,
    mode: str,
    execution_index: int,
    track_id: str,
    max_depth: int = 100,
    depth: int = 0,
    stack: tuple[str, ...] = (),
    card_characters: list[dict[str, Any]] | None = None,
) -> str:
    if depth >= max_depth and text.strip():
        raise WildcardResolutionError(
            f"负面 companion 展开超过最大深度 {max_depth}"
        )
    result = _expand(
        text,
        resolver=resolver,
        seed=seed,
        mode=mode,
        execution_index=execution_index,
        track_id=track_id,
        max_depth=max_depth,
    )
    if card_characters is not None:
        card_characters.extend(result.characters)
    repeated = next((key for key in result.selected_keys if key in stack), None)
    if repeated is not None:
        raise WildcardResolutionError(
            f"检测到负面 companion 循环引用 {repeated!r}"
        )
    parts = [result.text]
    for index, companion in enumerate(result.negatives):
        child_text = _negative_expansion(
            companion,
            resolver=resolver,
            seed=seed,
            mode=mode,
            execution_index=execution_index,
            track_id=f"{track_id}:companion:{index}",
            max_depth=max_depth,
            depth=depth + 1,
            stack=_companion_ancestry(result, index, stack),
            card_characters=card_characters,
        )
        parts.append(child_text)
    return join_prompt_parts(*parts)


def _runtime_plan(results: Iterable[ExpansionResult]) -> dict[str, Any]:
    result_list = list(results)
    explicit = [result.nai for result in result_list if result.nai]
    runtime = (
        nai_wildcard_syntax.merge_nai_payloads(*explicit)
        if explicit
        else {}
    )
    ratio_claim: dict[str, Any] = {}
    for result in result_list:
        parameters = result.parameters
        if "width" in parameters or "height" in parameters:
            ratio_claim = {
                key: parameters[key]
                for key in ("width", "height")
                if key in parameters
            }
            break
    if set(ratio_claim) == {"width", "height"}:
        runtime["ratio_hint"] = ratio_claim
    return runtime


def _output_character(
    *,
    positive: str,
    negative: str,
    use_position: bool,
    x: Any,
    y: Any,
) -> dict[str, Any]:
    return {
        "positive": positive,
        "negative": negative,
        "use_position": bool(use_position),
        "x": float(x),
        "y": float(y),
        "use_order": True,
    }


def evenly_distributed_positions(
    count: int,
    width: int,
    height: int,
) -> list[dict[str, float]]:
    """Return the same aspect-aware initial character grid used by the UI."""
    total = max(0, int(count))
    if not total:
        return []
    ratio = max(0.25, min(4.0, float(width) / float(height or 1)))
    columns = max(1, min(total, math.ceil(math.sqrt(total * ratio))))
    rows = math.ceil(total / columns)
    return [
        {
            "x": round(((index % columns) + 0.5) / columns, 3),
            "y": round((math.floor(index / columns) + 0.5) / rows, 3),
        }
        for index in range(total)
    ]


def character_document(
    characters: Any,
    *,
    width: int,
    height: int,
) -> dict[str, Any]:
    """Build the editable JSON character document exposed by the node seam."""
    source = list(characters or [])
    defaults = evenly_distributed_positions(len(source), width, height)
    use_coords = any(bool(item.get("use_position")) for item in source)
    items: list[dict[str, Any]] = []
    for index, item in enumerate(source):
        position = item if item.get("use_position") else defaults[index]
        items.append(
            {
                "positive": str(item.get("positive", "")),
                "negative": str(item.get("negative", "")),
                "x": float(position["x"]),
                "y": float(position["y"]),
            }
        )
    return {"use_coords": use_coords, "characters": items}


def _expand_card_character(
    template: Mapping[str, Any],
    *,
    resolver: WildcardResolver,
    seed: int,
    execution_index: int,
    track_id: str,
    metadata_results: list[ExpansionResult],
    seen: frozenset[str] = frozenset(),
) -> list[dict[str, Any]]:
    mode = str(template.get("_mode") or "sequence")
    source_key = str(template.get("_source_key") or "")
    next_seen = seen | {source_key} if source_key else seen
    positive_result = _expand(
        str(template.get("positive") or ""),
        resolver=resolver,
        seed=seed,
        mode=mode,
        execution_index=execution_index,
        track_id=f"{track_id}:positive",
    )
    metadata_results.append(positive_result)
    nested: list[dict[str, Any]] = list(positive_result.characters)
    companion_parts: list[str] = []
    for negative_index, companion in enumerate(positive_result.negatives):
        companion_text = _negative_expansion(
            companion,
            resolver=resolver,
            seed=seed,
            mode=mode,
            execution_index=execution_index,
            track_id=f"{track_id}:companion:{negative_index}",
            stack=_companion_ancestry(positive_result, negative_index),
            card_characters=nested,
        )
        if companion_text.strip():
            companion_parts.append(companion_text)
    explicit_negative = _negative_expansion(
        str(template.get("negative") or ""),
        resolver=resolver,
        seed=seed,
        mode=mode,
        execution_index=execution_index,
        track_id=f"{track_id}:negative",
        card_characters=nested,
    )
    resolved = [
        _output_character(
            positive=cleanup_prompt_commas(positive_result.text),
            negative=join_prompt_parts(explicit_negative, *companion_parts),
            use_position=bool(template.get("use_position")),
            x=template.get("x", 0.5),
            y=template.get("y", 0.5),
        )
    ]
    for nested_index, nested_template in enumerate(nested):
        nested_source = str(nested_template.get("_source_key") or "")
        if nested_source and nested_source in next_seen:
            continue
        resolved.extend(
            _expand_card_character(
                nested_template,
                resolver=resolver,
                seed=seed,
                execution_index=execution_index,
                track_id=f"{track_id}:nested:{nested_index}",
                metadata_results=metadata_results,
                seen=next_seen,
            )
        )
    return resolved


def _external_text(
    original: str,
    item_id: str,
    external_inputs: Mapping[str, Any],
) -> str:
    name = external_track_input_name(item_id)
    if name not in external_inputs or external_inputs[name] is None:
        return original
    incoming = external_inputs[name]
    return incoming if isinstance(incoming, str) else str(incoming)


def _active_source_texts(
    clean: Mapping[str, Any],
    external_inputs: Mapping[str, Any],
) -> Iterable[str]:
    for track in clean["tracks"]:
        if track["enabled"]:
            yield _external_text(track["text"], track["id"], external_inputs)
    quality_track = next(
        (track for track in clean["tracks"] if track["id"] == "quality"),
        None,
    )
    if quality_track is None or quality_track["enabled"]:
        yield _external_text(clean["negative"], "negative", external_inputs)
    for character in clean["characters"]:
        if character["enabled"]:
            yield character["positive"]
            yield character["negative"]


def _resolver_for_texts(
    texts: Iterable[str],
    resolver: WildcardResolver | None,
) -> WildcardResolver:
    if resolver is not None:
        return resolver
    if any(wildcard_keys(text) for text in texts):
        return wildcard_library.snapshot_resolver()
    return wildcard_library.PASSTHROUGH_RESOLVER


def _active_resolver(
    clean: Mapping[str, Any],
    external_inputs: Mapping[str, Any],
    resolver: WildcardResolver | None,
) -> WildcardResolver:
    return _resolver_for_texts(
        _active_source_texts(clean, external_inputs),
        resolver,
    )


def compose_plan(
    config: Any,
    *,
    execution_index: int = 0,
    seed: int = 0,
    resolver: WildcardResolver | None = None,
    external_inputs: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Resolve one base prompt plus native NovelAI character list."""
    clean = normalize_config(config)
    selection_seed = int(seed)
    index = int(execution_index)
    external = external_inputs or {}
    active = _active_resolver(clean, external, resolver)

    positive_parts: list[str] = []
    global_companion_negatives: list[str] = []
    metadata_results: list[ExpansionResult] = []
    pending_card_characters: list[dict[str, Any]] = []

    for track in clean["tracks"]:
        if not track["enabled"]:
            continue
        expanded = _expand(
            _external_text(track["text"], track["id"], external),
            resolver=active,
            seed=selection_seed,
            mode=track["mode"],
            execution_index=index,
            track_id=track["id"],
        )
        metadata_results.append(expanded)
        pending_card_characters.extend(expanded.characters)
        prompt = cleanup_prompt_commas(expanded.text)
        if prompt.strip():
            positive_parts.append(prompt)
        for negative_index, companion in enumerate(expanded.negatives):
            text = _negative_expansion(
                companion,
                resolver=active,
                seed=selection_seed,
                mode=track["mode"],
                execution_index=index,
                track_id=f"{track['id']}:negative:{negative_index}",
                stack=_companion_ancestry(expanded, negative_index),
                card_characters=pending_card_characters,
            )
            if text.strip():
                global_companion_negatives.append(text)

    quality_track = next(
        (track for track in clean["tracks"] if track["id"] == "quality"),
        None,
    )
    quality_enabled = quality_track is None or quality_track["enabled"]
    negative_source = (
        _external_text(clean["negative"], "negative", external)
        if quality_enabled
        else ""
    )
    fixed_negative = _negative_expansion(
        negative_source,
        resolver=active,
        seed=selection_seed,
        mode="random",
        execution_index=index,
        track_id="fixed-negative",
        card_characters=pending_card_characters,
    )
    characters: list[dict[str, Any]] = []
    for character in clean["characters"]:
        if not character["enabled"]:
            continue
        positive_result = _expand(
            character["positive"],
            resolver=active,
            seed=selection_seed,
            mode=character["mode"],
            execution_index=index,
            track_id=f"character:{character['id']}:positive",
        )
        metadata_results.append(positive_result)
        pending_card_characters.extend(positive_result.characters)
        companion_parts: list[str] = []
        for negative_index, companion in enumerate(positive_result.negatives):
            companion_text = _negative_expansion(
                companion,
                resolver=active,
                seed=selection_seed,
                mode=character["mode"],
                execution_index=index,
                track_id=f"character:{character['id']}:companion:{negative_index}",
                stack=_companion_ancestry(positive_result, negative_index),
                card_characters=pending_card_characters,
            )
            if companion_text.strip():
                companion_parts.append(companion_text)
        explicit_negative = _negative_expansion(
            character["negative"],
            resolver=active,
            seed=selection_seed,
            mode=character["mode"],
            execution_index=index,
            track_id=f"character:{character['id']}:negative",
            card_characters=pending_card_characters,
        )
        characters.append(
            _output_character(
                positive=cleanup_prompt_commas(positive_result.text),
                negative=join_prompt_parts(
                    explicit_negative,
                    *companion_parts,
                ),
                use_position=clean["use_coords"],
                x=character["x"],
                y=character["y"],
            )
        )

    for card_index, template in enumerate(pending_card_characters):
        characters.extend(
            _expand_card_character(
                template,
                resolver=active,
                seed=selection_seed,
                execution_index=index,
                track_id=f"card-character:{card_index}",
                metadata_results=metadata_results,
            )
        )

    return {
        "execution_index": index,
        "positive": join_prompt_parts(*positive_parts),
        "negative": join_prompt_parts(
            fixed_negative,
            *global_companion_negatives,
        ),
        "characters": characters,
        "runtime_plan": _runtime_plan(metadata_results),
    }


def _prune_runs(now: float | None = None) -> None:
    current = time.time() if now is None else now
    for run_id in list(_runs):
        last_access = float(_runs[run_id].get("last_access", current))
        if current - last_access > RUN_TTL_SECONDS:
            _runs.pop(run_id, None)
    while len(_runs) > MAX_CACHED_RUNS:
        _runs.popitem(last=False)


def prepare_run(
    config: Any,
    task_count: int | None = None,
    *,
    seed: int = 0,
    resolver: WildcardResolver | None = None,
) -> dict[str, Any]:
    """Preflight every task against one resolver snapshot, then publish it."""
    clean = normalize_config(config)
    count = clean["task_count"] if task_count is None else task_count
    if type(count) is not int:
        raise ValueError("任务数量必须是整数")
    if count < 1:
        raise ValueError("任务数量至少为 1")
    if type(seed) is not int:
        raise ValueError("选择种子必须是整数")

    active = _active_resolver(clean, {}, resolver)
    plans = [
        compose_plan(
            clean,
            execution_index=clean["start_index"] + offset,
            seed=seed,
            resolver=active,
        )
        for offset in range(count)
    ]
    nai_settings_plans = (
        [
            {
                "execution_index": plan["execution_index"],
                **copy.deepcopy(plan["runtime_plan"]),
            }
            for plan in plans
        ]
        if clean["settings_apply_nai"]
        else []
    )
    run_id = uuid.uuid4().hex
    now = time.time()
    plans_by_index = {
        int(plan["execution_index"]): copy.deepcopy(
            {
                "positive": plan["positive"],
                "negative": plan["negative"],
                "characters": plan["characters"],
            }
        )
        for plan in plans
    }
    with _run_lock:
        _prune_runs(now)
        _runs[run_id] = {
            "plans": plans_by_index,
            "consumed_indexes": set(),
            "last_access": now,
        }
        _prune_runs(now)
    return {
        "run_id": run_id,
        "nai_settings_plans": nai_settings_plans,
    }


def acquire_run(run_id: str, execution_index: int) -> dict[str, Any]:
    """Atomically acquire one precomputed plan; each index is single-use."""
    if not isinstance(run_id, str) or not run_id:
        raise ValueError("run_id 不能为空")
    if type(execution_index) is not int:
        raise ValueError("执行索引必须是整数")
    with _run_lock:
        _prune_runs()
        run = _runs.get(run_id)
        if not run:
            raise RuntimeError("本轮 NAI 提示词快照已失效，请重新准备批量运行")
        if execution_index in run["consumed_indexes"]:
            raise RuntimeError(
                f"执行索引 {execution_index} 已消费，不能重复执行"
            )
        if execution_index not in run["plans"]:
            raise RuntimeError(
                f"执行索引 {execution_index} 未计划，不能用于本轮 NAI 批量运行"
            )
        plan = copy.deepcopy(run["plans"][execution_index])
        run["consumed_indexes"].add(execution_index)
        run["plans"].pop(execution_index, None)
        run["last_access"] = time.time()
        if run["plans"]:
            _runs.move_to_end(run_id)
        else:
            _runs.pop(run_id, None)
        return plan

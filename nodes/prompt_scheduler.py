"""ComfyUI node for isolated NovelAI prompt scheduling."""

from __future__ import annotations

import json

try:
    from ..services import scheduler
    from ..services.core import ASPECT_RATIOS, SIZE_CLASSES, resolve_size
except ImportError:  # pragma: no cover - standalone test collection
    from services import scheduler  # type: ignore
    from services.core import ASPECT_RATIOS, SIZE_CLASSES, resolve_size  # type: ignore


class _FlexibleStringInputs(dict):
    """Accept frontend-created STRING sockets for any number of tracks."""

    def __getitem__(self, key):
        return ("STRING", {"forceInput": True})

    def __contains__(self, key):
        return True


class NAIPromptScheduler:
    """Compose one prompt from fixed text, wildcard cards, and characters."""

    NAME = "NAI Prompt Scheduler (4A Prompt Manager)"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "config_json": (
                    "STRING",
                    {
                        "default": (
                            '{"start_index":0,"task_count":1,"negative":"",'
                            '"tracks":[{"id":"quality","name":"质量",'
                            '"enabled":true,"text":"","mode":"sequence"}],'
                            '"characters":[{"id":"char-1","name":"角色 1",'
                            '"enabled":true,"positive":"","negative":"",'
                            '"mode":"sequence","use_position":false,'
                            '"x":0.5,"y":0.5,"use_order":false}],'
                            '"use_coords":false,"positions_initialized":false,'
                            '"settings_apply_nai":false}'
                        ),
                        "multiline": True,
                        "dynamicPrompts": False,
                    },
                ),
                "execution_index": (
                    "INT",
                    {"default": 0, "min": 0, "max": 0x7FFFFFFF},
                ),
                "run_id": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "dynamicPrompts": False,
                    },
                ),
                "size_class": ([*SIZE_CLASSES, "Custom"], {"default": "Normal"}),
                "aspect_ratio": (list(ASPECT_RATIOS), {"default": "Portrait"}),
                "width": (
                    "INT",
                    {"default": 832, "min": 64, "max": 2048, "step": 64},
                ),
                "height": (
                    "INT",
                    {"default": 1216, "min": 64, "max": 2048, "step": 64},
                ),
                "seed": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 0xFFFFFFFFFFFFFFFF,
                        "tooltip": "Wildcard selection seed; image seed belongs to NAI Sampler.",
                    },
                ),
            },
            "optional": _FlexibleStringInputs(),
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING", "INT", "INT")
    RETURN_NAMES = ("positive", "negative", "characters", "width", "height")
    FUNCTION = "compose"
    CATEGORY = "4A NovelAI"
    DESCRIPTION = (
        "Expands only __wildcard__ syntax and emits separate prompt strings, "
        "editable character JSON, and dimensions. The seed controls wildcard "
        "selection, not image generation."
    )

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def compose(
        self,
        config_json: str,
        execution_index: int,
        run_id: str,
        size_class: str,
        aspect_ratio: str,
        width: int,
        height: int,
        seed: int,
        **external_inputs,
    ):
        dynamic_inputs = {
            name: value
            for name, value in external_inputs.items()
            if name.startswith(scheduler.EXTERNAL_TRACK_PREFIX)
        }
        if run_id:
            if dynamic_inputs:
                raise ValueError("连接动态 track 输入时不能使用 NAI 批量 run_id")
            plan = scheduler.acquire_run(run_id, execution_index)
        else:
            plan = scheduler.compose_plan(
                config_json,
                execution_index=execution_index,
                seed=int(seed),
                external_inputs=dynamic_inputs,
            )
        resolved_width, resolved_height = resolve_size(
            size_class,
            aspect_ratio,
            int(width),
            int(height),
        )
        characters = scheduler.character_document(
            plan["characters"],
            width=resolved_width,
            height=resolved_height,
        )
        return (
            plan["positive"],
            plan["negative"],
            json.dumps(characters, ensure_ascii=False, separators=(",", ":")),
            resolved_width,
            resolved_height,
        )

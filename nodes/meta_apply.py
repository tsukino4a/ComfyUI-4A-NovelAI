"""UI-only node that applies metadata from a NovelAI image."""

from __future__ import annotations


class NAIMetaApply:
    NAME = "NAI Meta Apply"

    @classmethod
    def INPUT_TYPES(cls):
        toggle = {"label_on": "yes", "label_off": "no"}
        return {
            "required": {
                "Prompt": ("BOOLEAN", {**toggle, "default": True}),
                "UC": ("BOOLEAN", {**toggle, "default": True}),
                "Characters": ("BOOLEAN", {**toggle, "default": False}),
                "└ Append": ("BOOLEAN", {**toggle, "default": False}),
                "Settings": ("BOOLEAN", {**toggle, "default": True}),
                "Seed": ("BOOLEAN", {**toggle, "default": False}),
                # Hidden filename slot: keeps old workflow widget order and restore.
                "image": ("STRING", {"default": "", "multiline": False}),
            }
        }

    RETURN_TYPES = ()
    FUNCTION = "show"
    OUTPUT_NODE = True
    CATEGORY = "4A NovelAI"
    DESCRIPTION = "Drop or select a NovelAI image to apply its current metadata."

    @classmethod
    def VALIDATE_INPUTS(cls, **_kwargs):
        return True

    def show(self, **_kwargs):
        return ()

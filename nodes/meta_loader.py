"""UI-only metadata viewer for NovelAI and prompt-only fallback images."""

from __future__ import annotations


class NAIMetaLoader:
    NAME = "NAI Meta Loader"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "imported_json": (
                    "STRING",
                    {"default": "", "multiline": True, "dynamicPrompts": False},
                )
            }
        }

    RETURN_TYPES = ()
    FUNCTION = "display"
    OUTPUT_NODE = True
    CATEGORY = "4A NovelAI"
    DESCRIPTION = "Drop an image to inspect metadata and send it to NAI nodes."

    def display(self, imported_json: str = ""):
        value = imported_json if isinstance(imported_json, str) else str(imported_json or "")
        return {"ui": {"nai4a_meta_json": [value]}, "result": ()}

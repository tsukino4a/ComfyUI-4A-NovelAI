"""ComfyUI-4A-NovelAI plugin registration."""

WEB_DIRECTORY = "./web/comfyui"

if __package__:
    from .nodes import (
        NAIImageInputNode,
        NAIMetaApply,
        NAIMetaLoader,
        NAIModelNode,
        NAIOriginalImageSaverNode,
        NAIReferenceNode,
        NAISamplerNode,
        NAIUsageMonitorNode,
    )
    from .nodes.prompt_scheduler import NAIPromptScheduler
    from .server.routes import add_routes as register_scheduler_routes
    from .services.routes import register_routes

    NODE_CLASS_MAPPINGS = {
        "NovelAI4AModel": NAIModelNode,
        "NovelAI4AReference": NAIReferenceNode,
        "NovelAI4AImageInput": NAIImageInputNode,
        "NovelAI4AUsage": NAIUsageMonitorNode,
        "NovelAI4AOriginalSaver": NAIOriginalImageSaverNode,
        "NovelAI4ASampler": NAISamplerNode,
        NAIMetaApply.NAME: NAIMetaApply,
        NAIMetaLoader.NAME: NAIMetaLoader,
        NAIPromptScheduler.NAME: NAIPromptScheduler,
    }

    NODE_DISPLAY_NAME_MAPPINGS = {
        "NovelAI4AModel": "NAI Model Loader",
        "NovelAI4AReference": "NAI Reference Resources",
        "NovelAI4AImageInput": "NAI Image Input",
        "NovelAI4AUsage": "NAI Usage Monitor",
        "NovelAI4AOriginalSaver": "NAI Original Image Saver",
        "NovelAI4ASampler": "NAI Sampler",
        NAIMetaApply.NAME: "NAI Meta Apply",
        NAIMetaLoader.NAME: "NAI Meta Loader",
        NAIPromptScheduler.NAME: "NAI Prompt Scheduler",
    }

    register_routes()
    register_scheduler_routes()
else:  # pragma: no cover - pytest imports a root __init__.py as a plain module
    NODE_CLASS_MAPPINGS = {}
    NODE_DISPLAY_NAME_MAPPINGS = {}

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
]

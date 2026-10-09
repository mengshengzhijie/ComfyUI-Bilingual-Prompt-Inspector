from .nodes import BilingualPromptInspector, DuplicateChecker
from . import server  # noqa: F401 - importing registers local API routes


NODE_CLASS_MAPPINGS = {
    "BilingualPromptInspector": BilingualPromptInspector,
    "DuplicateChecker": DuplicateChecker,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BilingualPromptInspector": "Prompt Translator & Manager",
    "DuplicateChecker": "重复检查",
}

WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

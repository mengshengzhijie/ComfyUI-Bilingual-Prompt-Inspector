from .server import announce_upstream, current_prompt_id, upstream_gate


class BilingualPromptInspector:
    """
    @title: Prompt Translator & Manager
    @nickname: Prompt Translator
    @description: Bilingual prompt inspector and manager node. Features tag-linked views, drag-to-reorder, temporary hide, multiple translation services, and a sidebar dictionary panel. Can intercept upstream prompts for review before passing them downstream. Output always matches the English prompt text.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": (
                    "STRING",
                    {
                        "multiline": True,
                        "dynamicPrompts": True,
                        "default": "",
                    },
                )
            },
            "optional": {
                "prompt": ("STRING", {"forceInput": True}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("english_prompt",)
    FUNCTION = "pass_through"
    CATEGORY = "text/prompt"
    DESCRIPTION = "Bilingual prompt inspector and manager: tag-linked views, drag-to-reorder, temporary hide, upstream intercept with pause-to-confirm. Output always matches the English prompt text."

    async def pass_through(self, text, prompt=None, unique_id=None):
        # 没有上游时保持原来的直通行为：协程立即返回，执行器不会挂起。
        if prompt is None:
            return (text,)

        node_id = str(unique_id or "")
        announce_upstream(node_id, prompt)
        future = upstream_gate.open(node_id, current_prompt_id(), prompt)
        released = await upstream_gate.wait(node_id, future)
        # 前端放行时带回的是节点上编辑后的文本；无人接管（无浏览器或 API 调用）时原样透传。
        return (released if isinstance(released, str) else prompt,)

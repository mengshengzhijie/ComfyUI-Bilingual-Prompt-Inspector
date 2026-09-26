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
                # 输出管道（前端隐藏标签用）：节点文本保留隐藏标签便于继续编辑，
                # 前端把"剔除隐藏标签后的文本"同步进 effective_text 并置 use_effective，
                # 实际输出取它；旧工作流没有这两个 widget，默认直通 text。
                "effective_text": ("STRING", {"multiline": True, "default": ""}),
                "use_effective": ("BOOLEAN", {"default": False}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("英文提示词",)
    FUNCTION = "pass_through"
    CATEGORY = "text/prompt"
    DESCRIPTION = "Bilingual prompt inspector and manager: tag-linked views, drag-to-reorder, temporary hide, upstream intercept with pause-to-confirm. Output always matches the English prompt text."

    async def pass_through(self, text, prompt=None, effective_text="", use_effective=False, unique_id=None):
        # 前端置了 use_effective 时，effective_text 是"剔除隐藏标签后的文本"，全隐藏时为空串，
        # 也必须照用（所以不能拿空串当"未设置"）；旧工作流没有该 widget，默认 False 直通。
        base = effective_text if use_effective else text
        # 没有上游时保持原来的直通行为：协程立即返回，执行器不会挂起。
        if prompt is None:
            return (base,)

        node_id = str(unique_id or "")
        announce_upstream(node_id, prompt)
        future = upstream_gate.open(node_id, current_prompt_id(), prompt)
        released = await upstream_gate.wait(node_id, future)
        # 前端放行时带回的是节点上编辑后的文本；无人接管（无浏览器或 API 调用）时原样透传。
        return (released if isinstance(released, str) else prompt,)

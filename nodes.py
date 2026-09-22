from .server import announce_upstream, current_prompt_id, upstream_gate


class BilingualPromptInspector:
    """
    @title: Prompt Translator & Manager
    @nickname: Prompt Translator
    @description: 中英对照的提示词整理与管理节点，支持标签联动视图、拖拽排序、临时隐藏、多种翻译服务与侧边栏词库管理。可接管上游传来的提示词，确认后再输出。实际输出始终与英文提示词一致。
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
    RETURN_NAMES = ("英文提示词",)
    FUNCTION = "pass_through"
    CATEGORY = "文本/提示词工具"
    DESCRIPTION = "中英对照整理与管理提示词：标签联动视图、拖拽排序、临时隐藏、可接管上游提示词并暂停确认；输出始终与英文提示词一致。"

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

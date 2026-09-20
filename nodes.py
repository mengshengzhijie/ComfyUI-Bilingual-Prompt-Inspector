class BilingualPromptInspector:
    """
    @title: Prompt Translator & Manager
    @nickname: Prompt Translator
    @description: 中英对照的提示词整理与管理节点，支持标签联动视图、拖拽排序、临时隐藏、多种翻译服务与侧边栏词库管理。实际输出始终与输入的英文完全一致。
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
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("英文提示词",)
    FUNCTION = "pass_through"
    CATEGORY = "文本/提示词工具"
    DESCRIPTION = "中英对照整理与管理提示词：标签联动视图、拖拽排序、临时隐藏；输出始终与输入英文完全一致。"

    def pass_through(self, text):
        return (text,)

"""节点标签卡的配色配置。

色块池（presets / random_pool）只读，用户可以直接编辑 data/token_colors.json 增删色块；
按词库配色（pack_colors）由界面写回同一个文件，格式不对时回退默认，不影响功能。
"""

import json
import os
import re
import tempfile
from pathlib import Path


DEFAULT_PRESETS = [
    "#6b9b78", "#9b8b6b", "#6b7b9b", "#9b6b8b",
    "#8b9b6b", "#6b9b9b", "#9b7b6b", "#7b6b9b",
]
DEFAULT_RANDOM_POOL = [
    "#5b8a72", "#8a725b", "#5b6e8a", "#8a5b7a",
    "#7a8a5b", "#5b8a8a", "#8a6b5b", "#6b5b8a",
]
# 未命中任何词库的标签也当成一个可配色的来源，key 固定为 unindexed
UNINDEXED_PACK_ID = "unindexed"

MAX_COLOR_ENTRIES = 200
PACK_ID_PATTERN = re.compile(r"[A-Za-z0-9_-]{1,64}")
HEX_COLOR_PATTERN = re.compile(r"#[0-9a-fA-F]{6}")
SHORT_HEX_COLOR_PATTERN = re.compile(r"#[0-9a-fA-F]{3}")


def normalize_color(value):
    """把 #RGB / #RRGGBB 统一成小写的 #rrggbb，认不出来返回 None。"""
    text = str(value or "").strip()
    if HEX_COLOR_PATTERN.fullmatch(text):
        return text.lower()
    if SHORT_HEX_COLOR_PATTERN.fullmatch(text):
        return "#" + "".join(char * 2 for char in text[1:]).lower()
    return None


class TokenColorStore:
    def __init__(self, data_dir=None):
        self.data_dir = Path(data_dir or Path(__file__).resolve().parent / "data")
        self.path = self.data_dir / "token_colors.json"

    @staticmethod
    def defaults():
        return {
            "presets": list(DEFAULT_PRESETS),
            "random_pool": list(DEFAULT_RANDOM_POOL),
            "pack_colors": {},
            "anima_colors": {},
        }

    def config(self):
        """读取配置：色块池原样透传，缺字段或文件坏了就回退默认。"""
        payload = self._read()
        if payload is None:
            return self.defaults()
        config = self.defaults()
        for key in ("presets", "random_pool"):
            values = payload.get(key)
            if isinstance(values, list):
                config[key] = values
        for key in ("pack_colors", "anima_colors"):
            values = payload.get(key)
            if isinstance(values, dict):
                config[key] = self._clean_map(values)
        return config

    @staticmethod
    def _clean_map(raw):
        cleaned = {}
        for key, value in raw.items():
            color = normalize_color(value)
            if color and PACK_ID_PATTERN.fullmatch(str(key)):
                cleaned[str(key)] = color
        return cleaned

    @staticmethod
    def _validated_map(raw, label):
        if not isinstance(raw, dict):
            raise ValueError(f"{label}必须是对象")
        if len(raw) > MAX_COLOR_ENTRIES:
            raise ValueError(f"{label}最多 {MAX_COLOR_ENTRIES} 项")
        cleaned = {}
        for raw_key, value in raw.items():
            key = str(raw_key).strip()
            if not PACK_ID_PATTERN.fullmatch(key):
                raise ValueError(f"分类ID格式不正确：{key}")
            if value in (None, ""):
                continue
            color = normalize_color(value)
            if color is None:
                raise ValueError(f"颜色必须是 #RGB 或 #RRGGBB 十六进制值：{value}")
            cleaned[key] = color
        return cleaned

    def save_colors(self, pack_colors=None, anima_colors=None):
        """整体覆盖某一类配色：传空值表示该项恢复默认。只更新传进来的那一类。"""
        if pack_colors is None and anima_colors is None:
            raise ValueError("没有要保存的配色")
        config = self.config()
        if pack_colors is not None:
            config["pack_colors"] = self._validated_map(pack_colors, "按词库配色")
        if anima_colors is not None:
            config["anima_colors"] = self._validated_map(anima_colors, "按 Anima 配色")
        self._write(config)
        return config

    def _read(self):
        if not self.path.exists():
            return None
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        return payload if isinstance(payload, dict) else None

    def _write(self, payload):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, temp_name = tempfile.mkstemp(prefix="token_colors_", suffix=".json", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
            os.replace(temp_name, self.path)
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)

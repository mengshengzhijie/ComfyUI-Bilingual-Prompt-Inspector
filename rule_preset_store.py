"""AI 规则预设：一套规则一个文件，按后端分目录，方便单独备份、拷贝、给别人。

    data/rule_presets/openai/方案A.json
    data/rule_presets/ollama/本地 Qwen.json

每个 json 里是四条规则：
    { "translation": "...", "translate_optimize": "...", "optimization": "...", "natural": "..." }

刻意不塞进配置文件的单个 json：一套规则出问题时只影响它自己，也能直接拿去比对/分享。
"""

import json
import os
import tempfile
from pathlib import Path

MAX_NAME_CHARS = 60
MAX_RULE_CHARS = 20000
RULE_KINDS = ("translation", "translate_optimize", "optimization", "natural")
BACKENDS = ("openai", "ollama")

_ILLEGAL_NAME_CHARS = set('\\/:*?"<>|')


def _default_preset_dir():
    return Path(__file__).resolve().parent / "data" / "rule_presets"


def safe_preset_name(name):
    cleaned = "".join("_" if ch in _ILLEGAL_NAME_CHARS or ord(ch) < 32 else ch for ch in str(name or ""))
    cleaned = cleaned.strip(" .")[:MAX_NAME_CHARS]
    return cleaned or ""


class RulePresetStore:
    def __init__(self, store_dir=None):
        self.store_dir = Path(store_dir or _default_preset_dir())

    def _backend_dir(self, backend):
        name = backend if backend in BACKENDS else BACKENDS[0]
        return self.store_dir / name

    def list_presets(self, backend):
        """列出某个后端下的全部预设；坏文件跳过，不让一条坏数据挡住整张列表。"""
        directory = self._backend_dir(backend)
        try:
            files = sorted(directory.glob("*.json"), key=lambda path: path.stem.casefold())
        except OSError:
            return []
        presets = []
        for path in files:
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if not isinstance(payload, dict):
                continue
            rules = {}
            for kind in RULE_KINDS:
                value = payload.get(kind)
                rules[kind] = value[:MAX_RULE_CHARS] if isinstance(value, str) else ""
            presets.append({"name": path.stem, "rules": rules})
        return presets

    def save_preset(self, backend, name, rules):
        cleaned = safe_preset_name(name)
        if not cleaned:
            raise ValueError("预设名称不能为空")
        if not isinstance(rules, dict):
            raise ValueError("规则格式不对")
        payload = {}
        for kind in RULE_KINDS:
            value = rules.get(kind)
            payload[kind] = str(value)[:MAX_RULE_CHARS] if value is not None else ""
        directory = self._backend_dir(backend)
        try:
            directory.mkdir(parents=True, exist_ok=True)
        except OSError as error:
            raise ValueError(f"无法创建预设目录：{error}") from error
        target = directory / f"{cleaned}.json"
        fd, temp_name = tempfile.mkstemp(prefix="preset_", suffix=".json", dir=directory)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
            os.replace(temp_name, target)
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)
        return {"name": cleaned, "rules": payload}

    def delete_preset(self, backend, name):
        cleaned = safe_preset_name(name)
        if not cleaned:
            raise ValueError("预设名称不能为空")
        target = self._backend_dir(backend) / f"{cleaned}.json"
        if not target.is_file():
            raise FileNotFoundError(cleaned)
        target.unlink()
        return {"deleted": cleaned}

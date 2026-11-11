"""问候/提醒的配置：提示词 + 可选的独立 AI（不填就用助手设置里的那套）。

单独一个文件而不是塞进 assistant_store：问候是独立功能，以后还要加运行时长、
生成张数这些项目，各自演化更省心。密钥只落本地文件，接口只回「是否已配」。
"""

import json
import os
import tempfile
from pathlib import Path

MAX_PROMPT_CHARS = 8000
MAX_FIELD_CHARS = 500
DEFAULT_TEMPERATURE = 0.8

# 默认文案放在 data/greeting_defaults.json：不进代码、可读可改，也随发布包一起走。
# Python 这边只负责读，读不到就当空字符串（AI 会退化成没有系统提示词的样子）。
DEFAULTS_PATH = Path(__file__).resolve().parent / "data" / "greeting_defaults.json"


def _load_defaults():
    try:
        payload = json.loads(DEFAULTS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    welcome = payload.get("welcome")
    return {
        "prompt": str(payload.get("prompt") or ""),
        "time_prompt": str(payload.get("time_prompt") or ""),
        "image_prompt": str(payload.get("image_prompt") or ""),
        "welcome_prompt": str(payload.get("welcome_prompt") or ""),
        "error_prompt": str(payload.get("error_prompt") or ""),
        "idle_prompt": str(payload.get("idle_prompt") or ""),
        # 进入时的问候：固定文案，按时段分，不走 AI、也不给 UI 编辑
        "welcome": welcome if isinstance(welcome, dict) else {},
    }


_DEFAULTS = _load_defaults()
DEFAULT_PROMPT = _DEFAULTS["prompt"]
DEFAULT_TIME_PROMPT = _DEFAULTS["time_prompt"]
DEFAULT_IMAGE_PROMPT = _DEFAULTS["image_prompt"]
DEFAULT_WELCOME_PROMPT = _DEFAULTS["welcome_prompt"]
DEFAULT_ERROR_PROMPT = _DEFAULTS["error_prompt"]
DEFAULT_IDLE_PROMPT = _DEFAULTS["idle_prompt"]


def _clamp_temperature(value):
    """温度只收 0–2，写歪了就退回默认值。"""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return DEFAULT_TEMPERATURE
    return max(0.0, min(2.0, round(number, 2)))


def _clean_flag(value):
    """只有一个开关的规则（失败安慰 / 静默招呼）。"""
    raw = value if isinstance(value, dict) else {}
    return {"enabled": raw.get("enabled") is True}


def _clean_rule(value, number_key, default_number, low, high):
    """一条场景规则：开关 + 一个数值 + 自己的提示词。"""
    raw = value if isinstance(value, dict) else {}
    try:
        number = int(float(raw.get(number_key, default_number)))
    except (TypeError, ValueError):
        number = default_number
    prompt = raw.get("prompt")
    return {
        "enabled": raw.get("enabled") is True,
        number_key: max(low, min(high, number)),
        "prompt": prompt.strip()[:MAX_PROMPT_CHARS] if isinstance(prompt, str) else "",
    }


def _default_config_path():
    return Path(__file__).resolve().parent / "data" / "greeting" / "config.json"


class GreetingStore:
    def __init__(self, config_path=None):
        self.path = Path(config_path or _default_config_path())
        self._cache = None

    def _load(self):
        if self._cache is not None:
            return self._cache
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            payload = {}
        if not isinstance(payload, dict):
            payload = {}
        prompt = payload.get("prompt")
        self._cache = {
            "prompt": prompt if isinstance(prompt, str) and prompt.strip() else DEFAULT_PROMPT,
            "use_assistant_ai": payload.get("use_assistant_ai", True) is not False,
            "api_base_url": str(payload.get("api_base_url") or "")[:MAX_FIELD_CHARS],
            "model": str(payload.get("model") or "")[:MAX_FIELD_CHARS],
            "api_key": str(payload.get("api_key") or "")[:MAX_FIELD_CHARS],
            "temperature": _clamp_temperature(payload.get("temperature", DEFAULT_TEMPERATURE)),
            "error_rule": _clean_flag(payload.get("error_rule")),
            "random_rule": _clean_rule(payload.get("random_rule"), "chance", 10, 2, 1440),
            "idle_rule": _clean_flag(payload.get("idle_rule")),
            "time_rule": _clean_rule(payload.get("time_rule"), "minutes", 30, 1, 480),
            "image_rule": _clean_rule(payload.get("image_rule"), "count", 10, 1, 500),
        }
        return self._cache

    def config(self):
        """给前端看的版本：不回密钥，只回有没有配过。"""
        data = self._load()
        return {
            "prompt": data["prompt"],
            "default_prompt": DEFAULT_PROMPT,
            "default_time_prompt": DEFAULT_TIME_PROMPT,
            "default_image_prompt": DEFAULT_IMAGE_PROMPT,
            "welcome": _DEFAULTS["welcome"],
            "use_assistant_ai": data["use_assistant_ai"],
            "api_base_url": data["api_base_url"],
            "model": data["model"],
            "api_key_configured": bool(data["api_key"]),
            "temperature": data["temperature"],
            "error_rule": data["error_rule"],
            "random_rule": data["random_rule"],
            "idle_rule": data["idle_rule"],
            "time_rule": data["time_rule"],
            "image_rule": data["image_rule"],
        }

    def prompt(self):
        return self._load()["prompt"]

    def prompt_for(self, scene=""):
        data = self._load()
        if scene == "time":
            return data["time_rule"]["prompt"] or DEFAULT_TIME_PROMPT
        if scene == "images":
            return data["image_rule"]["prompt"] or DEFAULT_IMAGE_PROMPT
        if scene == "welcome":
            return DEFAULT_WELCOME_PROMPT or DEFAULT_PROMPT
        if scene == "error":
            return DEFAULT_ERROR_PROMPT or DEFAULT_PROMPT
        if scene == "idle":
            return DEFAULT_IDLE_PROMPT or DEFAULT_PROMPT
        return data["prompt"]

    def temperature(self):
        return self._load()["temperature"]

    def save(self, payload):
        if not isinstance(payload, dict):
            raise ValueError("请求内容格式不正确")
        data = dict(self._load())

        if "prompt" in payload:
            text = str(payload.get("prompt") or "").strip()[:MAX_PROMPT_CHARS]
            if not text:
                raise ValueError("提示词不能为空")
            data["prompt"] = text
        if "use_assistant_ai" in payload:
            data["use_assistant_ai"] = payload.get("use_assistant_ai") is not False
        for key in ("api_base_url", "model"):
            if key in payload:
                data[key] = str(payload.get(key) or "").strip()[:MAX_FIELD_CHARS]
        # 密钥留空 = 保持原来那份，避免每次改别的字段都要重敲
        if payload.get("clear_api_key"):
            data["api_key"] = ""
        elif payload.get("api_key"):
            data["api_key"] = str(payload["api_key"]).strip()[:MAX_FIELD_CHARS]
        if "temperature" in payload:
            data["temperature"] = _clamp_temperature(payload.get("temperature"))
        if isinstance(payload.get("error_rule"), dict):
            data["error_rule"] = _clean_flag({**data["error_rule"], **payload["error_rule"]})
        if isinstance(payload.get("random_rule"), dict):
            data["random_rule"] = _clean_rule(
                {**data["random_rule"], **payload["random_rule"]}, "chance", 10, 2, 1440
            )
        if isinstance(payload.get("idle_rule"), dict):
            data["idle_rule"] = _clean_flag({**data["idle_rule"], **payload["idle_rule"]})
        if isinstance(payload.get("time_rule"), dict):
            merged = {**data["time_rule"], **payload["time_rule"]}
            data["time_rule"] = _clean_rule(merged, "minutes", 30, 1, 480)
        if isinstance(payload.get("image_rule"), dict):
            merged = {**data["image_rule"], **payload["image_rule"]}
            data["image_rule"] = _clean_rule(merged, "count", 10, 1, 500)

        self._write(data)
        return self.config()

    def _write(self, data):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, temp_name = tempfile.mkstemp(prefix="greeting_", suffix=".json", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(data, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
            os.replace(temp_name, self.path)
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)
        self._cache = data

    # 走问候自己的 AI 时返回覆盖值；用助手那套则返回 None。
    # 配不全直接报错，由调用方转成用户可读的提示。
    def ai_override(self):
        data = self._load()
        if data["use_assistant_ai"]:
            return None
        base = data["api_base_url"].strip()
        model = data["model"].strip()
        key = data["api_key"].strip()
        missing = [name for name, value in (("API 地址", base), ("模型名称", model), ("密钥", key)) if not value]
        if missing:
            raise ValueError(
                f"问候的 AI 还没配全（缺 {('、'.join(missing))}）：请在「问候与提醒 → 问候的 AI」里补齐，"
                "或打开「使用助手设置里的 AI」"
            )
        return {"openai_base_url": base, "openai_model": model, "openai_api_key": key}

"""上游接管的行为设置：目前只有「前端多少秒内没接管就自动放行」。"""

import json
import os
import tempfile
from pathlib import Path

from .paths import DATA_DIR

DEFAULT_TIMEOUT = 20.0
MIN_TIMEOUT = 3.0
MAX_TIMEOUT = 600.0


def _default_path():
    return DATA_DIR / "user_config" / "upstream.json"


class UpstreamSettings:
    def __init__(self, config_path=None):
        self.path = Path(config_path or _default_path())
        self._cache = None

    def _load(self):
        if self._cache is not None:
            return self._cache
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            payload = {}
        value = payload.get("timeout_seconds") if isinstance(payload, dict) else None
        self._cache = {"timeout_seconds": _clamp(value)}
        return self._cache

    def config(self):
        return {"timeout_seconds": self._load()["timeout_seconds"], "default": DEFAULT_TIMEOUT}

    def timeout(self):
        return self._load()["timeout_seconds"]

    def save(self, payload):
        if not isinstance(payload, dict):
            raise ValueError("请求内容格式不正确")
        value = _clamp(payload.get("timeout_seconds"))
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, temp_name = tempfile.mkstemp(prefix="upstream_", suffix=".json", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump({"timeout_seconds": value}, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
            os.replace(temp_name, self.path)
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)
        self._cache = {"timeout_seconds": value}
        return self.config()


def _clamp(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return DEFAULT_TIMEOUT
    return max(MIN_TIMEOUT, min(MAX_TIMEOUT, round(number, 1)))

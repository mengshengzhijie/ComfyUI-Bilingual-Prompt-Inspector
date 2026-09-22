"""收藏的提示词。

元数据放在 user 目录下的 index.json，配图按 id 命名存成独立文件（不塞 base64，
几十条之后 JSON 会没法看）。所有写入都走临时文件 + 原子替换，图片上传做魔数
校验，不信任扩展名。
"""

import base64
import json
import os
import secrets
import tempfile
import time
from pathlib import Path

MAX_PROMPTS = 2000
MAX_NAME_CHARS = 80
MAX_TEXT_CHARS = 65536
MAX_NOTE_CHARS = 500
MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_IMPORT_BYTES = 128 * 1024 * 1024
BUNDLE_VERSION = 1

IMAGE_MIME_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp"}


def _default_store_dir():
    try:
        import folder_paths

        return Path(folder_paths.get_user_directory()) / "bilingual-prompt-inspector" / "saved_prompts"
    except (ImportError, AttributeError, TypeError):
        return Path(__file__).resolve().parent / "data" / "user_config" / "saved_prompts"


def sniff_image(data):
    """按文件头判断图片类型，返回扩展名；认不出返回 None。"""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if data[:3] == b"\xff\xd8\xff":
        return ".jpg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    return None


class SavedPromptStore:
    def __init__(self, store_dir=None):
        self.store_dir = Path(store_dir or _default_store_dir())
        self.index_path = self.store_dir / "index.json"
        self.store_dir.mkdir(parents=True, exist_ok=True)

    def _load_index(self):
        try:
            entries = json.loads(self.index_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return []
        if not isinstance(entries, list):
            return []
        return [entry for entry in entries if isinstance(entry, dict) and isinstance(entry.get("id"), str)]

    def _save_index(self, entries):
        self.store_dir.mkdir(parents=True, exist_ok=True)
        fd, temp_name = tempfile.mkstemp(prefix="saved_prompts_", suffix=".json", dir=self.store_dir)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(entries, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
            os.replace(temp_name, self.index_path)
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)

    @staticmethod
    def _clean_entry(entry):
        name = str(entry.get("name") or "").strip()[:MAX_NAME_CHARS] or "未命名收藏"
        text = str(entry.get("text") or "")[:MAX_TEXT_CHARS]
        note = entry.get("note")
        if not isinstance(note, str):
            note = None
        return name, text, (note[:MAX_NOTE_CHARS] if note else None)

    def list_prompts(self):
        entries = self._load_index()
        entries.sort(key=lambda entry: entry.get("created_at") or 0, reverse=True)
        return entries

    @staticmethod
    def _next_created_at(entries):
        """同一秒内连着收藏两条也要能分出先后，所以必要时往后顺延一秒。"""
        latest = max([entry.get("created_at") or 0 for entry in entries], default=0)
        return max(int(time.time()), latest + 1)

    def create_prompt(self, name, text, note=None, image_bytes=None, created_at=None):
        if not str(text or "").strip():
            raise ValueError("提示词内容为空，无法收藏")
        entries = self._load_index()
        if len(entries) >= MAX_PROMPTS:
            raise ValueError(f"收藏数量已达上限（{MAX_PROMPTS} 条），请先清理")
        name, text, note = self._clean_entry({"name": name, "text": text, "note": note})

        prompt_id = secrets.token_urlsafe(6)
        image_name = None
        if image_bytes:
            if not isinstance(image_bytes, (bytes, bytearray)) or len(image_bytes) > MAX_IMAGE_BYTES:
                raise ValueError(f"图片过大或无效（最大 {MAX_IMAGE_BYTES // (1024 * 1024)} MB）")
            sniffed = sniff_image(image_bytes)
            if sniffed is None:
                raise ValueError("图片格式仅支持 PNG / JPG / WebP")
            image_name = f"{prompt_id}{sniffed}"
            (self.store_dir / image_name).write_bytes(image_bytes)

        entry = {
            "id": prompt_id,
            "name": name,
            "text": text,
            "note": note,
            "image": image_name,
            "created_at": int(created_at) if created_at else self._next_created_at(entries),
        }
        entries.append(entry)
        self._save_index(entries)
        return entry

    def delete_prompt(self, prompt_id):
        entries = self._load_index()
        remaining = [entry for entry in entries if entry.get("id") != prompt_id]
        if len(remaining) == len(entries):
            raise ValueError("收藏不存在或已删除")
        for entry in entries:
            if entry.get("id") == prompt_id and isinstance(entry.get("image"), str) and entry["image"]:
                try:
                    (self.store_dir / entry["image"]).unlink()
                except OSError:
                    pass
        self._save_index(remaining)
        return len(remaining)

    def image_path(self, prompt_id):
        for entry in self._load_index():
            if entry.get("id") == prompt_id:
                if not isinstance(entry.get("image"), str) or not entry["image"]:
                    raise ValueError("该收藏没有配图")
                path = self.store_dir / entry["image"]
                if not path.is_file():
                    raise ValueError("配图文件缺失")
                return path
        raise ValueError("收藏不存在")

    def export_bundle(self):
        bundle = {"version": BUNDLE_VERSION, "prompts": []}
        for entry in self.list_prompts():
            item = {
                "id": entry.get("id"),
                "name": entry.get("name"),
                "text": entry.get("text"),
                "note": entry.get("note"),
                "created_at": entry.get("created_at"),
                "image": None,
            }
            image_name = entry.get("image")
            if isinstance(image_name, str) and image_name:
                path = self.store_dir / image_name
                try:
                    data = path.read_bytes()
                except OSError:
                    data = None
                if data:
                    ext = Path(image_name).suffix.lower()
                    item["image"] = {
                        "mime": IMAGE_MIME_TYPES.get(ext, "application/octet-stream"),
                        "data": base64.b64encode(data).decode("ascii"),
                    }
            bundle["prompts"].append(item)
        return bundle

    def import_bundle(self, payload):
        if not isinstance(payload, dict) or not isinstance(payload.get("prompts"), list):
            raise ValueError("导入内容不是有效的收藏包")
        imported = 0
        total_bytes = 0
        existing = self._load_index()
        existing_ids = {entry.get("id") for entry in existing}
        existing_contents = {(entry.get("name"), entry.get("text")) for entry in existing}
        for item in payload["prompts"]:
            if not isinstance(item, dict) or not str(item.get("text") or "").strip():
                continue
            if len(existing) >= MAX_PROMPTS:
                break
            name, text, note = self._clean_entry(item)
            if (name, text) in existing_contents:
                continue
            image_bytes = None
            image_data = item.get("image")
            if isinstance(image_data, dict) and isinstance(image_data.get("data"), str):
                try:
                    image_bytes = base64.b64decode(image_data["data"], validate=True)
                except (ValueError, TypeError):
                    image_bytes = None
                if image_bytes:
                    total_bytes += len(image_bytes)
                    if total_bytes > MAX_IMPORT_BYTES or len(image_bytes) > MAX_IMAGE_BYTES:
                        image_bytes = None
            # 导入文件是用户自己带的，created_at 可能是字符串，认不出就当没有
            created_at = item.get("created_at")
            if not isinstance(created_at, int) or isinstance(created_at, bool):
                created_at = None
            entry = self.create_prompt(
                name, text, note=note, image_bytes=image_bytes, created_at=created_at
            )
            existing.append(entry)
            existing_ids.add(entry["id"])
            existing_contents.add((entry["name"], entry["text"]))
            imported += 1
        return {"imported": imported, "total": len(existing)}

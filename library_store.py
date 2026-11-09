"""收藏库：一个条目一个目录，目录名就是名称，缩略图与目录同名。

为什么这么存（而不是像 saved_prompts 那样一个大 index.json 装文本）：
- 用户能在文件管理器里直接看到、改名、备份，目录名一眼就知道是什么；
- 图片与目录同名，缺图/多图一眼能看出来；
- 顺序和父子关系放在 library/index.json 里当缓存，打开面板只读这一个文件，
  不扫目录 —— 目录多了也不会卡。

磁盘是真相，index.json 是缓存：被外部改乱时用 rebuild() 重建。
"""

import json
import os
import re
import secrets
import shutil
import tempfile
import time
from pathlib import Path

try:  # 包内导入优先；单文件调试时退化成同目录导入
    from .saved_prompt_store import sniff_image
except ImportError:  # pragma: no cover
    from saved_prompt_store import sniff_image

MAX_ITEMS = 2000
MAX_NAME_CHARS = 80
MAX_TEXT_CHARS = 65536
MAX_NOTE_CHARS = 500
MAX_MODELS = 20
MAX_IMAGE_BYTES = 5 * 1024 * 1024
INDEX_VERSION = 1

_ILLEGAL_NAME_CHARS = set('\\/:*?"<>|')
_WINDOWS_RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}


def _default_library_dir():
    """收藏库放在插件目录下的 data/saved：和用户词库、配置在一起，备份时一起带走。"""
    return Path(__file__).resolve().parent / "data" / "saved"


def safe_dir_name(name):
    """目录名：去掉 Windows 不允许的字符、首尾的点和空格，避开保留名。"""
    cleaned = "".join("_" if ch in _ILLEGAL_NAME_CHARS or ord(ch) < 32 else ch for ch in str(name or ""))
    cleaned = cleaned.strip(" .")[:MAX_NAME_CHARS] or "未命名"
    if cleaned.upper() in _WINDOWS_RESERVED:
        cleaned = f"_{cleaned}"
    return cleaned


_COLOR_PATTERN = re.compile(r"^#[0-9a-f]{6}$")


def clean_color(value):
    """文件夹的淡色：只认 #rrggbb（前端渲染时自己加透明度），别的都当没设。"""
    if not isinstance(value, str):
        return None
    text = value.strip().lower()
    return text if _COLOR_PATTERN.match(text) else None


def clean_models(value):
    """适用模型：去空白、去重（忽略大小写），最多 MAX_MODELS 个。"""
    if not isinstance(value, (list, tuple)):
        return []
    cleaned, seen = [], set()
    for item in value:
        if not isinstance(item, str):
            continue
        label = " ".join(item.split())[:MAX_NAME_CHARS]
        if not label:
            continue
        marker = label.casefold()
        if marker in seen:
            continue
        seen.add(marker)
        cleaned.append(label)
        if len(cleaned) >= MAX_MODELS:
            break
    return cleaned


class LibraryStore:
    def __init__(self, store_dir=None):
        self.store_dir = Path(store_dir or _default_library_dir())
        self.index_path = self.store_dir / "index.json"
        self._cache = None
        self._cache_signature = None
        # 建不出来（只读安装、权限不足）也不要在导入阶段就炸：
        # 收藏相关接口各自报错，其它功能照常
        try:
            self.store_dir.mkdir(parents=True, exist_ok=True)
        except OSError:
            pass

    # ---- 索引 -------------------------------------------------------------

    def _signature(self):
        try:
            stat = self.index_path.stat()
        except OSError:
            return None
        return (stat.st_mtime_ns, stat.st_size)

    def _read_index_file(self):
        try:
            payload = json.loads(self.index_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        if not isinstance(payload, dict) or not isinstance(payload.get("items"), list):
            return None
        return payload

    def _write_index_file(self, items):
        items.sort(key=lambda item: (item.get("order", 0), item.get("created_at", 0)))
        payload = {"version": INDEX_VERSION, "updated_at": int(time.time()), "items": items}
        self.store_dir.mkdir(parents=True, exist_ok=True)
        fd, temp_name = tempfile.mkstemp(prefix="library_", suffix=".json", dir=self.store_dir)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
            os.replace(temp_name, self.index_path)
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)
        self._cache = items
        self._cache_signature = self._signature()

    def _entries(self):
        """取条目列表：优先内存缓存，其次 index.json，最后重建。"""
        if self._cache is not None and self._cache_signature == self._signature():
            return self._cache
        payload = self._read_index_file()
        if payload is None:
            return self.rebuild()
        items = [item for item in payload["items"] if isinstance(item, dict) and isinstance(item.get("id"), str)]
        items.sort(key=lambda item: (item.get("order", 0), item.get("created_at", 0)))
        self._cache = items
        self._cache_signature = self._signature()
        return items

    def rebuild(self):
        """扫一遍目录重建索引；只在首次、索引损坏或手动触发时调用。"""
        items = []
        try:
            self.store_dir.mkdir(parents=True, exist_ok=True)
            children = sorted(self.store_dir.iterdir(), key=lambda path: path.name.casefold())
        except OSError:
            return items
        for entry in children:
            if not entry.is_dir() or entry.name.startswith("."):
                continue
            info = self._read_info(entry)
            if not info:
                continue
            image = self._resolve_image(entry, info)
            items.append({
                "id": info["id"],
                "type": "folder" if info.get("type") == "folder" else "prompt",
                "name": info["name"],
                "dir": entry.name,
                "parent": info.get("parent"),
                "order": int(info.get("order") or 0),
                "note": info.get("note"),
                "models": clean_models(info.get("models")),
                "color": clean_color(info.get("color")),
                "text": str(info.get("text") or "")[:MAX_TEXT_CHARS],
                "image": image,
                "created_at": int(info.get("created_at") or 0),
            })
        items.sort(key=lambda item: (item["order"], item["created_at"]))
        self._write_index_file(items)
        return items

    @staticmethod
    def _read_info(directory):
        try:
            info = json.loads((directory / "info.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        if not isinstance(info, dict) or not isinstance(info.get("id"), str):
            return None
        name = str(info.get("name") or "").strip()[:MAX_NAME_CHARS] or directory.name
        info["name"] = name
        return info

    @staticmethod
    def _resolve_image(directory, info):
        """图片名必须与目录名一致才算数：有人手工塞进来一张别的图就不认。"""
        recorded = info.get("image")
        if not isinstance(recorded, str) or not recorded:
            return None
        candidate = directory / recorded
        if not candidate.is_file():
            return None
        if Path(recorded).stem.casefold() != directory.name.casefold():
            return None
        return recorded

    # ---- 目录与文件 -------------------------------------------------------

    def _unique_dir_name(self, name, entries, current_id=None):
        base = safe_dir_name(name)
        taken = {item["dir"].casefold() for item in entries if item.get("id") != current_id}
        candidate = base
        index = 2
        while candidate.casefold() in taken or (self.store_dir / candidate).exists():
            candidate = f"{base} ({index})"
            index += 1
        return candidate

    def _write_info(self, directory, info):
        target = directory / "info.json"
        fd, temp_name = tempfile.mkstemp(prefix="info_", suffix=".json", dir=directory)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(info, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
            os.replace(temp_name, target)
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)

    def _write_image(self, directory, dir_name, image_bytes, previous=None):
        """图片与目录同名；替换时先删旧文件，避免留下两张。"""
        if previous:
            try:
                (directory / previous).unlink()
            except OSError:
                pass
        if not image_bytes:
            return None
        if not isinstance(image_bytes, (bytes, bytearray)) or len(image_bytes) > MAX_IMAGE_BYTES:
            raise ValueError(f"图片过大或无效（最大 {MAX_IMAGE_BYTES // (1024 * 1024)} MB）")
        suffix = sniff_image(image_bytes)
        if suffix is None:
            raise ValueError("图片格式仅支持 PNG / JPG / WebP")
        image_name = f"{dir_name}{suffix}"
        (directory / image_name).write_bytes(image_bytes)
        return image_name

    def _find(self, item_id, entries=None):
        for item in entries or self._entries():
            if item["id"] == item_id:
                return item
        return None

    def _require(self, item_id):
        item = self._find(item_id)
        if not item:
            raise KeyError(item_id)
        return item

    # ---- 对外接口 ---------------------------------------------------------

    def tree(self):
        """扁平列表（带 parent/order），前端自己拼树；顺便给出目录根，方便显示路径。"""
        return {"root": str(self.store_dir), "items": self._entries()}

    def create(self, kind, name, text=None, note=None, models=None, image_bytes=None, parent=None, color=None):
        entries = self._entries()
        if len(entries) >= MAX_ITEMS:
            raise ValueError(f"收藏数量已达上限（{MAX_ITEMS}）")
        name = " ".join(str(name or "").split())[:MAX_NAME_CHARS]
        if not name:
            raise ValueError("名称不能为空")
        kind = "folder" if kind == "folder" else "prompt"
        if kind == "prompt" and not str(text or "").strip():
            raise ValueError("提示词内容不能为空")
        if parent and not any(item["id"] == parent and item["type"] == "folder" for item in entries):
            raise ValueError("目标文件夹不存在")

        dir_name = self._unique_dir_name(name, entries)
        directory = self.store_dir / dir_name
        directory.mkdir(parents=True, exist_ok=False)
        now = int(time.time())
        info = {
            "id": secrets.token_hex(8),
            "type": kind,
            "name": name,
            "note": (str(note)[:MAX_NOTE_CHARS] if note else None),
            "models": clean_models(models),
            "color": clean_color(color),
            "created_at": now,
            "parent": parent,
            "order": max([item["order"] for item in entries if item.get("parent") == parent], default=-1) + 1,
        }
        if kind == "prompt":
            info["text"] = str(text)[:MAX_TEXT_CHARS]
        try:
            image = self._write_image(directory, dir_name, image_bytes)
        except ValueError:
            shutil.rmtree(directory, ignore_errors=True)
            raise
        if image:
            info["image"] = image
        self._write_info(directory, info)

        entries.append({
            "id": info["id"], "type": kind, "name": name, "dir": dir_name,
            "parent": info["parent"], "order": info["order"],
            "note": info["note"], "models": info["models"], "color": info.get("color"),
            "text": info.get("text", ""), "image": image, "created_at": now,
        })
        self._write_index_file(entries)
        return next(item for item in entries if item["id"] == info["id"])

    def update(self, item_id, name=None, text=None, note=None, models=None, image_bytes=None, remove_image=False, color=None):
        entries = self._entries()
        item = self._require(item_id)
        directory = self.store_dir / item["dir"]
        if not directory.is_dir():
            raise ValueError("目录已不存在，请刷新收藏列表")
        info = self._read_info(directory) or {"id": item_id, "name": item["name"]}

        new_name = " ".join(str(name).split())[:MAX_NAME_CHARS] if name is not None else item["name"]
        if not new_name:
            raise ValueError("名称不能为空")
        renamed = new_name != item["name"]
        dir_name = item["dir"]
        if renamed:
            target = self._unique_dir_name(new_name, entries, current_id=item_id)
            # 目录名跟着名称走，图片也要跟着改名，保持「目录名 = 图片名」
            previous_image = info.get("image")
            directory.rename(self.store_dir / target)
            directory = self.store_dir / target
            dir_name = target
            if previous_image:
                new_image = f"{target}{Path(previous_image).suffix}"
                try:
                    (directory / previous_image).rename(directory / new_image)
                    info["image"] = new_image
                except OSError:
                    info["image"] = None

        if text is not None and item["type"] == "prompt":
            info["text"] = str(text)[:MAX_TEXT_CHARS]
        if note is not None:
            info["note"] = (str(note)[:MAX_NOTE_CHARS] if note else None)
        if models is not None:
            info["models"] = clean_models(models)
        if color is not None:
            info["color"] = clean_color(color)
        if remove_image:
            previous = info.get("image")
            if previous:
                try:
                    (directory / previous).unlink()
                except OSError:
                    pass
            info["image"] = None
        elif image_bytes is not None:
            image = self._write_image(directory, dir_name, image_bytes, previous=info.get("image"))
            info["image"] = image

        info["name"] = new_name
        self._write_info(directory, info)

        item.update({
            "name": new_name, "dir": dir_name,
            "note": info.get("note"), "models": clean_models(info.get("models")),
            "color": clean_color(info.get("color")),
            "text": info.get("text", item.get("text", "")),
            "image": info.get("image"),
        })
        self._write_index_file(entries)
        return item

    def move(self, item_id, parent=None, index=None):
        entries = self._entries()
        item = self._require(item_id)
        if item["type"] == "folder" and parent == item_id:
            raise ValueError("不能把文件夹拖进自己里面")
        if parent:
            target = self._find(parent, entries)
            if not target or target["type"] != "folder":
                raise ValueError("目标文件夹不存在")
            if item["type"] == "folder" and target.get("parent") == item_id:
                raise ValueError("不能把文件夹拖进自己里面")

        siblings = [entry for entry in entries if entry.get("parent") == parent and entry["id"] != item_id]
        position = len(siblings) if index is None else max(0, min(int(index), len(siblings)))
        siblings.insert(position, item)
        for order, sibling in enumerate(siblings):
            sibling["order"] = order
        item["parent"] = parent
        self._write_index_file(entries)

        directory = self.store_dir / item["dir"]
        info = self._read_info(directory)
        if info:
            info["parent"] = parent
            info["order"] = item["order"]
            self._write_info(directory, info)
        return item

    def delete(self, item_id):
        entries = self._entries()
        item = self._require(item_id)
        directory = self.store_dir / item["dir"]
        # 只删库目录下的这一层，避免任何路径穿越
        if directory.is_dir() and directory.parent == self.store_dir:
            shutil.rmtree(directory, ignore_errors=True)
        remaining = [entry for entry in entries if entry["id"] != item_id]
        if item["type"] == "folder":
            # 文件夹里的东西一起消失，索引里也一并清掉
            orphaned = [entry for entry in remaining if entry.get("parent") == item_id]
            for entry in orphaned:
                child = self.store_dir / entry["dir"]
                if child.is_dir() and child.parent == self.store_dir:
                    shutil.rmtree(child, ignore_errors=True)
            remaining = [entry for entry in remaining if entry.get("parent") != item_id]
        self._write_index_file(remaining)
        return len(remaining)

    def import_legacy(self, entries, source_dir):
        """把旧的 saved_prompts 一次性搬进来：名字/文本/备注/模型照搬，图片读成字节重新落盘。

        只搬一次：搬过就写 .legacy-imported 标记，之后即使用户把收藏删空也不会再灌一遍。
        """
        marker = self.store_dir / ".legacy-imported"
        if marker.exists() or self._entries():
            return {"imported": 0, "skipped": True}
        source = Path(source_dir)
        imported = 0
        for entry in entries or []:
            if not isinstance(entry, dict):
                continue
            try:
                image_bytes = None
                image = entry.get("image")
                if isinstance(image, str) and image:
                    candidate = source / image
                    if candidate.is_file():
                        image_bytes = candidate.read_bytes()
                self.create(
                    "prompt", entry.get("name"), text=entry.get("text"),
                    note=entry.get("note"), models=entry.get("models"), image_bytes=image_bytes,
                )
                imported += 1
            except (ValueError, OSError):
                continue
        marker.write_text("1", encoding="utf-8")
        return {"imported": imported, "skipped": False}

    def image_path(self, item_id):
        item = self._require(item_id)
        image = item.get("image")
        if not image:
            raise ValueError("这条收藏没有配图")
        path = self.store_dir / item["dir"] / image
        if not path.is_file():
            raise ValueError("配图文件已丢失")
        return path

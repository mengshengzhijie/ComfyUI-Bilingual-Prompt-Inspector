"""收藏库（library_store）的存储约定：目录名 = 名称、图片与目录同名、索引当缓存。"""

import base64
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from library_store import LibraryStore, safe_dir_name  # noqa: E402

# 1x1 透明 PNG
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


class LibraryStoreTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="bpi-lib-"))
        self.store = LibraryStore(self.root)

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_create_folder_and_prompt_on_disk(self):
        folder = self.store.create("folder", "人物", note="角色类", models=["anima"])
        prompt = self.store.create(
            "prompt", "森林夜景", text="forest, night", parent=folder["id"], image_bytes=PNG
        )

        self.assertEqual(folder["dir"], "人物")
        self.assertIsNone(folder["image"])
        self.assertEqual(prompt["parent"], folder["id"])
        self.assertEqual(prompt["image"], "森林夜景.png")
        # 目录名与图片名一致，各自带一份 info.json
        self.assertTrue((self.root / "森林夜景" / "森林夜景.png").is_file())
        self.assertTrue((self.root / "森林夜景" / "info.json").is_file())
        self.assertTrue((self.root / "人物" / "info.json").is_file())
        self.assertTrue((self.root / "index.json").is_file())

    def test_rename_moves_directory_and_image(self):
        prompt = self.store.create("prompt", "森林夜景", text="x", image_bytes=PNG)
        renamed = self.store.update(prompt["id"], name="雨夜街道")

        self.assertEqual(renamed["dir"], "雨夜街道")
        self.assertEqual(renamed["image"], "雨夜街道.png")
        self.assertFalse((self.root / "森林夜景").exists())
        self.assertTrue((self.root / "雨夜街道" / "雨夜街道.png").is_file())

    def test_duplicate_names_get_suffix(self):
        first = self.store.create("prompt", "同名", text="a")
        second = self.store.create("prompt", "同名", text="b")
        self.assertNotEqual(first["dir"], second["dir"])
        self.assertTrue(second["dir"].startswith("同名 ("))

    def test_move_reorders_within_folder(self):
        folder = self.store.create("folder", "组")
        a = self.store.create("prompt", "A", text="a", parent=folder["id"])
        b = self.store.create("prompt", "B", text="b", parent=folder["id"])
        self.store.move(b["id"], parent=folder["id"], index=0)

        names = [item["name"] for item in self.store.tree()["items"] if item.get("parent") == folder["id"]]
        self.assertEqual(names, ["B", "A"])
        self.assertEqual(a["order"], 1)

    def test_delete_folder_removes_children(self):
        folder = self.store.create("folder", "组")
        self.store.create("prompt", "A", text="a", parent=folder["id"])
        remaining = self.store.delete(folder["id"])

        self.assertEqual(remaining, 0)
        self.assertFalse((self.root / "组").exists())
        self.assertEqual(self.store.tree()["items"], [])

    def test_rebuild_drops_image_when_name_mismatch(self):
        prompt = self.store.create("prompt", "森林夜景", text="x", image_bytes=PNG)
        image = self.root / "森林夜景" / "森林夜景.png"
        image.rename(self.root / "森林夜景" / "别的名字.png")

        items = self.store.rebuild()
        target = next(item for item in items if item["id"] == prompt["id"])
        self.assertIsNone(target["image"])

    def test_tree_reads_cache_not_directory(self):
        self.store.create("prompt", "A", text="a")
        # 手写一个假条目进索引：如果不是读索引而是扫目录，它就会消失
        payload = self.store._read_index_file() or {"version": 1, "items": []}
        payload["items"].append({
            "id": "fake", "type": "prompt", "name": "假条目", "dir": "假条目",
            "parent": None, "order": 99, "note": None, "models": [], "text": "", "image": None, "created_at": 0,
        })
        self.store._write_index_file(payload["items"])
        names = [item["name"] for item in self.store.tree()["items"]]
        self.assertIn("假条目", names)

    def test_folder_color_roundtrip(self):
        folder = self.store.create("folder", "带色", color="#4ca7e8")
        self.assertEqual(folder["color"], "#4ca7e8")
        # 非法值当没设
        self.store.update(folder["id"], color="red")
        again = self.store.tree()["items"][0]
        self.assertIsNone(again["color"])
        # 重建索引后仍然读得回来
        self.store.update(folder["id"], color="#5EC9A3")
        items = self.store.rebuild()
        self.assertEqual(items[0]["color"], "#5ec9a3")

    def test_unsafe_names_are_sanitized(self):
        self.assertEqual(safe_dir_name("a/b:c*d"), "a_b_c_d")
        self.assertEqual(safe_dir_name("   "), "未命名")
        self.assertEqual(safe_dir_name("CON"), "_CON")


if __name__ == "__main__":
    unittest.main()

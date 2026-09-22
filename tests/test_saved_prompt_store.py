import tempfile
import unittest
from pathlib import Path

from saved_prompt_store import (
    MAX_IMAGE_BYTES,
    SavedPromptStore,
    sniff_image,
)

PNG_HEADER = b"\x89PNG\r\n\x1a\n"
JPEG_HEADER = b"\xff\xd8\xff\xe0"
WEBP_HEADER = b"RIFF\x00\x00\x00\x00WEBP"


class SavedPromptStoreTests(unittest.TestCase):
    def make_store(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        return SavedPromptStore(store_dir=Path(temp.name))

    def test_sniff_image_recognizes_supported_types(self):
        self.assertEqual(sniff_image(PNG_HEADER + b"rest"), ".png")
        self.assertEqual(sniff_image(JPEG_HEADER + b"rest"), ".jpg")
        self.assertEqual(sniff_image(WEBP_HEADER + b"rest"), ".webp")
        self.assertIsNone(sniff_image(b"plain text"))
        self.assertIsNone(sniff_image(b""))

    def test_create_without_image(self):
        store = self.make_store()
        entry = store.create_prompt("夕阳少女", "1girl, sunset", note="节点 #7")
        self.assertEqual(entry["name"], "夕阳少女")
        self.assertEqual(entry["text"], "1girl, sunset")
        self.assertEqual(entry["note"], "节点 #7")
        self.assertIsNone(entry["image"])
        self.assertEqual(len(store.list_prompts()), 1)

    def test_create_stores_image_file(self):
        store = self.make_store()
        entry = store.create_prompt("配图", "1girl", image_bytes=PNG_HEADER + b"payload")
        self.assertEqual(entry["image"], f"{entry['id']}.png")
        self.assertTrue((store.store_dir / entry["image"]).is_file())
        self.assertTrue(store.image_path(entry["id"]).is_file())

    def test_create_sorts_newest_first(self):
        store = self.make_store()
        first = store.create_prompt("第一条", "one")
        second = store.create_prompt("第二条", "two")
        self.assertEqual([item["id"] for item in store.list_prompts()], [second["id"], first["id"]])

    def test_create_rejects_empty_text(self):
        store = self.make_store()
        with self.assertRaises(ValueError):
            store.create_prompt("空", "   ")
        self.assertEqual(store.list_prompts(), [])

    def test_create_rejects_unknown_image(self):
        store = self.make_store()
        with self.assertRaises(ValueError):
            store.create_prompt("坏图", "1girl", image_bytes=b"not an image")
        self.assertEqual(store.list_prompts(), [])

    def test_create_rejects_oversized_image(self):
        store = self.make_store()
        with self.assertRaises(ValueError):
            store.create_prompt("大图", "1girl", image_bytes=PNG_HEADER + b"\0" * (MAX_IMAGE_BYTES + 1))
        self.assertEqual(store.list_prompts(), [])

    def test_delete_removes_entry_and_image(self):
        store = self.make_store()
        entry = store.create_prompt("配图", "1girl", image_bytes=PNG_HEADER + b"payload")
        image_path = store.store_dir / entry["image"]
        self.assertEqual(store.delete_prompt(entry["id"]) , 0)
        self.assertFalse(image_path.exists())
        self.assertEqual(store.list_prompts(), [])
        with self.assertRaises(ValueError):
            store.delete_prompt(entry["id"])

    def test_image_path_rejects_missing_image(self):
        store = self.make_store()
        entry = store.create_prompt("无图", "1girl")
        with self.assertRaises(ValueError):
            store.image_path(entry["id"])
        with self.assertRaises(ValueError):
            store.image_path("does-not-exist")

    def test_export_and_import_round_trip(self):
        store = self.make_store()
        store.create_prompt("带图", "1girl, sunset", image_bytes=PNG_HEADER + b"payload")
        store.create_prompt("无图", "1boy")
        bundle = store.export_bundle()
        self.assertEqual(len(bundle["prompts"]), 2)

        other = self.make_store()
        result = other.import_bundle(bundle)
        self.assertEqual(result["imported"], 2)
        imported = other.list_prompts()
        # 导入保留原来的 created_at，所以顺序跟导出时一致（新的在前）
        self.assertEqual([item["name"] for item in imported], ["无图", "带图"])
        imaged = next(item for item in imported if item["name"] == "带图")
        self.assertTrue(imaged["image"])
        self.assertTrue((other.store_dir / imaged["image"]).is_file())

    def test_import_skips_duplicates_and_invalid(self):
        store = self.make_store()
        store.create_prompt("重复", "1girl")
        result = store.import_bundle({
            "prompts": [
                {"name": "重复", "text": "1girl"},
                {"name": "空文本", "text": "   "},
                "not a dict",
                {"name": "新的", "text": "1boy"},
            ],
        })
        self.assertEqual(result["imported"], 1)
        self.assertEqual([item["name"] for item in store.list_prompts()], ["新的", "重复"])

    def test_import_keeps_original_order_and_tolerates_bad_timestamp(self):
        store = self.make_store()
        store.import_bundle({
            "prompts": [
                {"name": "旧的", "text": "1girl", "created_at": 1000},
                {"name": "坏的", "text": "1boy", "created_at": "not a number"},
            ],
        })
        self.assertEqual([item["name"] for item in store.list_prompts()], ["坏的", "旧的"])

    def test_import_rejects_bad_payload(self):
        store = self.make_store()
        with self.assertRaises(ValueError):
            store.import_bundle({"prompts": "nope"})
        with self.assertRaises(ValueError):
            store.import_bundle([])


if __name__ == "__main__":
    unittest.main()

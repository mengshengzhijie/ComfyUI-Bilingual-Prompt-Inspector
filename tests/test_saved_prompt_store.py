import tempfile
import unittest
from pathlib import Path

from saved_prompt_store import (
    MAX_IMAGE_BYTES,
    MAX_MODELS,
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

    def test_create_cleans_models(self):
        store = self.make_store()
        entry = store.create_prompt("带模型", "1girl", models=["  Anima ", "anima", "Pony", 42, None, ""])
        # 去空白、忽略大小写去重、只留字符串
        self.assertEqual(entry["models"], ["Anima", "Pony"])

    def test_create_caps_models(self):
        store = self.make_store()
        entry = store.create_prompt("很多模型", "1girl", models=[f"model-{index}" for index in range(MAX_MODELS + 5)])
        self.assertEqual(len(entry["models"]), MAX_MODELS)

    def test_create_without_models_stores_empty_list(self):
        store = self.make_store()
        self.assertEqual(store.create_prompt("无模型", "1girl", models="Anima")["models"], [])
        self.assertEqual(store.create_prompt("无模型2", "1girl")["models"], [])

    def test_export_and_import_keep_models(self):
        store = self.make_store()
        store.create_prompt("带模型", "1girl", models=["Anima"])
        bundle = store.export_bundle()
        self.assertEqual(bundle["prompts"][0]["models"], ["Anima"])

        other = self.make_store()
        other.import_bundle(bundle)
        self.assertEqual(other.list_prompts()[0]["models"], ["Anima"])

    def test_update_changes_fields_and_clears_note(self):
        store = self.make_store()
        entry = store.create_prompt("原名", "1girl", note="备注", models=["Anima"])
        updated = store.update_prompt(entry["id"], "新名", "1girl, sunset", note=None, models=["Pony", "pony"])
        self.assertEqual(updated["name"], "新名")
        self.assertEqual(updated["text"], "1girl, sunset")
        self.assertIsNone(updated["note"])
        self.assertEqual(updated["models"], ["Pony"])
        self.assertEqual(store.list_prompts()[0]["name"], "新名")

    def test_update_keeps_image_when_no_new_one_given(self):
        store = self.make_store()
        entry = store.create_prompt("带图", "1girl", image_bytes=PNG_HEADER + b"payload")
        updated = store.update_prompt(entry["id"], "带图", "1girl, sunset")
        self.assertEqual(updated["image"], entry["image"])
        self.assertTrue((store.store_dir / entry["image"]).is_file())

    def test_update_replaces_image_and_deletes_old_file(self):
        store = self.make_store()
        entry = store.create_prompt("带图", "1girl", image_bytes=PNG_HEADER + b"payload")
        old_path = store.store_dir / entry["image"]
        updated = store.update_prompt(entry["id"], "带图", "1girl", image_bytes=JPEG_HEADER + b"payload")
        self.assertEqual(updated["image"], f"{entry['id']}.jpg")
        self.assertFalse(old_path.exists())
        self.assertTrue((store.store_dir / updated["image"]).is_file())

    def test_update_rejects_empty_text_and_missing_entry(self):
        store = self.make_store()
        entry = store.create_prompt("原名", "1girl")
        with self.assertRaises(ValueError):
            store.update_prompt(entry["id"], "空", "  ")
        with self.assertRaises(ValueError):
            store.update_prompt("does-not-exist", "名", "1girl")
        self.assertEqual(store.list_prompts()[0]["text"], "1girl")

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

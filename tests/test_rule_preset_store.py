"""AI 规则预设：一套规则一个 json，按后端分目录。"""

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from rule_preset_store import RulePresetStore  # noqa: E402

SAMPLE = {
    "translation": "translate to chinese",
    "translate_optimize": "translate and tidy",
    "optimization": "optimize tags",
    "natural": "write natural language",
}


class RulePresetStoreTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="bpi-rules-"))
        self.store = RulePresetStore(self.root)

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_save_and_list_per_backend(self):
        self.store.save_preset("openai", "方案A", SAMPLE)
        self.store.save_preset("ollama", "本地Qwen", {**SAMPLE, "natural": "local"})

        openai = self.store.list_presets("openai")
        ollama = self.store.list_presets("ollama")
        self.assertEqual([item["name"] for item in openai], ["方案A"])
        self.assertEqual([item["name"] for item in ollama], ["本地Qwen"])
        self.assertEqual(openai[0]["rules"]["translation"], "translate to chinese")
        self.assertEqual(ollama[0]["rules"]["natural"], "local")

    def test_each_preset_is_its_own_file(self):
        self.store.save_preset("openai", "A", SAMPLE)
        self.store.save_preset("openai", "B", SAMPLE)
        files = sorted(path.name for path in (self.root / "openai").glob("*.json"))
        self.assertEqual(files, ["A.json", "B.json"])

    def test_same_name_overwrites(self):
        self.store.save_preset("openai", "A", SAMPLE)
        self.store.save_preset("openai", "A", {**SAMPLE, "translation": "new"})
        presets = self.store.list_presets("openai")
        self.assertEqual(len(presets), 1)
        self.assertEqual(presets[0]["rules"]["translation"], "new")

    def test_delete_removes_file(self):
        self.store.save_preset("openai", "A", SAMPLE)
        self.store.delete_preset("openai", "A")
        self.assertEqual(self.store.list_presets("openai"), [])

    def test_broken_file_is_skipped(self):
        self.store.save_preset("openai", "good", SAMPLE)
        (self.root / "openai" / "broken.json").write_text("{not json", encoding="utf-8")
        names = [item["name"] for item in self.store.list_presets("openai")]
        self.assertEqual(names, ["good"])

    def test_name_sanitized_and_empty_rejected(self):
        saved = self.store.save_preset("openai", "a/b:c", SAMPLE)
        self.assertEqual(saved["name"], "a_b_c")
        with self.assertRaises(ValueError):
            self.store.save_preset("openai", "   ", SAMPLE)


if __name__ == "__main__":
    unittest.main()

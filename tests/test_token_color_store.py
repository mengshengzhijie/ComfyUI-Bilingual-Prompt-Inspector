import json
import tempfile
import unittest
from pathlib import Path

from token_color_store import (
    DEFAULT_PRESETS,
    DEFAULT_RANDOM_POOL,
    TokenColorStore,
    normalize_color,
)


class TokenColorStoreTests(unittest.TestCase):
    def make_store(self, payload=None):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        store = TokenColorStore(Path(temp.name))
        if payload is not None:
            store.path.write_text(json.dumps(payload), encoding="utf-8")
        return store

    def test_normalize_color_accepts_short_and_long_hex(self):
        self.assertEqual(normalize_color("#abc"), "#aabbcc")
        self.assertEqual(normalize_color("#AABBCC"), "#aabbcc")
        self.assertIsNone(normalize_color("#abcde"))
        self.assertIsNone(normalize_color("red"))
        self.assertIsNone(normalize_color(None))

    def test_missing_file_falls_back_to_defaults(self):
        config = self.make_store().config()
        self.assertEqual(config["presets"], DEFAULT_PRESETS)
        self.assertEqual(config["random_pool"], DEFAULT_RANDOM_POOL)
        self.assertEqual(config["pack_colors"], {})
        self.assertEqual(config["anima_colors"], {})

    def test_broken_or_partial_file_still_reads_pools(self):
        config = self.make_store({"presets": ["#112233"], "random_pool": [], "pack_colors": "bad"}).config()
        self.assertEqual(config["presets"], ["#112233"])
        self.assertEqual(config["random_pool"], [])
        self.assertEqual(config["pack_colors"], {})

    def test_save_colors_writes_back_and_keeps_pools(self):
        store = self.make_store()
        config = store.save_colors(pack_colors={"personal": "#ABC", "camera": None})
        self.assertEqual(config["pack_colors"], {"personal": "#aabbcc"})
        self.assertEqual(config["presets"], DEFAULT_PRESETS)
        written = json.loads(store.path.read_text(encoding="utf-8"))
        self.assertEqual(written["pack_colors"], {"personal": "#aabbcc"})

    def test_save_colors_rejects_bad_input(self):
        store = self.make_store()
        with self.assertRaises(ValueError):
            store.save_colors(pack_colors={"personal": "not-a-color"})
        with self.assertRaises(ValueError):
            store.save_colors(anima_colors={"bad id!": "#112233"})
        with self.assertRaises(ValueError):
            store.save_colors(pack_colors=[])

    def test_empty_value_clears_existing_pack_color(self):
        store = self.make_store({"pack_colors": {"personal": "#112233"}})
        self.assertEqual(store.config()["pack_colors"], {"personal": "#112233"})
        self.assertEqual(store.save_colors(pack_colors={"personal": ""})["pack_colors"], {})

    def test_anima_colors_are_saved_alongside_pack_colors(self):
        store = self.make_store({"pack_colors": {"personal": "#112233"}})
        config = store.save_colors(anima_colors={"quality": "#ABC", "expression": ""})
        self.assertEqual(config["anima_colors"], {"quality": "#aabbcc"})
        # 只传了一类，另一类保持原样
        self.assertEqual(config["pack_colors"], {"personal": "#112233"})
        self.assertEqual(store.config()["anima_colors"], {"quality": "#aabbcc"})

    def test_save_colors_without_payload_is_rejected(self):
        store = self.make_store()
        with self.assertRaises(ValueError):
            store.save_colors()

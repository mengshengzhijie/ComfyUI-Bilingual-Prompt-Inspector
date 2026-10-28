import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from assistant_store import (
    AssistantStore,
    DEFAULT_NATURAL_RULE,
    DEFAULT_OPTIMIZATION_RULE,
    DEFAULT_TRANSLATE_OPTIMIZE_RULE,
    DEFAULT_TRANSLATION_RULE,
    LEGACY_DEFAULT_OPTIMIZATION_RULE,
    LEGACY_DEFAULT_TRANSLATION_RULE,
    V17_DEFAULT_TRANSLATION_RULE,
    baidu_split_query,
    baidu_translate_params,
    dictionary_translate,
    normalize_ai_base_url,
    ollama_tags_endpoint,
    openai_chat_endpoint,
    openai_models_endpoint,
    parse_json_body,
    sanitize_anima_prompt,
    sanitize_natural_prompt,
    translation_direction,
    upstream_error_message,
)
from dictionary_store import DictionaryStore


class AssistantStoreTests(unittest.TestCase):
    def make_dictionary(self, root):
        data = Path(root) / "dictionary"
        data.mkdir()
        (data / "base_tags.json").write_text(json.dumps({"tags": [
            {"english": "long hair", "chinese": "长发", "category": "发型"},
            {"english": "smile", "chinese": "微笑", "category": "表情"},
        ]}), encoding="utf-8")
        (data / "user_tags.json").write_text('{"tags": []}', encoding="utf-8")
        return DictionaryStore(data)

    def test_config_masks_api_key_and_preserves_custom_rules(self):
        with tempfile.TemporaryDirectory() as root:
            store = AssistantStore(Path(root) / "config")
            public = store.update({
                "translate_service": "openai_compatible",
                "ai_provider": "openai_compatible",
                "openai_base_url": "https://example.test/v1",
                "openai_model": "example-model",
                "openai_api_key": "secret-value",
                "openai_translation_rule": "自定义仅翻译",
                "openai_translate_optimize_rule": "自定义翻译并优化",
                "openai_optimization_rule": "自定义优化",
            })
            self.assertTrue(public["openai_api_key_configured"])
            self.assertNotIn("openai_api_key", public)
            self.assertEqual(store.config()["openai_api_key"], "secret-value")
            self.assertEqual(store.config()["openai_translation_rule"], "自定义仅翻译")
            self.assertEqual(store.config()["openai_translate_optimize_rule"], "自定义翻译并优化")
            # 另一套规则不受影响
            self.assertEqual(store.config()["ollama_translation_rule"], DEFAULT_TRANSLATION_RULE)
            self.assertNotIn("explanation_rule", public)

    def test_openai_and_ollama_slots_are_independent(self):
        with tempfile.TemporaryDirectory() as root:
            store = AssistantStore(Path(root) / "config")
            store.update({
                "ai_provider": "openai_compatible",
                "openai_base_url": "https://example.test/v1",
                "openai_model": "cloud-model",
                "openai_api_key": "secret-value",
                "openai_translation_rule": "云端规则",
            })
            store.update({
                "ai_provider": "ollama",
                "ollama_model": "qwen3:8b",
                "ollama_translation_rule": "本地规则",
            })
            config = store.config()
            self.assertEqual(config["openai_model"], "cloud-model")
            self.assertEqual(config["openai_api_key"], "secret-value")
            self.assertEqual(config["openai_translation_rule"], "云端规则")
            self.assertEqual(config["ollama_model"], "qwen3:8b")
            self.assertEqual(config["ollama_base_url"], "http://127.0.0.1:11434")
            self.assertEqual(config["ollama_translation_rule"], "本地规则")

    def test_dictionary_translation_preserves_weight(self):
        with tempfile.TemporaryDirectory() as root:
            dictionary = self.make_dictionary(root)
            self.assertEqual(dictionary_translate("长发，(微笑:1.2)", dictionary), "long hair, (smile:1.2)")

    def test_api_key_is_bound_to_base_url(self):
        with tempfile.TemporaryDirectory() as root:
            store = AssistantStore(Path(root) / "config")
            store.update({
                "translate_service": "openai_compatible",
                "ai_provider": "openai_compatible",
                "openai_base_url": "https://first.example/v1",
                "openai_model": "example-model",
                "openai_api_key": "secret-value",
            })
            self.assertEqual(store.config()["openai_api_key"], "secret-value")
            public = store.update({"openai_base_url": "https://second.example/v1"})
            self.assertFalse(public["openai_api_key_configured"])
            self.assertEqual(store.config()["openai_api_key"], "")

    def test_api_key_survives_provider_switch(self):
        with tempfile.TemporaryDirectory() as root:
            store = AssistantStore(Path(root) / "config")
            store.update({"openai_base_url": "https://example.test/v1", "openai_model": "m", "openai_api_key": "secret-value"})
            # 切到 Ollama 再切回来，密钥还在
            store.update({"ai_provider": "ollama"})
            self.assertEqual(store.config()["openai_api_key"], "secret-value")
            store.update({"ai_provider": "openai_compatible"})
            self.assertTrue(store.public_config()["openai_api_key_configured"])

    def test_legacy_ai_translate_service_is_split_by_provider(self):
        with tempfile.TemporaryDirectory() as root:
            store = AssistantStore(Path(root) / "config")
            store.config_dir.mkdir(parents=True, exist_ok=True)
            store.config_path.write_text(json.dumps({
                "installation_id": store.installation_id,
                "schema_version": 4,
                "translate_service": "ai",
                "ai_provider": "ollama",
                "ollama_model": "qwen3:8b",
            }, ensure_ascii=False), encoding="utf-8")
            config = store.config()
            self.assertEqual(config["translate_service"], "ollama")
            self.assertEqual(config["ai_provider"], "ollama")

    def test_ai_translate_service_pins_the_matching_provider(self):
        with tempfile.TemporaryDirectory() as root:
            store = AssistantStore(Path(root) / "config")
            store.update({
                "translate_service": "openai_compatible",
                "openai_base_url": "https://example.test/v1",
                "openai_model": "m",
                "openai_api_key": "secret-value",
            })
            public = store.update({"translate_service": "ollama"})
            self.assertEqual(public["translate_service"], "ollama")
            self.assertEqual(public["ai_provider"], "ollama")
            back = store.update({"translate_service": "openai_compatible"})
            self.assertEqual(back["translate_service"], "openai_compatible")
            self.assertEqual(back["ai_provider"], "openai_compatible")
            self.assertTrue(back["openai_api_key_configured"])

    def test_new_installation_id_invalidates_saved_configuration(self):
        with tempfile.TemporaryDirectory() as root:
            config_dir = Path(root) / "config"
            first_marker = Path(root) / "first-installation-id"
            first = AssistantStore(config_dir, install_id_path=first_marker)
            first.update({
                "translate_service": "openai_compatible",
                "ai_provider": "openai_compatible",
                "openai_base_url": "https://example.test/v1",
                "openai_model": "example-model",
                "openai_api_key": "secret-value",
            })
            second = AssistantStore(config_dir, install_id_path=Path(root) / "second-installation-id")
            config = second.config()
            self.assertEqual(config["translate_service"], "dictionary")
            self.assertEqual(config["openai_base_url"], "")
            self.assertEqual(config["openai_api_key"], "")

    def test_openai_base_url_requires_https_or_loopback(self):
        with tempfile.TemporaryDirectory() as root:
            store = AssistantStore(Path(root) / "config")
            with self.assertRaisesRegex(ValueError, "HTTPS"):
                store.update({"openai_base_url": "http://public.example/v1"})
            with self.assertRaisesRegex(ValueError, "完整的 http"):
                store.update({"openai_base_url": "public.example/v1"})
            self.assertEqual(store.update({"openai_base_url": "https://public.example/v1"})["openai_base_url"], "https://public.example/v1")
            # 本机回环的 http 放行：本地 LM Studio 之类
            self.assertEqual(store.update({"openai_base_url": "http://127.0.0.1:1234/v1"})["openai_base_url"], "http://127.0.0.1:1234/v1")

    def test_ollama_base_url_must_be_loopback(self):
        with tempfile.TemporaryDirectory() as root:
            store = AssistantStore(Path(root) / "config")
            self.assertEqual(store.config()["ollama_base_url"], "http://127.0.0.1:11434")
            self.assertEqual(store.update({"ollama_base_url": "http://localhost:11434"})["ollama_base_url"], "http://localhost:11434")
            self.assertEqual(store.update({"ollama_base_url": "http://[::1]:11434"})["ollama_base_url"], "http://[::1]:11434")
            for blocked in ("http://192.168.1.20:11434", "http://10.0.0.5:11434", "https://ollama.example.test"):
                with self.assertRaisesRegex(ValueError, "Ollama 地址只能是本机地址"):
                    store.update({"ollama_base_url": blocked})

    def test_remote_https_rejects_private_and_reserved_addresses(self):
        # https 也不能拐进内网：云元数据、私有网段、链路本地一律拒绝
        for blocked in (
            "https://169.254.169.254/latest",
            "https://192.168.1.20/v1",
            "https://10.0.0.5/v1",
            "https://172.16.0.9/v1",
            "https://[fd00::1]/v1",
        ):
            with self.assertRaisesRegex(ValueError, "内网、保留或链路本地"):
                normalize_ai_base_url(blocked, allow_remote=True)
        # 公网域名与公网 IP 正常放行
        self.assertEqual(normalize_ai_base_url("https://api.example.test/v1", allow_remote=True), "https://api.example.test/v1")
        self.assertEqual(normalize_ai_base_url("https://8.8.8.8/v1", allow_remote=True), "https://8.8.8.8/v1")
        # 本机回环不受这条限制
        self.assertEqual(normalize_ai_base_url("http://127.0.0.1:1234/v1", allow_remote=True), "http://127.0.0.1:1234/v1")

    def test_private_https_openai_url_is_rejected_on_save(self):
        with tempfile.TemporaryDirectory() as root:
            store = AssistantStore(Path(root) / "config")
            with self.assertRaisesRegex(ValueError, "内网、保留或链路本地"):
                store.update({"openai_base_url": "https://192.168.1.20/v1"})
            self.assertEqual(store.update({"openai_base_url": "https://api.example.test/v1"})["openai_base_url"], "https://api.example.test/v1")

    def test_normalize_ai_base_url_rejects_credentials_and_query(self):
        with self.assertRaisesRegex(ValueError, "用户名或密码"):
            normalize_ai_base_url("https://user:pass@example.test/v1", allow_remote=True)
        with self.assertRaisesRegex(ValueError, "查询参数"):
            normalize_ai_base_url("https://example.test/v1?x=1", allow_remote=True)
        self.assertEqual(normalize_ai_base_url("https://example.test/v1/", allow_remote=True), "https://example.test/v1")
        self.assertEqual(normalize_ai_base_url(""), "")

    def test_v3_config_migrates_into_selected_provider_slot(self):
        with tempfile.TemporaryDirectory() as root:
            store = AssistantStore(Path(root) / "config")
            store.config_dir.mkdir(parents=True, exist_ok=True)
            store.config_path.write_text(json.dumps({
                "installation_id": store.installation_id,
                "schema_version": 3,
                "translate_service": "ollama",
                "ai_provider": "ollama",
                "ai_base_url": "http://127.0.0.1:11434",
                "ai_model": "qwen3:8b",
                "ai_temperature": 0.7,
                "ai_timeout_seconds": 120,
                "translation_rule": "我的规则",
                "translate_optimize_rule": "我的优化规则",
                "optimization_rule": "我的整理规则",
            }, ensure_ascii=False), encoding="utf-8")
            config = store.config()
            self.assertEqual(config["ollama_base_url"], "http://127.0.0.1:11434")
            self.assertEqual(config["ollama_model"], "qwen3:8b")
            self.assertEqual(config["ollama_temperature"], 0.7)
            self.assertEqual(config["ollama_timeout_seconds"], 120)
            self.assertEqual(config["openai_model"], "")  # 另一套留默认
            # 规则原本不分后端，两套都继承
            self.assertEqual(config["ollama_translation_rule"], "我的规则")
            self.assertEqual(config["openai_translation_rule"], "我的规则")
            self.assertEqual(config["schema_version"], 4)

    def test_v3_migration_keeps_openai_api_key(self):
        with tempfile.TemporaryDirectory() as root:
            store = AssistantStore(Path(root) / "config")
            store.config_dir.mkdir(parents=True, exist_ok=True)
            store.config_path.write_text(json.dumps({
                "installation_id": store.installation_id,
                "schema_version": 3,
                "ai_provider": "openai_compatible",
                "ai_base_url": "https://example.test/v1",
                "ai_model": "example-model",
                "ai_api_key": "secret-value",
            }, ensure_ascii=False), encoding="utf-8")
            config = store.config()
            # 绑定的 provider 标记变了，密钥不能因此被当成「换了地址」清掉
            self.assertEqual(config["openai_api_key"], "secret-value")
            self.assertTrue(store.public_config()["openai_api_key_configured"])

    def test_dictionary_translation_reports_unknown(self):
        with tempfile.TemporaryDirectory() as root:
            dictionary = self.make_dictionary(root)
            with self.assertRaisesRegex(ValueError, "词库搜索.*手动加入个人词库"):
                dictionary_translate("不存在的中文标签", dictionary)

    def test_lm_studio_and_openai_endpoint_normalization(self):
        self.assertEqual(
            openai_chat_endpoint("http://127.0.0.1:1234"),
            "http://127.0.0.1:1234/v1/chat/completions",
        )
        self.assertEqual(
            openai_chat_endpoint("http://localhost:1234/v1"),
            "http://localhost:1234/v1/chat/completions",
        )
        self.assertEqual(
            openai_chat_endpoint("https://example.test/v1/chat/completions"),
            "https://example.test/v1/chat/completions",
        )

    def test_language_direction_and_anima_punctuation(self):
        self.assertEqual(translation_direction("masterpiece, best quality"), "to_chinese")
        self.assertEqual(translation_direction("杰作, best quality"), "to_english")
        self.assertEqual(
            sanitize_anima_prompt("```text\nmasterpiece，(smile：1.2)；@artist！\n```"),
            "masterpiece, (smile:1.2), @artist",
        )
        # 模型把结果包成 JSON/代码字符串时会残留转义符，清洗后不应判废
        self.assertEqual(
            sanitize_anima_prompt('masterpiece, \\"blue eyes\\", 1girl'),
            "masterpiece, blue eyes, 1girl",
        )
        self.assertEqual(
            sanitize_anima_prompt("masterpiece\\n\\t1girl, ＂blue dress＂"),
            "masterpiece, 1girl, blue dress",
        )
        # 模型用来断句的句点统一换成逗号，权重里的小数点必须原样保留
        self.assertEqual(
            sanitize_anima_prompt("masterpiece, 1girl, dragon slayer ornstein."),
            "masterpiece, 1girl, dragon slayer ornstein",
        )
        self.assertEqual(
            sanitize_anima_prompt("masterpiece, 1girl. A boy stands in the rain."),
            "masterpiece, 1girl, A boy stands in the rain",
        )
        self.assertEqual(
            sanitize_anima_prompt("(smile:1.2), (@rei (sanbonzakura):1.3), 1girl. A knight stands."),
            "(smile:1.2), (@rei (sanbonzakura):1.3), 1girl, A knight stands",
        )
        self.assertEqual(
            sanitize_anima_prompt("<lora:detail:0.8>, 1girl. A knight stands amid ruins, red banners."),
            "<lora:detail:0.8>, 1girl, A knight stands amid ruins, red banners",
        )
        with self.assertRaisesRegex(ValueError, "不符合 Anima"):
            sanitize_anima_prompt("masterpiece [smile]")
        with self.assertRaisesRegex(ValueError, "仍包含中文"):
            sanitize_anima_prompt("masterpiece, 杰作")

    def test_natural_prompt_keeps_sentence_punctuation(self):
        # 与 Anima 清洗的核心区别：句点是句子的一部分，不能被换成逗号
        self.assertEqual(
            sanitize_natural_prompt("A woman stands in the rain. She looks tired."),
            "A woman stands in the rain. She looks tired.",
        )
        # 逗号是句子内部的停顿，原样保留
        self.assertEqual(
            sanitize_natural_prompt("A woman stands in the rain, tired and cold."),
            "A woman stands in the rain, tired and cold.",
        )
        # 全角标点统一成半角，代码块围栏和转义符照旧清掉
        self.assertEqual(
            sanitize_natural_prompt('```text\nA woman stands in the rain，tired。\n```'),
            "A woman stands in the rain, tired.",
        )
        self.assertEqual(
            sanitize_natural_prompt('A woman \\"stands\\" in the rain'),
            'A woman "stands" in the rain',
        )
        # 模型爱用列表；自然语言结果里列表符号要去掉，换行收成空格
        self.assertEqual(
            sanitize_natural_prompt("1. A woman stands in the rain\n2. She looks tired"),
            "A woman stands in the rain She looks tired",
        )
        with self.assertRaisesRegex(ValueError, "仍包含中文"):
            sanitize_natural_prompt("一名女子站在雨中")

    def test_natural_rule_is_persisted_per_backend(self):
        with tempfile.TemporaryDirectory() as root:
            store = AssistantStore(config_dir=root, install_id_path=Path(root) / "install")
            store.update({"openai_natural_rule": "我的自然语言规则", "ollama_natural_rule": "本地规则"})
            config = store.config()
            self.assertEqual(config["openai_natural_rule"], "我的自然语言规则")
            self.assertEqual(config["ollama_natural_rule"], "本地规则")
            # 另一套不受影响，且默认值能通过 public_config 取回
            self.assertEqual(config["openai_optimization_rule"], DEFAULT_OPTIMIZATION_RULE)
            public = store.public_config()
            self.assertEqual(public["default_openai_natural_rule"], DEFAULT_NATURAL_RULE)
            self.assertEqual(public["default_ollama_natural_rule"], DEFAULT_NATURAL_RULE)

    def test_legacy_default_rules_are_upgraded(self):
        with tempfile.TemporaryDirectory() as root:
            store = AssistantStore(Path(root) / "config")
            store.config_dir.mkdir(parents=True, exist_ok=True)
            store.config_path.write_text(json.dumps({
                "provider": "openai_compatible",
                "translation_rule": LEGACY_DEFAULT_TRANSLATION_RULE,
                "optimization_rule": LEGACY_DEFAULT_OPTIMIZATION_RULE,
            }, ensure_ascii=False), encoding="utf-8")
            config = store.config()
            for prefix in ("openai", "ollama"):
                self.assertEqual(config[f"{prefix}_translation_rule"], DEFAULT_TRANSLATION_RULE)
                self.assertEqual(config[f"{prefix}_translate_optimize_rule"], DEFAULT_TRANSLATE_OPTIMIZE_RULE)
                self.assertEqual(config[f"{prefix}_optimization_rule"], DEFAULT_OPTIMIZATION_RULE)

    def test_v17_default_translation_rule_is_upgraded_without_overwriting_custom_rules(self):
        with tempfile.TemporaryDirectory() as root:
            store = AssistantStore(Path(root) / "config")
            store.config_dir.mkdir(parents=True, exist_ok=True)
            store.config_path.write_text(json.dumps({
                "installation_id": store.installation_id,
                "provider": "dictionary",
                "translation_rule": V17_DEFAULT_TRANSLATION_RULE,
            }, ensure_ascii=False), encoding="utf-8")
            self.assertEqual(store.config()["openai_translation_rule"], DEFAULT_TRANSLATION_RULE)

            store.update({"openai_translation_rule": "我的自定义翻译规则"})
            self.assertEqual(store.config()["openai_translation_rule"], "我的自定义翻译规则")
            self.assertEqual(store.config()["ollama_translation_rule"], DEFAULT_TRANSLATION_RULE)

    def test_baidu_provider_saves_and_masks_secret(self):
        with tempfile.TemporaryDirectory() as root:
            store = AssistantStore(Path(root) / "config")
            public = store.update({
                "translate_service": "baidu",
                "baidu_appid": "2026092000123456",
                "baidu_secret_key": "baidu-secret",
            })
            self.assertEqual(public["translate_service"], "baidu")
            self.assertEqual(public["baidu_appid"], "2026092000123456")
            self.assertTrue(public["baidu_secret_key_configured"])
            self.assertNotIn("baidu_secret_key", public)
            self.assertEqual(store.config()["baidu_secret_key"], "baidu-secret")
            self.assertFalse(public["openai_api_key_configured"])

    def test_baidu_secret_is_retained_when_translate_service_changes(self):
        with tempfile.TemporaryDirectory() as root:
            store = AssistantStore(Path(root) / "config")
            store.update({"translate_service": "baidu", "baidu_appid": "appid", "baidu_secret_key": "baidu-secret"})
            public = store.update({"translate_service": "openai_compatible", "ai_provider": "openai_compatible", "openai_base_url": "https://example.test/v1", "openai_model": "m"})
            self.assertTrue(public["baidu_secret_key_configured"])
            self.assertEqual(store.config()["baidu_secret_key"], "baidu-secret")

    def test_baidu_secret_is_cleared_on_explicit_clear(self):
        with tempfile.TemporaryDirectory() as root:
            store = AssistantStore(Path(root) / "config")
            store.update({"translate_service": "baidu", "baidu_appid": "appid", "baidu_secret_key": "baidu-secret"})
            public = store.update({"clear_baidu_secret_key": True})
            self.assertFalse(public["baidu_secret_key_configured"])
            self.assertEqual(store.config()["baidu_secret_key"], "")

    def test_baidu_qps_is_persisted_and_validated(self):
        with tempfile.TemporaryDirectory() as root:
            store = AssistantStore(Path(root) / "config")
            # 新装默认按标准版 1 QPS，宁慢不错
            self.assertEqual(store.config()["baidu_qps"], 1.0)
            public = store.update({"translate_service": "baidu", "baidu_appid": "appid", "baidu_qps": 10})
            self.assertEqual(public["baidu_qps"], 10.0)
            self.assertEqual(store.config()["baidu_qps"], 10.0)
            # 非数字直接拒绝，不静默回退，免得用户以为填上了
            with self.assertRaises(ValueError):
                store.update({"baidu_qps": "很快"})
            # 越界收敛到上下限
            self.assertEqual(store.update({"baidu_qps": 999})["baidu_qps"], 50.0)
            self.assertEqual(store.update({"baidu_qps": 0})["baidu_qps"], 0.1)

    def test_baidu_qps_falls_back_when_config_file_is_corrupt(self):
        with tempfile.TemporaryDirectory() as root:
            store = AssistantStore(Path(root) / "config")
            store.update({"translate_service": "baidu"})
            path = Path(root) / "config" / "assistant_settings.json"
            raw = json.loads(path.read_text(encoding="utf-8"))
            raw["baidu_qps"] = "not-a-number"
            path.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
            self.assertEqual(store.config()["baidu_qps"], 1.0)

    def test_model_list_endpoints_reuse_the_saved_base_url_shape(self):
        self.assertEqual(openai_models_endpoint("https://api.openai.com/v1"), "https://api.openai.com/v1/models")
        self.assertEqual(openai_models_endpoint("http://127.0.0.1:1234/v1/"), "http://127.0.0.1:1234/v1/models")
        self.assertEqual(openai_models_endpoint("https://x.cn/v1/chat/completions"), "https://x.cn/v1/models")
        self.assertEqual(openai_models_endpoint("https://x.cn/models"), "https://x.cn/models")
        self.assertEqual(ollama_tags_endpoint("http://127.0.0.1:11434"), "http://127.0.0.1:11434/api/tags")
        self.assertEqual(ollama_tags_endpoint("http://127.0.0.1:11434/v1"), "http://127.0.0.1:11434/api/tags")
        self.assertEqual(ollama_tags_endpoint("http://127.0.0.1:11434/api/chat"), "http://127.0.0.1:11434/api/tags")
        self.assertEqual(openai_models_endpoint(""), "")
        self.assertEqual(ollama_tags_endpoint(""), "")

    def test_error_bodies_that_are_not_json_still_read_as_a_sentence(self):
        # DeepSeek 缺密钥时回的是纯文本一行，不是 JSON；解析不了也不能把整条请求打崩
        # 第三个参数和 server.py 里的调用保持一致：整条路径改签名时这里会先炸出来
        self.assertIn("Authentication Fails", upstream_error_message("Authentication Fails (governor)", 401, "API"))
        self.assertIn("请检查 API 密钥", upstream_error_message("Authentication Fails (governor)", 401, "API"))
        self.assertEqual(
            upstream_error_message('{"error":{"message":"Invalid API key"}}', 401, "API"),
            "Invalid API key（HTTP 401；请检查 API 密钥是否已填写、是否有效）",
        )
        self.assertEqual(upstream_error_message("404 page not found", 404, "API"), "404 page not found（HTTP 404）")
        self.assertEqual(upstream_error_message("", 502, "Ollama"), "Ollama 请求失败（HTTP 502）")
        self.assertTrue(len(upstream_error_message("<html>" + "x" * 500 + "</html>", 403, "API")) < 220)

    def test_non_json_success_body_reports_instead_of_crashing(self):
        self.assertEqual(parse_json_body('{"data": []}', "API"), {"data": []})
        with self.assertRaises(ValueError) as raised:
            parse_json_body("<html>login</html>", "API")
        self.assertIn("返回的不是 JSON", str(raised.exception))
        with self.assertRaises(ValueError):
            parse_json_body("[1, 2, 3]", "API")

    def test_baidu_params_and_query_splitting(self):
        params = baidu_translate_params("appid", "secret", "你好", "zh", salt="12345")
        self.assertEqual(params["sign"], hashlib.md5("appid你好12345secret".encode("utf-8")).hexdigest())
        self.assertEqual(params["q"], "你好")
        self.assertEqual(baidu_split_query(""), [])
        self.assertEqual(baidu_split_query("a\nb"), ["a\nb"])
        chunks = baidu_split_query("，".join(["很长的标签" * 20] * 40))
        self.assertTrue(len(chunks) > 1)
        self.assertTrue(all(len(chunk) <= 600 for chunk in chunks))
        rejoined = "".join(part for chunk in chunks for part in chunk.split("\n"))
        self.assertEqual(rejoined, "，".join(["很长的标签" * 20] * 40))


if __name__ == "__main__":
    unittest.main()

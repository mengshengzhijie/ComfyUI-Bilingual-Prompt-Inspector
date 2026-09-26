import asyncio
import json
import sqlite3
import re
import secrets
import time
from collections import deque
from functools import wraps
from urllib.parse import urlparse

from aiohttp import ClientSession, ClientTimeout, web
from comfy import model_management
from server import PromptServer

from .assistant_store import (
    BAIDU_ERROR_MESSAGES,
    BAIDU_QPS_DEFAULT,
    BAIDU_TRANSLATE_ENDPOINT,
    AssistantStore,
    baidu_split_query,
    baidu_translate_params,
    dictionary_translate,
    openai_chat_endpoint,
    sanitize_anima_prompt,
    translation_direction,
)
from .dictionary_store import DictionaryStore, normalize_key
from .saved_prompt_store import (
    MAX_IMAGE_BYTES,
    SavedPromptStore,
)


store = DictionaryStore()
assistant_store = AssistantStore()
assistant_store.config()  # 进程启动时立即清除与当前安装身份不匹配的旧配置和凭据

_SESSION_TOKEN = secrets.token_urlsafe(32)
_MAX_JSON_BYTES = 8 * 1024 * 1024
_MAX_ASSISTANT_JSON_BYTES = 256 * 1024
_ASSISTANT_RATE_WINDOW = 60.0
_ASSISTANT_RATE_LIMIT = 30
_assistant_requests = deque()
_assistant_slots = asyncio.Semaphore(2)
# 百度翻译的全局 QPS 节流：所有百度请求共用一条时间轴，跨请求生效。
# 之前是每个请求内部 sleep(1.1)，只有单次文本被拆成多块时才生效，逐条翻译等于没节流。
_baidu_gate = asyncio.Lock()
_baidu_next_slot = 0.0


class AssistantLimitError(ValueError):
    pass


def error_response(error, status=400):
    return web.json_response({"success": False, "error": str(error)}, status=status)


def _same_origin(request):
    if request.headers.get("Sec-Fetch-Site", "").lower() == "cross-site":
        return False
    origin = request.headers.get("Origin", "").strip()
    if not origin:
        return True
    parsed = urlparse(origin)
    return parsed.scheme in {"http", "https"} and parsed.netloc.lower() == request.host.lower()


def _request_allowed(request):
    supplied = request.headers.get("X-BPI-Token", "")
    return _same_origin(request) and secrets.compare_digest(supplied, _SESSION_TOKEN)


def protected_route(method, path):
    def decorator(handler):
        @wraps(handler)
        async def guarded(request):
            if not _request_allowed(request):
                return error_response("请求未通过双语检查器的本机会话验证", 403)
            try:
                return await handler(request)
            except web.HTTPRequestEntityTooLarge as error:
                return error_response(error.reason or "请求内容过大", 413)

        getattr(PromptServer.instance.routes, method.lower())(path)(guarded)
        return guarded
    return decorator


async def _read_json(request, max_bytes=_MAX_JSON_BYTES):
    length = request.content_length
    if length is not None and length > max_bytes:
        raise ValueError(f"请求内容过大，最大允许 {max_bytes // 1024} KB")
    raw = await request.read()
    if len(raw) > max_bytes:
        raise ValueError(f"请求内容过大，最大允许 {max_bytes // 1024} KB")
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise web.HTTPBadRequest(reason="请求不是有效的 UTF-8 JSON") from error


def _consume_assistant_rate_limit():
    now = time.monotonic()
    while _assistant_requests and now - _assistant_requests[0] >= _ASSISTANT_RATE_WINDOW:
        _assistant_requests.popleft()
    if len(_assistant_requests) >= _ASSISTANT_RATE_LIMIT:
        raise AssistantLimitError("助手请求过于频繁，请稍后再试")
    _assistant_requests.append(now)


def _clean_assistant_result(value):
    text = str(value or "").strip()
    fenced = re.fullmatch(r"```(?:text|plaintext)?\s*([\s\S]*?)\s*```", text, re.IGNORECASE)
    return fenced.group(1).strip() if fenced else text


def _dictionary_explain(text):
    parts = [part.strip() for part in re.split(r"[,，、\r\n]+", str(text or "")) if part.strip()]
    if not parts:
        raise ValueError("待翻译文本为空")
    snapshot = store.snapshot()
    local = {normalize_key(tag["english"]): tag for tag in snapshot["tags"]}
    output = []
    missing = []
    for part in parts:
        weighted = re.fullmatch(r"\((.+):\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\)", part)
        lookup_part = weighted.group(1).strip() if weighted else part
        entry = local.get(normalize_key(lookup_part))
        if not entry:
            matches = store.lookup_large_tags([lookup_part])
            entry = matches[0] if matches else None
        if not entry:
            missing.append(lookup_part)
            continue
        chinese = entry["chinese"]
        output.append(f"({chinese}:{weighted.group(2)})" if weighted else chinese)
    if missing:
        raise ValueError(
            f"纯词库模式暂未收录：{'、'.join(missing[:8])}。可在“词库搜索”查找候选、"
            "手动加入个人词库，或按需配置免费的本地 Ollama / LM Studio。"
        )
    return "，".join(output)


async def _baidu_throttle(qps):
    """按账号 QPS 给百度请求排号；多留 10% 余量，避免边界抖动踩到 54003。"""
    global _baidu_next_slot
    interval = (1.0 / max(float(qps), 0.1)) * 1.1
    async with _baidu_gate:
        now = time.monotonic()
        slot = max(now, _baidu_next_slot)
        _baidu_next_slot = slot + interval
    delay = slot - time.monotonic()
    if delay > 0:
        await asyncio.sleep(delay)


async def _baidu_translate(text, to_lang):
    config = assistant_store.config()
    appid = str(config.get("baidu_appid") or "").strip()
    secret_key = str(config.get("baidu_secret_key") or "").strip()
    if not appid or not secret_key:
        raise ValueError("尚未填写百度翻译的 APP ID 或密钥")
    chunks = baidu_split_query(text)
    if not chunks:
        raise ValueError("待翻译文本为空")
    qps = config.get("baidu_qps") or BAIDU_QPS_DEFAULT
    timeout = ClientTimeout(total=config["ai_timeout_seconds"])
    results = []
    async with ClientSession(timeout=timeout) as session:
        for chunk in chunks:
            await _baidu_throttle(qps)
            params = baidu_translate_params(appid, secret_key, chunk, to_lang)
            async with session.post(BAIDU_TRANSLATE_ENDPOINT, data=params) as response:
                if response.status >= 400:
                    raise ValueError(f"百度翻译请求失败：HTTP {response.status}")
                data = await response.json(content_type=None)
            if not isinstance(data, dict):
                raise ValueError("百度翻译返回了无法解析的内容")
            if data.get("error_code"):
                code = str(data["error_code"])
                message = BAIDU_ERROR_MESSAGES.get(code) or data.get("error_msg") or f"错误码 {code}"
                raise ValueError(f"百度翻译失败：{message}")
            results.append("\n".join(str(item.get("dst", "")) for item in data.get("trans_result") or []))
    result = "\n".join(results).strip()
    if not result:
        raise ValueError("百度翻译没有返回译文")
    return result


async def _call_ai_assistant(action, text, instruction, config, connection_test=False):
    """翻译/优化都走这里。优化类恒走 AI；翻译类在 translate_service=ai 时也走 AI。"""
    if not config.get("ai_model"):
        raise ValueError("尚未填写 AI 模型名称（“翻译并优化”“优化为 Anima”以及 AI 翻译都需要）")
    ai_provider = config["ai_provider"]
    rule = {
        "translate": config["translation_rule"],
        "explain": config["translation_rule"],
        "translate_optimize": config["translate_optimize_rule"],
        "optimize": config["optimization_rule"],
    }[action]
    if connection_test:
        rule = "你是连接测试助手。"
        text = "只回复 OK"
    if not connection_test and action in {"translate", "explain"}:
        direction = "中文或中英混合内容翻译为英文；保留原本正确的英文标签" if translation_direction(text) == "to_english" else "英文翻译为中文"
        if action == "explain":
            direction = "将单个英文标签或英文自然语言片段翻译为简洁、忠实的中文"
        rule = f"{rule}\n\n本次任务方向：{direction}。"
    elif not connection_test and action == "translate_optimize":
        rule = f"{rule}\n\n本次任务：无论输入语言为何，最终必须输出经过优化的英文 Anima 提示词。"
    elif not connection_test and action == "optimize":
        if re.search(r"[\u3400-\u9fff]", text):
            raise ValueError("“优化为 Anima”只接受英文；中文或混合文本请使用“翻译并优化”")
        rule = f"{rule}\n\n本次任务：整理现有英文内容，不承担翻译。"
    if instruction:
        rule = f"{rule}\n\n用户本次附加要求优先遵循：{instruction.strip()}"
    timeout = ClientTimeout(total=config["ai_timeout_seconds"])
    if ai_provider == "ollama":
        base = (config.get("ai_base_url") or "http://127.0.0.1:11434").rstrip("/")
        if base.endswith("/v1"):
            base = base[:-3].rstrip("/")
        endpoint = base if base.endswith("/api/chat") else f"{base}/api/chat"
        payload = {
            "model": config["ai_model"],
            "stream": False,
            "messages": [{"role": "system", "content": rule}, {"role": "user", "content": text}],
            "options": {"temperature": config["ai_temperature"]},
        }
        async with ClientSession(timeout=timeout) as session:
            async with session.post(endpoint, json=payload) as response:
                data = await response.json(content_type=None)
                if response.status >= 400:
                    raise ValueError(data.get("error") or f"Ollama 请求失败：HTTP {response.status}")
        result = data.get("message", {}).get("content")
    else:
        if not config.get("ai_base_url"):
            raise ValueError("尚未填写 OpenAI 兼容 API 地址")
        headers = {"Content-Type": "application/json"}
        if config.get("ai_api_key"):
            headers["Authorization"] = f"Bearer {config['ai_api_key']}"
        payload = {
            "model": config["ai_model"],
            "temperature": config["ai_temperature"],
            "messages": [{"role": "system", "content": rule}, {"role": "user", "content": text}],
        }
        async with ClientSession(timeout=timeout) as session:
            async with session.post(openai_chat_endpoint(config["ai_base_url"]), headers=headers, json=payload) as response:
                data = await response.json(content_type=None)
                if response.status >= 400:
                    detail = data.get("error") if isinstance(data, dict) else None
                    if isinstance(detail, dict):
                        detail = detail.get("message")
                    raise ValueError(detail or f"API 请求失败：HTTP {response.status}")
        choices = data.get("choices") if isinstance(data, dict) else None
        result = choices[0].get("message", {}).get("content") if choices else None
    result = _clean_assistant_result(result)
    if not result:
        raise ValueError("模型没有返回文本结果")
    if len(result) > 50000:
        raise ValueError("模型返回内容异常过长")
    if action in {"translate_optimize", "optimize"}:
        result = sanitize_anima_prompt(result)
    return result


async def _call_configured_assistant(action, text, instruction="", connection_test=False):
    config = assistant_store.config()
    translate_service = config["translate_service"]
    # “翻译并优化”“优化为 Anima”恒走 AI；翻译/解释在 translate_service=ai 时也走 AI
    needs_ai = action in {"translate_optimize", "optimize"} or (
        action in {"translate", "explain"} and translate_service == "ai"
    )
    if needs_ai:
        return await _call_ai_assistant(action, text, instruction, config, connection_test)
    # 以下只处理 translate/explain 且 translate_service != "ai"
    if translate_service == "dictionary":
        if connection_test:
            return "纯词库模式可用"
        return dictionary_translate(text, store) if translation_direction(text) == "to_english" else _dictionary_explain(text)
    if translate_service == "baidu":
        if instruction:
            raise ValueError("百度翻译不支持附加要求，请把要求并入待翻译文本")
        if connection_test:
            await _baidu_translate("连接测试", "en")
            return "百度翻译连接成功"
        to_lang = "zh" if action == "explain" or translation_direction(text) == "to_chinese" else "en"
        return await _baidu_translate(text, to_lang)
    raise ValueError("翻译服务配置异常：请在助手设置里选择词库、百度或 AI")


@PromptServer.instance.routes.get("/bpi/session")
async def get_bpi_session(request):
    if not _same_origin(request):
        return error_response("跨站请求不能创建双语检查器会话", 403)
    return web.json_response(
        {"success": True, "data": {"token": _SESSION_TOKEN}},
        headers={"Cache-Control": "no-store"},
    )


@protected_route("get", "/bpi/assistant/config")
async def get_assistant_config(_request):
    return web.json_response({"success": True, "data": assistant_store.public_config()})


@protected_route("post", "/bpi/assistant/config")
async def save_assistant_config(request):
    try:
        result = assistant_store.update(await _read_json(request, _MAX_ASSISTANT_JSON_BYTES))
        return web.json_response({"success": True, "data": result})
    except (OSError, ValueError, web.HTTPBadRequest) as error:
        return error_response(error)


@protected_route("post", "/bpi/assistant/reset-rules")
async def reset_assistant_rules(_request):
    try:
        return web.json_response({"success": True, "data": assistant_store.reset_rules()})
    except OSError as error:
        return error_response(error, 500)


@protected_route("post", "/bpi/assistant/test")
async def test_assistant_connection(_request):
    try:
        _consume_assistant_rate_limit()
        try:
            await asyncio.wait_for(_assistant_slots.acquire(), timeout=0.25)
        except asyncio.TimeoutError as error:
            raise AssistantLimitError("已有多个助手任务正在运行，请稍后再试") from error
        try:
            result = await _call_configured_assistant("translate", "测试", connection_test=True)
        finally:
            _assistant_slots.release()
        return web.json_response({"success": True, "data": {"message": result}})
    except AssistantLimitError as error:
        return error_response(error, 429)
    except Exception as error:
        return error_response(error)


@protected_route("post", "/bpi/assistant/run")
async def run_assistant(request):
    try:
        payload = await _read_json(request, _MAX_ASSISTANT_JSON_BYTES)
        action = str(payload.get("action", "translate")) if isinstance(payload, dict) else "translate"
        text = str(payload.get("text", "")) if isinstance(payload, dict) else ""
        instruction = str(payload.get("instruction", "")) if isinstance(payload, dict) else ""
        if action not in {"translate", "explain", "translate_optimize", "optimize"}:
            raise ValueError("未知的助手操作")
        if not text.strip():
            raise ValueError("输入内容为空")
        if len(text) > 50000:
            raise ValueError("输入内容过长")
        if len(instruction) > 20000:
            raise ValueError("附加要求过长")
        # 百度翻译有自己的 QPS 节流器（_baidu_throttle），通用的「30 次 / 60 秒」
        # 计数器不再重复计数——否则逐条翻译 30 个标签之后，一分钟内再点一次会被误拦。
        # 只有真正走百度的 translate/explain 才豁免；optimize 恒走 AI，照旧计数。
        goes_to_baidu = assistant_store.config()["translate_service"] == "baidu" and action in {"translate", "explain"}
        if not goes_to_baidu:
            _consume_assistant_rate_limit()
        try:
            await asyncio.wait_for(_assistant_slots.acquire(), timeout=0.25)
        except asyncio.TimeoutError as error:
            raise AssistantLimitError("已有多个助手任务正在运行，请稍后再试") from error
        try:
            result = await _call_configured_assistant(action, text, instruction)
        finally:
            _assistant_slots.release()
        return web.json_response({"success": True, "data": {"text": result, "translate_service": assistant_store.config()["translate_service"]}})
    except AssistantLimitError as error:
        return error_response(error, 429)
    except (ValueError, web.HTTPBadRequest) as error:
        return error_response(error)
    except Exception as error:
        return error_response(error, 502)


@protected_route("get", "/bpi/dictionary")
async def get_dictionary(_request):
    try:
        return web.json_response({"success": True, "data": store.snapshot()})
    except (OSError, ValueError) as error:
        return error_response(error, 500)


# 节点标签卡的颜色配置：用户可以直接编辑 data/token_colors.json 增删色块，
# 不用改源码。文件不在或格式不对时回退内置默认，不影响功能。
_DEFAULT_TOKEN_COLORS = {
    "presets": ["#6b9b78", "#9b8b6b", "#6b7b9b", "#9b6b8b", "#8b9b6b", "#6b9b9b", "#9b7b6b", "#7b6b9b"],
    "random_pool": ["#5b8a72", "#8a725b", "#5b6e8a", "#8a5b7a", "#7a8a5b", "#5b8a8a", "#8a6b5b", "#6b5b8a"],
}


@protected_route("get", "/bpi/token-colors")
async def get_token_colors(_request):
    from pathlib import Path
    path = Path(__file__).resolve().parent / "data" / "token_colors.json"
    try:
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict) and isinstance(data.get("presets"), list) and isinstance(data.get("random_pool"), list):
                return web.json_response({"success": True, "data": data})
    except (OSError, ValueError):
        pass
    return web.json_response({"success": True, "data": _DEFAULT_TOKEN_COLORS})


@protected_route("post", "/bpi/large/lookup")
async def lookup_large_dictionary(request):
    try:
        payload = await _read_json(request)
        terms = payload.get("terms", []) if isinstance(payload, dict) else []
        return web.json_response({"success": True, "data": store.lookup_large_tags(terms)})
    except (ValueError, web.HTTPBadRequest) as error:
        return error_response(error)
    except (OSError, sqlite3.Error) as error:
        return error_response(error, 500)


@protected_route("get", "/bpi/large/search")
async def search_large_dictionary(request):
    try:
        query = request.query.get("q", "")
        limit = request.query.get("limit", "40")
        offset = request.query.get("offset", "0")
        return web.json_response({
            "success": True,
            "data": store.search_large_tags_page(query, limit=limit, offset=offset),
        })
    except ValueError as error:
        return error_response(error)
    except (OSError, sqlite3.Error) as error:
        return error_response(error, 500)


@protected_route("post", "/bpi/large/enabled")
async def set_large_dictionary_enabled(request):
    try:
        payload = await _read_json(request)
        if not isinstance(payload, dict) or "enabled" not in payload:
            raise ValueError("缺少 enabled 字段")
        result = store.set_large_dictionary_enabled(payload["enabled"])
        return web.json_response({"success": True, "data": result})
    except (ValueError, web.HTTPBadRequest) as error:
        return error_response(error)
    except OSError as error:
        return error_response(error, 500)


@protected_route("post", "/bpi/tags")
async def save_tag(request):
    try:
        value = await _read_json(request)
        tag, replaced = store.upsert(value)
        return web.json_response({"success": True, "data": tag, "replaced": replaced})
    except (ValueError, web.HTTPBadRequest) as error:
        return error_response(error)
    except OSError as error:
        return error_response(error, 500)


@protected_route("delete", "/bpi/tags/{english}")
async def delete_tag(request):
    try:
        deleted = store.delete(request.match_info["english"])
        return web.json_response({"success": True, "deleted": deleted})
    except (OSError, ValueError) as error:
        return error_response(error, 500)


@protected_route("get", "/bpi/export")
async def export_dictionary(_request):
    try:
        snapshot = store.snapshot()
        return web.json_response({"schema_version": snapshot["schema_version"], "tags": snapshot["user"]})
    except (OSError, ValueError) as error:
        return error_response(error, 500)


@protected_route("post", "/bpi/import")
async def import_dictionary(request):
    try:
        payload = await _read_json(request)
        values = payload.get("tags", []) if isinstance(payload, dict) else []
        mode = payload.get("mode", "overwrite") if isinstance(payload, dict) else "overwrite"
        result = store.import_tags(values, mode=mode)
        return web.json_response({"success": True, "data": result})
    except (ValueError, web.HTTPBadRequest) as error:
        return error_response(error)
    except OSError as error:
        return error_response(error, 500)


@protected_route("post", "/bpi/tags/bulk-update")
async def bulk_update_tags(request):
    try:
        payload = await _read_json(request)
        english_values = payload.get("english", []) if isinstance(payload, dict) else []
        updates = payload.get("updates", {}) if isinstance(payload, dict) else {}
        result = store.update_many(english_values, updates)
        return web.json_response({"success": True, "data": result})
    except (ValueError, web.HTTPBadRequest) as error:
        return error_response(error)
    except OSError as error:
        return error_response(error, 500)


@protected_route("post", "/bpi/packs/import")
async def import_dictionary_pack(request):
    try:
        payload = await _read_json(request)
        overwrite = bool(payload.get("overwrite", False)) if isinstance(payload, dict) else False
        pack_payload = payload.get("payload", payload) if isinstance(payload, dict) else payload
        result = store.import_pack(pack_payload, overwrite=overwrite)
        return web.json_response({"success": True, "data": result})
    except (ValueError, web.HTTPBadRequest) as error:
        return error_response(error)
    except OSError as error:
        return error_response(error, 500)


@protected_route("post", "/bpi/packs/{pack_id}/enabled")
async def set_dictionary_pack_enabled(request):
    try:
        payload = await _read_json(request)
        if not isinstance(payload, dict) or "enabled" not in payload:
            raise ValueError("缺少 enabled 字段")
        result = store.set_pack_enabled(request.match_info["pack_id"], payload["enabled"])
        return web.json_response({"success": True, "data": result})
    except (ValueError, web.HTTPBadRequest) as error:
        return error_response(error)
    except OSError as error:
        return error_response(error, 500)


@protected_route("get", "/bpi/packs/{pack_id}/export")
async def export_dictionary_pack(request):
    try:
        return web.json_response(store.export_pack(request.match_info["pack_id"]))
    except ValueError as error:
        return error_response(error, 404)
    except OSError as error:
        return error_response(error, 500)


@protected_route("delete", "/bpi/packs/{pack_id}")
async def delete_dictionary_pack(request):
    try:
        result = store.delete_pack(request.match_info["pack_id"])
        return web.json_response({"success": True, "data": result})
    except ValueError as error:
        return error_response(error)
    except OSError as error:
        return error_response(error, 500)


# ---------------------------------------------------------------------------
# 上游输入门
#
# 节点接到上游 STRING 时不直接放行，而是把文本交给前端，然后挂起等待确认。
# 挂起靠 async 节点函数：只要协程不返回，执行器就会把该节点标为 pending
# 并阻塞下游（execution.py 的 pending_async_nodes）。future 由下面的本地路由
# 唤醒，唤醒发生在主线程（aiohttp），所以一律走 call_soon_threadsafe。
# ---------------------------------------------------------------------------

UPSTREAM_ARRIVED_EVENT = "bpi/upstream-arrived"
# 前端没有接管时（无浏览器、API 调用）的兜底时限，超时后按透传放行
_UPSTREAM_HANDOFF_TIMEOUT = 20.0
# 前端已接管后的最长等待，避免挂起的任务永久占用执行线程
_UPSTREAM_WAIT_TIMEOUT = 3600.0
_UPSTREAM_POLL_INTERVAL = 0.5


class UpstreamGate:
    """按节点 id 保存一次挂起，future 只能被本地路由唤醒。"""

    def __init__(self, handoff_timeout=_UPSTREAM_HANDOFF_TIMEOUT, wait_timeout=_UPSTREAM_WAIT_TIMEOUT):
        self.handoff_timeout = handoff_timeout
        self.wait_timeout = wait_timeout
        self.pending = {}

    def open(self, node_id, prompt_id, text):
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        self.pending[node_id] = {
            "future": future,
            "loop": loop,
            "prompt_id": prompt_id,
            "text": text,
            "deadline": time.monotonic() + self.handoff_timeout,
        }
        return future

    def _entry(self, node_id, prompt_id):
        entry = self.pending.get(node_id)
        if entry is None:
            return None
        if prompt_id and entry["prompt_id"] and entry["prompt_id"] != prompt_id:
            return None
        return entry

    def ack(self, node_id, prompt_id=None):
        """前端已接管，把时限放宽到等待用户确认。"""
        entry = self._entry(node_id, prompt_id)
        if entry is None:
            return False
        entry["deadline"] = time.monotonic() + self.wait_timeout
        return True

    def release(self, node_id, prompt_id=None, text=None, cancelled=False):
        entry = self._entry(node_id, prompt_id)
        if entry is None:
            return False
        del self.pending[node_id]
        future = entry["future"]
        upstream_text = entry["text"]
        result = text if isinstance(text, str) else upstream_text

        def resolve():
            if future.done():
                return
            if cancelled:
                future.set_exception(model_management.InterruptProcessingException())
            else:
                future.set_result(result)

        entry["loop"].call_soon_threadsafe(resolve)
        return True

    def drop(self, node_id):
        entry = self.pending.pop(node_id, None)
        if entry is None:
            return
        future = entry["future"]

        def resolve():
            if not future.done():
                future.set_result(None)

        entry["loop"].call_soon_threadsafe(resolve)

    async def wait(self, node_id, future):
        """等到前端放行；返回 None 表示无人接管，调用方按透传处理。"""
        while True:
            if model_management.processing_interrupted():
                self.drop(node_id)
                raise model_management.InterruptProcessingException()
            entry = self.pending.get(node_id)
            if entry is None:
                return None
            remaining = entry["deadline"] - time.monotonic()
            if remaining <= 0:
                self.drop(node_id)
                return None
            try:
                return await asyncio.wait_for(
                    asyncio.shield(future), timeout=min(remaining, _UPSTREAM_POLL_INTERVAL)
                )
            except asyncio.TimeoutError:
                continue


upstream_gate = UpstreamGate()


def current_prompt_id():
    try:
        from comfy_execution.utils import get_executing_context

        context = get_executing_context()
    except Exception:
        return None
    return getattr(context, "prompt_id", None)


def announce_upstream(node_id, text):
    PromptServer.instance.send_sync(UPSTREAM_ARRIVED_EVENT, {"node_id": node_id, "text": text})


async def _read_node_payload(request):
    payload = await _read_json(request)
    return str(payload.get("node_id") or ""), payload.get("prompt_id"), payload.get("text")


@protected_route("post", "/bpi/upstream/ack")
async def ack_upstream(request):
    node_id, prompt_id, _ = await _read_node_payload(request)
    return web.json_response({"success": upstream_gate.ack(node_id, prompt_id)})


@protected_route("post", "/bpi/upstream/resume")
async def resume_upstream(request):
    node_id, prompt_id, text = await _read_node_payload(request)
    success = upstream_gate.release(node_id, prompt_id, text=text)
    return web.json_response({"success": success})


@protected_route("post", "/bpi/upstream/cancel")
async def cancel_upstream(request):
    node_id, prompt_id, _ = await _read_node_payload(request)
    success = upstream_gate.release(node_id, prompt_id, cancelled=True)
    return web.json_response({"success": success})


# ---------------------------------------------------------------------------
# 收藏的提示词：元数据与配图都在 ComfyUI 用户目录，插件仓库不携带。
# ---------------------------------------------------------------------------

saved_prompt_store = SavedPromptStore()
# multipart 正文 = 文本字段 + 一张可选图片（图片本身最大 5 MB）
_MAX_SAVED_PROMPT_BYTES = MAX_IMAGE_BYTES + 512 * 1024


@protected_route("get", "/bpi/saved-prompts")
async def list_saved_prompts(_request):
    return web.json_response({"success": True, "data": saved_prompt_store.list_prompts()})


@protected_route("post", "/bpi/saved-prompts")
async def create_saved_prompt(request):
    if request.content_length is not None and request.content_length > _MAX_SAVED_PROMPT_BYTES:
        return error_response("收藏内容过大（图片最大 5 MB）", 413)
    name = text = note = None
    image_bytes = None
    try:
        reader = await request.multipart()
        async for part in reader:
            if part.name == "image":
                image_bytes = await part.read(decode=False)
            elif part.name == "name":
                name = await part.text()
            elif part.name == "text":
                text = await part.text()
            elif part.name == "note":
                note = await part.text()
    except (ValueError, web.HTTPException) as error:
        return error_response(f"读取表单失败：{error}")
    try:
        entry = saved_prompt_store.create_prompt(name, text, note=note, image_bytes=image_bytes)
        return web.json_response({"success": True, "data": entry})
    except ValueError as error:
        return error_response(error)


@protected_route("delete", "/bpi/saved-prompts/{prompt_id}")
async def delete_saved_prompt(request):
    try:
        remaining = saved_prompt_store.delete_prompt(request.match_info["prompt_id"])
        return web.json_response({"success": True, "data": {"remaining": remaining}})
    except ValueError as error:
        return error_response(error, 404)


# 图片用 <img> 加载，自定义请求头带不进去，所以这里只做同源检查、不走会话令牌。
@PromptServer.instance.routes.get("/bpi/saved-prompts/{prompt_id}/image")
async def saved_prompt_image(request):
    if not _same_origin(request):
        return error_response("拒绝跨源请求", 403)
    try:
        path = saved_prompt_store.image_path(request.match_info["prompt_id"])
    except ValueError as error:
        return error_response(error, 404)
    return web.FileResponse(path, headers={"Cache-Control": "private, max-age=3600"})


@protected_route("get", "/bpi/saved-prompts/export")
async def export_saved_prompts(_request):
    return web.json_response({"success": True, "data": saved_prompt_store.export_bundle()})


@protected_route("post", "/bpi/saved-prompts/import")
async def import_saved_prompts(request):
    try:
        payload = await _read_json(request)
        result = saved_prompt_store.import_bundle(payload)
        return web.json_response({"success": True, "data": result})
    except ValueError as error:
        return error_response(error)

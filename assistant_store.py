import json
import hashlib
import os
import re
import secrets
import tempfile
from ipaddress import ip_address
from pathlib import Path
from urllib.parse import urlparse


LEGACY_DEFAULT_TRANSLATION_RULE = """你是 Anima 模型的双语提示词翻译器。把用户输入忠实转换为英文，不得解释、评价或使用 Markdown。
如果输入是逗号分隔的中文标签，优先输出准确的 Danbooru/Anima 英文标签并保持逗号结构；如果输入是自然语言，则输出忠实流畅的英文自然语言。
保留人物数量、角色名、作品名、画师 @ 前缀、权重、否定关系和用户明确要求。不得擅自增加人物、服装、动作、背景或成人内容。
只返回可直接写入 ComfyUI 文本框的英文提示词。"""

V17_DEFAULT_TRANSLATION_RULE = """你是双语提示词忠实翻译器，只执行翻译，不扩写、不优化、不评价，也不输出 Markdown、标题、引号、解释、警告或免责声明。
根据本次任务给出的方向转换中文、英文或中英混合输入：中文或混合输入转英文时，保留已经正确的英文标签；纯英文转中文时，逐项准确解释标签，并把完整自然语言忠实译成中文。
严格保留人物数量、成年人身份、角色名、作品名、画师 @ 前缀、标签顺序、括号权重、LoRA 语法、否定关系、左右位置、动作、服装、身体特征、场景和安全等级。不得擅自增加、删除、弱化或改写内容。
对于明确为成年人的合法成人内容，按原文忠实处理相关身体、服装、姿势、关系和成人标签，不回避、不含糊替换，也不主动增加原文没有的成人内容；不得将未成年人或年龄不明确的人物成人化。
标签优先采用准确的 Danbooru/Anima 常用写法；自然语言保持自然、明确。只返回翻译结果。"""

DEFAULT_TRANSLATION_RULE = V17_DEFAULT_TRANSLATION_RULE + """
输入是单个标签时只返回一个对应词；输入是自然语言句子或段落时必须保持自然语言形式，不要改写成逗号分隔的标签列表。自然语言译文可以按语法正常使用逗号，不受原文逗号数量限制。
对于明确成年内容中的身体解剖词汇，应使用准确、直接的医学或通用对应词，不使用含糊代称，也不要额外列出多个同义标签。"""

DEFAULT_TRANSLATE_OPTIMIZE_RULE = """你是 Anima 模型提示词翻译与优化器。理解中文、英文或中英混合输入，将其转换为一份可直接用于 Anima 的英文提示词；只返回最终结果，不输出 Markdown、标题、引号、解释、警告或免责声明。
先忠实翻译，再在不改变原意的前提下消除重复和明显冲突，选用准确的 Danbooru/Anima 标签，并按以下顺序组织：质量/元数据/年份/安全，人数，角色，作品/系列，画师，外观，其他标签（表情、动作、姿势、镜头），环境，末尾自然语言描述。
严格保留人物数量、成年人身份、角色名、作品名、画师 @ 前缀、括号权重、LoRA 语法、否定关系、左右位置、动作、服装、身体特征、互动关系、背景和用户明确限制，不得擅自换人、增加人物或改变主题。
对于明确为成年人的合法成人内容，准确保留并规范相关成人标签，不弱化、不含糊替换，也不主动增加原文没有的成人内容；不得将未成年人或年龄不明确的人物成人化。
标签使用英文逗号分隔；需要自然语言补充时，只在标签之后使用英文句点分隔。仅使用 Anima 支持的英文标点和语法：逗号、句点、圆括号与冒号权重、@ 画师前缀、下划线、连字符、撇号、百分号，以及尖括号 LoRA 语法。"""

LEGACY_DEFAULT_EXPLANATION_RULE = """你是 Anima/Danbooru 英文标签解释器。把用户提供的单个英文标签忠实翻译成简短中文，不得扩写成多个标签，不得增加权重、括号、示例或解释前缀。
角色名、作品名、摄影术语和成人标签应准确直译；无法可靠翻译时保持专有名词并给出最短中文说明。
只返回对应的中文词语。"""

LEGACY_DEFAULT_OPTIMIZATION_RULE = """你是 Anima 模型提示词优化器。理解用户的中文意图，输出可直接用于 Anima 的英文提示词，不得解释或使用 Markdown。
优先使用准确、简洁、无冲突的 Danbooru/Anima 标签；需要补充氛围和细节时，可以在标签末尾增加一段以英文句点开头的自然语言描述。
严格保持用户指定的人物、身份、数量、左右位置、动作、服装、安全等级和否定要求，不得擅自改变主题。
建议按以下顺序组织：质量/元数据/年份/安全，人数，角色，作品/系列，画师，外观，表情/动作/姿势等其他标签，环境，自然语言描述。
只返回最终英文提示词。"""

DEFAULT_OPTIMIZATION_RULE = """你是 Anima 模型英文提示词优化器。输入应当已经是英文；只进行 Anima 格式整理、去重、冲突检查、标签规范化和必要的表达优化，不承担中译英。只返回最终结果，不输出 Markdown、标题、引号、解释、警告或免责声明。
按以下顺序组织：质量/元数据/年份/安全，人数，角色，作品/系列，画师，外观，其他标签（表情、动作、姿势、镜头），环境，末尾自然语言描述。
严格保留人物数量、成年人身份、角色名、作品名、画师 @ 前缀、括号权重、LoRA 语法、否定关系、左右位置、动作、服装、身体特征、互动关系、背景和用户明确限制，不得擅自换人、增加人物或改变主题。
对于明确为成年人的合法成人内容，准确保留并规范相关成人标签，不弱化、不含糊替换，也不主动增加原文没有的成人内容；不得将未成年人或年龄不明确的人物成人化。
标签使用英文逗号分隔；自然语言只放在末尾并使用英文句点分隔。仅使用 Anima 支持的英文标点和语法：逗号、句点、圆括号与冒号权重、@ 画师前缀、下划线、连字符、撇号、百分号，以及尖括号 LoRA 语法。"""

DEFAULT_CONFIG = {
    "schema_version": 4,
    # 翻译/解释走哪个服务；OpenAI 兼容与 Ollama 本身就是两个平级选项
    "translate_service": "dictionary",  # dictionary | baidu | openai_compatible | ollama
    # 选词库/百度时翻译不走 AI，但「翻译并优化」「优化为 Anima」恒走 AI —— 这时用它决定读哪一套
    "ai_provider": "openai_compatible",  # openai_compatible | ollama
    # OpenAI 兼容：远端必须 https，本机回环 http 也放行（本地 LM Studio 之类）
    "openai_base_url": "",
    "openai_model": "",
    "openai_api_key": "",
    "openai_temperature": 0.2,
    "openai_timeout_seconds": 90,
    # Ollama：只允许本机回环地址，没有密钥
    "ollama_base_url": "http://127.0.0.1:11434",
    "ollama_model": "",
    "ollama_temperature": 0.2,
    "ollama_timeout_seconds": 90,
    # 百度翻译独立配置，不随翻译服务切换而清空
    "baidu_appid": "",
    "baidu_secret_key": "",
    # 百度账号的 QPS 上限：未认证/标准版 1，个人认证 10，企业认证更高。
    # 后端按它给百度请求排队，避免触发 54003「请求过于频繁」
    "baidu_qps": 1.0,
    "appearance": "auto",  # auto | dark | light
    # 插件面板自己的界面语言：auto 跟随 ComfyUI 的 Comfy.Locale，zh / en 强制指定
    "language": "auto",  # auto | zh | en
    # 每个后端一套规则：本地小模型和云端大模型要写的提示词不一样
    "openai_translation_rule": DEFAULT_TRANSLATION_RULE,
    "openai_translate_optimize_rule": DEFAULT_TRANSLATE_OPTIMIZE_RULE,
    "openai_optimization_rule": DEFAULT_OPTIMIZATION_RULE,
    "ollama_translation_rule": DEFAULT_TRANSLATION_RULE,
    "ollama_translate_optimize_rule": DEFAULT_TRANSLATE_OPTIMIZE_RULE,
    "ollama_optimization_rule": DEFAULT_OPTIMIZATION_RULE,
}

# 规则按后端分成两套，遍历时统一用这两个前缀
AI_PROVIDER_PREFIXES = {"openai_compatible": "openai", "ollama": "ollama"}
# translate_service 里属于 AI 的两个值，与 ai_provider 共用同一套前缀
AI_SERVICES = frozenset(AI_PROVIDER_PREFIXES)
TRANSLATE_SERVICES = frozenset({"dictionary", "baidu"}) | AI_SERVICES
RULE_KEYS = ("translation_rule", "translate_optimize_rule", "optimization_rule")

BAIDU_TRANSLATE_ENDPOINT = "https://fanyi-api.baidu.com/api/trans/vip/translate"

# 百度「通用文本翻译」按账号档位给 QPS：标准版 1 QPS，个人认证 10 QPS，企业认证更高。
# 后端按这个值给百度请求排队；填高了会被百度报 54003，填低了只是慢一点。
BAIDU_QPS_DEFAULT = 1.0
BAIDU_QPS_MIN = 0.1
BAIDU_QPS_MAX = 50.0
# 百度单块最多 600 字，90 秒与原默认值一致（AI 拆成两套后不再借用它的超时）
BAIDU_TIMEOUT_SECONDS = 90


def normalize_baidu_qps(value):
    """把用户填的 QPS 收敛成合法数字；非数字一律拒绝，不静默回退。"""
    if value is None or isinstance(value, bool) or str(value).strip() == "":
        return BAIDU_QPS_DEFAULT
    try:
        qps = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError("百度 QPS 必须是数字") from error
    if qps != qps or qps in (float("inf"), float("-inf")):
        raise ValueError("百度 QPS 必须是数字")
    return min(max(qps, BAIDU_QPS_MIN), BAIDU_QPS_MAX)

BAIDU_ERROR_MESSAGES = {
    "52001": "请求超时，请重试",
    "52002": "百度翻译系统错误，请稍后重试",
    "52003": "未授权用户，请检查 APP ID 是否正确",
    "54000": "必填参数缺失，请检查 APP ID 与密钥",
    "54001": "签名错误，请检查密钥是否正确",
    "54003": "请求过于频繁，请稍后重试",
    "54004": "账户余额不足或免费额度已用尽",
    "54005": "单次请求文本过长",
    "58002": "翻译服务已被关闭，请在百度智能云控制台开启",
    "90107": "当前接口需要开通高级版",
}


def translation_direction(text):
    return "to_english" if re.search(r"[\u3400-\u9fff]", str(text or "")) else "to_chinese"


def is_loopback_host(hostname):
    """只允许真正的回环地址：127.0.0.0/8、::1、localhost。

    比「私有网段」窄得多 —— 私有网段里还有路由器、NAS、同事的机器，
    SSRF 正是靠它们横向探测，所以这里一律不放行。
    """
    host = str(hostname or "").strip().lower().rstrip(".")
    if host in {"localhost", "127.0.0.1", "::1"}:
        return True
    try:
        return ip_address(host).is_loopback
    except ValueError:
        return False


def is_public_address(hostname):
    """主机名直接写成 IP 时，只放行公网地址；域名不做解析，一律放行。

    挡的是 https://192.168.x.x、https://10.x.x.x、https://169.254.169.254（云元数据）这类
    「虽然是 https、但仍然指向内网」的直连写法。
    """
    try:
        return ip_address(hostname).is_global
    except ValueError:
        return True


def normalize_ai_base_url(value, *, allow_remote=False):
    """校验 AI 地址，返回去掉尾斜杠的原文；不合规直接抛错，不发请求。

    allow_remote=False（Ollama）：只能是本机回环地址。
    allow_remote=True（OpenAI 兼容）：https 一律放行，http 只放行本机回环。
    """
    base = str(value or "").strip().rstrip("/")
    if not base:
        return ""
    parsed = urlparse(base)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("API 地址必须是完整的 http:// 或 https:// 地址")
    if parsed.username or parsed.password:
        raise ValueError("API 地址中不能包含用户名或密码")
    if parsed.query or parsed.fragment:
        raise ValueError("API 地址中不能包含查询参数或片段")
    loopback = is_loopback_host(parsed.hostname)
    if not allow_remote and not loopback:
        raise ValueError("Ollama 地址只能是本机地址（127.0.0.1 / localhost / ::1）")
    if parsed.scheme == "http" and not loopback:
        raise ValueError("非本机 API 地址必须使用 HTTPS，避免密钥明文传输")
    if allow_remote and not loopback and not is_public_address(parsed.hostname):
        raise ValueError("远端 API 地址不能是内网、保留或链路本地地址")
    return base


def openai_chat_endpoint(base_url):
    """Return a chat-completions endpoint for an OpenAI-compatible base URL."""
    base = str(base_url or "").strip().rstrip("/")
    if not base:
        return ""
    if base.endswith("/chat/completions"):
        return base
    parsed = urlparse(base)
    path = parsed.path.rstrip("/")
    if not path and parsed.hostname in {"127.0.0.1", "localhost"} and parsed.port == 1234:
        return f"{base}/v1/chat/completions"
    return f"{base}/chat/completions"


def baidu_translate_params(appid, secret_key, query, to_lang, from_lang="auto", salt=None):
    """组装百度通用文本翻译接口参数；sign = MD5(appid + q + salt + 密钥)。"""
    appid = str(appid or "")
    secret_key = str(secret_key or "")
    salt = str(salt if salt is not None else secrets.token_hex(8))
    sign = hashlib.md5(f"{appid}{query}{salt}{secret_key}".encode("utf-8")).hexdigest()
    return {"q": query, "from": from_lang, "to": to_lang, "appid": appid, "salt": salt, "sign": sign}


def baidu_split_query(text, max_chars=600, max_lines=30):
    """把待翻译文本拆成接口可接受的分块：按行切分，超长行在逗号处断开。"""
    lines = [line for line in str(text or "").replace("\r\n", "\n").split("\n") if line.strip()]
    prepared = []
    for line in lines:
        while len(line) > max_chars:
            cut = max(line.rfind(",", 0, max_chars), line.rfind("，", 0, max_chars))
            if cut <= 0:
                cut = max_chars
            prepared.append(line[:cut])
            line = line[cut:]
        prepared.append(line)
    chunks, current, size = [], [], 0
    for line in prepared:
        if current and (size + len(line) + 1 > max_chars or len(current) >= max_lines):
            chunks.append("\n".join(current))
            current, size = [], 0
        current.append(line)
        size += len(line) + 1
    if current:
        chunks.append("\n".join(current))
    return chunks


# 权重的句点只出现在「冒号后的小数」里：(tag:1.2)、[tag:1.2]、<lora:name:0.8>。
# 断句用的句点则是「词 + 句点 + 空白」，形态完全不同，所以先把权重片段整段挑出来保护。
WEIGHT_FRAGMENT = re.compile(r"[(\[<][^\n]*?:\s*-?\d+(?:\.\d+)?\s*[)\]>]")


def replace_sentence_periods(text):
    """把权重之外的句点换成逗号。

    模型按规则会用句点把末尾自然语言接在标签后面，但那会让整串标签被前端当成自然语言段。
    权重片段整段跳过，片段外再要求句点前后都不是数字，双保险。
    """
    def to_commas(segment):
        return re.sub(r"(?<!\d)\s*\.\s*(?!\d)", ", ", segment)

    parts = []
    cursor = 0
    for match in WEIGHT_FRAGMENT.finditer(text):
        parts.append(to_commas(text[cursor:match.start()]))
        parts.append(match.group(0))
        cursor = match.end()
    parts.append(to_commas(text[cursor:]))
    return "".join(parts)


def sanitize_anima_prompt(value):
    text = str(value or "").strip()
    fenced = re.fullmatch(r"```(?:text|plaintext)?\s*([\s\S]*?)\s*```", text, re.IGNORECASE)
    text = fenced.group(1).strip() if fenced else text
    replacements = {
        "，": ",", "、": ",", "；": ",", ";": ",", "。": ".",
        "！": ".", "!": ".", "？": ".", "?": ".", "：": ":",
        "（": "(", "）": ")", "＜": "<", "＞": ">", "—": "-", "–": "-", "…": ".",
        "“": "", "”": "", "＂": "", "‘": "'", "’": "'", "＇": "'", '"': "", "`": "",
    }
    for source, target in replacements.items():
        text = text.replace(source, target)
    # 模型常把结果写成 JSON 或代码字符串，留下 \" \n 这类转义；先把字面换行/制表还原成换行，
    # 再去掉其余孤立反斜杠，否则一个转义符就会让整条提示词判废。
    text = re.sub(r"\\+[nrt]", "\n", text)
    text = text.replace("\\", "")
    text = re.sub(r"(?m)^\s*(?:[-*•]+|\d+[.)])\s*", "", text)
    text = re.sub(r"[\r\n]+", ", ", text)
    text = re.sub(r"\s*,\s*", ", ", text)
    text = replace_sentence_periods(text)
    text = re.sub(r",(?:\s*,)+", ",", text)
    text = re.sub(r"\s+", " ", text).strip(" ,")
    # 模型常在结果末尾多留一个句点。规则里的句点是用来分隔末尾自然语言的，后面没有内容时
    # 它没有意义，却会让前端把整串标签误判成自然语言段落，所以直接去掉。
    text = re.sub(r"\s*[.]+\s*$", "", text)
    if re.search(r"[\u3400-\u9fff]", text):
        raise ValueError("助手返回的 Anima 提示词仍包含中文，请调整规则后重试")
    allowed_punctuation = set(",.():@_-'<>%+/&")
    invalid = sorted({char for char in text if not (char.isalnum() or char.isspace() or char in allowed_punctuation)})
    if invalid:
        raise ValueError(f"助手返回了不符合 Anima 规则的标点：{' '.join(invalid)}")
    if not text:
        raise ValueError("助手返回的 Anima 提示词为空")
    return text


def _default_config_dir():
    try:
        import folder_paths
        return Path(folder_paths.get_user_directory()) / "bilingual-prompt-inspector"
    except (ImportError, AttributeError, TypeError):
        return Path(__file__).resolve().parent / "data" / "user_config"


class AssistantStore:
    def __init__(self, config_dir=None, install_id_path=None):
        custom_config_dir = config_dir is not None
        self.config_dir = Path(config_dir or _default_config_dir())
        self.config_path = self.config_dir / "assistant_settings.json"
        default_install_id_path = (
            self.config_dir / ".installation_id"
            if custom_config_dir
            else Path(__file__).resolve().parent / "data" / "runtime" / "installation_id"
        )
        self.install_id_path = Path(install_id_path or default_install_id_path)
        self.installation_id = self._load_or_create_installation_id()

    @staticmethod
    def _write_json_atomic(path, payload):
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temp_name = tempfile.mkstemp(prefix="assistant_settings_", suffix=".json", dir=path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
            os.replace(temp_name, path)
            try:
                os.chmod(path, 0o600)
            except OSError:
                pass
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)

    def _load_or_create_installation_id(self):
        try:
            if self.install_id_path.exists():
                value = self.install_id_path.read_text(encoding="utf-8").strip()
                if re.fullmatch(r"[A-Za-z0-9_-]{32,128}", value):
                    return value
        except OSError:
            pass
        value = secrets.token_urlsafe(32)
        self.install_id_path.parent.mkdir(parents=True, exist_ok=True)
        fd, temp_name = tempfile.mkstemp(prefix="installation_", suffix=".tmp", dir=self.install_id_path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(value)
            os.replace(temp_name, self.install_id_path)
            try:
                os.chmod(self.install_id_path, 0o600)
            except OSError:
                pass
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)
        return value

    @staticmethod
    def _normalize_base_url(value):
        return str(value or "").strip().rstrip("/")

    @classmethod
    def _credential_binding(cls, provider, base_url):
        identity = f"{str(provider or '').strip().lower()}\0{cls._normalize_base_url(base_url)}"
        return hashlib.sha256(identity.encode("utf-8")).hexdigest()

    def _default_persisted_config(self):
        return {
            **DEFAULT_CONFIG,
            "installation_id": self.installation_id,
            "openai_credential_binding": "",
            "baidu_credential_binding": "",
        }

    @staticmethod
    def _migrate_v2(value):
        """旧 schema（单一 provider）→ v3（翻译服务 + 独立 AI/百度槽）。"""
        if value.get("schema_version", 0) >= 3:
            return value
        old_provider = str(value.get("provider", "dictionary")).strip().lower()
        if old_provider in ("openai_compatible", "ollama"):
            value["translate_service"] = "ai"
            value.setdefault("ai_provider", old_provider)
        elif old_provider == "baidu":
            value["translate_service"] = "baidu"
            value.setdefault("ai_provider", "openai_compatible")
        else:
            value["translate_service"] = "dictionary"
            value.setdefault("ai_provider", "openai_compatible")
        # 旧的 base_url/model/api_key/temperature/timeout_seconds 搬到 ai_* 槽
        value.setdefault("ai_base_url", value.get("base_url", ""))
        value.setdefault("ai_model", value.get("model", ""))
        value.setdefault("ai_api_key", value.get("api_key", ""))
        value.setdefault("ai_temperature", value.get("temperature", 0.2))
        value.setdefault("ai_timeout_seconds", value.get("timeout_seconds", 90))
        # 旧 credential_binding 改名 ai_credential_binding（语义一致：绑 AI 后端+地址）
        value.setdefault("ai_credential_binding", value.get("credential_binding", ""))
        value.setdefault("baidu_credential_binding", value.get("baidu_credential_binding", ""))
        value["schema_version"] = 3
        return value

    @classmethod
    def _migrate_v3(cls, value):
        """v3（AI 单槽）→ v4（OpenAI / Ollama 两套独立配置）。

        旧的单槽值整份搬到「当前所选后端」那套，另一套留默认；
        规则原本不分后端，两套都继承，之后可以各自改。
        """
        if value.get("schema_version", 0) >= 4:
            return value
        provider = str(value.get("ai_provider", "openai_compatible")).strip().lower()
        prefix = AI_PROVIDER_PREFIXES.get(provider, "openai")
        for source, target in (
            ("ai_base_url", "base_url"),
            ("ai_model", "model"),
            ("ai_temperature", "temperature"),
            ("ai_timeout_seconds", "timeout_seconds"),
        ):
            if str(value.get(source) or "").strip() != "":
                value[f"{prefix}_{target}"] = value[source]
        if prefix == "openai" and str(value.get("ai_api_key") or "").strip():
            value["openai_api_key"] = value["ai_api_key"]
            # 绑定的 provider 标记从 openai_compatible 变成 openai，旧值必然对不上；
            # 直接按新前缀重算，否则密钥会被当成「换了地址」清掉
            value["openai_credential_binding"] = cls._credential_binding("openai", value.get("openai_base_url", ""))
        for rule in RULE_KEYS:
            existing = str(value.get(rule) or "").strip()
            if existing:
                for target in ("openai", "ollama"):
                    value.setdefault(f"{target}_{rule}", existing)
        for key in ("ai_base_url", "ai_model", "ai_temperature", "ai_timeout_seconds", "ai_api_key", "ai_credential_binding"):
            value.pop(key, None)
        value["schema_version"] = 4
        return value

    def config(self):
        value = {}
        should_rewrite = False
        if self.config_path.exists():
            try:
                loaded = json.loads(self.config_path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    value = loaded
            except (OSError, ValueError):
                value = {}
        if value and value.get("installation_id") != self.installation_id:
            value = self._default_persisted_config()
            should_rewrite = True
        if value and value.get("schema_version", 0) < 3:
            value = self._migrate_v2(value)
            should_rewrite = True
        if value and value.get("schema_version", 0) < 4:
            value = self._migrate_v3(value)
            should_rewrite = True
        # 旧值 "ai" 已拆成两个平级服务：按当时的后端落到 openai_compatible / ollama
        if value and value.get("translate_service") == "ai":
            provider = str(value.get("ai_provider") or "openai_compatible").strip().lower()
            value["translate_service"] = provider if provider in AI_SERVICES else "openai_compatible"
            should_rewrite = True
        # 旧版默认规则已废弃：两套各查一次，命中就换成现在的默认
        for prefix in ("openai", "ollama"):
            if value.get(f"{prefix}_translation_rule") in {LEGACY_DEFAULT_TRANSLATION_RULE, V17_DEFAULT_TRANSLATION_RULE}:
                value[f"{prefix}_translation_rule"] = DEFAULT_TRANSLATION_RULE
                should_rewrite = True
            if value.get(f"{prefix}_optimization_rule") == LEGACY_DEFAULT_OPTIMIZATION_RULE:
                value[f"{prefix}_optimization_rule"] = DEFAULT_OPTIMIZATION_RULE
                should_rewrite = True
        result = {**self._default_persisted_config(), **value, "installation_id": self.installation_id}
        # 密钥只在「地址变了」或「换机器」时清，切翻译服务 / 切后端绝不清
        if result.get("openai_api_key") and result.get("openai_credential_binding") != self._credential_binding("openai", result["openai_base_url"]):
            result["openai_api_key"] = ""
            result["openai_credential_binding"] = ""
            should_rewrite = True
        if result.get("baidu_secret_key") and result.get("baidu_credential_binding") != self._credential_binding("baidu", ""):
            result["baidu_secret_key"] = ""
            result["baidu_credential_binding"] = ""
            should_rewrite = True
        # 手改配置文件可能写坏 QPS；这里兜底回默认值，不让整个助手挂掉
        try:
            result["baidu_qps"] = normalize_baidu_qps(result.get("baidu_qps"))
        except ValueError:
            result["baidu_qps"] = BAIDU_QPS_DEFAULT
            should_rewrite = True
        if should_rewrite:
            self._write_json_atomic(self.config_path, result)
        return result

    def public_config(self):
        config = self.config()
        defaults = {}
        for prefix in ("openai", "ollama"):
            defaults[f"default_{prefix}_translation_rule"] = DEFAULT_TRANSLATION_RULE
            defaults[f"default_{prefix}_translate_optimize_rule"] = DEFAULT_TRANSLATE_OPTIMIZE_RULE
            defaults[f"default_{prefix}_optimization_rule"] = DEFAULT_OPTIMIZATION_RULE
        return {
            key: config[key] for key in DEFAULT_CONFIG if key not in ("openai_api_key", "baidu_secret_key")
        } | {
            "openai_api_key_configured": bool(config.get("openai_api_key")),
            "baidu_secret_key_configured": bool(config.get("baidu_secret_key")),
        } | defaults

    @staticmethod
    def _clean_rule(value, fallback):
        text = str(value if value is not None else fallback).strip()
        if not text:
            return fallback
        if len(text) > 20000:
            raise ValueError("自定义规则不能超过 20000 个字符")
        return text

    def update(self, payload):
        if not isinstance(payload, dict):
            raise ValueError("设置必须是对象")
        current = self.config()
        translate_service = str(payload.get("translate_service", current["translate_service"])).strip().lower()
        if translate_service not in TRANSLATE_SERVICES:
            raise ValueError("翻译服务仅支持词库、百度翻译、OpenAI 兼容接口或 Ollama")
        ai_provider = str(payload.get("ai_provider", current["ai_provider"])).strip().lower()
        if ai_provider not in {"openai_compatible", "ollama"}:
            raise ValueError("AI 后端仅支持 OpenAI 兼容接口或 Ollama")
        # 选了 OpenAI / Ollama 当翻译服务时，它就是 AI 后端，两者不允许脱节
        if translate_service in AI_SERVICES:
            ai_provider = translate_service
        # 两个后端各一套：地址规则不同（Ollama 只认本机，OpenAI 远端必须 https）
        openai_base_url = normalize_ai_base_url(payload.get("openai_base_url", current["openai_base_url"]), allow_remote=True)
        ollama_base_url = normalize_ai_base_url(payload.get("ollama_base_url", current["ollama_base_url"]))
        if not ollama_base_url:
            ollama_base_url = DEFAULT_CONFIG["ollama_base_url"]
        models = {}
        numbers = {}
        for prefix in ("openai", "ollama"):
            models[prefix] = str(payload.get(f"{prefix}_model", current[f"{prefix}_model"])).strip()
            if len(models[prefix]) > 300:
                raise ValueError("模型名称过长")
            try:
                numbers[prefix] = (
                    float(payload.get(f"{prefix}_temperature", current[f"{prefix}_temperature"])),
                    int(payload.get(f"{prefix}_timeout_seconds", current[f"{prefix}_timeout_seconds"])),
                )
            except (TypeError, ValueError) as error:
                raise ValueError("温度和超时时间必须是数字") from error
            if not 0 <= numbers[prefix][0] <= 2:
                raise ValueError("温度必须在 0 到 2 之间")
            if not 5 <= numbers[prefix][1] <= 600:
                raise ValueError("超时时间必须在 5 到 600 秒之间")
        # OpenAI key：只在「地址变了」或显式清除时清，切翻译服务 / 切后端绝不清
        openai_api_key = "" if openai_base_url != self._normalize_base_url(current["openai_base_url"]) else current.get("openai_api_key", "")
        if payload.get("clear_openai_api_key"):
            openai_api_key = ""
        elif "openai_api_key" in payload:
            incoming_key = str(payload.get("openai_api_key") or "").strip()
            if incoming_key and incoming_key != "••••••••":
                if len(incoming_key) > 4096:
                    raise ValueError("API Key 过长")
                openai_api_key = incoming_key
        baidu_appid = str(payload.get("baidu_appid", current.get("baidu_appid", ""))).strip()
        if len(baidu_appid) > 128:
            raise ValueError("百度 APP ID 过长")
        # 百度密钥：只在显式清除时清，切翻译服务绝不清
        baidu_secret = current.get("baidu_secret_key", "")
        if payload.get("clear_baidu_secret_key"):
            baidu_secret = ""
        elif "baidu_secret_key" in payload:
            incoming_secret = str(payload.get("baidu_secret_key") or "").strip()
            if incoming_secret and incoming_secret != "••••••••":
                if len(incoming_secret) > 4096:
                    raise ValueError("百度密钥过长")
                baidu_secret = incoming_secret
        baidu_qps = normalize_baidu_qps(payload.get("baidu_qps", current.get("baidu_qps", BAIDU_QPS_DEFAULT)))
        openai_credential_binding = self._credential_binding("openai", openai_base_url) if openai_api_key else ""
        baidu_credential_binding = self._credential_binding("baidu", "") if baidu_secret else ""
        appearance = str(payload.get("appearance", current.get("appearance", "auto"))).strip().lower()
        if appearance not in {"auto", "dark", "light"}:
            raise ValueError("外观模式仅支持 auto / dark / light")
        language = str(payload.get("language", current.get("language", "auto"))).strip().lower()
        if language not in {"auto", "zh", "en"}:
            raise ValueError("界面语言仅支持 auto / zh / en")
        result = {
            "schema_version": 4,
            "translate_service": translate_service,
            "ai_provider": ai_provider,
            "openai_base_url": openai_base_url,
            "openai_model": models["openai"],
            "openai_api_key": openai_api_key,
            "openai_temperature": numbers["openai"][0],
            "openai_timeout_seconds": numbers["openai"][1],
            "ollama_base_url": ollama_base_url,
            "ollama_model": models["ollama"],
            "ollama_temperature": numbers["ollama"][0],
            "ollama_timeout_seconds": numbers["ollama"][1],
            "baidu_appid": baidu_appid,
            "baidu_secret_key": baidu_secret,
            "baidu_qps": baidu_qps,
            "appearance": appearance,
            "language": language,
            "baidu_credential_binding": baidu_credential_binding,
            "openai_credential_binding": openai_credential_binding,
            "installation_id": self.installation_id,
        }
        # 规则两套，各取各自的当前值兜底
        for prefix in ("openai", "ollama"):
            for rule in RULE_KEYS:
                result[f"{prefix}_{rule}"] = self._clean_rule(payload.get(f"{prefix}_{rule}"), current[f"{prefix}_{rule}"])
        self._write_json_atomic(self.config_path, result)
        return self.public_config()


def dictionary_translate(text, dictionary_store):
    parts = [part.strip() for part in re.split(r"[,，、\r\n]+", str(text or "")) if part.strip()]
    if not parts:
        raise ValueError("待翻译文本为空")
    snapshot = dictionary_store.snapshot()
    local = snapshot["tags"]
    output = []
    missing = []
    for part in parts:
        weighted = re.fullmatch(r"\((.+):\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\)", part)
        lookup_part = weighted.group(1).strip() if weighted else part
        if not re.search(r"[\u3400-\u9fff]", lookup_part):
            output.append(part)
            continue
        exact = [tag for tag in local if lookup_part == tag.get("chinese") or lookup_part in (tag.get("aliases") or [])]
        if not exact:
            large = dictionary_store.search_large_tags(lookup_part, limit=30)
            exact = [tag for tag in large if lookup_part == tag.get("chinese")]
        if exact:
            # 个人词库与自然语言词库都算本机自建，优先于内置词库（与 dictionary_store.USER_PACK_IDS 一致）
            exact.sort(key=lambda tag: (tag.get("pack_id") in ("personal", "natural"), int(tag.get("post_count", 0))), reverse=True)
            english = exact[0]["english"]
            output.append(f"({english}:{weighted.group(2)})" if weighted else english)
        else:
            missing.append(lookup_part)
    if missing:
        preview = "、".join(missing[:8])
        raise ValueError(
            f"纯词库模式暂未收录：{preview}。可在“词库搜索”查找候选、手动加入个人词库，"
            "或按需配置免费的本地 Ollama / LM Studio；外部 API 不是必需项。"
        )
    return ", ".join(output)

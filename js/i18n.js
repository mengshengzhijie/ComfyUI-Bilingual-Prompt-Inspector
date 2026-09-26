// 插件自建的多语言层。
//
// ComfyUI 自带的 locale 机制（mergeCustomNodesI18n）只翻译 nodeDefs —— 也就是节点名、
// 节点描述、输入 / 输出名。面板里的按钮、状态栏、tooltip 这些自定义 DOM 文案它管不到，
// 所以这里自己做一层：
//   · 源码里一律保留英文原文（上架 Comfy Registry / ComfyUI-Manager 要求英文界面）
//   · 运行时按英文原文查中文表，查不到就原样显示英文 —— 缺翻译只会退回英文，不会出现空文案
//   · 「跟随 ComfyUI」读 ComfyUI 的 Comfy.Locale 设置，中文系语言走中文，其余走英文
//
// 带变量的文案（例如 `deleted “${term}”; press Ctrl+Z to undo`）没法直接整句做键，
// 这里把「“...”」和数字统一折叠成 {} 再查表，命中后按出现顺序回填。

const STORAGE_KEY = "bpi.language.v1";
const LANGUAGE_CHANGED_EVENT = "bpi:language-changed";
const LANGUAGE_MODES = new Set(["auto", "zh", "en"]);
const TEXT_ATTR = "data-bpi-i18n-text";
const TITLE_ATTR = "data-bpi-i18n-title";
const PLACEHOLDER_ATTR = "data-bpi-i18n-placeholder";
// 变量占位符：normalize() 把动态片段折叠成它，译表里也写它
const VAR = "{}";
// 第 1 组是「“…”」里的内容，第 2 组是数字；回填时只取内容，不带引号
const VAR_PATTERN = /“([^”]*)”|(\d+(?:\.\d+)?)/g;

function variables(text) {
  const values = [];
  for (const match of text.matchAll(VAR_PATTERN)) values.push(match[1] !== undefined ? match[1] : match[2]);
  return values;
}

const ZH = {
  // ── 通用按钮 / 弹窗 ────────────────────────────────────────────────
  Cancel: "取消",
  Close: "关闭",
  Confirm: "确认",
  Save: "保存",
  Delete: "删除",
  Copy: "复制",
  Export: "导出",
  Import: "导入",
  Refresh: "刷新",
  Clear: "清空",
  New: "新建",
  Done: "完成",
  Discard: "丢弃",
  Resume: "继续",
  Weight: "权重",
  Category: "分类",
  English: "英文",
  Name: "名称",
  Notes: "备注",
  Prompt: "提示词",
  Personal: "个人",
  Favorite: "收藏",
  Unfavorite: "取消收藏",
  "Favorite tag": "收藏标签",
  "All": "全部",
  "Optional": "选填",
  "Comma-separated": "用逗号分隔",
  "0–2": "0–2",
  "5–600": "5–600",

  // ── 节点主面板 ──────────────────────────────────────────────────────
  "English original (actual output)": "英文原文（实际输出）",
  "Chinese explanation (read-only)": "中文解释（只读）",
  "Category table view | click tags to link; category names are not written to the prompt":
    "分类表视图 | 点击标签联动；分类名不会写入提示词",
  "Click tags to link; select then press Delete": "点击标签联动；选中后按 Delete",
  "Enter the English prompt; after editing, it will be shown as selectable, deletable tags.":
    "输入英文提示词；编辑完成后会显示成可选中、可删除的标签。",
  "Enter a prompt in the English text box above; per-tag bilingual mapping will appear here.":
    "在上面的英文输入框里写提示词，这里会出现逐标签的中英对照。",
  "Linked tags will appear here after you finish editing English.":
    "英文编辑完成后，联动标签会出现在这里。",
  "Edit text": "编辑文本",
  "Edit Chinese": "编辑中文",
  "Edit directly when empty": "为空时可直接编辑",
  "Edit tag weight": "编辑标签权重",
  "Apply weight": "应用权重",
  "Clear weight": "清除权重",
  "Highest": "最高",
  Translate: "翻译",
  "Translate & optimize": "翻译并优化",
  "Optimize to Anima": "优化为 Anima",
  "Re-translate": "重新翻译",
  "Translate all unknown": "翻译全部未收录",
  "Sort by Anima order": "按 Anima 顺序排序",
  "Confirm write English": "确认写入英文",
  "Confirm & save": "确认并保存",
  "Save to dict": "存入词库",
  "Save to Personal Dictionary": "保存到个人词库",
  "Add tag": "添加标签",
  "New Tag": "新建标签",
  "Search candidates": "搜索候选",
  "Dictionary search": "词库搜索",
  "Enter Chinese, English, alias, or concept; click a result to insert the English tag":
    "输入中文、英文、别名或概念；点击结果即可插入英文标签",
  "Search English, Chinese, aliases or category": "搜索英文、中文、别名或分类",
  "Double-click to edit Chinese explanation": "双击编辑中文解释",
  "Enter Chinese explanation": "输入中文解释",
  "Copy English + Chinese mapping": "复制中英对照",
  "Text mode while typing; parsed into tags when done": "输入时按文本处理，结束后解析为标签",
  "Stay in text editing while typing; switch to tag view on blur or after clicking Done":
    "输入时保持文本编辑；失焦或点「完成」后切回标签视图",
  "Switch between the English text editor and the linked tag view":
    "在英文文本编辑框与联动标签视图之间切换",
  "Requires a second click to clear the actual English output; after clearing, click the same button or press Ctrl+Z to undo":
    "需要再点一次才会清空英文实际输出；清空后点同一个按钮或按 Ctrl+Z 可撤销",
  "Save the current English prompt to favorites in the user directory (a reference image can be attached)":
    "把当前英文提示词保存到用户目录的收藏里（可附带参考图）",
  "Hidden tags will not enter the actual output": "隐藏的标签不会进入实际输出",
  "These tags will not enter the actual output; click a tag to restore it to its original position":
    "这些标签不会进入实际输出；点击标签可恢复到原位置",
  "Restore all": "全部恢复",
  "Delete pending": "删除待确认",
  "Auto-detect": "自动识别",
  "Tag mode": "标签模式",
  "Natural language": "自然语言",
  "All Categories": "全部分类",
  Unknown: "未收录",
  Machine: "机器翻译",
  "Personal dictionary": "个人词库",
  "No inspector node on canvas": "画布上没有检查器节点",
  "No matching items under the current filter.": "当前筛选条件下没有匹配项。",
  "No unknown tags currently": "当前没有未收录标签",
  "Edit directly": "直接编辑",

  // ── 上游拦截条 ──────────────────────────────────────────────────────
  "Upstream input": "上游输入",
  "Intercept upstream text": "拦截上游文本",
  "When on, intercepts upstream text and pauses for confirmation; when off, upstream text passes through unchanged":
    "开启时拦截上游文本并暂停等待确认；关闭时上游文本原样通过",
  "Determines when upstream text overwrites the node content": "决定上游文本在什么时候覆盖节点内容",
  "Import: on content change": "导入：内容变化时",
  "Import: every run": "导入：每次运行",
  "Import: first run only": "导入：仅首次运行",
  "New English prompt to apply": "待应用的新英文提示词",
  "Current English prompt": "当前英文提示词",

  // ── 状态栏 / 提示文案（含变量） ──────────────────────────────────────
  "Click “Confirm clear” again to clear the English actual output": "再点一次「确认清空」才会清空英文实际输出",
  "English actual output cleared; click “undo” to restore immediately": "英文实际输出已清空；点「撤销」可立即恢复",
  "English actual output is already empty": "英文实际输出已经是空的",
  "English clear undone": "已撤销英文清空",
  "English content has changed; cannot undo this clear": "英文内容已变化，无法撤销这次清空",
  "English prompt is empty; cannot sort": "英文提示词是空的，无法排序",
  "Content is empty; enter the English prompt directly": "内容为空，请直接输入英文提示词",
  "Result is empty; English prompt not overwritten": "结果为空，未覆盖英文提示词",
  "No content change": "内容没有变化",
  "Natural-language segments only support whole-segment editing; tags can still be deleted individually":
    "自然语言片段只支持整段编辑；标签仍可单独删除",
  "Only tags support individual weights; use text editing for natural language":
    "只有标签支持单独权重；自然语言请用文本编辑",
  "Weight must be between 0 and 3": "权重必须在 0 到 3 之间",
  "Use “Edit text” to process it": "请用「编辑文本」处理",
  "Click “Edit text”, then use the inspector's own “Translate” or “Translate & optimize”":
    "点「编辑文本」，再用检查器自带的「翻译」或「翻译并优化」",
  "Sorting complete; please confirm in the preview window": "排序完成，请在预览窗口里确认",
  "Please check unconfirmed machine translations first": "请先处理未确认的机器翻译",
  "Cleared unsaved machine translations": "已清除未保存的机器翻译",
  "Prompt copied to clipboard": "提示词已复制到剪贴板",
  "Prompt is empty; cannot favorite": "提示词是空的，无法收藏",
  "Browser denied clipboard write": "浏览器拒绝了剪贴板写入",
  "Browser denied clipboard access": "浏览器拒绝了剪贴板访问",
  "Only optimizes existing English; does not translate": "只优化已有英文，不做翻译",
  "press Anima stable sort by recommended categories, one row per non-empty category; natural language and BREAK/AND kept intact":
    "按 Anima 推荐分类做稳定排序，每个非空分类一行；自然语言与 BREAK/AND 原样保留",
  "Drag to reorder tags; or select then press Alt+↑/↓ to nudge; Ctrl+Z to undo":
    "拖动可调整标签顺序；或选中后按 Alt+↑/↓ 微调；Ctrl+Z 撤销",
  "applied {}; press Ctrl+Z to undo": "已应用 {}；按 Ctrl+Z 可撤销",
  "deleted {}; press Ctrl+Z to undo": "已删除「{}」；按 Ctrl+Z 可撤销",
  "{}; press Ctrl+Z to undo": "{}；按 Ctrl+Z 可撤销",
  "moved {}; press Ctrl+Z to undo": "已移动「{}」；按 Ctrl+Z 可撤销",
  "hidden {} (excluded from actual output); can be restored anytime in the hidden section; press Ctrl+Z to undo":
    "已隐藏「{}」（不计入实际输出）；随时可在隐藏区恢复；按 Ctrl+Z 可撤销",
  "restored {} to its original position; press Ctrl+Z to undo": "已把「{}」恢复到原位置；按 Ctrl+Z 可撤销",
  "restored {} hidden tags; press Ctrl+Z to undo": "已恢复 {} 个隐藏标签；按 Ctrl+Z 可撤销",
  "{} is already at the front": "「{}」已经在最前面",
  "{} is already at the back": "「{}」已经在最后面",
  "temporarily modified {}; not saved to dictionary": "已临时修改「{}」，未存入词库",
  "saved {} to personal dictionary": "已把「{}」存入个人词库",
  "translated {}; can save after confirming": "已翻译「{}」，确认后可保存",
  "Copied {} CN/EN mapping": "已复制「{}」的中英对照",
  "Delete {}": "删除「{}」",
  "Move {}": "移动「{}」",
  "Hide {}": "隐藏「{}」",
  "restore {}": "恢复「{}」",
  "Clear {} weight": "清除「{}」的权重",
  "will set {} weight to {}": "将把「{}」的权重设为 {}",
  "Hide {}: excluded from actual output; can be restored in the hidden section":
    "隐藏「{}」：不计入实际输出，可在隐藏区恢复",
  "Hide {}: removed from actual output but kept in this list; can be restored to original position at any time":
    "隐藏「{}」：从实际输出中移除但保留在本列表，随时可恢复到原位置",
  "Click to restore {} to its original position": "点击把「{}」恢复到原位置",
  "hidden ({})": "已隐藏（{}）",
  "Delete personal override and restore built-in explanation": "删除个人覆盖并恢复内置解释",
  "Delete personal tag": "删除个人标签",
  "Delete override & restore built-in": "删除覆盖并恢复内置解释",
  "Delete Personal Tag": "删除个人标签",
  "Enabled {}": "已启用「{}」",
  "Disabled {}": "已停用「{}」",
  "Query: {}": "查询：{}",
  "Query: {} | weight: {}": "查询：{}｜权重：{}",
  "Explanation source: {}": "解释来源：{}",
  "Aliases: {}": "别名：{}",
  "{} ↔ {} | natural language supports only whole-segment editing; can drag to reorder the whole segment":
    "「{}」↔「{}」｜自然语言只支持整段编辑；可拖动整段调整顺序",
  "{} ↔ {} | click to link; double-click to edit weight; select then press Delete; drag to reorder or Alt+↑/↓ to nudge":
    "「{}」↔「{}」｜点击联动；双击编辑权重；选中后按 Delete；拖动排序或 Alt+↑/↓ 微调",
  "Insert line break": "插入换行",
  "Delete line break": "删除换行",
  "Move line break": "移动换行",
  "Insert a line break after the selected tag, or at the end when no tag is selected":
    "在选中的标签后面插入换行；没有选中标签时插到末尾",
  "Line break | drag onto a tag to move it; click × to delete (the two lines merge)":
    "换行｜拖到某个标签上可移动位置；点 × 删除（上下两行合并）",
  "Delete this line break": "删除这个换行",
  "Enter tags first, then insert a line break": "先输入标签，再插入换行",
  "Inserted a line break; press Ctrl+Z to undo": "已插入换行；按 Ctrl+Z 撤销",
  "Deleted a line break; press Ctrl+Z to undo": "已删除换行；按 Ctrl+Z 撤销",
  "Moved the line break; press Ctrl+Z to undo": "已移动换行；按 Ctrl+Z 撤销",
  "Check this machine translation; use the toolbar above the table to add several entries to the personal dictionary at once":
    "勾选这条机器翻译；用表格上方的工具条可以一次把多条加入个人词库",
  "Drag to resize the two columns; double-click to reset to the default ratio": "拖动调整左右两栏宽度；双击恢复默认比例",
  "Add selected to personal dictionary": "把已选加入个人词库",
  "Selected {} / {}": "已选 {} / 共 {}",
  "Check the entries you want to add first": "请先勾选要加入的词条",
  "Adding {} entries…": "正在加入「{}」条词条…",
  "Added {} entries | new {}, replaced {}": "已加入「{}」条｜新增「{}」、覆盖「{}」",
  "Added {} entries | new {}, replaced {}, skipped {}": "已加入「{}」条｜新增「{}」、覆盖「{}」、跳过「{}」",
  "Restore all {} hidden tags to their original positions": "把全部 {} 个隐藏标签恢复到原位置",
  "Generated by the assistant currently configured in the bilingual inspector; not yet saved to the personal dictionary":
    "由双语检查器当前配置的助手生成，尚未存入个人词库",
  "Machine translation not yet human-verified": "机器翻译，尚未人工确认",
  "Dictionary cannot determine": "词库无法判定",
  "Estimated from dictionary source and verification status": "按词库来源与校验状态估算",
  "Click to insert the English tag": "点击插入这个英文标签",
  "Click to insert the English tag | aliases: {}": "点击插入这个英文标签｜别名：{}",
  "Enable or disable large dictionary on-demand lookup": "启用或停用大词库按需查询",
  "Large dictionary database not installed": "尚未安装大词库数据库",
  "Click to disable this pack": "点击停用这个词包",
  "Click to enable this pack": "点击启用这个词包",

  // ── 底部快捷输入 ────────────────────────────────────────────────────
  "Quick add": "快捷添加",
  "Enter to add | Shift+Enter for a new line | Ctrl+Enter to translate & optimize": "回车添加｜Shift+回车换行｜Ctrl+回车翻译并优化",
  "Type Chinese to translate it into English tags, or type English tags to add them directly":
    "输入中文会自动翻译为英文标签；直接输入英文则原样添加",
  Add: "添加",
  "Enter Chinese or an English tag first": "请先输入中文或英文标签",
  "Added {} to the prompt": "已把「{}」添加到提示词",
  "Translating {}…": "正在翻译「{}」…",
  "Translation result is empty": "翻译结果是空的",
  "Translated {} to {} and added it": "已把「{}」翻译为「{}」并添加",

  // ── 弹窗：保存提示词 ────────────────────────────────────────────────
  "Save Current Prompt": "保存当前提示词",
  "Defaults to the start of the prompt": "默认取提示词开头",
  "Reference Image": "参考图",
  "Drop an image here, or click to select": "把图片拖到这里，或点击选择",
  "Optional; PNG / JPG / WebP, max 5 MB": "选填；PNG / JPG / WebP，最大 5 MB",
  "Prompt is empty, cannot save": "提示词是空的，无法保存",
  "Select a node to save": "选择要保存的节点",
  "No image": "无图片",

  // ── 弹窗：新增 / 编辑标签 ────────────────────────────────────────────
  "Add Personal Tag": "新增个人标签",
  "Add or Edit Personal Tag": "新增或编辑个人标签",
  "English Tag": "英文标签",
  "Chinese Name": "中文名称",
  "Chinese Aliases": "中文别名",
  Models: "适用模型",
  "Recommended Weight": "推荐权重",
  "e.g.: looking at viewer": "例如：looking at viewer",
  "e.g.: pose, camera, style": "例如：pose、camera、style",

  // ── 关于 ────────────────────────────────────────────────────────────
  "About plugin": "关于插件",
  "View plugin version and project repository": "查看插件版本与项目仓库",
  "Visit plugin repo ↗": "访问插件仓库 ↗",
  "A ComfyUI community tool for Anima / Danbooru prompt organization, translation, and management.":
    "ComfyUI 社区工具：整理、翻译与管理 Anima / Danbooru 提示词。",
  "Based on Qiongyi44's bilingual prompt inspector; independently maintained.":
    "基于 Qiongyi44 的双语提示词检查器，独立维护。",

  // ── 侧边栏管理面板 ──────────────────────────────────────────────────
  "Bilingual Prompt Manager": "提示词翻译与管理",
  "Tag Manager": "标签管理",
  Dictionary: "词库",
  Packs: "词包",
  Favorites: "收藏",
  "Assistant Settings": "助手设置",
  "Manager panel": "管理面板",
  "Add or select a BilingualPromptInspector node to see its tag manager here.":
    "添加或选中画布上的 BilingualPromptInspector 节点，即可在此看到它的标签管理。",
  "Tag translation, dictionary search and per-tag operations edit the selected node below.":
    "标签翻译、词库搜索和逐标签操作都作用于下方选中的节点。",
  "Inspector node:": "检查器节点：",
  "Refresh node list": "刷新节点列表",
  "Refresh dictionary": "刷新词库",
  "Add manually": "手动添加",
  "Bulk Category/Models": "批量改分类／模型",
  "Bulk edit applies only to checked personal entries": "批量修改只对勾选的个人条目生效",
  "Session-only": "仅本次会话",
  "Pending Machine": "待确认机器翻译",
  "Danbooru Large Dict": "Danbooru 大词库",
  "Built-in pack enabled": "已启用内置词包",
  "All Packs": "全部词包",
  "Clear session machine translations": "清除本会话的机器翻译",
  "Confirm selected": "确认已选",
  "Cannot disable": "不可停用",
  "Search by name or content": "按名称或内容搜索",
  "Load to Node": "载入到节点",
  "Saved": "已保存",
  Deleted: "已删除",
  Exported: "已导出",
  "No tags array in file": "文件里没有 tags 数组",
  "Community dictionary file must contain a tags array": "社区词库文件必须包含 tags 数组",
  "Pack name cannot be empty": "词包名称不能为空",
  "Import Community Pack": "导入社区词包",
  "Import as community pack": "作为社区词包导入",
  "Import Personal Dictionary Preview": "导入个人词库预览",
  "Confirm Import": "确认导入",
  "Import as Chinese aliases": "作为中文别名导入",
  "Keep current explanations": "保留当前解释",
  "Use imported explanations": "使用导入的解释",
  "Imported explanation": "导入的解释",
  "Current explanation": "当前解释",
  "Conflict:": "冲突：",
  "Overwrite if same pack ID exists (auto-backup before update)": "若存在相同词包 ID 则覆盖（更新前自动备份）",
  "Import file contains invalid entries missing English or Chinese; please fix the file first.":
    "导入文件里有缺少英文或中文的无效条目，请先修正文件。",
  "Current personal dictionary is backed up before import. You can keep current explanations, use imported ones, or merge different Chinese texts as aliases. Built-in files are never modified.":
    "导入前会先备份当前个人词库。你可以保留现有解释、改用导入的解释，或把不同的中文合并为别名。内置文件不会被修改。",
  "Querying Danbooru large dictionary...": "正在查询 Danbooru 大词库…",
  "Querying the large dictionary…": "正在查询大词库…",
  "Recognizing tag categories…": "正在识别标签分类…",
  "Loading dictionary…": "正在加载词库…",
  "Loading settings...": "正在加载设置…",
  "Settings load on first visit...": "首次进入时加载设置…",

  // ── 助手设置 ────────────────────────────────────────────────────────
  "Translation Service": "翻译服务",
  "Dictionary only (no API)": "仅词库（不需要接口）",
  "Baidu Translate": "百度翻译",
  "AI (OpenAI-compatible / Ollama)": "AI（OpenAI 兼容 / Ollama）",
  "Translation/explanation uses this choice. \"Translate & Optimize\" and \"Optimize to Anima\" always use AI, unrelated here. To test AI connection, temporarily set translation service to AI then click test (key preserved).":
    "翻译／解释按这里的选择走。「翻译并优化」和「优化为 Anima」始终走 AI，与此无关。要测试 AI 连接，请临时把翻译服务切到 AI 再点测试（密钥会保留）。",
  "APP ID": "APP ID",
  "Secret Key": "密钥",
  "Clear saved Baidu secret": "清除已保存的百度密钥",
  "Baidu Cloud \"General Text Translation\" APP ID": "百度智能云「通用文本翻译」的 APP ID",
  "Baidu Cloud \"General Text Translation\" Secret Key": "百度智能云「通用文本翻译」的密钥",
  "AI Service (Translate & Optimize / Optimize / AI Translate)": "AI 服务（翻译并优化 / 优化 / AI 翻译）",
  "AI Backend": "AI 后端",
  "OpenAI-compatible API": "OpenAI 兼容接口",
  "Ollama (local)": "Ollama（本地）",
  "API URL": "API 地址",
  "Optional for Ollama; e.g.: https://host/v1": "Ollama 可选；例如 https://host/v1",
  "Model Name": "模型名称",
  "e.g.: qwen3:8b or provider model ID": "例如：qwen3:8b 或服务商的模型 ID",
  "Use LM Studio Local Preset": "使用 LM Studio 本地预设",
  "Connects to localhost:1234 by default; no external API required.": "默认连接 localhost:1234，不需要外部接口。",
  "LM Studio default URL filled; select a loaded model ID, then Save & Test": "已填入 LM Studio 默认地址；选择已加载的模型 ID 后保存并测试",
  "API Key": "API 密钥",
  "Optional for local Ollama / LM Studio": "本地 Ollama / LM Studio 可选",
  "Clear saved API Key": "清除已保存的 API 密钥",
  "Saved; leave empty to keep": "已保存；留空则保持不变",
  Temperature: "温度",
  "Timeout (s)": "超时（秒）",
  Appearance: "外观",
  "Follow ComfyUI": "跟随 ComfyUI",
  Dark: "暗色",
  Light: "亮色",
  "Save & Test Connection": "保存并测试连接",
  "Save Settings": "保存设置",
  "Reset to Default Rules": "恢复默认规则",
  "Defaults restored in editor; click Save to apply": "已在编辑框恢复默认值；点保存后生效",
  "Assistant settings saved": "助手设置已保存",
  "Testing...": "测试中…",
  "Settings are stored in the ComfyUI user directory. AI key and Baidu secret are retained independently; switching service never clears either. AI key is only cleared when AI backend/URL changes or on a different machine. Neither is written to workflows or returned to the browser.":
    "设置保存在 ComfyUI 用户目录下。AI 密钥与百度密钥各自独立保留，切换服务不会清空任何一个。AI 密钥只在 AI 后端／地址变化或换机器时清除。两者都不会写入工作流，也不会回传给浏览器。",

  // ── 语言设置（本功能新增） ────────────────────────────────────────────
  Language: "语言",
  Chinese: "中文",
  "Chinese (Simplified)": "简体中文",
  "Follow ComfyUI language setting": "跟随 ComfyUI 语言设置",
  "Choose the language for this plugin's own panels. \"Follow ComfyUI\" reads the ComfyUI language setting; \"Chinese\" and \"English\" force one. Applied to open panels right away; reload the page if anything still shows the old language.":
    "选择本插件面板的语言。「跟随 ComfyUI 语言设置」会随 ComfyUI 的语言切换；「中文」「英文」为强制指定。已打开的面板会立即更新；若个别位置仍是旧语言，刷新页面即可。",
  "Language saved": "语言设置已保存",

  // ── 标签来源 / 分类 / 模式 ──────────────────────────────────────────
  "Inspector assistant": "检查器助手",
  "Built-in dictionary": "内置词库",
  "Legacy personal dictionary": "旧版个人词库",
  "Danbooru Large dictionary": "Danbooru 大词库",
  "Syntax-protected": "语法保留项",
  "Unknown source": "未知来源",
  "Uncategorized": "未分类",
  "Not indexed": "未收录",
  "Natural-language segment (pending translation or confirmation)": "自然语言片段（待翻译或确认）",
  "Custom": "自定义",
  "Pending": "待确认",
  Syntax: "语法",
  Unconfirmed: "未确认",
  "Weight {}": "权重 {}",
  Tag: "标签",
  "Tag + Natural language": "标签 + 自然语言",
  Instruction: "指令",
  "Mode: {}": "模式：{}",
  "Mode: {} | {}": "模式：{}｜{}",
  "English prompt tag view": "英文提示词标签视图",
  "Anima official sort": "Anima 官方顺序",
  "Anima official order preview": "Anima 官方顺序预览",
  "Empty input": "输入为空",
  "Copied": "已复制",

  // ── 节点面板：统计 / 提示 / 操作回执 ──────────────────────────────────
  "items {} | recognized {} | unknown {}": "共 {} 个标签｜已识别 {}｜未收录 {}",
  "items {} | recognized {} | unknown {} | pending {}": "共 {} 个标签｜已识别 {}｜未收录 {}｜待确认 {}",
  "items {} | recognized {} | unknown {} | issues {}": "共 {} 个标签｜已识别 {}｜未收录 {}｜问题 {}",
  "items {} | recognized {} | unknown {} | pending {} | issues {}": "共 {} 个标签｜已识别 {}｜未收录 {}｜待确认 {}｜问题 {}",
  "{}Sync": "{}同步",
  "Clear English prompt": "清空英文提示词",
  "This tag has no explicit weight": "这个标签没有显式权重",
  "Weight unchanged or value invalid": "权重没有变化，或数值无效",
  "Restore all hidden tags ({} )": "恢复全部隐藏标签（{}）",
  "Undone: {}": "已撤销：{}",
  "Redone: {}": "已重做：{}",
  "Located: {}": "已定位：{}",
  Translating: "正在翻译",
  "Translating: {}": "正在翻译：{}",
  "This is a natural-language segment; keep the translation as natural language, do not split into a tag list.":
    "这是自然语言片段；翻译请保持自然语言，不要拆成标签列表。",
  "Rejected abnormal translation: {}": "已拒绝异常翻译：{}",
  "({}:{})": "（{}：{}）",
  "relocated {}  | pending categories {}  tags. Sorting only moves tags; content is not rewritten.":
    "已重排 {}｜待定分类 {} 个标签。排序只移动标签，不改写内容。",
  "Translation complete {} items": "翻译完成 {} 条",
  "Translation complete {} items | rejected {}": "翻译完成 {} 条｜已拒绝 {} 条",
  "Restore built-in": "恢复内置",
  "Delete personal": "删除个人",
  "Built-in explanation restored": "已恢复内置解释",
  "Personal tag deleted": "个人标签已删除",
  "Chinese explanation cannot be empty": "中文解释不能为空",
  "Result still contains Chinese": "结果仍包含中文",
  "Contains characters not allowed by Anima rules: {}": "包含 Anima 规则不允许的字符：{}",
  "favorited or recently used": "已收藏或最近使用",
  "No matching tag found in the active dictionaries; you can manually add one to the personal dictionary.":
    "已启用的词库里没有匹配的标签；可以手动添加到个人词库。",
  "Danbooru raw format": "Danbooru 原始格式",
  "Large dictionary": "大词库",
  "Search more": "搜索更多",
  "Showing {}  items; there may be more": "已显示 {} 条，可能还有更多",
  "showing all {}  items; no more results": "已显示全部 {} 条，没有更多结果",
  "Intercept upstream text; output after confirmation": "拦截上游文本，确认后再输出",
  "Direct passthrough: upstream output as-is, no import, no pause": "直接透传：上游原样输出，不导入也不暂停",
  "Release failed: {}": "放行失败：{}",
  "Discard failed: {}": "放弃失败：{}",
  "Cannot pause for confirmation: {}": "无法暂停等待确认：{}",
  "Bilingual Prompt Manager {}": "提示词翻译与管理 {}",
  "Bilingual Prompt Inspector {}": "提示词翻译与管理 {}",
  "Bilingual Prompt Inspector": "提示词翻译与管理",

  // ── 侧边栏：词库 / 词包 / 收藏 ──────────────────────────────────────
  Builtin: "内置",
  "Built-in": "内置",
  Edit: "编辑",
  Load: "载入",
  "Save Personal": "保存为个人",
  "Reset Built-in": "重置为内置",
  "Select all ({} items)": "全选（{} 条）",
  "pack:": "词包：",
  "Copied {}": "已复制 {}",
  "Processed {}": "已处理「{}」",
  "Re-translated {}": "已重新翻译「{}」",
  "Confirmed {} entries; personal dictionary backed up": "已确认 {} 条；个人词库已备份",
  "Rejected invalid translation: {}": "已拒绝无效翻译：{}",
  "Large dictionary loads on demand; enter English or Chinese keywords above.": "大词库按需加载；在上面输入英文或中文关键词。",
  "No entries match the current filter.": "当前筛选条件下没有匹配的条目。",
  " | Large {} ({})": "｜大词库 {}（{}）",
  "Showing {}": "显示 {}",
  "Selected {}": "已选 {}",
  "Enabled packs {}/{}": "已启用词包 {}/{}",
  "Built-in {}": "内置 {}",
  "Personal {}": "个人 {}",
  "Pending {}": "待确认 {}",
  "Large {} (on-demand)": "大词库 {}（按需）",
  "Large {} (disabled)": "大词库 {}（已停用）",
  "Large not installed": "大词库未安装",
  "Common dictionary {} items": "通用词库 {} 条",
  "on-demand": "按需",
  disabled: "已停用",
  "{} items | Local user | Always enabled, overrides same-name entries": "{} 条｜本地用户｜始终启用，覆盖同名条目",
  "{} Danbooru Large Dict": "{} Danbooru 大词库",
  "{} items | v{} | {} | read-only, on-demand": "{} 条｜v{}｜{}｜只读、按需",
  "Database not installed | small dictionaries unaffected": "未安装数据库｜小词库不受影响",
  "Read-only": "只读",
  Unavailable: "不可用",
  "{} items | v{} | {}": "{} 条｜v{}｜{}",
  "Exported {}": "已导出「{}」",
  "Delete community pack \"{}\"? File is backed up first; recoverable from data/backups.":
    "删除社区词包「{}」？文件会先备份，可从 data/backups 恢复。",
  "Deleted and backed up {}": "已删除并备份「{}」",
  "{} community pack {}, {} items": "{} 社区词包「{}」，{} 条",
  "Total {}": "共 {}",
  "Added {}": "新增 {}",
  "Conflicts {}": "冲突 {}",
  "Duplicates {}": "重复 {}",
  "Invalid {}": "无效 {}",
  "Import complete: added {}, overwrote {}, skipped {} | auto-backed up": "导入完成：新增 {}、覆盖 {}、跳过 {}｜已自动备份",
  "Import complete: {} added": "导入完成：新增 {} 条",
  "Tags {} | Sample: {}": "标签 {} 条｜示例：{}",
  "New category (empty = no change):": "新分类（留空表示不改）：",
  "Applicable models, comma-separated (empty = no change):": "适用模型，逗号分隔（留空表示不改）：",
  "Updated {} entries; personal dictionary backed up": "已更新 {} 条；个人词库已备份",
  "Exported {} personal tags": "已导出 {} 条个人标签",
  "Community pack read failed: {}": "社区词包读取失败：{}",
  "Pack Name": "词包名称",
  "e.g.: community pose extension": "例如：community pose extension",
  "Pack ID (optional)": "词包 ID（选填）",
  "English, numbers, hyphens": "英文、数字、连字符",
  Version: "版本",
  "e.g.: 1.0.0": "例如：1.0.0",
  Source: "来源",
  "Community Import": "社区导入",
  "Community or author name": "社区或作者名",
  "License (optional)": "授权（选填）",
  "e.g.: CC BY 4.0": "例如：CC BY 4.0",
  "Homepage (optional)": "主页（选填）",
  "Records source only; no automatic access": "仅记录来源，不会自动访问",
  "Translation Rule": "翻译规则",
  "Translate & Optimize Rule": "翻译并优化规则",
  "Optimize Rule": "优化规则",
  "Connection OK: {}": "连接正常：{}",
  // 确认对话框的默认确认按钮（confirmDialog 的 confirmLabel 缺省值），
  // 不是「连接正常」的 OK——那个是整句键 "Connection OK: {}"。
  OK: "确认",
  Untitled: "未命名",
  "Source node not recorded": "未记录来源节点",
  "No matching favorites.": "没有匹配的收藏。",
  "No favorites yet. Click the star button on a node to save the current prompt.":
    "还没有收藏。点节点上的星标按钮即可保存当前提示词。",
  "This will overwrite node #{} prompt. Cannot be undone with Ctrl+Z.": "这会覆盖节点 #{} 的提示词，Ctrl+Z 无法撤销。",
  "Loaded to node #{}": "已载入到节点 #{}",
  "Delete {}? Reference image will be deleted too.": "删除「{}」？参考图也会一并删除。",
  "Node #{}": "节点 #{}",
  "Node #{}: {}": "节点 #{}：{}",
  "Bilingual Prompt Inspector: Tag Manager, Dictionary, Packs & Assistant Settings":
    "提示词翻译与管理：标签管理、词库、词包与助手设置",

  // ── 语法诊断（parser.js）────────────────────────────────────────────
  "Manual override": "手动覆盖",
  "Structured translation request/body detected": "检测到结构化翻译请求／正文",
  "Translation directive prefix detected": "检测到翻译指令前缀",
  "Natural language followed by tag list": "自然语言后接标签列表",
  "Natural language between tags": "标签之间的自然语言",
  "Short tags followed by natural language": "短标签后接自然语言",
  "Multiple short tags": "多个短标签",
  "Complete sentence": "完整句子",
  "Natural language grammar": "自然语言语法",
  "Tag-style input": "标签式输入",
  "Translation is empty": "翻译结果为空",
  "Translation too long ({} chars)": "翻译结果过长（{} 字符）",
  "Single tag expanded to multiple lines": "单个标签被展开成多行",
  "Single tag expanded to {} tags": "单个标签被展开成 {} 个标签",
  "Translation added weights not in source": "翻译结果添加了原文没有的权重",
  "Translation added brackets not in source": "翻译结果添加了原文没有的括号",
  "Translation has explanatory prefix": "翻译结果带有说明性前缀",
  "Not judged": "未判定",
  High: "高",
  Medium: "中",
  "Bracket mismatch: extra or misplaced {}": "括号不匹配：多了或位置不对的 {}",
  "Unclosed bracket: missing {}": "括号未闭合：缺少 {}",
  "Duplicate tag: {}": "重复标签：{}",
  "Invalid weight format: {}": "权重格式无效：{}",
  "Full-width separator detected; Anima tag flow usually uses ASCII commas": "检测到全角分隔符；Anima 标签流一般用半角逗号",
  "Consecutive commas or empty tags detected": "检测到连续逗号或空标签",
  "Checking by natural language sentences; commas do not split into separate tags": "按自然语言句子检查；逗号不会拆成独立标签",
  "Mixed tags + natural language detected: short tags checked individually, trailing description kept as one segment":
    "检测到标签 + 自然语言混排：短标签逐个检查，结尾描述作为一整段保留",
  "Translation instruction detected; checker analyzes body only": "检测到翻译指令；检查器只分析正文",
  "Solo vs multiple subjects": "单人 vs 多人",
  "Front vs back view": "正面 vs 背面",
  "Facing left vs right": "朝左 vs 朝右",
  "Standing vs other poses": "站姿 vs 其他姿态",
  "Eyes closed vs looking at viewer": "闭眼 vs 看向镜头",
  "Full body vs close-up": "全身 vs 特写",

  // ── Anima 分类排序（anima_sorter.js）─────────────────────────────────
  "Quality / Meta / Year / Rating": "质量 / 元信息 / 年代 / 评级",
  "People count": "人物数量",
  Character: "角色",
  "Copyright / Series": "版权 / 作品",
  Artist: "画师",
  "Appearance / Clothing": "外观 / 服装",
  "Expression / Action / Pose": "表情 / 动作 / 姿态",
  "Camera / Composition": "镜头 / 构图",
  Style: "风格",
  "Scene / Background / Lighting": "场景 / 背景 / 光影",
  Uncertain: "不确定",
  "Separator / Group": "分隔符 / 分组",

  // ── 词典工具（dictionary_tools.js）───────────────────────────────────
  "Clear text": "清空文本",
  "Confirm clear": "确认清空",
  Undo: "撤销",
  "Related concept": "相关概念",
  "Concept modified: {}": "概念改写：{}",
  "Concept link: {}": "概念关联：{}",
  "Exact match": "完全匹配",
  "Prefix or alias match": "前缀或别名匹配",
  "Substring match": "子串匹配",

  // ── 请求失败类提示（bpi_shared.js 抛出的 error.message）────────────────
  "Local session initialization failed": "本地会话初始化失败",
  "Resume failed ({})": "放行失败（{}）",
  "Dictionary load failed": "词库加载失败",
  "Assistant returned no valid result": "助手没有返回有效结果",
  "Assistant processing failed": "助手处理失败",
  "Assistant returned no text": "助手没有返回文本",
  "Failed to load assistant settings": "助手设置加载失败",
  "Failed to save assistant settings": "助手设置保存失败",
  "Connection test failed": "连接测试失败",
  "Tag save failed": "标签保存失败",
  "Personal tag deletion failed": "个人标签删除失败",
  "Dictionary import failed": "词库导入失败",
  "Bulk update failed": "批量更新失败",
  "Dictionary pack toggle failed": "词包启用状态切换失败",
  "Large dictionary lookup failed": "大词库查询失败",
  "Large dictionary search failed": "大词库搜索失败",
  "Large dictionary toggle failed": "大词库开关切换失败",
  "Community pack import failed": "社区词包导入失败",
  "Community pack deletion failed": "社区词包删除失败",
  "Dictionary pack export failed": "词包导出失败",
  "Export failed": "导出失败",
  "Saved prompts load failed": "收藏加载失败",
  "Saved prompt creation failed": "收藏创建失败",
  "Saved prompt deletion failed": "收藏删除失败",
  "Saved prompts export failed": "收藏导出失败",
  "Saved prompts import failed": "收藏导入失败",

  // ── 上面几处带变量的组合形态 ──────────────────────────────────────────
  "Discarded this upstream input": "已丢弃这次上游输入",
  "already matches Anima order": "已经是 Anima 顺序",
  "already matches Anima order | pending {} items": "已经是 Anima 顺序｜还有 {} 项待定",
  "Enabled Danbooru Large Dict": "已启用 Danbooru 大词库",
  "Disabled Danbooru Large Dict": "已停用 Danbooru 大词库",
  "{} items | v{} | {} | License {}": "{} 条｜v{}｜{}｜授权 {}",
  "Possible conflict: {} ({} ↔ {})": "可能存在冲突：{}（{} ↔ {}）",

  // ── 第三批：自由文本变量包裹后的组合形态与遗漏项 ──────────────────────
  "Low": "低",
  "Low · pending": "低 · 待确认",
  "Medium · pending": "中 · 待确认",
  "Medium · session-only": "中 · 仅本次会话",
  "★ Unfavorite": "★ 取消收藏",
  "☆ Favorite": "☆ 收藏",
  "Paused, waiting for confirmation…": "已暂停，等待确认…",
  "Querying dictionary…": "正在查询词库…",
  "Searching for more…": "正在搜索更多…",
  "tag: {} | Anima format: (Tag:Weight)": "标签：{}｜Anima 格式：(标签:权重)",
  "Node #{} · {}  tags": "节点 #{} · {} 个标签",
  "Running {}…": "正在运行 {}…",
  "Translating unknown tags {}/{}：{}": "正在翻译未收录标签 {}/{}：{}",
  "Translation complete {} items, rejected abnormal results {} items": "翻译完成 {} 条，已拒绝异常结果 {} 条",
  "uses {}": "使用 {} 次",
  "{} · {} KB": "{} · {} KB",
  "Weight {} outside common range {}–{}": "权重 {} 超出常见范围 {}–{}",
  "Tags {}": "标签 {} 条",
  "Sample": "示例",
  "(empty prompt)": "（空提示词）",
  "(weight {})": "（权重 {}）",
  "Delete community pack {}? File is backed up first; recoverable from data/backups.": "删除社区词包「{}」？会先备份文件，可从 data/backups 恢复。",


  // ── 第四批：分段翻译后需要的片段 ────────────────────────────────────
  "community pack {}, {} items": "社区词包「{}」，{} 条",
  Updated: "已更新",
  Imported: "已导入",

  "Prompt (English on top, Chinese below)": "提示词（上英文 · 下中文）",
  "Click a tag to link it with the detail table below; select then press Delete": "点击标签可与下方明细表联动；选中后按 Delete 删除",
  "English prompt is empty; nothing to optimize": "英文提示词是空的，没有可优化的内容",
  "“Optimize to Anima” only processes English; translate Chinese in the sidebar first": "「优化为 Anima」只处理英文；中文请先在侧边栏翻译",
  "{} done; please confirm in the preview window": "「{}」完成；请在预览窗口确认",
  "{}; please fix it in the preview before confirming": "「{}」；请在预览里改好再确认",
};

let mode = "auto";
let resolved = null;
let localeReader = null;

// bpi_shared 在模块加载时把「读 ComfyUI 语言设置」的函数注册进来，
// 这样 i18n.js 本身不依赖 app.js，node 下也能单独跑测试。
export function registerLocaleReader(reader) {
  localeReader = reader;
  resolved = null;
}

function readComfyLocale() {
  if (typeof localeReader === "function") {
    try {
      const value = localeReader();
      if (typeof value === "string" && value) return value;
    } catch {
      /* 设置面板还没起来，忽略 */
    }
  }
  if (typeof navigator !== "undefined" && navigator.language) return navigator.language;
  return "";
}

function isChineseLocale(value) {
  return /^zh\b/i.test(String(value || "").trim());
}

export function resolveLanguage() {
  if (resolved) return resolved;
  if (mode === "zh" || mode === "en") {
    resolved = mode;
  } else {
    resolved = isChineseLocale(readComfyLocale()) ? "zh" : "en";
  }
  return resolved;
}

export function getLanguageMode() {
  return mode;
}

export function setLanguageMode(next, { persist = true, notify = true } = {}) {
  const value = String(next || "auto").toLowerCase();
  mode = LANGUAGE_MODES.has(value) ? value : "auto";
  resolved = null;
  if (persist) {
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      /* 隐私模式下写不了，仅本次会话生效 */
    }
  }
  if (notify) {
    applyLanguageToDom();
    try {
      window.dispatchEvent(new CustomEvent(LANGUAGE_CHANGED_EVENT, { detail: { mode } }));
    } catch {
      /* 无 window 环境（如 node 测试）直接跳过 */
    }
  }
  return mode;
}

export function loadStoredLanguage() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (LANGUAGE_MODES.has(String(stored || ""))) return setLanguageMode(stored, { persist: false, notify: false });
  } catch {
    /* 读不到就用默认 auto */
  }
  return mode;
}

// 把英文原文折叠成查表键：「“...”」片段和数字都视为变量
function normalizeKey(text) {
  return text.replace(VAR_PATTERN, VAR);
}

export function t(text, depth = 0) {
  if (typeof text !== "string" || !text) return text;
  if (resolveLanguage() !== "zh") return text;
  const direct = ZH[text];
  if (direct !== undefined) return direct;
  // 带变量的文案：先把变量抠出来，再按出现顺序填回译文
  const values = variables(text);
  if (!values.length) return text;
  const pattern = ZH[normalizeKey(text)];
  if (pattern === undefined) return text;
  // 变量本身也可能是界面文案（例如冲突标签 "Solo vs multiple subjects"、模式名 "Tag"），
  // 一并翻译；depth 只防万一，正常一层就够。
  const filled = depth < 2 ? values.map((value) => t(value, depth + 1)) : values;
  let index = 0;
  return pattern.split(VAR).map((part, position) => (position === 0 ? part : `${filled[index++] ?? ""}${part}`)).join("");
}

// ── 实时切换：把英文原文记在 data 属性上，改语言时整树重刷 ──────────────

function remember(node, attribute, source) {
  if (!node || typeof source !== "string" || !source) return;
  if (!/[A-Za-z]/.test(source)) return; // 纯符号（× ↩ ⠿）没有翻译价值
  try {
    node.setAttribute(attribute, source);
  } catch {
    /* 忽略 */
  }
}

export function markText(node, source) {
  remember(node, TEXT_ATTR, source);
}

export function setText(node, source) {
  if (!node) return;
  node.textContent = t(source);
  // 动态文案（状态栏、报错）不参与整树重刷，避免被回填成旧内容
  try {
    node.removeAttribute(TEXT_ATTR);
  } catch {
    /* 忽略 */
  }
}

export function setTitle(node, source) {
  if (!node) return;
  node.title = t(source);
  remember(node, TITLE_ATTR, source);
}

export function setPlaceholder(node, source) {
  if (!node) return;
  node.placeholder = t(source);
  remember(node, PLACEHOLDER_ATTR, source);
}

export function applyLanguageToDom(root) {
  if (typeof document === "undefined" || !document.querySelectorAll) return;
  const scope = root && root.querySelectorAll ? root : document;
  const rules = [
    [`[${TEXT_ATTR}]`, TEXT_ATTR, "textContent"],
    [`[${TITLE_ATTR}]`, TITLE_ATTR, "title"],
    [`[${PLACEHOLDER_ATTR}]`, PLACEHOLDER_ATTR, "placeholder"],
  ];
  for (const [selector, attribute, property] of rules) {
    for (const node of scope.querySelectorAll(selector)) {
      const source = node.getAttribute(attribute);
      if (!source) continue;
      node[property] = t(source);
    }
  }
}

export { LANGUAGE_CHANGED_EVENT, LANGUAGE_MODES, STORAGE_KEY, ZH };

import { app } from "../../scripts/app.js";
import { normalizeKey, validateTranslationResult } from "./parser.js";
import { mergeImportAsAliases, previewImport, toggleFavorite } from "./dictionary_tools.js";
import { panelSyncHub } from "./panel_sync.js";
import { installBpiWheelGuard } from "./wheel_guard.js";
import {
  MANAGER_OPEN_EVENT,
  MANAGER_TAB_ID,
  button,
  deleteCommunityPack,
  deletePersonalTag,
  deleteSavedPrompt,
  downloadJson,
  element,
  exportDictionaryPack,
  exportPersonalDictionary,
  exportSavedPrompts,
  field,
  getAssistantConfig,
  importCommunityPack,
  importSavedPrompts,
  importTags,
  bulkUpdateTags,
  injectBpiStyles,
  listSavedPrompts,
  loadDictionary,
  loadPreferences,
  openSavePromptDialog,
  openTagDialog,
  savedPromptImageUrl,
  runInspectorAssistant,
  saveAssistantConfig,
  savePreferences,
  searchLargeDictionary,
  setLargeDictionaryEnabled,
  setPackEnabled,
  testAssistantConnection,
} from "./bpi_shared.js";

const SECTIONS = [
  ["tag-manager", "标签管理"],
  ["tags", "词库"],
  ["packs", "词库包"],
  ["assistant", "助手设置"],
  ["favorites", "收藏"],
];

const manager = {
  data: { tags: [], builtin: [], user: [], packs: [] },
  preferences: loadPreferences(),
  selected: new Set(),
  section: "tags",
  loaded: false,
  assistantLoaded: false,
  favoritesLoaded: false,
  favorites: [],
  favoritesChangeHandler: null,
  tagManagerNodeId: null,
  largeMatches: [],
  largeQuery: "",
  largeLoading: false,
  largeTimer: null,
  largeGeneration: 0,
  syncSource: Symbol("bpi-manager"),
};

let root = null;
let refs = {};

function setStatus(message, kind = "") {
  if (!refs.status) return;
  refs.status.textContent = message;
  refs.status.dataset.kind = kind;
}

function isFavorite(english) {
  return manager.preferences.favorites.includes(normalizeKey(english));
}

function changeFavorite(english) {
  manager.preferences = toggleFavorite(manager.preferences, english);
  savePreferences(manager.preferences);
  panelSyncHub.notify("preferences", manager.syncSource);
}

function machineRows() {
  return [...panelSyncHub.machineTranslations.entries()].map(([key, item]) => ({
    key,
    kind: "machine",
    tag: {
      english: item.english ?? key,
      chinese: item.text,
      aliases: [],
      category: "待确认",
      models: ["general", "anima"],
      source: "bpi-assistant",
      verified: false,
    },
  })).filter((row) => !manager.data.tags.some((tag) => normalizeKey(tag.english) === row.key));
}

function managerRows() {
  const personalKeys = new Set(manager.data.user.map((tag) => normalizeKey(tag.english)));
  const localKeys = new Set(manager.data.tags.map((tag) => normalizeKey(tag.english)));
  return [
    ...manager.data.tags.map((tag) => ({ key: normalizeKey(tag.english), kind: personalKeys.has(normalizeKey(tag.english)) ? "personal" : "builtin", tag })),
    ...manager.largeMatches
      .filter((tag) => !localKeys.has(normalizeKey(tag.english)))
      .map((tag) => ({ key: normalizeKey(tag.english), kind: "large", tag })),
    ...machineRows(),
  ];
}

const refresh = async (notifyPeers = true) => {
  try {
    manager.data = await loadDictionary(true);
    if (notifyPeers) panelSyncHub.notify("dictionary", manager.syncSource);
  } catch (error) {
    setStatus(error.message, "error");
    return;
  }
  renderAll();
};

function rebuildSourceOptions() {
  const current = refs.source.value;
  refs.source.replaceChildren();
  const options = [
    ["all", "全部词库"],
    ["builtin", "已启用内置包"],
    ["personal", "个人词库"],
    ...(manager.data.large_dictionary?.available ? [["large", "Danbooru 大型词库"]] : []),
    ["machine", "待确认机器译"],
    ["favorites", "收藏"],
    ...(manager.data.packs ?? []).map((pack) => [`pack:${pack.id}`, `${pack.enabled ? "✓" : "○"} ${pack.name}`]),
  ];
  for (const [value, label] of options) {
    const option = element("option", "", label);
    option.value = value;
    refs.source.appendChild(option);
  }
  refs.source.value = options.some(([value]) => value === current) ? current : "all";
}

function rebuildCategoryOptions() {
  const current = refs.category.value;
  refs.category.replaceChildren();
  const all = element("option", "", "全部分类");
  all.value = "all";
  refs.category.appendChild(all);
  const categories = [...new Set(managerRows().map((row) => row.tag.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  for (const category of categories) {
    const option = element("option", "", category);
    option.value = category;
    refs.category.appendChild(option);
  }
  refs.category.value = [...refs.category.options].some((option) => option.value === current) ? current : "all";
}

function deleteMachineTranslation(key) {
  const changed = panelSyncHub.machineTranslations.delete(key);
  if (changed) panelSyncHub.notify("machine", manager.syncSource);
  return changed;
}

async function confirmMachineRows(rows) {
  if (!rows.length) {
    setStatus("请先勾选待确认机器译", "error");
    return;
  }
  try {
    const imported = await importTags(rows.map((row) => ({ ...row.tag, verified: true })), "overwrite");
    for (const row of rows) {
      deleteMachineTranslation(row.key);
      manager.selected.delete(`machine:${row.key}`);
    }
    await refresh();
    setStatus(`已确认 ${imported.added + imported.replaced} 项，并自动备份个人词库`, "ok");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function retranslateMachineRow(row) {
  setStatus(`正在翻译：${row.tag.english}`, "busy");
  try {
    const translated = await runInspectorAssistant("translate", row.tag.english);
    const validation = validateTranslationResult(row.tag.english, translated, {});
    if (!validation.ok) {
      setStatus(`已拒绝异常译文：${validation.reason}`, "error");
      return;
    }
    panelSyncHub.machineTranslations.set(row.key, {
      english: row.tag.english,
      text: validation.text,
      source: "bpi-assistant",
      createdAt: Date.now(),
    });
    panelSyncHub.notify("machine", manager.syncSource);
    setStatus(`已重新翻译“${row.tag.english}”`, "ok");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function renderRows() {
  if (!refs.rows) return;
  rebuildSourceOptions();
  rebuildCategoryOptions();
  const query = refs.search.value.trim().toLowerCase();
  const category = refs.category.value;
  const source = refs.source.value;
  const rows = managerRows().filter((row) => {
    if (source === "favorites" && !isFavorite(row.tag.english)) return false;
    if (source.startsWith("pack:") && row.tag.pack_id !== source.slice(5)) return false;
    if (!["all", "favorites"].includes(source) && !source.startsWith("pack:") && row.kind !== source) return false;
    if (category !== "all" && row.tag.category !== category) return false;
    if (query) {
      const haystack = [row.tag.english, row.tag.chinese, row.tag.category, ...(row.tag.aliases ?? [])].join("\n").toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
  refs.rows.replaceChildren();
  const selectAll = element("input");
  selectAll.type = "checkbox";
  selectAll.checked = rows.length > 0 && rows.every((row) => manager.selected.has(`${row.kind}:${row.key}`));
  selectAll.addEventListener("change", () => {
    for (const row of rows) {
      const id = `${row.kind}:${row.key}`;
      if (selectAll.checked) manager.selected.add(id); else manager.selected.delete(id);
    }
    renderRows();
  });
  const header = element("div", "bpm-row");
  const headerTop = element("div", "bpm-row-top");
  headerTop.append(selectAll, element("span", "bpm-row-en", `全选（当前 ${rows.length} 项）`));
  header.appendChild(headerTop);
  refs.rows.appendChild(header);
  for (const row of rows) {
    const { tag, key, kind } = row;
    const id = `${kind}:${key}`;
    const item = element("div", "bpm-row");
    const top = element("div", "bpm-row-top");
    const checkbox = element("input");
    checkbox.type = "checkbox";
    checkbox.checked = manager.selected.has(id);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) manager.selected.add(id); else manager.selected.delete(id);
      renderRows();
    });
    const english = element("span", "bpm-row-en", tag.english);
    english.title = tag.aliases?.length ? `别名：${tag.aliases.join("、")}` : tag.english;
    top.append(checkbox, english);
    if (tag.category) top.appendChild(element("span", "bpi-badge", tag.category));
    item.appendChild(top);
    item.appendChild(element("div", "bpm-row-zh", tag.chinese));
    const meta = element("div", "bpm-row-meta");
    const sourceName = kind === "machine" ? "机器译" : kind === "personal" ? "个人词库" : kind === "large" ? "Danbooru 大型词库" : (tag.pack_name ?? "内置词库");
    meta.appendChild(element("span", "", sourceName));
    const star = button(isFavorite(tag.english) ? "★ 取消收藏" : "☆ 收藏", () => {
      changeFavorite(tag.english);
      renderRows();
    }, `bpi-mini${isFavorite(tag.english) ? " bpi-star bpi-starred" : ""}`);
    meta.appendChild(star);
    item.appendChild(meta);
    const actions = element("div", "bpm-actions");
    actions.appendChild(button("复制", async () => {
      try {
        await navigator.clipboard.writeText(tag.english);
        setStatus(`已复制 ${tag.english}`, "ok");
      } catch {
        setStatus("浏览器未允许写入剪贴板", "error");
      }
    }, "bpi-mini"));
    if (kind === "machine") {
      actions.append(
        button("确认", () => confirmMachineRows([row]), "bpi-mini bpi-primary"),
        button("重译", () => retranslateMachineRow(row), "bpi-mini"),
        button("删除待确认", () => {
          deleteMachineTranslation(key);
          manager.selected.delete(id);
          renderRows();
        }, "bpi-mini"),
      );
    } else {
      actions.appendChild(button(kind === "large" ? "保存个人" : "编辑", () => openTagDialog(tag, refresh), "bpi-mini"));
      if (kind === "personal") {
        const hasBuiltin = manager.data.builtin.some((item2) => normalizeKey(item2.english) === normalizeKey(tag.english));
        actions.appendChild(button(hasBuiltin ? "恢复内置" : "删除", async () => {
          if (!window.confirm(`${hasBuiltin ? "删除个人覆盖并恢复内置解释" : "删除个人标签"}“${tag.english}”？`)) return;
          try {
            await deletePersonalTag(tag.english);
            manager.selected.delete(id);
            await refresh();
            setStatus(`已处理“${tag.english}”`, "ok");
          } catch (error) { setStatus(error.message, "error"); }
        }, "bpi-mini bpi-danger"));
      }
    }
    item.appendChild(actions);
    refs.rows.appendChild(item);
  }
  if (manager.largeLoading) refs.rows.appendChild(element("div", "bpm-loading", "正在按需查询 Danbooru 大型词库…"));
  if (!rows.length && !manager.largeLoading) {
    const emptyText = source === "large" && !query
      ? "大型词库不会整库加载，请在上方输入英文或中文关键词。"
      : "当前筛选条件下没有词条。";
    refs.rows.appendChild(element("div", "bpm-loading", emptyText));
  }
  const large = manager.data.large_dictionary;
  const largeSummary = large?.available ? `｜大型库 ${large.count}（${large.enabled ? "按需启用" : "已停用"}）` : "｜大型库未安装";
  const enabledPacks = (manager.data.packs ?? []).filter((pack) => pack.enabled).length;
  refs.summary.textContent = `显示 ${rows.length} 项｜已选 ${manager.selected.size} 项｜已启用包 ${enabledPacks}/${manager.data.packs?.length ?? 0}｜内置有效 ${manager.data.builtin.length}${largeSummary}｜个人 ${manager.data.user.length}｜待确认 ${machineRows().length}`;
}

function renderPacks() {
  if (!refs.packList) return;
  refs.packList.replaceChildren();
  const personalCard = element("div", "bpi-pack-card bpi-pack-personal");
  const personalMarker = element("span", "bpi-badge bpi-confidence-high", "最高");
  const personalBody = element("div");
  personalBody.append(element("div", "bpi-pack-name", "个人词库"), element("div", "bpi-pack-meta", `${manager.data.user.length} 项｜本机用户｜始终启用并覆盖所有同名词条`));
  personalCard.append(personalMarker, personalBody, element("div", "bpi-pack-controls", "不可停用"));
  refs.packList.appendChild(personalCard);
  const large = manager.data.large_dictionary;
  if (large) {
    const card = element("div", `bpi-pack-card${large.enabled && large.available ? "" : " bpi-pack-disabled"}`);
    const toggle = element("input", "bpi-switch");
    toggle.type = "checkbox";
    toggle.checked = Boolean(large.enabled);
    toggle.disabled = !large.available;
    toggle.title = large.available ? "启用或停用大型词库按需查询" : "尚未安装大型词库数据库";
    toggle.addEventListener("change", async () => {
      toggle.disabled = true;
      try {
        await setLargeDictionaryEnabled(toggle.checked);
        await refresh();
        manager.largeMatches = [];
        manager.largeQuery = "";
        setStatus(`${toggle.checked ? "已启用" : "已停用"} Danbooru 大型词库`, "ok");
      } catch (error) {
        setStatus(error.message, "error");
        toggle.checked = !toggle.checked;
        toggle.disabled = false;
      }
    });
    const body = element("div");
    body.append(
      element("div", "bpi-pack-name", large.name),
      element("div", "bpi-pack-meta", large.available
        ? `${large.count} 项｜版本 ${large.version}｜${large.source}｜只读、按需查询`
        : "尚未安装数据库｜不会影响现有小型词库"),
    );
    const controls = element("div", "bpi-pack-controls", large.available ? "只读" : "不可用");
    card.append(toggle, body, controls);
    refs.packList.appendChild(card);
  }
  for (const pack of manager.data.packs ?? []) {
    const card = element("div", `bpi-pack-card${pack.enabled ? "" : " bpi-pack-disabled"}`);
    const toggle = element("input", "bpi-switch");
    toggle.type = "checkbox";
    toggle.checked = Boolean(pack.enabled);
    toggle.title = pack.enabled ? "点击停用此词库包" : "点击启用此词库包";
    toggle.addEventListener("change", async () => {
      toggle.disabled = true;
      try {
        await setPackEnabled(pack.id, toggle.checked);
        await refresh();
        manager.selected.clear();
        setStatus(`${toggle.checked ? "已启用" : "已停用"}“${pack.name}”`, "ok");
      } catch (error) {
        setStatus(error.message, "error");
        toggle.checked = !toggle.checked;
        toggle.disabled = false;
      }
    });
    const body = element("div");
    body.append(
      element("div", "bpi-pack-name", pack.name),
      element("div", "bpi-pack-meta", `${pack.count} 项｜版本 ${pack.version}｜${pack.source}${pack.license ? `｜许可 ${pack.license}` : ""}`),
    );
    const controls = element("div", "bpi-pack-controls");
    controls.appendChild(button("导出", async () => {
      try {
        const payload = await exportDictionaryPack(pack.id);
        downloadJson(payload, `bpi-pack-${pack.id}-${new Date().toISOString().slice(0, 10)}.json`);
        setStatus(`已导出“${pack.name}”`, "ok");
      } catch (error) { setStatus(error.message, "error"); }
    }, "bpi-mini"));
    if (!pack.readonly) {
      controls.appendChild(button("删除", async () => {
        if (!window.confirm(`删除社区词库包“${pack.name}”？文件会先备份，可从 data/backups 恢复。`)) return;
        try {
          await deleteCommunityPack(pack.id);
          await refresh();
          manager.selected.clear();
          setStatus(`已删除并备份“${pack.name}”`, "ok");
        } catch (error) { setStatus(error.message, "error"); }
      }, "bpi-mini bpi-danger"));
    }
    card.append(toggle, body, controls);
    refs.packList.appendChild(card);
  }
}

function openCommunityPackPreview(payload, filename) {
  if (!payload || !Array.isArray(payload.tags)) {
    setStatus("社区词库文件必须包含 tags 数组", "error");
    return;
  }
  const shade = element("div", "bpi-modal-shade");
  const modal = element("div", "bpi-modal");
  modal.appendChild(element("h3", "", "导入为独立社区词库包"));
  const form = element("div", "bpi-community-form");
  const metadata = payload.pack && typeof payload.pack === "object" ? payload.pack : {};
  const fallbackName = String(filename ?? "community-pack.json").replace(/\.json$/i, "");
  const fields = {};
  for (const [key, label, value, placeholder] of [
    ["name", "词库包名称", metadata.name ?? fallbackName, "例如：社区姿势扩展"],
    ["id", "包ID（可选）", metadata.id ?? "", "英文、数字、横线"],
    ["version", "版本", metadata.version ?? "1.0.0", "例如：1.0.0"],
    ["source", "来源", metadata.source ?? "社区导入", "社区或作者名称"],
    ["license", "许可（可选）", metadata.license ?? "", "例如：CC BY 4.0"],
    ["homepage", "主页（可选）", metadata.homepage ?? "", "仅记录来源，不自动访问"],
  ]) {
    form.appendChild(element("label", "", label));
    const input = element("input");
    input.value = value;
    input.placeholder = placeholder;
    fields[key] = input;
    form.appendChild(input);
  }
  modal.appendChild(form);
  const preview = element("div", "bpi-community-preview");
  preview.textContent = `词条 ${payload.tags.length} 项｜示例：${payload.tags.slice(0, 8).map((tag) => `${tag?.english ?? "?"} → ${tag?.chinese ?? "?"}`).join("；")}`;
  modal.appendChild(preview);
  const overwriteLine = element("label", "bpm-toolbar");
  const overwrite = element("input");
  overwrite.type = "checkbox";
  overwriteLine.append(overwrite, element("span", "", "同ID社区包已存在时覆盖更新（更新前自动备份）"));
  modal.appendChild(overwriteLine);
  const error = element("div", "bpi-status");
  error.dataset.kind = "error";
  modal.appendChild(error);
  const actions = element("div", "bpi-modal-actions");
  const close = () => shade.remove();
  const confirm = button("导入社区包", async () => {
    if (!fields.name.value.trim()) { error.textContent = "词库包名称不能为空"; return; }
    confirm.disabled = true;
    try {
      const result = await importCommunityPack({
        ...payload,
        pack: {
          ...metadata,
          name: fields.name.value.trim(),
          id: fields.id.value.trim(),
          version: fields.version.value.trim(),
          source: fields.source.value.trim(),
          license: fields.license.value.trim(),
          homepage: fields.homepage.value.trim(),
        },
      }, overwrite.checked);
      close();
      await refresh();
      setStatus(`${result.replaced ? "已更新" : "已导入"}社区包“${result.name}”，共 ${result.count} 项`, "ok");
    } catch (importError) {
      error.textContent = importError.message;
      confirm.disabled = false;
    }
  }, "bpi-primary");
  actions.append(button("取消", close), confirm);
  modal.appendChild(actions);
  shade.appendChild(modal);
  document.body.appendChild(shade);
  shade.addEventListener("mousedown", (event) => { if (event.target === shade) close(); });
  modal.addEventListener("mousedown", (event) => event.stopPropagation());
  setTimeout(() => fields.name.focus(), 0);
}

function openImportPreview(payload) {
  if (!payload || !Array.isArray(payload.tags)) {
    setStatus("文件中没有 tags 数组", "error");
    return;
  }
  const report = previewImport(payload.tags, manager.data.tags);
  const shade = element("div", "bpi-modal-shade");
  const modal = element("div", "bpi-modal");
  modal.appendChild(element("h3", "", "导入个人词库预览"));
  const stats = element("div", "bpi-import-stat");
  stats.append(
    element("span", "", `总计 ${report.total}`),
    element("span", "", `新增 ${report.added}`),
    element("span", "", `冲突 ${report.conflicts.length}`),
    element("span", "", `重复 ${report.duplicates}`),
    element("span", report.invalid ? "bpi-danger-text" : "", `无效 ${report.invalid}`),
  );
  modal.appendChild(stats);
  const explanation = element("p", "", "导入前会自动备份当前个人词库。你可以保留当前解释、使用导入解释，或把不同的导入中文合并为别名。内置词库文件始终不会被修改。");
  modal.appendChild(explanation);
  if (report.conflicts.length) {
    const conflicts = element("div", "bpi-import-conflicts");
    const header = element("div", "bpi-import-conflict");
    header.append(element("strong", "", "英文"), element("strong", "", "当前有效解释"), element("strong", "", "导入解释"));
    conflicts.appendChild(header);
    for (const conflict of report.conflicts.slice(0, 100)) {
      const row = element("div", "bpi-import-conflict");
      row.append(element("span", "", conflict.english), element("span", "", conflict.current), element("span", "", conflict.incoming));
      conflicts.appendChild(row);
    }
    modal.appendChild(conflicts);
  }
  const modeLine = element("div", "bpm-toolbar");
  const modeLabel = element("label", "", "同名冲突：");
  const mode = element("select", "bpi-mode");
  for (const [value, label] of [["skip", "保留当前解释"], ["overwrite", "使用导入解释"], ["alias", "导入为中文别名"]]) {
    const option = element("option", "", label);
    option.value = value;
    mode.appendChild(option);
  }
  modeLine.append(modeLabel, mode);
  modal.appendChild(modeLine);
  const error = element("div", "bpi-status");
  error.dataset.kind = "error";
  modal.appendChild(error);
  const actions = element("div", "bpi-modal-actions");
  const close = () => shade.remove();
  const confirm = button("确认导入", async () => {
    if (report.invalid) return;
    confirm.disabled = true;
    try {
      let importValues = payload.tags;
      let importMode = mode.value;
      if (mode.value === "alias") {
        importValues = mergeImportAsAliases(payload.tags, manager.data.tags);
        importMode = "overwrite";
      }
      const imported = await importTags(importValues, importMode);
      close();
      await refresh();
      setStatus(`导入完成：新增 ${imported.added}，覆盖 ${imported.replaced}，跳过 ${imported.skipped}｜已自动备份`, "ok");
    } catch (importError) {
      error.textContent = importError.message;
      confirm.disabled = false;
    }
  }, "bpi-primary");
  if (report.invalid) {
    confirm.disabled = true;
    error.textContent = "导入文件包含缺少英文或中文的无效词条，请先修正文件。";
  }
  actions.append(button("取消", close), confirm);
  modal.appendChild(actions);
  shade.appendChild(modal);
  document.body.appendChild(shade);
  shade.addEventListener("mousedown", (event) => { if (event.target === shade) close(); });
  modal.addEventListener("mousedown", (event) => event.stopPropagation());
}

async function buildAssistantSection(section) {
  section.replaceChildren();
  const loading = element("div", "bpm-loading", "正在读取设置…");
  section.appendChild(loading);
  let config;
  try {
    config = await getAssistantConfig();
  } catch (error) {
    loading.textContent = error.message;
    loading.classList.add("bpi-danger-text");
    return;
  }
  manager.assistantLoaded = true;
  section.replaceChildren();
  const form = element("form", "bpi-form");
  form.addEventListener("submit", (event) => event.preventDefault());
  const error = element("div", "bpi-status");
  error.style.gridColumn = "1 / -1";

  // 翻译服务：翻译/解释按此选择；“翻译并优化”“优化为 Anima”恒走 AI
  const serviceLabel = element("label", "", "翻译服务");
  const service = element("select");
  for (const [value, label] of [
    ["dictionary", "纯词库（无需 API）"],
    ["baidu", "百度翻译"],
    ["ai", "AI（OpenAI 兼容 / Ollama）"],
  ]) {
    const option = element("option", "", label);
    option.value = value;
    service.appendChild(option);
  }
  service.value = config.translate_service;
  form.append(serviceLabel, service);
  const serviceNote = element("div", "bpi-config-note", "翻译/解释按此选择；“翻译并优化”与“优化为 Anima”恒走 AI，与此处无关。要测 AI 连接请临时把翻译服务设为 AI 再点测试（密钥不会丢）。");
  serviceNote.style.gridColumn = "1 / -1";
  form.append(serviceNote);

  // 百度翻译（独立留存，切翻译服务不清）
  const baiduHead = element("div", "bpm-toolbar");
  baiduHead.style.gridColumn = "1 / -1";
  baiduHead.append(element("strong", "", "百度翻译"));
  form.append(baiduHead);
  const baiduAppId = field(form, "APP ID", "assistant-baidu-appid", config.baidu_appid, "百度智能云“通用文本翻译”的 APP ID");
  const baiduSecretKey = field(form, "密钥", "assistant-baidu-secret", "", config.baidu_secret_key_configured ? "已保存；留空保持不变" : "百度智能云“通用文本翻译”的密钥");
  baiduSecretKey.type = "password";
  const clearBaiduLine = element("label", "bpm-toolbar");
  const clearBaiduSecretKey = element("input");
  clearBaiduSecretKey.type = "checkbox";
  clearBaiduLine.append(clearBaiduSecretKey, element("span", "", "清除已保存的百度密钥"));
  const baiduSpacer = element("span");
  form.append(baiduSpacer, clearBaiduLine);

  // AI 服务（优化恒走它；翻译在选 AI 时也走它）
  const aiHead = element("div", "bpm-toolbar");
  aiHead.style.gridColumn = "1 / -1";
  aiHead.append(element("strong", "", "AI 服务（翻译并优化 / 优化为 Anima / AI 翻译）"));
  form.append(aiHead);
  const aiProviderLabel = element("label", "", "AI 后端");
  const aiProvider = element("select");
  for (const [value, label] of [["openai_compatible", "OpenAI 兼容 API"], ["ollama", "Ollama 本地模型"]]) {
    const option = element("option", "", label);
    option.value = value;
    aiProvider.appendChild(option);
  }
  aiProvider.value = config.ai_provider;
  form.append(aiProviderLabel, aiProvider);
  const baseUrl = field(form, "API 地址", "assistant-base-url", config.ai_base_url, "Ollama 可留空；兼容接口示例 https://host/v1");
  const model = field(form, "模型名称", "assistant-model", config.ai_model, "例如 qwen3:8b 或服务商模型 ID");
  const presetLine = element("div", "bpm-toolbar");
  presetLine.style.gridColumn = "1 / -1";
  const lmStudioPreset = button("使用 LM Studio 本地预设", () => {
    aiProvider.value = "openai_compatible";
    baseUrl.value = "http://127.0.0.1:1234/v1";
    error.textContent = "已填入 LM Studio 默认地址；请选择已加载模型的 ID，再保存并测试连接";
    error.dataset.kind = "ok";
  });
  presetLine.append(lmStudioPreset, element("span", "bpi-config-note", "默认连接本机 1234 端口，不要求购买外部 API。"));
  form.append(presetLine);
  const apiKey = field(form, "API Key", "assistant-api-key", "", config.ai_api_key_configured ? "已保存；留空保持不变" : "本地 Ollama / LM Studio 可留空");
  apiKey.type = "password";
  const clearLine = element("label", "bpm-toolbar");
  const clearApiKey = element("input");
  clearApiKey.type = "checkbox";
  clearLine.append(clearApiKey, element("span", "", "清除已保存的 API Key"));
  const apiKeySpacer = element("span");
  form.append(apiKeySpacer, clearLine);
  const temperature = field(form, "温度", "assistant-temperature", config.ai_temperature, "0–2");
  temperature.type = "number";
  temperature.min = "0";
  temperature.max = "2";
  temperature.step = "0.05";
  const timeout = field(form, "超时（秒）", "assistant-timeout", config.ai_timeout_seconds, "5–600");
  timeout.type = "number";
  timeout.min = "5";
  timeout.max = "600";

  // 规则
  const addRule = (labelText, value) => {
    const labelElement = element("label", "", labelText);
    const textarea = element("textarea");
    textarea.value = value;
    form.append(labelElement, textarea);
    return { labelElement, textarea };
  };
  const translationRule = addRule("仅翻译规则", config.translation_rule);
  const translateOptimizeRule = addRule("翻译并优化规则", config.translate_optimize_rule);
  const optimizationRule = addRule("优化为 Anima 规则", config.optimization_rule);
  form.appendChild(error);

  section.appendChild(form);
  section.appendChild(element("div", "bpi-config-note", "设置保存在当前 ComfyUI 用户目录。AI Key 与百度密钥独立留存，切换翻译服务互不清空；仅在 AI 后端/地址变更或换机器时才清 AI Key。两者均不写入工作流、不返回浏览器。"));
  const actions = element("div", "bpm-assistant-actions");
  const resetButton = button("恢复默认规则", () => {
    translationRule.textarea.value = config.default_translation_rule;
    translateOptimizeRule.textarea.value = config.default_translate_optimize_rule;
    optimizationRule.textarea.value = config.default_optimization_rule;
    error.textContent = "已在编辑框恢复默认值，点击保存后生效";
    error.dataset.kind = "ok";
  });
  const testButton = button("保存并测试连接", async () => {
    testButton.disabled = true;
    error.textContent = "正在测试…";
    error.dataset.kind = "busy";
    try {
      config = await saveAssistantConfig(payload());
      const result = await testAssistantConnection();
      error.textContent = `连接正常：${result.message}`;
      error.dataset.kind = "ok";
    } catch (testError) {
      error.textContent = testError.message;
      error.dataset.kind = "error";
    } finally {
      testButton.disabled = false;
    }
  });
  const saveButton = button("保存设置", async () => {
    saveButton.disabled = true;
    try {
      config = await saveAssistantConfig(payload());
      error.textContent = "助手设置已保存";
      error.dataset.kind = "ok";
    } catch (saveError) {
      error.textContent = saveError.message;
      error.dataset.kind = "error";
    } finally {
      saveButton.disabled = false;
    }
  }, "bpi-primary");
  actions.append(resetButton, testButton, saveButton);
  section.appendChild(actions);
  const payload = () => ({
    translate_service: service.value,
    ai_provider: aiProvider.value,
    ai_base_url: baseUrl.value.trim(),
    ai_model: model.value.trim(),
    ai_api_key: apiKey.value.trim(),
    clear_ai_api_key: clearApiKey.checked,
    baidu_appid: baiduAppId.value.trim(),
    baidu_secret_key: baiduSecretKey.value.trim(),
    clear_baidu_secret_key: clearBaiduSecretKey.checked,
    ai_temperature: temperature.value,
    ai_timeout_seconds: timeout.value,
    translation_rule: translationRule.textarea.value,
    translate_optimize_rule: translateOptimizeRule.textarea.value,
    optimization_rule: optimizationRule.textarea.value,
  });
}

function setSection(section) {
  if (!SECTIONS.some(([id]) => id === section)) return;
  manager.section = section;
  for (const [id] of SECTIONS) {
    refs.tabs?.querySelector(`[data-section="${id}"]`)?.classList.toggle("bpm-tab-active", id === section);
    refs.sections?.querySelector(`.bpm-section[data-section="${id}"]`)?.toggleAttribute("hidden", id !== section);
  }
  if (section === "tag-manager") rebuildTagManagerSection();
  if (section === "assistant" && !manager.assistantLoaded) buildAssistantSection(refs.assistantSection);
  if (section === "favorites" && !manager.favoritesLoaded) {
    manager.favoritesLoaded = true;
    refs.sections.appendChild(buildFavoritesSection());
    refreshFavorites();
  }
}

// ---------------------------------------------------------------------------
// 收藏：提示词 + 可选配图，落在 ComfyUI 用户目录
// ---------------------------------------------------------------------------

function favoriteDate(value) {
  const stamp = Number(value ?? 0);
  if (!stamp) return "";
  const date = new Date(stamp * 1000);
  const pad = (item) => String(item).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function targetInspectorNode() {
  const nodes = inspectorNodes();
  return nodes.find((node) => node.id === manager.tagManagerNodeId)
    ?? nodes.find((node) => node.selected)
    ?? nodes[0]
    ?? null;
}

function confirmDialog(title, message, confirmLabel = "确定") {
  return new Promise((resolve) => {
    const shade = element("div", "bpi-modal-shade");
    const modal = element("div", "bpi-modal");
    const actions = element("div", "bpi-modal-actions");
    const close = (value) => {
      shade.remove();
      resolve(value);
    };
    actions.append(button("取消", () => close(false)), button(confirmLabel, () => close(true), "bpi-primary"));
    modal.append(element("h3", "", title), element("div", "bpi-preview-text", message), actions);
    shade.appendChild(modal);
    document.body.appendChild(shade);
    shade.addEventListener("mousedown", (event) => {
      if (event.target === shade) close(false);
    });
    modal.addEventListener("mousedown", (event) => event.stopPropagation());
  });
}

async function pickInspectorNode() {
  const nodes = inspectorNodes();
  if (!nodes.length) {
    setStatus("画布上没有检查器节点", "error");
    return null;
  }
  if (nodes.length === 1) return nodes[0];
  return new Promise((resolve) => {
    const shade = element("div", "bpi-modal-shade");
    const modal = element("div", "bpi-modal");
    const list = element("div", "bpi-pack-list");
    for (const node of nodes) {
      list.appendChild(button(tagNodeLabel(node), () => {
        shade.remove();
        resolve(node);
      }));
    }
    const actions = element("div", "bpi-modal-actions");
    actions.append(button("取消", () => {
      shade.remove();
      resolve(null);
    }));
    modal.append(element("h3", "", "选择要收藏的节点"), list, actions);
    shade.appendChild(modal);
    document.body.appendChild(shade);
    shade.addEventListener("mousedown", (event) => {
      if (event.target === shade) {
        shade.remove();
        resolve(null);
      }
    });
    modal.addEventListener("mousedown", (event) => event.stopPropagation());
  });
}

function favoriteCard(item) {
  const card = element("div", "bpi-fav-card");
  const thumb = element("div", "bpi-fav-thumb");
  if (item.image) thumb.style.backgroundImage = `url("${savedPromptImageUrl(item.id)}")`;
  else thumb.textContent = "无配图";
  const info = element("div", "bpi-fav-info");
  const name = element("span", "bpi-fav-name", item.name ?? "未命名收藏");
  name.appendChild(element("span", "bpi-fav-date", favoriteDate(item.created_at)));
  const actions = element("div", "bpi-fav-actions");
  actions.append(
    button("载入到节点", () => loadFavoriteIntoNode(item), "bpi-primary"),
    button("复制", () => copyFavorite(item)),
    button("删除", () => removeFavorite(item), "bpi-danger"),
  );
  info.append(
    name,
    element("div", "bpi-fav-text", item.text ?? ""),
    element("div", "bpi-fav-meta", item.note || "未记录来源节点"),
    actions,
  );
  card.append(thumb, info);
  return card;
}

function renderFavorites() {
  const list = refs.favoritesList;
  if (!list) return;
  const query = String(refs.favoritesSearch?.value ?? "").trim().toLowerCase();
  const items = manager.favorites.filter((item) => !query
    || String(item.name ?? "").toLowerCase().includes(query)
    || String(item.text ?? "").toLowerCase().includes(query));
  list.replaceChildren();
  if (!items.length) {
    list.appendChild(element("div", "bpi-empty", manager.favorites.length
      ? "没有匹配的收藏。"
      : "还没有收藏。在节点上点「收藏」即可保存当前提示词。"));
    return;
  }
  for (const item of items) list.appendChild(favoriteCard(item));
}

async function refreshFavorites() {
  try {
    manager.favorites = await listSavedPrompts();
  } catch (error) {
    setStatus(error.message, "error");
    manager.favorites = [];
  }
  renderFavorites();
}

async function copyFavorite(item) {
  try {
    await navigator.clipboard.writeText(item.text ?? "");
    setStatus("提示词已复制到剪贴板", "ok");
  } catch {
    setStatus("浏览器拒绝了剪贴板访问", "error");
  }
}

async function loadFavoriteIntoNode(item) {
  const target = targetInspectorNode();
  if (!target) {
    setStatus("画布上没有检查器节点", "error");
    return;
  }
  const confirmed = await confirmDialog(
    "载入收藏",
    `将用这条收藏覆盖节点 #${target.id} 的英文提示词，此操作无法用 Ctrl+Z 撤销。`,
  );
  if (!confirmed) return;
  target._bilingualPromptInspector?.setText?.(item.text ?? "");
  setStatus(`已载入到节点 #${target.id}`, "ok");
}

async function removeFavorite(item) {
  const confirmed = await confirmDialog("删除收藏", `删除「${item.name ?? "未命名收藏"}」，配图会一并删除。`);
  if (!confirmed) return;
  try {
    await deleteSavedPrompt(item.id);
    await refreshFavorites();
    setStatus("已删除收藏", "ok");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function createFavoriteFromNode() {
  const node = await pickInspectorNode();
  if (!node) return;
  const text = String(node.widgets?.find((widget) => widget.name === "text")?.value ?? "");
  openSavePromptDialog({ text, note: `节点 #${node.id}` }, async () => {
    await refreshFavorites();
    setStatus("已保存收藏", "ok");
  });
}

async function exportFavorites() {
  try {
    const bundle = await exportSavedPrompts();
    downloadJson(bundle, `saved-prompts-${new Date().toISOString().slice(0, 10)}.json`);
    setStatus("已导出收藏", "ok");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function importFavoritesFile(file) {
  try {
    const result = await importSavedPrompts(JSON.parse(await file.text()));
    await refreshFavorites();
    setStatus(`导入完成，新增 ${result?.imported ?? 0} 条`, "ok");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function buildFavoritesSection() {
  const section = element("div", "bpm-section");
  section.dataset.section = "favorites";
  const toolbar = element("div", "bpm-toolbar");
  refs.favoritesSearch = element("input", "bpi-search");
  refs.favoritesSearch.type = "search";
  refs.favoritesSearch.placeholder = "按名称或内容搜索";
  refs.favoritesSearch.addEventListener("input", renderFavorites);
  const importInput = element("input");
  importInput.type = "file";
  importInput.accept = ".json,application/json";
  importInput.style.display = "none";
  importInput.addEventListener("change", async () => {
    const file = importInput.files?.[0];
    importInput.value = "";
    if (file) await importFavoritesFile(file);
  });
  toolbar.append(
    refs.favoritesSearch,
    button("新建收藏", () => createFavoriteFromNode(), "bpi-primary"),
    button("导出", () => exportFavorites()),
    button("导入", () => importInput.click()),
    importInput,
  );
  refs.favoritesList = element("div", "bpm-rows");
  section.append(toolbar, refs.favoritesList);
  return section;
}

function renderAll() {
  renderRows();
  renderPacks();
}

function scheduleLargeSearch(query) {
  clearTimeout(manager.largeTimer);
  if (!query || !manager.data.large_dictionary?.available || !manager.data.large_dictionary?.enabled) {
    manager.largeGeneration += 1;
    manager.largeQuery = "";
    manager.largeMatches = [];
    manager.largeLoading = false;
    renderRows();
    return;
  }
  if (query === manager.largeQuery) return;
  manager.largeQuery = query;
  manager.largeMatches = [];
  manager.largeLoading = true;
  const generation = ++manager.largeGeneration;
  manager.largeTimer = setTimeout(async () => {
    try {
      const page = await searchLargeDictionary(query, 100);
      if (generation !== manager.largeGeneration || refs.search?.value.trim() !== query) return;
      manager.largeMatches = page.items ?? [];
    } catch (error) {
      if (generation === manager.largeGeneration) setStatus(error.message, "error");
    } finally {
      if (generation === manager.largeGeneration) {
        manager.largeLoading = false;
        renderRows();
      }
    }
  }, 260);
}

function inspectorNodes() {
  return (app.graph?._nodes ?? []).filter((node) => node._bilingualPromptInspector?.detailsBody);
}

function tagNodeLabel(node) {
  const text = String(node.widgets?.find((widget) => widget.name === "text")?.value ?? "").trim();
  return `节点 #${node.id}：${text ? text.slice(0, 30) : "（空提示词）"}`;
}

function buildTagManagerSection() {
  const section = element("div", "bpm-section");
  section.dataset.section = "tag-manager";
  section.hidden = true;
  const toolbar = element("div", "bpm-toolbar");
  const select = element("select", "bpi-mode");
  select.style.minWidth = "220px";
  const refresh = button("刷新节点列表", () => rebuildTagManagerSection());
  toolbar.append(element("span", "", "检查器节点："), select, refresh,
    element("span", "bpi-config-note", "标签翻译、词库搜索与逐标签操作在下方编辑当前选中的节点。"));
  select.addEventListener("change", () => {
    // ComfyUI 前端 1.16+ 的 node.id 是字符串（见 litegraph 的 toNodeId），
    // 用 Number() 会变成数字，导致下面 find 的严格比较永远失败、退回第一个节点。
    manager.tagManagerNodeId = String(select.value);
    rebuildTagManagerSection();
  });
  refs.tagManagerSelect = select;
  refs.tagManagerHost = element("div", "bpm-tagmanager-host");
  section.append(toolbar, refs.tagManagerHost);
  return section;
}

function rebuildTagManagerSection() {
  const select = refs.tagManagerSelect;
  const host = refs.tagManagerHost;
  if (!select || !host) return;
  const nodes = inspectorNodes();
  const previous = manager.tagManagerNodeId;
  host.replaceChildren();
  select.replaceChildren();
  if (!nodes.length) {
    select.disabled = true;
    const option = element("option", "", "画布上没有检查器节点");
    option.value = "";
    select.appendChild(option);
    host.appendChild(element("div", "bpi-empty", "添加或选中一个「双语提示词检查器」节点后，这里会显示它的标签管理界面。"));
    manager.tagManagerNodeId = null;
    return;
  }
  select.disabled = false;
  for (const node of nodes) {
    const option = element("option", "", tagNodeLabel(node));
    option.value = String(node.id);
    select.appendChild(option);
  }
  // 没有指定节点时优先落在画布上当前选中的那个，而不是永远第一个
  const target = nodes.find((node) => node.id === previous) ?? nodes.find((node) => node.selected) ?? nodes[0];
  select.value = String(target.id);
  manager.tagManagerNodeId = target.id;
  host.appendChild(target._bilingualPromptInspector.detailsBody);
  // detailsBody 的内容靠节点自身的 render 填充；换宿主后补一次同步渲染，
  // 否则刚挂进来时明细表可能是空的。
  target._bilingualPromptInspector.refreshAfterConfigure?.();
}

function build() {
  root = element("div", "bpm-panel");
  const head = element("div", "bpm-head");
  refs.status = element("span", "bpi-status");
  head.append(element("strong", "", "双语提示词管理"), refs.status);
  refs.tabs = element("div", "bpm-tabs");
  for (const [id, label] of SECTIONS) {
    const tab = button(label, () => setSection(id), `bpm-tab${id === manager.section ? " bpm-tab-active" : ""}`);
    tab.dataset.section = id;
    refs.tabs.appendChild(tab);
  }
  refs.sections = element("div", "bpm-sections");
  refs.sections.style.cssText = "flex:1;min-height:0;display:flex;flex-direction:column";
  refs.tagManagerSection = buildTagManagerSection();
  refs.sections.appendChild(refs.tagManagerSection);
  refs.sections.appendChild(buildTagsSection());
  refs.sections.appendChild(buildPacksSection());
  refs.assistantSection = buildAssistantPlaceholder();
  refs.sections.appendChild(refs.assistantSection);
  root.append(head, refs.tabs, refs.sections);
  root.addEventListener("mousedown", (event) => event.stopPropagation());
  root.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });
  // 面板每次都重建，收藏分页也要跟着重新懒加载
  manager.favoritesLoaded = false;
  if (manager.favoritesChangeHandler) {
    window.removeEventListener("bpi:saved-prompts-changed", manager.favoritesChangeHandler);
  }
  manager.favoritesChangeHandler = () => {
    if (manager.favoritesLoaded) refreshFavorites();
  };
  window.addEventListener("bpi:saved-prompts-changed", manager.favoritesChangeHandler);
}

function buildTagsSection() {
  const section = element("div", "bpm-section");
  section.dataset.section = "tags";
  const toolbar = element("div", "bpm-toolbar");
  refs.search = element("input", "bpi-search");
  refs.search.type = "search";
  refs.search.placeholder = "搜索英文、中文、别名或分类";
  refs.source = element("select", "bpi-mode");
  refs.category = element("select", "bpi-mode");
  toolbar.append(refs.search, refs.source, refs.category);
  refs.summary = element("div", "bpm-summary");
  refs.rows = element("div", "bpm-rows");
  const footer = element("div", "bpm-footer");
  const left = element("div", "bpi-toolbar-group");
  const right = element("div", "bpi-toolbar-group");
  const importInput = element("input");
  importInput.type = "file";
  importInput.accept = ".json,application/json";
  importInput.style.display = "none";
  importInput.addEventListener("change", async () => {
    const file = importInput.files?.[0];
    importInput.value = "";
    if (!file) return;
    try {
      openImportPreview(JSON.parse(await file.text()));
    } catch (error) {
      setStatus(error.message, "error");
    }
  });
  left.append(
    button("新增标签", () => openTagDialog({}, refresh), "bpi-primary"),
    button("确认所选机器译", () => {
      const rows = managerRows().filter((row) => row.kind === "machine" && manager.selected.has(`machine:${row.key}`));
      confirmMachineRows(rows);
    }),
    button("批量分类/模型", async () => {
      const rows = managerRows().filter((row) => row.kind === "personal" && manager.selected.has(`personal:${row.key}`));
      if (!rows.length) { setStatus("批量修改仅适用于已勾选的个人词条", "error"); return; }
      const category = window.prompt("新的分类（留空表示不修改分类）：", rows[0].tag.category ?? "");
      if (category === null) return;
      const models = window.prompt("适用模型，用逗号分隔（留空表示不修改模型）：", (rows[0].tag.models ?? []).join(", "));
      if (models === null) return;
      const updates = {};
      if (category.trim()) updates.category = category.trim();
      if (models.trim()) updates.models = models;
      if (!Object.keys(updates).length) return;
      try {
        const result = await bulkUpdateTags(rows.map((row) => row.tag.english), updates);
        await refresh();
        setStatus(`已批量修改 ${result.updated} 项，并自动备份个人词库`, "ok");
      } catch (error) { setStatus(error.message, "error"); }
    }),
    button("导入", () => importInput.click()),
    button("导出", async () => {
      try {
        const payload = await exportPersonalDictionary();
        downloadJson(payload, `bpi-user-tags-${new Date().toISOString().slice(0, 10)}.json`);
        setStatus(`已导出 ${payload.tags?.length ?? 0} 个个人标签`, "ok");
      } catch (error) { setStatus(error.message, "error"); }
    }),
  );
  right.append(button("刷新", () => refresh()));
  footer.append(left, right);
  refs.search.addEventListener("input", () => {
    renderRows();
    scheduleLargeSearch(refs.search.value.trim());
  });
  refs.source.addEventListener("change", renderRows);
  refs.category.addEventListener("change", renderRows);
  section.append(toolbar, refs.summary, refs.rows, footer, importInput);
  return section;
}

function buildPacksSection() {
  const section = element("div", "bpm-section");
  section.dataset.section = "packs";
  section.hidden = true;
  const toolbar = element("div", "bpm-toolbar");
  const communityInput = element("input");
  communityInput.type = "file";
  communityInput.accept = ".json,application/json";
  communityInput.style.display = "none";
  communityInput.addEventListener("change", async () => {
    const file = communityInput.files?.[0];
    communityInput.value = "";
    if (!file) return;
    try {
      openCommunityPackPreview(JSON.parse(await file.text()), file.name);
    } catch (error) {
      setStatus(`社区包文件读取失败：${error.message}`, "error");
    }
  });
  toolbar.append(
    button("导入社区词库包", () => communityInput.click(), "bpi-primary"),
    button("刷新", () => refresh()),
  );
  refs.packList = element("div", "bpi-pack-list");
  section.append(toolbar, refs.packList, communityInput);
  return section;
}

function buildAssistantPlaceholder() {
  const section = element("div", "bpm-section");
  section.dataset.section = "assistant";
  section.hidden = true;
  section.appendChild(element("div", "bpm-loading", "切换到本页时读取设置…"));
  return section;
}

function renderTab(container) {
  if (!root) build();
  container.replaceChildren(root);
  setSection(manager.section);
  if (!manager.loaded) {
    manager.loaded = true;
    refresh(false);
  } else {
    renderAll();
  }
}

function destroyTab() {
  clearTimeout(manager.largeTimer);
  manager.largeGeneration += 1;
  refs.tagManagerHost?.replaceChildren?.();
}

injectBpiStyles();
installBpiWheelGuard();

app.registerExtension({
  name: "ComfyUI.BilingualPromptInspector.ManagerPanel",
  async setup() {
    if (!app.extensionManager?.registerSidebarTab) {
      console.warn("[BilingualPromptInspector] 当前 ComfyUI 前端不支持侧边栏，管理面板不可用");
      return;
    }
    app.extensionManager.registerSidebarTab({
      id: MANAGER_TAB_ID,
      icon: "pi pi-language",
      title: "双语提示词管理",
      tooltip: "双语提示词检查器：标签管理、词库、词库包与助手设置",
      type: "custom",
      render: renderTab,
      destroy: destroyTab,
    });
    window.addEventListener(MANAGER_OPEN_EVENT, (event) => {
      if (event.detail?.section === "tag-manager" && event.detail?.nodeId != null) {
        manager.tagManagerNodeId = event.detail.nodeId;
      }
      setSection(event.detail?.section ?? "tags");
    });
  },
});

panelSyncHub.subscribe((kind, source) => {
  if (source === manager.syncSource) return;
  if (kind === "dictionary") {
    refresh(false);
  } else if (kind === "preferences") {
    manager.preferences = loadPreferences();
    renderRows();
  } else if (kind === "machine") {
    renderRows();
  }
});

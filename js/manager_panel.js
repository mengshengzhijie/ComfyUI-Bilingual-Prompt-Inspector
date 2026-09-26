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
  applyBpiAppearance,
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
  setLanguageMode,
  setLargeDictionaryEnabled,
  setPackEnabled,
  setPlaceholder,
  setText,
  setTitle,
  t,
  testAssistantConnection,
} from "./bpi_shared.js";

const SECTIONS = [
  ["tag-manager", "Tag Manager"],
  ["tags", "Dictionary"],
  ["packs", "Packs"],
  ["assistant", "Assistant Settings"],
  ["favorites", "Favorites"],
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
  setText(refs.status, message);
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
      category: "Unconfirmed",
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
    ["all", "All Packs"],
    ["builtin", "Built-in pack enabled"],
    ["personal", "Personal"],
    ...(manager.data.large_dictionary?.available ? [["large", "Danbooru Large Dict"]] : []),
    ["machine", "Pending Machine"],
    ["favorites", "Favorites"],
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
  const all = element("option", "", "All Categories");
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
    setStatus("Please check unconfirmed machine translations first", "error");
    return;
  }
  try {
    const imported = await importTags(rows.map((row) => ({ ...row.tag, verified: true })), "overwrite");
    for (const row of rows) {
      deleteMachineTranslation(row.key);
      manager.selected.delete(`machine:${row.key}`);
    }
    await refresh();
    setStatus(`Confirmed ${imported.added + imported.replaced} entries; personal dictionary backed up`, "ok");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function retranslateMachineRow(row) {
  setStatus(`Translating: “${row.tag.english}”`, "busy");
  try {
    const translated = await runInspectorAssistant("translate", row.tag.english);
    const validation = validateTranslationResult(row.tag.english, translated, {});
    if (!validation.ok) {
      setStatus(`Rejected invalid translation: “${validation.reason}”`, "error");
      return;
    }
    panelSyncHub.machineTranslations.set(row.key, {
      english: row.tag.english,
      text: validation.text,
      source: "bpi-assistant",
      createdAt: Date.now(),
    });
    panelSyncHub.notify("machine", manager.syncSource);
    setStatus(`Re-translated “${row.tag.english}”`, "ok");
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
  headerTop.append(selectAll, element("span", "bpm-row-en", `Select all (${rows.length} items)`));
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
    setTitle(english, tag.aliases?.length ? `Aliases: ${tag.aliases.join(", ")}` : tag.english);
    top.append(checkbox, english);
    if (tag.category) top.appendChild(element("span", "bpi-badge", tag.category));
    item.appendChild(top);
    item.appendChild(element("div", "bpm-row-zh", tag.chinese));
    const meta = element("div", "bpm-row-meta");
    const sourceName = kind === "machine" ? "Machine" : kind === "personal" ? "Personal" : kind === "large" ? "Danbooru Large Dict" : (tag.pack_name ?? "Built-in");
    meta.appendChild(element("span", "", sourceName));
    const star = button(isFavorite(tag.english) ? "★ Unfavorite" : "☆ Favorite", () => {
      changeFavorite(tag.english);
      renderRows();
    }, `bpi-mini${isFavorite(tag.english) ? " bpi-star bpi-starred" : ""}`);
    meta.appendChild(star);
    item.appendChild(meta);
    const actions = element("div", "bpm-actions");
    actions.appendChild(button("Copy", async () => {
      try {
        await navigator.clipboard.writeText(tag.english);
        setStatus(`Copied “${tag.english}”`, "ok");
      } catch {
        setStatus("Browser denied clipboard write", "error");
      }
    }, "bpi-mini"));
    if (kind === "machine") {
      actions.append(
        button("Confirm", () => confirmMachineRows([row]), "bpi-mini bpi-primary"),
        button("Re-translate", () => retranslateMachineRow(row), "bpi-mini"),
        button("Delete pending", () => {
          deleteMachineTranslation(key);
          manager.selected.delete(id);
          renderRows();
        }, "bpi-mini"),
      );
    } else {
      actions.appendChild(button(kind === "large" ? "Save Personal" : "Edit", () => openTagDialog(tag, refresh), "bpi-mini"));
      if (kind === "personal") {
        const hasBuiltin = manager.data.builtin.some((item2) => normalizeKey(item2.english) === normalizeKey(tag.english));
        actions.appendChild(button(hasBuiltin ? "Reset Built-in" : "Delete", async () => {
          if (!window.confirm(`${hasBuiltin ? "Delete override & restore built-in" : "Delete Personal Tag"}“${tag.english}”?`)) return;
          try {
            await deletePersonalTag(tag.english);
            manager.selected.delete(id);
            await refresh();
            setStatus(`Processed “${tag.english}”`, "ok");
          } catch (error) { setStatus(error.message, "error"); }
        }, "bpi-mini bpi-danger"));
      }
    }
    item.appendChild(actions);
    refs.rows.appendChild(item);
  }
  if (manager.largeLoading) refs.rows.appendChild(element("div", "bpm-loading", "Querying Danbooru large dictionary..."));
  if (!rows.length && !manager.largeLoading) {
    const emptyText = source === "large" && !query
      ? "Large dictionary loads on demand; enter English or Chinese keywords above."
      : "No entries match the current filter.";
    refs.rows.appendChild(element("div", "bpm-loading", emptyText));
  }
  const large = manager.data.large_dictionary;
  // 分段翻译再拼：大词库有「未安装 / 按需 / 已停用」三种形态，整句做键会漏掉其中几种
  const largeSummary = large?.available
    ? t(`Large ${large.count} (${large.enabled ? "on-demand" : "disabled"})`)
    : t("Large not installed");
  const enabledPacks = (manager.data.packs ?? []).filter((pack) => pack.enabled).length;
  setText(refs.summary, [
    t(`Showing ${rows.length}`),
    t(`Selected ${manager.selected.size}`),
    t(`Enabled packs ${enabledPacks}/${manager.data.packs?.length ?? 0}`),
    t(`Built-in ${manager.data.builtin.length}`),
    largeSummary,
    t(`Personal ${manager.data.user.length}`),
    t(`Pending ${machineRows().length}`),
  ].join(" | "));
}

function renderPacks() {
  if (!refs.packList) return;
  refs.packList.replaceChildren();
  const personalCard = element("div", "bpi-pack-card bpi-pack-personal");
  const personalMarker = element("span", "bpi-badge bpi-confidence-high", "Highest");
  const personalBody = element("div");
  personalBody.append(element("div", "bpi-pack-name", "Personal"), element("div", "bpi-pack-meta", `${manager.data.user.length} items | Local user | Always enabled, overrides same-name entries`));
  personalCard.append(personalMarker, personalBody, element("div", "bpi-pack-controls", "Cannot disable"));
  refs.packList.appendChild(personalCard);
  const large = manager.data.large_dictionary;
  if (large) {
    const card = element("div", `bpi-pack-card${large.enabled && large.available ? "" : " bpi-pack-disabled"}`);
    const toggle = element("input", "bpi-switch");
    toggle.type = "checkbox";
    toggle.checked = Boolean(large.enabled);
    toggle.disabled = !large.available;
    setTitle(toggle, large.available ? "Enable or disable large dictionary on-demand lookup" : "Large dictionary database not installed");
    toggle.addEventListener("change", async () => {
      toggle.disabled = true;
      try {
        await setLargeDictionaryEnabled(toggle.checked);
        await refresh();
        manager.largeMatches = [];
        manager.largeQuery = "";
        setStatus(`${toggle.checked ? "Enabled" : "Disabled"} Danbooru Large Dict`, "ok");
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
        ? `${large.count} items | v“${large.version}” | “${large.source}” | read-only, on-demand`
        : "Database not installed | small dictionaries unaffected"),
    );
    const controls = element("div", "bpi-pack-controls", large.available ? "Read-only" : "Unavailable");
    card.append(toggle, body, controls);
    refs.packList.appendChild(card);
  }
  for (const pack of manager.data.packs ?? []) {
    const card = element("div", `bpi-pack-card${pack.enabled ? "" : " bpi-pack-disabled"}`);
    const toggle = element("input", "bpi-switch");
    toggle.type = "checkbox";
    toggle.checked = Boolean(pack.enabled);
    setTitle(toggle, pack.enabled ? "Click to disable this pack" : "Click to enable this pack");
    toggle.addEventListener("change", async () => {
      toggle.disabled = true;
      try {
        await setPackEnabled(pack.id, toggle.checked);
        await refresh();
        manager.selected.clear();
        setStatus(`${toggle.checked ? "Enabled" : "Disabled"} “${pack.name}”`, "ok");
      } catch (error) {
        setStatus(error.message, "error");
        toggle.checked = !toggle.checked;
        toggle.disabled = false;
      }
    });
    const body = element("div");
    body.append(
      element("div", "bpi-pack-name", pack.name),
      element("div", "bpi-pack-meta", `${pack.count} items | v“${pack.version}” | “${pack.source}”${pack.license ? ` | License “${pack.license}”` : ""}`),
    );
    const controls = element("div", "bpi-pack-controls");
    controls.appendChild(button("Export", async () => {
      try {
        const payload = await exportDictionaryPack(pack.id);
        downloadJson(payload, `bpi-pack-${pack.id}-${new Date().toISOString().slice(0, 10)}.json`);
        setStatus(`Exported “${pack.name}”`, "ok");
      } catch (error) { setStatus(error.message, "error"); }
    }, "bpi-mini"));
    if (!pack.readonly) {
      controls.appendChild(button("Delete", async () => {
        if (!window.confirm(`Delete community pack “${pack.name}”? File is backed up first; recoverable from data/backups.`)) return;
        try {
          await deleteCommunityPack(pack.id);
          await refresh();
          manager.selected.clear();
          setStatus(`Deleted and backed up “${pack.name}”`, "ok");
        } catch (error) { setStatus(error.message, "error"); }
      }, "bpi-mini bpi-danger"));
    }
    card.append(toggle, body, controls);
    refs.packList.appendChild(card);
  }
}

function openCommunityPackPreview(payload, filename) {
  if (!payload || !Array.isArray(payload.tags)) {
    setStatus("Community dictionary file must contain a tags array", "error");
    return;
  }
  const shade = element("div", "bpi-modal-shade");
  const modal = element("div", "bpi-modal");
  modal.appendChild(element("h3", "", "Import as community pack"));
  const form = element("div", "bpi-community-form");
  const metadata = payload.pack && typeof payload.pack === "object" ? payload.pack : {};
  const fallbackName = String(filename ?? "community-pack.json").replace(/\.json$/i, "");
  const fields = {};
  for (const [key, label, value, placeholder] of [
    ["name", "Pack Name", metadata.name ?? fallbackName, "e.g.: community pose extension"],
    ["id", "Pack ID (optional)", metadata.id ?? "", "English, numbers, hyphens"],
    ["version", "Version", metadata.version ?? "1.0.0", "e.g.: 1.0.0"],
    ["source", "Source", metadata.source ?? "Community Import", "Community or author name"],
    ["license", "License (optional)", metadata.license ?? "", "e.g.: CC BY 4.0"],
    ["homepage", "Homepage (optional)", metadata.homepage ?? "", "Records source only; no automatic access"],
  ]) {
    form.appendChild(element("label", "", label));
    const input = element("input");
    input.value = value;
    setPlaceholder(input, placeholder);
    fields[key] = input;
    form.appendChild(input);
  }
  modal.appendChild(form);
  const preview = element("div", "bpi-community-preview");
  const sampleText = payload.tags.slice(0, 8).map((tag) => `${tag?.english ?? "?"} → ${tag?.chinese ?? "?"}`).join("; ");
  setText(preview, `${t(`Tags ${payload.tags.length}`)} | ${t("Sample")}: ${sampleText}`);
  modal.appendChild(preview);
  const overwriteLine = element("label", "bpm-toolbar");
  const overwrite = element("input");
  overwrite.type = "checkbox";
  overwriteLine.append(overwrite, element("span", "", "Overwrite if same pack ID exists (auto-backup before update)"));
  modal.appendChild(overwriteLine);
  const error = element("div", "bpi-status");
  error.dataset.kind = "error";
  modal.appendChild(error);
  const actions = element("div", "bpi-modal-actions");
  const close = () => shade.remove();
  const confirm = button("Import Community Pack", async () => {
    if (!fields.name.value.trim()) { setText(error, "Pack name cannot be empty"); return; }
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
      setStatus(`${result.replaced ? t("Updated") : t("Imported")} ${t(`community pack “${result.name}”, ${result.count} items`)}`, "ok");
    } catch (importError) {
      setText(error, importError.message);
      confirm.disabled = false;
    }
  }, "bpi-primary");
  actions.append(button("Cancel", close), confirm);
  modal.appendChild(actions);
  shade.appendChild(modal);
  document.body.appendChild(shade);
  shade.addEventListener("mousedown", (event) => { if (event.target === shade) close(); });
  modal.addEventListener("mousedown", (event) => event.stopPropagation());
  setTimeout(() => fields.name.focus(), 0);
}

function openImportPreview(payload) {
  if (!payload || !Array.isArray(payload.tags)) {
    setStatus("No tags array in file", "error");
    return;
  }
  const report = previewImport(payload.tags, manager.data.tags);
  const shade = element("div", "bpi-modal-shade");
  const modal = element("div", "bpi-modal");
  modal.appendChild(element("h3", "", "Import Personal Dictionary Preview"));
  const stats = element("div", "bpi-import-stat");
  stats.append(
    element("span", "", `Total ${report.total}`),
    element("span", "", `Added ${report.added}`),
    element("span", "", `Conflicts ${report.conflicts.length}`),
    element("span", "", `Duplicates ${report.duplicates}`),
    element("span", report.invalid ? "bpi-danger-text" : "", `Invalid ${report.invalid}`),
  );
  modal.appendChild(stats);
  const explanation = element("p", "", "Current personal dictionary is backed up before import. You can keep current explanations, use imported ones, or merge different Chinese texts as aliases. Built-in files are never modified.");
  modal.appendChild(explanation);
  if (report.conflicts.length) {
    const conflicts = element("div", "bpi-import-conflicts");
    const header = element("div", "bpi-import-conflict");
    header.append(element("strong", "", "English"), element("strong", "", "Current explanation"), element("strong", "", "Imported explanation"));
    conflicts.appendChild(header);
    for (const conflict of report.conflicts.slice(0, 100)) {
      const row = element("div", "bpi-import-conflict");
      row.append(element("span", "", conflict.english), element("span", "", conflict.current), element("span", "", conflict.incoming));
      conflicts.appendChild(row);
    }
    modal.appendChild(conflicts);
  }
  const modeLine = element("div", "bpm-toolbar");
  const modeLabel = element("label", "", "Conflict:");
  const mode = element("select", "bpi-mode");
  for (const [value, label] of [["skip", "Keep current explanations"], ["overwrite", "Use imported explanations"], ["alias", "Import as Chinese aliases"]]) {
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
  const confirm = button("Confirm Import", async () => {
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
      setStatus(`Import complete: added ${imported.added}, overwrote ${imported.replaced}, skipped ${imported.skipped} | auto-backed up`, "ok");
    } catch (importError) {
      setText(error, importError.message);
      confirm.disabled = false;
    }
  }, "bpi-primary");
  if (report.invalid) {
    confirm.disabled = true;
    setText(error, "Import file contains invalid entries missing English or Chinese; please fix the file first.");
  }
  actions.append(button("Cancel", close), confirm);
  modal.appendChild(actions);
  shade.appendChild(modal);
  document.body.appendChild(shade);
  shade.addEventListener("mousedown", (event) => { if (event.target === shade) close(); });
  modal.addEventListener("mousedown", (event) => event.stopPropagation());
}

async function buildAssistantSection(section) {
  section.replaceChildren();
  const loading = element("div", "bpm-loading", "Loading settings...");
  section.appendChild(loading);
  let config;
  try {
    config = await getAssistantConfig();
  } catch (error) {
    setText(loading, error.message);
    loading.classList.add("bpi-danger-text");
    return;
  }
  manager.assistantLoaded = true;
  applyBpiAppearance(config.appearance);
  section.replaceChildren();
  const form = element("form", "bpi-form");
  form.addEventListener("submit", (event) => event.preventDefault());
  const error = element("div", "bpi-status");
  error.style.gridColumn = "1 / -1";

  // 翻译服务：翻译/解释按此选择；“翻译并优化”“优化为 Anima”恒走 AI
  const serviceLabel = element("label", "", "Translation Service");
  const service = element("select");
  for (const [value, label] of [
    ["dictionary", "Dictionary only (no API)"],
    ["baidu", "Baidu Translate"],
    ["ai", "AI (OpenAI-compatible / Ollama)"],
  ]) {
    const option = element("option", "", label);
    option.value = value;
    service.appendChild(option);
  }
  service.value = config.translate_service;
  form.append(serviceLabel, service);
  const serviceNote = element("div", "bpi-config-note", 'Translation/explanation uses this choice. "Translate & Optimize" and "Optimize to Anima" always use AI, unrelated here. To test AI connection, temporarily set translation service to AI then click test (key preserved).');
  serviceNote.style.gridColumn = "1 / -1";
  form.append(serviceNote);

  // 百度翻译（独立留存，切翻译服务不清）
  const baiduHead = element("div", "bpm-toolbar");
  baiduHead.style.gridColumn = "1 / -1";
  baiduHead.append(element("strong", "", "Baidu Translate"));
  form.append(baiduHead);
  const baiduAppId = field(form, "APP ID", "assistant-baidu-appid", config.baidu_appid, 'Baidu Cloud "General Text Translation" APP ID');
  const baiduSecretKey = field(form, "Secret Key", "assistant-baidu-secret", "", config.baidu_secret_key_configured ? "Saved; leave empty to keep" : 'Baidu Cloud "General Text Translation" Secret Key');
  baiduSecretKey.type = "password";
  const clearBaiduLine = element("label", "bpm-toolbar");
  const clearBaiduSecretKey = element("input");
  clearBaiduSecretKey.type = "checkbox";
  clearBaiduLine.append(clearBaiduSecretKey, element("span", "", "Clear saved Baidu secret"));
  const baiduSpacer = element("span");
  form.append(baiduSpacer, clearBaiduLine);

  // AI 服务（优化恒走它；翻译在选 AI 时也走它）
  const aiHead = element("div", "bpm-toolbar");
  aiHead.style.gridColumn = "1 / -1";
  aiHead.append(element("strong", "", "AI Service (Translate & Optimize / Optimize / AI Translate)"));
  form.append(aiHead);
  const aiProviderLabel = element("label", "", "AI Backend");
  const aiProvider = element("select");
  for (const [value, label] of [["openai_compatible", "OpenAI-compatible API"], ["ollama", "Ollama (local)"]]) {
    const option = element("option", "", label);
    option.value = value;
    aiProvider.appendChild(option);
  }
  aiProvider.value = config.ai_provider;
  form.append(aiProviderLabel, aiProvider);
  const baseUrl = field(form, "API URL", "assistant-base-url", config.ai_base_url, "Optional for Ollama; e.g.: https://host/v1");
  const model = field(form, "Model Name", "assistant-model", config.ai_model, "e.g.: qwen3:8b or provider model ID");
  const presetLine = element("div", "bpm-toolbar");
  presetLine.style.gridColumn = "1 / -1";
  const lmStudioPreset = button("Use LM Studio Local Preset", () => {
    aiProvider.value = "openai_compatible";
    baseUrl.value = "http://127.0.0.1:1234/v1";
    setText(error, "LM Studio default URL filled; select a loaded model ID, then Save & Test");
    error.dataset.kind = "ok";
  });
  presetLine.append(lmStudioPreset, element("span", "bpi-config-note", "Connects to localhost:1234 by default; no external API required."));
  form.append(presetLine);
  const apiKey = field(form, "API Key", "assistant-api-key", "", config.ai_api_key_configured ? "Saved; leave empty to keep" : "Optional for local Ollama / LM Studio");
  apiKey.type = "password";
  const clearLine = element("label", "bpm-toolbar");
  const clearApiKey = element("input");
  clearApiKey.type = "checkbox";
  clearLine.append(clearApiKey, element("span", "", "Clear saved API Key"));
  const apiKeySpacer = element("span");
  form.append(apiKeySpacer, clearLine);
  const temperature = field(form, "Temperature", "assistant-temperature", config.ai_temperature, "0–2");
  temperature.type = "number";
  temperature.min = "0";
  temperature.max = "2";
  temperature.step = "0.05";
  const timeout = field(form, "Timeout (s)", "assistant-timeout", config.ai_timeout_seconds, "5–600");
  timeout.type = "number";
  timeout.min = "5";
  timeout.max = "600";

  // 外观模式
  const appearanceLabel = element("label", "", "Appearance");
  const appearanceSelect = element("select");
  for (const [value, label] of [
    ["auto", "Follow ComfyUI"],
    ["dark", "Dark"],
    ["light", "Light"],
  ]) {
    const option = element("option", "", label);
    option.value = value;
    appearanceSelect.appendChild(option);
  }
  appearanceSelect.value = config.appearance || "auto";
  form.append(appearanceLabel, appearanceSelect);

  // 界面语言：auto 跟随 ComfyUI 的 Comfy.Locale，zh / en 强制指定
  const languageLabel = element("label", "", "Language");
  const languageSelect = element("select");
  for (const [value, label] of [
    ["auto", "Follow ComfyUI language setting"],
    ["zh", "Chinese"],
    ["en", "English"],
  ]) {
    const option = element("option", "", label);
    option.value = value;
    languageSelect.appendChild(option);
  }
  languageSelect.value = config.language || "auto";
  form.append(languageLabel, languageSelect);
  const languageNote = element("div", "bpi-config-note", "Choose the language for this plugin's own panels. \"Follow ComfyUI\" reads the ComfyUI language setting; \"Chinese\" and \"English\" force one. Applied to open panels right away; reload the page if anything still shows the old language.");
  languageNote.style.gridColumn = "1 / -1";
  form.append(languageNote);

  // 规则
  const addRule = (labelText, value) => {
    const labelElement = element("label", "", labelText);
    const textarea = element("textarea");
    textarea.value = value;
    form.append(labelElement, textarea);
    return { labelElement, textarea };
  };
  const translationRule = addRule("Translation Rule", config.translation_rule);
  const translateOptimizeRule = addRule("Translate & Optimize Rule", config.translate_optimize_rule);
  const optimizationRule = addRule("Optimize Rule", config.optimization_rule);
  form.appendChild(error);

  section.appendChild(form);
  section.appendChild(element("div", "bpi-config-note", "Settings are stored in the ComfyUI user directory. AI key and Baidu secret are retained independently; switching service never clears either. AI key is only cleared when AI backend/URL changes or on a different machine. Neither is written to workflows or returned to the browser."));
  const actions = element("div", "bpm-assistant-actions");
  const resetButton = button("Reset to Default Rules", () => {
    translationRule.textarea.value = config.default_translation_rule;
    translateOptimizeRule.textarea.value = config.default_translate_optimize_rule;
    optimizationRule.textarea.value = config.default_optimization_rule;
    setText(error, "Defaults restored in editor; click Save to apply");
    error.dataset.kind = "ok";
  });
  const testButton = button("Save & Test Connection", async () => {
    testButton.disabled = true;
    setText(error, "Testing...");
    error.dataset.kind = "busy";
    try {
      config = await saveAssistantConfig(payload());
      setLanguageMode(config.language);
      const result = await testAssistantConnection();
      setText(error, `Connection OK: “${result.message}”`);
      error.dataset.kind = "ok";
    } catch (testError) {
      setText(error, testError.message);
      error.dataset.kind = "error";
    } finally {
      testButton.disabled = false;
    }
  });
  const saveButton = button("Save Settings", async () => {
    saveButton.disabled = true;
    try {
      config = await saveAssistantConfig(payload());
      applyBpiAppearance(config.appearance);
      setLanguageMode(config.language);
      setText(error, "Assistant settings saved");
      error.dataset.kind = "ok";
    } catch (saveError) {
      setText(error, saveError.message);
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
    appearance: appearanceSelect.value,
    language: languageSelect.value,
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

function confirmDialog(title, message, confirmLabel = "OK") {
  return new Promise((resolve) => {
    const shade = element("div", "bpi-modal-shade");
    const modal = element("div", "bpi-modal");
    const actions = element("div", "bpi-modal-actions");
    const close = (value) => {
      shade.remove();
      resolve(value);
    };
    actions.append(button("Cancel", () => close(false)), button(confirmLabel, () => close(true), "bpi-primary"));
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
    setStatus("No inspector node on canvas", "error");
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
    actions.append(button("Cancel", () => {
      shade.remove();
      resolve(null);
    }));
    modal.append(element("h3", "", "Select a node to save"), list, actions);
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
  else setText(thumb, "No image");
  const info = element("div", "bpi-fav-info");
  const name = element("span", "bpi-fav-name", item.name ?? "Untitled");
  name.appendChild(element("span", "bpi-fav-date", favoriteDate(item.created_at)));
  const actions = element("div", "bpi-fav-actions");
  actions.append(
    button("Load to Node", () => loadFavoriteIntoNode(item), "bpi-primary"),
    button("Copy", () => copyFavorite(item)),
    button("Delete", () => removeFavorite(item), "bpi-danger"),
  );
  info.append(
    name,
    element("div", "bpi-fav-text", item.text ?? ""),
    element("div", "bpi-fav-meta", item.note || "Source node not recorded"),
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
      ? "No matching favorites."
      : "No favorites yet. Click the star button on a node to save the current prompt."));
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
    setStatus("Prompt copied to clipboard", "ok");
  } catch {
    setStatus("Browser denied clipboard access", "error");
  }
}

async function loadFavoriteIntoNode(item) {
  const target = targetInspectorNode();
  if (!target) {
    setStatus("No inspector node on canvas", "error");
    return;
  }
  const confirmed = await confirmDialog(
    "Load",
    `This will overwrite node #${target.id} prompt. Cannot be undone with Ctrl+Z.`,
  );
  if (!confirmed) return;
  target._bilingualPromptInspector?.setText?.(item.text ?? "");
  setStatus(`Loaded to node #${target.id}`, "ok");
}

async function removeFavorite(item) {
  const confirmed = await confirmDialog("Delete", `Delete “${item.name ?? t("Untitled")}”? Reference image will be deleted too.`);
  if (!confirmed) return;
  try {
    await deleteSavedPrompt(item.id);
    await refreshFavorites();
    setStatus("Deleted", "ok");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function createFavoriteFromNode() {
  const node = await pickInspectorNode();
  if (!node) return;
  const text = String(node.widgets?.find((widget) => widget.name === "text")?.value ?? "");
  openSavePromptDialog({ text, note: `Node #${node.id}` }, async () => {
    await refreshFavorites();
    setStatus("Saved", "ok");
  });
}

async function exportFavorites() {
  try {
    const bundle = await exportSavedPrompts();
    downloadJson(bundle, `saved-prompts-${new Date().toISOString().slice(0, 10)}.json`);
    setStatus("Exported", "ok");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function importFavoritesFile(file) {
  try {
    const result = await importSavedPrompts(JSON.parse(await file.text()));
    await refreshFavorites();
    setStatus(`Import complete: ${result?.imported ?? 0} added`, "ok");
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
  setPlaceholder(refs.favoritesSearch, "Search by name or content");
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
    button("New", () => createFavoriteFromNode(), "bpi-primary"),
    button("Export", () => exportFavorites()),
    button("Import", () => importInput.click()),
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
  return `${t(`Node #${node.id}`)}: ${text ? text.slice(0, 30) : t("(empty prompt)")}`;
}

function buildTagManagerSection() {
  const section = element("div", "bpm-section");
  section.dataset.section = "tag-manager";
  section.hidden = true;
  const toolbar = element("div", "bpm-toolbar");
  const select = element("select", "bpi-mode");
  select.style.minWidth = "220px";
  const refresh = button("Refresh node list", () => rebuildTagManagerSection());
  toolbar.append(element("span", "", "Inspector node:"), select, refresh,
    element("span", "bpi-config-note", "Tag translation, dictionary search and per-tag operations edit the selected node below."));
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
    const option = element("option", "", "No inspector node on canvas");
    option.value = "";
    select.appendChild(option);
    host.appendChild(element("div", "bpi-empty", "Add or select a BilingualPromptInspector node to see its tag manager here."));
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
  head.append(element("strong", "", "Bilingual Prompt Manager"), refs.status);
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
  setPlaceholder(refs.search, "Search English, Chinese, aliases or category");
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
    button("New Tag", () => openTagDialog({}, refresh), "bpi-primary"),
    button("Confirm selected", () => {
      const rows = managerRows().filter((row) => row.kind === "machine" && manager.selected.has(`machine:${row.key}`));
      confirmMachineRows(rows);
    }),
    button("Bulk Category/Models", async () => {
      const rows = managerRows().filter((row) => row.kind === "personal" && manager.selected.has(`personal:${row.key}`));
      if (!rows.length) { setStatus("Bulk edit applies only to checked personal entries", "error"); return; }
      const category = window.prompt("New category (empty = no change):", rows[0].tag.category ?? "");
      if (category === null) return;
      const models = window.prompt("Applicable models, comma-separated (empty = no change):", (rows[0].tag.models ?? []).join(", "));
      if (models === null) return;
      const updates = {};
      if (category.trim()) updates.category = category.trim();
      if (models.trim()) updates.models = models;
      if (!Object.keys(updates).length) return;
      try {
        const result = await bulkUpdateTags(rows.map((row) => row.tag.english), updates);
        await refresh();
        setStatus(`Updated ${result.updated} entries; personal dictionary backed up`, "ok");
      } catch (error) { setStatus(error.message, "error"); }
    }),
    button("Import", () => importInput.click()),
    button("Export", async () => {
      try {
        const payload = await exportPersonalDictionary();
        downloadJson(payload, `bpi-user-tags-${new Date().toISOString().slice(0, 10)}.json`);
        setStatus(`Exported ${payload.tags?.length ?? 0} personal tags`, "ok");
      } catch (error) { setStatus(error.message, "error"); }
    }),
  );
  right.append(button("Refresh", () => refresh()));
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
      setStatus(`Community pack read failed: “${error.message}”`, "error");
    }
  });
  toolbar.append(
    button("Import Community Pack", () => communityInput.click(), "bpi-primary"),
    button("Refresh", () => refresh()),
  );
  refs.packList = element("div", "bpi-pack-list");
  section.append(toolbar, refs.packList, communityInput);
  return section;
}

function buildAssistantPlaceholder() {
  const section = element("div", "bpm-section");
  section.dataset.section = "assistant";
  section.hidden = true;
  section.appendChild(element("div", "bpm-loading", "Settings load on first visit..."));
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
// 启动时把后端保存的外观 / 语言设置拉下来；语言还会顺带整树重刷一次已渲染的面板
getAssistantConfig()
  .then((cfg) => {
    applyBpiAppearance(cfg.appearance);
    setLanguageMode(cfg.language);
  })
  .catch(() => {});

app.registerExtension({
  name: "ComfyUI.BilingualPromptInspector.ManagerPanel",
  async setup() {
    if (!app.extensionManager?.registerSidebarTab) {
      console.warn("[BilingualPromptInspector] Current frontend does not support sidebar; panel unavailable");
      return;
    }
    app.extensionManager.registerSidebarTab({
      id: MANAGER_TAB_ID,
      icon: "pi pi-language",
      // 侧边栏标签显示的就是插件名，直接写中文：注册发生在启动时，
      // 语言设置要等后端配置返回才落地，走 t() 会先渲染成英文且不会再刷新。
      title: "提示词翻译与管理",
      tooltip: "提示词翻译与管理：标签管理、词库、词包与助手设置",
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

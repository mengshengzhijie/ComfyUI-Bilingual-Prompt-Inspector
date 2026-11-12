// 收藏库的树视图：文件夹 + 条目，拖动排序 / 拖进文件夹，默认全部收起。
//
// 几个约定（和存储层对齐）：
// - 展开状态只存在内存里：刷新页面才回到「全部收起」，切窗口、关侧边栏都不影响；
// - 拖动不加任何过渡动画，松手直接重排；
// - 缩进只缩一层（12px），不做层层加深，避免长条目被挤成窄条；
// - 文件夹的箭头放在最右边。
import { bpiFetch, button, element, setPlaceholder, setText } from "./bpi_shared.js";

const API_ROOT = "/bpi/library";

// 文件夹的淡色：只影响行的底色，渲染时统一加 12% 透明度（#rrggbb + "1f"）
const FOLDER_COLORS = ["#4ca7e8", "#5ec9a3", "#e8b85c", "#cbb1ff", "#ff8b93", "#86d5c4", "#e2ca78", "#7fc4e0"];

function randomFolderColor() {
  const hue = Math.floor(Math.random() * 360);
  const sat = 0.62;
  const light = 0.58;
  const channel = (offset) => {
    const k = (offset + hue / 30) % 12;
    const a = sat * Math.min(light, 1 - light);
    const value = light - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    return Math.round(255 * value).toString(16).padStart(2, "0");
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

async function readJson(response) {
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || payload.success === false) {
    throw new Error(payload?.error || `请求失败（HTTP ${response.status}）`);
  }
  return payload.data;
}

async function fetchTree() {
  return readJson(await bpiFetch(API_ROOT, { headers: { Accept: "application/json" } }));
}

async function createItem({ kind, name, text, note, models, imageFile, parent, color }) {
  const body = new FormData();
  body.append("kind", kind);
  body.append("name", name ?? "");
  if (text != null) body.append("text", text);
  if (note) body.append("note", note);
  for (const model of models ?? []) body.append("models", model);
  if (parent) body.append("parent", parent);
  if (color) body.append("color", color);
  if (imageFile) body.append("image", imageFile, imageFile.name || "image");
  return readJson(await bpiFetch(API_ROOT, { method: "POST", body }));
}

async function updateItem(id, { name, text, note, models, imageFile, removeImage, color }) {
  const body = new FormData();
  if (name != null) body.append("name", name);
  if (text != null) body.append("text", text);
  if (note != null) body.append("note", note ?? "");
  for (const model of models ?? []) body.append("models", model);
  if (removeImage) body.append("remove_image", "1");
  if (color !== undefined) body.append("color", color ?? "");
  if (imageFile) body.append("image", imageFile, imageFile.name || "image");
  return readJson(await bpiFetch(`${API_ROOT}/${encodeURIComponent(id)}`, { method: "POST", body }));
}

async function moveItem(id, parent, index) {
  return readJson(await bpiFetch(`${API_ROOT}/${encodeURIComponent(id)}/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parent: parent ?? null, index }),
  }));
}

async function deleteItem(id) {
  return readJson(await bpiFetch(`${API_ROOT}/${encodeURIComponent(id)}`, { method: "DELETE" }));
}

// 淡色底在深/浅主题下的观感差很多：亮色背景原本就浅，12% 几乎看不见
function isDarkTheme() {
  const root = document.documentElement;
  const body = document.body;
  if (root.getAttribute("data-bpi-theme") === "dark") return true;
  if (root.getAttribute("data-bpi-theme") === "light") return false;
  if (body.classList.contains("dark-theme")) return true;
  return false;
}

function tintAlpha() {
  return isDarkTheme() ? { folder: "1f", child: "0d" } : { folder: "33", child: "1a" };
}

function imageUrl(item) {
  return `${API_ROOT}/${encodeURIComponent(item.id)}/image?v=${item.updated_at ?? item.created_at ?? 0}`;
}

function parseModels(value) {
  return String(value ?? "")
    .split(/[,，]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

// 新建 / 编辑弹窗。类型选「文件夹」时只需要名称、备注、模型、参考图，没有提示词那一块。
export function openLibraryItemDialog({ item = null, parent = null, presetKind = null, presetText = "" }, onSaved) {
  const editing = Boolean(item);
  const shade = element("div", "bpi-modal-shade");
  const modal = element("div", "bpi-modal");
  const title = element("h3", "", editing ? "编辑收藏" : "新建收藏");
  const form = element("form", "bpi-form");
  const error = element("div", "bpi-status");
  error.dataset.kind = "error";
  error.style.gridColumn = "1 / -1";

  let kind = item?.type === "folder" || presetKind === "folder" ? "folder" : "prompt";

  const kindLabel = element("label", "", "类型");
  const kindSelect = element("select", "bpi-select");
  for (const [value, label] of [["folder", "文件夹"], ["prompt", "提示词"]]) {
    const option = element("option", "", label);
    option.value = value;
    kindSelect.appendChild(option);
  }
  kindSelect.value = kind;
  kindSelect.disabled = editing; // 已有的条目不允许改类型
  form.append(kindLabel, kindSelect);

  const nameLabel = element("label", "", "名称");
  const nameInput = element("input");
  nameInput.value = item?.name ?? "";
  setPlaceholder(nameInput, "必填");
  form.append(nameLabel, nameInput);

  const noteLabel = element("label", "", "备注");
  const noteInput = element("input");
  noteInput.value = item?.note ?? "";
  setPlaceholder(noteInput, "可选");
  form.append(noteLabel, noteInput);

  const modelsLabel = element("label", "", "使用模型");
  const modelsInput = element("input");
  modelsInput.value = Array.isArray(item?.models) ? item.models.join(", ") : "";
  setPlaceholder(modelsInput, "可选，逗号分隔");
  form.append(modelsLabel, modelsInput);

  let pickedColor = item?.color ?? "";
  const colorLabel = element("label", "", "颜色");
  const colorRow = element("div", "bpi-lib-colors");
  const swatches = [];
  const syncColor = () => {
    for (const swatch of swatches) swatch.classList.toggle("bpi-lib-color-on", swatch.dataset.color === pickedColor);
  };
  const addSwatch = (value, label) => {
    const swatch = element("button", label ? "bpi-lib-color bpi-lib-color-text" : "bpi-lib-color", label ?? "");
    swatch.type = "button";
    swatch.dataset.color = value ?? "";
    if (value) swatch.style.backgroundColor = value;
    swatch.addEventListener("click", (event) => {
      event.preventDefault();
      pickedColor = value ?? "";
      syncColor();
    });
    swatches.push(swatch);
    colorRow.appendChild(swatch);
    return swatch;
  };
  for (const color of FOLDER_COLORS) addSwatch(color);
  addSwatch("", "无");
  const randomSwatch = addSwatch("", "随机");
  randomSwatch.addEventListener("click", () => {
    // 先清掉旧高亮，再把自己涂成新颜色并选中
    const color = randomFolderColor();
    randomSwatch.style.backgroundColor = color;
    randomSwatch.dataset.color = color;
    pickedColor = color;
    syncColor();
  });
  form.append(colorLabel, colorRow);

  const textLabel = element("label", "", "提示词");
  const textArea = element("textarea", "bpi-save-template");
  textArea.value = item?.text ?? presetText ?? "";
  textArea.rows = 4;
  form.append(textLabel, textArea);

  const imageLabel = element("label", "", "参考图");
  const drop = element("div", "bpi-save-drop bpi-lib-drop-image");
  const preview = element("img", "bpi-save-preview");
  const dropText = element("div", "", "拖一张图进来，或点一下选择");
  const fileInfo = element("div", "bpi-save-file", "可选；PNG / JPG / WebP，最大 5 MB");
  if (item?.image) {
    preview.src = imageUrl(item);
    preview.style.display = "block";
  }
  drop.append(preview, dropText, fileInfo);
  const picker = element("input");
  picker.type = "file";
  picker.accept = "image/png,image/jpeg,image/webp";
  picker.hidden = true;
  form.append(imageLabel, drop);

  const removeRow = element("label", "bpi-switch-row");
  const removeImageInput = element("input");
  removeImageInput.type = "checkbox";
  const removeTrack = element("span", "bpi-switch-track");
  removeTrack.appendChild(element("span", "bpi-switch-thumb"));
  // 打开后变红，旁边提醒一句「保存后生效」——和清除密钥那个开关的写法一致
  removeRow.append(
    removeImageInput,
    removeTrack,
    element("span", "bpi-switch-text", "删除已有参考图"),
    element("span", "bpi-switch-hint", "保存后生效"),
  );
  removeRow.style.gridColumn = "1 / -1";
  if (item?.image) form.append(removeRow);

  form.appendChild(error);

  let imageFile = null;
  const setImage = (file) => {
    imageFile = file;
    preview.src = URL.createObjectURL(file);
    preview.style.display = "block";
    setText(fileInfo, `“${file.name || "图片"}” · ${Math.max(1, Math.round(file.size / 1024))} KB`);
  };
  drop.addEventListener("click", () => picker.click());
  picker.addEventListener("change", () => {
    if (picker.files?.[0]) setImage(picker.files[0]);
  });
  drop.addEventListener("dragover", (event) => {
    event.preventDefault();
    drop.classList.add("bpi-dragover");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("bpi-dragover"));
  drop.addEventListener("drop", (event) => {
    event.preventDefault();
    drop.classList.remove("bpi-dragover");
    const file = event.dataTransfer?.files?.[0];
    if (file) setImage(file);
  });

  const syncKind = () => {
    const isFolder = kind === "folder";
    textLabel.hidden = isFolder;
    textArea.hidden = isFolder;
    colorLabel.hidden = !isFolder;
    colorRow.hidden = !isFolder;
    setText(title, editing ? "编辑收藏" : isFolder ? "新建文件夹" : "新建提示词");
  };
  kindSelect.addEventListener("change", () => {
    kind = kindSelect.value;
    syncKind();
  });
  syncKind();

  const close = () => shade.remove();
  const actions = element("div", "bpi-modal-actions");
  const saveButton = button("保存", async () => {
    const name = nameInput.value.trim();
    if (!name) {
      setText(error, "名称不能为空");
      return;
    }
    const text = kind === "prompt" ? textArea.value : null;
    if (kind === "prompt" && !String(text ?? "").trim()) {
      setText(error, "提示词内容不能为空");
      return;
    }
    saveButton.disabled = true;
    try {
      const payload = {
        name,
        text,
        note: noteInput.value.trim() || null,
        models: parseModels(modelsInput.value),
        imageFile,
        removeImage: removeImageInput.checked,
        color: kind === "folder" ? pickedColor : "",
      };
      const saved = editing
        ? await updateItem(item.id, payload)
        : await createItem({ ...payload, kind, parent });
      close();
      window.dispatchEvent(new CustomEvent("bpi:library-changed", { detail: saved }));
      onSaved?.(saved);
    } catch (failure) {
      setText(error, failure.message);
      saveButton.disabled = false;
    }
  }, "bpi-primary");
  actions.append(button("取消", close), saveButton);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    saveButton.click();
  });

  modal.append(title, form, picker, actions);
  shade.appendChild(modal);
  document.body.appendChild(shade);
  shade.addEventListener("mousedown", (event) => {
    if (event.target === shade) close();
  });
  modal.addEventListener("mousedown", (event) => event.stopPropagation());
  requestAnimationFrame(() => nameInput.focus());
  return { close };
}

export function createLibraryView({ mount, onLoad, onToast, confirmDelete }) {
  let items = [];
  let loaded = false;
  let dragId = null;
  const expanded = new Set(); // 只在内存：刷新页面才回到全部收起
  let query = "";

  const byId = (id) => items.find((item) => item.id === id) ?? null;
  const childrenOf = (parent) => items
    .filter((item) => (item.parent ?? null) === (parent ?? null))
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0));

  const matches = (item) => {
    if (!query) return true;
    const haystack = [item.name, item.note, item.text, ...(item.models ?? [])].join("\n").toLowerCase();
    return haystack.includes(query);
  };

  // 搜索时把所有祖先也带出来，否则匹配到的条目会因为没有父级而整条不显示
  const visibleIds = () => {
    if (!query) return null;
    const keep = new Set();
    for (const item of items) {
      if (!matches(item)) continue;
      keep.add(item.id);
      let parent = item.parent;
      while (parent) {
        keep.add(parent);
        parent = byId(parent)?.parent ?? null;
      }
    }
    return keep;
  };

  function rowsFor(parent, depth) {
    const keep = visibleIds();
    const list = childrenOf(parent).filter((item) => !keep || keep.has(item.id));
    const rows = [];
    for (const item of list) {
      rows.push(item, ...(item.type === "folder" && (expanded.has(item.id) || Boolean(query))
        ? rowsFor(item.id, depth + 1)
        : []));
    }
    return rows;
  }

  function rowElement(item) {
    const isFolder = item.type === "folder";
    const row = element("div", `bpi-lib-row ${isFolder ? "bpi-lib-folder" : "bpi-lib-item"}`);
    row.dataset.id = item.id;
    row.draggable = true;
    // 文件夹的淡色：存的是 #rrggbb，这里按当前主题补透明度铺一层。
    // 文件夹里的条目继承同一个颜色，但更淡一档，一眼能看出它属于哪个组。
    const tint = tintAlpha();
    if (isFolder && item.color) {
      row.style.backgroundColor = `${item.color}${tint.folder}`;
    } else if (!isFolder && item.parent) {
      const parentColor = byId(item.parent)?.color;
      if (parentColor) row.style.backgroundColor = `${parentColor}${tint.child}`;
    }

    const main = element("div", "bpi-lib-main");
    // 缩略图对所有行都放（文件夹也能配参考图），没有图就给虚线占位，
    // 这样文件夹与提示词的行高一致，树看起来才是齐的
    const thumb = element("span", "bpi-lib-thumb");
    if (item.image) thumb.style.backgroundImage = `url("${imageUrl(item)}")`;
    else thumb.classList.add("bpi-lib-noimg");
    main.appendChild(thumb);
    const name = element("span", "bpi-lib-name", item.name ?? "未命名");
    if (isFolder) {
      main.appendChild(name);
      main.appendChild(element("span", "bpi-lib-count", String(childrenOf(item.id).length)));
    } else {
      // 名称一行、提示词摘要一行：挤在同一行时两边都被截断，反而看不清是什么
      const texts = element("div", "bpi-lib-texts");
      texts.appendChild(name);
      const summary = String(item.text ?? "").replace(/\s+/g, " ").slice(0, 120);
      if (summary) texts.appendChild(element("span", "bpi-lib-summary", summary));
      main.appendChild(texts);
    }

    const arrow = element("span", "bpi-lib-arrow", isFolder ? (expanded.has(item.id) ? "▾" : "▸") : "");
    if (isFolder) {
      arrow.addEventListener("click", (event) => {
        event.stopPropagation();
        if (expanded.has(item.id)) expanded.delete(item.id);
        else expanded.add(item.id);
        render();
      });
    }

    const tools = element("span", "bpi-lib-tools");
    if (!isFolder) {
      tools.append(
        button("载入", (event) => {
          event.stopPropagation();
          onLoad?.(item);
        }, "bpi-mini"),
        button("复制", async (event) => {
          event.stopPropagation();
          try {
            await navigator.clipboard.writeText(String(item.text ?? ""));
            onToast?.("已复制提示词", "ok");
          } catch {
            onToast?.("浏览器不允许写剪贴板", "error");
          }
        }, "bpi-mini"),
      );
    }
    tools.append(
      button("编辑", (event) => {
        event.stopPropagation();
        openLibraryItemDialog({ item }, () => refresh());
      }, "bpi-mini"),
      button("删除", async (event) => {
        event.stopPropagation();
        const ok = confirmDelete ? await confirmDelete(item) : window.confirm(`删除“${item.name}”？`);
        if (!ok) return;
        try {
          await deleteItem(item.id);
          expanded.delete(item.id);
          onToast?.("已删除", "ok");
          refresh();
        } catch (failure) {
          onToast?.(failure.message, "error");
        }
      }, "bpi-mini bpi-danger"),
    );

    row.append(main, tools, arrow);
    if (isFolder) {
      row.addEventListener("click", () => {
        if (expanded.has(item.id)) expanded.delete(item.id);
        else expanded.add(item.id);
        render();
      });
    }
    attachDrag(row, item);
    return row;
  }

  function clearDropMarks() {
    for (const node of mount.querySelectorAll(".bpi-lib-drop-before, .bpi-lib-drop-after, .bpi-lib-drop-into")) {
      node.classList.remove("bpi-lib-drop-before", "bpi-lib-drop-after", "bpi-lib-drop-into");
    }
  }

  function attachDrag(row, item) {
    row.addEventListener("dragstart", (event) => {
      dragId = item.id;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", item.id);
      row.classList.add("bpi-lib-dragging");
    });
    row.addEventListener("dragend", () => {
      dragId = null;
      row.classList.remove("bpi-lib-dragging");
      clearDropMarks();
    });
    row.addEventListener("dragover", (event) => {
      if (!dragId || dragId === item.id) return;
      event.preventDefault();
      event.stopPropagation();
      clearDropMarks();
      const rect = row.getBoundingClientRect();
      const ratio = (event.clientY - rect.top) / Math.max(1, rect.height);
      if (item.type === "folder" && ratio > 0.3 && ratio < 0.7) {
        row.classList.add("bpi-lib-drop-into");
      } else {
        row.classList.add(ratio < 0.5 ? "bpi-lib-drop-before" : "bpi-lib-drop-after");
      }
    });
    row.addEventListener("dragleave", () => {
      row.classList.remove("bpi-lib-drop-before", "bpi-lib-drop-after", "bpi-lib-drop-into");
    });
    row.addEventListener("drop", async (event) => {
      if (!dragId || dragId === item.id) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = row.getBoundingClientRect();
      const ratio = (event.clientY - rect.top) / Math.max(1, rect.height);
      const intoFolder = item.type === "folder" && ratio > 0.3 && ratio < 0.7;
      clearDropMarks();
      const moving = dragId;
      dragId = null;
      try {
        if (intoFolder) {
          expanded.add(item.id);
          await moveItem(moving, item.id, null);
        } else {
          const siblings = childrenOf(item.parent).filter((entry) => entry.id !== moving);
          const at = siblings.findIndex((entry) => entry.id === item.id);
          const index = ratio < 0.5 ? Math.max(0, at) : Math.max(0, at + 1);
          await moveItem(moving, item.parent, index);
        }
        await refresh();
      } catch (failure) {
        onToast?.(failure.message, "error");
      }
    });
  }

  function render() {
    mount.replaceChildren();
    const rows = rowsFor(null, 0);
    if (!items.length) {
      mount.appendChild(element("div", "bpi-empty", "还没有收藏。点上面的「新建」建一个文件夹或提示词。"));
      return;
    }
    if (!rows.length) {
      mount.appendChild(element("div", "bpi-empty", "没有匹配的收藏。"));
      return;
    }
    for (const item of rows) {
      const row = rowElement(item);
      const depth = (() => {
        let level = 0;
        let parent = item.parent;
        while (parent) {
          level += 1;
          parent = byId(parent)?.parent ?? null;
        }
        return level;
      })();
      row.style.paddingLeft = `${8 + depth * 12}px`;
      mount.appendChild(row);
    }
  }

  let legacyTried = false;

  async function refresh() {
    try {
      let data = await fetchTree();
      // 新库第一次用而且空着：把旧版 saved_prompts 里的一次性搬过来（后端有标记，只搬一次）
      if (!data?.items?.length && !legacyTried) {
        legacyTried = true;
        const imported = await readJson(await bpiFetch(`${API_ROOT}/import-legacy`, { method: "POST" })).catch(() => null);
        if (imported?.imported > 0) {
          data = await fetchTree();
          onToast?.(`已从旧收藏导入 ${imported.imported} 条`, "ok");
        }
      }
      items = Array.isArray(data?.items) ? data.items : [];
      loaded = true;
      render();
    } catch (failure) {
      mount.replaceChildren(element("div", "bpi-empty", `读取收藏失败：${failure.message}`));
    }
  }

  const onLibraryChanged = () => {
    if (!mount.isConnected) {
      window.removeEventListener("bpi:library-changed", onLibraryChanged);
      return;
    }
    refresh();
  };
  window.addEventListener("bpi:library-changed", onLibraryChanged);

  // 拖到列表空白处 = 移出到根目录末尾
  mount.addEventListener("dragover", (event) => {
    if (!dragId) return;
    event.preventDefault();
  });
  mount.addEventListener("drop", async (event) => {
    if (!dragId || event.target !== mount) return;
    event.preventDefault();
    const moving = dragId;
    dragId = null;
    try {
      await moveItem(moving, null, null);
      await refresh();
    } catch (failure) {
      onToast?.(failure.message, "error");
    }
  });

  return {
    refresh,
    render,
    setQuery(value) {
      query = String(value ?? "").trim().toLowerCase();
      render();
    },
    openCreate(parent = null) {
      openLibraryItemDialog({ parent }, () => refresh());
    },
    isLoaded: () => loaded,
    items: () => items,
  };
}

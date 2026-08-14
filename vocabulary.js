const state = {
  entries: [],
  currentList: [],
  selected: new Set(),
  lastIndex: -1
};

const elements = {};

document.addEventListener("DOMContentLoaded", async () => {
  bindElements();
  bindEvents();
  await loadEntries();
});

function bindElements() {
  elements.count = document.getElementById("vocab-count");
  elements.searchInput = document.getElementById("search-input");
  elements.languageFilter = document.getElementById("language-filter");
  elements.timeFilter = document.getElementById("time-filter");
  elements.exportFilter = document.getElementById("export-filter");
  elements.sortOrder = document.getElementById("sort-order");
  elements.exportButton = document.getElementById("export-csv");
  elements.emptyState = document.getElementById("empty-state");
  elements.list = document.getElementById("vocab-list");
  elements.selectCount = document.getElementById("select-count");
  elements.selectAll = document.getElementById("select-all");
  elements.selectClear = document.getElementById("select-clear");
  elements.deleteSelected = document.getElementById("delete-selected");
}

function bindEvents() {
  elements.searchInput.addEventListener("input", render);
  elements.languageFilter.addEventListener("change", render);
  elements.timeFilter.addEventListener("change", render);
  elements.exportFilter.addEventListener("change", render);
  elements.sortOrder.addEventListener("change", render);
  elements.exportButton.addEventListener("click", exportVisible);
  elements.selectAll.addEventListener("click", selectAllVisible);
  elements.selectClear.addEventListener("click", clearSelection);
  elements.deleteSelected.addEventListener("click", deleteSelected);
}

async function loadEntries() {
  const response = await sendRuntimeMessage({ type: "GET_ENTRIES" });
  state.entries = response?.ok && Array.isArray(response.entries) ? response.entries : [];
  renderLanguageFilter();
  render();
}

function renderLanguageFilter() {
  const languages = getStarredEntries()
    .map((entry) => entry.lang)
    .filter(Boolean)
    .filter((lang, index, list) => list.indexOf(lang) === index)
    .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));

  const currentValue = elements.languageFilter.value;
  elements.languageFilter.replaceChildren(createOption("", "全部语言"));

  for (const lang of languages) {
    elements.languageFilter.appendChild(createOption(lang, lang));
  }

  if (languages.includes(currentValue)) {
    elements.languageFilter.value = currentValue;
  }
}

function render() {
  const query = elements.searchInput.value.trim().toLocaleLowerCase();
  const language = elements.languageFilter.value;
  const sortOrder = elements.sortOrder.value;

  state.currentList = getStarredEntries()
    .filter((entry) => {
      const matchesQuery = !query ||
        entry.word.toLocaleLowerCase().includes(query) ||
        entry.meaning.toLocaleLowerCase().includes(query);
      const matchesLanguage = !language || entry.lang === language;
      return matchesQuery && matchesLanguage &&
        inTimeRange(entry.timestamp) && matchesExportStatus(entry);
    })
    .sort((a, b) => compareEntries(a, b, sortOrder));

  elements.count.textContent = `${getStarredEntries().length} 条生词`;
  elements.emptyState.hidden = state.currentList.length > 0;
  elements.list.replaceChildren(...state.currentList.map(createEntryNode));
  updateSelectBar();
}

function matchesExportStatus(entry) {
  const filter = elements.exportFilter.value;
  if (filter === "all") {
    return true;
  }
  const exported = Number(entry.exportedAt) > 0;
  return filter === "done" ? exported : !exported;
}

function inTimeRange(timestamp) {
  const filter = elements.timeFilter.value;
  if (filter === "all") {
    return true;
  }
  const n = Number(timestamp);
  if (!Number.isFinite(n) || n <= 0) {
    return false;
  }
  const now = new Date();
  if (filter === "today") {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    return n >= start;
  }
  const days = filter === "7d" ? 7 : 30;
  return n >= now.getTime() - days * 86400000;
}

function updateSelectBar() {
  const present = new Set(getStarredEntries().map((entry) => entry.id));
  for (const id of Array.from(state.selected)) {
    if (!present.has(id)) {
      state.selected.delete(id);
    }
  }
  const n = state.selected.size;
  elements.selectCount.textContent = `已选 ${n} 项`;
  elements.deleteSelected.textContent = `删除选中 (${n})`;
  elements.deleteSelected.disabled = n === 0;
}

function handleCheck(index, shift) {
  const list = state.currentList;
  const id = list[index].id;
  const turnOn = !state.selected.has(id);
  if (shift && state.lastIndex >= 0) {
    const a = Math.min(state.lastIndex, index);
    const b = Math.max(state.lastIndex, index);
    for (let i = a; i <= b; i += 1) {
      const eid = list[i].id;
      if (turnOn) {
        state.selected.add(eid);
      } else {
        state.selected.delete(eid);
      }
    }
  } else if (turnOn) {
    state.selected.add(id);
  } else {
    state.selected.delete(id);
  }
  state.lastIndex = index;
  render();
}

function selectAllVisible() {
  state.currentList.forEach((entry) => state.selected.add(entry.id));
  render();
}

function clearSelection() {
  state.selected.clear();
  state.lastIndex = -1;
  render();
}

async function deleteSelected() {
  if (!state.selected.size) {
    return;
  }
  if (!window.confirm(`确定删除选中的 ${state.selected.size} 条生词？`)) {
    return;
  }
  const ids = Array.from(state.selected);
  const response = await sendRuntimeMessage({ type: "UNSTAR_MANY", ids });
  if (!response?.ok) {
    window.alert(response?.error?.message || "删除失败");
    return;
  }

  const idSet = new Set(ids);
  state.entries = state.entries.map((entry) => (
    idSet.has(entry.id) ? { ...entry, starred: false } : entry
  ));
  state.selected.clear();
  state.lastIndex = -1;
  renderLanguageFilter();
  render();
}

function createEntryNode(entry, index) {
  const details = document.createElement("details");
  details.className = "vocab-item";

  const summary = document.createElement("summary");
  summary.className = "vocab-summary";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "vocab-check";
  checkbox.checked = state.selected.has(entry.id);
  checkbox.title = "选择（Shift 点击可选一段范围）";
  checkbox.addEventListener("click", (event) => {
    event.stopPropagation();
    event.preventDefault();
    handleCheck(index, event.shiftKey);
  });

  const main = document.createElement("div");
  main.className = "vocab-main";

  const wordLine = document.createElement("div");
  wordLine.className = "word-line";

  const word = document.createElement("span");
  word.className = "word";
  word.textContent = entry.word;
  wordLine.appendChild(word);

  if (entry.translit) {
    const translit = document.createElement("span");
    translit.className = "translit";
    translit.textContent = entry.translit;
    wordLine.appendChild(translit);
  }

  const meaning = document.createElement("div");
  meaning.className = "meaning";
  meaning.textContent = entry.meaning || "暂无词义";

  const metaLine = document.createElement("div");

  const tag = document.createElement("span");
  tag.className = "lang-tag";
  tag.textContent = entry.lang || "未知语言";

  const date = document.createElement("span");
  date.className = "vocab-date";
  date.textContent = `🗓 ${formatDateOnly(entry.timestamp)}`;

  metaLine.append(tag, date);

  if (Number(entry.exportedAt) > 0) {
    const exported = document.createElement("span");
    exported.className = "vocab-exported";
    exported.textContent = "✓ 已导出";
    metaLine.append(exported);
  }

  main.append(wordLine, meaning, metaLine);

  const actions = document.createElement("div");
  actions.className = "vocab-actions";

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "danger-button";
  deleteButton.textContent = "🗑 删除";
  deleteButton.title = "从生词本移除";
  deleteButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    unstarEntry(entry.id);
  });
  actions.appendChild(deleteButton);

  summary.append(checkbox, main, actions);

  const body = document.createElement("div");
  body.className = "details-body";
  body.append(
    createDetailRow("完整词义", entry.meaning || "暂无"),
    createDetailRow("词源", entry.etymology || "暂无"),
    createDetailRow("句中作用", entry.form || "暂无"),
    createDetailRow("上下文", entry.context || "暂无"),
    createDetailRow("添加日期", formatDateTime(entry.timestamp))
  );

  details.append(summary, body);
  return details;
}

async function unstarEntry(id) {
  const response = await sendRuntimeMessage({
    type: "TOGGLE_STAR",
    id,
    starred: false
  });

  if (!response?.ok) {
    window.alert(response?.error?.message || "删除失败");
    return;
  }

  state.entries = state.entries.map((entry) => (
    entry.id === id ? { ...entry, starred: false } : entry
  ));
  state.selected.delete(id);
  renderLanguageFilter();
  render();
}

async function exportVisible() {
  // 所见即所导：导出当前列表（跟随 语言 + 时间 + 导出状态 + 搜索 筛选）。
  const entries = state.currentList.slice();
  if (entries.length === 0) {
    window.alert("当前筛选/搜索范围没有可导出的生词。");
    return;
  }

  downloadCsv(entries);

  // 标记为已导出，之后用"未导出"筛选即可只导新词。
  const ids = entries.map((entry) => entry.id);
  await sendRuntimeMessage({ type: "MARK_EXPORTED", ids });
  const now = Date.now();
  const idSet = new Set(ids);
  state.entries = state.entries.map((entry) => (
    idSet.has(entry.id) ? { ...entry, exportedAt: now } : entry
  ));
  render();

  window.alert(`CSV已导出（共 ${entries.length} 条，跟随当前筛选/搜索）。
这些词已标记为"已导出"，下次用顶部"未导出"筛选即可只导新词。

在Anki中导入步骤：
1. 打开Anki桌面版
2. 文件 → 导入 → 选择此CSV
3. Note Type 选"基础"，字段映射：第1列→正面，第2列→背面（第3列已自动设为标签）
4. "现有笔记/Existing notes"选"保留(Preserve)"：重复导入整本生词本时，已存在的卡片会被跳过，不会被替换或删除，新词照常加入
5. 点击导入即可`);
}

function downloadCsv(entries) {
  const lines = [
    "#separator:tab",
    "#html:true",
    "#tags column:3",
    ...entries.map((entry) => [
      sanitizeCsvField(createFrontHtml(entry)),
      sanitizeCsvField(createBackHtml(entry)),
      sanitizeCsvField(languageToTag(entry.lang))
    ].join("\t"))
  ];
  const blob = new Blob([lines.join("\n")], {
    type: "text/tab-separated-values;charset=utf-8"
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `vocabulary_${formatDate(new Date())}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function createFrontHtml(entry) {
  return `<div style="font-size:22px; line-height:1.6; padding:20px; text-align:center;">${highlightWord(entry.context, entry.word)}</div><span style="display:none">#${escapeHtml(entry.id || "")}</span>`;
}

function createBackHtml(entry) {
  const highlightedContext = highlightWord(entry.context, entry.word);
  return `<div style="font-size:18px; line-height:1.8; padding:20px;">
  <div style="font-size:20px; text-align:center; margin-bottom:16px; padding-bottom:12px; border-bottom:1px solid #ddd;">
    ${highlightedContext}
  </div>
  <div style="margin:8px 0;">📖 <b>${escapeHtml(entry.translit)}</b></div>
  <div style="margin:8px 0;">💡 ${escapeHtml(entry.meaning)}</div>
  <div style="margin:8px 0;">🌱 ${escapeHtml(entry.etymology)}</div>
  <div style="margin:8px 0;">📍 ${escapeHtml(entry.form)}</div>
</div>`;
}

function highlightWord(context, word) {
  const text = String(context || word || "");
  const target = String(word || "");
  const index = findTargetWordIndex(text, target);

  if (!target || index < 0) {
    return escapeHtml(text);
  }

  return [
    escapeHtml(text.slice(0, index)),
    `<b style="color:#d97706;">${escapeHtml(text.slice(index, index + target.length))}</b>`,
    escapeHtml(text.slice(index + target.length))
  ].join("");
}

function findTargetWordIndex(text, word) {
  if (!word) {
    return -1;
  }

  let index = text.indexOf(word);
  const firstOccurrence = index;
  while (index >= 0) {
    const before = text[index - 1] || "";
    const after = text[index + word.length] || "";
    if (isWordBoundary(before) && isWordBoundary(after)) {
      return index;
    }
    index = text.indexOf(word, index + word.length);
  }

  // 没有"整词边界"匹配时，退回首次出现的位置，避免该高亮却不高亮。
  return firstOccurrence;
}

function isWordBoundary(char) {
  return !char || /[\s\u200c.,،，;؛:：!?؟۔。！？"'“”‘’«»《》（）()[\]{}<>]/u.test(char);
}

function createDetailRow(label, value) {
  const row = document.createElement("div");
  row.className = "detail-row";

  const labelNode = document.createElement("div");
  labelNode.className = "detail-label";
  labelNode.textContent = label;

  const valueNode = document.createElement("div");
  valueNode.className = "detail-value";
  valueNode.textContent = value;

  row.append(labelNode, valueNode);
  return row;
}

function createOption(value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
}

function compareEntries(a, b, sortOrder) {
  if (sortOrder === "oldest") {
    return a.timestamp - b.timestamp;
  }

  if (sortOrder === "language") {
    return a.lang.localeCompare(b.lang, "zh-Hans-CN") || b.timestamp - a.timestamp;
  }

  return b.timestamp - a.timestamp;
}

function getStarredEntries() {
  return state.entries.filter((entry) => entry.starred);
}

function sanitizeCsvField(value) {
  // 标准 CSV 转义：整段用双引号包裹，内部双引号写成两个，换行转 <br>。
  // 否则字段里 HTML 的 style="..." 引号会让 Anki 误判边界，导致上下文/词语丢失。
  const text = String(value ?? "").replace(/\r\n|\r|\n/g, "<br>");
  return `"${text.replace(/"/g, '""')}"`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function languageToTag(lang) {
  const tags = {
    波斯语: "Persian",
    俄语: "Russian",
    阿拉伯语: "Arabic",
    土耳其语: "Turkish"
  };
  return tags[lang] || String(lang || "Unknown").trim().replace(/\s+/g, "_");
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDateOnly(timestamp) {
  const n = Number(timestamp);
  if (!Number.isFinite(n) || n <= 0) {
    return "未知日期";
  }
  return formatDate(new Date(n));
}

function formatDateTime(timestamp) {
  const n = Number(timestamp);
  if (!Number.isFinite(n) || n <= 0) {
    return "未知日期";
  }
  const date = new Date(n);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${formatDate(date)} ${hh}:${mm}`;
}

function sendRuntimeMessage(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response);
    });
  });
}

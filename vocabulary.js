const $ = (id) => document.getElementById(id);
const h = (tag, props = {}, ...kids) => {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...kids.filter((k) => k != null && k !== false));
  return el;
};

const state = { entries: [], list: [], selected: new Set(), lastIndex: -1 };
const starred = () => state.entries.filter((e) => e.starred);

document.addEventListener("DOMContentLoaded", async () => {
  // 词条按词形分键存（w:<词>）；后台还没来得及迁移的老数据还在 entries 里
  const all = await chrome.storage.local.get(null);
  state.entries = all.entries || Object.keys(all).filter((k) => k.startsWith("w:")).flatMap((k) => all[k]);
  for (const id of ["search-input", "language-filter", "time-filter", "export-filter", "sort-order"]) {
    $(id).addEventListener(id === "search-input" ? "input" : "change", render);
  }
  $("export-csv").onclick = exportVisible;
  $("select-all").onclick = () => {
    state.list.forEach((e) => state.selected.add(e.id));
    render();
  };
  $("select-clear").onclick = () => {
    state.selected.clear();
    state.lastIndex = -1;
    render();
  };
  $("delete-selected").onclick = () => {
    if (confirm(`确定删除选中的 ${state.selected.size} 条生词？`)) unstar([...state.selected]);
  };
  render();
});

function render() {
  // 语言筛选项跟着生词本走，保留当前选择
  const langFilter = $("language-filter");
  const current = langFilter.value;
  const langs = [...new Set(starred().map((e) => e.lang))].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
  langFilter.replaceChildren(h("option", { value: "", textContent: "全部语言" }),
    ...langs.map((l) => h("option", { value: l, textContent: l })));
  langFilter.value = langs.includes(current) ? current : "";

  const query = $("search-input").value.trim().toLocaleLowerCase();
  const order = $("sort-order").value;
  state.list = starred()
    .filter((e) => (!query || e.word.toLocaleLowerCase().includes(query) || e.meaning.toLocaleLowerCase().includes(query)) &&
      (!langFilter.value || e.lang === langFilter.value) && inTimeRange(e.timestamp) && matchesExport(e))
    .sort((a, b) => order === "oldest" ? a.timestamp - b.timestamp
      : order === "language" ? a.lang.localeCompare(b.lang, "zh-Hans-CN") || b.timestamp - a.timestamp
        : b.timestamp - a.timestamp);

  const ids = new Set(starred().map((e) => e.id));
  for (const id of state.selected) if (!ids.has(id)) state.selected.delete(id);

  $("vocab-count").textContent = `${ids.size} 条生词`;
  $("empty-state").hidden = state.list.length > 0;
  $("vocab-list").replaceChildren(...state.list.map(entryNode));
  $("select-count").textContent = `已选 ${state.selected.size} 项`;
  $("delete-selected").textContent = `删除选中 (${state.selected.size})`;
  $("delete-selected").disabled = !state.selected.size;
}

function matchesExport(entry) {
  const filter = $("export-filter").value;
  return filter === "all" || (filter === "done") === entry.exportedAt > 0;
}

function inTimeRange(timestamp) {
  const filter = $("time-filter").value;
  if (filter === "all") return true;
  const now = new Date();
  if (filter === "today") return timestamp >= new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return timestamp >= now.getTime() - (filter === "7d" ? 7 : 30) * 864e5;
}

// Shift 点复选框：选中/取消上次点的那条到这条之间的整段
function toggleCheck(index, shift) {
  const turnOn = !state.selected.has(state.list[index].id);
  const [a, b] = shift && state.lastIndex >= 0
    ? [Math.min(state.lastIndex, index), Math.max(state.lastIndex, index)]
    : [index, index];
  for (const e of state.list.slice(a, b + 1)) turnOn ? state.selected.add(e.id) : state.selected.delete(e.id);
  state.lastIndex = index;
  render();
}

function entryNode(entry, index) {
  const row = (label, value) => h("div", { className: "detail-row" },
    h("div", { className: "detail-label", textContent: label }),
    h("div", { className: "detail-value", textContent: value || "暂无" }));

  return h("details", { className: "vocab-item" },
    h("summary", { className: "vocab-summary" },
      h("input", {
        type: "checkbox",
        className: "vocab-check",
        checked: state.selected.has(entry.id),
        title: "选择（Shift 点击可选一段范围）",
        onclick: (event) => {
          event.preventDefault();
          event.stopPropagation();
          toggleCheck(index, event.shiftKey);
        }
      }),
      h("div", { className: "vocab-main" },
        h("div", { className: "word-line" },
          h("span", { className: "word", textContent: entry.word }),
          entry.translit && h("span", { className: "translit", textContent: entry.translit })),
        h("div", { className: "meaning", textContent: entry.meaning || "暂无词义" }),
        h("div", {},
          h("span", { className: "lang-tag", textContent: entry.lang }),
          h("span", { className: "vocab-date", textContent: `🗓 ${formatDate(entry.timestamp)}` }),
          entry.exportedAt > 0 && h("span", { className: "vocab-exported", textContent: "✓ 已导出" }))),
      h("div", { className: "vocab-actions" },
        h("button", {
          type: "button",
          className: "danger-button",
          textContent: "🗑 删除",
          title: "从生词本移除",
          onclick: (event) => {
            event.preventDefault();
            unstar([entry.id]);
          }
        }))),
    h("div", { className: "details-body" },
      row("完整词义", entry.meaning),
      row("词源", entry.etymology),
      row("句中作用", entry.form),
      row("上下文", entry.context),
      row("添加日期", formatDate(entry.timestamp, true))));
}

async function unstar(ids) {
  const res = await chrome.runtime.sendMessage({ type: "PATCH", items: state.entries.filter((e) => ids.includes(e.id)), patch: { starred: false } });
  if (!res?.ok) return alert(res?.error?.message || "删除失败");
  const set = new Set(ids);
  for (const e of state.entries) if (set.has(e.id)) e.starred = false;
  ids.forEach((id) => state.selected.delete(id));
  state.lastIndex = -1;
  render();
}

// 所见即所导：导出当前列表（跟随搜索和全部筛选），导完标记为已导出
async function exportVisible() {
  const entries = state.list.slice();
  if (!entries.length) return alert("当前筛选/搜索范围没有可导出的生词。");

  const field = (v) => `"${String(v ?? "").replace(/\r\n|\r|\n/g, "<br>").replace(/"/g, '""')}"`;
  const lines = ["#separator:tab", "#html:true", "#tags column:3",
    ...entries.map((e) => [frontHtml(e), backHtml(e), languageToTag(e.lang)].map(field).join("\t"))];
  const link = h("a", {
    href: URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/tab-separated-values;charset=utf-8" })),
    download: `vocabulary_${formatDate(Date.now())}.csv`
  });
  link.click();
  URL.revokeObjectURL(link.href);

  const exportedAt = Date.now();
  await chrome.runtime.sendMessage({ type: "PATCH", items: entries, patch: { exportedAt } });
  entries.forEach((e) => (e.exportedAt = exportedAt));
  render();

  alert(`CSV已导出（共 ${entries.length} 条，跟随当前筛选/搜索）。
这些词已标记为"已导出"，下次用顶部"未导出"筛选即可只导新词。

在Anki中导入步骤：
1. 打开Anki桌面版
2. 文件 → 导入 → 选择此CSV
3. Note Type 选"基础"，字段映射：第1列→正面，第2列→背面（第3列已自动设为标签）
4. "现有笔记/Existing notes"选"保留(Preserve)"：重复导入整本生词本时，已存在的卡片会被跳过，不会被替换或删除，新词照常加入
5. 点击导入即可`);
}

// 正面埋隐藏的词条 id，Anki 靠它去重
function frontHtml(e) {
  return `<div style="font-size:22px; line-height:1.6; padding:20px; text-align:center;">${markWord(e.context, e.word)}</div><span style="display:none">#${escapeHtml(e.id)}</span>`;
}

function backHtml(e) {
  return `<div style="font-size:18px; line-height:1.8; padding:20px;">
  <div style="font-size:20px; text-align:center; margin-bottom:16px; padding-bottom:12px; border-bottom:1px solid #ddd;">
    ${markWord(e.context, e.word)}
  </div>
  <div style="margin:8px 0;">📖 <b>${escapeHtml(e.translit)}</b></div>
  <div style="margin:8px 0;">💡 ${escapeHtml(e.meaning)}</div>
  <div style="margin:8px 0;">🌱 ${escapeHtml(e.etymology)}</div>
  <div style="margin:8px 0;">📍 ${escapeHtml(e.form)}</div>
</div>`;
}

// 上下文里把生词加粗：优先整词边界的那次出现，找不到就用第一次出现
function markWord(context, word) {
  const text = context || word;
  const boundary = /[\s\u200C.,،，;؛:：!?؟۔。！？"'“”‘’«»《》（）()[\]{}<>]/u;
  const isEdge = (ch) => !ch || boundary.test(ch);
  let i = word ? text.indexOf(word) : -1;
  const first = i;
  while (i >= 0 && !(isEdge(text[i - 1]) && isEdge(text[i + word.length]))) i = text.indexOf(word, i + word.length);
  if (i < 0) i = first;
  if (i < 0) return escapeHtml(text);
  return `${escapeHtml(text.slice(0, i))}<b style="color:#d97706;">${escapeHtml(word)}</b>${escapeHtml(text.slice(i + word.length))}`;
}

function escapeHtml(value) {
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(value ?? "").replace(/[&<>"']/g, (c) => map[c]);
}

function languageToTag(lang) {
  const tags = { 波斯语: "Persian", 俄语: "Russian", 阿拉伯语: "Arabic", 土耳其语: "Turkish" };
  return tags[lang] || String(lang || "Unknown").trim().replace(/\s+/g, "_");
}

function formatDate(timestamp, withTime = false) {
  if (!(timestamp > 0)) return "未知日期";
  const d = new Date(timestamp);
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return withTime ? `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}` : date;
}

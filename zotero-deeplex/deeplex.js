/* Nama PDF 查词 — Zotero 7/9 主模块。
 * 阅读器选中文本 -> 文字选择弹窗里追加查词卡片（流式渲染）。
 * 调用 DeepSeek 返回 IPA 发音 / 词源 / 词义 / 句中作用，可收藏进生词本。
 */

Nama = {
  // ---- 配置 ----
  API_ENDPOINT: "https://api.deepseek.com/v1/chat/completions",
  MODEL: "deepseek-v4-flash",
  API_TIMEOUT_MS: 60000,
  PREF_API_KEY: "extensions.nama.apiKey",
  PREF_ENTRIES: "extensions.nama.entries",
  PREF_CACHE: "extensions.deeplex.cache", // 更旧版本的缓存，仅用于迁移
  // 旧命名空间（DeepLex），一次性迁移到 nama.* 后即弃用
  OLD_PREF_API_KEY: "extensions.deeplex.apiKey",
  OLD_PREF_ENTRIES: "extensions.deeplex.entries",
  ENTRY_CAP: 1000,

  // 逐行标签格式：便于流式时逐字段渲染。
  SYSTEM_PROMPT: `你是多语言查词助手。给你一个词(或词组/句子)及其上下文，按下面纯文本格式逐行输出：每字段独占一行、以英文标签开头、尽量短，不用markdown、不加多余说明。

WORD: 原词
PRON: 读音注音，只给「正文语言」的读音(正文语言=选区周围上下文所用、读者正在读的语言)——即读者会怎么读这个词，不要给它在原语/来源语言里的读音。注音体系随正文语言：中文带声调拼音／日语黑本式罗马音(可附假名)／韩语罗马字／印地·梵·巴利用IAST／俄波阿土等用IPA(方括号+重音ˈ)。
LANG: 该词本身所属或来源的语言(中文名)；借词可写「X语(源自Y语)」。
MEANING: 核心词义(中文,1-2个义项)
ETYMOLOGY: 词源一句话(可提原语来源)
FORM: 形态与句法作用；变体形式先给原形和形态再说语法成分，原形则直接说特征。

先据上下文定「正文语言」以决定用哪种读音，按共享文字/借词分圈：
- 汉字圈(中/日/韩/越)：含假名→日语(罗马音)、含谚文→韩语、纯汉字合中文语境→中文(拼音)；中文里的日本/韩国人名地名一律给拼音，不给日/韩读音
- 梵/巴利借词(佛教等)：中日文佛教术语按正文读(拼音/罗马音)，梵/巴利来源只放进 ETYMOLOGY、不作读音
- 阿拉伯字母圈(阿/波斯/乌尔都/奥斯曼/维吾尔/库尔德)：按上下文与词汇定正文语言，给该语言读音
- 西里尔圈(俄/乌/保/塞/哈萨克/蒙古)：同形字母不同读音，按正文语言
- 拉丁圈(英/法/德/意/西/土耳其/越南等)：同拼写跨语言，按正文语言与上下文
- 专名通则：人名地名跨语言保字形/拼写，按正文语言读(读者怎么读)
用IPA的语言，不标短元音的文字按标准音补全(波斯语德黑兰音 æ/e/o、ɒː/iː/uː)并标重音ˈ。`,

  // ---- 生命周期 ----
  init({ id, version, rootURI }) {
    this._id = id;
    this._version = version;
    this._rootURI = rootURI;
    this._migrateFromDeepLex();
    this._loadEntries();
  },

  // 从旧名 DeepLex（extensions.deeplex.*）一次性迁移到 nama.*。
  // 换插件 id 后偏好仍保存在 Zotero 全局 prefs 里，可直接读到，
  // 所以用户已存的生词本与 API Key 不会丢。
  _migrateFromDeepLex() {
    try {
      if (!Zotero.Prefs.get(this.PREF_ENTRIES, true)) {
        const oldEntries = Zotero.Prefs.get(this.OLD_PREF_ENTRIES, true);
        if (oldEntries) {
          Zotero.Prefs.set(this.PREF_ENTRIES, oldEntries, true);
        }
      }
      if (!Zotero.Prefs.get(this.PREF_API_KEY, true)) {
        const oldKey = Zotero.Prefs.get(this.OLD_PREF_API_KEY, true);
        if (oldKey) {
          Zotero.Prefs.set(this.PREF_API_KEY, oldKey, true);
        }
      }
    } catch (e) {
      Zotero.debug("[Nama] migrate from DeepLex failed: " + e);
    }
  },

  registerReaderListener() {
    this._onPopup = this.handleTextSelectionPopup.bind(this);
    Zotero.Reader.registerEventListener("renderTextSelectionPopup", this._onPopup, this._id);
  },

  unregisterReaderListener() {
    if (this._onPopup) {
      Zotero.Reader.unregisterEventListener("renderTextSelectionPopup", this._onPopup);
      this._onPopup = null;
    }
  },

  // ---- 阅读器文字选择弹窗 ----
  handleTextSelectionPopup(event) {
    try {
      const { doc, params, append } = event;
      const text = this._norm(params && params.annotation && params.annotation.text);
      if (!text) {
        return;
      }
      const context = this._getContext(event, text);
      const container = doc.createElement("div");
      this._styleCard(container);
      append(container);
      this._renderLoading(doc, container, text);
      this._runLookup(doc, container, text, context);
    } catch (e) {
      Zotero.debug("[Nama] popup error: " + e);
    }
  },

  // 省事版上下文：尽力抓取选区所在的文本块（段落/邻近行），供模型消歧（尤其波斯语）。
  // 抓不到就回退为选中的词本身，不影响使用。
  _getContext(event, selectedText) {
    try {
      const doc = event && event.doc;
      const sel = doc && doc.getSelection && doc.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        return selectedText;
      }
      const node = sel.anchorNode;
      const el = node && (node.nodeType === 1 ? node : node.parentElement);
      if (!el) {
        return selectedText;
      }
      const block = (el.closest && el.closest("p, li, blockquote, td, th, figcaption, div, span")) || el;
      const parts = [];
      const prev = block.previousElementSibling;
      if (prev && prev.textContent) {
        parts.push(prev.textContent);
      }
      parts.push(block.textContent || "");
      const next = block.nextElementSibling;
      if (next && next.textContent) {
        parts.push(next.textContent);
      }
      let text = this._norm(parts.join(" "));
      if (!text) {
        return selectedText;
      }
      const MAX = 400;
      if (text.length > MAX) {
        const idx = text.indexOf(selectedText);
        if (idx >= 0) {
          const start = Math.max(0, idx - Math.floor((MAX - selectedText.length) / 2));
          text = text.slice(start, start + MAX);
        } else {
          text = text.slice(0, MAX);
        }
      }
      return text;
    } catch (e) {
      return selectedText;
    }
  },

  async _runLookup(doc, container, text, context) {
    const ctx = context || text;
    try {
      this._loadEntries(); // 与生词本窗口的改动保持同步
      const existing = this._findEntry(text, ctx);
      if (existing) {
        this._renderResult(doc, container, existing, existing, false);
        return;
      }

      const apiKey = this.getApiKey();
      if (!apiKey) {
        const e = new Error("请先设置 DeepSeek API Key");
        e.type = "missing_key";
        throw e;
      }

      const data = await this.queryDeepSeek(apiKey, text, ctx);

      const entry = this._saveEntry(data, text, ctx);
      this._renderResult(doc, container, entry, entry, false);
    } catch (e) {
      this._renderError(doc, container, e, text);
    }
  },

  // ---- DeepSeek 调用（Zotero.HTTP，特权环境无 CORS；非流式一次性返回）----
  async queryDeepSeek(apiKey, word, sentence) {
    const body = JSON.stringify({
      model: this.MODEL,
      temperature: 0.2,
      // 关闭思考模式（v4 默认开启，会显著变慢甚至超时）
      thinking: { type: "disabled" },
      // 字段本就短，限个上限防跑长、稳住速度
      max_tokens: 300,
      messages: [
        { role: "system", content: this.SYSTEM_PROMPT },
        { role: "user", content: "单词：" + word + "\n句子：" + sentence }
      ]
    });

    let status;
    let responseText = "";

    try {
      const xhr = await Zotero.HTTP.request("POST", this.API_ENDPOINT, {
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + apiKey
        },
        body,
        timeout: this.API_TIMEOUT_MS,
        responseType: "text",
        successCodes: false
      });
      status = xhr.status;
      responseText = xhr.responseText || "";
    } catch (error) {
      if (error && error.xmlhttp) {
        status = error.xmlhttp.status;
        responseText = error.xmlhttp.responseText || "";
      } else {
        const msg = String((error && error.message) || error || "");
        const isTimeout = /timeout|timed out/i.test(msg) || (error && error.timeout);
        const e = new Error(isTimeout ? "请求超时，请重试" : "网络错误，请重试");
        e.type = isTimeout ? "timeout" : "network";
        throw e;
      }
    }

    if (status < 200 || status >= 300) {
      let payload = null;
      try {
        payload = JSON.parse(responseText);
      } catch (e) {
        payload = null;
      }
      throw this._apiError(status, payload, responseText);
    }

    let content = "";
    try {
      const obj = JSON.parse(responseText);
      content = (obj.choices && obj.choices[0] && obj.choices[0].message &&
        obj.choices[0].message.content) || "";
    } catch (e) {
      content = "";
    }
    if (!content || !content.trim()) {
      const e = new Error("解析失败");
      e.type = "invalid_json";
      throw e;
    }
    return this._parseAnalysis(content, word);
  },

  // 解析逐行标签格式；兼容旧 JSON 输出。
  _parseAnalysis(text, fallbackWord) {
    const field = (key) => {
      const m = text.match(new RegExp("^[\\s>*\\-]*" + key + "\\s*[:：]\\s*(.+)$", "im"));
      return m ? this._short(m[1]) : "";
    };

    let word = field("WORD");
    let translit = field("PRON") || field("IPA");
    let lang = field("LANG");
    let meaning = field("MEANING");
    let etymology = field("ETYMOLOGY");
    let form = field("FORM");

    if (!word && !meaning && text.indexOf("{") !== -1) {
      try {
        const obj = this._extractJson(text);
        word = this._short(obj.word) || word;
        translit = this._short(obj.translit) || translit;
        lang = this._short(obj.lang) || lang;
        meaning = this._short(obj.meaning) || meaning;
        etymology = this._short(obj.etymology) || etymology;
        form = this._short(obj.form || obj.role) || form;
      } catch (e) {
        // 忽略
      }
    }

    return {
      word: word || fallbackWord,
      lang: lang || "未知语言",
      translit,
      meaning,
      etymology,
      form
    };
  },

  _extractJson(text) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) {
      return {};
    }
    return JSON.parse(text.slice(start, end + 1));
  },

  _apiError(status, payload, responseText) {
    const apiMessage = (payload && payload.error && payload.error.message) || responseText || "API调用失败";
    const error = new Error(apiMessage);
    error.status = status;
    if (status === 401) {
      error.type = "invalid_key";
      error.message = "API Key 无效";
      return error;
    }
    if (status === 402 || /insufficient|balance|quota|余额|欠费/i.test(apiMessage)) {
      error.type = "insufficient_balance";
      error.message = "DeepSeek 账户余额不足";
      return error;
    }
    error.type = "api_error";
    return error;
  },

  // ---- 渲染 ----
  _styleCard(el) {
    el.style.cssText = [
      "font-family:-apple-system,system-ui,'Segoe UI',sans-serif",
      "box-sizing:border-box",
      "min-width:240px",
      "max-width:340px",
      "margin:4px",
      "padding:10px 12px",
      "background:#ffffff",
      "color:#1f2937",
      "border:1px solid #e5e7eb",
      "border-radius:8px",
      "font-size:13px",
      "line-height:1.5",
      "text-align:left"
    ].join(";");
  },

  _renderLoading(doc, container, text) {
    container.replaceChildren();
    const word = doc.createElement("div");
    word.textContent = text;
    word.style.cssText = "font-size:15px;font-weight:600;word-break:break-word;";
    const status = doc.createElement("div");
    status.textContent = "Nama 分析中…";
    status.style.cssText = "margin-top:6px;color:#6b7280;";
    container.append(word, status);
  },

  _renderResult(doc, container, data, entry, live) {
    container.replaceChildren();

    const header = doc.createElement("div");
    header.style.cssText = "display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;";
    const word = doc.createElement("span");
    word.textContent = data.word || "";
    word.style.cssText = "font-size:16px;font-weight:600;word-break:break-word;";
    header.append(word);
    if (data.translit) {
      const ipa = doc.createElement("span");
      ipa.textContent = data.translit;
      ipa.style.cssText = "color:#2563eb;font-size:13px;";
      header.append(ipa);
    }
    container.append(header);

    if (data.lang) {
      const tag = doc.createElement("span");
      tag.textContent = data.lang;
      tag.style.cssText = "display:inline-block;margin-top:6px;padding:1px 8px;background:#eef2ff;color:#4338ca;border-radius:10px;font-size:11px;";
      container.append(tag);
    }

    const placeholder = live ? "…" : "暂无";
    container.append(this._field(doc, "💡", "词义", data.meaning || placeholder));
    container.append(this._field(doc, "🌱", "词源", data.etymology || placeholder));
    container.append(this._field(doc, "📍", "句中作用", data.form || placeholder));

    if (live) {
      const tip = doc.createElement("div");
      tip.textContent = "生成中…";
      tip.style.cssText = "margin-top:6px;color:#9ca3af;font-size:11px;";
      container.append(tip);
    } else if (entry && entry.id) {
      const actions = doc.createElement("div");
      actions.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px;";
      actions.append(this._starButton(doc, entry), this._reanalyzeButton(doc, container, entry));
      container.append(actions);
    }
  },

  _reanalyzeButton(doc, container, entry) {
    const btn = doc.createElement("button");
    btn.textContent = "重新分析";
    btn.style.cssText = "padding:3px 10px;border:1px solid #d1d5db;border-radius:6px;" +
      "cursor:pointer;font-size:12px;color:#374151;background:#f9fafb;";
    btn.addEventListener("click", () => this._reanalyze(doc, container, entry));
    return btn;
  },

  async _reanalyze(doc, container, entry) {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      this._renderError(doc, container, { type: "missing_key" }, entry.word);
      return;
    }
    const context = entry.context || entry.word;
    try {
      const data = await this.queryDeepSeek(apiKey, entry.word, context, (partial) => {
        this._renderResult(doc, container, Object.assign({}, entry, partial), null, true);
      });
      const merged = Object.assign({}, entry, {
        word: data.word || entry.word,
        translit: data.translit || entry.translit,
        meaning: data.meaning || entry.meaning,
        etymology: data.etymology || entry.etymology,
        form: data.form || entry.form,
        lang: data.lang || entry.lang,
        timestamp: Date.now()
      });
      const idx = this._entries.findIndex((e) => e.id === entry.id);
      if (idx >= 0) {
        this._entries[idx] = merged;
      } else {
        this._entries.push(merged);
      }
      this._saveEntries();
      this._renderResult(doc, container, merged, merged, false);
    } catch (e) {
      this._renderError(doc, container, e, entry.word);
    }
  },

  _field(doc, icon, label, value) {
    const row = doc.createElement("div");
    row.style.cssText = "display:flex;gap:6px;margin-top:6px;";
    const iconNode = doc.createElement("span");
    iconNode.textContent = icon;
    const body = doc.createElement("div");
    const labelNode = doc.createElement("div");
    labelNode.textContent = label;
    labelNode.style.cssText = "font-size:11px;color:#6b7280;";
    const valueNode = doc.createElement("div");
    valueNode.textContent = value;
    valueNode.style.cssText = "color:#1f2937;word-break:break-word;";
    body.append(labelNode, valueNode);
    row.append(iconNode, body);
    return row;
  },

  _starButton(doc, entry) {
    const btn = doc.createElement("button");
    const paint = (starred) => {
      btn.textContent = starred ? "⭐ 已收藏" : "☆ 收藏到生词本";
      btn.style.cssText = "padding:3px 10px;border:1px solid #d1d5db;" +
        "border-radius:6px;cursor:pointer;font-size:12px;color:#374151;background:" +
        (starred ? "#fef3c7" : "#f9fafb") + ";";
    };
    paint(Boolean(entry.starred));
    btn.addEventListener("click", () => {
      btn.disabled = true;
      try {
        const updated = this.toggleStar(entry.id);
        entry.starred = Boolean(updated.starred);
        paint(entry.starred);
      } catch (e) {
        Zotero.debug("[Nama] star error: " + e);
      }
      btn.disabled = false;
    });
    return btn;
  },

  _renderError(doc, container, error, fallbackWord) {
    container.replaceChildren();
    const word = doc.createElement("div");
    word.textContent = fallbackWord;
    word.style.cssText = "font-size:15px;font-weight:600;word-break:break-word;";
    const msg = doc.createElement("div");
    msg.textContent = this._friendlyError(error);
    msg.style.cssText = "margin-top:6px;color:#b91c1c;";
    container.append(word, msg);

    if (error && error.type === "missing_key") {
      const hint = doc.createElement("div");
      hint.textContent = "请在顶部菜单 工具(Tools) ▸ “Nama: 设置 DeepSeek API Key” 中配置。";
      hint.style.cssText = "margin-top:6px;color:#6b7280;font-size:11px;";
      container.append(hint);
    }
  },

  _friendlyError(error) {
    switch (error && error.type) {
      case "missing_key": return "请先设置 DeepSeek API Key";
      case "invalid_key": return "API Key 无效";
      case "insufficient_balance": return "DeepSeek 账户余额不足";
      case "network": return "网络错误，请重试";
      case "timeout": return "请求超时，请重试";
      case "invalid_json": return "解析失败，请重试";
      default: return (error && error.message) || "查询失败";
    }
  },

  // ---- API Key ----
  getApiKey() {
    try {
      return this._norm(Zotero.Prefs.get(this.PREF_API_KEY, true));
    } catch (e) {
      return "";
    }
  },

  promptForApiKey(window) {
    const input = { value: this.getApiKey() };
    const ok = Services.prompt.prompt(window, "Nama",
      "请输入 DeepSeek API Key（留空可清除）：", input, null, {});
    if (!ok) {
      return;
    }
    Zotero.Prefs.set(this.PREF_API_KEY, this._norm(input.value), true);
    window.alert("Nama：API Key 已保存。");
  },

  // ---- 工具菜单 ----
  addToAllWindows() {
    for (const win of Zotero.getMainWindows()) {
      if (win.ZoteroPane) {
        this.addToWindow(win);
      }
    }
  },

  addToWindow(window) {
    const doc = window.document;
    if (!doc) {
      return;
    }
    const popup = doc.getElementById("menu_ToolsPopup");
    if (!popup) {
      return;
    }
    if (!doc.getElementById("nama-menu-setkey")) {
      const setKey = doc.createXULElement("menuitem");
      setKey.id = "nama-menu-setkey";
      setKey.setAttribute("label", "Nama: 设置 DeepSeek API Key");
      setKey.addEventListener("command", () => this.promptForApiKey(window));
      popup.appendChild(setKey);
    }
    if (!doc.getElementById("nama-menu-notebook")) {
      const notebook = doc.createXULElement("menuitem");
      notebook.id = "nama-menu-notebook";
      notebook.setAttribute("label", "Nama: 打开生词本");
      notebook.addEventListener("command", () => this.openNotebook(window));
      popup.appendChild(notebook);
    }
  },

  removeFromWindow(window) {
    for (const id of ["nama-menu-setkey", "nama-menu-notebook"]) {
      const item = window.document && window.document.getElementById(id);
      if (item) {
        item.remove();
      }
    }
  },

  removeFromAllWindows() {
    for (const win of Zotero.getMainWindows()) {
      this.removeFromWindow(win);
    }
  },

  openNotebook(parentWindow) {
    try {
      const win = parentWindow.openDialog(
        "about:blank",
        "nama-notebook",
        "chrome,centerscreen,resizable,width=780,height=660"
      );
      if (!win) {
        parentWindow.alert("无法打开生词本窗口");
        return;
      }
      const run = () => {
        try {
          this._buildNotebook(win);
        } catch (e) {
          Zotero.debug("[Nama] notebook build error: " + e);
          try {
            win.document.body.textContent = "生词本出错：" + e;
          } catch (e2) {
            // ignore
          }
        }
      };
      win.addEventListener("load", run, { once: true });
      // about:blank 可能已经加载完，兜底再跑一次（_buildNotebook 内有去重）。
      win.setTimeout(run, 60);
    } catch (e) {
      Zotero.debug("[Nama] openNotebook error: " + e);
      parentWindow.alert("打开生词本失败：" + e);
    }
  },

  _buildNotebook(win) {
    if (win._namaBuilt) {
      return;
    }
    win._namaBuilt = true;

    const self = this;
    const doc = win.document;
    doc.title = "Nama 生词本";
    doc.body.style.margin = "0";

    const style = doc.createElement("style");
    style.textContent = this.NOTEBOOK_CSS;
    doc.head.appendChild(style);

    const root = doc.createElement("div");
    root.id = "nb-root";
    doc.body.appendChild(root);

    let entries = [];
    let langFilter = "";
    let sortMode = "newest";
    const SORTS = [["newest", "最新优先"], ["oldest", "最早优先"], ["language", "按语言"]];
    const TIMES = [["all", "全部时间"], ["today", "今天"], ["7d", "近7天"], ["30d", "近30天"]];
    const EXPORTS = [["all", "全部"], ["new", "未导出"], ["done", "已导出"]];
    const ui = {};
    let timeFilter = "all";
    let exportFilter = "all";
    const selected = new Set();
    let lastIndex = -1;
    let currentList = [];

    const header = el("div", "nb-header");
    ui.count = el("span", "nb-count", "");
    header.append(el("span", "nb-title", "📒 Nama 生词本"), ui.count);

    const controls = el("div", "nb-controls");
    ui.search = doc.createElement("input");
    ui.search.type = "text";
    ui.search.placeholder = "搜索单词或词义…";
    ui.search.addEventListener("input", render);

    ui.export = el("button", "nb-export", "导出 CSV (Anki)");
    ui.export.addEventListener("click", exportCsv);

    controls.append(ui.search, ui.export);

    ui.langRow = el("div", "nb-chiprow");
    ui.timeRow = el("div", "nb-chiprow");
    ui.exportRow = el("div", "nb-chiprow");
    ui.sortRow = el("div", "nb-chiprow");

    ui.selbar = el("div", "nb-selbar");
    ui.selInfo = el("span", "nb-count", "已选 0 项");
    ui.selAll = el("button", "nb-chip", "全选");
    ui.selAll.addEventListener("click", () => {
      currentList.forEach((e) => selected.add(e.id));
      render();
    });
    ui.selClear = el("button", "nb-chip", "清空选择");
    ui.selClear.addEventListener("click", () => {
      selected.clear();
      lastIndex = -1;
      render();
    });
    ui.selDelete = el("button", "nb-del", "删除选中 (0)");
    ui.selDelete.addEventListener("click", deleteSelected);
    ui.selbar.append(ui.selInfo, ui.selAll, ui.selClear, ui.selDelete);

    ui.list = el("div", "nb-list");
    ui.empty = el("div", "nb-empty", "生词本还是空的。在阅读器里查词后点“☆ 收藏到生词本”即可加入。");

    root.append(header, controls, ui.langRow, ui.timeRow, ui.exportRow, ui.sortRow, ui.selbar, ui.list, ui.empty);

    renderTimeChips();
    renderExportChips();
    renderSortChips();
    refresh();

    function refresh() {
      self._loadEntries();
      entries = self.getStarredEntries();
      renderLangFilter();
      render();
    }

    function chip(label, active, onClick) {
      const b = el("button", active ? "nb-chip nb-chip-active" : "nb-chip", label);
      b.addEventListener("click", onClick);
      return b;
    }

    function renderSortChips() {
      ui.sortRow.replaceChildren(...SORTS.map(([v, t]) =>
        chip(t, sortMode === v, () => {
          sortMode = v;
          renderSortChips();
          render();
        })));
    }

    function renderTimeChips() {
      ui.timeRow.replaceChildren(...TIMES.map(([v, t]) =>
        chip(t, timeFilter === v, () => {
          timeFilter = v;
          renderTimeChips();
          render();
        })));
    }

    function renderExportChips() {
      ui.exportRow.replaceChildren(...EXPORTS.map(([v, t]) =>
        chip(t, exportFilter === v, () => {
          exportFilter = v;
          renderExportChips();
          render();
        })));
    }

    function inExportStatus(entry) {
      if (exportFilter === "all") {
        return true;
      }
      const exported = Number(entry.exportedAt) > 0;
      return exportFilter === "done" ? exported : !exported;
    }

    function inTimeRange(ts) {
      if (timeFilter === "all") {
        return true;
      }
      const n = Number(ts);
      if (!Number.isFinite(n) || n <= 0) {
        return false;
      }
      const now = new Date();
      if (timeFilter === "today") {
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        return n >= start;
      }
      const days = timeFilter === "7d" ? 7 : 30;
      return n >= now.getTime() - days * 86400000;
    }

    function renderLangFilter() {
      const langs = unique(entries.map((e) => e.lang).filter(Boolean))
        .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
      if (langFilter && !langs.includes(langFilter)) {
        langFilter = "";
      }
      const opts = [["", "全部语言"]].concat(langs.map((l) => [l, l]));
      ui.langRow.replaceChildren(...opts.map(([v, t]) =>
        chip(t, langFilter === v, () => {
          langFilter = v;
          renderLangFilter();
          render();
        })));
    }

    function render() {
      const query = (ui.search.value || "").trim().toLowerCase();
      const lang = langFilter;
      const sort = sortMode;
      currentList = entries
        .filter((e) => {
          const matchQuery = !query ||
            (e.word || "").toLowerCase().includes(query) ||
            (e.meaning || "").toLowerCase().includes(query);
          return matchQuery && (!lang || e.lang === lang) &&
            inTimeRange(e.timestamp) && inExportStatus(e);
        })
        .sort((a, b) => compare(a, b, sort));

      ui.count.textContent = entries.length + " 条生词";
      ui.empty.style.display = currentList.length ? "none" : "block";
      ui.list.replaceChildren(...currentList.map(itemNode));
      updateSelBar();
    }

    function updateSelBar() {
      const present = new Set(entries.map((e) => e.id));
      for (const id of Array.from(selected)) {
        if (!present.has(id)) {
          selected.delete(id);
        }
      }
      ui.selInfo.textContent = "已选 " + selected.size + " 项";
      ui.selDelete.textContent = "删除选中 (" + selected.size + ")";
      ui.selDelete.disabled = selected.size === 0;
    }

    function handleCheck(index, shift) {
      const id = currentList[index].id;
      const turnOn = !selected.has(id);
      if (shift && lastIndex >= 0) {
        const a = Math.min(lastIndex, index);
        const b = Math.max(lastIndex, index);
        for (let i = a; i <= b; i += 1) {
          const eid = currentList[i].id;
          if (turnOn) {
            selected.add(eid);
          } else {
            selected.delete(eid);
          }
        }
      } else if (turnOn) {
        selected.add(id);
      } else {
        selected.delete(id);
      }
      lastIndex = index;
      render();
    }

    function deleteSelected() {
      if (!selected.size) {
        return;
      }
      if (!win.confirm("确定删除选中的 " + selected.size + " 条生词？")) {
        return;
      }
      self._unstarMany(Array.from(selected)); // 一次性删除，只写一次盘
      selected.clear();
      lastIndex = -1;
      refresh();
    }

    function itemNode(entry, index) {
      const item = el("div", "nb-item");
      const summary = el("div", "nb-summary");

      const left = el("div", "nb-summary-left");

      const cb = doc.createElement("input");
      cb.type = "checkbox";
      cb.className = "nb-check";
      cb.checked = selected.has(entry.id);
      cb.addEventListener("click", (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        handleCheck(index, ev.shiftKey);
      });

      const main = doc.createElement("div");
      const wordLine = doc.createElement("div");
      wordLine.append(el("span", "nb-word", entry.word));
      if (entry.translit) {
        wordLine.append(el("span", "nb-ipa", entry.translit));
      }
      const metaLine = doc.createElement("div");
      metaLine.append(el("span", "nb-tag", entry.lang || "未知语言"));
      metaLine.append(el("span", "nb-date", "🗓 " + dateOnly(entry.timestamp)));
      if (Number(entry.exportedAt) > 0) {
        metaLine.append(el("span", "nb-exported", "✓ 已导出"));
      }
      main.append(
        wordLine,
        el("div", "nb-meaning", entry.meaning || "暂无词义"),
        metaLine
      );

      left.append(cb, main);

      const del = el("button", "nb-del", "🗑 删除");
      del.addEventListener("click", (ev) => {
        ev.stopPropagation();
        self.toggleStar(entry.id, false);
        selected.delete(entry.id);
        refresh();
      });

      summary.append(left, del);

      const bodyBox = el("div", "nb-body");
      bodyBox.style.display = "none";
      bodyBox.append(
        detailRow("完整词义", entry.meaning || "暂无"),
        detailRow("词源", entry.etymology || "暂无"),
        detailRow("句中作用", entry.form || "暂无"),
        detailRow("上下文", entry.context || "暂无"),
        detailRow("添加日期", dateTime(entry.timestamp))
      );

      summary.addEventListener("click", () => {
        bodyBox.style.display = bodyBox.style.display === "none" ? "block" : "none";
      });

      item.append(summary, bodyBox);
      return item;
    }

    async function exportCsv() {
      if (!entries.length) {
        win.alert("生词本为空，暂无可导出的记录。");
        return;
      }
      const list = currentList.slice();
      if (!list.length) {
        win.alert("当前筛选/搜索范围没有可导出的生词。");
        return;
      }
      const lines = [
        "#separator:tab",
        "#html:true",
        "#tags column:3",
        ...list.map((e) => [
          csvField(frontHtml(e)),
          csvField(backHtml(e)),
          csvField(langTag(e.lang))
        ].join("\t"))
      ];
      const csv = lines.join("\n");
      const filename = "nama_vocabulary_" + dateStr(new Date()) + ".csv";
      try {
        const desktop = Components.classes["@mozilla.org/file/directory_service;1"]
          .getService(Components.interfaces.nsIProperties)
          .get("Desk", Components.interfaces.nsIFile);
        desktop.append(filename);
        await Zotero.File.putContentsAsync(desktop.path, csv);
        try {
          Zotero.File.reveal(desktop.path);
        } catch (e) {
          // ignore
        }
        self._markExported(list.map((e) => e.id));
        refresh();
        win.alert("已导出到桌面：" + filename + "（共 " + list.length + " 条，跟随当前筛选）。\n" +
          "这些词已标记为“已导出”，下次用顶部“未导出”筛选即可只导新词。\n\n" +
          "Anki 导入：文件 → 导入 → 选该 CSV。\n" +
          "· 笔记类型选“基础”，字段1→正面、字段2→背面（第3列已自动设为标签）。\n" +
          "· “现有笔记/Existing notes”选“保留(Preserve)”：重复导入整本生词本时，" +
          "已存在的卡片会被跳过，不会被替换或删除，新词照常加入。");
      } catch (err) {
        win.alert("导出失败：" + err);
      }
    }

    // ---- 内部工具 ----
    function el(tag, cls, text) {
      const node = doc.createElement(tag);
      if (cls) {
        node.className = cls;
      }
      if (text !== undefined) {
        node.textContent = text;
      }
      return node;
    }

    function detailRow(label, value) {
      const row = el("div", "nb-row");
      row.append(el("div", "nb-label", label), el("div", "nb-value", value));
      return row;
    }

    function compare(a, b, sort) {
      if (sort === "oldest") {
        return a.timestamp - b.timestamp;
      }
      if (sort === "language") {
        return (a.lang || "").localeCompare(b.lang || "", "zh-Hans-CN") || b.timestamp - a.timestamp;
      }
      return b.timestamp - a.timestamp;
    }

    function unique(list) {
      return list.filter((v, i) => list.indexOf(v) === i);
    }

    function frontHtml(e) {
      // 末尾埋入隐藏的词条 id：卡面看不见，但让 Anki 把每条生词视为不同的卡，
      // 既保证同词不同语境各留一张，又保证重复导入时按 id 精确去重。
      return '<div style="font-size:22px;line-height:1.6;padding:20px;text-align:center;">' +
        highlight(e.context, e.word) + "</div>" +
        '<span style="display:none">#' + esc(e.id || "") + "</span>";
    }

    function backHtml(e) {
      return '<div style="font-size:18px;line-height:1.8;padding:20px;">' +
        '<div style="font-size:20px;text-align:center;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid #ddd;">' +
        highlight(e.context, e.word) + "</div>" +
        '<div style="margin:8px 0;">📖 <b>' + esc(e.translit) + "</b></div>" +
        '<div style="margin:8px 0;">💡 ' + esc(e.meaning) + "</div>" +
        '<div style="margin:8px 0;">🌱 ' + esc(e.etymology) + "</div>" +
        '<div style="margin:8px 0;">📍 ' + esc(e.form) + "</div></div>";
    }

    function highlight(context, word) {
      const text = String(context || word || "");
      const target = String(word || "");
      const idx = wordIndex(text, target);
      if (!target || idx < 0) {
        return esc(text);
      }
      return esc(text.slice(0, idx)) +
        '<b style="color:#d97706;">' + esc(text.slice(idx, idx + target.length)) + "</b>" +
        esc(text.slice(idx + target.length));
    }

    function wordIndex(text, word) {
      if (!word) {
        return -1;
      }
      let idx = text.indexOf(word);
      const firstOccurrence = idx;
      while (idx >= 0) {
        const before = text[idx - 1] || "";
        const after = text[idx + word.length] || "";
        if (boundary(before) && boundary(after)) {
          return idx;
        }
        idx = text.indexOf(word, idx + word.length);
      }
      // 没有"整词边界"匹配时，退回首次出现位置，避免该高亮却不高亮。
      return firstOccurrence;
    }

    function boundary(ch) {
      return !ch || /[\s‌.,،，;؛:：!?؟۔。！？"'“”‘’«»《》（）()[\]{}<>]/u.test(ch);
    }

    function langTag(lang) {
      const map = { 波斯语: "Persian", 俄语: "Russian", 阿拉伯语: "Arabic", 土耳其语: "Turkish" };
      return map[lang] || String(lang || "Unknown").trim().replace(/\s+/g, "_");
    }

    function csvField(value) {
      // 标准 CSV 转义：整段加双引号、内部双引号写成两个，换行转 <br>。
      // 否则 HTML 里的 style="..." 引号会让 Anki 误判字段边界，丢失上下文/词语。
      const text = String(value == null ? "" : value).replace(/\r\n|\r|\n/g, "<br>");
      return '"' + text.replace(/"/g, '""') + '"';
    }

    function esc(value) {
      return String(value == null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function dateStr(date) {
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, "0");
      const d = String(date.getDate()).padStart(2, "0");
      return y + "-" + m + "-" + d;
    }

    function dateOnly(ts) {
      const n = Number(ts);
      if (!Number.isFinite(n) || n <= 0) {
        return "未知日期";
      }
      return dateStr(new Date(n));
    }

    function dateTime(ts) {
      const n = Number(ts);
      if (!Number.isFinite(n) || n <= 0) {
        return "未知日期";
      }
      const d = new Date(n);
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      return dateStr(d) + " " + hh + ":" + mm;
    }
  },

  NOTEBOOK_CSS: [
    "html,body{margin:0;background:#f8fafc;}",
    "#nb-root{padding:16px;font-family:-apple-system,system-ui,'Segoe UI','Microsoft YaHei',sans-serif;color:#1f2937;font-size:14px;box-sizing:border-box;}",
    ".nb-header{display:flex;align-items:baseline;gap:10px;margin-bottom:12px;}",
    ".nb-title{font-size:18px;font-weight:700;}",
    ".nb-count{color:#6b7280;font-size:13px;}",
    ".nb-controls{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;}",
    ".nb-controls input,.nb-controls select,.nb-controls button{font-size:13px;padding:5px 8px;border:1px solid #d1d5db;border-radius:6px;background:#fff;color:#1f2937;}",
    ".nb-controls input{flex:1;min-width:140px;}",
    ".nb-controls button{cursor:pointer;}",
    ".nb-export{background:#4338ca;color:#fff;border-color:#4338ca;}",
    ".nb-chiprow{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;}",
    ".nb-chip{font-size:12px;padding:3px 10px;border:1px solid #d1d5db;border-radius:14px;background:#fff;color:#374151;cursor:pointer;}",
    ".nb-chip-active{background:#4338ca;color:#fff;border-color:#4338ca;}",
    ".nb-empty{color:#9ca3af;padding:40px 0;text-align:center;}",
    ".nb-item{background:#fff;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:8px;padding:10px 12px;}",
    ".nb-summary{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;cursor:pointer;}",
    ".nb-summary-left{display:flex;align-items:flex-start;gap:10px;flex:1;min-width:0;}",
    ".nb-check{width:16px;height:16px;margin-top:4px;cursor:pointer;flex:none;}",
    ".nb-word{font-size:16px;font-weight:600;}",
    ".nb-ipa{color:#2563eb;font-size:13px;margin-left:8px;}",
    ".nb-meaning{color:#374151;margin-top:2px;}",
    ".nb-tag{display:inline-block;margin-top:4px;padding:1px 8px;background:#eef2ff;color:#4338ca;border-radius:10px;font-size:11px;}",
    ".nb-date{color:#9ca3af;font-size:11px;margin-left:8px;}",
    ".nb-exported{color:#0f766e;background:#ecfdf5;border:1px solid rgba(15,118,110,0.2);border-radius:10px;font-size:11px;padding:1px 8px;margin-left:8px;}",
    ".nb-selbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px;}",
    ".nb-del[disabled]{opacity:0.45;cursor:not-allowed;}",
    ".nb-del{border:1px solid #fecaca;background:#fef2f2;color:#b91c1c;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:12px;white-space:nowrap;}",
    ".nb-body{margin-top:8px;border-top:1px dashed #e5e7eb;padding-top:8px;}",
    ".nb-row{display:flex;gap:8px;margin-top:4px;}",
    ".nb-label{color:#6b7280;min-width:64px;font-size:12px;}",
    ".nb-value{color:#1f2937;}"
  ].join(""),

  // ---- 词条数据 ----
  _loadEntries() {
    try {
      const raw = Zotero.Prefs.get(this.PREF_ENTRIES, true);
      this._entries = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(this._entries)) {
        this._entries = [];
      }
    } catch (e) {
      this._entries = [];
    }
    if (this._entries.length === 0) {
      this._migrateOldCache();
    }
  },

  _migrateOldCache() {
    try {
      const raw = Zotero.Prefs.get(this.PREF_CACHE, true);
      if (!raw) {
        return;
      }
      const obj = JSON.parse(raw);
      const now = Date.now();
      this._entries = Object.values(obj)
        .map((v) => this._createEntry(v, v.word || "", v.context || "", v.timestamp || now))
        .filter(Boolean);
      this._saveEntries();
    } catch (e) {
      // 迁移失败不影响使用
    }
  },

  _saveEntries() {
    try {
      Zotero.Prefs.set(this.PREF_ENTRIES, JSON.stringify(this._entries), true);
    } catch (e) {
      Zotero.debug("[Nama] save entries failed: " + e);
    }
  },

  _findEntry(word, context) {
    const w = this._norm(word).toLowerCase();
    const c = this._norm(context).toLowerCase();
    return this._entries.find((e) =>
      this._norm(e.word).toLowerCase() === w &&
      this._norm(e.context).toLowerCase() === c) || null;
  },

  _createEntry(data, fallbackWord, context, ts) {
    const word = this._short(data.word) || fallbackWord;
    if (!word) {
      return null;
    }
    return {
      id: this._newId(),
      word,
      translit: this._short(data.translit),
      etymology: this._short(data.etymology),
      meaning: this._short(data.meaning),
      form: this._short(data.form || data.role),
      lang: this._short(data.lang) || "未知语言",
      context: this._trim(context, 500),
      timestamp: ts || Date.now(),
      starred: Boolean(data.starred)
    };
  },

  _saveEntry(data, word, context) {
    const entry = this._createEntry(data, word, context, Date.now());
    this._entries.push(entry);
    this._pruneEntries();
    this._saveEntries();
    return entry;
  },

  toggleStar(id, starred) {
    const entry = this._entries.find((e) => e.id === id);
    if (!entry) {
      return { starred: false };
    }
    entry.starred = typeof starred === "boolean" ? starred : !entry.starred;
    this._saveEntries();
    return entry;
  },

  getStarredEntries() {
    return this._entries.filter((e) => e.starred).slice();
  },

  _markExported(ids) {
    const set = new Set(ids);
    const now = Date.now();
    for (const entry of this._entries) {
      if (set.has(entry.id)) {
        entry.exportedAt = now;
      }
    }
    this._saveEntries();
  },

  _unstarMany(ids) {
    const set = new Set(ids);
    for (const entry of this._entries) {
      if (set.has(entry.id)) {
        entry.starred = false;
      }
    }
    this._saveEntries();
  },

  _pruneEntries() {
    if (this._entries.length <= this.ENTRY_CAP) {
      return;
    }
    const removable = this._entries
      .filter((e) => !e.starred)
      .sort((a, b) => a.timestamp - b.timestamp);
    const removeCount = this._entries.length - this.ENTRY_CAP;
    const removeIds = new Set(removable.slice(0, removeCount).map((e) => e.id));
    this._entries = this._entries.filter((e) => !removeIds.has(e.id));
  },

  // ---- 小工具 ----
  _newId() {
    try {
      if (Zotero.Utilities && Zotero.Utilities.randomString) {
        return "dl-" + Zotero.Utilities.randomString(10);
      }
    } catch (e) {
      // fall through
    }
    return "dl-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  },

  _trim(value, max) {
    const s = this._norm(value);
    return s.length <= max ? s : s.slice(0, max) + "...";
  },

  _norm(value) {
    return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  },

  _short(value) {
    if (value === null || value === undefined) {
      return "";
    }
    return String(value).trim().replace(/\s+/g, " ");
  }
};

(() => {
  const CARD_ID = "mlwa-card-root";
  const CARD_WIDTH = 300;
  const EDGE_PUNCT = /^[\s"'“”‘’«»《》（）()[\]{}<>.,，、:：;؛!?。！？؟۔]+|[\s"'“”‘’«»《》（）()[\]{}<>.,，、:：;؛!?。！？؟۔]+$/gu;
  const SENTENCE_END = /[.!?。！？؟۔\n\r]/u;
  // 不查：纯数字/符号（日期、电话、ISBN、价格，含波斯/阿拉伯数字），以及整个选区就是网址、邮箱、裸域名。
  // 多是复制时顺手选中的，每次都白调一次 DeepSeek。句子里带个链接的照常查。
  const NOT_A_WORD = /^[\p{N}\s.,:;/+\-–—%()#]+$|^\S*(https?:\/\/|www\.)\S*$|^\S+@\S+\.\S+$|^[\w-]+(\.[\w-]+)*\.(com|net|org|edu|gov|io|cn|de|ir|ru|uk|fr|jp|info|me|app|dev)(\/\S*)?$/iu;

  let card = null;
  let ui = null;    // 卡片里会变的节点
  let port = null;
  let cur = null;   // 当前卡片：{ word, sentence, rect, id, starred, data }
  let lock = "";    // 锁定的正文语言，"" = 自动识别

  const h = (tag, props = {}, ...kids) => {
    const el = Object.assign(document.createElement(tag), props);
    el.append(...kids.filter((k) => k != null && k !== false));
    return el;
  };

  document.addEventListener("mouseup", (event) => {
    if (card?.contains(event.target)) return;
    setTimeout(() => {
      const sel = readSelection();
      if (sel) lookup(sel);
    }, 30);
  }, true);
  document.addEventListener("mousedown", (event) => {
    if (card && !card.contains(event.target)) closeCard();
  }, true);
  document.addEventListener("keydown", (event) => event.key === "Escape" && closeCard());
  document.addEventListener("fullscreenchange", closeCard);   // 进出全屏后位置必然失效

  function readSelection() {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const word = sel.toString().replace(/\u00A0/g, " ").replace(/\s+/g, " ").replace(EDGE_PUNCT, "");
    if (!word) {
      closeCard();
      return null;
    }
    if (NOT_A_WORD.test(word)) return null;
    const range = sel.getRangeAt(0);
    const box = range.getBoundingClientRect();
    const rect = box.width || box.height ? box : range.getClientRects()[0];
    return rect && { word, rect, sentence: sentenceAround(range, word) || word };
  }

  // 选区所在块元素里，从上一个句末标点到下一个句末标点；跨内联标签（链接、强调）也连得上。
  // 用 innerText（渲染后的文字）而不是 textContent：HTML 源码里的折行在 textContent 里是 \n，
  // 会把长句切成几个词；<br> 在 textContent 里又什么都没有，前后两行的词会粘在一起。
  function sentenceAround(range, word) {
    // 按共同祖先找块：选区起点常落在上一个元素的文字末尾，按起点找会找到别的块
    const node = range.commonAncestorContainer;
    const block = (node.nodeType === 1 ? node : node.parentElement)
      ?.closest("p,li,blockquote,td,th,dd,dt,figcaption,h1,h2,h3,h4,h5,h6,div") || document.body;
    const text = block.innerText;
    // 在 innerText 里找选中的文字；块里出现多次时取位置最接近选区的那次（按 textContent 偏移等比估算）
    const before = document.createRange();
    before.setStart(block, 0);
    before.setEnd(range.startContainer, range.startOffset);
    const guess = (before.toString().length / Math.max(1, block.textContent.length)) * text.length;
    const re = new RegExp(word.split(" ").map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), "giu");
    let hit = null;
    for (const m of text.matchAll(re)) if (!hit || Math.abs(m.index - guess) < Math.abs(hit.index - guess)) hit = m;
    if (!hit) return "";
    const i = hit.index;
    const j = i + hit[0].length;
    let a = i;
    let b = j;
    while (a > 0 && !SENTENCE_END.test(text[a - 1])) a--;
    while (b < text.length && !SENTENCE_END.test(text[b])) b++;
    // 超长无标点的段落只取选区前后各 250 字
    return text.slice(Math.max(a, i - 250), Math.min(b + 1, j + 250)).replace(/\s+/g, " ").trim();
  }

  // 后台消息：{data} 流式片段 → {done, data} 最终词条 → 可能再来 {patch} 词典读音 → 后台断开
  function lookup(sel, fresh = false) {
    port?.disconnect();
    cur = { word: sel.word, sentence: sel.sentence, rect: sel.rect, id: fresh ? sel.id : null, starred: fresh && sel.starred, data: {} };
    build();
    render(true);
    let settled = false;
    let p;
    try {
      p = port = chrome.runtime.connect({ name: "nama-lookup" });
    } catch {
      port = null;
      return showError({ message: "扩展刚更新过，请刷新本页" });
    }
    p.onMessage.addListener((msg) => {
      if (p !== port) return;
      if (msg.error) {
        port = null;
        p.disconnect();
        return showError(msg.error);
      }
      if (msg.lock !== undefined) lock = msg.lock;
      if (msg.done) {
        settled = true;
        cur.id = msg.data.id;
        cur.starred = msg.data.starred;
      }
      Object.assign(cur.data, msg.data || msg.patch);
      render(!settled);
    });
    p.onDisconnect.addListener(() => {
      if (p !== port) return;
      port = null;
      if (!settled) showError({ message: "扩展后台断开了，请重试" });
    });
    p.postMessage({ word: cur.word, sentence: cur.sentence, fresh, id: cur.id });
  }

  // 每次查词搭一次骨架，流式结果只改文字：下拉框要是跟着重建，一打开就会被收起
  function build() {
    const value = () => h("span", { className: "mlwa-field-value" });
    const field = (icon, label, node) => h("div", { className: "mlwa-field" },
      h("span", { className: "mlwa-field-icon", textContent: icon }),
      h("div", { className: "mlwa-field-content" }, h("span", { className: "mlwa-field-label", textContent: label }), node));
    ui = {
      translit: h("span"),
      star: h("button", { type: "button", onclick: toggleStar }),
      lang: h("span", { className: "mlwa-lang-tag" }),
      select: langSelect(),
      meaning: value(),
      etymology: value(),
      form: value(),
      redo: h("button", { type: "button", className: "mlwa-secondary-button", onclick: () => lookup(cur, true) })
    };
    show(
      header(ui.translit, ui.star),
      h("div", { className: "mlwa-tag-row" }, ui.lang, ui.select),
      field("💡", "词义", ui.meaning),
      field("🌱", "词源", ui.etymology),
      field("📍", "句中作用", ui.form),
      h("div", { className: "mlwa-footer" }, ui.redo)
    );
  }

  function render(busy) {
    const d = cur.data;
    const blank = busy ? "…" : "暂无";
    Object.assign(ui.translit, {
      hidden: !d.translit,
      textContent: d.translit || "",
      className: d.ipaDict ? "mlwa-translit mlwa-dict" : "mlwa-translit",
      title: d.ipaDict ? "IPA 取自 Wiktionary（kaikki.org）" : "模型给出的读音"
    });
    ui.lang.textContent = d.lang || (busy ? "…" : "未知语言");
    if (ui.select.value !== lock) ui.select.value = lock;
    for (const key of ["meaning", "etymology", "form"]) ui[key].textContent = d[key] || blank;
    Object.assign(ui.redo, { textContent: busy ? "生成中…" : "重新分析", disabled: busy });
    paintStar();
    place();
  }

  function paintStar() {
    Object.assign(ui.star, {
      hidden: !cur.id,
      disabled: false,
      className: cur.starred ? "mlwa-star is-starred" : "mlwa-star",
      textContent: cur.starred ? "⭐" : "☆",
      title: cur.starred ? "从生词本移除" : "加入生词本"
    });
  }

  function showError(error) {
    ui = null;
    show(
      header(),
      h("div", { className: "mlwa-status mlwa-status-error", textContent: error.message || "查询失败" }),
      error.type === "missing_key"
        ? h("div", { className: "mlwa-footer" }, h("button", {
          type: "button",
          className: "mlwa-primary-button",
          textContent: "打开设置页",
          onclick: () => chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" })
        }))
        : h("div", { className: "mlwa-hint", textContent: "可以稍后重新选中再试。" })
    );
  }

  function header(translit, star) {
    return h("div", { className: "mlwa-header" },
      h("div", { className: "mlwa-title" }, h("span", { className: "mlwa-word", textContent: cur.word }), translit),
      h("div", { className: "mlwa-header-actions" }, star,
        h("button", { type: "button", className: "mlwa-close", textContent: "×", title: "关闭", onclick: closeCard })));
  }

  // 正文语言：锁定后模型只按这门语言分析，不会在近亲语言之间跳；所有页面共用
  function langSelect() {
    const select = h("select", { className: "mlwa-lang-select", title: "正文语言" },
      h("option", { value: "", textContent: "自动识别" }),
      ...Object.keys(LANGS).map((name) => h("option", { value: name, textContent: name })));
    select.value = lock;
    select.onchange = async () => {
      lock = select.value;
      await chrome.storage.local.set({ readLang: lock });
      lookup(cur);
    };
    return select;
  }

  async function toggleStar() {
    const c = cur;   // 等待期间卡片可能已换词或关闭
    const starred = !c.starred;
    ui.star.disabled = true;
    const res = await chrome.runtime.sendMessage({ type: "PATCH", items: [{ id: c.id, word: c.data.word }], patch: { starred } })
      .catch((e) => ({ error: { message: e.message } }));
    if (!res?.ok) return c === cur && showError(res?.error || {});
    c.starred = starred;
    if (c === cur && ui) paintStar();
    setHighlight(c.word, starred);
  }

  // 全屏时只有全屏元素的子树会渲染，卡片得挂进去
  function show(...children) {
    const host = document.fullscreenElement || document.documentElement;
    if (!card) {
      card = h("div", { id: CARD_ID, className: "mlwa-card" });
      card.addEventListener("mousedown", (event) => event.stopPropagation());
    }
    if (card.parentNode !== host) host.appendChild(card);
    card.replaceChildren(...children);
    place();
  }

  function place() {
    const fixed = card.parentNode !== document.documentElement;
    const sx = fixed ? 0 : scrollX;
    const sy = fixed ? 0 : scrollY;
    const r = cur.rect;
    const m = 12;
    const left = Math.max(sx + m, Math.min(sx + r.left, sx + innerWidth - CARD_WIDTH - m));
    const below = sy + r.bottom + 8;
    const above = sy + r.top - card.offsetHeight - 8;
    const top = below + card.offsetHeight > sy + innerHeight - m && above > sy + m ? above : below;
    Object.assign(card.style, {
      position: fixed ? "fixed" : "absolute",
      left: `${Math.round(left)}px`,
      top: `${Math.round(Math.max(sy + m, top))}px`
    });
  }

  function closeCard() {
    port?.disconnect();   // 后台照样生成完并存下来，只是不再推给卡片
    port = null;
    cur = null;
    ui = null;
    card?.remove();
    card = null;
  }

  // ===== 生词页内高亮：纯静态点线下划线，不响应鼠标 =====
  const HL = "mlwa-hl";
  const SKIP = `script,style,noscript,textarea,input,select,option,code,pre,kbd,samp,.${HL},#${CARD_ID}`;
  const hlWords = new Set();
  let hlOn = false;
  let hlRe = null;

  chrome.storage.local.get(["starredWords", "highlightEnabled", "readLang"]).then(({ starredWords = [], highlightEnabled = true, readLang = "" }) => {
    lock = langKey(readLang);
    hlOn = highlightEnabled;
    if (!hlOn) return;
    starredWords.forEach(addWord);
    buildRegex();
    observe();
    scan();
    // 兜底：load 之后和稍后几秒再整页扫一遍，覆盖观察器漏掉的内容（已高亮的会跳过）
    addEventListener("load", scan, { once: true });
    setTimeout(scan, 1500);
    setTimeout(scan, 4000);
  }).catch(() => {});

  function addWord(word) {
    const w = String(word || "").trim().toLowerCase();
    if (w.length >= 2) hlWords.add(w);
  }

  function buildRegex() {
    const alt = [...hlWords]
      .sort((a, b) => b.length - a.length)   // 长词优先
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|");
    hlRe = alt ? new RegExp(`(?<![\\p{L}\\p{M}])(?:${alt})(?![\\p{L}\\p{M}])`, "giu") : null;
  }

  function setHighlight(word, on) {
    if (!hlOn) return;
    const w = word.trim().toLowerCase();
    if (on) {
      addWord(w);
      buildRegex();
      scan();
      return;
    }
    hlWords.delete(w);
    buildRegex();
    for (const span of document.querySelectorAll(`.${HL}`)) {
      if (span.textContent.toLowerCase() === w) span.replaceWith(span.textContent);
    }
  }

  function scan(root = document.body) {
    if (!hlRe || !root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(highlightText);
  }

  function highlightText(node) {
    const parent = node.parentElement;
    const text = node.nodeValue;
    if (!hlRe || !parent || !text?.trim() || parent.isContentEditable || parent.closest(SKIP)) return;
    const parts = [];
    let last = 0;
    for (const m of text.matchAll(hlRe)) {
      parts.push(text.slice(last, m.index), h("span", { className: HL, textContent: m[0] }));
      last = m.index + m[0].length;
    }
    if (!parts.length) return;
    parts.push(text.slice(last));
    node.replaceWith(...parts.filter((p) => p !== ""));
  }

  function observe() {
    let pending = [];
    let timer = null;
    new MutationObserver((mutations) => {
      for (const mu of mutations) {
        for (const node of mu.addedNodes) {
          if (node.nodeType === 3 || (node.nodeType === 1 && node.id !== CARD_ID && !node.classList.contains(HL))) {
            pending.push(node);
          }
        }
      }
      if (pending.length && !timer) {
        timer = setTimeout(() => {
          const batch = pending;
          pending = [];
          timer = null;
          for (const node of batch) {
            if (!node.isConnected) continue;
            node.nodeType === 1 ? scan(node) : highlightText(node);
          }
        }, 400);
      }
    }).observe(document.body, { childList: true, subtree: true });
  }
})();

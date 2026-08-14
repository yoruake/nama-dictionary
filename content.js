(function () {
  const CARD_ID = "mlwa-card-root";
  const CARD_WIDTH = 300;
  const QUERY_DELAY_MS = 30;

  let activeRequestId = 0;
  let activeCard = null;
  let outsideClickHandler = null;
  let currentLookup = null;
  let activePort = null;
  // 本页查过的词，再悬停时直接出结果（背景页那边也有缓存，但省掉一次消息往返）
  const lookupMemo = new Map();

  document.addEventListener("mouseup", handleMouseUp, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeCard();
    }
  });
  // 进出全屏后卡片位置必然失效，直接关掉。
  document.addEventListener("fullscreenchange", closeCard);

  function handleMouseUp(event) {
    if (activeCard?.contains(event.target)) {
      return;
    }

    window.setTimeout(() => {
      const selectionInfo = readSelection();
      if (!selectionInfo) {
        return;
      }

      const { word, sentence, rect } = selectionInfo;
      runLookup(word, sentence, rect);
    }, QUERY_DELAY_MS);
  }

  // 查词主流程。除选中文本外，字幕栏悬停查词(subtitle.js)也走这里。
  // 优先走流式：模型逐行输出，拿到一行就渲染一行，不用等六个字段全写完。
  function runLookup(word, sentence, rect) {
    if (!word) {
      return;
    }

    const requestId = ++activeRequestId;
    currentLookup = { word, sentence, id: null, starred: false };

    // 本页查过的词直接复原，连消息都不用发
    const memo = lookupMemo.get(word);
    if (memo) {
      currentLookup.id = memo.id || null;
      currentLookup.starred = Boolean(memo.starred);
      renderResult(memo, { cached: true, rect });
      return;
    }

    showLoadingCard(word, rect);

    if (!startStreamingLookup(word, sentence, rect, requestId)) {
      fallbackLookup(word, sentence, rect, requestId);
    }
  }

  function startStreamingLookup(word, sentence, rect, requestId) {
    let port = null;
    try {
      port = chrome.runtime.connect({ name: "nama-lookup" });
    } catch (error) {
      return false;
    }
    if (!port) {
      return false;
    }

    closeActivePort();
    activePort = port;
    let answered = false;

    port.onMessage.addListener((message) => {
      if (requestId !== activeRequestId || !message) {
        return;
      }

      if (message.type === "partial") {
        answered = true;
        renderResult(message.data, { rect, partial: true });
        return;
      }

      if (message.type === "done") {
        answered = true;
        currentLookup = {
          word,
          sentence,
          id: message.id || null,
          starred: Boolean(message.data && message.data.starred)
        };
        if (message.data) {
          lookupMemo.set(word, message.data);
        }
        renderResult(message.data, { cached: Boolean(message.cached), rect });
        closeActivePort();
        return;
      }

      if (message.type === "error") {
        answered = true;
        showError(message.error || { type: "unknown", message: "查询失败" }, word, rect);
        closeActivePort();
      }
    });

    port.onDisconnect.addListener(() => {
      if (activePort === port) {
        activePort = null;
      }
      // 后台没接住（比如 service worker 刚被回收）→ 退回一次性请求
      if (!answered && requestId === activeRequestId) {
        fallbackLookup(word, sentence, rect, requestId);
      }
    });

    try {
      port.postMessage({ type: "LOOKUP_STREAM", word, sentence });
    } catch (error) {
      closeActivePort();
      return false;
    }
    return true;
  }

  function closeActivePort() {
    if (activePort) {
      try {
        activePort.disconnect();
      } catch (error) {
        // 已经断了
      }
      activePort = null;
    }
  }

  function fallbackLookup(word, sentence, rect, requestId) {
    sendRuntimeMessage({
      type: "LOOKUP_WORD",
      word,
      sentence,
      useCache: true
    })
      .then((response) => {
        if (requestId !== activeRequestId) {
          return;
        }

        if (!response?.ok) {
          showError(response?.error || { type: "unknown", message: "查询失败" }, word, rect);
          return;
        }

        currentLookup = {
          word,
          sentence,
          id: response.id || response.data?.id || null,
          starred: Boolean(response.data?.starred)
        };
        if (response.data) {
          lookupMemo.set(word, response.data);
        }
        renderResult(response.data, {
          cached: Boolean(response.cached),
          rect
        });
      })
      .catch((error) => {
        if (requestId !== activeRequestId) {
          return;
        }

        showError(
          {
            type: "runtime_error",
            message: error.message || "扩展通信失败"
          },
          word,
          rect
        );
      });
  }

  function readSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return null;
    }

    const range = selection.getRangeAt(0);
    const rawText = selection.toString();
    const word = cleanSelectedText(rawText);

    if (!word) {
      closeCard();
      return null;
    }

    const rect = getRangeRect(range);
    if (!rect) {
      return null;
    }

    return {
      word,
      sentence: extractSentence(selection, range, rawText, word),
      rect
    };
  }

  function cleanSelectedText(text) {
    return text
      .replace(/\u00a0/g, " ")
      .trim()
      .replace(/\s+/g, " ")
      .replace(/^[\s"'“”‘’«»《》（）()[\]{}<>.,，、:：;؛.!?。！？؟۔]+/u, "")
      .replace(/[\s"'“”‘’«»《》（）()[\]{}<>.,，、:：;؛.!?。！？؟۔]+$/u, "");
  }

  function getRangeRect(range) {
    const directRect = range.getBoundingClientRect();
    if (directRect && (directRect.width || directRect.height)) {
      return directRect;
    }

    const rects = range.getClientRects();
    return rects.length ? rects[0] : null;
  }

  function extractSentence(selection, range, rawSelectedText, cleanWord) {
    const textNodeContext = getTextNodeContext(range.startContainer, range.startOffset);
    if (textNodeContext) {
      return findSentenceAroundIndex(
        textNodeContext.text,
        textNodeContext.offset,
        rawSelectedText,
        cleanWord
      );
    }

    const anchorText = getNodeText(selection.anchorNode);
    const anchorSentence = findSentenceByText(anchorText, rawSelectedText, cleanWord);
    if (anchorSentence) {
      return anchorSentence;
    }

    const commonText = getNodeText(range.commonAncestorContainer);
    const commonSentence = findSentenceByText(commonText, rawSelectedText, cleanWord);
    if (commonSentence) {
      return commonSentence;
    }

    return cleanSelectedText(rawSelectedText) || cleanWord;
  }

  function getTextNodeContext(node, offset) {
    if (!node || node.nodeType !== Node.TEXT_NODE || typeof node.textContent !== "string") {
      return null;
    }

    return {
      text: node.textContent,
      offset: Math.max(0, Math.min(offset, node.textContent.length))
    };
  }

  function getNodeText(node) {
    if (!node) {
      return "";
    }

    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent || "";
    }

    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node.closest?.("p, li, blockquote, td, th, figcaption, article, section, div");
      return element?.innerText || node.textContent || "";
    }

    return node.textContent || "";
  }

  function findSentenceByText(text, rawSelectedText, cleanWord) {
    if (!text) {
      return "";
    }

    const rawIndex = rawSelectedText ? text.indexOf(rawSelectedText) : -1;
    if (rawIndex >= 0) {
      return findSentenceAroundIndex(text, rawIndex, rawSelectedText, cleanWord);
    }

    const cleanIndex = cleanWord ? text.indexOf(cleanWord) : -1;
    if (cleanIndex >= 0) {
      return findSentenceAroundIndex(text, cleanIndex, rawSelectedText, cleanWord);
    }

    return "";
  }

  function findSentenceAroundIndex(text, index, rawSelectedText, cleanWord) {
    if (!text) {
      return cleanWord;
    }

    let targetIndex = index;
    if (targetIndex < 0) {
      targetIndex = rawSelectedText ? text.indexOf(rawSelectedText) : -1;
    }
    if (targetIndex < 0) {
      targetIndex = cleanWord ? text.indexOf(cleanWord) : -1;
    }
    if (targetIndex < 0) {
      return trimSentence(text);
    }

    const start = findPreviousSentenceBoundary(text, targetIndex);
    const end = findNextSentenceBoundary(text, targetIndex);
    return trimSentence(text.slice(start, end));
  }

  function findPreviousSentenceBoundary(text, index) {
    for (let i = index - 1; i >= 0; i -= 1) {
      if (isSentenceBoundary(text[i])) {
        return i + 1;
      }
    }
    return 0;
  }

  function findNextSentenceBoundary(text, index) {
    for (let i = index; i < text.length; i += 1) {
      if (isSentenceBoundary(text[i])) {
        return i + 1;
      }
    }
    return text.length;
  }

  function isSentenceBoundary(char) {
    return /[.!?。！？؟۔\n\r]/u.test(char);
  }

  function trimSentence(text) {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length <= 500) {
      return normalized;
    }

    return `${normalized.slice(0, 500)}...`;
  }

  function showLoadingCard(word, rect) {
    const card = ensureCard(rect);
    card.replaceChildren(
      createHeader(word, "", true),
      createStatus("分析中...")
    );
    positionCard(card, rect);
  }

  function renderResult(data, options = {}) {
    const card = ensureCard(options.rect);
    const partial = Boolean(options.partial);
    // 流式过程中还没写到的字段留省略号，别显示成"暂无"（那是"查不到"的意思）
    const blank = partial ? "…" : "暂无";

    if (data?.id && currentLookup) {
      currentLookup.id = data.id;
      currentLookup.starred = Boolean(data.starred);
    }

    card.replaceChildren(
      createHeader(data.word || currentLookup?.word || "", data.translit || "", true, {
        id: data.id,
        starred: Boolean(data.starred)
      }),
      createLangTag(data.lang || (partial ? "…" : "未知语言")),
      createField("💡", "词义", data.meaning || blank),
      createField("🌱", "词源", data.etymology || blank),
      createField("📍", "句中作用", data.form || blank),
      createFooter(partial)
    );

    if (options.rect) {
      positionCard(card, options.rect);
    }
  }

  function showError(error, word, rect) {
    const card = ensureCard(rect);
    const friendlyMessage = getFriendlyErrorMessage(error);

    if (error?.type === "invalid_json" && error.rawResponse) {
      console.warn("[多语言查词助手] DeepSeek返回非法JSON：", error.rawResponse);
    }

    card.replaceChildren(
      createHeader(word || "查询失败", "", true),
      createStatus(friendlyMessage, true),
      error?.type === "missing_key" ? createOpenOptionsButton() : createRetryHint()
    );

    if (rect) {
      positionCard(card, rect);
    }
  }

  // 全屏时(YouTube/Netflix)只有全屏元素的子树会被渲染，卡片必须挂到全屏元素里。
  function cardHost() {
    return document.fullscreenElement || document.documentElement;
  }

  function ensureCard(rect) {
    const host = cardHost();

    if (!activeCard) {
      activeCard = document.createElement("div");
      activeCard.id = CARD_ID;
      activeCard.className = "mlwa-card";
      activeCard.addEventListener("mousedown", (event) => event.stopPropagation());
      host.appendChild(activeCard);
      bindOutsideClick();
    } else if (activeCard.parentNode !== host) {
      host.appendChild(activeCard);
    }

    if (rect) {
      positionCard(activeCard, rect);
    }

    return activeCard;
  }

  function positionCard(card, rect) {
    const margin = 12;
    // 挂在全屏元素里时页面滚动无意义，改用 fixed + 视口坐标。
    const isFixed = card.parentNode !== document.documentElement;
    card.style.position = isFixed ? "fixed" : "absolute";
    const scrollX = isFixed ? 0 : (window.scrollX || window.pageXOffset || 0);
    const scrollY = isFixed ? 0 : (window.scrollY || window.pageYOffset || 0);
    const maxLeft = scrollX + window.innerWidth - CARD_WIDTH - margin;
    const left = Math.max(scrollX + margin, Math.min(scrollX + rect.left, maxLeft));
    const belowTop = scrollY + rect.bottom + 8;
    const aboveTop = scrollY + rect.top - card.offsetHeight - 8;
    const estimatedHeight = card.offsetHeight || 190;
    const wouldOverflowBottom = belowTop + estimatedHeight > scrollY + window.innerHeight - margin;
    const top = wouldOverflowBottom && aboveTop > scrollY + margin
      ? aboveTop
      : belowTop;

    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(Math.max(scrollY + margin, top))}px`;
  }

  function createHeader(word, translit, withClose, starState = null) {
    const header = document.createElement("div");
    header.className = "mlwa-header";

    const title = document.createElement("div");
    title.className = "mlwa-title";

    const wordNode = document.createElement("span");
    wordNode.className = "mlwa-word";
    wordNode.textContent = word;
    title.appendChild(wordNode);

    if (translit) {
      const translitNode = document.createElement("span");
      translitNode.className = "mlwa-translit";
      translitNode.textContent = translit;
      title.appendChild(translitNode);
    }

    header.appendChild(title);

    const actions = document.createElement("div");
    actions.className = "mlwa-header-actions";

    if (starState?.id) {
      actions.appendChild(createStarButton(starState.starred));
    }

    if (withClose) {
      const closeButton = document.createElement("button");
      closeButton.type = "button";
      closeButton.className = "mlwa-close";
      closeButton.textContent = "×";
      closeButton.title = "关闭";
      closeButton.addEventListener("click", closeCard);
      actions.appendChild(closeButton);
    }

    header.appendChild(actions);
    return header;
  }

  function createStarButton(starred) {
    const starButton = document.createElement("button");
    starButton.type = "button";
    starButton.className = starred ? "mlwa-star is-starred" : "mlwa-star";
    starButton.textContent = starred ? "⭐" : "☆";
    starButton.title = starred ? "从生词本移除" : "加入生词本";
    starButton.setAttribute("aria-label", starButton.title);
    starButton.addEventListener("click", handleStarClick);
    return starButton;
  }

  function createLangTag(lang) {
    const row = document.createElement("div");
    row.className = "mlwa-tag-row";

    const tag = document.createElement("span");
    tag.className = "mlwa-lang-tag";
    tag.textContent = lang;
    row.appendChild(tag);

    return row;
  }

  function createField(icon, label, value) {
    const row = document.createElement("div");
    row.className = "mlwa-field";

    const iconNode = document.createElement("span");
    iconNode.className = "mlwa-field-icon";
    iconNode.textContent = icon;
    row.appendChild(iconNode);

    const content = document.createElement("div");
    content.className = "mlwa-field-content";

    const labelNode = document.createElement("span");
    labelNode.className = "mlwa-field-label";
    labelNode.textContent = label;
    content.appendChild(labelNode);

    const valueNode = document.createElement("span");
    valueNode.className = "mlwa-field-value";
    valueNode.textContent = value;
    content.appendChild(valueNode);

    row.appendChild(content);
    return row;
  }

  function createStatus(message, isError = false) {
    const status = document.createElement("div");
    status.className = isError ? "mlwa-status mlwa-status-error" : "mlwa-status";
    status.textContent = message;
    return status;
  }

  function createFooter(partial = false) {
    const footer = document.createElement("div");
    footer.className = "mlwa-footer";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "mlwa-secondary-button";
    button.textContent = partial ? "生成中…" : "重新分析";
    button.disabled = partial;
    if (!partial) {
      button.addEventListener("click", handleReanalyzeClick);
    }
    footer.appendChild(button);

    return footer;
  }

  function createOpenOptionsButton() {
    const footer = document.createElement("div");
    footer.className = "mlwa-footer";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "mlwa-primary-button";
    button.textContent = "打开设置页";
    button.addEventListener("click", () => {
      sendRuntimeMessage({ type: "OPEN_OPTIONS" });
    });
    footer.appendChild(button);

    return footer;
  }

  function createRetryHint() {
    const hint = document.createElement("div");
    hint.className = "mlwa-hint";
    hint.textContent = "可以稍后重新选中单词再试。";
    return hint;
  }

  function handleReanalyzeClick(event) {
    const button = event.currentTarget;
    if (!currentLookup?.word) {
      return;
    }

    button.disabled = true;
    button.textContent = "分析中...";

    sendRuntimeMessage({
      type: "REANALYZE_FORM",
      word: currentLookup.word,
      sentence: currentLookup.sentence,
      id: currentLookup.id
    })
      .then((response) => {
        if (!response?.ok) {
          showError(response?.error || { type: "unknown", message: "查询失败" }, currentLookup.word);
          return;
        }

        currentLookup.id = response.id || response.data?.id || currentLookup.id;
        currentLookup.starred = Boolean(response.data?.starred);
        renderResult(response.data, {
          cached: true
        });
      })
      .catch((error) => {
        showError(
          {
            type: "runtime_error",
            message: error.message || "扩展通信失败"
          },
          currentLookup.word
        );
      });
  }

  function handleStarClick(event) {
    event.stopPropagation();

    const button = event.currentTarget;
    if (!currentLookup?.id) {
      return;
    }

    button.disabled = true;

    sendRuntimeMessage({
      type: "TOGGLE_STAR",
      id: currentLookup.id
    })
      .then((response) => {
        if (!response?.ok) {
          button.disabled = false;
          showError(response?.error || { type: "unknown", message: "星标更新失败" }, currentLookup.word);
          return;
        }

        currentLookup.starred = Boolean(response.data?.starred);
        if (response.data && currentLookup.word) {
          lookupMemo.set(currentLookup.word, response.data);
        }
        updateStarButton(button, currentLookup.starred);

        // 收藏/取消后就地更新页内高亮，无需刷新页面
        if (currentLookup.starred) {
          addHighlightWord(currentLookup.word);
        } else {
          removeHighlightWord(currentLookup.word);
        }
      })
      .catch((error) => {
        button.disabled = false;
        showError(
          {
            type: "runtime_error",
            message: error.message || "星标更新失败"
          },
          currentLookup.word
        );
      });
  }

  function updateStarButton(button, starred) {
    button.disabled = false;
    button.classList.toggle("is-starred", starred);
    button.textContent = starred ? "⭐" : "☆";
    button.title = starred ? "从生词本移除" : "加入生词本";
    button.setAttribute("aria-label", button.title);
  }

  function bindOutsideClick() {
    removeOutsideClick();
    outsideClickHandler = (event) => {
      if (activeCard && !activeCard.contains(event.target)) {
        closeCard();
      }
    };
    document.addEventListener("mousedown", outsideClickHandler, true);
  }

  function removeOutsideClick() {
    if (outsideClickHandler) {
      document.removeEventListener("mousedown", outsideClickHandler, true);
      outsideClickHandler = null;
    }
  }

  function closeCard() {
    activeRequestId += 1;
    closeActivePort();   // 卡片关了就别再让模型往下生成
    currentLookup = null;
    if (activeCard) {
      activeCard.remove();
      activeCard = null;
    }
    removeOutsideClick();
  }

  function getFriendlyErrorMessage(error) {
    switch (error?.type) {
      case "missing_key":
        return "请先在扩展设置中配置DeepSeek API Key";
      case "invalid_key":
        return "API Key无效";
      case "insufficient_balance":
        return "DeepSeek账户余额不足";
      case "network":
        return "网络错误，请重试";
      case "timeout":
        return "请求超时，请重试";
      case "invalid_json":
        return "解析失败";
      default:
        return error?.message || "查询失败";
    }
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

  // ===== 生词页内高亮 =====
  const HL_CLASS = "mlwa-hl";
  const HL_SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT",
    "CODE", "PRE", "KBD", "SAMP", "OPTION"
  ]);

  let hlRegex = null;
  let hlObserver = null;
  let hlSettingOn = false;
  const hlForms = new Set(); // 已跟踪的生词（小写）

  async function initHighlight() {
    hlSettingOn = await getHighlightEnabled();
    if (!hlSettingOn) {
      return;
    }
    const resp = await sendRuntimeMessage({ type: "GET_ENTRIES" }).catch(() => null);
    const entries = resp?.ok && Array.isArray(resp.entries)
      ? resp.entries.filter((e) => e && e.starred && e.word)
      : [];
    for (const entry of entries) {
      const form = String(entry.word || "").trim();
      if (form.length >= 2) {
        hlForms.add(form.toLowerCase());
      }
    }
    rebuildRegex();
    // 无论当前有没有词都启动观察器，方便之后新增的词也能覆盖到后续加载的内容
    observeMutations();
    if (hlRegex && document.body) {
      highlightRoot(document.body);
    }
    scheduleRescans();
  }

  // 兜底：页面 load 完成及稍后再整页重扫几次，覆盖初次扫描后才插入的内容
  // （观察器偶有遗漏的情况）。highlightRoot 幂等，已高亮的会跳过。
  function scheduleRescans() {
    const rescan = () => {
      if (hlSettingOn && hlRegex && document.body) {
        highlightRoot(document.body);
      }
    };
    if (document.readyState !== "complete") {
      window.addEventListener("load", rescan, { once: true });
    }
    setTimeout(rescan, 1500);
    setTimeout(rescan, 4000);
  }

  function getHighlightEnabled() {
    return new Promise((resolve) => {
      chrome.storage.local.get(["highlightEnabled"], (r) => {
        const v = r && r.highlightEnabled;
        resolve(v === undefined ? true : Boolean(v));
      });
    });
  }

  function rebuildRegex() {
    const forms = Array.from(hlForms).filter((f) => f.length >= 2);
    if (!forms.length) {
      hlRegex = null;
      return;
    }
    forms.sort((a, b) => b.length - a.length); // 长词优先
    const alt = forms.map(escapeRegex).join("|");
    try {
      hlRegex = new RegExp("(?<![\\p{L}\\p{M}])(" + alt + ")(?![\\p{L}\\p{M}])", "giu");
    } catch (e) {
      try {
        hlRegex = new RegExp("(" + alt + ")", "giu");
      } catch (e2) {
        hlRegex = null;
      }
    }
  }

  // 收藏后：把该词的下划线就地加上，不刷新页面。
  function addHighlightWord(word) {
    if (!hlSettingOn) {
      return;
    }
    const form = String(word || "").trim();
    if (form.length < 2) {
      return;
    }
    const key = form.toLowerCase();
    if (!hlForms.has(key)) {
      hlForms.add(key);
      rebuildRegex();
    }
    if (!hlRegex || !document.body) {
      return;
    }
    observeMutations();
    highlightRoot(document.body); // 幂等：新词会被包裹，已高亮的会跳过
  }

  // 取消收藏后：就地去掉该词的下划线。
  function removeHighlightWord(word) {
    const key = String(word || "").trim().toLowerCase();
    if (!hlForms.has(key)) {
      return;
    }
    hlForms.delete(key);
    rebuildRegex();
    const spans = document.querySelectorAll("." + HL_CLASS);
    for (const span of spans) {
      if ((span.textContent || "").toLowerCase() === key) {
        span.replaceWith(document.createTextNode(span.textContent));
      }
    }
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function isSkippableParent(node) {
    const parent = node.parentNode;
    if (!parent || parent.nodeType !== 1) {
      return true;
    }
    if (HL_SKIP_TAGS.has(parent.tagName) || parent.isContentEditable) {
      return true;
    }
    if (parent.closest && parent.closest("." + HL_CLASS + ", #" + CARD_ID + ", #mlwa-hl-tip")) {
      return true;
    }
    return false;
  }

  function highlightRoot(root) {
    if (!root || !hlRegex) {
      return;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) {
          return NodeFilter.FILTER_REJECT;
        }
        return isSkippableParent(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });
    const targets = [];
    let n;
    while ((n = walker.nextNode())) {
      targets.push(n);
    }
    for (const node of targets) {
      highlightTextNode(node);
    }
  }

  function highlightTextNode(node) {
    if (!hlRegex || !node.nodeValue || isSkippableParent(node)) {
      return;
    }
    const text = node.nodeValue;
    hlRegex.lastIndex = 0;
    if (!hlRegex.test(text)) {
      return;
    }

    hlRegex.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    let m;
    while ((m = hlRegex.exec(text)) !== null) {
      const matched = m[0];
      if (!matched) {
        hlRegex.lastIndex += 1;
        continue;
      }
      const start = m.index;
      if (start > last) {
        frag.appendChild(document.createTextNode(text.slice(last, start)));
      }
      const span = document.createElement("span");
      span.className = HL_CLASS;
      span.textContent = matched;
      frag.appendChild(span);
      last = start + matched.length;
    }
    if (last < text.length) {
      frag.appendChild(document.createTextNode(text.slice(last)));
    }
    node.parentNode.replaceChild(frag, node);
  }

  function observeMutations() {
    if (hlObserver || !document.body) {
      return;
    }
    let pending = [];
    let timer = null;
    hlObserver = new MutationObserver((mutations) => {
      for (const mu of mutations) {
        for (const node of mu.addedNodes) {
          if (node.nodeType === 1) {
            if (node.id === CARD_ID || node.id === "mlwa-hl-tip") {
              continue;
            }
            if (node.classList && node.classList.contains(HL_CLASS)) {
              continue;
            }
            pending.push(node);
          } else if (node.nodeType === 3) {
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
            if (!node.isConnected) {
              continue;
            }
            if (node.nodeType === 1) {
              highlightRoot(node);
            } else if (node.nodeType === 3) {
              highlightTextNode(node);
            }
          }
        }, 400);
      }
    });
    hlObserver.observe(document.body, { childList: true, subtree: true });
  }

  initHighlight().catch((e) => console.debug("[多语言查词助手] 高亮初始化失败", e));

  // 供同一扩展的其它内容脚本(subtitle.js)复用查词卡片。
  // 内容脚本共享同一个隔离世界的 window，所以直接挂在 window 上即可。
  window.__namaDict = {
    lookup: runLookup,
    close: closeCard
  };
})();

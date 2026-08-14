const API_ENDPOINT = "https://api.deepseek.com/v1/chat/completions";
const MODEL = "deepseek-v4-flash";
const API_TIMEOUT_MS = 60000;
const API_KEY_STORAGE_KEY = "deepseekApiKey";
const ENTRIES_STORAGE_KEY = "entries";
const LEGACY_CACHE_STORAGE_KEY = "lookupCache";

const SYSTEM_PROMPT = `你是多语言查词助手。给你一个词(或词组/句子)及其上下文，按下面纯文本格式逐行输出：每字段独占一行、以英文标签开头、尽量短，不用markdown、不加多余说明。

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
用IPA的语言，不标短元音的文字按标准音补全(波斯语德黑兰音 æ/e/o、ɒː/iː/uː)并标重音ˈ。`;

const storageReady = initializeEntriesStorage().catch((error) => {
  console.error("[多语言查词助手] 存储初始化失败", error);
});

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch((error) => {
      console.error("[多语言查词助手] 未处理错误", error);
      sendResponse({
        ok: false,
        error: serializeError(error)
      });
    });

  return true;
});

// 流式查词：边生成边把已有字段推给卡片，不用等六个字段全部写完。
// 之所以走 Port 而不是 sendMessage，是因为一次请求要回传很多次。
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "nama-lookup") {
    return;
  }
  port.onMessage.addListener((message) => {
    if (message && message.type === "LOOKUP_STREAM") {
      streamLookup(port, message).catch((error) => {
        safePost(port, { type: "error", error: serializeError(error) });
      });
    }
  });
});

function safePost(port, payload) {
  try {
    port.postMessage(payload);
    return true;
  } catch (error) {
    return false;   // 卡片已经关了，端口断开
  }
}

async function streamLookup(port, message) {
  const word = normalizeInput(message.word);
  const context = normalizeContext(message.sentence || word);

  if (!word) {
    safePost(port, { type: "error", error: { type: "bad_request", message: "未检测到可查询的单词" } });
    return;
  }

  const entries = await getEntries();
  const cached = findCachedEntry(entries, word, context) || findEntryByWord(entries, word);
  if (cached) {
    safePost(port, { type: "done", cached: true, id: cached.id, data: cached });
    return;
  }

  const apiKey = await getApiKey();
  if (!apiKey) {
    safePost(port, {
      type: "error",
      error: { type: "missing_key", message: "请先在扩展设置中配置DeepSeek API Key" }
    });
    return;
  }

  let lastPostAt = 0;
  const full = await streamDeepSeek(apiKey, word, context, (text) => {
    const now = Date.now();
    if (now - lastPostAt < 80) {
      return;   // 限流，别把消息通道打满
    }
    lastPostAt = now;
    safePost(port, { type: "partial", data: parseAnalysis(text, word) });
  });

  const entry = createEntry(parseAnalysis(full, word), word, context);
  const fresh = await getEntries();
  fresh.push(entry);
  await saveEntries(fresh);

  safePost(port, { type: "done", cached: false, id: entry.id, data: entry });
}

async function handleMessage(message) {
  if (!message || typeof message.type !== "string") {
    return createFailure("bad_request", "请求格式不正确");
  }

  switch (message.type) {
    case "LOOKUP_WORD":
      return lookupWord(message);
    case "REANALYZE_FORM":
      return reanalyzeForm(message);
    case "TOGGLE_STAR":
      return toggleStar(message);
    case "UNSTAR_MANY":
      return unstarMany(message);
    case "MARK_EXPORTED":
      return markExported(message);
    case "GET_ENTRIES":
      return getEntriesForPage();
    case "TEST_API_KEY":
      return testApiKey(message);
    case "GET_CACHE_STATS":
      return getCacheStats();
    case "CLEAR_CACHE":
      return clearCache();
    case "FETCH_SUBTITLE":
      return fetchSubtitle(message);
    case "WARM_API":
      return warmApi();
    case "OPEN_OPTIONS":
      await chrome.runtime.openOptionsPage();
      return { ok: true };
    default:
      return createFailure("bad_request", "未知请求类型");
  }
}

// 取字幕文件。放在这里跑是为了绕开 CORS（Netflix 的字幕在 nflxvideo.net 上）。
// URL 来自页面主世界的 bridge，属于不可信输入，所以只放行这几个字幕域名。
const SUBTITLE_HOSTS = [
  /^www\.youtube\.com$/,
  /^[a-z0-9-]+\.googlevideo\.com$/,
  /^[a-z0-9.-]+\.nflxvideo\.net$/,
  /^[a-z0-9.-]+\.netflix\.com$/
];

async function fetchSubtitle(message) {
  let url;
  try {
    url = new URL(String(message.url || ""));
  } catch (error) {
    return createFailure("bad_request", "字幕地址不合法");
  }

  if (url.protocol !== "https:" || !SUBTITLE_HOSTS.some((re) => re.test(url.hostname))) {
    return createFailure("bad_request", `不允许的字幕来源：${url.hostname}`);
  }

  try {
    const response = await fetch(url.toString(), { credentials: "omit" });
    if (!response.ok) {
      return createFailure("network", `字幕请求失败：HTTP ${response.status}`);
    }
    const text = await response.text();
    if (!text) {
      return createFailure("network", "字幕内容为空");
    }
    return { ok: true, text };
  } catch (error) {
    return createFailure("network", error.message || "字幕请求失败");
  }
}

async function lookupWord(message) {
  const word = normalizeInput(message.word);
  const context = normalizeContext(message.sentence || word);

  if (!word) {
    return createFailure("bad_request", "未检测到可查询的单词");
  }

  const entries = await getEntries();
  const cached = findCachedEntry(entries, word, context);

  if (cached && message.useCache !== false) {
    return {
      ok: true,
      cached: true,
      id: cached.id,
      data: cached
    };
  }

  // 回退：同一个词（不论上下文）已在本地/生词本中 → 复用它，避免重复调用 API、
  // 避免建重复条目，也让已收藏的词被再次选中后能直接取消收藏。
  if (message.useCache !== false) {
    const byWord = findEntryByWord(entries, word);
    if (byWord) {
      return {
        ok: true,
        cached: true,
        id: byWord.id,
        data: byWord
      };
    }
  }

  const apiKey = await getApiKey();
  if (!apiKey) {
    return createFailure("missing_key", "请先在扩展设置中配置DeepSeek API Key");
  }

  const data = await queryDeepSeek(apiKey, word, context);
  const entry = createEntry(data, word, context);
  entries.push(entry);
  await saveEntries(entries);

  return {
    ok: true,
    cached: false,
    id: entry.id,
    data: entry
  };
}

async function reanalyzeForm(message) {
  const word = normalizeInput(message.word);
  const context = normalizeContext(message.sentence || word);

  if (!word) {
    return createFailure("bad_request", "未检测到可查询的单词");
  }

  const apiKey = await getApiKey();
  if (!apiKey) {
    return createFailure("missing_key", "请先在扩展设置中配置DeepSeek API Key");
  }

  const entries = await getEntries();
  const entryIndex = findEntryIndex(entries, message.id, word, context);
  const cached = entryIndex >= 0 ? entries[entryIndex] : null;

  const fresh = await queryDeepSeek(apiKey, word, context);
  const merged = {
    id: cached?.id || generateId(),
    // 保留原文词形，避免重新分析后与页面文字对不上导致高亮失效
    word: cached?.word || word || fresh.word,
    translit: fresh.translit || cached?.translit || "",
    etymology: fresh.etymology || cached?.etymology || "",
    meaning: fresh.meaning || cached?.meaning || "",
    form: fresh.form || cached?.form || "",
    lang: fresh.lang || cached?.lang || "未知语言",
    context,
    timestamp: Date.now(),
    starred: Boolean(cached?.starred),
    exportedAt: normalizeExportedAt(cached?.exportedAt)
  };

  if (entryIndex >= 0) {
    entries[entryIndex] = merged;
  } else {
    entries.push(merged);
  }
  await saveEntries(entries);

  return {
    ok: true,
    cached: false,
    id: merged.id,
    data: merged
  };
}

async function toggleStar(message) {
  const entries = await getEntries();
  const id = normalizeInput(message.id);
  const index = entries.findIndex((entry) => entry.id === id);

  if (index < 0) {
    return createFailure("not_found", "未找到这条查询记录");
  }

  const nextStarred = typeof message.starred === "boolean"
    ? message.starred
    : !entries[index].starred;

  entries[index] = {
    ...entries[index],
    starred: nextStarred
  };
  await saveEntries(entries);

  return {
    ok: true,
    data: entries[index]
  };
}

async function getEntriesForPage() {
  const entries = await getEntries();
  return {
    ok: true,
    entries
  };
}

async function markExported(message) {
  const ids = Array.isArray(message.ids)
    ? message.ids.map(normalizeInput).filter(Boolean)
    : [];
  if (!ids.length) {
    return { ok: true, count: 0 };
  }

  const idSet = new Set(ids);
  const entries = await getEntries();
  const now = Date.now();
  let count = 0;

  for (const entry of entries) {
    if (idSet.has(entry.id)) {
      entry.exportedAt = now;
      count += 1;
    }
  }

  await saveEntries(entries);
  return { ok: true, count };
}

async function unstarMany(message) {
  const ids = Array.isArray(message.ids)
    ? message.ids.map(normalizeInput).filter(Boolean)
    : [];
  if (!ids.length) {
    return { ok: true, count: 0 };
  }

  const idSet = new Set(ids);
  const entries = await getEntries();
  let count = 0;

  for (const entry of entries) {
    if (idSet.has(entry.id) && entry.starred) {
      entry.starred = false;
      count += 1;
    }
  }

  await saveEntries(entries);
  return { ok: true, count };
}

async function testApiKey(message) {
  const apiKey = normalizeInput(message.apiKey);
  const word = normalizeInput(message.word) || "سلام";
  const sentence = normalizeInput(message.sentence) || `测试词：${word}`;

  if (!apiKey) {
    return createFailure("missing_key", "请先输入DeepSeek API Key");
  }

  const data = await queryDeepSeek(apiKey, word, sentence);
  return {
    ok: true,
    data
  };
}

async function getCacheStats() {
  const entries = await getEntries();
  return {
    ok: true,
    count: entries.length,
    starredCount: entries.filter((entry) => entry.starred).length
  };
}

async function clearCache() {
  const entries = await getEntries();
  const preservedEntries = entries.filter((entry) => entry.starred);
  await saveEntries(preservedEntries);
  await removeStorage([LEGACY_CACHE_STORAGE_KEY]);
  return {
    ok: true,
    count: preservedEntries.length,
    starredCount: preservedEntries.length
  };
}

// 预热：鼠标一进字幕就调一次，把 service worker 叫醒 + 把到 DeepSeek 的 TLS 连接建好。
// 真正查词时就省掉了冷启动和握手的时间。请求本身失败无所谓，连接建上就行。
async function warmApi() {
  try {
    await fetch(API_ENDPOINT, { method: "HEAD" });
  } catch (error) {
    // 预热失败不影响任何功能
  }
  return { ok: true };
}

async function streamDeepSeek(apiKey, word, sentence, onText) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const response = await fetch(API_ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        thinking: { type: "disabled" },
        max_tokens: 300,
        stream: true,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `单词：${word}\n句子：${sentence}` }
        ]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw buildApiError(response.status, parseApiResponseBody(errorText), errorText);
    }
    if (!response.body) {
      const error = new Error("网络错误，请重试");
      error.type = "network";
      throw error;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) {
          continue;
        }
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") {
          continue;
        }
        try {
          const chunk = JSON.parse(payload);
          const delta = chunk?.choices?.[0]?.delta?.content;
          if (delta) {
            full += delta;
            onText(full);
          }
        } catch (error) {
          // SSE 被切在半截 JSON 上，等下一片
        }
      }
    }

    if (!full.trim()) {
      const error = new Error("解析失败");
      error.type = "invalid_json";
      throw error;
    }

    return full;
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error("请求超时，请重试");
      timeoutError.type = "timeout";
      throw timeoutError;
    }
    if (error.type) {
      throw error;
    }
    const networkError = new Error("网络错误，请重试");
    networkError.type = "network";
    throw networkError;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function queryDeepSeek(apiKey, word, sentence) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const response = await fetch(API_ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        // 关闭思考模式（v4 默认开启，会显著变慢甚至超时）
        thinking: { type: "disabled" },
        // 字段本就短，限个上限防跑长、稳住速度
        max_tokens: 300,
        messages: [
          {
            role: "system",
            content: SYSTEM_PROMPT
          },
          {
            role: "user",
            content: `单词：${word}\n句子：${sentence}`
          }
        ]
      })
    });

    const responseText = await response.text();
    const payload = parseApiResponseBody(responseText);

    if (!response.ok) {
      throw buildApiError(response.status, payload, responseText);
    }

    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      const error = new Error("解析失败");
      error.type = "invalid_json";
      error.rawResponse = responseText;
      throw error;
    }

    return parseAnalysis(content, word);
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error("请求超时，请重试");
      timeoutError.type = "timeout";
      throw timeoutError;
    }

    if (error.type) {
      throw error;
    }

    const networkError = new Error("网络错误，请重试");
    networkError.type = "network";
    networkError.originalMessage = error.message;
    throw networkError;
  } finally {
    clearTimeout(timeoutId);
  }
}

// 解析逐行标签格式（WORD/PRON/LANG/MEANING/ETYMOLOGY/FORM）；兼容旧 JSON 输出。
function parseAnalysis(text, fallbackWord) {
  const field = (key) => {
    const match = text.match(new RegExp("^[\\s>*\\-]*" + key + "\\s*[:：]\\s*(.+)$", "im"));
    return match ? toShortString(match[1]) : "";
  };

  let word = field("WORD");
  let translit = field("PRON") || field("IPA");
  let lang = field("LANG");
  let meaning = field("MEANING");
  let etymology = field("ETYMOLOGY");
  let form = field("FORM");

  if (!word && !meaning && text.indexOf("{") !== -1) {
    try {
      const obj = extractJson(text);
      word = toShortString(obj.word) || word;
      translit = toShortString(obj.translit) || translit;
      lang = toShortString(obj.lang) || lang;
      meaning = toShortString(obj.meaning) || meaning;
      etymology = toShortString(obj.etymology) || etymology;
      form = toShortString(obj.form || obj.role) || form;
    } catch {
      // 忽略半截 JSON
    }
  }

  return {
    word: word || fallbackWord,
    lang,
    translit,
    meaning,
    etymology,
    form
  };
}

function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return {};
  }
  return JSON.parse(text.slice(start, end + 1));
}

function parseApiResponseBody(responseText) {
  try {
    return JSON.parse(responseText);
  } catch {
    return null;
  }
}

function parseModelJson(content) {
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");

    if (start !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        // 继续抛出统一的解析失败错误，便于 content script 展示。
      }
    }

    const error = new Error("解析失败");
    error.type = "invalid_json";
    error.rawResponse = content;
    throw error;
  }
}

function normalizeAnalysis(data, fallbackWord) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    const error = new Error("解析失败");
    error.type = "invalid_json";
    error.rawResponse = JSON.stringify(data);
    throw error;
  }

  return {
    word: toShortString(data.word) || fallbackWord,
    lang: toShortString(data.lang) || "未知语言",
    translit: toShortString(data.translit),
    etymology: toShortString(data.etymology),
    meaning: toShortString(data.meaning),
    form: toShortString(data.form || data.role)
  };
}

function buildApiError(status, payload, responseText) {
  const apiMessage = payload?.error?.message || responseText || "API调用失败";
  const error = new Error(apiMessage);
  error.status = status;

  if (status === 401) {
    error.type = "invalid_key";
    error.message = "API Key无效";
    return error;
  }

  if (
    status === 402 ||
    /insufficient|balance|quota|余额|账户余额|欠费/i.test(apiMessage)
  ) {
    error.type = "insufficient_balance";
    error.message = "DeepSeek账户余额不足";
    return error;
  }

  error.type = "api_error";
  return error;
}

async function getApiKey() {
  const result = await getStorage([API_KEY_STORAGE_KEY]);
  return normalizeInput(result[API_KEY_STORAGE_KEY]);
}

async function initializeEntriesStorage() {
  const result = await getStorage([ENTRIES_STORAGE_KEY, LEGACY_CACHE_STORAGE_KEY]);
  const now = Date.now();
  const normalized = normalizeEntriesArray(result[ENTRIES_STORAGE_KEY], now);
  const legacyEntries = convertLegacyCache(result[LEGACY_CACHE_STORAGE_KEY], now);
  const mergedEntries = normalized.entries.concat(legacyEntries);
  const cleanedEntries = removeExpiredEntries(mergedEntries);

  if (
    normalized.changed ||
    legacyEntries.length > 0 ||
    cleanedEntries.length !== mergedEntries.length ||
    !Array.isArray(result[ENTRIES_STORAGE_KEY])
  ) {
    await setStorage({ [ENTRIES_STORAGE_KEY]: cleanedEntries });
  }

  if (result[LEGACY_CACHE_STORAGE_KEY]) {
    await removeStorage([LEGACY_CACHE_STORAGE_KEY]);
  }
}

async function getEntries() {
  await storageReady;

  const result = await getStorage([ENTRIES_STORAGE_KEY]);
  const normalized = normalizeEntriesArray(result[ENTRIES_STORAGE_KEY], Date.now());

  if (normalized.changed || !Array.isArray(result[ENTRIES_STORAGE_KEY])) {
    await saveEntries(normalized.entries);
  }

  return normalized.entries;
}

async function saveEntries(entries) {
  await setStorage({ [ENTRIES_STORAGE_KEY]: entries });
}

function createEntry(data, fallbackWord, context) {
  const timestamp = Date.now();

  return {
    id: generateId(),
    // 用用户选中的原文词形（而非模型返回的“原词”），保证与页面文字一致，
    // 页内高亮才能稳定匹配到。
    word: fallbackWord || toShortString(data.word),
    translit: toShortString(data.translit),
    etymology: toShortString(data.etymology),
    meaning: toShortString(data.meaning),
    form: toShortString(data.form || data.role),
    lang: toShortString(data.lang) || "未知语言",
    context,
    timestamp,
    starred: false,
    exportedAt: 0
  };
}

function normalizeEntriesArray(value, now) {
  if (!Array.isArray(value)) {
    return {
      entries: [],
      changed: value !== undefined
    };
  }

  let changed = false;
  const entries = [];

  for (const item of value) {
    const entry = normalizeEntry(item, now);
    if (!entry) {
      changed = true;
      continue;
    }

    entries.push(entry);
    if (!isEntryEquivalent(item, entry)) {
      changed = true;
    }
  }

  return {
    entries,
    changed
  };
}

function isEntryEquivalent(original, normalized) {
  return original.id === normalized.id &&
    original.word === normalized.word &&
    (original.translit || "") === normalized.translit &&
    (original.etymology || "") === normalized.etymology &&
    (original.meaning || "") === normalized.meaning &&
    (original.form || original.role || "") === normalized.form &&
    (original.lang || "未知语言") === normalized.lang &&
    normalizeContext(original.context || original.sentence || "") === normalized.context &&
    Number(original.timestamp ?? original.updatedAt) === normalized.timestamp &&
    Boolean(original.starred) === normalized.starred &&
    normalizeExportedAt(original.exportedAt) === normalized.exportedAt;
}

function normalizeEntry(item, now) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return null;
  }

  const word = toShortString(item.word);
  if (!word) {
    return null;
  }

  return {
    id: toShortString(item.id) || generateId(),
    word,
    translit: toShortString(item.translit),
    etymology: toShortString(item.etymology),
    meaning: toShortString(item.meaning),
    form: toShortString(item.form || item.role),
    lang: toShortString(item.lang) || "未知语言",
    context: normalizeContext(item.context || item.sentence || ""),
    timestamp: normalizeTimestamp(item.timestamp ?? item.updatedAt, now),
    starred: Boolean(item.starred),
    exportedAt: normalizeExportedAt(item.exportedAt)
  };
}

function normalizeExportedAt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function convertLegacyCache(cache, now) {
  if (!cache || typeof cache !== "object" || Array.isArray(cache)) {
    return [];
  }

  return Object.values(cache)
    .map((item) => normalizeEntry({
      ...item,
      id: item?.id || generateId(),
      context: item?.context || "",
      timestamp: now,
      starred: Boolean(item?.starred)
    }, now))
    .filter(Boolean);
}

function removeExpiredEntries(entries) {
  const cutoff = getSixMonthsAgoTimestamp();
  return entries.filter((entry) => entry.starred || entry.timestamp >= cutoff);
}

function getSixMonthsAgoTimestamp() {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 6);
  return cutoff.getTime();
}

function findEntryIndex(entries, id, word, context) {
  const normalizedId = normalizeInput(id);
  if (normalizedId) {
    const idIndex = entries.findIndex((entry) => entry.id === normalizedId);
    if (idIndex >= 0) {
      return idIndex;
    }
  }

  return entries.findIndex((entry) => isSameLookup(entry, word, context));
}

function findCachedEntry(entries, word, context) {
  return entries.find((entry) => isSameLookup(entry, word, context)) || null;
}

function findEntryByWord(entries, word) {
  const target = normalizeCacheWord(word);
  const matches = entries.filter((entry) => normalizeCacheWord(entry.word) === target);
  if (!matches.length) {
    return null;
  }

  // 优先返回已收藏的；同类里取最近的一条。
  const starred = matches.filter((entry) => entry.starred);
  const pool = starred.length ? starred : matches;
  return pool.reduce((best, entry) => (entry.timestamp > best.timestamp ? entry : best));
}

function isSameLookup(entry, word, context) {
  const target = normalizeCacheWord(word);
  const targetContext = normalizeContext(context);

  return normalizeCacheWord(entry.word) === target && normalizeContext(entry.context) === targetContext;
}

function getStorage(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(error);
        return;
      }
      resolve(result);
    });
  });
}

function setStorage(items) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function removeStorage(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(keys, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function createFailure(type, message, extra = {}) {
  return {
    ok: false,
    error: {
      type,
      message,
      ...extra
    }
  };
}

function serializeError(error) {
  return {
    type: error.type || "unknown",
    message: error.message || "未知错误",
    status: error.status,
    rawResponse: error.rawResponse,
    originalMessage: error.originalMessage
  };
}

function normalizeInput(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function normalizeContext(value) {
  return normalizeInput(value);
}

function normalizeCacheWord(value) {
  return normalizeInput(value).toLocaleLowerCase();
}

function normalizeTimestamp(value, fallback) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : fallback;
}

function toShortString(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value).trim().replace(/\s+/g, " ");
}

function generateId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

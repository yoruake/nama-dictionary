importScripts("langs.js");

const API = "https://api.deepseek.com/chat/completions";
// DeepSeek-V4.1-Flash（2026-09-10 起）。旧名 deepseek-v4-flash 对应的模型已退役，只是临时转发过来。
const MODEL = "deepseek-flash";
const CACHE_DAYS = 183;   // 未收藏的查词缓存保留半年

const SYSTEM_PROMPT = `你是多语言查词助手。输入是要查的词（或词组、句子）、它所在的句子，有时还给出「正文语言」。按下面格式逐行输出纯文本：每个字段一行、英文标签开头、尽量简短，不用 markdown，不加任何说明。

LANG: 该词在这段正文里所属的语言，只写中文语言名（如 波斯语）；借词来源写进 ETYMOLOGY
PRON: 读音，规则见下
MEANING: 本句中的词义（中文，1-2 个义项）
ETYMOLOGY: 词源，一句话
FORM: 形态与句法作用；变形词先给原形和形态，再说在句中作什么成分

一、定正文语言
- 给了「正文语言」就一律按它分析读音、词义、形态，不要改判成相近语言。
- 没给就据上下文判断。同文字的近亲语言靠拼写特征和周围词汇区分：波斯/达利/塔吉克、阿拉伯/波斯/乌尔都、俄/乌克兰/哈萨克/塔吉克（西里尔）、土耳其/阿塞拜疆。
- 汉字：含假名为日语，含谚文为韩语，否则按中文。

二、PRON：只写读者在正文语言里怎么读，不写来源语言的读音（梵语、阿拉伯语等来源放进 ETYMOLOGY）。人名地名也按正文语言读；中文里的日韩人名地名给拼音。
- 中文：带声调拼音。日语：平文式罗马字，可附假名。韩语：文观部罗马字。梵语、巴利语、印地语：IAST。
- 其他语言：先写标出元音和重音的形式，空一格再写方括号 IPA，重读音节前标 ˈ。先定元音和重音再转 IPA，不要逐字母硬转：
  俄语 кни́ги [ˈknʲiɡʲɪ]：按词形变化定重音；非重读 о/а 弱化为 ɐ/ə，е/я 为 ɪ；词末浊辅音清化；软辅音标 ʲ
  波斯语 ketāb [keˈtɒːb]：补全不写出的短元音；德黑兰音 æ e o / ɒː iː uː；耶扎菲读出 -e/-ye；名词、形容词重音在末音节，动词前缀 mi-/ne-/be- 带重音。达利语用喀布尔音
  阿拉伯语 al-kutubu [al.ˈku.tu.bu]：补全短元音，按句法补格尾，句末停顿形不读格尾
  德语 gegangen [ɡəˈɡaŋən]`;

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

// ===== 存储：每个词形一个键 "w:<小写词>" → 这个词形的所有词条 =====
// 0.8 及以前整本词库存在一个 entries 键里（用户的有 6000+ 条、近 3MB），每查一次词要整读整写两三遍，
// 光是从缓存里拿一个查过的词就要 200–500ms。页内高亮只要收藏的词，单独存一份 starredWords。
const wkey = (word) => "w:" + squash(word).toLocaleLowerCase();

// 读-改-写一律排队，避免并发互相覆盖
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

// 改一个词形下的词条：fn 原地改数组（或返回新数组），改空了就删键
function updateWord(word, fn) {
  return serial(async () => {
    const k = wkey(word);
    const { [k]: list = [] } = await chrome.storage.local.get(k);
    const next = fn(list) || list;
    await (next.length ? chrome.storage.local.set({ [k]: next }) : chrome.storage.local.remove(k));
  });
}

// 旧版 entries 一次性拆成每词一个键；之后每次 service worker 启动这里只是查一下没有 entries 键
const ready = serial(async () => {
  const { entries } = await chrome.storage.local.get("entries");
  if (!entries) return;
  const out = {};
  for (const e of entries) (out[wkey(e.word)] ||= []).push(e);
  out.starredWords = [...new Set(entries.filter((e) => e.starred).map((e) => squash(e.word).toLocaleLowerCase()))];
  await chrome.storage.local.set(out);
  await chrome.storage.local.remove("entries");
});

// 只留 keep 为真的词条（清空缓存 / 过期清理），只在用户点清空或浏览器启动时跑
function prune(keep) {
  return serial(async () => {
    const all = await chrome.storage.local.get(null);
    const set = {};
    const del = [];
    for (const [k, list] of Object.entries(all)) {
      if (!k.startsWith("w:")) continue;
      const left = list.filter(keep);
      if (!left.length) del.push(k);
      else if (left.length < list.length) set[k] = left;
    }
    await chrome.storage.local.remove(del);
    await chrome.storage.local.set(set);
  });
}
const expire = () => prune((e) => e.starred || e.timestamp >= Date.now() - CACHE_DAYS * 864e5);
chrome.runtime.onStartup.addListener(expire);
chrome.runtime.onInstalled.addListener(() => ready.then(expire));

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  handle(msg).then(reply, (e) => reply({ ok: false, error: errInfo(e) }));
  return true;
});

async function handle(msg) {
  switch (msg?.type) {
    case "PATCH": {   // 收藏 / 取消收藏 / 标记已导出；items: [{ id, word }]，按 word 找键
      await ready;
      const ids = new Set(msg.items.map((x) => x.id));
      const words = [...new Set(msg.items.map((x) => x.word))];
      for (const w of words) await updateWord(w, (es) => { for (const e of es) if (ids.has(e.id)) Object.assign(e, msg.patch); });
      if ("starred" in msg.patch) await serial(() => syncStarred(words));
      return { ok: true };
    }
    case "CLEAR":
      await ready;
      await prune((e) => e.starred);
      return { ok: true };
    case "TEST_KEY":
      return { ok: true, data: parse(await ask(msg.apiKey, msg.word, `测试词：${msg.word}`, "")) };
    case "OPEN_OPTIONS":
      await chrome.runtime.openOptionsPage();
      return { ok: true };
  }
  return { ok: false, error: { message: "未知请求" } };
}

// ===== 查词：走 Port，边生成边把已有字段推给卡片 =====
// 卡片中途关掉也照样生成完、存下来（下次再查直接出缓存），只是不再推给卡片
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "nama-lookup") return;
  port.onMessage.addListener((msg) => lookup(port, msg)
    .catch((e) => post(port, { error: errInfo(e) }))
    .finally(() => port.disconnect()));
});

function post(port, msg) {
  try { port.postMessage(msg); } catch {}   // 卡片已关
}

// 这几个词形还有没有收藏的词条，同步进 starredWords（页内高亮用）
async function syncStarred(words) {
  const keys = words.map(wkey);
  const got = await chrome.storage.local.get([...keys, "starredWords"]);
  const set = new Set(got.starredWords || []);
  for (const k of keys) (got[k] || []).some((e) => e.starred) ? set.add(k.slice(2)) : set.delete(k.slice(2));
  await chrome.storage.local.set({ starredWords: [...set] });
}

async function lookup(port, { word, sentence, fresh, id }) {
  word = squash(word);
  const context = squash(sentence) || word;
  if (!word) throw err("bad_request", "没有选中可查的文字");

  await ready;
  const k = wkey(word);
  const { [k]: list = [], deepseekApiKey, readLang = "" } =
    await chrome.storage.local.get([k, "deepseekApiKey", "readLang"]);
  const lock = langKey(readLang);

  if (!fresh) {
    const hit = findEntry(list, word, lock);
    if (hit) return post(port, { done: true, data: hit, lock });
  }
  if (!deepseekApiKey) throw err("missing_key", "请先在扩展设置里填 DeepSeek API Key");

  // 词典读音和模型并行：锁了语言就立刻查，否则等模型吐出 LANG 行再查
  let dict = lock ? dictIpa(word, lock) : null;
  let lastPost = 0;
  const text = await ask(deepseekApiKey, word, context, lock, (partial) => {
    const data = parse(partial, lock);
    if (!dict && LANGS[langKey(data.lang)]) dict = dictIpa(word, data.lang);
    if (Date.now() - lastPost > 80) {   // 限流，别把消息通道打满
      lastPost = Date.now();
      post(port, { data, lock });
    }
  });

  // 模型一写完就存、就出结果，不等词典
  const data = parse(text, lock);
  const fields = { ...data, ipaDict: false, lang: data.lang || "未知语言", context, timestamp: Date.now() };
  let entry;
  await updateWord(word, (es) => {
    // 重新分析：沿用原条目的 id、原文词形（页内高亮靠它匹配）、收藏和导出状态
    const i = id ? es.findIndex((e) => e.id === id) : -1;
    if (i >= 0) entry = es[i] = { ...es[i], ...fields };
    else es.push(entry = { id: crypto.randomUUID(), word, ...fields, starred: false, exportedAt: 0 });
  });
  post(port, { done: true, data: entry, lock });

  // 词典读音到了再补上；这期间要是又重新分析过，就不拿旧的覆盖
  const ipa = pickIpa(await (dict || dictIpa(word, data.lang)), data.translit);
  if (!ipa) return;
  const patch = { translit: ipa, ipaDict: true };
  await updateWord(word, (es) => {
    const e = es.find((x) => x.id === entry.id);
    if (e?.timestamp === entry.timestamp) Object.assign(e, patch);
  });
  post(port, { patch });
}

// 同词：已收藏的优先，其次最近分析的（所以重新分析后再查就是新结果）；锁了语言只认该语言
function findEntry(entries, word, lock) {
  const key = word.toLocaleLowerCase();
  return entries
    .filter((e) => e.word.toLocaleLowerCase() === key && (!lock || e.lang.startsWith(lock)))
    .sort((a, b) => b.starred - a.starred || b.timestamp - a.timestamp)[0];
}

async function ask(apiKey, word, sentence, lock, onText = () => {}) {
  try {
    const res = await fetch(API, {
      method: "POST",
      signal: AbortSignal.timeout(60000),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL,
        thinking: { type: "disabled" },   // 默认开思考，查一个词要等好几秒
        temperature: 0.2,
        max_tokens: 400,
        stream: true,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `${lock ? `正文语言：${lock}\n` : ""}单词：${word}\n句子：${sentence}` }
        ]
      })
    });
    if (!res.ok) throw apiError(res.status, await res.text());

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const lines = (buffer + value).split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        const payload = line.slice(5).trim();
        if (!line.startsWith("data:") || payload === "[DONE]") continue;
        const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
        if (delta) onText(text += delta);
      }
    }
    if (!text.trim()) throw err("empty", "模型没有返回内容，请重试");
    return text;
  } catch (e) {
    if (e.type) throw e;
    if (e.name === "TimeoutError") throw err("timeout", "请求超时，请重试");
    throw err("network", "网络错误，请重试");
  }
}

function parse(text, lock) {
  const field = (tag) => squash(text.match(new RegExp(`^[\\s>*-]*${tag}\\**\\s*[:：]\\s*(.+)$`, "im"))?.[1]);
  return {
    lang: lock || field("LANG"),
    translit: field("PRON"),
    meaning: field("MEANING"),
    etymology: field("ETYMOLOGY"),
    form: field("FORM")
  };
}

// ===== 词典读音：Wiktionary（kaikki.org 逐词 JSONL），只查单个词 =====
async function dictIpa(word, lang) {
  const name = LANGS[langKey(lang)];
  if (!name || /\s/.test(word)) return [];
  // 词典页标题不带课本式重音符和阿拉伯语元音符号
  const bare = word.normalize("NFC").replace(/[\u0300\u0301\u064B-\u065F\u0670]/g, "");
  const signal = AbortSignal.timeout(4000);
  const get = async (w) => {
    const c = Array.from(w);
    const path = [name, "meaning", c[0], c.slice(0, 2).join(""), `${w}.jsonl`].map(encodeURIComponent).join("/");
    try {
      const res = await fetch(`https://kaikki.org/dictionary/${path}`, { signal });
      if (!res.ok) return [];
      return (await res.text()).split("\n").filter(Boolean)
        .flatMap((line) => JSON.parse(line).sounds || [])
        .map((s) => s.ipa)
        .filter((ipa) => ipa && !ipa.includes("-"));   // 去掉「/ɹə-/」这类残片
    } catch {
      return [];   // 超时或断网：就用模型的读音
    }
  };
  // 句首大写的形式词典里多半没有：原样和小写并行查，原样优先
  const [exact, lower = []] = await Promise.all([...new Set([bare, bare.toLocaleLowerCase()])].map(get));
  return exact.length ? exact : lower;
}

// 同形词、方言变体都在候选里：挑和模型读音最接近的那个替换进去，差太远就不换
function pickIpa(candidates, pron) {
  const own = pron.match(/\[[^\]]+\]|\/[^/]+\//)?.[0];
  if (!own || !candidates.length) return "";
  const norm = (s) => s.normalize("NFD").replace(/[\p{M}\p{Lm}\p{P}\s]/gu, "").replace(/g/g, "ɡ");
  const target = norm(own);
  const [[distance, best]] = candidates
    .map((c) => [editDistance(norm(c), target), c])
    .sort((a, b) => a[0] - b[0]);
  return distance <= Math.max(2, target.length * 0.4) ? pron.replace(own, () => best) : "";
}

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] !== b[j - 1]));
    }
    prev = cur;
  }
  return prev[b.length];
}

// ===== 小工具 =====
function apiError(status, body) {
  let message = body;
  try { message = JSON.parse(body).error.message; } catch {}
  if (status === 401) return err("invalid_key", "API Key 无效");
  if (status === 402 || /insufficient|balance|quota|余额|欠费/i.test(message)) {
    return err("insufficient_balance", "DeepSeek 账户余额不足");
  }
  return err("api_error", `DeepSeek 返回 ${status}：${message}`.slice(0, 200));
}

function err(type, message) {
  return Object.assign(new Error(message), { type });
}

function errInfo(e) {
  return { type: e.type || "unknown", message: e.message || "未知错误" };
}

function squash(s) {
  return String(s ?? "").trim().replace(/\s+/g, " ");
}

// 自检：node check.js（扩展不加载这个文件）。离线测解析/缓存/读音挑选，加 --live 再真连 kaikki.org。
const fs = require("fs");
const assert = require("assert");
const noop = () => {};
// 老版本的数据：整本词库在一个 entries 键里，加载 background.js 时应自动拆成每词一个键
const old = (word, starred) => ({ id: word + starred, word, lang: "俄语", starred, timestamp: Date.now() });
const store = { entries: [old("Книги", true), old("книги", false), old("мир", false)] };
globalThis.chrome = {
  action: { onClicked: { addListener: noop } },
  runtime: { onMessage: { addListener: noop }, onConnect: { addListener: noop }, onStartup: { addListener: noop }, onInstalled: { addListener: noop } },
  storage: { local: {
    get: async (keys) => Object.fromEntries((keys === null ? Object.keys(store) : [].concat(keys))
      .filter((k) => k in store).map((k) => [k, structuredClone(store[k])])),
    set: async (o) => Object.assign(store, structuredClone(o)),
    remove: async (keys) => [].concat(keys).forEach((k) => delete store[k])
  } }
};
// 和 service worker 里的 importScripts 一样：顶层 const 在各脚本间共享
const load = (f) => require("vm").runInThisContext(fs.readFileSync(`${__dirname}/${f}`, "utf8"), { filename: f });
globalThis.importScripts = load;
load("background.js");

// 模型输出解析：容忍加粗标签和全角冒号；锁定语言时 LANG 以锁定为准
const out = "**LANG**: 阿拉伯语\nPRON： kitāb [keˈtɒːb]\nMEANING: 书\nETYMOLOGY: 阿拉伯语 kitāb\nFORM: 名词";
assert.deepStrictEqual(parse(out, "波斯语"), {
  lang: "波斯语", translit: "kitāb [keˈtɒːb]", meaning: "书", etymology: "阿拉伯语 kitāb", form: "名词"
});
assert.strictEqual(parse("LANG: 波斯", "").lang, "波斯");
assert.strictEqual(langKey("波斯"), "");            // 流式半截不触发词典查询
assert.strictEqual(langKey("波斯语(源自阿拉伯语)"), "波斯语");

// 读音挑选：同形词 / 方言变体里选最接近模型的；差太远不换；模型没给 IPA 不换
const persian = ["/ki.ˈtaːb/", "[kʰɪ.t̪ʰɑ́ːb]", "[kʰʲe.t̪ʰɒ́ːb̥]", "/kut.ˈtaːb/", "[kʰot̪ʰ.t̪ʰɒ́ːb̥]"];
assert.strictEqual(pickIpa(persian, "ketāb [keˈtɒːb]"), "ketāb [kʰʲe.t̪ʰɒ́ːb̥]");
assert.strictEqual(pickIpa(persian, "kottāb [kotˈtɒːb]"), "kottāb [kʰot̪ʰ.t̪ʰɒ́ːb̥]");
const arabic = ["/ka.ta.ba/", "/kat.ta.ba/", "/ku.tub/", "/ki.taːb/"];
assert.strictEqual(pickIpa(arabic, "kutub [ˈku.tub]"), "kutub /ku.tub/");
assert.strictEqual(pickIpa(["[ˈknʲiɡʲɪ]"], "кни́ги [ˈknʲigʲɪ]"), "кни́ги [ˈknʲiɡʲɪ]");   // g/ɡ 视为同一个
assert.strictEqual(pickIpa(["[mɐskˈva]"], "книги [ˈknʲigʲɪ]"), "");
assert.strictEqual(pickIpa(persian, "shū"), "");
assert.strictEqual(editDistance("kitten", "sitting"), 3);

// 缓存命中：已收藏 > 最近分析；锁了语言只认该语言
const e = (id, lang, starred, timestamp) => ({ id, word: "Бо", lang, starred, timestamp });
const entries = [e("ru", "俄语", false, 3), e("tg", "塔吉克语", false, 1), e("tg2", "塔吉克语", false, 2)];
assert.strictEqual(findEntry(entries, "бо", "").id, "ru");
assert.strictEqual(findEntry(entries, "бо", "塔吉克语").id, "tg2");
entries[1].starred = true;
assert.strictEqual(findEntry(entries, "бо", "").id, "tg");
assert.strictEqual(findEntry(entries, "бо", "波斯语"), undefined);

(async () => {
  await ready;
  assert.deepStrictEqual(Object.keys(store).sort(), ["starredWords", "w:книги", "w:мир"]);
  assert.strictEqual(store["w:книги"].length, 2);
  assert.deepStrictEqual(store.starredWords, ["книги"]);
  // 取消收藏 → 同步出高亮词表；清空缓存只留收藏
  await handle({ type: "PATCH", items: [{ id: "Книгиtrue", word: "Книги" }], patch: { starred: false } });
  assert.deepStrictEqual(store.starredWords, []);
  await handle({ type: "PATCH", items: [{ id: "мирfalse", word: "мир" }], patch: { starred: true } });
  await handle({ type: "CLEAR" });
  assert.deepStrictEqual(Object.keys(store).sort(), ["starredWords", "w:мир"]);
  for (const k of Object.keys(store)) delete store[k];

  // 端到端：流式 SSE 切成 5 字节碎片（跨多字节字符）→ 解析 → 先出结果入库 → 词典 IPA 事后补上
  // → 再查命中缓存 → 重新分析保留收藏、再查拿到的是新结果
  Object.assign(store, { deepseekApiKey: "sk-test", readLang: "俄语" });
  const calls = [];
  const deepseekCalls = () => calls.filter((u) => u.includes("deepseek")).length;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes("kaikki")) return new Response(`${JSON.stringify({ sounds: [{ ipa: "[ˈknʲiɡʲɪ]" }] })}\n`);
    const answer = ["LANG: 俄语", "PRON: кни́ги [ˈknʲigʲɪ]", `MEANING: 书（第 ${deepseekCalls()} 次分析）`, "ETYMOLOGY: 源自古教会斯拉夫语", "FORM: книга 的复数"].join("\n");
    const sse = answer.match(/[^]{1,12}/g)
      .map((t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`).join("") + "data: [DONE]\n\n";
    const bytes = new TextEncoder().encode(sse);
    return new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 5) c.enqueue(bytes.slice(i, i + 5)); c.close(); } }));
  };
  const run = async (msg) => {
    const posts = [];
    await lookup({ postMessage: (m) => posts.push(m) }, msg);
    return posts;
  };
  let posts = await run({ word: "книги", sentence: "Эти книги интересные." });
  const done = posts.find((m) => m.done);
  assert.ok(done && done.lock === "俄语");
  assert.strictEqual(done.data.translit, "кни́ги [ˈknʲigʲɪ]");   // 先给模型读音
  assert.strictEqual(done.data.ipaDict, false);
  assert.deepStrictEqual(posts.at(-1), { patch: { translit: "кни́ги [ˈknʲiɡʲɪ]", ipaDict: true } });
  assert.strictEqual(store["w:книги"].length, 1);
  assert.strictEqual(store["w:книги"][0].ipaDict, true);
  await run({ word: "Книги", sentence: "другое" });   // 大小写不同、上下文不同，同语言 → 走缓存
  assert.strictEqual(deepseekCalls(), 1);
  store["w:книги"][0].starred = true;
  posts = await run({ word: "книги", sentence: "Эти книги интересные.", fresh: true, id: store["w:книги"][0].id });
  assert.strictEqual(deepseekCalls(), 2);
  assert.strictEqual(store["w:книги"].length, 1);
  assert.strictEqual(posts.find((m) => m.done).data.starred, true);
  posts = await run({ word: "книги", sentence: "Эти книги интересные." });
  assert.strictEqual(posts[0].data.meaning, "书（第 2 次分析）");

  if (process.argv.includes("--live")) {
    const ipas = await dictIpa("Книги", "俄语");   // 句首大写 → 回退小写
    assert.ok(ipas.includes("[ˈknʲiɡʲɪ]"), ipas);
    assert.deepStrictEqual(await dictIpa("два слова", "俄语"), []);
    assert.deepStrictEqual(await dictIpa("书", "中文"), []);
  }
  console.log("check.js: all ok");
})();

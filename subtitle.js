// Nama 视频字幕模式：把 YouTube / Netflix 的原生字幕就地换成可查词的字幕。
//
// 两种工作模式：
//  1. track（首选）——开播时就把**整条字幕轨**抓下来，一次性断好句、建好时间轴。
//     跳句、停在句末都是精确的，显示的也是完整句子（因为已经知道后文了）。
//     字幕轨地址来自 subtitle-bridge.js（页面主世界），下载走 background.js（绕 CORS）。
//  2. live（兜底）——整轨拿不到时，退回 100ms 轮询 DOM，边看边攒时间轴。
//     此时「下一句」只能小步试探 seek，显示的也只能是当前这一条碎片。
(function () {
  const SITE = detectSite();
  if (!SITE) {
    return;
  }

  const BRIDGE_TAG = "nama-bridge";
  const OVERLAY_ID = "nama-sub-overlay";
  const ACTIVE_CLASS = "nama-sub-active";
  const TICK_MS = 100;
  const SEEK_QUIET_MS = 700;
  const PROBE_STEP = 0.4;
  const PROBE_MAX_STEPS = 16;
  // 进字幕框已经会暂停，说明是有意停下来看的，不必再等那么久防误触
  const HOVER_DELAY_MS = 120;
  const WARM_INTERVAL_MS = 120000;
  // live 兜底模式下，滚动字幕是一个词一个词长出来的。每次都重画会看得人很难受，
  // 所以等它「停止增长」再整块换一次；一直在长的话也最多憋这么久。
  const LIVE_SETTLE_MS = 350;
  const LIVE_HOLD_MAX_MS = 1200;

  // 断句
  const SENTENCE_END_RE = /[.!?。！？…؟۔][\s"'”’»）)\]]*$/u;
  // 攒够「软长度」后，遇到逗号分号一类的**从句边界**也断——否则一个长句能拖很久
  const CLAUSE_END_RE = /[,;:，、；：—–][\s"'”’»）)\]]*$/u;
  const SENTENCE_GAP_S = 1.2;
  const PAUSE_HINT_S = 0.35;        // 句内这么长的停顿，多半正好是词组之间
  const OVERLONG_FACTOR = 3;        // 整段找不到任何安全断点时的兜底上限

  // 整轨获取
  const TRACK_REQUEST_RETRIES = 6;
  const TRACK_RETRY_MS = 1500;
  const VERIFY_FAIL_LIMIT = 3;

  const DEFAULTS = {
    subtitleEnabled: true,
    subtitleAutoPause: false,
    subtitleMergeSentences: false,
    subtitleFontSize: 28,
    subtitleFontFamily: "",
    subtitleBackdrop: "shadow",
    subtitleBottomPct: 12,
    subtitleMaxChars: 80
  };

  function maxChars() {
    return Math.min(240, Math.max(30, Number(settings.subtitleMaxChars) || 80));
  }

  // 一个断点至少要留下这么长的片段才值得单独成句。
  // 取 0.35 而不是 0.6：从句往往就三四十字，卡太高会把本来很好的逗号断点挡掉，
  // 结果反倒攒出一个超长句。宁可短一点，也别长到看不完。
  function softChars() {
    return Math.max(20, Math.round(maxChars() * 0.35));
  }

  const settings = Object.assign({}, DEFAULTS);

  let video = null;
  let overlay = null;
  let displayText = "";
  let contextText = "";
  let hasCue = false;
  let lastSeekAt = 0;
  let hoverTimer = null;
  let hoverWord = "";
  let closeTimer = null;
  let leaveTimer = null;
  let pausedByHover = false;   // 只有「我们因为悬停暂停的」才在离开时自动续播

  // ---- track 模式 ----
  let mode = "live";
  let trackCues = [];           // 整轨原始 cue，改断句长度时要靠它重新断
  let sentences = [];           // [{start, end, text}]，整轨断好句的结果
  let sentenceIdx = -1;
  let autoPausedIdx = -1;
  let trackState = "idle";      // idle | requesting | loading | ready | failed
  let trackAttempts = 0;
  let nextAttemptAt = 0;
  let candidates = [];
  let candidateIdx = 0;
  let verified = false;
  let verifyFails = 0;
  let lastVerifiedDom = "";
  let netflixTracks = null;
  let netflixActive = null;

  // ---- live 兜底模式 ----
  let lastText = "";
  let currentCue = null;
  let lastCue = null;
  let cues = [];
  let probing = false;
  let sentence = "";
  let sentenceStart = null;
  let pendingFlush = false;
  let gapStart = null;
  let pendingText = "";      // 已读到但还没画上去的文本（等它别再长了）
  let pendingSince = 0;
  let lastRenderAt = 0;
  let fallbackNotified = false;

  init();

  function init() {
    chrome.storage.local.get(Object.keys(DEFAULTS), (stored) => {
      for (const key of Object.keys(DEFAULTS)) {
        if (stored[key] !== undefined) {
          settings[key] = stored[key];
        }
      }
      applyStyle();
      if (!settings.subtitleEnabled) {
        teardown();
      }
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") {
        return;
      }
      let touched = false;
      for (const key of Object.keys(DEFAULTS)) {
        if (changes[key]) {
          const next = changes[key].newValue;
          settings[key] = next === undefined ? DEFAULTS[key] : next;
          touched = true;
        }
      }
      if (!touched) {
        return;
      }
      if (!settings.subtitleEnabled) {
        teardown();
        return;
      }
      applyStyle();
      if (changes.subtitleMergeSentences) {
        refreshDisplay();
      }
      // 改了每句长度就按新长度重新断一次（整轨还在内存里，不用重新下载）
      if (changes.subtitleMaxChars && mode === "track" && trackCues.length) {
        sentences = buildSentences(trackCues);
        sentenceIdx = -1;
        autoPausedIdx = -1;
      }
    });

    window.addEventListener("message", handleBridgeMessage);
    document.addEventListener("keydown", handleKey, true);
    document.addEventListener("fullscreenchange", () => {
      if (settings.subtitleEnabled && overlay) {
        mountOverlay();
      }
    });

    setInterval(tick, TICK_MS);
  }

  // ===== 站点适配 =====

  function detectSite() {
    const host = location.hostname;
    if (/(^|\.)youtube\.com$/.test(host)) {
      return "youtube";
    }
    if (/(^|\.)netflix\.com$/.test(host)) {
      return "netflix";
    }
    return null;
  }

  function isWatchPage() {
    if (SITE === "youtube") {
      return location.pathname === "/watch" || location.pathname.startsWith("/embed/");
    }
    return location.pathname.startsWith("/watch");
  }

  function findVideo() {
    const videos = Array.from(document.querySelectorAll("video"));
    let best = null;
    for (const v of videos) {
      if (!v.isConnected || !v.duration || !isFinite(v.duration)) {
        continue;
      }
      if (!best || v.duration > best.duration) {
        best = v;
      }
    }
    return best || videos.find((v) => v.isConnected) || null;
  }

  // 只取顶层的「一行字幕」容器：两家都会在里面套一层同文本的描边副本。
  function nativeLineNodes() {
    return SITE === "youtube"
      ? document.querySelectorAll(".ytp-caption-window-container > .caption-window")
      : document.querySelectorAll(".player-timedtext > .player-timedtext-text-container");
  }

  function readNativeText() {
    let nodes = Array.from(nativeLineNodes());
    if (!nodes.length && SITE === "youtube") {
      nodes = Array.from(document.querySelectorAll(".ytp-caption-segment"));
    }

    const seen = new Set();
    const lines = [];
    for (const node of nodes) {
      if (node.style && node.style.display === "none") {
        continue;
      }
      const line = collapseSelfRepeat(normalize(node.textContent));
      if (line && !seen.has(line)) {
        seen.add(line);
        lines.push(line);
      }
    }
    return collapseSelfRepeat(lines.join(" "));
  }

  function normalize(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  // 门槛 10 字符：短句里「そうそう」这类真叠词不能误砍。
  function collapseSelfRepeat(text) {
    if (text.length < 10) {
      return text;
    }
    const half = Math.floor(text.length / 2);
    if (text.length % 2 === 0 && text.slice(0, half) === text.slice(half)) {
      return text.slice(0, half);
    }
    if (text[half] === " " && text.slice(0, half) === text.slice(half + 1)) {
      return text.slice(0, half);
    }
    return text;
  }

  // ===== 整轨获取 =====

  function requestTracks() {
    window.postMessage({ __nama: `${BRIDGE_TAG}-req`, type: "REQUEST_TRACKS" }, location.origin);
  }

  function handleBridgeMessage(event) {
    if (event.source !== window) {
      return;
    }
    const data = event.data;
    if (!data || data.__nama !== BRIDGE_TAG) {
      return;
    }

    if (data.type === "YOUTUBE_TRACKS") {
      onYouTubeTracks(data.payload);
    } else if (data.type === "NETFLIX_TRACKS") {
      netflixTracks = (data.payload && data.payload.tracks) || null;
      if (trackState === "requesting") {
        buildNetflixCandidates();
      }
    } else if (data.type === "NETFLIX_ACTIVE") {
      netflixActive = data.payload || null;
      if (trackState === "requesting" && netflixTracks) {
        buildNetflixCandidates();
      }
    }
  }

  function ensureTrack() {
    if (trackState !== "idle" || !video || Date.now() < nextAttemptAt) {
      return;
    }
    if (trackAttempts >= TRACK_REQUEST_RETRIES) {
      trackState = "failed";
      notifyFallback("bridge 一直没报出字幕轨（脚本没注入？播放器没就绪？）");
      return;
    }

    trackAttempts += 1;
    nextAttemptAt = Date.now() + TRACK_RETRY_MS;
    trackState = "requesting";
    requestTracks();

    // 桥没回应（脚本没注入 / 播放器还没就绪）就重来，超次数后彻底退回 live
    window.setTimeout(() => {
      if (trackState === "requesting") {
        trackState = trackAttempts >= TRACK_REQUEST_RETRIES ? "failed" : "idle";
      }
    }, TRACK_RETRY_MS - 100);
  }

  function onYouTubeTracks(payload) {
    const tracks = (payload && payload.tracks) || [];
    if (!tracks.length) {
      trackState = trackAttempts >= TRACK_REQUEST_RETRIES ? "failed" : "idle";
      if (trackState === "failed") {
        notifyFallback("这个视频的 playerResponse 里没有字幕轨");
      }
      return;
    }

    const wanted = payload.active ? payload.active.languageCode : null;
    const scored = tracks
      .filter((track) => track.baseUrl)
      .map((track) => {
        let score = 0;
        if (wanted && track.languageCode === wanted) score += 100;
        if (track.kind !== "asr") score += 10;          // 人工字幕优先于自动字幕
        if (track.vssId && track.vssId.startsWith(".")) score += 5;  // 默认轨
        return { score, track };
      })
      .sort((a, b) => b.score - a.score);

    candidates = scored.map((item) => ({
      url: `${item.track.baseUrl}&fmt=json3`,
      format: "json3",
      label: item.track.name || item.track.languageCode
    }));
    candidateIdx = 0;
    loadCandidate();
  }

  function buildNetflixCandidates() {
    const tracks = (netflixTracks || []).filter((track) => track
      && !track.isNoneTrack
      && !track.isForcedNarrative
      && track.ttDownloadables);

    if (!tracks.length) {
      trackState = trackAttempts >= TRACK_REQUEST_RETRIES ? "failed" : "idle";
      if (trackState === "failed") {
        notifyFallback("没从播放清单里截到可用字幕轨");
      }
      return;
    }

    const wanted = netflixActive
      ? (netflixActive.bcp47 || netflixActive.language || "")
      : "";

    const built = [];
    for (const track of tracks) {
      const download = pickNetflixDownload(track);
      if (!download) {
        continue;
      }
      const lang = track.language || track.bcp47 || "";
      built.push({
        score: wanted && lang && lang === wanted ? 100 : 0,
        url: download.url,
        format: download.format,
        label: track.languageDescription || lang
      });
    }

    if (!built.length) {
      trackState = "failed";
      notifyFallback("字幕轨里没有可下载的 webvtt / dfxp 地址");
      return;
    }

    built.sort((a, b) => b.score - a.score);
    candidates = built;
    candidateIdx = 0;
    loadCandidate();
  }

  function pickNetflixDownload(track) {
    const downloadables = track.ttDownloadables || {};
    const keys = Object.keys(downloadables);
    // webvtt 比 ttml 好解析，优先
    keys.sort((a, b) => (b.includes("webvtt") ? 1 : 0) - (a.includes("webvtt") ? 1 : 0));

    for (const key of keys) {
      const entry = downloadables[key] || {};
      const urls = entry.downloadUrls || entry.urls || null;
      if (!urls) {
        continue;
      }
      const url = Array.isArray(urls) ? urls[0] : Object.values(urls)[0];
      if (typeof url === "string" && url) {
        return { url, format: key.includes("webvtt") ? "vtt" : "ttml" };
      }
    }
    return null;
  }

  async function loadCandidate() {
    if (candidateIdx >= candidates.length) {
      trackState = "failed";
      mode = "live";
      notifyFallback("候选字幕轨都下载或解析失败了");
      return;
    }

    trackState = "loading";
    const candidate = candidates[candidateIdx];

    let response = null;
    try {
      response = await sendRuntimeMessage({ type: "FETCH_SUBTITLE", url: candidate.url });
    } catch (error) {
      response = null;
    }

    if (!response || !response.ok || !response.text) {
      console.warn("[Nama] 字幕轨下载失败", candidate.label, candidate.url,
        response && response.error ? response.error.message : "(无响应)");
      candidateIdx += 1;
      loadCandidate();
      return;
    }

    let parsed = [];
    try {
      parsed = candidate.format === "json3" ? parseJson3(response.text)
        : candidate.format === "vtt" ? parseVtt(response.text)
          : parseTtml(response.text);
    } catch (error) {
      parsed = [];
    }

    if (!parsed.length) {
      candidateIdx += 1;
      loadCandidate();
      return;
    }

    trackCues = parsed;
    sentences = buildSentences(trackCues);
    if (!sentences.length) {
      candidateIdx += 1;
      loadCandidate();
      return;
    }

    mode = "track";
    trackState = "ready";
    sentenceIdx = -1;
    autoPausedIdx = -1;
    verified = false;
    verifyFails = 0;
    lastVerifiedDom = "";
    flash(`字幕已载入：${sentences.length} 句`);
  }

  // 退回 live 模式时明确告诉用户一声——否则「字幕怎么一个词一个词蹦」
  // 会被误当成显示 bug，其实是整轨没抓到。
  function notifyFallback(reason) {
    if (fallbackNotified) {
      return;
    }
    fallbackNotified = true;
    console.warn(`[Nama] 整轨字幕不可用，退回逐句模式：${reason}`);
    flash("字幕轨未取到，已退回逐句模式");
  }

  function resetTrack() {
    mode = "live";
    fallbackNotified = false;
    trackCues = [];
    sentences = [];
    sentenceIdx = -1;
    autoPausedIdx = -1;
    trackState = "idle";
    trackAttempts = 0;
    nextAttemptAt = 0;
    candidates = [];
    candidateIdx = 0;
    verified = false;
    verifyFails = 0;
    lastVerifiedDom = "";
    netflixActive = null;
    // netflixTracks 不清：Netflix 只在换片时才重发清单
  }

  // ===== 字幕文件解析 =====

  function parseJson3(text) {
    const data = JSON.parse(text);
    const events = data.events || [];
    const out = [];
    for (const event of events) {
      if (!event.segs || typeof event.tStartMs !== "number") {
        continue;
      }
      const body = normalize(event.segs.map((seg) => seg.utf8 || "").join(""));
      if (!body) {
        continue;
      }
      const start = event.tStartMs / 1000;
      const end = start + (event.dDurationMs || 2000) / 1000;
      out.push({ start, end, text: body });
    }
    return out;
  }

  function parseVtt(text) {
    const out = [];
    for (const block of text.replace(/\r/g, "").split(/\n{2,}/)) {
      const arrow = block.indexOf("-->");
      if (arrow < 0) {
        continue;
      }
      const lines = block.split("\n");
      const timeLineIdx = lines.findIndex((line) => line.includes("-->"));
      if (timeLineIdx < 0) {
        continue;
      }
      const [rawStart, rawEnd] = lines[timeLineIdx].split("-->");
      const start = parseClock(rawStart);
      const end = parseClock(rawEnd);
      if (start === null || end === null) {
        continue;
      }
      const body = normalize(stripTags(lines.slice(timeLineIdx + 1).join(" ")));
      if (body) {
        out.push({ start, end, text: body });
      }
    }
    return out;
  }

  function parseTtml(text) {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.querySelector("parsererror")) {
      return [];
    }
    // Netflix 的 dfxp 用 tick 计时，倍率写在根节点上
    const root = doc.documentElement;
    const tickRate = Number(
      root.getAttribute("ttp:tickRate") || root.getAttribute("tickRate") || 10000000
    ) || 10000000;

    const out = [];
    for (const node of doc.getElementsByTagName("p")) {
      const start = parseTtmlTime(node.getAttribute("begin"), tickRate);
      const end = parseTtmlTime(node.getAttribute("end"), tickRate);
      if (start === null || end === null) {
        continue;
      }
      const body = normalize((node.textContent || "").replace(/\s+/g, " "));
      if (body) {
        out.push({ start, end, text: body });
      }
    }
    return out;
  }

  function parseTtmlTime(value, tickRate) {
    if (!value) {
      return null;
    }
    const raw = String(value).trim();
    if (raw.endsWith("t")) {
      const ticks = Number(raw.slice(0, -1));
      return isFinite(ticks) ? ticks / tickRate : null;
    }
    if (raw.endsWith("s")) {
      const seconds = Number(raw.slice(0, -1));
      return isFinite(seconds) ? seconds : null;
    }
    return parseClock(raw);
  }

  function parseClock(value) {
    const raw = String(value || "").trim().replace(",", ".");
    const parts = raw.split(":").map(Number);
    if (parts.some((part) => !isFinite(part))) {
      return null;
    }
    if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    }
    return parts.length === 1 ? parts[0] : null;
  }

  function stripTags(text) {
    return String(text || "").replace(/<[^>]*>/g, " ");
  }

  // ===== 断句 =====

  // 滚动式字幕后一条是在前一条基础上长出来的，直接拼会重复。
  function mergeOverlap(buffer, next) {
    if (next.startsWith(buffer)) {
      return next;
    }
    if (buffer.endsWith(next)) {
      return buffer;
    }
    const max = Math.min(buffer.length, next.length);
    for (let n = max; n > 3; n -= 1) {
      if (buffer.slice(-n) === next.slice(0, n)) {
        return buffer + next.slice(n);
      }
    }
    // 中日文之间不补空格。除了汉字假名，也要算上全角标点(，。、)和 CJK 符号，
    // 否则「……的时候，」+「那是……」会被塞进一个空格。
    const cjkEdge = /[぀-ヿ㐀-䶿一-鿿豈-﫿　-〿＀-￯]/u;
    const joiner = cjkEdge.test(buffer.slice(-1)) || cjkEdge.test(next.slice(0, 1)) ? "" : " ";
    return normalize(buffer + joiner + next);
  }

  // 整轨断句。
  // **长度本身不制造断点**——只决定在哪个「安全点」上断。cue 的边界是按显示时长切的，
  // 经常正好落在词组中间，照着长度硬断就会把词组劈开。
  // 安全点只有三种：句末标点、从句标点(攒够软长度后才算)、句内明显停顿。
  function buildSentences(rawCues) {
    const hard = maxChars();
    const soft = softChars();
    const ceiling = hard * OVERLONG_FACTOR;

    const cues = rawCues
      .map((cue) => ({ start: cue.start, end: cue.end, text: normalize(cue.text) }))
      .filter((cue) => cue.text)
      .sort((a, b) => a.start - b.start)
      .flatMap(splitCueAtSentenceEnd);

    const out = [];
    let group = [];

    const flush = () => {
      if (group.length) {
        out.push(makeSentence(group));
        group = [];
      }
    };

    for (const cue of cues) {
      const prev = group[group.length - 1];
      if (prev && cue.start - prev.end > SENTENCE_GAP_S) {
        flush();
      }

      group.push(cue);
      const text = groupText(group);

      if (isSentenceDone(text, soft)) {
        flush();
        continue;
      }
      if (text.length < hard) {
        continue;
      }

      // 已经超过目标长度：回头找组内最靠后的安全点断开，剩下的接着攒
      let at = pickSafeBreak(group, hard, soft, false);
      if (!at && text.length >= ceiling) {
        at = pickSafeBreak(group, hard, soft, true);
      }

      if (at > 0) {
        out.push(makeSentence(group.slice(0, at)));
        group = group.slice(at);
      } else if (text.length >= ceiling) {
        flush();   // 整段一个安全点都没有，只能硬断
      }
    }

    flush();
    return out;
  }

  // 一条 cue 里可能同时装着上一句的结尾和下一句的开头（"…就这样。他没有…"）。
  // 只在 cue 边界断的话，这个句号就被跳过了，上一句的最后几个词会被并进下一句。
  // 所以先按句末标点把 cue 拆开，时间按字符位置线性摊。
  function splitCueAtSentenceEnd(cue) {
    const text = cue.text;
    const boundaries = [];
    const re = /[.!?。！？…؟۔]+["'”’»）)\]]*\s*/gu;

    let match;
    while ((match = re.exec(text)) !== null) {
      const end = match.index + match[0].length;
      if (end < text.length) {
        boundaries.push(end);   // 标点正好在结尾就不用拆
      }
    }
    if (!boundaries.length) {
      return [cue];
    }

    const cuts = [0, ...boundaries, text.length];
    const duration = Math.max(0, cue.end - cue.start);
    const total = text.length || 1;
    const parts = [];

    for (let i = 0; i + 1 < cuts.length; i += 1) {
      const from = cuts[i];
      const to = cuts[i + 1];
      const part = text.slice(from, to).trim();
      if (!part) {
        continue;
      }
      parts.push({
        start: cue.start + (from / total) * duration,
        end: cue.start + (to / total) * duration,
        text: part
      });
    }

    return parts.length ? parts : [cue];
  }

  function isSentenceDone(text, soft) {
    return SENTENCE_END_RE.test(text)
      || (text.length >= soft && CLAUSE_END_RE.test(text));
  }

  // 候选断点分三档：① 有停顿 ② 无停顿但前一条不是以短词收尾 ③ 以短词收尾。
  // 第三档基本就是 of / to / در / و / и 这类连接词，断在那儿最难看，
  // 只有整段实在没别的选择时才用。
  function pickSafeBreak(group, hard, soft, desperate) {
    const total = groupText(group).length;
    const candidates = [];

    for (let k = 1; k < group.length; k += 1) {
      const prefix = groupText(group.slice(0, k));
      if (prefix.length < soft) {
        continue;   // 太短的碎片不值得单独成句
      }
      const gap = group[k].start - group[k - 1].end;
      const tier = gap >= PAUSE_HINT_S
        ? 1
        : (endsWithShortWord(group[k - 1].text) ? 3 : 2);
      candidates.push({ k, len: prefix.length, tail: total - prefix.length, tier });
    }

    const maxTier = desperate ? 3 : 2;
    for (let tier = 1; tier <= maxTier; tier += 1) {
      const list = candidates.filter((item) => item.tier === tier);
      if (!list.length) {
        continue;
      }
      // 别在离尾巴太近的地方断：剩下那几个词会被并到下一句开头去
      const roomy = list.filter((item) => item.tail >= soft);
      const pool = roomy.length ? roomy : list;
      const within = pool.filter((item) => item.len <= hard);
      return within.length ? within[within.length - 1].k : pool[0].k;
    }
    return 0;
  }

  function endsWithShortWord(text) {
    const match = text.match(/[\p{L}\p{M}\p{N}]+$/u);
    if (!match) {
      return false;             // 以标点收尾，本来就是好断点
    }
    if (CJK_RE.test(match[0])) {
      return false;             // 中日文不按空格分词，这个启发式不适用
    }
    return match[0].length <= 3;
  }

  function groupText(group) {
    let text = "";
    for (const cue of group) {
      text = text ? mergeOverlap(text, cue.text) : cue.text;
    }
    return text;
  }

  function makeSentence(group) {
    return {
      start: group[0].start,
      end: group[group.length - 1].end,
      text: groupText(group)
    };
  }

  // 返回 start <= t 的最后一句：句子播完后仍留在屏幕上，方便暂停回看。
  function sentenceIndexAt(t) {
    let lo = 0;
    let hi = sentences.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sentences[mid].start <= t) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  }

  // ===== 主循环 =====

  function tick() {
    if (!settings.subtitleEnabled || probing) {
      return;
    }
    if (!isWatchPage()) {
      teardown();
      return;
    }

    const v = findVideo();
    if (!v) {
      teardown();
      return;
    }

    if (v !== video) {
      if (video) {
        video.removeEventListener("seeking", markSeek);
      }
      video = v;
      resetCues();
      resetTrack();
      video.addEventListener("seeking", markSeek);
    }

    mountOverlay();
    positionOverlay();
    ensureTrack();

    const domText = readNativeText();
    if (mode === "track") {
      tickTrack(domText);
    } else {
      tickLive(domText);
    }
  }

  function tickTrack(domText) {
    const t = video.currentTime;
    const idx = sentenceIndexAt(t);

    if (idx >= 0 && idx !== sentenceIdx) {
      sentenceIdx = idx;
      contextText = sentences[idx].text;
      renderLine(contextText);
      hasCue = true;
      document.documentElement.classList.add(ACTIVE_CLASS);
    }

    // 精确停在句末——不用再等 DOM 变化
    if (settings.subtitleAutoPause && sentenceIdx >= 0 && autoPausedIdx !== sentenceIdx
      && !video.paused && t >= sentences[sentenceIdx].end - 0.03
      && Date.now() - lastSeekAt > SEEK_QUIET_MS) {
      video.pause();
      autoPausedIdx = sentenceIdx;
    }

    verifyTrack(domText, t);
  }

  // 选错轨（语言不对）会整篇对不上，这里拿播放器实际显示的字幕来核对。
  // 原生字幕被用户关掉时读不到文本，只能信任 bridge 报的 active 轨。
  function verifyTrack(domText, t) {
    if (verified || !domText || domText === lastVerifiedDom) {
      return;
    }
    lastVerifiedDom = domText;

    const idx = sentenceIndexAt(t);
    const ours = idx >= 0 ? sentences[idx].text : "";
    if (looksLikeSameText(ours, domText)) {
      verified = true;
      return;
    }

    verifyFails += 1;
    if (verifyFails >= VERIFY_FAIL_LIMIT) {
      verifyFails = 0;
      candidateIdx += 1;
      mode = "live";
      loadCandidate();
    }
  }

  function looksLikeSameText(a, b) {
    const x = compact(a);
    const y = compact(b);
    if (!x || !y) {
      return false;
    }
    const probe = y.slice(0, Math.min(10, y.length));
    return x.includes(probe) || y.includes(x.slice(0, Math.min(10, x.length)));
  }

  function compact(text) {
    return String(text || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  }

  function tickLive(domText) {
    const wall = Date.now();

    if (domText !== lastText) {
      const prevText = lastText;
      // 滚动字幕：新文本是在旧文本后面接出来的，属于「同一条还在长」，不是新的一条
      const grew = Boolean(domText && prevText && domText.startsWith(prevText));
      lastText = domText;
      const now = video.currentTime;

      if (currentCue && currentCue.end === null) {
        currentCue.end = now;
      }

      const atBoundary = !settings.subtitleMergeSentences || pendingFlush || !domText;
      if (prevText && !grew && atBoundary && settings.subtitleAutoPause && !video.paused
        && wall - lastSeekAt > SEEK_QUIET_MS) {
        video.pause();
      }

      if (domText) {
        const gap = gapStart === null ? 0 : Math.max(0, now - gapStart);
        gapStart = null;
        hasCue = true;
        currentCue = recordCue(domText, now);
        lastCue = currentCue;
        contextText = advanceSentence(domText, currentCue.start, gap);
        pendingText = settings.subtitleMergeSentences ? contextText : domText;
        pendingSince = wall;
        document.documentElement.classList.add(ACTIVE_CLASS);
        if (!grew) {
          commitLive();   // 换了新的一条，立刻显示，不用等
        }
      } else {
        currentCue = null;
        gapStart = now;
      }
    }

    maybeCommitLive(wall);
  }

  // 还在往外长就先攒着，等它停下来再整块换。一直不停也不能永远不显示，所以有上限。
  function maybeCommitLive(wall) {
    if (!pendingText || pendingText === displayText) {
      return;
    }
    if (wall - pendingSince >= LIVE_SETTLE_MS || wall - lastRenderAt >= LIVE_HOLD_MAX_MS) {
      commitLive();
    }
  }

  function commitLive() {
    lastRenderAt = Date.now();
    renderLine(pendingText);
  }

  function advanceSentence(text, start, gapSeconds) {
    if (!settings.subtitleMergeSentences) {
      sentence = text;
      sentenceStart = start;
      pendingFlush = true;
      return sentence;
    }

    // live 模式没有后文可看，只能按标点/停顿断；长度只做兜底上限，
    // 否则同样会把词组从中间劈开。
    const startsNew = !sentence
      || pendingFlush
      || gapSeconds >= SENTENCE_GAP_S
      || sentence.length >= maxChars() * OVERLONG_FACTOR;

    if (startsNew) {
      sentence = text;
      sentenceStart = start;
    } else {
      sentence = mergeOverlap(sentence, text);
    }

    pendingFlush = isSentenceDone(sentence, softChars());
    return sentence;
  }

  function resetSentence() {
    sentence = "";
    sentenceStart = null;
    pendingFlush = false;
    gapStart = null;
  }

  function markSeek() {
    lastSeekAt = Date.now();
    autoPausedIdx = -1;
    resetSentence();
    lastText = "";
  }

  function resetCues() {
    cues = [];
    currentCue = null;
    lastCue = null;
    lastText = "";
    displayText = "";
    contextText = "";
    pendingText = "";
    pendingSince = 0;
    lastRenderAt = 0;
    hasCue = false;
    hoverWord = "";
    resetSentence();
    document.documentElement.classList.remove(ACTIVE_CLASS);
    if (overlay) {
      overlay.replaceChildren();
    }
  }

  function recordCue(text, start) {
    let i = 0;
    while (i < cues.length && cues[i].start < start) {
      i += 1;
    }
    for (const near of [cues[i - 1], cues[i]]) {
      if (near && near.text === text && Math.abs(near.start - start) < 0.5) {
        return near;
      }
    }
    const cue = { text, start, end: null };
    cues.splice(i, 0, cue);
    return cue;
  }

  // ===== 跳句 =====

  function seekTo(time, resume = true) {
    if (!video) {
      return;
    }
    lastSeekAt = Date.now();
    autoPausedIdx = -1;
    video.currentTime = Math.max(0, time);
    if (resume && video.paused) {
      video.play().catch(() => {});
    }
  }

  // 上一句：**直接跳到上一句开头**，不做「第一下先回本句开头」那套播放器惯例
  // （用户明确要求：那样调到上一句要按两下）。想重听本句用 S。
  function prevUnit() {
    if (!video) {
      return;
    }
    const t = video.currentTime;

    if (mode === "track") {
      if (!sentences.length) {
        return;
      }
      const idx = sentenceIndexAt(t);
      const target = idx > 0 ? idx - 1 : 0;
      seekTo(sentences[target].start);
      return;
    }

    let current = -1;
    for (let i = 0; i < cues.length; i += 1) {
      if (cues[i].start <= t) {
        current = i;
      } else {
        break;
      }
    }
    if (current > 0) {
      seekTo(cues[current - 1].start - 0.05);
    } else if (current === 0) {
      seekTo(cues[0].start - 0.05);
    } else {
      seekTo(t - 3);
    }
  }

  function nextUnit() {
    if (!video) {
      return;
    }

    if (mode === "track") {
      const next = sentences.find((item) => item.start > video.currentTime + 0.05);
      if (next) {
        seekTo(next.start);
      }
      return;
    }

    const known = cues.find((cue) => cue.start > video.currentTime + 0.25);
    if (known) {
      seekTo(known.start + 0.02);
      return;
    }
    probeForward();
  }

  function repeatUnit() {
    if (mode === "track") {
      if (sentenceIdx >= 0) {
        seekTo(sentences[sentenceIdx].start);
      }
      return;
    }
    const start = settings.subtitleMergeSentences && sentenceStart !== null
      ? sentenceStart
      : (currentCue || lastCue || {}).start;
    if (typeof start === "number") {
      seekTo(start - 0.05);
    }
  }

  // 只有 live 模式才需要：没时间轴，只能暂停后小步 seek 直到字幕变化。
  async function probeForward() {
    if (probing || !video) {
      return;
    }

    probing = true;
    const baseText = lastText;
    const origin = video.currentTime;
    const wasPlaying = !video.paused;
    let found = false;

    try {
      video.pause();
      let t = origin;
      for (let i = 0; i < PROBE_MAX_STEPS; i += 1) {
        t += PROBE_STEP;
        if (video.duration && t >= video.duration) {
          break;
        }
        lastSeekAt = Date.now();
        video.currentTime = t;
        await sleep(110);

        const text = readNativeText();
        if (text && text !== baseText) {
          found = true;
          lastText = text;
          currentCue = recordCue(text, video.currentTime);
          lastCue = currentCue;
          resetSentence();
          contextText = advanceSentence(text, currentCue.start, SENTENCE_GAP_S);
          renderLine(settings.subtitleMergeSentences ? contextText : text);
          break;
        }
      }
    } finally {
      if (!found) {
        video.currentTime = origin;
      }
      lastSeekAt = Date.now();
      probing = false;
      if (wasPlaying) {
        video.play().catch(() => {});
      }
    }
  }

  // ===== 开关 / 微调 =====

  function toggleAutoPause() {
    settings.subtitleAutoPause = !settings.subtitleAutoPause;
    chrome.storage.local.set({ subtitleAutoPause: settings.subtitleAutoPause });
    flash(settings.subtitleAutoPause ? "自动暂停：开" : "自动暂停：关");
  }

  function toggleMerge() {
    settings.subtitleMergeSentences = !settings.subtitleMergeSentences;
    chrome.storage.local.set({ subtitleMergeSentences: settings.subtitleMergeSentences });
    refreshDisplay();
    flash(settings.subtitleMergeSentences ? "合并成整句：开" : "合并成整句：关");
  }

  // track 模式下显示的本来就是完整句子，合并开关只影响 live 模式
  function refreshDisplay() {
    if (mode === "track") {
      return;
    }
    resetSentence();
    displayText = "";
    if (!lastText) {
      return;
    }
    const start = currentCue ? currentCue.start : 0;
    contextText = advanceSentence(lastText, start, 0);
    renderLine(settings.subtitleMergeSentences ? contextText : lastText);
  }

  function bumpFontSize(delta) {
    const next = Math.min(72, Math.max(12, Number(settings.subtitleFontSize) + delta));
    settings.subtitleFontSize = next;
    chrome.storage.local.set({ subtitleFontSize: next });
    applyStyle();
    flash(`字号 ${next}px`);
  }

  function bumpBottom(delta) {
    const next = Math.min(45, Math.max(0, Number(settings.subtitleBottomPct) + delta));
    settings.subtitleBottomPct = next;
    chrome.storage.local.set({ subtitleBottomPct: next });
    positionOverlay();
    flash(`离底部 ${next}%`);
  }

  function nudge(seconds) {
    if (video) {
      seekTo(video.currentTime + seconds, false);
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function flash(message) {
    if (!overlay) {
      return;
    }
    let tip = overlay.querySelector(".nama-sub-flash");
    if (!tip) {
      tip = document.createElement("div");
      tip.className = "nama-sub-flash";
      overlay.appendChild(tip);
    }
    tip.textContent = message;
    tip.classList.add("is-on");
    window.clearTimeout(flash.timer);
    flash.timer = window.setTimeout(() => tip.classList.remove("is-on"), 1400);
  }

  // ===== 快捷键 =====

  function handleKey(event) {
    if (!settings.subtitleEnabled || !video || !isWatchPage()) {
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }

    const target = event.target;
    if (target && (target.isContentEditable
      || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName || ""))) {
      return;
    }

    const key = event.key;
    let handled = true;

    // ←/→ 直接就是上一句/下一句的开头（覆盖播放器原本的 5/10 秒快进）
    if (key === "ArrowLeft" && !event.shiftKey) {
      prevUnit();
    } else if (key === "ArrowRight" && !event.shiftKey) {
      nextUnit();
    } else if (key === "a" || key === "A") {
      prevUnit();
    } else if (key === "d" || key === "D") {
      nextUnit();
    } else if (key === "s" || key === "S") {
      repeatUnit();
    } else if (key === "q" || key === "Q") {
      toggleAutoPause();
    } else if (key === "w" || key === "W") {
      toggleMerge();
    } else if (key === "[") {
      bumpFontSize(-2);
    } else if (key === "]") {
      bumpFontSize(2);
    } else if (event.shiftKey && key === "ArrowUp") {
      bumpBottom(2);
    } else if (event.shiftKey && key === "ArrowDown") {
      bumpBottom(-2);
    } else if (event.shiftKey && key === "ArrowLeft") {
      nudge(-5);   // 方向键被占了，细调留给 Shift+←/→
    } else if (event.shiftKey && key === "ArrowRight") {
      nudge(5);
    } else {
      handled = false;
    }

    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  // ===== 字幕层 =====

  function uiHost() {
    return document.fullscreenElement || document.body;
  }

  function mountOverlay() {
    const host = uiHost();
    if (!host) {
      return;
    }
    if (!overlay) {
      buildOverlay();
    }
    if (overlay.parentNode !== host) {
      host.appendChild(overlay);
    }
  }

  function buildOverlay() {
    overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    for (const type of ["mousedown", "click", "dblclick"]) {
      overlay.addEventListener(type, (e) => e.stopPropagation());
    }
    // 进字幕框就停、离开就续播（mouseenter/leave 不冒泡，挂在框上即可覆盖整块）
    overlay.addEventListener("mouseenter", handleOverlayEnter);
    overlay.addEventListener("mouseleave", handleOverlayLeave);
    applyStyle();
  }

  function handleOverlayEnter() {
    window.clearTimeout(leaveTimer);
    if (video && !video.paused) {
      video.pause();
      pausedByHover = true;
    }
    warmApi();
  }

  // 鼠标进字幕 = 马上就要查词了。这一下把 service worker 叫醒、
  // 顺便把到 DeepSeek 的 TLS 连接建好，真查的时候就省掉冷启动和握手。
  let lastWarmAt = 0;
  function warmApi() {
    if (Date.now() - lastWarmAt < WARM_INTERVAL_MS) {
      return;
    }
    lastWarmAt = Date.now();
    sendRuntimeMessage({ type: "WARM_API" }).catch(() => {});
  }

  function handleOverlayLeave() {
    window.clearTimeout(leaveTimer);
    leaveTimer = window.setTimeout(checkAwayFromSubtitle, 200);
  }

  // 鼠标可能是移到词典卡片上去了（要点收藏/重新分析），那就先别续播也别收卡片。
  function checkAwayFromSubtitle() {
    if (isHovered(document.getElementById("mlwa-card-root")) || isHovered(overlay)) {
      leaveTimer = window.setTimeout(checkAwayFromSubtitle, 200);
      return;
    }

    closeCard();
    if (pausedByHover && video && video.paused) {
      video.play().catch(() => {});
    }
    pausedByHover = false;
  }

  function isHovered(element) {
    return Boolean(element && element.isConnected && element.matches(":hover"));
  }

  function closeCard() {
    window.clearTimeout(closeTimer);
    hoverWord = "";
    if (window.__namaDict) {
      window.__namaDict.close();
    }
  }

  function applyStyle() {
    if (!overlay) {
      return;
    }
    overlay.style.fontSize = `${Number(settings.subtitleFontSize) || DEFAULTS.subtitleFontSize}px`;
    overlay.style.fontFamily = settings.subtitleFontFamily || "";
    overlay.classList.remove("nama-bd-shadow", "nama-bd-box", "nama-bd-none");
    const backdrop = ["shadow", "box", "none"].includes(settings.subtitleBackdrop)
      ? settings.subtitleBackdrop
      : "shadow";
    overlay.classList.add(`nama-bd-${backdrop}`);
    positionOverlay();
  }

  // 锚定 <video> 本身而不是原生字幕框：控制栏一出现播放器会把原生字幕往上顶，
  // 鼠标一停又落回去，跟着它走的话字幕会在鼠标底下反复跳，词根本选不中。
  function positionOverlay() {
    if (!overlay || !video) {
      return;
    }
    const rect = video.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return;
    }

    const pct = Math.min(45, Math.max(0, Number(settings.subtitleBottomPct) || 0));
    overlay.style.left = `${Math.round(rect.left + rect.width / 2)}px`;
    overlay.style.top = `${Math.round(rect.bottom - (rect.height * pct) / 100)}px`;
    overlay.style.maxWidth = `${Math.round(Math.max(240, rect.width * 0.9))}px`;
  }

  function teardown() {
    if (!overlay && !video) {
      return;
    }
    window.clearTimeout(leaveTimer);
    window.clearTimeout(closeTimer);
    window.clearTimeout(hoverTimer);
    pausedByHover = false;
    document.documentElement.classList.remove(ACTIVE_CLASS);
    if (overlay) {
      overlay.remove();
      overlay = null;
    }
    if (video) {
      video.removeEventListener("seeking", markSeek);
      video = null;
    }
    resetCues();
    resetTrack();
  }

  function renderLine(text) {
    if (!overlay || text === displayText) {
      return;
    }
    displayText = text;
    hoverWord = "";
    window.clearTimeout(hoverTimer);

    const flashTip = overlay.querySelector(".nama-sub-flash");
    overlay.replaceChildren();
    if (flashTip) {
      overlay.appendChild(flashTip);
    }

    for (const token of tokenize(text)) {
      if (!token.word) {
        overlay.appendChild(document.createTextNode(token.text));
        continue;
      }
      const span = document.createElement("span");
      span.className = "nama-sub-w";
      span.textContent = token.text;
      span.addEventListener("mouseenter", handleWordEnter);
      span.addEventListener("mouseleave", handleWordLeave);
      span.addEventListener("click", handleWordClick);
      overlay.appendChild(span);
    }
  }

  // 暂停由整个字幕框的 mouseenter 负责，这里只管查词
  function handleWordEnter(event) {
    const span = event.currentTarget;
    window.clearTimeout(hoverTimer);
    window.clearTimeout(closeTimer);
    hoverTimer = window.setTimeout(() => lookupSpan(span, false), HOVER_DELAY_MS);
  }

  // 离开这个词 → 收起卡片。留 260ms 是为了让鼠标能移到卡片上去点收藏。
  function handleWordLeave() {
    window.clearTimeout(hoverTimer);
    window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(closeIfNotOnCard, 260);
  }

  function closeIfNotOnCard() {
    if (isHovered(document.getElementById("mlwa-card-root"))) {
      closeTimer = window.setTimeout(closeIfNotOnCard, 260);
      return;
    }
    closeCard();
  }

  function handleWordClick(event) {
    event.stopPropagation();
    window.clearTimeout(hoverTimer);
    lookupSpan(event.currentTarget, true);
  }

  function lookupSpan(span, force) {
    const api = window.__namaDict;
    if (!api || !span.isConnected) {
      return;
    }

    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString().trim()) {
      return;
    }

    const word = (span.textContent || "").trim();
    if (!word || (!force && word === hoverWord)) {
      return;
    }

    hoverWord = word;
    api.lookup(word, contextText || displayText || word, span.getBoundingClientRect());
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

  // 拉丁/西里尔/阿拉伯等按空格与标点切词；汉字与假名逐字可查（词组请拖选）。
  const WORD_RE = /[\p{L}\p{M}\p{N}]+(?:['’‌‐-]?[\p{L}\p{M}\p{N}]+)*/gu;
  const CJK_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/u;

  function tokenize(text) {
    const tokens = [];
    let last = 0;
    let match;

    WORD_RE.lastIndex = 0;
    while ((match = WORD_RE.exec(text)) !== null) {
      if (match.index > last) {
        tokens.push({ word: false, text: text.slice(last, match.index) });
      }
      pushWord(tokens, match[0]);
      last = match.index + match[0].length;
    }
    if (last < text.length) {
      tokens.push({ word: false, text: text.slice(last) });
    }
    return tokens;
  }

  function pushWord(tokens, word) {
    if (!CJK_RE.test(word)) {
      tokens.push({ word: true, text: word });
      return;
    }
    for (const char of word) {
      tokens.push({ word: true, text: char });
    }
  }
})();

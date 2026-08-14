// Nama 字幕桥接：运行在**页面主世界**(manifest 里 "world": "MAIN")。
//
// 为什么需要它：内容脚本在隔离世界，读不到页面的 JS 变量和播放器对象，
// 而整条字幕轨的地址只存在于那些对象里。这里只负责「读出来 + postMessage 回去」，
// 不改播放器状态、不发请求。真正的下载在 background.js（绕 CORS + 域名白名单）。
(function () {
  const TAG = "nama-bridge";
  const SITE = /(^|\.)netflix\.com$/.test(location.hostname)
    ? "netflix"
    : (/(^|\.)youtube\.com$/.test(location.hostname) ? "youtube" : null);

  if (!SITE) {
    return;
  }

  function post(type, payload) {
    try {
      window.postMessage({ __nama: TAG, type, payload }, location.origin);
    } catch (error) {
      // 页面可能限制 postMessage，静默放弃，subtitle.js 会退回轮询模式
    }
  }

  // ===== Netflix：字幕轨只出现在播放清单的响应里，钩 JSON.parse 截下来 =====
  if (SITE === "netflix") {
    const nativeParse = JSON.parse;
    JSON.parse = function (text, reviver) {
      const data = nativeParse.call(this, text, reviver);
      try {
        scanForTracks(data, 0);
      } catch (error) {
        // 别让我们的问题弄坏 Netflix 自己的解析
      }
      return data;
    };
  }

  // 限深 + 限宽的浅扫，别在每次 JSON.parse 上做全量深搜（Netflix 一秒解析很多次）
  function scanForTracks(node, depth) {
    if (!node || typeof node !== "object" || depth > 4) {
      return;
    }

    if (Array.isArray(node.timedtexttracks) && node.timedtexttracks.length) {
      post("NETFLIX_TRACKS", {
        movieId: node.movieId || null,
        tracks: node.timedtexttracks
      });
      return;
    }

    if (Array.isArray(node)) {
      for (let i = 0; i < Math.min(node.length, 8); i += 1) {
        scanForTracks(node[i], depth + 1);
      }
      return;
    }

    for (const key of ["result", "results", "manifest", "manifests", "video", "data", "payload"]) {
      if (node[key]) {
        scanForTracks(node[key], depth + 1);
      }
    }
  }

  // 当前选的是哪条字幕轨（能读到就省掉后面的比对验证）
  function readNetflixActive() {
    try {
      const api = window.netflix.appContext.state.playerApp.getAPI();
      const player = api.videoPlayer;
      const sessionId = player.getAllPlayerSessionIds()[0];
      const track = player.getVideoPlayerBySessionId(sessionId).getTimedTextTrack();
      if (!track) {
        return null;
      }
      return {
        trackId: track.trackId || null,
        bcp47: track.bcp47 || null,
        language: track.language || null
      };
    } catch (error) {
      return null;
    }
  }

  // ===== YouTube：播放器对象里直接有整份 playerResponse =====
  function readYouTubeTracks() {
    const player = document.getElementById("movie_player");

    let response = null;
    try {
      response = player && player.getPlayerResponse ? player.getPlayerResponse() : null;
    } catch (error) {
      response = null;
    }
    if (!response) {
      response = window.ytInitialPlayerResponse || null;
    }

    const renderer = response
      && response.captions
      && response.captions.playerCaptionsTracklistRenderer;
    const list = (renderer && renderer.captionTracks) || [];

    let active = null;
    try {
      active = player && player.getOption ? player.getOption("captions", "track") : null;
    } catch (error) {
      active = null;
    }

    return {
      videoId: (response && response.videoDetails && response.videoDetails.videoId) || null,
      active: active && active.languageCode
        ? { languageCode: active.languageCode, kind: active.kind || "" }
        : null,
      tracks: list.map((track) => ({
        baseUrl: track.baseUrl,
        languageCode: track.languageCode || "",
        kind: track.kind || "",
        vssId: track.vssId || "",
        name: (track.name && (track.name.simpleText
          || (track.name.runs && track.name.runs[0] && track.name.runs[0].text))) || ""
      }))
    };
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) {
      return;
    }
    const data = event.data;
    if (!data || data.__nama !== `${TAG}-req` || data.type !== "REQUEST_TRACKS") {
      return;
    }

    if (SITE === "youtube") {
      post("YOUTUBE_TRACKS", readYouTubeTracks());
    } else {
      post("NETFLIX_ACTIVE", readNetflixActive());
    }
  });
})();

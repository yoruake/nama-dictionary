const API_KEY_STORAGE_KEY = "deepseekApiKey";

const elements = {};

document.addEventListener("DOMContentLoaded", async () => {
  bindElements();
  bindEvents();
  await loadSettings();
  await refreshCacheCount();
});

function bindElements() {
  elements.apiKey = document.getElementById("api-key");
  elements.toggleKey = document.getElementById("toggle-key");
  elements.saveKey = document.getElementById("save-key");
  elements.saveStatus = document.getElementById("save-status");
  elements.openVocabulary = document.getElementById("open-vocabulary");
  elements.highlightEnabled = document.getElementById("highlight-enabled");
  elements.cacheCount = document.getElementById("cache-count");
  elements.clearCache = document.getElementById("clear-cache");
  elements.testWord = document.getElementById("test-word");
  elements.testApi = document.getElementById("test-api");
  elements.testResult = document.getElementById("test-result");
}

function bindEvents() {
  elements.toggleKey.addEventListener("click", () => {
    const isPassword = elements.apiKey.type === "password";
    elements.apiKey.type = isPassword ? "text" : "password";
    elements.toggleKey.textContent = isPassword ? "隐藏" : "显示";
  });

  elements.saveKey.addEventListener("click", saveApiKey);
  elements.openVocabulary.addEventListener("click", openVocabulary);
  elements.highlightEnabled.addEventListener("change", saveHighlightEnabled);
  elements.clearCache.addEventListener("click", clearCache);
  elements.testApi.addEventListener("click", testApiKey);
}

async function loadSettings() {
  const result = await getStorage([
    API_KEY_STORAGE_KEY,
    "highlightEnabled"
  ]);

  elements.apiKey.value = result[API_KEY_STORAGE_KEY] || "";
  elements.highlightEnabled.checked = result.highlightEnabled === undefined
    ? true
    : Boolean(result.highlightEnabled);
}

async function saveHighlightEnabled() {
  await setStorage({ highlightEnabled: elements.highlightEnabled.checked });
  showSaveStatus(elements.highlightEnabled.checked ? "已开启页内高亮（刷新网页生效）" : "已关闭页内高亮（刷新网页生效）");
}

async function saveApiKey() {
  const apiKey = elements.apiKey.value.trim();
  await setStorage({ [API_KEY_STORAGE_KEY]: apiKey });
  showSaveStatus(apiKey ? "已保存" : "已清空");
}

async function refreshCacheCount() {
  const response = await sendRuntimeMessage({ type: "GET_CACHE_STATS" });
  elements.cacheCount.textContent = String(response?.count || 0);
}

async function clearCache() {
  const confirmed = window.confirm("确定清空未收藏的本地查词缓存吗？生词本中的记录会保留。");
  if (!confirmed) {
    return;
  }

  await sendRuntimeMessage({ type: "CLEAR_CACHE" });
  await refreshCacheCount();
  showSaveStatus("缓存已清空");
}

function openVocabulary() {
  window.open(chrome.runtime.getURL("vocabulary.html"), "_blank", "noopener");
}

async function testApiKey() {
  const apiKey = elements.apiKey.value.trim();
  const word = elements.testWord.value.trim() || "سلام";

  if (!apiKey) {
    showTestResult("请先输入 DeepSeek API Key。", true);
    return;
  }

  elements.testApi.disabled = true;
  showTestResult("测试中...", false);

  try {
    const response = await sendRuntimeMessage({
      type: "TEST_API_KEY",
      apiKey,
      word,
      sentence: `这是一个API测试句，测试词是：${word}`
    });

    if (!response?.ok) {
      showTestResult(response?.error?.message || "测试失败", true);
      return;
    }

    showTestResult(
      `测试成功。\n\n${JSON.stringify(response.data, null, 2)}`,
      false
    );
  } catch (error) {
    showTestResult(error.message || "扩展通信失败", true);
  } finally {
    elements.testApi.disabled = false;
  }
}

function showSaveStatus(message) {
  elements.saveStatus.textContent = message;
  window.clearTimeout(showSaveStatus.timer);
  showSaveStatus.timer = window.setTimeout(() => {
    elements.saveStatus.textContent = "";
  }, 2400);
}

function showTestResult(message, isError) {
  elements.testResult.textContent = message;
  elements.testResult.classList.toggle("is-error", Boolean(isError));
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

const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", async () => {
  const { deepseekApiKey = "", highlightEnabled = true } =
    await chrome.storage.local.get(["deepseekApiKey", "highlightEnabled"]);
  $("api-key").value = deepseekApiKey;
  $("highlight-enabled").checked = highlightEnabled;
  refreshCacheCount();

  $("toggle-key").onclick = () => {
    const hidden = $("api-key").type === "password";
    $("api-key").type = hidden ? "text" : "password";
    $("toggle-key").textContent = hidden ? "隐藏" : "显示";
  };
  $("save-key").onclick = async () => {
    const apiKey = $("api-key").value.trim();
    await chrome.storage.local.set({ deepseekApiKey: apiKey });
    flash(apiKey ? "已保存" : "已清空");
  };
  $("open-vocabulary").onclick = () => window.open(chrome.runtime.getURL("vocabulary.html"), "_blank", "noopener");
  $("highlight-enabled").onchange = async () => {
    const on = $("highlight-enabled").checked;
    await chrome.storage.local.set({ highlightEnabled: on });
    flash(`已${on ? "开启" : "关闭"}页内高亮（刷新网页生效）`);
  };
  $("clear-cache").onclick = async () => {
    if (!confirm("确定清空未收藏的本地查词缓存吗？生词本中的记录会保留。")) return;
    await chrome.runtime.sendMessage({ type: "CLEAR" });
    refreshCacheCount();
    flash("缓存已清空");
  };
  $("test-api").onclick = testApiKey;
});

async function refreshCacheCount() {
  const all = await chrome.storage.local.get(null);
  const entries = all.entries || Object.keys(all).filter((k) => k.startsWith("w:")).flatMap((k) => all[k]);
  $("cache-count").textContent = entries.length;
}

async function testApiKey() {
  const apiKey = $("api-key").value.trim();
  if (!apiKey) return showTest("请先输入 DeepSeek API Key。", true);
  $("test-api").disabled = true;
  showTest("测试中...");
  const res = await chrome.runtime.sendMessage({ type: "TEST_KEY", apiKey, word: $("test-word").value.trim() || "سلام" })
    .catch((e) => ({ error: { message: e.message } }));
  showTest(res?.ok ? `测试成功。\n\n${JSON.stringify(res.data, null, 2)}` : res?.error?.message || "测试失败", !res?.ok);
  $("test-api").disabled = false;
}

function showTest(message, isError = false) {
  $("test-result").textContent = message;
  $("test-result").classList.toggle("is-error", isError);
}

function flash(message) {
  $("save-status").textContent = message;
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => ($("save-status").textContent = ""), 2400);
}

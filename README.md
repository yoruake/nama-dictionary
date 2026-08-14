# 多语言查词助手

一个 Manifest V3 Chrome 扩展。选中网页上的外语单词后，扩展会调用 DeepSeek API，返回 IPA 国际音标发音、词源、中文词义，以及该词在句中的形态与句法作用。选中长度不限，单词、词组、整句皆可查询。当前主要面向波斯语、俄语，也可用于其他语言。

## 安装

1. 打开 Chrome，进入 `chrome://extensions`
2. 开启右上角“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择本项目目录
5. 如已打开目标网页，请刷新页面后再使用

## 配置 API Key

1. 点击浏览器工具栏中的扩展图标，打开设置页
2. 在 `DeepSeek API Key` 输入框中填入你自己的 Key
3. 点击“保存”
4. 可使用“测试连接”按钮验证 Key 是否可用

API Key 会保存到 Chrome 扩展的 `chrome.storage.local` 中。本项目不会把 Key 写入代码文件，也不会上传到任何自建服务器。

## 使用

在网页中用鼠标选中 1-2 个外语词，扩展会自动在选区附近显示查词卡片。卡片中可以点击星标，把记录加入生词本。

设置页中的“打开生词本”可以查看已收藏词条，并导出 Anki 可导入的 CSV 文件。

## 隐私说明

- 你的 DeepSeek API Key 只保存在本机 Chrome 的扩展本地存储中。
- 扩展不会把 API Key 上传到任何第三方服务器，除了在调用 DeepSeek API 时作为请求认证头发送给 DeepSeek。
- 查词时会把你选中的词和自动提取的上下文句子发送给 DeepSeek，用于生成分析结果。
- 查词记录、生词本和缓存都保存在本地 `chrome.storage.local` 中。
- 本项目没有远程统计、埋点或自建后端。

## 权限说明

- `storage`：保存 API Key、查词缓存和生词本。
- `activeTab`：保留最小浏览器标签权限。
- `https://api.deepseek.com/*`：允许后台 service worker 调用 DeepSeek API。
- `<all_urls>` content script：用于在网页中监听选词并显示浮动查词卡片。

## Anki 导出

在生词本页面点击“导出CSV”，选择导出范围后会下载 `vocabulary_YYYY-MM-DD.csv`。导入 Anki 时建议：

1. 打开 Anki 桌面版
2. 文件 -> 导入 -> 选择该 CSV
3. Note Type 选“基础”
4. 字段映射：第 1 列 -> 正面，第 2 列 -> 背面，第 3 列 -> 标签
5. 点击导入

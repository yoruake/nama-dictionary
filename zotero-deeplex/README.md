# DeepLex PDF 查词（Zotero 7/9 插件）

在 Zotero 内置 PDF / EPUB 阅读器里选中外语单词（或词组、整句，**长度不限**），
自动调用 DeepSeek，返回 **IPA 国际音标发音 / 词源 / 中文词义 / 句中作用**，
**流式**显示在文字选择弹窗里（边生成边填）。结果带本地缓存，重复查词不再扣费。

支持 **⭐收藏到生词本**，并提供生词本窗口：搜索 / 按语言筛选 / 排序 / 展开详情 /
删除 / **导出 CSV 给 Anki**。

> 仅供个人使用，无需上架商店，无需签名。

## 文件结构

```
zotero-deeplex/
├── manifest.json   插件清单
├── bootstrap.js    启动入口
├── deeplex.js      查词逻辑 + 流式弹窗卡片 + 词条数据 + 菜单
├── notebook.xhtml  生词本窗口（界面）
└── notebook.js     生词本逻辑（搜索/筛选/导出 Anki CSV）
```

## 打包成 .xpi

`.xpi` 就是个 zip，**注意要把三个文件放在压缩包根目录**（不要套一层文件夹）。

在本目录下用 PowerShell：

```powershell
Compress-Archive -Path manifest.json,bootstrap.js,deeplex.js -DestinationPath deeplex.zip -Force
Rename-Item deeplex.zip deeplex.xpi
```

## 安装

1. 打开 Zotero 7 → 菜单 **工具(Tools) ▸ 插件(Add-ons)**。
2. 右上角齿轮 ⚙ → **Install Add-on From File…** → 选择 `deeplex.xpi`。
3. 安装后无需重启。

## 配置 API Key

菜单 **工具(Tools) ▸ “DeepLex: 设置 DeepSeek API Key”** → 粘贴你的 DeepSeek Key → 确定。
（Key 保存在 Zotero 偏好 `extensions.deeplex.apiKey`，留空可清除。）

## 使用

- **查词**：打开 PDF/EPUB → **选中单词** → 工具条下方出现 DeepLex 卡片，
  文字流式生成（IPA / 词义 / 词源 / 句中作用逐项填入）。
- **收藏**：卡片底部点 **☆ 收藏到生词本**。
- **生词本**：菜单 **工具(Tools) ▸ “DeepLex: 打开生词本”** → 搜索 / 按语言筛选 /
  排序 / 点条目展开详情 / 删除 / 导出 CSV。
- **导出 Anki**：生词本里点“导出 CSV (Anki)”，文件存到**桌面**并自动定位；
  在 Anki 中 文件 → 导入 → 选该 CSV，Note Type 选“基础”，字段 1→正面、2→背面、3→标签。

## 调试

菜单 **帮助(Help) ▸ 调试日志 ▸ 查看输出**，日志里搜 `[DeepLex]` 可看到错误信息。

## 数据存储

- API Key：偏好 `extensions.deeplex.apiKey`
- 词条（含收藏）：偏好 `extensions.deeplex.entries`（JSON 数组，最多 1000 条，
  收藏的永久保留，未收藏的超量时淘汰最旧的）

## 已知差异

- **上下文**：浏览器版会自动抓取整句作为上下文；阅读器里目前直接用你选中的文本。
  想要更准的“句中作用”，可以连同前后文一起选中。
- **流式**：若 Zotero 的网络层对响应做了缓冲，可能看不到逐字生成、而是一次性出现，
  功能不受影响。

# Nama · PDF 查词（Zotero 7 / 9 插件）

在 Zotero 内置的 PDF / EPUB 阅读器里选中外语单词（或词组、整句，**长度不限**），
调用 DeepSeek 返回 **发音注音 / 词源 / 中文词义 / 句中作用**，显示在文字选择弹窗里。
支持 ⭐ 收藏进生词本，以及导出 Anki CSV。

设计理念、注音规则等见[仓库根目录的 README](../README.md)。当前版本 **1.6.0**。

> 目录名 `zotero-deeplex/` 和文件名 `deeplex.js` / `deeplex.xpi` 是更名前的旧名，
> 保留只是为了不打乱打包脚本，插件本身叫 Nama。

## 文件结构

```
zotero-deeplex/
├── manifest.json   插件清单（Zotero 用 manifest_version 2）
├── bootstrap.js    启动入口
├── deeplex.js      全部逻辑：查词、弹窗卡片、词条存储、菜单、生词本
├── icon48.png / icon96.png
└── deeplex.xpi     打包产物
```

生词本没有独立的 XHTML 文件——**独立 HTML 窗口在 Zotero 里加载不出来**，
现在的做法是打开 `about:blank` 后由主模块往里建 DOM。

## 安装

1. Zotero → **工具(Tools) ▸ 插件(Add-ons)**
2. 右上角齿轮 ⚙ → **Install Add-on From File…** → 选 `deeplex.xpi`
3. 无需重启

> **从 DeepLex 升级**：插件 id 已从 `deeplex-pdf@deeplex.app` 换成 `nama-pdf@nama.app`，
> Zotero 会当成一个新插件，**旧的「DeepLex」需要手动删除**。
> 偏好键也从 `extensions.deeplex.*` 换到了 `extensions.nama.*`，
> 首次启动时会自动做一次性迁移，生词本和 API Key 不会丢。

## 配置 API Key

**工具(Tools) ▸ 「Nama: 设置 DeepSeek API Key」** → 粘贴 Key → 确定。留空即清除。

## 使用

- **查词**：打开 PDF / EPUB，选中文字，工具条下方出现卡片。
  上下文取选区所在段落（限 400 字符），比浏览器版的整句更宽一些。
- **收藏**：卡片底部点 ☆。
- **生词本**：工具(Tools) ▸ 「Nama: 打开生词本」。搜索 / 按语言筛选 / 时间筛选 /
  导出状态筛选 / 排序 / 展开详情 / 多选批量删除。
  筛选用的是 chip 按钮而不是下拉框——原生 `<select>` 在 Zotero 的 chrome 窗口下拉打不开。
- **导出 Anki**：点「导出 CSV (Anki)」，**所见即所导**（跟随当前筛选），文件存到桌面并自动定位。
  在 Anki 中 文件 → 导入 → 选该 CSV，Note Type 选「基础」，字段 1→正面、2→背面、3→标签，
  重复项处理选「保留(Preserve)」。

## 打包成 .xpi

`.xpi` 就是个 zip，**三个文件必须在压缩包根目录**，不要多套一层文件夹。在本目录下：

```powershell
Compress-Archive -Path manifest.json,bootstrap.js,deeplex.js -DestinationPath deeplex.zip -Force
Move-Item deeplex.zip deeplex.xpi -Force
```

改版本号时注意两件事：

- **`manifest.json` 必须 UTF-8 无 BOM**。PowerShell 的 `Set-Content -Encoding utf8` 会写进 BOM，
  Zotero 会直接判定清单无效。确认首字节是 `{`（123）。
- Zotero 9 要求 `applications.zotero` 下四项齐全：`id`（带点的域名形式）、`update_url`、
  `strict_min_version`、`strict_max_version`，缺一个就报「不兼容」。

## 调试

**帮助(Help) ▸ 调试日志 ▸ 查看输出**，日志里搜 `[Nama]`。

## 数据存储

| 偏好键 | 内容 |
|---|---|
| `extensions.nama.apiKey` | DeepSeek API Key |
| `extensions.nama.entries` | 词条（含收藏），JSON 数组，最多 1000 条；收藏的永久保留，未收藏的超量时淘汰最旧的 |

均用 `Zotero.Prefs.get/set(key, true)` 读写。

## 与浏览器版的差异

- **非流式**：Zotero 沙箱里没有 `fetch` / `AbortController`，走的是 `Zotero.HTTP.request`
  一次性取回结果，卡片不会逐字长出来。
- 没有页内高亮，也没有视频字幕模式——那两个都是浏览器专属的。

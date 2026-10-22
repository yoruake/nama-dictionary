// 卡片上「正文语言」下拉的选项：中文名 → kaikki.org（Wiktionary 数据）里的语言名。
// null = 不查词典 IPA（这些语言注音用拼音 / 罗马字 / IAST）。加语言只改这里。
const LANGS = {
  中文: null, 日语: null, 韩语: null,
  英语: "English", 法语: "French", 德语: "German",
  俄语: "Russian", 乌克兰语: "Ukrainian",
  波斯语: "Persian", 达利语: "Persian", 塔吉克语: "Tajik",
  阿拉伯语: "Arabic", 乌尔都语: "Urdu",
  土耳其语: "Turkish", 阿塞拜疆语: "Azerbaijani", 乌兹别克语: "Uzbek", 哈萨克语: "Kazakh",
  印地语: null, 梵语: null
};

const langKey = (lang) => Object.keys(LANGS).find((k) => String(lang || "").startsWith(k)) || "";

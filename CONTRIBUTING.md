# Contributing

目前主要维护 macOS。欢迎提交问题、兼容性修复和聚焦的小改动。

User documentation: [简体中文](README.md) · [English](README.en.md). The project primarily targets macOS; focused fixes and compatibility reports are welcome.

## 开发验证

需要 Node.js 24+、curl 8.7+、OpenSSL，以及本机回环端口监听权限。项目没有第三方 npm 运行依赖。

```sh
npm run check
npm test
```

测试只使用内存数据库、临时文件和本地 HTTPS/代理服务，不要求真实 Codex 账号，也不访问公网。

## 约定

- Codex 数据库、配置、会话文件保持只读；不要读取登录凭据。
- 缺失数据保留未知；查询失败不能伪装成零或健康。
- 新指标说明数据来源、单位、时间窗和采集时间；累计 token 差分不是生成速度。
- 网络探针必须有超时、缓存、并发上限和退出取消；保留 TLS 验证及代理失败状态。
- 为真正的边界和回归补测试，不依赖本机账号数据、外网或真实代理凭据。
- 提交截图和日志前，移除会话内容、标题、账号信息、路径、IP 与代理认证信息。

## Translations / 界面翻译

Built-in interface messages are kept in `locales/options.mjs`, `locales/status.mjs`, `locales/dashboard.mjs`, and `locales/resource.mjs`. The catalogs expose entries mapping a stable key to all four supported languages:

```js
example: {
  'zh-CN': '已采集 {count} 项',
  'zh-TW': '已採集 {count} 項',
  en: 'Collected {count} items',
  ja: '{count} 件を取得',
},
```

Use the catalog's existing structure and `createTranslator` rather than replacing arbitrary text in the completed screen. `dashboard.mjs` builds its catalog from compact entry arrays; preserve that format when editing existing messages. Prefer descriptive semantic keys for new messages. Keep exactly the same placeholder names in every translation, and supply values separately so chat text, paths, commands, tool names, raw logs, and collected data are never translated accidentally.

To add a language:

1. Add its canonical tag to `SUPPORTED_LOCALES` and its display name to `LOCALE_NAMES` in `i18n.mjs`. Extend `normalizeLocale` with the intended system-tag aliases; preserve documented automatic-detection precedence and the English fallback.
2. Add a translation for every message in all four catalogs. Do not rely on fallback text to make a partial language appear complete.
3. Extend the locale and option tests, then check help, argument errors, all four pages, and both narrow and wide terminal layouts. Preserve ANSI handling and display-cell width, including CJK characters.
4. Update the language lists and CLI examples in both READMEs. JSON field names and raw values must remain compatible across languages.

界面翻译只作用于内置文字，不能改写用户内容或采集结果。新增语言时需要补全全部词条、占位符、系统语言识别、参数测试和窄屏布局验证，再更新中英文文档。

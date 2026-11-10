# Contributing

项目包含 macOS、Linux、Windows 的采集后端。欢迎提交问题、兼容性修复和聚焦的小改动；报告平台问题时请附操作系统、Node.js/curl 版本，以及已脱敏的不可用指标说明。

User documentation: [简体中文](README.md) · [繁體中文](README.zh-TW.md) · [English](README.en.md) · [日本語](README.ja.md). The project includes macOS, Linux, and Windows sampling backends. Distinguish fixture coverage from native execution when reporting compatibility.

## 开发验证

需要 Node.js 24+、curl 8.7+、OpenSSL，以及本机回环端口监听权限。项目没有第三方 npm 运行依赖。

macOS 使用系统工具；Linux 主要使用 `/proc`、`/sys`、`ps`，路由查询可使用 `ip`；Windows 使用 Windows PowerShell 5.1/CIM 和 `curl.exe`。Windows PowerShell 可通过 `npm.cmd run check`、`npm.cmd test` 避免 `.ps1` 包装脚本的执行策略问题。

```sh
npm run check
npm test
```

测试只使用内存数据库、临时文件和本地 HTTPS/代理服务，不要求真实 Codex 账号，也不访问公网。

CI 矩阵覆盖 macOS、Linux、Windows 与 Node.js 24/26。当前实际验证包括 macOS 上的 Node.js 24/26，以及 Linux arm64 Docker 容器（官方 `node:24-trixie-slim`、Node.js 24.22.2、curl 8.14.1）的测试与语法检查；Linux 容器仅跳过 Darwin `top` 专用测试，不等同于原生 Linux 宿主机验证。Windows 目前通过解析与命令 fixture 测试，原生 Windows 实机仍未验证。

注入的跨平台解析 fixture 不等于原生系统执行；提交中应分别说明本机实际检查、容器验证、fixture 结果和已完成的 CI 作业。POSIX 信号、系统工具或平台专属提供者的测试只能在适用的平台断言其行为，不能用静默跳过掩盖核心采集缺口。

## 约定

- Codex 数据库、配置、会话文件保持只读；不要读取登录凭据。
- 缺失数据保留未知；查询失败不能伪装成零或健康。
- 新指标说明数据来源、单位、时间窗和采集时间；累计 token 差分不是生成速度。
- 网络探针必须有超时、缓存、并发上限和退出取消；保留 TLS 验证及代理失败状态。
- 平台采集保持接口与单位一致；首次差分、计数重置、缺少工具/提供者或权限不足时保留未知。Windows 不得伪造 Unix load average，Linux 不得凭空假定全局代理关闭。
- MCP 清单只报告安全的配置元数据，不把配置数量当作运行进程数；不要输出认证头、环境变量值、凭据或完整命令参数。Skill 清单使用有界、去重的扫描，插件缓存目录不能单独作为安装或启用证据。
- 运行任务页保持主任务/子代理关系、陈旧记录和不完整覆盖的区分；显示条数不能改变统计口径，缺失父节点与循环关系不能补造。
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
3. Extend the locale and option tests, then check help, argument errors, all six pages, and both narrow and wide terminal layouts. Preserve ANSI handling and display-cell width, including CJK characters.
4. Update the language lists and CLI examples in all translated READMEs. JSON field names and raw values must remain compatible across languages.

界面翻译只作用于内置文字，不能改写用户内容或采集结果。新增语言时需要补全全部词条、占位符、系统语言识别、参数测试和窄屏布局验证，再更新各语言文档。

## Public previews / 公开预览

`npm run demo` rebuilds four localized SVG previews from deterministic synthetic data only. Preview-only text lives in `locales/demo.mjs`; it does not translate or alter runtime collector data. Chat names, models, paths, messages, and network addresses are replaced before layout and text-node generation. Never place an opaque rectangle over raw SVG text while retaining the original value underneath. Run `node --test demo.test.mjs` to check language, determinism, and redaction in the text layer and metadata.

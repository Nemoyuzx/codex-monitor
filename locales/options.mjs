export const optionsCatalog = {
  'view.overview': { 'zh-CN': '总览', 'zh-TW': '總覽', en: 'Overview', ja: '概要' },
  'view.host': { 'zh-CN': '主机', 'zh-TW': '主機', en: 'Host', ja: 'ホスト' },
  'view.tasks': { 'zh-CN': '任务', 'zh-TW': '任務', en: 'Tasks', ja: 'タスク' },
  'view.diagnostics': { 'zh-CN': '诊断', 'zh-TW': '診斷', en: 'Diagnostics', ja: '診断' },
  'error.missing': {
    'zh-CN': '{flag} 缺少参数', 'zh-TW': '{flag} 缺少參數',
    en: '{flag} requires a value', ja: '{flag} には値が必要です',
  },
  'error.unknown': {
    'zh-CN': '未知参数：{flag}', 'zh-TW': '未知參數：{flag}',
    en: 'Unknown option: {flag}', ja: '不明なオプション: {flag}',
  },
  'error.range': {
    'zh-CN': '{field} 需为 {min}–{max} 的整数', 'zh-TW': '{field} 需為 {min}–{max} 的整數',
    en: '{field} must be an integer from {min} to {max}', ja: '{field} は {min}〜{max} の整数で指定してください',
  },
  'error.view': {
    'zh-CN': '--view 可选 overview、host、tasks、diagnostics',
    'zh-TW': '--view 可選 overview、host、tasks、diagnostics',
    en: '--view must be one of overview, host, tasks, diagnostics',
    ja: '--view は overview、host、tasks、diagnostics のいずれかを指定してください',
  },
  'error.language': {
    'zh-CN': '不支持的语言：{value}。可选 auto、zh-CN、zh-TW、en、ja',
    'zh-TW': '不支援的語言：{value}。可選 auto、zh-CN、zh-TW、en、ja',
    en: 'Unsupported language: {value}. Supported: auto, zh-CN, zh-TW, en, ja',
    ja: '未対応の言語: {value}。指定可能: auto、zh-CN、zh-TW、en、ja',
  },
};

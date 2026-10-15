// Renderer-owned text only. Metric labels and source data are supplied by the
// dashboard model and must never be translated by matching displayed values.
export default {
  title: { 'zh-CN': '资源监视', 'zh-TW': '資源監視', en: 'Resources', ja: 'リソース監視' },
  recent: { 'zh-CN': '最近 {duration}', 'zh-TW': '最近 {duration}', en: 'Last {duration}', ja: '直近 {duration}' },
  now: { 'zh-CN': '现在', 'zh-TW': '現在', en: 'now', ja: '現在' },
  folded: {
    'zh-CN': '… 已折叠部分内容，拉高窗口可看全 …',
    'zh-TW': '… 已摺疊部分內容，拉高視窗可看完整內容 …',
    en: '… Some content hidden; increase window height …',
    ja: '… 一部を省略。ウィンドウを縦に広げて表示 …',
  },
  hiddenCharts: { 'zh-CN': '{count} 图', 'zh-TW': '{count} 圖', en: '{count} charts', ja: '{count} グラフ' },
  hiddenChart: { 'zh-CN': '{count} 图', 'zh-TW': '{count} 圖', en: '{count} chart', ja: '{count} グラフ' },
  hiddenRows: { 'zh-CN': '{count} 行', 'zh-TW': '{count} 列', en: '{count} rows', ja: '{count} 行' },
  hiddenRow: { 'zh-CN': '{count} 行', 'zh-TW': '{count} 列', en: '{count} row', ja: '{count} 行' },
  listSeparator: { 'zh-CN': '、', 'zh-TW': '、', en: ', ', ja: '、' },
  hidden: { 'zh-CN': '… 已隐藏 {items}', 'zh-TW': '… 已隱藏 {items}', en: '… Hidden: {items}', ja: '… 省略: {items}' },
  hiddenHint: {
    'zh-CN': '{notice} · 拉高窗口或切换视图',
    'zh-TW': '{notice} · 拉高視窗或切換檢視',
    en: '{notice} · Increase height or switch views',
    ja: '{notice} · 縦に広げるか表示を切替',
  },
  trendsHint: {
    'zh-CN': '拉高窗口查看完整趋势',
    'zh-TW': '拉高視窗查看完整趨勢',
    en: 'Increase height for full trends',
    ja: '縦に広げて推移をすべて表示',
  },
  legend: { 'zh-CN': 'CPU / 内存  ', 'zh-TW': 'CPU / 記憶體  ', en: 'CPU / Memory  ', ja: 'CPU / メモリ  ' },
  low: { 'zh-CN': '低', 'zh-TW': '低', en: 'low', ja: '低' },
  medium: { 'zh-CN': '中', 'zh-TW': '中', en: 'medium', ja: '中' },
  high: { 'zh-CN': '高', 'zh-TW': '高', en: 'high', ja: '高' },
};

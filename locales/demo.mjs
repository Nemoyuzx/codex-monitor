// Public-preview text only; no private values belong in this catalog.
const entries = [
  [
    "badge",
    "DEMO · 模拟数据",
    "DEMO · 模擬資料",
    "DEMO · synthetic data",
    "DEMO · 合成データ"
  ],
  [
    "source",
    "数据源",
    "資料來源",
    "Data source",
    "データソース"
  ],
  [
    "model",
    "模型",
    "模型",
    "Model",
    "モデル"
  ],
  [
    "summary",
    "只读监控 · 1s 刷新 · 80s 趋势窗口",
    "唯讀監控 · 1s 更新 · 80s 趨勢視窗",
    "Read-only · 1s refresh · 80s history",
    "読み取り専用 · 1秒更新 · 80秒履歴"
  ],
  [
    "status",
    "状态  演示运行中 · 1 个示例任务 · 工具执行中 0 · 队列 0",
    "狀態  示範執行中 · 1 個範例任務 · 工具執行中 0 · 佇列 0",
    "Status  Demo running · 1 sample task · 0 tools running · queue 0",
    "状態  デモ実行中 · サンプルタスク 1件 · 実行中ツール 0件 · 待機 0件"
  ],
  [
    "host",
    "主机状态（模拟）",
    "主機狀態（模擬）",
    "Host status (DEMO)",
    "ホスト状態（デモ）"
  ],
  [
    "hostName",
    "主机",
    "主機",
    "Host",
    "ホスト"
  ],
  [
    "device",
    "12 核 · 24 GB",
    "12 核心 · 24 GB",
    "12 cores · 24 GB",
    "12コア · 24 GB"
  ],
  [
    "cpuValue",
    "全机 30% · Codex 多核 56%",
    "整機 30% · Codex 多核心 56%",
    "Host 30% · Codex multicore 56%",
    "全体 30% · Codex マルチコア 56%"
  ],
  [
    "memory",
    "内存",
    "記憶體",
    "Memory",
    "メモリ"
  ],
  [
    "memoryValue",
    "物理已用 15 GB / 24 GB",
    "實體已用 15 GB / 24 GB",
    "Physical used 15 GB / 24 GB",
    "物理使用量 15 GB / 24 GB"
  ],
  [
    "interface",
    "网络接口",
    "網路介面",
    "Interface",
    "インターフェース"
  ],
  [
    "sampling",
    "采样",
    "取樣",
    "Sampling",
    "サンプリング"
  ],
  [
    "samplingValue",
    "合成趋势 · 80 个样本",
    "合成趨勢 · 80 個樣本",
    "Synthetic trend · 80 samples",
    "合成トレンド · 80サンプル"
  ],
  [
    "eventTitle",
    "最近可见事件（模拟）",
    "最近可見事件（模擬）",
    "Latest visible event (DEMO)",
    "最近のイベント（デモ）"
  ],
  [
    "chat",
    "会话",
    "對話",
    "Chat",
    "チャット"
  ],
  [
    "type",
    "类型",
    "類型",
    "Type",
    "種類"
  ],
  [
    "done",
    "工具完成",
    "工具完成",
    "Tool completed",
    "ツール完了"
  ],
  [
    "content",
    "内容",
    "內容",
    "Content",
    "内容"
  ],
  [
    "contentValue",
    "演示工具已完成，消息内容已遮挡",
    "示範工具已完成，訊息內容已遮蔽",
    "Demo tool completed; message content redacted",
    "デモツール完了。メッセージ本文はマスク済み"
  ],
  [
    "age",
    "距现在",
    "距現在",
    "Age",
    "経過時間"
  ],
  [
    "ageValue",
    "2 秒前",
    "2 秒前",
    "2 seconds ago",
    "2秒前"
  ],
  [
    "eventDone",
    "  2 秒前  工具完成    {mask}",
    "  2 秒前  工具完成    {mask}",
    "  2s ago  Tool done      {mask}",
    "  2秒前  ツール完了  {mask}"
  ],
  [
    "eventActive",
    "  8 秒前  任务活动    {mask}",
    "  8 秒前  任務活動    {mask}",
    "  8s ago  Task activity  {mask}",
    "  8秒前  タスク動作  {mask}"
  ],
  [
    "eventUpdate",
    " 18 秒前  任务更新    {mask}",
    " 18 秒前  任務更新    {mask}",
    " 18s ago  Task update    {mask}",
    " 18秒前  タスク更新  {mask}"
  ],
  [
    "networkTitle",
    "IP · 路由 · 代理（模拟）",
    "IP · 路由 · 代理（模擬）",
    "IP · Routes · Proxies (DEMO)",
    "IP · ルート · プロキシ（デモ）"
  ],
  [
    "probeMock",
    "DEMO · 模拟结果，敏感字段已遮挡",
    "DEMO · 模擬結果，敏感欄位已遮蔽",
    "DEMO · simulated results; sensitive fields redacted",
    "DEMO · 合成結果。機微な項目はマスク済み"
  ],
  [
    "noteTitle",
    "预览说明",
    "預覽說明",
    "Preview notes",
    "プレビューの説明"
  ],
  [
    "note1",
    "所有数值均为合成示例，不代表真实设备性能。",
    "所有數值均為合成範例，不代表真實裝置效能。",
    "All values are synthetic, not real device performance.",
    "数値はすべて合成例で、実機の性能を示しません。"
  ],
  [
    "note2",
    "公网出口、代理状态与延迟均非实测。",
    "公網出口、代理狀態與延遲均非實測。",
    "Egress, proxy status and latency were not measured.",
    "公開IP、プロキシ状態、遅延は実測ではありません。"
  ],
  [
    "note3",
    "会话、模型、路径与网络地址已遮挡，源码不保留原值。",
    "對話、模型、路徑與網路位址已遮蔽，原始碼不保留原值。",
    "Chats, models, paths and addresses are redacted in SVG source.",
    "会話名、モデル、パス、アドレスはSVGソースにも残しません。"
  ],
  [
    "keyboard",
    " [1 总览]   2 主机   3 任务   4 诊断   ·   Space 暂停   ↑↓ 滚动   [ ] 时间窗口   r 刷新   h 帮助   q 退出",
    " [1 總覽]   2 主機   3 任務   4 診斷   ·   Space 暫停   ↑↓ 捲動   [ ] 時間視窗   r 更新   h 說明   q 離開",
    " [1 Overview]   2 Host   3 Tasks   4 Diagnostics   ·   Space pause   ↑↓ scroll   [ ] time window   r refresh   h help   q quit",
    " [1 概要]   2 ホスト   3 タスク   4 診断   ·   Space 一時停止   ↑↓ スクロール   [ ] 時間幅   r 更新   h ヘルプ   q 終了"
  ],
  [
    "footer",
    " DEMO · 合成数据 · 敏感字段已遮挡 · 无真实日志、IP、会话或性能测量。",
    " DEMO · 合成資料 · 敏感欄位已遮蔽 · 無真實日誌、IP、對話或效能測量。",
    " DEMO · Synthetic data · Sensitive fields redacted · No real logs, IPs, chats or performance measurements.",
    " DEMO · 合成データ · 機微な項目はマスク済み · 実際のログ、IP、会話、性能測定は含みません。"
  ],
  [
    "svgTitle",
    "Codex Monitor — 合成 DEMO · 已打码",
    "Codex Monitor — 合成 DEMO · 已遮蔽",
    "Codex Monitor — Synthetic DEMO · Redacted",
    "Codex Monitor — 合成 DEMO · マスク済み"
  ],
  [
    "svgDescription",
    "251×72 终端预览，左侧双栏、右侧八个趋势图与逐核状态。数据全部为合成演示，非实测。会话、模型、路径、IP、网关、DNS、代理地址与消息已在渲染前遮挡，SVG 不保留原值。",
    "251×72 終端機預覽，左側雙欄、右側八個趨勢圖與逐核狀態。資料全部為合成示範，非實測。對話、模型、路徑、IP、閘道、DNS、代理位址與訊息在繪製前已遮蔽，SVG 不保留原值。",
    "251×72 terminal preview with two information columns, eight resource charts and per-core status. All data is synthetic, not measured. Chat names, models, paths, IPs, gateways, DNS, proxy endpoints and message text are redacted before rendering; original values are absent from SVG.",
    "251×72の端末プレビュー。左側は情報2列、右側は8個のグラフとコア別状態です。すべて合成データで実測ではありません。会話名、モデル、パス、IP、ゲートウェイ、DNS、プロキシ、本文は描画前にマスクし、SVGには元の値を残しません。"
  ]
];

export const demoCatalog = Object.freeze(Object.fromEntries(entries.map(([key, zh, traditional, en, ja]) =>
  [key, Object.freeze({ 'zh-CN': zh, 'zh-TW': traditional, en, ja })])));


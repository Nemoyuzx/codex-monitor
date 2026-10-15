#!/usr/bin/env node
// codex-status.mjs — 只读地读取本地 Codex (ChatGPT.app 桌面版 / Codex CLI) 的整条链路状态。
// 覆盖：最近可见事件、进行中 turn、进程/MCP/队列/目标、网络探针、存储/日志/用量、保守判断。
// 纯只读，不动 ~/.codex，不上传任何数据。
//
// 用法:
//   node codex-status.mjs                # 单次输出
//   node codex-status.mjs -w             # 实时刷新（默认每 1 秒）
//   node codex-status.mjs -w -i 3        # 每 3 秒刷新
//   node codex-status.mjs --color        # 强制彩色
//   node codex-status.mjs --no-color     # 关闭颜色
//   CODEX_HOME=/path/.codex node codex-status.mjs -w

import { createDatabaseRegistry } from './database-discovery.mjs';
import { execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fitRows, truncVis, padVis, renderResourcePanel } from './resource-panel.mjs';
import { dashboardLayout, renderInformationSections, composeInformationPane } from './dashboard-layout.mjs';
import { createHostSampler } from './host-metrics.mjs';
import { createTopSampler } from './top-sampler.mjs';
import { createActivityCollector } from './activity-metrics.mjs';
import { createNetworkDetailsSampler } from './network-details.mjs';
import { createNetworkProbeSampler } from './network-probes.mjs';
import { createBackgroundProbes } from './background-probes.mjs';
import { readPerformanceMetrics } from './performance-metrics.mjs';
import { buildDashboardRegions, bytes as dashboardBytes } from './dashboard-model.mjs';
import { parseOptions, getViewNames, reduceKey, createKeyDecoder } from './monitor-options.mjs';
import { createTranslator, getLocale, setLocale, resolveLocale, formatAgo } from './i18n.mjs';
import { statusMessages } from './locales/status.mjs';

const t = createTranslator(statusMessages);
const shutdown = new AbortController();
const topSampler = createTopSampler();

let options;
try { options = parseOptions(process.argv.slice(2)); setLocale(options.lang); }
catch (error) {
  let locale = error.locale || 'en';
  if (!error.locale) { try { locale = resolveLocale(); } catch {} }
  console.error(error.message + '\n' + t('usageHint', {}, locale)); process.exit(1);
}
const watch = options.watch;
const interval = options.interval;
let uiState = { view: options.view, paused: false, showHelp: false, leftOffset: 0, windowSeconds: options.windowSeconds };
const hostSampler = createHostSampler({ interfaceName: options.interfaceName });
const networkDetailsSampler = createNetworkDetailsSampler();
const activityCollector = createActivityCollector();
let lastRender = null, lastSnapshot = null, performanceCache = null, performanceCacheAt = 0, wakeWatch = null, lastLeftTotal = 0, lastLeftViewportRows = 20;
let forceNetworkRefresh = false;
const networkProbeSampler = createNetworkProbeSampler({ concurrency: 4 });
const networkProbeController = createBackgroundProbes({
  enabled: !options.noProbes, ttlMs: 60_000,
  sample: ({ networkDetails }, { force }) => networkProbeSampler.sample({ networkDetails, force }),
  cancel: () => networkProbeSampler.close(), onUpdate: publishProbeState,
});
const legacyProbeController = createBackgroundProbes({
  enabled: !options.noProbes, ttlMs: 10_000,
  sample: (_, { force }) => getProbes(force), cancel: () => legacyProbeAbort?.abort(), onUpdate: publishProbeState,
});
function publishProbeState() {
  if (uiState.paused) return;
  if (lastRender) {
    lastRender.dashboard.networkProbes = networkProbeController.getState();
    lastRender.dashboard.legacyProbeState = legacyProbeController.getState();
    lastRender.dashboard.probes = legacyProbeController.getState().result || [];
  }
  if (lastSnapshot) {
    lastSnapshot.networkProbes = networkProbeController.getState();
    lastSnapshot.probes = legacyProbeController.getState().result || [];
  }
  if (wakeWatch) { const resolve = wakeWatch; wakeWatch = null; resolve(); }
}
function networkProbeKey(details) {
  return JSON.stringify([details?.interfaceName, details?.addresses, details?.routes,
    ['http', 'https', 'socks'].map(key => {
      const entry = details?.systemProxy?.[key];
      return [entry?.enabled, entry?.endpoint, entry?.probe?.status];
    }), details?.systemProxy?.pac, details?.systemProxy?.autoDiscovery, details?.environmentProxy]);
}


const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
let NOW = Date.now();
const HOUR_MS = 3600000;
const TEN_MIN_S = 600;

const TOOL_TYPES = "('commandExecution','mcpToolCall','dynamicToolCall','collabAgentToolCall','webSearch')";

// ---- 颜色 ----
const forceColor = process.argv.includes('--color');
const noColor = process.argv.includes('--no-color');
let COLOR = process.stdout.isTTY && !('NO_COLOR' in process.env);
if (forceColor) COLOR = true;   // 显式 --color 优先级最高
if (noColor) COLOR = false;     // 显式 --no-color
const R = '\x1b[0m';
function col(code, s) { return COLOR ? '\x1b[' + code + 'm' + s + R : s; }
const bold = s => col('1', s);
const dim = s => col('2', s);
const red = s => col('31', s);
const green = s => col('32', s);
const yellow = s => col('33', s);
const cyan = s => col('36', s);
const magenta = s => col('35', s);
function hdr(s) { return bold(cyan(s)); }
function paintVerdict(key) {
  // Severity follows the semantic verdict, independent of its translated text.
  const paint = ['verdictExited', 'verdictNetwork', 'verdictHung'].includes(key) ? red
    : ['verdictIncomplete', 'verdictPolling'].includes(key) ? yellow : green;
  return bold(paint(t(key)));
}

// ---- sqlite（只读打开） ----
function all(db, sql, ...a) { try { return db.prepare(sql).all(...a); } catch { return []; } }
function one(db, sql, ...a) { try { return db.prepare(sql).get(...a) ?? null; } catch { return null; } }

const sourceRegistry = createDatabaseRegistry({ home: CODEX_HOME, sources: {
  history: { prefix: 'thread_history_', table: 'thread_items' },
  state: { prefix: 'state_', table: 'threads' },
  logs: { prefix: 'logs_', table: 'logs' },
  queue: { prefix: 'queue_', table: 'queued_items' },
  goals: { prefix: 'goals_', table: 'thread_goals' },
} });
let { history: TH, state: ST, logs: LG, queue: Q, goals: G } = sourceRegistry.refresh();
function refreshSources(force) {
  const next = sourceRegistry.refresh({ force });
  const sources = [next.history, next.state, next.logs, next.queue, next.goals];
  if ([TH, ST, LG, Q, G].some((source, index) => source !== sources[index])) performanceCacheAt = 0;
  if (LG !== next.logs) { lastLogId = null; lastLogAt = null; }
  ({ history: TH, state: ST, logs: LG, queue: Q, goals: G } = next);
}

// ---- config.toml（缓存，只读一次） ----
let CONFIG_TEXT = null;
function configText() {
  if (CONFIG_TEXT === null) {
    try { CONFIG_TEXT = fs.readFileSync(path.join(CODEX_HOME, 'config.toml'), 'utf8'); } catch (e) { CONFIG_TEXT = ''; }
  }
  return CONFIG_TEXT;
}
function cfgVal(key) {
  const txt = configText();
  for (const line of txt.split('\n')) {
    const i = line.indexOf('=');
    if (i < 0) continue;
    if (line.slice(0, i).trim() !== key) continue;
    let v = line.slice(i + 1).trim();
    if ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'")) v = v.slice(1, -1);
    return v;
  }
  return '';
}
function mcpServerCount() {
  let n = 0;
  for (const line of configText().split('\n')) if (line.startsWith('[mcp_servers.')) n++;
  return n;
}

// ---- 格式化 ----
const p2 = n => (n < 10 ? '0' + n : '' + n);
function fmtTs(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' +
         p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
}
function age(ms) { return formatAgo(ms, NOW); }

function clip(s, n) {
  n = n || 160;
  if (s == null) return '';
  let t = String(s).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}
function fmtBytes(n) {
  if (n == null || isNaN(n)) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : parseFloat(v.toFixed(1))) + ' ' + u[i];
}
function human(n) {
  if (n == null || isNaN(n)) return '0';
  return new Intl.NumberFormat(getLocale(), { notation: 'compact', maximumFractionDigits: 2 }).format(n);
}

function msgText(o) {
  if (!o) return '';
  if (typeof o.text === 'string' && o.text) return o.text;
  if (Array.isArray(o.content)) {
    const out = [];
    for (const c of o.content) {
      if (c && typeof c === 'object' && (c.text || c.input_text)) out.push(c.text || c.input_text);
      else if (typeof c === 'string') out.push(c);
    }
    return out.join(' ');
  }
  if (typeof o.content === 'string') return o.content;
  return '';
}
function label(thread, n) {
  n = n || 40;
  return thread.agent_nickname || thread.name || clip(thread.title, n) || clip(thread.id, 8) || t('unnamed');
}
function describe(type, json) {
  let o = null;
  try { o = JSON.parse(json); } catch (e) { o = null; }
  if (!o) return type;
  if (type === 'userMessage') return clip(msgText(o), 120);
  if (type === 'agentMessage') return clip(msgText(o) || o.text || '', 120);
  if (type === 'commandExecution') return '$ ' + clip(o.command || '', 90) + (o.exitCode != null ? '  (exit=' + o.exitCode + ')' : '');
  if (type === 'fileChange') {
    const arr = Array.isArray(o.changes) ? o.changes : [];
    const c = (arr[0] && arr[0].path) || o.path || '';
    return t('eventFileChange', { path: clip(c, 90) });
  }
  if (type === 'mcpToolCall') return (o.server || '') + '.' + (o.tool || '') + '  (' + (o.status || '') + ')';
  if (type === 'webSearch') return t('eventSearch', { query: clip(o.query || (o.arguments && o.arguments.query) || '', 90) });
  if (type === 'subAgentActivity') return t('eventSubagent', { activity: o.kind || o.activityType || o.status || '' });
  if (type === 'collabAgentToolCall') return t('eventCollab', { tool: clip(o.toolName || o.name || o.tool || '', 60) });
  if (type === 'dynamicToolCall') return t('eventDynamic', { tool: clip(o.name || o.tool || '', 60) });
  if (type === 'plan') return t('eventPlan', { title: clip(o.title || o.name || '', 60) });
  if (type === 'contextCompaction') return t('eventCompaction');
  if (type === 'imageView') return t('eventImageView');
  if (type === 'imageGeneration') return t('eventImageGeneration');
  return type;
}
function sh(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', timeout: 8000, maxBuffer: 16 * 1024 * 1024 }).trim(); } catch (e) { return ''; }
}
function errMsg(s) {
  if (!s) return '';
  const t = String(s);
  const i = t.indexOf('}');
  const j = t.indexOf(': ', i > 0 ? i : 0);
  return clip(j > -1 ? t.slice(j + 2) : t, 70);
}
// ---- 主机状态采样 + sparkline ----
const HIST_MAX = 3602;
const hist = Object.fromEntries(['at','load','mem','net','codexCpu','activity','faultRate','cpu','physicalMem','network','networkIn','networkOut','diskRead','diskWrite','codexRss','toolRate','swap'].map(key => [key, []]));
let lastLogId = null;
let lastLogAt = null;
let lastVm = null;
function pushHist(key, v) { hist[key].push(v); if (hist[key].length > HIST_MAX) hist[key].shift(); }
let SYSINFO = null;
function sysStatic() {
  if (SYSINFO === null) {
    const p = sh('sysctl -n hw.ncpu hw.memsize machdep.cpu.brand_string kern.boottime').split('\n');
    SYSINFO = {
      ncpu: Number(p[0]) || 0,
      mem: Number(p[1]) || 0,
      brand: p[2] || '',
      bootSec: Number((String(p[3]).match(/sec = (\d+)/) || [])[1]) || 0,
    };
  }
  return SYSINFO;
}
function loadAvg() {
  try {
    const values = os.loadavg();
    if (values.length >= 3 && values.slice(0, 3).every(Number.isFinite)) return values.slice(0, 3);
  } catch {}
  return [null, null, null];
}
const fmtLoad = (value, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : '—';
const fmtSampleRate = value => Number.isFinite(value) && value >= 0 ? fmtRate(value) : '—';
function memUsedPct() {
  const m = sh('memory_pressure -Q 2>/dev/null').match(/free percentage:\s*(\d+)%/);
  return m ? 100 - Number(m[1]) : -1;
}
function fmtRate(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'G';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}
function vmStat() {
  const s = sh('vm_stat');
  const out = {};
  const ps = (s.match(/page size of (\d+)/) || [])[1];
  out.pageSize = ps ? Number(ps) : 16384;
  for (const line of s.split('\n')) {
    const m = line.match(/"?([^":]+)"?:\s*(\d+)\.?\s*$/);
    if (m) out[m[1].trim()] = Number(m[2]);
  }
  return out;
}
function parseSwap() {
  const m = sh('sysctl -n vm.swapusage').match(/total\s*=\s*([\d.]+)\s*([KMGTP]?)\s+used\s*=\s*([\d.]+)\s*([KMGTP]?)/i);
  const mult = { B: 1, K: 1024, M: 1048576, G: 1073741824, T: 1099511627776 };
  if (!m) return { used: null, total: null };
  return { total: Number(m[1]) * (mult[(m[2] || 'B').toUpperCase()] || 1), used: Number(m[3]) * (mult[(m[4] || 'B').toUpperCase()] || 1) };
}
function powerState(value) {
  const states = { charged: 'powerCharged', charging: 'powerCharging', discharging: 'powerDischarging', 'finishing charge': 'powerFinishing', 'ac attached': 'powerAc' };
  const state = String(value || '').toLowerCase();
  return Object.hasOwn(states, state) ? t(states[state]) : value;
}
function fmtUptime(sec) {
  if (!sec || sec < 0) return '?';
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d > 0) return t('uptimeDays', { days: d, hours: h });
  if (h > 0) return t('uptimeHours', { hours: h, minutes: m });
  return t('uptimeMinutes', { minutes: m });
}
// ---- 终端宽度 / 两栏布局 ----
function composeColumns(left, right, cols) {
  if (cols < 84) return left.map(row => truncVis(row, cols)).join('\n');
  const layout = dashboardLayout(cols);
  return Array.from({ length: Math.max(left.length, right.length) }, (_, i) =>
    padVis(truncVis(left[i] || '', layout.left), layout.left) + dim(' │ ') + truncVis(right[i] || '', layout.right)
  ).join('\n');
}
async function probe(url, label, signal) {
  const at = Date.now();
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout(4000), signal]) });
    const latencyMs = Date.now() - at;
    try { await response.body?.cancel(); } catch {}
    return { label, status: response.status, latencyMs, at };
  } catch (error) {
    return { label, status: null, latencyMs: Date.now() - at, at, error: String(error?.cause?.code || error?.name || 'timeout') };
  }
}
let probeCache = null, probeCacheAt = 0, legacyProbeAbort = null;
const PROBE_TTL_MS = 10000;
async function getProbes(force = false) {
  if (options.noProbes) return [];
  if (!force && probeCache && Date.now() >= probeCacheAt && Date.now() - probeCacheAt < PROBE_TTL_MS) return probeCache;
  legacyProbeAbort = new AbortController();
  const signal = legacyProbeAbort.signal;
  probeCache = await Promise.all([
    probe('https://chatgpt.com/', 'chatgpt.com', signal),
    probe('https://chatgpt.com/backend-api', 'backend-api', signal),
    probe('https://codex-cloud-environments.chatgpt.com/', 'cloud-env', signal),
    probe('https://status.openai.com/', 'status.openai.com', signal),
  ]);
  probeCacheAt = Date.now();
  return probeCache;
}

// 数据目录总占用（du 一次性，懒加载缓存）
let codexSize = null;
function codexDirSize() {
  if (codexSize === null) {
    let output = '';
    try { output = execFileSync('du', ['-sk', CODEX_HOME], { encoding: 'utf8', timeout: 8000, stdio: ['ignore','pipe','ignore'] }); } catch {}
    const kb = parseInt(output, 10);
    codexSize = Number.isFinite(kb) ? kb * 1024 : -1;
  }
  return codexSize;
}
function dbInventory() {
  const items = [];
  try {
    for (const f of fs.readdirSync(CODEX_HOME)) {
      if (!f.endsWith('.sqlite') && !f.endsWith('.sqlite-wal')) continue;
      let s = 0; try { s = fs.statSync(path.join(CODEX_HOME, f)).size; } catch (e) {}
      items.push({ f, s });
    }
  } catch (e) {}
  items.sort((a, b) => b.s - a.s);
  return items;
}

// ===== 单次采集 + 渲染 =====
async function runOnce() {
  NOW = Date.now();
  refreshSources(forceNetworkRefresh);
  if (forceNetworkRefresh) CONFIG_TEXT = null;
  const cols = process.stdout.columns || 110;
  const twoCol = cols >= 84;
  const leftW = twoCol ? dashboardLayout(cols).left : cols;
  // Leave room for the watch footer and its trailing newline to avoid scrolling.
  const lines = [];

  // 头部
  lines.push(bold(t('title')) + '  ' + cyan(fmtTs(NOW)));
  lines.push(dim(t('dataSource', { path: CODEX_HOME })));
  const model = cfgVal('model') || '?';
  const sandbox = cfgVal('sandbox_mode') || '?';
  const reas = cfgVal('model_reasoning_effort') || '?';
  const mcpN = mcpServerCount();
  let cliVer = '';
  if (ST) { const r = one(ST.db, "SELECT cli_version FROM threads WHERE cli_version<>'' ORDER BY updated_at_ms DESC LIMIT 1"); cliVer = r?.cli_version || ''; }
  lines.push(t('environment', { label: dim(t('environmentLabel')), model: cyan(model), sandbox: yellow(sandbox), reasoning: reas || '?', mcp: mcpN, cli: cliVer ? ' · CLI ' + cliVer : '' }));
  lines.push(dim('\u2500'.repeat(twoCol ? leftW : 78)));

  const sampleStarted = Date.now();
  const forceThisSample = forceNetworkRefresh;
  const topPromise = topSampler.sample({ force: forceThisSample, signal: shutdown.signal });
  const legacyProbeTask = legacyProbeController.refresh(null, { force: forceThisSample });
  const host = hostSampler.sample();
  const networkDetailsPromise = networkDetailsSampler.sample({ interfaceName: host.network.interfaceName, force: forceNetworkRefresh });
  forceNetworkRefresh = false;
  const psCmd = host.processSnapshot;
  const procs = (host.processes.topCpu || []).map(p => ({ name: p.name, cpu: p.cpuPercent }));
  const codexCpu = host.processes.cpuPercent;
  const activity = activityCollector({ historyDb: TH?.db, stateDb: ST?.db, logsDb: LG?.db, queueDb: Q?.db, goalsDb: G?.db, now: NOW, threads: options.threads });
  if (!performanceCache || Date.now() - performanceCacheAt >= 5000) {
    performanceCache = readPerformanceMetrics({ threadIds: activity.sessions.rows.map(task => task.id), dbPath: options.metricsDb, now: NOW });
    performanceCacheAt = Date.now();
  }
  const tokenSum = activity.tokens.unarchived;
  const topModel = activity.sessions.rows.find(task => task.model)?.model || '';
  const sys = sysStatic();
  const load = loadAvg();
  const pressurePct = memUsedPct();
  const netInRate = host.network.inRate, netOutRate = host.network.outRate;
  const netRate = Number.isFinite(netInRate) && Number.isFinite(netOutRate) ? (netInRate + netOutRate) / 1024 : -1;
  const dio = { rRate: host.disk.readRate, wRate: host.disk.writeRate, rOpRate: host.disk.readIOPS, wOpRate: host.disk.writeIOPS };
  const logHead = LG ? one(LG.db, "SELECT max(id) m FROM logs") : null;
  const curLogId = Number.isFinite(logHead?.m) ? logHead.m : null;
  const logAt = Date.now();
  const logRate = curLogId != null && lastLogId != null && logAt > lastLogAt && curLogId >= lastLogId
    ? (curLogId - lastLogId) / ((logAt - lastLogAt) / 1000) : null;
  lastLogId = curLogId;
  lastLogAt = logAt;
  pushHist('at', NOW);
  pushHist('load', load[0]);
  pushHist('mem', pressurePct >= 0 ? pressurePct : null);
  pushHist('net', netRate >= 0 ? netRate : null);
  pushHist('codexCpu', codexCpu);
  pushHist('activity', logRate);
  const vm = vmStat();
  const pageSize = vm.pageSize || 16384;
  const faults = vm['Translation faults'];
  const pageins = vm['Pageins'];
  const pageouts = vm['Pageouts'];
  const compPages = vm['Pages occupied by compressor'];
  const compStored = vm['Pages stored in compressor'];
  let faultRate = null, pageinRate = null, pageoutRate = null;
  {
    const t4 = Date.now();
    if (lastVm && Number.isFinite(faults) && faults >= lastVm.faults) {
      const dt = (t4 - lastVm.at) / 1000;
      if (dt > 0) {
        faultRate = (faults - lastVm.faults) / dt;
        if (Number.isFinite(pageins) && Number.isFinite(lastVm.pageins) && pageins >= lastVm.pageins) pageinRate = (pageins - lastVm.pageins) / dt;
        if (Number.isFinite(pageouts) && Number.isFinite(lastVm.pageouts) && pageouts >= lastVm.pageouts) pageoutRate = (pageouts - lastVm.pageouts) / dt;
      }
    }
    lastVm = Number.isFinite(faults) ? { faults, pageins, pageouts, at: t4 } : null;
    pushHist('faultRate', faultRate);
  }
  const swap = parseSwap();
  const swapBytes = swap.used;
  const tm = await topPromise;
  const batt = host.power;
  const memPct = Number.isFinite(tm.memUsed) && sys.mem > 0 ? tm.memUsed / sys.mem * 100 : null;
  const toolRate = Number.isFinite(activity.tools.completed10m) ? activity.tools.completed10m / 600 : null;
  for (const [key, value] of Object.entries({ cpu: host.cpu.usagePercent, physicalMem: memPct, network: netRate >= 0 ? netRate * 1024 : null, networkIn: netInRate, networkOut: netOutRate, diskRead: host.disk.readRate, diskWrite: host.disk.writeRate, codexRss: host.processes.rssBytes, toolRate, swap: swap.used })) pushHist(key, value);
  const anonBytes = Number.isFinite(vm['Anonymous pages']) ? vm['Anonymous pages'] * pageSize : null;
  const cachedBytes = Number.isFinite(vm['File-backed pages']) && Number.isFinite(vm['Pages purgeable']) ? (vm['File-backed pages'] + vm['Pages purgeable']) * pageSize : null;
  const loadRatio = sys.ncpu && Number.isFinite(load[0]) ? (load[0] / sys.ncpu) * 100 : null;
  const loadCol = loadRatio == null ? dim : loadRatio < 60 ? green : (loadRatio < 100 ? yellow : red);
  const memCol = memPct == null ? dim : memPct < 80 ? green : (memPct < 95 ? yellow : red);
  const tp = procs.slice(0, 3);
  lines.push('');
  lines.push(magenta(bold(t('hostTitle'))) + '  ' + dim(t('hostSummary', { brand: sys.brand || '?', cores: sys.ncpu || '?', memory: fmtBytes(sys.mem), uptime: fmtUptime(Math.floor(NOW / 1000) - sys.bootSec) })));
  lines.push(t('hostLoad', { current: loadCol(bold('1m ' + fmtLoad(load[0]))), averages: dim(' · 5m ' + fmtLoad(load[1]) + ' · 15m ' + fmtLoad(load[2])), cores: sys.ncpu || '?' }));
  if (Number.isFinite(memPct)) lines.push(t('hostMemory', { percent: memCol(bold(memPct.toFixed(1)) + '%'), detail: dim(t('physicalUsed', { used: fmtBytes(tm.memUsed), total: fmtBytes(sys.mem) })) }));
  lines.push(t('hostCpu', { cpu: Number.isFinite(host.cpu.usagePercent) ? bold(host.cpu.usagePercent.toFixed(1) + '%') : '—', codex: Number.isFinite(codexCpu) ? t('multiCorePercent', { percent: codexCpu.toFixed(1) }) : '—', rss: dashboardBytes(host.processes.rssBytes) }));
  lines.push(t('hostNetwork', { rate: netRate >= 0 ? cyan(fmtBytes(Math.round(netRate * 1024)) + '/s') : dim('—') }));
  if (tp.length) lines.push(t('hostTopCpu', { processes: tp.map(p => (p.cpu > 50 ? red : cyan)(clip(p.name, 18) + ' ' + p.cpu.toFixed(0) + '%')).join(' · ') }));
  lines.push('');
  lines.push(yellow(bold(t('activityMonitor'))) + dim('  top -l 1'));
  if (tm.cpuUser != null) lines.push(t('cpuBreakdown', { user: bold(tm.cpuUser.toFixed(1)), system: bold(tm.cpuSys.toFixed(1)), idle: tm.cpuIdle.toFixed(1) }));
  if (tm.procTotal != null) lines.push(t('processSummary', { total: bold(String(tm.procTotal)), running: tm.procRunning, sleeping: tm.procSleeping, threads: bold(String(tm.threads)) }));
  if (tm.memUsed != null) lines.push(t('memorySummary', { used: bold(fmtBytes(tm.memUsed)), wired: fmtBytes(tm.memWired), compressed: fmtBytes(tm.memComp), free: fmtBytes(tm.memUnused) }));
  lines.push(t('vmSummary', { app: fmtBytes(anonBytes), cache: fmtBytes(cachedBytes), swap: swap.used == null ? '—' : swap.used > 0 ? yellow(fmtBytes(swap.used)) : '0', total: fmtBytes(swap.total) }));
  if (tm.swapins != null) lines.push(t('swapSummary', { input: human(tm.swapins), output: human(tm.swapouts), inRate: fmtSampleRate(pageinRate), outRate: fmtSampleRate(pageoutRate) }));
  if (tm.netByteIn != null) lines.push(t('networkTotals', { input: fmtBytes(tm.netByteIn), inPackets: human(tm.netPktIn), output: fmtBytes(tm.netByteOut), outPackets: human(tm.netPktOut) }));
  if (tm.netPktInRate != null) lines.push(t('networkRates', { input: netInRate >= 0 ? bold(fmtBytes(Math.round(netInRate)) + '/s') : '—', inPackets: fmtRate(tm.netPktInRate), output: netOutRate >= 0 ? bold(fmtBytes(Math.round(netOutRate)) + '/s') : '—', outPackets: fmtRate(tm.netPktOutRate) }));
  if (tm.diskByteRead != null) lines.push(t('diskTotals', { read: fmtBytes(tm.diskByteRead), reads: human(tm.diskOpRead), write: fmtBytes(tm.diskByteWrite), writes: human(tm.diskOpWrite) }));
  lines.push(t('diskRates', { read: bold(dashboardBytes(dio.rRate) + '/s'), reads: fmtSampleRate(dio.rOpRate), write: bold(dashboardBytes(dio.wRate) + '/s'), writes: fmtSampleRate(dio.wOpRate) }));
  if (batt) lines.push(t('battery', { percent: bold(String(batt.pct)), state: powerState(batt.state) }));

  // [1] 最近可见事件
  let merged = [];
  let latestThreadId = null;
  if (TH && ST) {
    const top = all(ST.db, "SELECT id, agent_nickname, name, title, model, cwd FROM threads ORDER BY updated_at_ms DESC LIMIT 8");
    if (top.length) latestThreadId = top[0].id;
    for (const t of top) {
      const rows = all(TH.db, "SELECT item_type, item_id, created_at_ms, started_at_ms, completed_at_ms, item_json FROM thread_items WHERE thread_id=? AND item_type NOT IN ('sleep','reasoning') ORDER BY rollout_ordinal DESC LIMIT 30", t.id);
      for (const r of rows) merged.push({ nick: label(t), ...r });
    }
    merged.sort((a, b) => b.created_at_ms - a.created_at_ms);
  }
  const newestVisible = merged[0] || null;
  lines.push('');
  lines.push(hdr(t('eventsTitle')));
  if (newestVisible) {
    lines.push(t('eventType', { type: bold(newestVisible.item_type), source: newestVisible.nick ? t('eventSource', { name: cyan(newestVisible.nick) }) : '' }));
    lines.push(t('eventContent', { text: describe(newestVisible.item_type, newestVisible.item_json) || t('empty') }));
    lines.push(t('eventTime', { time: cyan(fmtTs(newestVisible.created_at_ms)) }));
    lines.push(t('eventAge', { age: bold(age(newestVisible.created_at_ms)) }));
  } else {
    lines.push(t('noVisibleEvents'));
  }
  const lastAgent = merged.find(r => r.item_type === 'agentMessage');
  const lastUser = merged.find(r => r.item_type === 'userMessage');
  if (lastAgent || lastUser) {
    lines.push('    ----');
    if (lastAgent) lines.push(t('lastAgent', { age: bold(age(lastAgent.created_at_ms)), text: clip(describe('agentMessage', lastAgent.item_json), 90) }));
    if (lastUser) lines.push(t('lastUser', { age: bold(age(lastUser.created_at_ms)), text: clip(describe('userMessage', lastUser.item_json), 90) }));
  }
  const recent = merged.slice(0, 6);
  if (recent.length) {
    lines.push(t('recentEvents'));
    for (const r of recent) lines.push('      - ' + dim(age(r.created_at_ms)) + '  ' + cyan(r.item_type) + '  ' + describe(r.item_type, r.item_json).slice(0, 84));
  }

  // [2] 未完成的工具调用
  const runningTurns = activity.sessions.rows.filter(task => task.status === 'inProgress' || task.status === 'stale').map(task => ({ thread_id: task.id, started_at: task.turnStartedAt / 1000, stale: task.stale }));
  const unfinishedRecent = activity.tools.pendingRows.filter(item => !item.stale).map(item => ({
    nick: activity.sessions.rows.find(task => task.id === item.threadId)?.label || item.threadId.slice(0, 8),
    item_type: item.type, started_at_ms: item.startedAt, created_at_ms: NOW - item.waitMs,
  }));
  const unfinishedStale = activity.tools.stalePending;
  const toolLowerBound = !activity.coverage.pendingComplete;
  const hungTools = unfinishedRecent.filter(u => u.created_at_ms < NOW - 300000);
  lines.push('');
  lines.push(hdr(t('toolsTitle')));
  if (!activity.availability.history || activity.tools.pending == null) lines.push(yellow(t('toolsUnavailable')));
  else if (hungTools.length) {
    lines.push('    ' + red(t('hungTools', { count: hungTools.length })) + t('hungToolsDetail'));
    for (const u of hungTools.slice(0, 10)) lines.push('      - ' + u.nick + ' : ' + u.item_type + ' · ' + age(u.started_at_ms || u.created_at_ms));
  } else if (unfinishedRecent.length) {
    lines.push('    ' + yellow(t('pendingTools', { count: unfinishedRecent.length })) + t('pendingToolsDetail'));
    for (const u of unfinishedRecent.slice(0, 10)) lines.push('      - ' + u.nick + ' : ' + u.item_type + ' · ' + age(u.started_at_ms || u.created_at_ms));
  } else {
    lines.push('    ' + green(t('notFound')) + t('noPendingTools') + (toolLowerBound ? t('boundedScan') : ''));
  }
  if (unfinishedStale > 0) lines.push(dim(t('staleTools', { count: unfinishedStale })));
  const recentRunning = runningTurns.filter(t => !t.stale);
  const staleRunning = activity.turns.staleRunning || 0;
  lines.push(t('runningTurns', { total: bold(String(activity.turns.totalRunning ?? '—')), recent: bold(String(activity.turns.recentRunning ?? '—')) }));
  const nickById = {};
  if (ST && recentRunning.length) {
    const ids = [...new Set(recentRunning.map(t => t.thread_id))];
    for (const id of ids) {
      const r = one(ST.db, "SELECT id, agent_nickname, name, title FROM threads WHERE id=?", id);
      nickById[id] = r ? label(r, 24) : clip(id, 8);
    }
  }
  for (const turn of recentRunning.slice(0, 8)) lines.push(t('turnStarted', { name: nickById[turn.thread_id] || '?', age: age(turn.started_at * 1000) }));
  if (staleRunning) lines.push(dim(t('staleTurns', { count: staleRunning })));

  // 空转检测
  let sleepLoopCount = 0;
  if (TH && latestThreadId) {
    const tail = all(TH.db, "SELECT item_type FROM thread_items WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT 20", latestThreadId);
    for (const r of tail) { if (r.item_type === 'sleep') sleepLoopCount++; else break; }
  }

  // [3] 进程 · MCP · 队列 · 目标（复用上面一次采集的 psCmd）
  const appServerProc = host.processes.counts['app-server'] || 0;
  const execServerProc = host.processes.counts['exec-server'] || 0;
  const codeModeHostProc = host.processes.counts['code-mode'] || 0;
  const netServiceProc = (psCmd.match(/network\.mojom\.NetworkService/g) || []).length;
  const mcpDetail = Object.entries(host.processes.items.filter(p => p.role === 'mcp').reduce((counts, p) => { counts[p.name] = (counts[p.name] || 0) + 1; return counts; }, {})).map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n);
  const mcpTotal = host.processes.available ? host.processes.counts.mcp || 0 : null;
  // Counts alone do not prove a leak: several live chats can legitimately own servers.
  const queuedItems = activity.queue.count;
  let queuedRevs = null;
  try { if (Q) queuedRevs = one(Q.db, 'SELECT count(*) c FROM queued_thread_revisions')?.c ?? null; } catch {}
  const goalsCount = activity.goals.active;

  lines.push('');
  lines.push(hdr(t('processesTitle')));
  lines.push(t('processes', { processes: host.processes.available ? 'app-server ×' + bold(String(appServerProc)) + (appServerProc > 0 ? green(' ✓') : red(' ✗')) + ' · exec-server ×' + execServerProc + ' · code-mode-host ×' + codeModeHostProc : dim(t('unavailable')) }));
  lines.push(t('mcpProcesses', { count: bold(mcpTotal == null ? '—' : String(mcpTotal)), detail: mcpDetail.length ? ' (' + mcpDetail.slice(0, 3).map(d => d.name + ' ×' + d.n).join(', ') + ')' : '', config: dim(t('mcpConfigured', { count: mcpN })) }));
  lines.push(t('cloudQueue', { count: queuedItems == null ? dim('—') : queuedItems > 0 ? yellow(String(queuedItems)) : green(t('zeroQueue')), revisions: queuedRevs ?? '—' }));
  lines.push(t('activeGoals', { active: bold(goalsCount == null ? '—' : String(goalsCount)), total: activity.goals.total ?? '—' }));

  // [4] 网络探针
  let ipcSocket = false;
  try { ipcSocket = fs.statSync(path.join(CODEX_HOME, 'ipc', 'ipc.sock')).isSocket(); } catch (e) {}
  const networkDetails = await networkDetailsPromise;
  const networkProbeTask = networkProbeController.refresh({ networkDetails }, { force: forceThisSample, key: networkProbeKey(networkDetails) });
  if (!watch) await Promise.all([legacyProbeTask, networkProbeTask]);
  const probeRes = legacyProbeController.getState().result || [];
  const networkProbes = networkProbeController.getState();
  const legacyProbeState = legacyProbeController.getState();
  const netOk = probeRes.length === 4 && probeRes.every(x => x.status != null);
  lines.push('');
  lines.push(hdr(t('networkTitle')));
  lines.push(t('localIpc', { socket: ipcSocket ? green(t('ipcPresent')) : red(t('ipcMissing')), service: netServiceProc > 0 ? green(t('running')) : red(t('notFound')) }));
  if (options.noProbes) lines.push(dim(t('probesDisabled')));
  else if (legacyProbeState.sampling && !probeRes.length) lines.push(dim(t('probesSampling')));
  for (const result of probeRes) {
    const paint = !result.status ? red : result.status >= 400 ? yellow : green;
    lines.push('    ' + result.label.padEnd(18) + ': ' + paint(result.status ? 'HTTP ' + result.status : result.error) + ' · ' + result.latencyMs + 'ms');
  }
  if (probeRes.some(result => result.status >= 400)) lines.push(dim(t('httpReachabilityNote')));

  // [5] 存储 · 日志 · 用量
  const inv = dbInventory();
  const dbTotal = inv.filter(x => x.f.endsWith('.sqlite')).reduce((a, b) => a + b.s, 0);
  const topDb = inv.find(x => !x.f.endsWith('-wal'));
  const topWal = inv.find(x => x.f.endsWith('-wal'));
  let lastLogSec = null;
  const lvls = {};
  let errSummary = [];
  if (LG) {
    const lr = one(LG.db, "SELECT ts FROM logs ORDER BY ts DESC, id DESC LIMIT 1");
    if (lr) lastLogSec = lr.ts;
    const cutoff = Math.floor(NOW / 1000) - TEN_MIN_S;
    for (const r of all(LG.db, "SELECT level, count(*) c FROM logs WHERE ts>=? GROUP BY level", cutoff)) lvls[r.level] = r.c;
    const erows = all(LG.db, "SELECT target, feedback_log_body FROM logs WHERE ts>=? AND level='ERROR' ORDER BY ts DESC, id DESC LIMIT 12", cutoff);
    const byTarget = {};
    for (const r of erows) { if (!byTarget[r.target]) byTarget[r.target] = { target: r.target, c: 0, msg: r.feedback_log_body }; byTarget[r.target].c++; }
    errSummary = Object.values(byTarget).sort((a, b) => b.c - a.c);
  }
  const errRecent = activity.alerts.error10m;
  const warnRecent = activity.alerts.warn10m;
  let dfAvail = '', dfCap = '';
  {
    let output = '';
    try { output = execFileSync('df', ['-h', CODEX_HOME], { encoding: 'utf8', timeout: 2000, stdio: ['ignore','pipe','ignore'] }); } catch {}
    const p = output.trim().split('\n').at(-1).trim().split(/\s+/);
    dfAvail = p[3] || '';
    dfCap = p[4] || '';
  }
  lines.push('');
  lines.push(hdr(t('storageTitle')));
  lines.push(t('tokenTotal', { count: bold(tokenSum == null ? '—' : human(tokenSum)), model: topModel ? t('tokenModel', { model: cyan(topModel) }) : '' }));
  lines.push(t('tokenDelta', { count: bold(activity.tokens.monitorDelta == null ? '—' : human(activity.tokens.monitorDelta)) }));
  const measuredSpeed = activity.sessions.rows.map(task => performanceCache.byThread[task.id]?.fields.tokensPerSecond).find(Boolean);
  lines.push(t('nativeSpeed', { speed: measuredSpeed ? t('cachedSpeed', { speed: measuredSpeed.value.toFixed(1), age: age(measuredSpeed.measuredAt) }) : t('noSpeed') }));
  {
    const win = Number(cfgVal('model_context_window')) || 0;
    const auto = Number(cfgVal('model_auto_compact_token_limit')) || 0;
    const comps = merged.filter(r => r.item_type === 'contextCompaction').length;
    lines.push(t('contextWindow', { window: win ? human(win) : '?', threshold: auto ? t('compactionThreshold', { count: human(auto) }) : '', recent: comps > 0 ? t('recentCompactions', { count: comps }) : t('noRecentCompactions') }));
  }
  lines.push(t('pageFaults', { faults: bold(fmtSampleRate(faultRate)), input: fmtSampleRate(pageinRate), output: fmtSampleRate(pageoutRate) }));
  lines.push(t('compressedMemory', { compressed: fmtBytes(compPages * pageSize), original: fmtBytes(compStored * pageSize), swap: swapBytes == null ? '—' : swapBytes > 0 ? yellow(fmtBytes(swapBytes)) : '0' }));
  if (codexDirSize() > 0) lines.push(t('dataDirectory', { size: bold(fmtBytes(codexDirSize())), db: fmtBytes(dbTotal) }));
  else lines.push(t('dbFiles', { size: fmtBytes(dbTotal) }));
  if (topDb) lines.push(t('largestDb', { file: topDb.f, size: bold(fmtBytes(topDb.s)) }));
  if (topWal && topWal.s > 50 * 1024 * 1024) lines.push(t('walBacklog', { file: yellow(topWal.f + ' ' + fmtBytes(topWal.s)) }));
  else if (topWal) lines.push(t('largestWal', { file: topWal.f, size: fmtBytes(topWal.s) }));
  if (dfAvail) lines.push(t('diskFree', { free: green(dfAvail), percent: dfCap }));
  lines.push(t('logHeartbeat', { age: lastLogSec != null ? cyan(age(lastLogSec * 1000)) : t('none'), errors: errRecent == null ? '—' : errRecent > 0 ? red(String(errRecent)) : '0', warnings: warnRecent == null ? '—' : warnRecent > 0 ? yellow(String(warnRecent)) : '0', info: activity.availability.logs ? lvls.INFO || 0 : '—', debug: activity.availability.logs ? lvls.DEBUG || 0 : '—', trace: activity.availability.logs ? lvls.TRACE || 0 : '—' }));
  if (errSummary.length) {
    for (const e of errSummary.slice(0, 3)) lines.push(t('recentError', { target: red(clip(String(e.target), 28) + ' ×' + e.c), error: errMsg(e.msg) }));
  }

  // [6] 保守判断
  let verdict;
  const facts = [];
  if (!host.processes.available) facts.push(dim(t('processUnavailable'))); else if (appServerProc > 0) facts.push(green(t('appAlive'))); else facts.push(red(t('appServerMissing')));
  facts.push(dim(t('identifiableMcp', { count: mcpTotal ?? '—' })));
  if (queuedItems == null) facts.push(dim(t('queueUnknown'))); else if (queuedItems > 0) facts.push(yellow(t('queueBacklog', { count: queuedItems }))); else facts.push(green(t('queueEmpty')));
  if (netOk) facts.push(green(t('httpReachable'))); else if (probeRes.length) facts.push(red(t('networkFailed'))); else if (options.noProbes) facts.push(dim(t('httpDisabled')));
  if (errRecent == null) facts.push(dim(t('alertsUnknown'))); else if (errRecent > 0) facts.push(yellow('ERROR=' + errRecent)); else facts.push(green(t('noRecentErrors')));

  if (!host.processes.available || !activity.availability.history || !activity.availability.state || !Number.isFinite(activity.turns.recentRunning)) verdict = 'verdictIncomplete';
  else if (appServerProc === 0) verdict = 'verdictExited';
  else if (!netOk && probeRes.length) verdict = 'verdictNetwork';
  else if (hungTools.length > 0) verdict = 'verdictHung';
  else if (activity.turns.recentRunning > 0 && sleepLoopCount >= 3) verdict = 'verdictPolling';
  else if (activity.turns.recentRunning > 0) verdict = 'verdictWorking';
  else verdict = 'verdictIdle';

  lines.push('');
  lines.push(hdr(t('verdictTitle')));
  lines.push('    ' + paintVerdict(verdict));
  lines.push(dim(t('verdictFacts', { facts: facts.join('; ') })));
  if (sleepLoopCount >= 3) lines.push(yellow(t('sleepLoop', { count: sleepLoopCount })));
  if (errRecent > 0 && errSummary.length) {
    lines.push(dim(t('errorNote', { target: clip(String(errSummary[0].target), 28), error: errMsg(errSummary[0].msg) })));
  }
  lines.push('');

  lines.splice(4, 0, t('statusLabel') + paintVerdict(verdict), dim(t('taskStatus', { running: activity.turns.recentRunning ?? '—', tools: activity.tools.pending ?? '—', queue: activity.queue.count ?? '—', errors: activity.alerts.error10m ?? '—' })));
  const sampleMs = Date.now() - sampleStarted;
  const dashboard = { host, activity, performance: performanceCache, sys, tm, load, pressurePercent: pressurePct, swap, hist, now: NOW,
    probes: probeRes, storage: { dbBytes: dbTotal, walBytes: inv.filter(item => item.f.endsWith('-wal')).reduce((sum, item) => sum + item.s, 0), diskAvailable: dfAvail },
    networkDetails, networkProbes, legacyProbeState, sampleMs, intervalMs: interval * 1000, noProbes: options.noProbes, limit: options.threads };
  lastRender = { lines, dashboard };
  lastSnapshot = { at: NOW, host, activity, performance: performanceCache, networkDetails, networkProbes, storage: dashboard.storage, probes: probeRes,
    system: { ...sys, load, physicalMemoryUsedBytes: tm.memUsed ?? null, physicalMemoryPercent: memPct,
      memoryPressureEstimatePercent: pressurePct >= 0 ? pressurePct : null, swap,
      vm: { faultRate, pageinRate, pageoutRate, compressedBytes: Number.isFinite(compPages) ? compPages * pageSize : null } },
    environment: { model, reasoning: reas, sandbox, cliVersion: cliVer },
    monitor: { pid: process.pid, rssBytes: process.memoryUsage().rss },
    sampleMs, intervalSeconds: interval, windowSeconds: uiState.windowSeconds };
  return !watch && !options.json ? renderLast() : '';
}

function renderLast() {
  if (!lastRender) return '';
  const cols = process.stdout.columns || 110;
  const frameRows = process.stdout.rows ? Math.max(1, process.stdout.rows - (watch ? 2 : 1)) : undefined;
  const layout = dashboardLayout(cols);
  const { charts, information, systemStatus } = buildDashboardRegions({ ...lastRender.dashboard, view: uiState.view,
    width: layout.right || cols, windowSeconds: uiState.windowSeconds }, { detailWidth: layout.secondary });
  const original = lastRender.lines;
  const index = marker => original.findIndex(line => line.includes(marker));
  const header = original.slice(0, 6);
  let primary;
  if (uiState.view === 'host') primary = original.slice(6, index('[1]'));
  else if (uiState.view === 'tasks') primary = original.slice(index('[1]'), index('[3]'));
  else if (uiState.view === 'diagnostics') primary = original.slice(index('[3]'));
  else {
    primary = original.slice(6, index('[4]'));
    const storageLabels = ['localIpc', 'dataDirectory', 'dbFiles', 'largestDb', 'walBacklog', 'largestWal', 'diskFree', 'compressedMemory', 'contextWindow'].map(key => t(key).split('{')[0]);
    const rows = original.slice(index('[4]'), index('[6]')).filter(line => storageLabels.some(label => line.includes(label)));
    information.push({ title: t('storageLinkTitle'), tag: 'STORAGE', tone: 'cyan', rows });
  }
  if (!layout.right) information.unshift({ title: t('resourceValuesTitle'), tag: 'VALUES', tone: 'cyan',
    rows: charts.sections.flatMap(section => section.metrics.map(metric => ({ label: metric.label, value: metric.value, tone: metric.tone }))) });
  if (!layout.right) information.push(systemStatus);
  let secondary = renderInformationSections(information, { width: layout.columns === 2 ? layout.secondary : layout.left, color: COLOR });
  let pinned = header;
  if (uiState.showHelp) {
    pinned = [];
    primary = [
      bold(t('keysTitle')), '',
      t('keysViews'),
      t('keysPause'),
      t('keysScroll'),
      t('keysPage'),
      t('keysHome'),
      t('keysWindow'),
      t('keysRefresh'),
      t('keysHelp'),
      t('keysQuit'), '',
      t('helpLayout'),
      t('helpColumns'),
      t('helpReadOnly'),
      t('helpMemory'),
      t('helpCpu'),
      t('helpSpeed'),
      t('helpHttp'),
    ];
    secondary = [];
  }
  const left = composeInformationPane({ header: pinned, primary, secondary }, { layout, height: frameRows,
    offset: uiState.leftOffset, color: COLOR, scroll: Boolean(watch && process.stdout.isTTY), help: uiState.showHelp });
  uiState.leftOffset = left.offset;
  lastLeftTotal = left.total;
  lastLeftViewportRows = Math.max(1, left.viewportRows);
  let right = [];
  if (layout.right) {
    const budget = frameRows ?? 60;
    const status = fitRows(renderInformationSections([systemStatus], { width: layout.right, color: COLOR }), Math.max(1, Math.floor(budget / 4)), dim(t('raiseWindow')));
    right = renderResourcePanel(charts, { width: layout.right, height: Math.max(0, budget - status.length - 1), color: COLOR, presentation: 'charts' }).concat('', status);
  }
  return composeColumns(left.rows, right, cols);
}

const HELP = [
  t('helpTitle'), t('usage'),
  t('usageCommand'),
  t('usageOnceCommand'),
  t('usageNode'),
  t('usageNodeWatch'),
  t('usageInterval'),
  t('usageOnce'),
  t('usageView'),
  t('usageWindow'),
  t('usageInterface'),
  t('usageThreads'),
  t('usageProbes'),
  t('usageMetrics'),
  t('usageJson'),
  t('usageColor'),
  t('usageLang'),
  t('usageHelp'), '',
  t('languageEnvironment'), '',
  t('usageKeys'),
].join('\n');

if (options.help) { console.log(HELP); process.exit(0); }

function closeDatabases() {
  shutdown.abort();
  networkProbeController.close(); legacyProbeController.close();
  sourceRegistry.close();
}

if (watch) {
  const terminal = Boolean(process.stdout.isTTY && !options.json);
  const interactive = terminal && process.stdin.isTTY;
  const previousRaw = process.stdin.isRaw;
  const wake = () => { if (wakeWatch) { const resolve = wakeWatch; wakeWatch = null; resolve(); } };
  const decodeKeys = createKeyDecoder();
  const onKey = chunk => {
    if (String(chunk).includes('\x03')) { uiState.quit = true; shutdown.abort(); wake(); return; }
    const wasPaused = uiState.paused;
    for (const key of decodeKeys(chunk)) uiState = reduceKey(uiState, key, lastLeftViewportRows);
    if (uiState.quit) shutdown.abort();
    if (wasPaused && !uiState.paused && hist.at.length) {
      for (const key of Object.keys(hist)) pushHist(key, key === 'at' ? Date.now() - 1 : null);
    }
    wake();
  };
  const onSignal = () => { uiState.quit = true; shutdown.abort(); wake(); };
  if (terminal) process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[?7l');
  if (interactive) { process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('data', onKey); }
  process.stdout.on('resize', wake);
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  let nextSampleAt = 0;
  try {
    while (!uiState.quit) {
      if ((!uiState.paused && Date.now() >= nextSampleAt) || uiState.refreshRequested || !lastRender) {
        if (uiState.refreshRequested) { probeCacheAt = 0; performanceCacheAt = 0; forceNetworkRefresh = true; }
        uiState.refreshRequested = false;
        const started = Date.now();
        await runOnce();
        nextSampleAt = Math.max(Date.now() + 50, started + interval * 1000);
      }
      if (uiState.quit) break;
      if (options.json) process.stdout.write(JSON.stringify(lastSnapshot) + '\n');
      else {
        const rendered = renderLast();
        const footer = ' ' + Object.entries(getViewNames()).map(([key, value], i) => (uiState.view === key ? '[' : '') + (i + 1) + ' ' + value + (uiState.view === key ? ']' : '')).join('  ')
          + ' · ' + (uiState.paused ? t('paused') : interval + 's') + t('scrollFooter') + (uiState.leftOffset + 1) + '/' + lastLeftTotal + t('keysFooter');
        const frame = rendered + '\n' + truncVis(dim(footer), process.stdout.columns || 110);
        process.stdout.write(terminal ? '\x1b[H' + frame.replace(/\n/g, '\x1b[K\n') + '\x1b[K\x1b[0J' : frame + '\n');
      }
      await new Promise(resolve => {
        const timeout = setTimeout(() => { wakeWatch = null; resolve(); }, uiState.paused ? 1000 : Math.max(50, nextSampleAt - Date.now()));
        wakeWatch = () => { clearTimeout(timeout); resolve(); };
      });
    }
  } catch (error) { console.error(t('samplingFailed') + error.message); process.exitCode = 1; }
  finally {
    if (interactive) { process.stdin.off('data', onKey); process.stdin.setRawMode(Boolean(previousRaw)); process.stdin.pause(); }
    if (terminal) process.stdout.write('\x1b[?7h\x1b[?25h\x1b[?1049l');
    process.stdout.off('resize', wake); process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
    closeDatabases();
  }
} else {
  try {
    const rendered = await runOnce();
    process.stdout.write(options.json ? JSON.stringify(lastSnapshot, null, 2) + '\n' : rendered + '\n');
  } catch (error) { console.error(t('samplingFailed') + error.message); process.exitCode = 1; }
  finally { closeDatabases(); }
}

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

import { discoverDatabase } from './database-discovery.mjs';
import { execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fitRows, truncVis, padVis, renderResourcePanel } from './resource-panel.mjs';
import { dashboardLayout, renderInformationSections, composeInformationPane } from './dashboard-layout.mjs';
import { createHostSampler } from './host-metrics.mjs';
import { createActivityCollector } from './activity-metrics.mjs';
import { createNetworkDetailsSampler } from './network-details.mjs';
import { createNetworkProbeSampler } from './network-probes.mjs';
import { createBackgroundProbes } from './background-probes.mjs';
import { readPerformanceMetrics } from './performance-metrics.mjs';
import { buildDashboardRegions, bytes as dashboardBytes } from './dashboard-model.mjs';
import { parseOptions, VIEW_NAMES, reduceKey, createKeyDecoder } from './monitor-options.mjs';

let options;
try { options = parseOptions(process.argv.slice(2)); }
catch (error) { console.error(error.message + '\n使用 --help 查看用法'); process.exit(1); }
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
  sample: () => getProbes(), cancel: () => legacyProbeAbort?.abort(), onUpdate: publishProbeState,
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
function paintVerdict(v) {
  if (/崩溃|异常|挂起|失败/.test(v)) return bold(red(v));
  if (/空转|等待|疑似|泄漏|暂无|数据不完整|不可用/.test(v)) return bold(yellow(v));
  return bold(green(v));
}

// ---- sqlite（只读打开） ----
function all(db, sql, ...a) { try { return db.prepare(sql).all(...a); } catch { return []; } }
function one(db, sql, ...a) { try { return db.prepare(sql).get(...a) ?? null; } catch { return null; } }

function discover(prefix, table) {
  return discoverDatabase({ home: CODEX_HOME, prefix, table });
}

const TH = discover('thread_history_', 'thread_items');
const ST = discover('state_', 'threads');
const LG = discover('logs_', 'logs');
const Q = discover('queue_', 'queued_items');
const G = discover('goals_', 'thread_goals');

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
function age(ms) {
  const s = Math.round((NOW - ms) / 1000);
  if (s < 0) return '刚刚';
  if (s < 60) return s + ' 秒前';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  return Math.floor(s / 86400) + ' 天前';
}
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
  if (n >= 1e12) return parseFloat((n / 1e12).toFixed(2)) + ' 万亿';
  if (n >= 1e8) return parseFloat((n / 1e8).toFixed(1)) + ' 亿';
  if (n >= 1e4) return parseFloat((n / 1e4).toFixed(1)) + ' 万';
  return String(n);
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
function label(t, n) {
  n = n || 40;
  return t.agent_nickname || t.name || clip(t.title, n) || clip(t.id, 8) || '(未命名)';
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
    return '改文件: ' + clip(c, 90);
  }
  if (type === 'mcpToolCall') return (o.server || '') + '.' + (o.tool || '') + '  (' + (o.status || '') + ')';
  if (type === 'webSearch') return '搜索: ' + clip(o.query || (o.arguments && o.arguments.query) || '', 90);
  if (type === 'subAgentActivity') return '子代理活动: ' + (o.kind || o.activityType || o.status || '');
  if (type === 'collabAgentToolCall') return 'collab 调用: ' + clip(o.toolName || o.name || o.tool || '', 60);
  if (type === 'dynamicToolCall') return 'dynamic 调用: ' + clip(o.name || o.tool || '', 60);
  if (type === 'plan') return '计划: ' + clip(o.title || o.name || '', 60);
  if (type === 'contextCompaction') return '上下文压缩';
  if (type === 'imageView') return '查看图片';
  if (type === 'imageGeneration') return '生成图片';
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
  const m = sh('sysctl -n vm.loadavg').match(/[\d.]+/g);
  return m && m.length >= 3 ? m.slice(0, 3).map(Number) : [null, null, null];
}
const fmtLoad = (value, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : '—';
const fmtSampleRate = value => Number.isFinite(value) && value >= 0 ? fmtRate(value) : '—';
function memUsedPct() {
  const m = sh('memory_pressure -Q 2>/dev/null').match(/free percentage:\s*(\d+)%/);
  return m ? 100 - Number(m[1]) : -1;
}
function fmtRate(n) {
  if (n == null || isNaN(n) || n < 0) return '0';
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
function toBytes(v, u) {
  const mult = { '': 1, B: 1, K: 1024, M: 1048576, G: 1073741824, T: 1099511627776 };
  return Number(v) * (mult[(u || '').toUpperCase()] || 1);
}
let topCache = null, topCacheAt = 0, topPrev = null;
function topSample() {
  const now = Date.now();
  if (topCache && (now - topCacheAt) < 2500) return topCache;
  const s = sh('top -l 1 -n 0');
  const o = { at: now };
  let m;
  if ((m = s.match(/Processes:\s*(\d+)\s*total,\s*(\d+)\s*running,\s*(?:(\d+)\s*stuck,\s*)?(\d+)\s*sleeping,\s*(\d+)\s*threads/))) {
    o.procTotal = Number(m[1]); o.procRunning = Number(m[2]); o.procSleeping = Number(m[4]); o.threads = Number(m[5]);
  }
  if ((m = s.match(/CPU usage:\s*([\d.]+)%\s*user,\s*([\d.]+)%\s*sys,\s*([\d.]+)%\s*idle/))) {
    o.cpuUser = Number(m[1]); o.cpuSys = Number(m[2]); o.cpuIdle = Number(m[3]);
  }
  if ((m = s.match(/PhysMem:\s*([\d.]+)([KMG]?)\s*used\s*\(([\d.]+)([KMG]?)\s*wired,\s*([\d.]+)([KMG]?)\s*compressor\),\s*([\d.]+)([KMG]?)\s*unused/))) {
    o.memUsed = toBytes(m[1], m[2]); o.memWired = toBytes(m[3], m[4]); o.memComp = toBytes(m[5], m[6]); o.memUnused = toBytes(m[7], m[8]);
  }
  if ((m = s.match(/([\d,]+)\(\d+\)\s*swapins,\s*([\d,]+)\(\d+\)\s*swapouts/))) {
    o.swapins = Number(m[1].replace(/,/g, '')); o.swapouts = Number(m[2].replace(/,/g, ''));
  }
  if ((m = s.match(/Networks:\s*packets:\s*(\d+)\/([\d.]+)([KMG]?)\s*in,\s*(\d+)\/([\d.]+)([KMG]?)\s*out/))) {
    o.netPktIn = Number(m[1]); o.netByteIn = toBytes(m[2], m[3]); o.netPktOut = Number(m[4]); o.netByteOut = toBytes(m[5], m[6]);
  }
  if ((m = s.match(/Disks:\s*(\d+)\/([\d.]+)([KMG]?)\s*read,\s*(\d+)\/([\d.]+)([KMG]?)\s*written/))) {
    o.diskOpRead = Number(m[1]); o.diskByteRead = toBytes(m[2], m[3]); o.diskOpWrite = Number(m[4]); o.diskByteWrite = toBytes(m[5], m[6]);
  }
  if (topPrev && topPrev.at) {
    const dt = (now - topPrev.at) / 1000;
    if (dt > 0) {
      const d = (a, b) => (a != null && b != null && a >= b) ? (a - b) / dt : 0;
      o.netInRate = d(o.netByteIn, topPrev.netByteIn); o.netOutRate = d(o.netByteOut, topPrev.netByteOut);
      o.netPktInRate = d(o.netPktIn, topPrev.netPktIn); o.netPktOutRate = d(o.netPktOut, topPrev.netPktOut);
      o.diskReadRate = d(o.diskByteRead, topPrev.diskByteRead); o.diskWriteRate = d(o.diskByteWrite, topPrev.diskByteWrite);
      o.diskOpReadRate = d(o.diskOpRead, topPrev.diskOpRead); o.diskOpWriteRate = d(o.diskOpWrite, topPrev.diskOpWrite);
    }
  }
  topPrev = o;
  topCache = o; topCacheAt = now;
  return o;
}
function fmtUptime(sec) {
  if (!sec || sec < 0) return '?';
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d > 0) return d + '天' + h + '时';
  if (h > 0) return h + '时' + m + '分';
  return m + '分';
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
async function getProbes() {
  if (options.noProbes) return [];
  if (probeCache && Date.now() - probeCacheAt < PROBE_TTL_MS) return probeCache;
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
  const cols = process.stdout.columns || 110;
  const twoCol = cols >= 84;
  const leftW = twoCol ? dashboardLayout(cols).left : cols;
  // Leave room for the watch footer and its trailing newline to avoid scrolling.
  const lines = [];

  // 头部
  lines.push(bold('Codex 本地状态') + '  ' + cyan(fmtTs(NOW)));
  lines.push(dim('数据源  ' + CODEX_HOME));
  const model = cfgVal('model') || '?';
  const sandbox = cfgVal('sandbox_mode') || '?';
  const reas = cfgVal('model_reasoning_effort') || '?';
  const mcpN = mcpServerCount();
  let cliVer = '';
  if (ST) { const r = one(ST.db, "SELECT cli_version FROM threads WHERE cli_version<>'' ORDER BY updated_at_ms DESC LIMIT 1"); cliVer = r?.cli_version || ''; }
  lines.push(dim('环境    ') + '模型 ' + cyan(model) + ' · 沙箱 ' + yellow(sandbox) + ' · 推理 ' + (reas || '?') + ' · MCP ' + mcpN + (cliVer ? ' · CLI ' + cliVer : ''));
  lines.push(dim('\u2500'.repeat(twoCol ? leftW : 78)));

  const sampleStarted = Date.now();
  const forceThisSample = forceNetworkRefresh;
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
  const curLogId = LG ? Number(one(LG.db, "SELECT max(id) m FROM logs")?.m || 0) : null;
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
  const tm = topSample();
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
  lines.push(magenta(bold('主机状态')) + '  ' + dim((sys.brand || '?') + ' · ' + (sys.ncpu || '?') + ' 核 · ' + fmtBytes(sys.mem) + ' · up ' + fmtUptime(Math.floor(NOW / 1000) - sys.bootSec)));
  lines.push('  负载  ' + loadCol(bold('1m ' + fmtLoad(load[0]))) + dim(' · 5m ' + fmtLoad(load[1]) + ' · 15m ' + fmtLoad(load[2])) + '（' + (sys.ncpu || '?') + ' 核）');
  if (Number.isFinite(memPct)) lines.push('  内存  ' + memCol(bold(memPct.toFixed(1)) + '%') + dim('（物理已用 ' + fmtBytes(tm.memUsed) + ' / ' + fmtBytes(sys.mem) + '）'));
  lines.push('  CPU   全机 ' + (Number.isFinite(host.cpu.usagePercent) ? bold(host.cpu.usagePercent.toFixed(1) + '%') : '—') + ' · Codex ' + (Number.isFinite(codexCpu) ? codexCpu.toFixed(1) + '%（多核）' : '—') + ' · RSS ' + dashboardBytes(host.processes.rssBytes));
  lines.push('  网络  ' + (netRate >= 0 ? cyan(fmtBytes(Math.round(netRate * 1024)) + '/s') : dim('—')));
  if (tp.length) lines.push('  占用  ' + tp.map(p => (p.cpu > 50 ? red : cyan)(clip(p.name, 18) + ' ' + p.cpu.toFixed(0) + '%')).join(' · '));
  lines.push('');
  lines.push(yellow(bold('活动监视器')) + dim('  top -l 1'));
  if (tm.cpuUser != null) lines.push('  CPU    user ' + bold(tm.cpuUser.toFixed(1)) + '% · sys ' + bold(tm.cpuSys.toFixed(1)) + '% · idle ' + tm.cpuIdle.toFixed(1) + '%');
  if (tm.procTotal != null) lines.push('  进程   ' + bold(String(tm.procTotal)) + '（运行 ' + tm.procRunning + ' · 睡眠 ' + tm.procSleeping + '）· 线程 ' + bold(String(tm.threads)));
  if (tm.memUsed != null) lines.push('  内存   已用 ' + bold(fmtBytes(tm.memUsed)) + '（wired ' + fmtBytes(tm.memWired) + ' · 压缩 ' + fmtBytes(tm.memComp) + '）· 空闲 ' + fmtBytes(tm.memUnused));
  lines.push('  VM     App ' + fmtBytes(anonBytes) + ' · 缓存 ' + fmtBytes(cachedBytes) + ' · swap ' + (swap.used == null ? '—' : swap.used > 0 ? yellow(fmtBytes(swap.used)) : '0') + '/' + fmtBytes(swap.total));
  if (tm.swapins != null) lines.push('  换页   in ' + human(tm.swapins) + ' · out ' + human(tm.swapouts) + '（累计）· ' + fmtSampleRate(pageinRate) + '/s · ' + fmtSampleRate(pageoutRate) + '/s');
  if (tm.netByteIn != null) lines.push('  网络   累计 ↓' + fmtBytes(tm.netByteIn) + ' ' + human(tm.netPktIn) + 'pkt ↑' + fmtBytes(tm.netByteOut) + ' ' + human(tm.netPktOut) + 'pkt');
  if (tm.netPktInRate != null) lines.push('  网速   ↓' + (netInRate >= 0 ? bold(fmtBytes(Math.round(netInRate)) + '/s') : '—') + ' ' + fmtRate(tm.netPktInRate) + 'pkt ↑' + (netOutRate >= 0 ? bold(fmtBytes(Math.round(netOutRate)) + '/s') : '—') + ' ' + fmtRate(tm.netPktOutRate) + 'pkt');
  if (tm.diskByteRead != null) lines.push('  磁盘   累计 读 ' + fmtBytes(tm.diskByteRead) + ' ' + human(tm.diskOpRead) + 'op · 写 ' + fmtBytes(tm.diskByteWrite) + ' ' + human(tm.diskOpWrite) + 'op');
  lines.push('  盘速   读 ' + bold(dashboardBytes(dio.rRate) + '/s') + ' ' + fmtSampleRate(dio.rOpRate) + 'op · 写 ' + bold(dashboardBytes(dio.wRate) + '/s') + ' ' + fmtSampleRate(dio.wOpRate) + 'op');
  if (batt) lines.push('  电池   ' + bold(String(batt.pct)) + '% · ' + batt.state);

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
  lines.push(hdr('[1] 最近一次可见事件'));
  if (newestVisible) {
    lines.push('    类型   : ' + bold(newestVisible.item_type) + (newestVisible.nick ? ' · 来自「' + cyan(newestVisible.nick) + '」' : ''));
    lines.push('    内容   : ' + (describe(newestVisible.item_type, newestVisible.item_json) || '(空)'));
    lines.push('    时间   : ' + cyan(fmtTs(newestVisible.created_at_ms)));
    lines.push('    距现在 : ' + bold(age(newestVisible.created_at_ms)));
  } else {
    lines.push('    （未发现可见事件）');
  }
  const lastAgent = merged.find(r => r.item_type === 'agentMessage');
  const lastUser = merged.find(r => r.item_type === 'userMessage');
  if (lastAgent || lastUser) {
    lines.push('    ----');
    if (lastAgent) lines.push('    最近一条智能体消息 : ' + bold(age(lastAgent.created_at_ms)) + ' · ' + clip(describe('agentMessage', lastAgent.item_json), 90));
    if (lastUser) lines.push('    最近一条用户消息   : ' + bold(age(lastUser.created_at_ms)) + ' · ' + clip(describe('userMessage', lastUser.item_json), 90));
  }
  const recent = merged.slice(0, 6);
  if (recent.length) {
    lines.push('    最近可见事件（倒序）:');
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
  lines.push(hdr('[2] 有没有工具调用没看到完成输出'));
  if (!activity.availability.history || activity.tools.pending == null) lines.push(yellow('    工具数据不可用'));
  else if (hungTools.length) {
    lines.push('    ' + red('疑似挂起 ' + hungTools.length + ' 个') + '（已观测到启动 >5 分钟的未完成项）:');
    for (const u of hungTools.slice(0, 10)) lines.push('      - ' + u.nick + ' : ' + u.item_type + ' · ' + age(u.started_at_ms || u.created_at_ms));
  } else if (unfinishedRecent.length) {
    lines.push('    ' + yellow('有 ' + unfinishedRecent.length + ' 个工具调用刚启动、尚未完成') + '（可能正在执行）:');
    for (const u of unfinishedRecent.slice(0, 10)) lines.push('      - ' + u.nick + ' : ' + u.item_type + ' · ' + age(u.started_at_ms || u.created_at_ms));
  } else {
    lines.push('    ' + green('未发现') + ' —— 当前工具采样未发现近期未完成项。' + (toolLowerBound ? '（有界扫描，未证明全量完整）' : ''));
  }
  if (unfinishedStale > 0) lines.push(dim('    （另有 ' + unfinishedStale + ' 个更早的历史未完成项，多为被中断的旧会话遗留，可忽略。）'));
  const recentRunning = runningTurns.filter(t => !t.stale);
  const staleRunning = activity.turns.staleRunning || 0;
  lines.push('    处于 inProgress 的 turn：共 ' + bold(String(activity.turns.totalRunning ?? '—')) + ' 个，最近 1 小时内 ' + bold(String(activity.turns.recentRunning ?? '—')) + ' 个。');
  const nickById = {};
  if (ST && recentRunning.length) {
    const ids = [...new Set(recentRunning.map(t => t.thread_id))];
    for (const id of ids) {
      const r = one(ST.db, "SELECT id, agent_nickname, name, title FROM threads WHERE id=?", id);
      nickById[id] = r ? label(r, 24) : clip(id, 8);
    }
  }
  for (const t of recentRunning.slice(0, 8)) lines.push('      - 「' + (nickById[t.thread_id] || '?') + '」开始于 ' + age(t.started_at * 1000));
  if (staleRunning) lines.push(dim('    备注：另有 ' + staleRunning + ' 个 inProgress turn 是 1 小时前遗留的（多为历史未收尾会话，可忽略）。'));

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
  lines.push(hdr('[3] 进程 · MCP · 队列 · 目标'));
  lines.push('    进程      : ' + (host.processes.available ? 'app-server ×' + bold(String(appServerProc)) + (appServerProc > 0 ? green(' ✓') : red(' ✗')) + ' · exec-server ×' + execServerProc + ' · code-mode-host ×' + codeModeHostProc : dim('数据不可用')));
  lines.push('    可辨 MCP   : ' + bold(mcpTotal == null ? '—' : String(mcpTotal)) + (mcpDetail.length ? '（' + mcpDetail.slice(0, 3).map(d => d.name + ' ×' + d.n).join('、') + '）' : '') + dim(' · 配置 ' + mcpN + ' 个，未识别子进程不计入'));
  lines.push('    云端队列  : queued_items ' + (queuedItems == null ? dim('—') : queuedItems > 0 ? yellow(String(queuedItems)) : green('0（无积压）')) + ' · revisions ' + (queuedRevs ?? '—'));
  lines.push('    进行中目标 : ' + bold(goalsCount == null ? '—' : String(goalsCount)) + ' 个 · 全部 ' + (activity.goals.total ?? '—'));

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
  lines.push(hdr('[4] 网络探针'));
  lines.push('    本地 IPC  : ' + (ipcSocket ? green('ipc.sock 存在（OK）') : red('未发现 ipc.sock')) + ' · 网络服务 ' + (netServiceProc > 0 ? green('运行中') : red('未发现')));
  if (options.noProbes) lines.push(dim('    外部探针已关闭（--no-probes）'));
  else if (legacyProbeState.sampling && !probeRes.length) lines.push(dim('    默认请求 HTTP 探针正在后台检测…'));
  for (const result of probeRes) {
    const paint = !result.status ? red : result.status >= 400 ? yellow : green;
    lines.push('    ' + result.label.padEnd(18) + ': ' + paint(result.status ? 'HTTP ' + result.status : result.error) + ' · ' + result.latencyMs + 'ms');
  }
  if (probeRes.some(result => result.status >= 400)) lines.push(dim('    HTTP 响应表明链路可达；拒绝响应不代表登录或服务可用。'));

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
  lines.push(hdr('[5] 存储 · 日志 · 用量'));
  lines.push('    累计 token : ' + bold(tokenSum == null ? '—' : human(tokenSum)) + (topModel ? '（未归档累计；近期模型 ' + cyan(topModel) + '）' : ''));
  lines.push('    本次增量   : ' + bold(activity.tokens.monitorDelta == null ? '—' : human(activity.tokens.monitorDelta)) + ' token（累计计数变化）');
  const measuredSpeed = activity.sessions.rows.map(task => performanceCache.byThread[task.id]?.fields.tokensPerSecond).find(Boolean);
  lines.push('    原生速度   : ' + (measuredSpeed ? '缓存 ≈' + measuredSpeed.value.toFixed(1) + ' tok/s · ' + age(measuredSpeed.measuredAt) : '—（尚无匹配的完整观测）'));
  {
    const win = Number(cfgVal('model_context_window')) || 0;
    const auto = Number(cfgVal('model_auto_compact_token_limit')) || 0;
    const comps = merged.filter(r => r.item_type === 'contextCompaction').length;
    lines.push('    上下文     : 窗口 ' + (win ? human(win) : '?') + (auto ? ' · 压缩阈值 ' + human(auto) : '') + (comps > 0 ? ' · 近期压缩 ' + comps + ' 次' : ' · 近期无压缩'));
  }
  lines.push('    缺页率   : ' + bold(fmtSampleRate(faultRate)) + '/s · 换页 ' + fmtSampleRate(pageinRate) + ' in / ' + fmtSampleRate(pageoutRate) + ' out');
  lines.push('    压缩内存 : ' + fmtBytes(compPages * pageSize) + '（原始 ' + fmtBytes(compStored * pageSize) + '）· swap ' + (swapBytes == null ? '—' : swapBytes > 0 ? yellow(fmtBytes(swapBytes)) : '0'));
  if (codexDirSize() > 0) lines.push('    数据目录   : ' + bold(fmtBytes(codexDirSize())) + ' · DB 文件 ' + fmtBytes(dbTotal));
  else lines.push('    DB 文件    : ' + fmtBytes(dbTotal));
  if (topDb) lines.push('    最大 DB    : ' + topDb.f + ' ' + bold(fmtBytes(topDb.s)));
  if (topWal && topWal.s > 50 * 1024 * 1024) lines.push('    WAL 积压   : ' + yellow(topWal.f + ' ' + fmtBytes(topWal.s)) + '（偏大，可能未 checkpoint）');
  else if (topWal) lines.push('    最大 WAL   : ' + topWal.f + ' ' + fmtBytes(topWal.s));
  if (dfAvail) lines.push('    磁盘       : 可用 ' + green(dfAvail) + '（' + dfCap + ' 已用）');
  lines.push('    日志心跳   : ' + (lastLogSec != null ? cyan(age(lastLogSec * 1000)) : '无') + '；近 10 分钟 ERROR=' + (errRecent == null ? '—' : errRecent > 0 ? red(String(errRecent)) : '0') + ' WARN=' + (warnRecent == null ? '—' : warnRecent > 0 ? yellow(String(warnRecent)) : '0') + ' INFO=' + (activity.availability.logs ? lvls.INFO || 0 : '—') + ' DEBUG=' + (activity.availability.logs ? lvls.DEBUG || 0 : '—') + ' TRACE=' + (activity.availability.logs ? lvls.TRACE || 0 : '—'));
  if (errSummary.length) {
    for (const e of errSummary.slice(0, 3)) lines.push('    最近 ERROR : ' + red(clip(String(e.target), 28) + ' ×' + e.c) + ' — ' + errMsg(e.msg));
  }

  // [6] 保守判断
  let verdict;
  const facts = [];
  if (!host.processes.available) facts.push(dim('进程数据不可用')); else if (appServerProc > 0) facts.push(green('应用进程存活')); else facts.push(red('未发现 app-server'));
  facts.push(dim('可辨 MCP ' + (mcpTotal ?? '—') + ' 个'));
  if (queuedItems == null) facts.push(dim('队列未知')); else if (queuedItems > 0) facts.push(yellow('云端队列积压 ' + queuedItems)); else facts.push(green('队列无积压'));
  if (netOk) facts.push(green('HTTP 链路可达')); else if (probeRes.length) facts.push(red('网络探测失败')); else if (options.noProbes) facts.push(dim('HTTP 探针关闭'));
  if (errRecent == null) facts.push(dim('日志告警未知')); else if (errRecent > 0) facts.push(yellow('ERROR=' + errRecent)); else facts.push(green('近 10 分钟无 ERROR'));

  if (!host.processes.available || !activity.availability.history || !activity.availability.state || !Number.isFinite(activity.turns.recentRunning)) verdict = '数据不完整，当前无法判断任务状态';
  else if (appServerProc === 0) verdict = '应用可能已退出/崩溃，需人工介入';
  else if (!netOk && probeRes.length) verdict = '应用存活，但网络异常，可能影响与 OpenAI 的通信';
  else if (hungTools.length > 0) verdict = '有工具调用疑似挂起（超过 5 分钟没有完成输出），需关注';
  else if (activity.turns.recentRunning > 0 && sleepLoopCount >= 3) verdict = '运行中，但最新线程疑似空转轮询（连续 sleep + 空推理），在等外部结果，暂无新产出';
  else if (activity.turns.recentRunning > 0) verdict = '工作中（有近期进行中任务；工具状态以已观测范围为准）';
  else verdict = '当前未发现近期进行中任务（历史遗留项单独列出）';

  lines.push('');
  lines.push(hdr('[6] 当前状态的保守判断'));
  lines.push('    ' + paintVerdict(verdict));
  lines.push(dim('    依据 : ' + facts.join('；')));
  if (sleepLoopCount >= 3) lines.push(yellow('    （检测到最新线程末尾连续 ' + sleepLoopCount + ' 个 sleep 事件，据此判为空转。）'));
  if (errRecent > 0 && errSummary.length) {
    lines.push(dim('    备注 : 近 10 分钟的 ERROR 主要来自「' + clip(String(errSummary[0].target), 28) + '」(' + errMsg(errSummary[0].msg) + ')。'));
  }
  lines.push('');

  lines.splice(4, 0, '状态    ' + paintVerdict(verdict), dim('任务    运行 ' + (activity.turns.recentRunning ?? '—') + ' · 工具执行中 ' + (activity.tools.pending ?? '—') + ' · 队列 ' + (activity.queue.count ?? '—') + ' · 近10m ERROR ' + (activity.alerts.error10m ?? '—')));
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
  return renderLast();
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
    const rows = original.slice(index('[4]'), index('[6]')).filter(line => /本地 IPC|数据目录|DB 文件|最大 DB|WAL|磁盘 |压缩内存|上下文/.test(line));
    information.push({ title: '存储与本地链路', tag: 'STORAGE', tone: 'cyan', rows });
  }
  if (!layout.right) information.unshift({ title: '资源当前值', tag: 'VALUES', tone: 'cyan',
    rows: charts.sections.flatMap(section => section.metrics.map(metric => ({ label: metric.label, value: metric.value, tone: metric.tone }))) });
  if (!layout.right) information.push(systemStatus);
  let secondary = renderInformationSections(information, { width: layout.columns === 2 ? layout.secondary : layout.left, color: COLOR });
  let pinned = header;
  if (uiState.showHelp) {
    pinned = [];
    primary = [
      bold('Codex 监控 · 快捷键'), '',
      '1 总览   2 主机   3 任务   4 诊断',
      'Space / p    暂停或恢复采样',
      '↑ ↓ / j k    滚动左侧信息；宽屏两栏同步滚动',
      'PgUp PgDn    翻页滚动',
      'g / Home     回到顶部',
      '[ / ]        缩短或扩大趋势时间窗口',
      'r            立即重新采集并刷新探针',
      'h / ?        显示或关闭帮助',
      'q / Ctrl-C   退出并恢复终端', '',
      '右侧只显示主机和 Codex 趋势，列表及诊断在左侧。',
      '终端达到 180 列时，左侧自动分成两栏。',
      'Codex 数据只读；JSON 导出不包含消息、命令或日志正文。',
      '内存为物理已用；RSS 求和包含共享页重复。',
      'ps CPU 为系统平均值，全机/逐核 CPU 为区间采样。',
      '缓存 ≈tok/s 保留测量时间，不代表当前生成速度。',
      'HTTP 401/403 只表示收到了响应，不验证登录状态。',
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
    const status = fitRows(renderInformationSections([systemStatus], { width: layout.right, color: COLOR }), Math.max(1, Math.floor(budget / 4)), dim('… 拉高窗口查看全部逐核状态'));
    right = renderResourcePanel(charts, { width: layout.right, height: Math.max(0, budget - status.length - 1), color: COLOR, presentation: 'charts' }).concat('', status);
  }
  return composeColumns(left.rows, right, cols);
}

const HELP = [
  'codex-monitor — 只读 Codex 本地监控台', '用法:',
  '  codex-monitor                         实时监控（默认每 1 秒）',
  '  codex-monitor --once                  单次状态',
  '  node codex-status.mjs                  单次状态',
  '  node codex-status.mjs -w               交互监控',
  '  -i, --interval SEC                    刷新间隔，默认 1s',
  '  --once                                单次输出并退出',
  '  --view overview|host|tasks|diagnostics 启动页面',
  '  --window SEC                          趋势窗口 10–3600s',
  '  --interface NAME                      指定网络接口',
  '  --threads N                           显示任务数 1–30',
  '  --no-probes                           关闭全部外部探针（含公网IP/代理HTTPS）',
  '  --metrics-db PATH                     可选数值快照库',
  '  --json                                单次 JSON；-w 为 JSONL',
  '  --color / --no-color                   强制颜色 / 无颜色',
  '  -h, --help                            帮助', '',
  '快捷键：1–4 切页 · Space 暂停 · ↑↓ 滚动 · [ ] 窗口 · r 刷新 · h 帮助 · q 退出',
].join('\n');

if (options.help) { console.log(HELP); process.exit(0); }

function closeDatabases() {
  networkProbeController.close(); legacyProbeController.close();
  for (const source of [TH, ST, LG, Q, G]) { try { source?.db.close(); } catch {} }
}

if (watch) {
  const terminal = Boolean(process.stdout.isTTY && !options.json);
  const interactive = terminal && process.stdin.isTTY;
  const previousRaw = process.stdin.isRaw;
  const wake = () => { if (wakeWatch) { const resolve = wakeWatch; wakeWatch = null; resolve(); } };
  const decodeKeys = createKeyDecoder();
  const onKey = chunk => {
    if (String(chunk).includes('\x03')) { uiState.quit = true; wake(); return; }
    const wasPaused = uiState.paused;
    for (const key of decodeKeys(chunk)) uiState = reduceKey(uiState, key, lastLeftViewportRows);
    if (wasPaused && !uiState.paused && hist.at.length) {
      for (const key of Object.keys(hist)) pushHist(key, key === 'at' ? Date.now() - 1 : null);
    }
    wake();
  };
  const onSignal = () => { uiState.quit = true; wake(); };
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
        const footer = ' ' + Object.entries(VIEW_NAMES).map(([key, value], i) => (uiState.view === key ? '[' : '') + (i + 1) + ' ' + value + (uiState.view === key ? ']' : '')).join('  ')
          + ' · ' + (uiState.paused ? '已暂停' : interval + 's') + ' · ↑↓滚动 ' + (uiState.leftOffset + 1) + '/' + lastLeftTotal + ' · h 帮助 · q 退出';
        const frame = rendered + '\n' + truncVis(dim(footer), process.stdout.columns || 110);
        process.stdout.write(terminal ? '\x1b[H' + frame.replace(/\n/g, '\x1b[K\n') + '\x1b[K\x1b[0J' : frame + '\n');
      }
      await new Promise(resolve => {
        const timeout = setTimeout(() => { wakeWatch = null; resolve(); }, uiState.paused ? 1000 : Math.max(50, nextSampleAt - Date.now()));
        wakeWatch = () => { clearTimeout(timeout); resolve(); };
      });
    }
  } catch (error) { console.error('监控采集失败：' + error.message); process.exitCode = 1; }
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
  } catch (error) { console.error('监控采集失败：' + error.message); process.exitCode = 1; }
  finally { closeDatabases(); }
}

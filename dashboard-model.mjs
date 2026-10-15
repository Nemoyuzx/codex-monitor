import { compactNumber, duration, padVis, truncVis } from './resource-panel.mjs';
import { createTranslator, getLocale, withLocale } from './i18n.mjs';
import { dashboardCatalog } from './locales/dashboard.mjs';

const t = createTranslator(dashboardCatalog);
const ago = ms => t('{time}前', { time: elapsed(ms) });
const sourceLabels = new Set(['系统 HTTP', '系统 HTTPS', '系统 SOCKS', '直连（系统路由）']);
const collectorLabel = value => sourceLabels.has(value) ? t(value) : value;
const collectorState = (kind, value) => Object.hasOwn(dashboardCatalog, `${kind}.${value}`) ? t(`${kind}.${value}`) : value;
const dashboardResources = Symbol('dashboardResources');
const hostChartKeys = new Set(['cpu', 'load', 'physicalMem', 'network', 'diskRead', 'diskWrite']);

const finite = Number.isFinite;
const number = n => finite(n) ? Number.isInteger(n) && Math.abs(n) < 1000 ? String(n) : compactNumber(n) : '—';
const boundNumber = (value, complete) => finite(value) ? (complete === false ? '≥' : '') + number(value) : '—';
const pct = n => finite(n) ? n.toFixed(1) + '%' : '—';
const tone = (n, lo = 60, hi = 85) => !finite(n) ? 'cyan' : n < lo ? 'green' : n < hi ? 'yellow' : 'red';
export function bytes(n) {
  if (!finite(n) || n < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) { n /= 1024; unit++; }
  return (unit ? Number(n.toFixed(1)) : Math.round(n)) + ' ' + units[unit];
}
const rate = n => finite(n) && n >= 0 ? bytes(n) + '/s' : '—';
const perSecond = n => finite(n) && n >= 0 ? number(n) + '/s' : '—';
const elapsed = ms => !finite(ms) || ms < 0 ? '—' : ms >= 86_400_000
  ? Math.floor(ms / 86_400_000) + 'd' + Math.floor(ms % 86_400_000 / 3_600_000) + 'h'
  : ms >= 3_600_000 ? Math.floor(ms / 3_600_000) + 'h' + Math.floor(ms % 3_600_000 / 60_000) + 'm' : duration(ms / 1000);
const millis = ms => finite(ms) ? ms < 1000 ? Math.round(ms) + 'ms' : (ms / 1000).toFixed(1) + 's' : '—';
const byteScale = { format: n => bytes(n).replace(' ', '') };
const percentScale = { max: 100, format: n => Math.round(n) + '%' };
const row = (label, value, extra = {}) => ({ label, value, ...extra });

function coreRows(cpu, width) {
  const values = cpu?.perCore || [];
  const perRow = Math.max(1, Math.floor((width - 4) / 18));
  const rows = [];
  for (let i = 0; i < values.length; i += perRow) {
    const line = values.slice(i, i + perRow).map((value, j) => {
      const count = finite(value) ? Math.round(value / 100 * 5) : 0;
      return padVis(String(i + j).padStart(2) + ' ' + (finite(value) ? '━'.repeat(count) + '·'.repeat(5 - count) : '     ') + ' ' + pct(value), 18);
    }).join('');
    rows.push(row(i ? '' : t('逐核 CPU'), line.trimEnd(), { priority: 30, optional: true }));
  }
  return rows;
}

function taskRows(activity, now, limit, compact = false) {
  const sessions = activity?.sessions;
  const rows = [row(t('进行中 / 陈旧记录'), number(activity?.turns?.recentRunning) + ' / ' + number(activity?.turns?.staleRunning), { priority: 90 }),
    row(t('未归档 / 主聊天 / 子代理'), [finite(sessions?.total) && finite(sessions?.archived) ? sessions.total - sessions.archived : null, sessions?.main, sessions?.agents].map(number).join(' / '), { priority: 60 }),
    row(t('排队 / 最久等待'), number(activity?.queue?.count) + ' / ' + elapsed(activity?.queue?.oldestWaitMs), { priority: 90 }),
    row(t('目标 · active / 全部'), number(activity?.goals?.active) + ' / ' + number(activity?.goals?.total), { priority: 60 })];
  const entries = (sessions?.rows || []).slice(0, compact ? Math.min(limit, 5) : limit);
  for (const task of entries) {
    const running = task.status === 'running' || task.status === 'inProgress';
    const status = running ? t('运行') : task.status === 'stale' ? t('历史') : task.status === 'unknown' ? t('未知') : t('近期');
    rows.push(row((task.depth ? '↳ ' : '') + task.label,
      status + ' ' + elapsed(task.runningMs) + ' · ' + (task.model || '—') + ' · ' + (finite(task.lastActivityAt) ? ago(now - task.lastActivityAt) : '—'),
      { tone: running ? 'green' : 'cyan', priority: 45, optional: compact }));
  }
  if (!entries.length) rows.push(row(t('任务列表'), activity?.availability?.history ? t('当前没有近期任务') : t('数据源不可用'), { priority: 40 }));
  return rows;
}

function processRows(host, width, limit) {
  const processes = host?.processes;
  const entries = processes?.items || [];
  const counts = Object.entries(processes?.counts || {}).map(([name, count]) => name + '×' + count).join(' · ');
  const rows = [row(t('Codex 进程 / RSS'), (processes?.available ? number(entries.length) : '—') + ' / ' + bytes(processes?.rssBytes), { priority: 90 }),
    row(t('角色'), counts || '—', { priority: 60 })];
  const tableWidth = width - 4;
  rows.push({ label: '', value: padVis(truncVis(padVis('PID', 7) + padVis('CPU%', 8) + padVis('RSS', 11) + t('进程 / 角色'), tableWidth), tableWidth), priority: 50 });
  for (const p of entries.toSorted((a, b) => b.cpuPercent - a.cpuPercent).slice(0, limit)) {
    const text = padVis(String(p.pid), 7) + padVis(finite(p.cpuPercent) ? p.cpuPercent.toFixed(1) : '—', 8)
      + padVis(bytes(p.rssBytes), 11) + p.name + ' · ' + p.role;
    rows.push(row('', padVis(truncVis(text, tableWidth), tableWidth), { priority: 40, optional: true }));
  }
  rows.push(row(t('统计口径'), t('ps %CPU · RSS 求和含共享页'), { priority: 20, optional: true }));
  return rows;
}

function toolRows(activity, compact) {
  const tools = activity?.tools;
  const observed = value => boundNumber(value, activity?.coverage?.recentToolsComplete);
  const rows = [row(t('工具 · 近10m 完成 / 失败'), observed(tools?.completed10m) + ' / ' + observed(tools?.failed10m), { priority: 90 }),
    row(t('工具 · 进行中 / 最久'), boundNumber(tools?.pending, activity?.coverage?.pendingComplete) + ' / ' + elapsed(tools?.oldestPendingMs), { priority: 90 }),
    row(t('工具耗时 P50 / P95'), millis(tools?.p50Ms) + ' / ' + millis(tools?.p95Ms), { priority: 80 }),
    row(t('耗时样本'), number(tools?.durationSampleCount) + t(' · 上报值或已观测区间'), { priority: 40, optional: true })];
  if (!compact) {
    for (const item of (tools?.byType || []).slice(0, 8)) {
      rows.push(row(item.type || item.itemType || t('工具'), t('{completed} 完成 · {failed} 失败', { completed: number(item.completed), failed: number(item.failed) }), { priority: 50 }));
    }
    for (const item of (tools?.pendingRows || []).slice(0, 6)) {
      rows.push(row(t('执行中 {name}', { name: item.label || item.threadLabel || item.type || '' }), elapsed(item.waitMs), { priority: 40, optional: true }));
    }
  }
  if (activity?.coverage?.complete === false) rows.push(row(t('工具统计范围'), t('有界采样 · ≥ 表示已观测下界'), { tone: 'yellow', priority: 95 }));
  return rows;
}

function performanceRows(activity, performance, now) {
  const rows = [row(t('token · 未归档累计'), number(activity?.tokens?.unarchived), { priority: 60 }),
    row(t('token · 本次监控增量'), number(activity?.tokens?.monitorDelta), { priority: 80 }),
    row(t('原生速度'), '—', { priority: 40, optional: true })];
  let foundSpeed = false;
  for (const task of activity?.sessions?.rows || []) {
    const data = performance?.byThread?.[task.id]?.fields;
    if (!data) continue;
    const cachedPair = (label, first, second, format = number) => {
      if (!first && !second) return;
      const text = metric => !metric ? '—' : (metric.lowerBound ? '≥' : metric.approximate ? '≈' : '') + format(metric.value);
      const measuredAt = Math.min(...[first, second].filter(Boolean).map(metric => metric.measuredAt));
      rows.push(row(task.label + ' · ' + label, t('缓存 {values} · {age}', { values: text(first) + ' / ' + text(second), age: ago(now - measuredAt) }), { priority: 35, optional: true }));
    };
    const parts = [], measured = [];
    if (data.tokensPerSecond) {
      const metric = data.tokensPerSecond;
      parts.push('≈' + metric.value.toFixed(1) + ' tok/s'); measured.push(metric.measuredAt);
      foundSpeed = true;
    }
    if (data.firstTokenAvgMs) { parts.push('TTFT ' + millis(data.firstTokenAvgMs.value)); measured.push(data.firstTokenAvgMs.measuredAt); }
    if (data.cacheHitPercent) { parts.push(t('命中 {percent}', { percent: pct(data.cacheHitPercent.value) })); measured.push(data.cacheHitPercent.measuredAt); }
    if (parts.length) rows.push(row(task.label, t('缓存 {values} · {age}', { values: parts.join(' · '), age: ago(now - Math.min(...measured)) }), { priority: 50, optional: true }));
    cachedPair(t('输入 / 输出 token'), data.inputTokens, data.outputTokens);
    cachedPair(t('轮次 / 步骤'), data.rounds, data.steps);
    cachedPair(t('模型 / 工具耗时'), data.llmDurationMs, data.toolDurationMs, millis);
  }
  if (foundSpeed) rows.splice(2, 1);
  if (performance?.available) rows.push(row(t('数值源最近采集'), t('{age} · 缓存快照', { age: ago(performance.sourceAge) }), { priority: 20, optional: true }));
  rows.push(row(t('上下文当前占比'), '—', { priority: 20, optional: true }));
  return rows;
}

function networkProbeRows(state, compact, now) {
  if (!state) return [row(t('公网与代理实测'), '—')];
  if (state.disabled) return [row(t('公网与代理实测'), t('已关闭（--no-probes）'))];
  const result = state.result;
  if (!result) return [row(t('公网与代理实测'), state.sampling ? t('后台检测中…') : state.error ? t('检测暂不可用') : t('尚未检测'))];
  const rows = [row(t('公网与代理实测'), state.sampling ? t('重新检测中 · 以下为上次结果') : t('已完成 · 60s 缓存')),
    row(t('出口检测时间'), finite(result.sampledAt) ? ago(Math.max(0, now - result.sampledAt)) : '—')];
  const targets = [result.direct?.ipLookup?.target, result.direct?.connectivity?.target].filter(Boolean);
  if (targets.length) rows.push(row(t('实测站点'), [...new Set(targets)].join(' / ')));
  const failures = { timeout: t('请求超时'), tcp: t('TCP 连接失败'), dns: t('DNS 解析失败'), proxy: t('代理握手失败'),
    'proxy-auth': t('代理认证失败（407）'), 'proxy-unverified': t('未验证代理路径'), tls: t('TLS 校验/握手失败'),
    http: t('目标 HTTP 未通过'), 'invalid-response': t('响应内容不符合预期'), unavailable: t('检测不可用'), cancelled: t('已取消') };
  const describe = request => {
    if (!request) return '—';
    if (request.status === 'ok') return 'HTTP ' + request.httpStatus + t(' · 总耗时 ') + millis(request.timing?.totalMs);
    const label = failures[request.status] || t('未通过');
    const status = request.httpStatus ? ' · HTTP ' + request.httpStatus : request.proxyHttpStatus && request.status !== 'proxy-auth' ? ' · CONNECT ' + request.proxyHttpStatus : '';
    const spent = finite(request.timing?.totalMs) ? t(' · 耗时 ') + millis(request.timing.totalMs) : '';
    return label + status + spent;
  };
  let proxyIndex = 0;
  for (const route of [result.direct, ...(result.proxies || [])].filter(Boolean)) {
    const label = route.kind === 'direct' ? t('直连') : t('代理{index}', { index: ++proxyIndex });
    if (route.kind !== 'direct') rows.push(row(t('{route} 路径', { route: label }), route.endpoint || '—'));
    rows.push(row(t('{route} 实测状态', { route: label }), ({ ok: t('两个目标均通过'), partial: t('部分目标可达'), failed: t('两个目标均未通过') })[route.status] || '—',
      { tone: route.status === 'ok' ? 'green' : 'yellow' }));
    rows.push(row(t('{route} 公网 IP', { route: label }), route.publicIp || (route.ipLookup?.status === 'ok' ? '—' : '— · ' + (failures[route.ipLookup?.status] || t('查询未完成')))));
    rows.push(row(t('{route} HTTPS', { route: label }), describe(route.connectivity),
      { tone: route.connectivity?.status === 'ok' ? 'green' : 'yellow' }));
    if (!compact) {
      if (route.kind !== 'direct') rows.push(row(t('{route} 配置来源', { route: label }), (route.sources || []).map(collectorLabel).join(' / ') || '—'));
      rows.push(row(t('{route} IP查询 HTTPS', { route: label }), describe(route.ipLookup), { tone: route.ipLookup?.status === 'ok' ? 'green' : 'yellow' }));
      const timing = route.connectivity?.timing;
      rows.push(row(t('{route} DNS / TCP累计', { route: label }), millis(timing?.dnsMs) + ' / ' + millis(timing?.connectMs)),
        row(t('{route} TLS / 首字节累计', { route: label }), millis(timing?.tlsMs) + ' / ' + millis(timing?.ttfbMs)));
      if (route.kind !== 'direct') {
        const verified = [route.connectivity, route.ipLookup].some(request => request?.status === 'ok'
          && (request.proxyUsed === true || request.proxyHttpStatus === 200));
        rows.push(row(t('{route} 路径验证', { route: label }), verified ? t('已验证代理 HTTPS；未回退直连') : t('强制指定代理，尚未验证 HTTPS 成功')));
      }
    }
  }
  if (!result.proxies?.length) rows.push(row(t('显式代理实测'), t('没有可测试的手动/环境代理')));
  if (result.pac?.enabled) rows.push(row(t('PAC 实测'), t('脚本未解析，不作为已验证代理路径')));
  rows.push(row(t('检测口径'), t('直连依系统路由；代理强制指定路径')),
    row(t('延迟口径'), t('HTTPS 请求耗时，含连接/握手/响应')));
  return rows;
}

function networkRows(details, compact, networkProbes, now) {
  const list = values => Array.isArray(values) ? values.length ? values.join(' · ') : t('未配置') : '—';
  const proxy = details?.systemProxy;
  const entries = ['http', 'https', 'socks'].map(key => ({ key, ...proxy?.[key] }));
  const enabled = entries.filter(entry => entry.enabled === true);
  const modes = enabled.map(entry => entry.key.toUpperCase());
  if (proxy?.pac?.enabled) modes.push('PAC');
  if (proxy?.autoDiscovery) modes.push(t('自动发现'));
  const mode = !proxy ? '—' : entries.some(entry => entry.enabled == null) || proxy.pac?.enabled == null || proxy.autoDiscovery == null
    ? t('部分配置未知') : modes.length ? modes.join(' / ') : t('关闭（系统配置）');
  const rows = [row(t('网络接口'), details?.interfaceName || '—'),
    row(t('本机 IPv4'), list(details?.addresses?.ipv4)),
    row(t('默认网关 IPv4'), details?.routes?.ipv4?.gateway || '—'),
    row(t('系统 DNS'), list(details?.dns?.nameservers)),
    row(t('系统代理 · 全局配置'), mode)];
  if (!compact) rows.splice(2, 0, row(t('本机 IPv6'), list(details?.addresses?.ipv6)));
  if (!compact) rows.splice(4, 0, row(t('默认网关 IPv6'), details?.routes?.ipv6?.gateway || '—'));
  for (const entry of compact ? enabled : entries) {
    if (!proxy) continue;
    const state = entry.enabled === true ? entry.endpoint || t('启用，地址未知') : entry.enabled === false ? t('关闭') : '—';
    const probe = { open: t('本机端口可连接'), closed: t('本机端口未连接'), timeout: t('本机端口超时'), unprobed: t('远端端口未探测') }[entry.probe?.status];
    rows.push(row(t('{protocol} 代理', { protocol: entry.key.toUpperCase() }), state + (probe ? ' · ' + probe : ''),
      { tone: ['closed', 'timeout'].includes(entry.probe?.status) ? 'yellow' : 'cyan' }));
  }
  if (proxy?.pac?.enabled || !compact) rows.push(row('PAC', !proxy ? '—' : proxy.pac?.enabled ? proxy.pac.url || t('启用，地址未知') : t('关闭')));
  if (!compact) rows.push(row(t('代理自动发现'), !proxy ? '—' : proxy.autoDiscovery == null ? '—' : proxy.autoDiscovery ? t('开启') : t('关闭')),
    row(t('系统绕过规则'), proxy ? list(proxy.bypass) : '—'));
  const env = details?.environmentProxy;
  const configured = (env || []).filter(entry => entry.present && entry.name.toUpperCase() !== 'NO_PROXY');
  if (compact) rows.push(row(t('当前进程环境代理'), !Array.isArray(env) ? '—' : configured.length ? [...new Set(configured.map(entry => entry.endpoint || t('格式不可识别')))].join(' · ') : t('未设置')));
  else {
    if (!configured.length) rows.push(row(t('当前进程环境代理'), Array.isArray(env) ? t('未设置') : '—'));
    for (const entry of configured) rows.push(row(t('环境 {name}', { name: entry.name }), entry.endpoint || t('已设置，格式不可识别')));
    for (const entry of env || []) if (entry.present && entry.name.toUpperCase() === 'NO_PROXY') rows.push(row(t('环境 {name}', { name: entry.name }), t('{count} 条绕过规则', { count: entry.entryCount })));
    rows.push(row(t('检测到隧道接口'), list(details?.tunnelInterfaces)),
      row(t('网络配置采集时间'), Number.isFinite(details?.sampledAt) ? new Date(details.sampledAt).toLocaleTimeString(getLocale(), { hour12: false }) : '—'));
  }
  rows.push(row(t('代理口径'), t('配置不代表应用实际请求路径；下方为独立实测')));
  rows.push(...networkProbeRows(networkProbes, compact, now));
  return rows;
}

export function buildDashboard(options) {
  return options.locale ? withLocale(options.locale, () => buildLocalizedDashboard(options)) : buildLocalizedDashboard(options);
}

function buildLocalizedDashboard({ host, activity, performance, sys, tm, load, pressurePercent, swap, hist, now, windowSeconds,
  probes = [], storage = {}, sampleMs, intervalMs, networkDetails, networkProbes, legacyProbeState, view = 'overview', width = 100, limit = 8, noProbes = false }) {
  const history = key => hist[key] || [];
  const metric = (label, value, key, options = {}) => ({ label, value, historyKey: key, values: history(key), priority: 70, ...options });
  const memoryPercent = finite(tm?.memUsed) && sys?.mem > 0 ? tm.memUsed / sys.mem * 100 : null;
  const cpuPercent = host?.cpu?.usagePercent;
  const capacity = host?.cpu?.logicalCores || sys?.ncpu;
  const net = host?.network, disk = host?.disk, proc = host?.processes;
  const networkTotal = finite(net?.inRate) && finite(net?.outRate) ? net.inRate + net.outRate : null;
  const hostMetrics = [
    metric(t('CPU · 全机'), pct(cpuPercent), 'cpu', { tone: tone(cpuPercent), scale: percentScale, meter: cpuPercent, detail: t('逐核累计时间差分'), priority: 100 }),
    metric(t('CPU 负载 · 1m'), finite(load?.[0]) ? load[0].toFixed(2) : '—', 'load', {
      tone: tone(capacity && finite(load?.[0]) ? load[0] / capacity * 100 : null, 60, 100),
      detail: t('5m {five} · 15m {fifteen} · {cores} 核', { five: number(load?.[1]), fifteen: number(load?.[2]), cores: number(capacity) }),
      scale: { max: Math.max(capacity || 1, ...history('load').filter(finite)) * 1.1 }, priority: 75 }),
    metric(t('物理内存'), pct(memoryPercent), 'physicalMem', { tone: tone(memoryPercent, 80, 95), scale: percentScale,
      detail: bytes(tm?.memUsed) + ' / ' + bytes(sys?.mem), priority: 95 }),
    metric(t('网络 · {interface}', { interface: net?.interfaceName || '—' }), rate(networkTotal), 'network', { tone: 'cyan', scale: byteScale,
      detail: '↓ ' + rate(net?.inRate) + '  ↑ ' + rate(net?.outRate), priority: 90 }),
    metric(t('磁盘读取'), rate(disk?.readRate), 'diskRead', { tone: 'cyan', scale: byteScale, detail: number(disk?.readIOPS) + ' IOPS', priority: 65 }),
    metric(t('磁盘写入'), rate(disk?.writeRate), 'diskWrite', { tone: 'magenta', scale: byteScale, detail: number(disk?.writeIOPS) + ' IOPS', priority: 65 }),
  ];
  if (view === 'host') hostMetrics.push(
    metric(t('网络下载'), rate(net?.inRate), 'networkIn', { scale: byteScale, detail: t('累计 {value}', { value: bytes(net?.inBytes) }), tone: 'cyan', priority: 60 }),
    metric(t('网络上传'), rate(net?.outRate), 'networkOut', { scale: byteScale, detail: t('累计 {value}', { value: bytes(net?.outBytes) }), tone: 'magenta', priority: 60 }),
    metric(t('内存压力估计'), finite(pressurePercent) && pressurePercent >= 0 ? pressurePercent + '%' : '—', 'mem', { scale: percentScale, detail: t('memory_pressure 报告的非空闲占比'), priority: 55 }),
    metric(t('缺页率'), perSecond(history('faultRate').at(-1)), 'faultRate', { tone: 'cyan', detail: t('包含普通缺页，不等同磁盘换页'), priority: 55 }),
    metric(t('swap 已用'), bytes(swap?.used), 'swap', { tone: 'cyan', scale: byteScale, detail: t('已分配 {value}', { value: bytes(swap?.total) }), priority: 40 }),
  );
  const hostRows = coreRows(host?.cpu, width);
  if (host?.power) hostRows.push(row(t('电源'), pct(host.power.pct) + ' · ' + collectorState('power', host.power.state) + (finite(host.power.remainingMinutes) ? ' · ' + host.power.remainingMinutes + 'm' : ''), { key: 'power', priority: 35, optional: true }));
  if (host?.pressure) hostRows.push(row(t('系统压力'), collectorState('pressure', host.pressure.state) || String(host.pressure.level), { key: 'pressure', priority: 50, optional: true }));
  const codexMetrics = [
    metric(t('Codex CPU · 多核'), pct(proc?.cpuPercent), 'codexCpu', { tone: tone(capacity && finite(proc?.cpuPercent) ? proc.cpuPercent / capacity : null),
      detail: t('ps %CPU · 单核 100%'), scale: { max: Math.max(100, ...history('codexCpu').filter(finite)) * 1.1, format: n => number(n) + '%' }, priority: 100 }),
    metric('Codex RSS', bytes(proc?.rssBytes), 'codexRss', { tone: 'magenta', scale: byteScale,
      detail: t('{count} 进程 · 含共享页重复', { count: number(proc?.items?.length) }), priority: 95 }),
    metric(t('工具完成 · 10m均值'), finite(activity?.tools?.completed10m) ? (activity?.coverage?.recentToolsComplete === false ? '≥' : '') + perSecond(activity.tools.completed10m / 600) : '—', 'toolRate', {
      tone: 'cyan', detail: t('{count} 个已观测执行中', { count: number(activity?.tools?.pending) }), priority: 70 }),
    metric(t('日志新增'), perSecond(history('activity').at(-1)), 'activity', { tone: 'magenta', detail: t('按实际采样时间计算'), priority: 60 }),
  ];
  const hostSection = { title: t('主机资源'), tag: 'HOST', tone: 'cyan', priority: 100, metrics: hostMetrics, rows: hostRows,
    footer: t('压缩 {value} · swap {swap}', { value: bytes(tm?.memComp), swap: bytes(swap?.used) }) };
  const codexSection = { title: t('Codex 资源'), tag: 'CODEX', tone: 'magenta', priority: 95, metrics: codexMetrics };
  const tasks = { title: t('任务与队列'), tag: 'TASKS', tone: 'cyan', priority: 85, rows: taskRows(activity, now, limit, view === 'overview') };
  const processes = { title: t('Codex 进程排行'), tag: 'PROCESSES', tone: 'magenta', priority: 55, optional: view === 'overview', rows: processRows(host, width, view === 'overview' ? 3 : 10) };
  const tools = { title: t('工具与性能'), tag: 'TOOLS', tone: 'cyan', priority: 70, rows: toolRows(activity, view === 'overview') };
  const perf = { title: t('Token 与已采集性能'), tag: 'METRICS', tone: 'magenta', priority: 60, optional: view === 'overview', rows: performanceRows(activity, performance, now) };
  const diagnosticRows = [
    row(t('近10m ERROR / WARN'), number(activity?.alerts?.error10m) + ' / ' + number(activity?.alerts?.warn10m), { tone: activity?.alerts?.error10m > 0 ? 'yellow' : 'green', priority: 100 }),
    row(t('ERROR / WARN · 每分钟'), number(activity?.alerts?.errorPerMinute) + ' / ' + number(activity?.alerts?.warnPerMinute), { priority: 70 }),
    row(t('采集耗时 / 目标间隔'), millis(sampleMs) + ' / ' + millis(intervalMs), { priority: 80, tone: finite(sampleMs) && sampleMs > intervalMs ? 'yellow' : 'cyan' }),
  ];
  if (noProbes) diagnosticRows.push(row(t('HTTP 探针'), t('已关闭'), { priority: 80 }));
  else if (legacyProbeState?.sampling) diagnosticRows.push(row(t('默认请求 HTTP 探针'), t('正在后台检测'), { priority: 80 }));
  for (const probe of probes) diagnosticRows.push(row(collectorLabel(probe.label),
    (probe.status ? 'HTTP ' + probe.status : probe.error || '—') + ' · ' + millis(probe.latencyMs),
    { tone: !probe.status ? 'red' : probe.status >= 400 ? 'yellow' : 'green', priority: 60, optional: view === 'overview' }));
  if (probes.some(probe => [401, 403, 429].includes(probe.status))) diagnosticRows.push(row(t('HTTP 拒绝响应'), t('链路可达，未验证登录或服务可用性'), { priority: 60, optional: view === 'overview' }));
  if (view === 'diagnostics') {
    diagnosticRows.push(row('DB / WAL', bytes(storage.dbBytes) + ' / ' + bytes(storage.walBytes), { priority: 70 }),
      row(t('磁盘可用'), storage.diskAvailable || '—', { priority: 70 }),
      row(t('数据源采集'), activity?.sampledAt ? ago(now - activity.sampledAt) : '—', { priority: 65 }));
    for (const alert of (activity?.alerts?.recent || []).slice(0, 8)) diagnosticRows.push(row(alert.level + ' ' + alert.target,
      ago(now - alert.at) + (alert.count > 1 ? ' ×' + alert.count : ''), { tone: alert.level === 'ERROR' ? 'red' : 'yellow', priority: 50 }));
    for (const [source, available] of Object.entries(activity?.availability || {})) diagnosticRows.push(row(t('数据源 {source}', { source }), available ? t('只读可用') : t('不可用'), { tone: available ? 'green' : 'yellow', priority: 50 }));
  }
  const diagnostics = { title: t('链路与告警'), tag: 'HEALTH', tone: 'yellow', priority: 80, rows: diagnosticRows };
  const network = { title: t('IP · 路由 · 代理'), tag: 'NETWORK', tone: 'cyan', priority: 75, rows: networkRows(networkDetails, view !== 'diagnostics', networkProbes, now) };
  const pages = { overview: [hostSection, codexSection, tasks, tools, processes, diagnostics, perf, network],
    host: [hostSection, network, processes], tasks: [tasks, tools, perf], diagnostics: [network, diagnostics, tools, perf] };
  const model = { sections: pages[view] || pages.overview, times: hist.at || [], now, windowSeconds, locale: getLocale() };
  // Regions reuse already-built resources rather than rebuilding every task,
  // process, network and performance row to obtain the overview charts.
  Object.defineProperty(model, dashboardResources, { value: [hostSection, codexSection] });
  return model;
}

// The right pane stays dedicated to eight resource trends. Lists and detailed
// statistics have a separate model so text can never squeeze the plot height.
export function buildDashboardRegions(options, layout = {}) {
  return options.locale ? withLocale(options.locale, () => buildLocalizedRegions(options, layout)) : buildLocalizedRegions(options, layout);
}

function buildLocalizedRegions(options, { detailWidth = 68 } = {}) {
  const active = buildDashboard({ ...options, width: detailWidth + 4 });
  const resources = active[dashboardResources];
  const rightSections = resources.map(section => ({
    ...section, rows: [], footer: undefined,
    metrics: section.metrics.filter(metric => section.tag === 'CODEX' ? ['codexCpu', 'codexRss'].includes(metric.historyKey) : hostChartKeys.has(metric.historyKey)),
  }));
  const chartKeys = new Set(rightSections.flatMap(section => section.metrics.map(metric => metric.historyKey)));
  const information = active.sections.map(section => ({
    ...section, metrics: [],
    title: section.tag === 'HOST' ? t('主机扩展指标') : section.tag === 'CODEX' ? t('Codex 活动') : section.title,
    rows: [
      ...(section.metrics || []).filter(metric => !chartKeys.has(metric.historyKey)).map(metric => row(metric.label, metric.value, { tone: metric.tone, key: metric.historyKey })),
      ...(section.tag === 'HOST' ? [] : section.rows || []),
    ],
  })).filter(section => section.rows.length);
  if (!options.view || options.view === 'overview') {
    const order = ['NETWORK', 'TASKS', 'TOOLS', 'PROCESSES', 'HOST', 'CODEX', 'HEALTH', 'METRICS'];
    information.sort((a, b) => order.indexOf(a.tag) - order.indexOf(b.tag));
  }
  const systemStatus = { title: t('逐核与系统状态'), tag: 'SYSTEM', tone: 'cyan', rows: [
    ...coreRows(options.host?.cpu, Math.max(18, (options.width || 100) - 6)),
    ...(resources.find(section => section.tag === 'HOST')?.rows || []).filter(row => ['power', 'pressure'].includes(row.key)),
  ] };
  return { charts: { ...active, sections: rightSections }, information, systemStatus };
}

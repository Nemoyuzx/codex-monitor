import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboard, buildDashboardRegions } from './dashboard-model.mjs';
import { renderResourcePanel, visLen } from './resource-panel.mjs';

function sample(overrides = {}) {
  return {
    now: 1_000_000, windowSeconds: 80, hist: { at: [1_000_000] },
    host: { cpu: { logicalCores: 12, usagePercent: 20, perCore: Array(12).fill(20) },
      processes: { available: true, items: [{ pid: 12, name: 'codex', role: 'app-server', cpuPercent: 36, rssBytes: 1e8 }],
        cpuPercent: 36, rssBytes: 1e8, counts: { 'app-server': 1 }, topCpu: [{ pid: 99, name: 'unrelated', cpuPercent: 90, rssBytes: 1e9 }] },
      network: { interfaceName: 'en0', inRate: 100, outRate: 200 }, disk: { readRate: 300, writeRate: 400 } },
    activity: { sessions: { total: 10, archived: 3, main: 5, agents: 2, rows: [{ id: 'task', label: '任务甲', lastActivityAt: null, runningMs: null, status: 'recent' }] },
      turns: { recentRunning: 1, staleRunning: 2 }, tools: { window10m: { completed: 99, failed: 3 }, completed10m: 600, failed10m: 3, pending: 0, byType: [] },
      coverage: { complete: false, recentToolsComplete: false, pendingComplete: false }, tokens: {}, alerts: {}, queue: {}, goals: {} },
    sys: { mem: 24e9, ncpu: 12 }, tm: { memUsed: 12e9 }, load: [3, 4, 5], swap: { used: null, total: null }, ...overrides,
  };
}

test('dashboard uses physical memory, completion timestamps and Codex-only process rows', () => {
  const dashboard = buildDashboard(sample());
  const metrics = dashboard.sections.flatMap(section => section.metrics || []);
  assert.equal(metrics.find(metric => metric.label === '物理内存').value, '50.0%');
  assert.equal(metrics.find(metric => metric.label.startsWith('工具完成')).value, '≥1/s');
  const processes = dashboard.sections.find(section => section.tag === 'PROCESSES');
  assert.ok(processes.rows.some(row => row.value?.includes('codex')));
  assert.ok(!processes.rows.some(row => row.value?.includes('unrelated')));
  assert.ok(dashboard.sections.flatMap(section => section.rows || []).some(row => row.label === '工具统计范围'));
  const tasks = dashboard.sections.find(section => section.tag === 'TASKS');
  assert.equal(tasks.rows.find(row => row.label.startsWith('未归档')).value, '7 / 5 / 2');
  assert.ok(tasks.rows.find(row => row.label === '任务甲').value.endsWith('· —'));
});

test('absent system and telemetry data remain unknown on every page', () => {
  for (const view of ['overview', 'host', 'tasks', 'diagnostics']) {
    const model = buildDashboard(sample({ host: {}, activity: {}, sys: {}, tm: {}, view }));
    const metrics = model.sections.flatMap(section => section.metrics || []);
    for (const metric of metrics.filter(metric => /全机|物理内存|Codex CPU|RSS|工具完成/.test(metric.label))) assert.equal(metric.value, '—');
    const rendered = renderResourcePanel(model, { width: 108, height: 70, color: true });
    assert.ok(rendered.length <= 70);
    assert.ok(rendered.every(line => visLen(line) <= 108));
    assert.ok(!rendered.join('\n').includes('null'));
  }
});

test('cached native performance always carries provenance and an age', () => {
  const model = buildDashboard(sample({ view: 'tasks', performance: { available: true, sourceAge: 3_600_000,
    byThread: { task: { fields: { tokensPerSecond: { value: 23.5, measuredAt: 900_000 }, firstTokenAvgMs: { value: 1200, measuredAt: 800_000 } } } } } }));
  const rows = model.sections.find(section => section.tag === 'METRICS').rows;
  const measured = rows.find(row => row.label === '任务甲');
  assert.ok(measured.value.includes('缓存 ≈23.5 tok/s'));
  assert.ok(measured.value.includes('3m20s前'));
  assert.equal(rows.find(row => row.label === '上下文当前占比').value, '—');
});

test('resource charts stay separate from tasks, processes and diagnostics on every page', () => {
  for (const view of ['overview', 'host', 'tasks', 'diagnostics']) {
    const { charts, information, systemStatus } = buildDashboardRegions(sample({ view }), { detailWidth: 68 });
    assert.deepEqual(charts.sections.map(section => section.tag), ['HOST', 'CODEX']);
    assert.equal(charts.sections.flatMap(section => section.metrics).length, 8);
    assert.ok(charts.sections.every(section => !section.rows.length));
    assert.ok(information.every(section => !section.metrics.length));
    assert.ok(systemStatus.rows.some(row => row.label === '逐核 CPU'));
    assert.ok(!information.some(section => section.rows.some(row => row.label === '逐核 CPU')));
    const tags = information.map(section => section.tag);
    if (view === 'overview' || view === 'tasks') assert.ok(tags.includes('TASKS') && tags.includes('TOOLS') && tags.includes('METRICS'));
    if (view === 'overview' || view === 'host') assert.ok(tags.includes('PROCESSES'));
    if (view === 'overview' || view === 'diagnostics') assert.ok(tags.includes('HEALTH'));
  }
});

test('network addresses, routes and proxy configuration are left-side information', () => {
  const regions = buildDashboardRegions(sample({ view: 'diagnostics', width: 98, networkDetails: {
    interfaceName: 'en0', sampledAt: 900_000,
    addresses: { ipv4: ['192.0.2.3'], ipv6: ['2001:db8::3'] },
    routes: { ipv4: { gateway: '192.0.2.1' }, ipv6: { gateway: '2001:db8::1' } },
    dns: { nameservers: ['192.0.2.53'] },
    systemProxy: { http: { enabled: true, endpoint: 'http://127.0.0.1:7890', probe: { status: 'open' } },
      https: { enabled: false }, socks: { enabled: false }, pac: { enabled: false }, autoDiscovery: false, bypass: ['localhost'] },
    environmentProxy: [{ name: 'HTTP_PROXY', present: true, endpoint: 'http://127.0.0.1:7890', valid: true }],
    tunnelInterfaces: ['utun2'],
  } }));
  const network = regions.information.find(section => section.tag === 'NETWORK');
  const text = JSON.stringify(network.rows);
  for (const value of ['192.0.2.3', '192.0.2.1', '2001:db8::3', '192.0.2.53', 'HTTP_PROXY', '本机端口可连接', 'utun2']) assert.ok(text.includes(value));
  assert.ok(text.includes('实际请求路径'));
  assert.ok(!JSON.stringify(regions.charts).includes('HTTP_PROXY'));
});

function networkResult(overrides = {}) {
  const request = { status: 'ok', httpStatus: 204, proxyUsed: true, proxyHttpStatus: 200,
    timing: { dnsMs: 1, connectMs: 2, tlsMs: 20, ttfbMs: 80, totalMs: 100 } };
  return { sampledAt: 800_000, disabled: false,
    direct: { kind: 'direct', status: 'ok', publicIp: '1.1.1.1', connectivity: { ...request, proxyUsed: false, proxyHttpStatus: null },
      ipLookup: { ...request, httpStatus: 200, proxyUsed: false } },
    proxies: [{ kind: 'proxy', endpoint: 'http://127.0.0.1:7890', sources: ['system.http'], status: 'ok', publicIp: '8.8.8.8',
      connectivity: request, ipLookup: { ...request, httpStatus: 200 } }], ...overrides };
}

test('public IP and successful HTTPS probes remain distinct per route with actual measurement age', () => {
  const model = buildDashboard(sample({ view: 'diagnostics', networkProbes: {
    sampledAt: 999_999, sampling: true, result: networkResult(),
  } }));
  const rows = model.sections.find(section => section.tag === 'NETWORK').rows;
  assert.equal(rows.find(row => row.label === '直连 公网 IP').value, '1.1.1.1');
  assert.equal(rows.find(row => row.label === '代理1 公网 IP').value, '8.8.8.8');
  assert.equal(rows.find(row => row.label === '出口检测时间').value, '3m20s前');
  assert.match(rows.find(row => row.label === '公网与代理实测').value, /上次结果/);
  assert.match(rows.find(row => row.label === '代理1 HTTPS').value, /HTTP 204.*100ms/);
  assert.match(rows.find(row => row.label === '代理1 路径验证').value, /已验证代理 HTTPS/);
});

test('failed proxy probes never appear as a successful zero latency or inherit the direct exit', () => {
  const failed = { kind: 'proxy', endpoint: 'http://127.0.0.1:7890', status: 'failed', publicIp: null,
    connectivity: { status: 'proxy-auth', proxyUsed: true, proxyHttpStatus: 407, httpStatus: null, timing: { totalMs: 80 } },
    ipLookup: { status: 'timeout', timing: { totalMs: 5000 } } };
  const model = buildDashboard(sample({ view: 'diagnostics', networkProbes: { result: networkResult({ proxies: [failed] }) } }));
  const rows = model.sections.find(section => section.tag === 'NETWORK').rows;
  assert.match(rows.find(row => row.label === '代理1 HTTPS').value, /认证失败/);
  assert.equal(rows.find(row => row.label === '代理1 实测状态').value, '两个目标均未通过');
  assert.ok(!rows.find(row => row.label === '代理1 公网 IP').value.includes('1.1.1.1'));
  assert.ok(!rows.find(row => row.label === '代理1 HTTPS').value.includes('总耗时 0ms'));
  assert.match(rows.find(row => row.label === '代理1 路径验证').value, /尚未验证 HTTPS 成功/);
});

test('disabled external probes are explicitly disabled and partial successes stay partial', () => {
  const disabled = buildDashboard(sample({ networkProbes: { disabled: true } }));
  assert.ok(disabled.sections.find(section => section.tag === 'NETWORK').rows.some(row => /已关闭/.test(row.value)));
  const partial = networkResult(); partial.proxies[0].status = 'partial'; partial.proxies[0].publicIp = null;
  partial.proxies[0].ipLookup = { status: 'http', httpStatus: 403, timing: { totalMs: 60 } };
  const model = buildDashboard(sample({ networkProbes: { result: partial } }));
  const rows = model.sections.find(section => section.tag === 'NETWORK').rows;
  assert.equal(rows.find(row => row.label === '代理1 实测状态').value, '部分目标可达');
  assert.match(rows.find(row => row.label === '代理1 HTTPS').value, /HTTP 204/);
});

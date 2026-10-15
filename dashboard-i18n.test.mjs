import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboard, buildDashboardRegions } from './dashboard-model.mjs';
import { dashboardCatalog } from './locales/dashboard.mjs';
import { getLocale, withLocale } from './i18n.mjs';
import { renderResourcePanel, visLen } from './resource-panel.mjs';

const locales = ['zh-CN', 'zh-TW', 'en', 'ja'];
const views = ['overview', 'host', 'tasks', 'diagnostics'];
const sample = (overrides = {}) => ({
  now: 1_000_000, windowSeconds: 80, width: 100,
  hist: { at: [800_000, 900_000, 1_000_000], cpu: [10, 20, 30], codexCpu: [1, 2, 3], activity: [0, 1, 2] },
  host: {
    cpu: { logicalCores: 2, usagePercent: 20, perCore: [10, 30] },
    power: { pct: 100, state: 'charged' }, pressure: { state: 'normal', level: 1 },
    processes: { available: true, items: [{ pid: 12, name: '我的进程', role: 'app-server', cpuPercent: 36, rssBytes: 1e8 }], cpuPercent: 36, rssBytes: 1e8, counts: { 'app-server': 1 } },
    network: { interfaceName: 'en0', inRate: 100, outRate: 200, inBytes: 1000, outBytes: 2000 },
    disk: { readRate: 300, writeRate: 400, readIOPS: 1, writeIOPS: 2 },
  },
  activity: {
    sampledAt: 900_000,
    sessions: { total: 10, archived: 3, main: 5, agents: 2,
      rows: [{ id: 'task', label: '用户自定任务', lastActivityAt: 900_000, runningMs: 30_000, status: 'running', model: '用户模型' }] },
    turns: { recentRunning: 1, staleRunning: 2 },
    tools: { completed10m: 600, failed10m: 3, pending: 1, oldestPendingMs: 500, p50Ms: 10, p95Ms: 30, durationSampleCount: 50,
      byType: [{ type: '自定工具', completed: 50, failed: 1 }], pendingRows: [{ label: '用户工具说明', waitMs: 500 }] },
    coverage: { complete: false, recentToolsComplete: false, pendingComplete: false },
    tokens: { unarchived: 100, monitorDelta: 10 }, alerts: { error10m: 0, warn10m: 2, recent: [{ level: 'WARN', target: '自定日志来源', at: 900_000, count: 2 }] },
    queue: { count: 1, oldestWaitMs: 1000 }, goals: { active: 1, total: 2 }, availability: { history: true, logs: false },
  },
  performance: { available: true, sourceAge: 100_000, byThread: { task: { fields: {
    tokensPerSecond: { value: 23.5, measuredAt: 900_000 }, cacheHitPercent: { value: 80, measuredAt: 900_000 },
    inputTokens: { value: 20, measuredAt: 900_000 }, outputTokens: { value: 30, measuredAt: 900_000 },
    rounds: { value: 2, measuredAt: 900_000 }, steps: { value: 4, measuredAt: 900_000 },
    llmDurationMs: { value: 1500, measuredAt: 900_000 }, toolDurationMs: { value: 500, measuredAt: 900_000 },
  } } } },
  networkDetails: {
    interfaceName: 'en0', sampledAt: 900_000,
    addresses: { ipv4: ['192.0.2.3'], ipv6: ['2001:db8::3'] },
    routes: { ipv4: { gateway: '192.0.2.1' }, ipv6: { gateway: '2001:db8::1' } }, dns: { nameservers: ['192.0.2.53'] },
    systemProxy: { http: { enabled: true, endpoint: 'http://127.0.0.1:7890', probe: { status: 'open' } }, https: { enabled: false }, socks: { enabled: false },
      pac: { enabled: true, url: 'https://example.test/代理.pac' }, autoDiscovery: false, bypass: ['localhost'] },
    environmentProxy: [{ name: 'HTTP_PROXY', present: true, endpoint: 'http://127.0.0.1:7890' }, { name: 'NO_PROXY', present: true, entryCount: 2 }],
    tunnelInterfaces: ['utun2'],
  },
  probes: [{ label: '原始探针标签', error: '原始错误信息', latencyMs: 50 }, { label: 'chatgpt.com', status: 403, latencyMs: 100 }],
  sys: { mem: 24e9, ncpu: 2 }, tm: { memUsed: 12e9, memComp: 1e9 }, load: [1, 2, 3], swap: { used: 100, total: 1000 },
  ...overrides,
});

const byTag = (model, tag) => model.sections.find(section => section.tag === tag);
const request = (status = 'ok') => ({ status, httpStatus: status === 'ok' ? 204 : null, proxyHttpStatus: 200, proxyUsed: true,
  timing: { dnsMs: 1, connectMs: 2, tlsMs: 20, ttfbMs: 80, totalMs: 100 } });
const probeResult = (status = 'ok') => ({ sampledAt: 800_000, pac: { enabled: true },
  direct: { kind: 'direct', publicIp: '192.0.2.10', status: 'ok', connectivity: request(), ipLookup: request() },
  proxies: [{ kind: 'proxy', endpoint: 'http://127.0.0.1:7890', status: status === 'ok' ? 'ok' : 'failed', publicIp: null,
    sources: ['系统 HTTP', 'system.https', 'environment.HTTP_PROXY', '自定义来源'], connectivity: request(status), ipLookup: request('timeout') }],
});

test('dashboard catalogs provide all four locales with matching template placeholders', () => {
  for (const [key, translations] of Object.entries(dashboardCatalog)) {
    const placeholders = text => [...text.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map(match => match[1]).sort();
    for (const locale of locales) {
      assert.equal(typeof translations[locale], 'string', `${key}: ${locale}`);
      assert.ok(translations[locale].length, `${key}: ${locale}`);
      assert.deepEqual(placeholders(translations[locale]), placeholders(translations['zh-CN']), `${key}: ${locale}`);
    }
  }
});

test('every language keeps all eight chart identities, values and system rows on all pages', () => {
  const expectedKeys = ['cpu', 'load', 'physicalMem', 'network', 'diskRead', 'diskWrite', 'codexCpu', 'codexRss'];
  for (const locale of locales) for (const view of views) {
    const regions = buildDashboardRegions(sample({ locale, view }), { detailWidth: 68 });
    const metrics = regions.charts.sections.flatMap(section => section.metrics);
    assert.deepEqual(metrics.map(metric => metric.historyKey), expectedKeys, `${locale}: ${view}`);
    assert.equal(metrics[0].value, '20.0%');
    assert.equal(metrics[2].value, '50.0%');
    assert.deepEqual(regions.systemStatus.rows.filter(row => row.key).map(row => row.key), ['power', 'pressure']);
    assert.ok(regions.information.every(section => !section.metrics.length));
    assert.ok(regions.charts.sections.every(section => !section.rows.length));
    assert.ok(!regions.information.some(section => section.rows.some(row => ['power', 'pressure'].includes(row.key))));
    if (view === 'overview' || view === 'tasks') {
      const task = regions.information.find(section => section.tag === 'TASKS').rows.find(row => row.label === '用户自定任务');
      assert.equal(task.tone, 'green', 'tone must follow the status code, not the translated word');
    }
  }
});

test('explicit locales are scoped, while an omitted locale follows the render context', () => {
  const previous = getLocale();
  withLocale('en', () => {
    assert.equal(byTag(buildDashboard(sample()), 'HOST').title, 'Host resources');
    assert.equal(byTag(buildDashboard(sample({ locale: 'ja' })), 'HOST').title, 'ホストリソース');
    assert.equal(getLocale(), 'en');
    assert.equal(buildDashboardRegions(sample({ locale: 'zh-TW' })).systemStatus.title, '逐核與系統狀態');
    assert.equal(getLocale(), 'en');
  });
  assert.equal(getLocale(), previous);
});

test('standalone model and region rendering retain the locale after the build scope ends', () => {
  const titles = { 'zh-CN': '资源监视', 'zh-TW': '資源監視', en: 'Resources', ja: 'リソース監視' };
  const previous = getLocale();
  for (const locale of locales) {
    const model = buildDashboard(sample({ locale }));
    const { charts } = buildDashboardRegions(sample({ locale, view: 'tasks' }));
    assert.equal(model.locale, locale);
    assert.equal(charts.locale, locale);
    assert.equal(getLocale(), previous, 'building a model must restore its scoped locale');
    for (const standalone of [model, charts]) {
      const lines = renderResourcePanel(standalone, { width: 100, height: 70, presentation: 'charts' });
      assert.ok(lines[0].includes(titles[locale]), `${locale}: renderer chrome must follow model.locale`);
      if (locale === 'en') assert.ok(!/\p{Script=Han}/u.test(lines.join('\n')));
    }
  }
});

test('English localizes built-in statuses and provenance without rewriting user/collector content', () => {
  const options = sample({ locale: 'en', view: 'diagnostics', networkProbes: { sampling: true, result: probeResult('proxy-auth') } });
  const before = JSON.stringify(options);
  const model = buildDashboard(options);
  const text = JSON.stringify(model);
  for (const raw of ['用户自定任务', '自定工具', '用户工具说明', '原始探针标签', '原始错误信息', '自定日志来源', 'https://example.test/代理.pac', '自定义来源']) assert.ok(text.includes(raw), raw);
  for (const translated of ['Cached ≈23.5 tok/s', '1m40s ago', 'Source logs', 'Unavailable', 'Proxy authentication failed (407)', 'System HTTP', 'previous results', 'no direct fallback']) {
    // A failed route has no successful fallback statement; the direct route is independently successful.
    if (translated === 'no direct fallback') continue;
    assert.ok(text.includes(translated), translated);
  }
  const network = byTag(model, 'NETWORK').rows;
  assert.equal(network.find(row => row.label === 'Direct public IP').value, '192.0.2.10');
  assert.ok(!network.find(row => row.label === 'Proxy 1 public IP').value.includes('192.0.2.10'));
  assert.match(network.find(row => row.label === 'Proxy 1 route verification').value, /not yet verified/);
  assert.equal(JSON.stringify(options), before, 'localization must never mutate raw sampling/JSON data');
  const processes = buildDashboard(sample({ locale: 'en', view: 'host' }));
  assert.ok(JSON.stringify(processes).includes('我的进程'));
  const tasks = buildDashboard(sample({ locale: 'en', view: 'tasks' }));
  assert.ok(JSON.stringify(tasks).includes('用户模型'));
});

test('all proxy failure categories have English explanations and never become a successful zero latency', () => {
  const failures = {
    timeout: 'Request timed out', tcp: 'TCP connection failed', dns: 'DNS lookup failed', proxy: 'Proxy handshake failed',
    'proxy-auth': 'Proxy authentication failed', 'proxy-unverified': 'Proxy route unverified', tls: 'TLS verification/handshake failed',
    http: 'Target HTTP check failed', 'invalid-response': 'Unexpected response content', unavailable: 'Probe unavailable', cancelled: 'Cancelled',
  };
  for (const [status, description] of Object.entries(failures)) {
    const rows = byTag(buildDashboard(sample({ locale: 'en', view: 'diagnostics', networkProbes: { result: probeResult(status) } })), 'NETWORK').rows;
    const value = rows.find(row => row.label === 'Proxy 1 HTTPS').value;
    assert.ok(value.includes(description), `${status}: ${value}`);
    assert.ok(!value.includes('total 0ms'));
    assert.equal(rows.find(row => row.label === 'Proxy 1 probe status').value, 'Both targets failed');
  }
});

test('English model has no untranslated built-in Chinese across empty, pending and successful sources', () => {
  const clean = { now: 1_000_000, windowSeconds: 80, hist: { at: [] }, host: { power: { pct: 100, state: 'charged' }, pressure: { state: 'normal' } }, activity: {}, sys: {}, tm: {}, load: [], swap: {} };
  for (const view of views) for (const networkProbes of [undefined, { disabled: true }, { sampling: true }, { error: 'source failed' }, { result: probeResult() }]) {
    const result = networkProbes?.result ? structuredClone(networkProbes) : networkProbes;
    if (result?.result) result.result.proxies[0].sources = ['系统 HTTP'];
    const model = buildDashboard({ ...clean, locale: 'en', view, networkProbes: result });
    assert.ok(!/\p{Script=Han}/u.test(JSON.stringify(model)), `${view}: untranslated built-in string`);
  }
});

test('localized charts and information stay within terminal cell width', () => {
  for (const locale of locales) for (const view of views) for (const width of [36, 68, 100, 140]) {
    const model = buildDashboard(sample({ locale, view, width }));
    const lines = withLocale(locale, () => renderResourcePanel(model, { width, height: 70, color: true }));
    assert.ok(lines.length <= 70, `${locale} ${view} ${width}`);
    assert.ok(lines.every(line => visLen(line) <= width), `${locale} ${view} ${width}`);
  }
});

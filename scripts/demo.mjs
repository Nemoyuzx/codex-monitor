#!/usr/bin/env node
// Public preview only: deterministic synthetic data, with no samplers, commands,
// network requests, environment inspection, or access to local Codex databases.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTranslator, normalizeLocale, SUPPORTED_LOCALES, withLocale } from '../i18n.mjs';
import { demoCatalog } from '../locales/demo.mjs';
import { statusMessages } from '../locales/status.mjs';
import { dashboardCatalog } from '../locales/dashboard.mjs';
import { buildDashboardRegions } from '../dashboard-model.mjs';
import { dashboardLayout, renderInformationSections, composeInformationPane } from '../dashboard-layout.mjs';
import { charW, fitRows, padVis, renderResourcePanel, truncVis, visLen, terminalTokens } from '../resource-panel.mjs';

const cols = 251, rows = 72;
const now = Date.parse('2026-01-01T04:00:00Z');
const KB = 1024, MB = KB ** 2, GB = KB ** 3;
const times = Array.from({ length: 80 }, (_, index) => now - (79 - index) * 1000);
const wave = (base, swing, period = 9, phase = 0) => times.map((_, i) =>
  Math.max(0, base + swing * Math.sin(i / period + phase) + swing * 0.24 * Math.sin(i / 2.7)));
const burst = (base, peak, phase = 0) => times.map((_, i) =>
  base + peak * Math.max(0, Math.sin(i / 6 + phase)) ** 8 + peak * 0.17 * Math.max(0, Math.cos(i / 2.3)) ** 12);
const hist = {
  at: times, cpu: wave(24, 12), load: wave(2.7, 0.9, 15), physicalMem: wave(63, 2.2, 19),
  network: burst(150 * KB, 2.2 * MB), diskRead: burst(600 * KB, 5.5 * MB, 1.3),
  diskWrite: burst(120 * KB, 2.6 * MB, 3), codexCpu: wave(56, 28, 8, 1.5),
  codexRss: wave(2.4 * GB, 0.18 * GB, 17), toolRate: wave(0.6, 0.25), activity: burst(2, 18),
};
const last = key => hist[key].at(-1);
const request = totalMs => ({ status: 'ok', httpStatus: 204,
  target: 'https://connectivity.example.test/', proxyUsed: false, proxyHttpStatus: null,
  timing: { dnsMs: 4, connectMs: 18, tlsMs: 46, ttfbMs: totalMs - 5, totalMs } });
const directRequest = request(118), proxyRequest = { ...request(154), proxyUsed: true, proxyHttpStatus: 200 };
const data = {
  now, windowSeconds: 80, hist, view: 'overview', sampleMs: 84, intervalMs: 1000,
  sys: { mem: 24 * GB, ncpu: 12 }, load: [last('load'), 2.83, 2.61],
  tm: { memUsed: last('physicalMem') / 100 * 24 * GB, memComp: 1.2 * GB },
  pressurePercent: 38, swap: { used: 512 * MB, total: 2 * GB },
  host: {
    cpu: { logicalCores: 12, usagePercent: last('cpu'), perCore: [58, 46, 35, 29, 4, 2, 1, 2, 17, 14, 8, 6] },
    power: { pct: 100, state: 'charged', remainingMinutes: null }, pressure: { state: 'normal' },
    network: { interfaceName: 'en0', inRate: last('network') * 0.75, outRate: last('network') * 0.25 },
    disk: { readRate: last('diskRead'), writeRate: last('diskWrite'), readIOPS: 42, writeIOPS: 18 },
    processes: { available: true, cpuPercent: last('codexCpu'), rssBytes: last('codexRss'),
      counts: { renderer: 2, 'app-server': 1, worker: 3 }, items: [
        { pid: 1201, name: 'Codex (Renderer)', role: 'renderer', cpuPercent: 18.4, rssBytes: 620 * MB },
        { pid: 1202, name: 'app-server', role: 'app-server', cpuPercent: 8.2, rssBytes: 190 * MB },
        { pid: 1203, name: 'worker', role: 'worker', cpuPercent: 2.6, rssBytes: 96 * MB },
      ] },
  },
  activity: {
    sampledAt: now, availability: { history: true, logs: true, queue: true },
    sessions: { total: 6, archived: 2, main: 3, agents: 1, rows: [
      { id: 'demo-a', label: '示例会话 A', model: 'example-model', depth: 0, status: 'running', runningMs: 183000, lastActivityAt: now - 2000 },
      { id: 'demo-b', label: '示例会话 B', model: 'example-model', depth: 1, status: 'recent', runningMs: null, lastActivityAt: now - 18000 },
    ] },
    turns: { recentRunning: 1, staleRunning: 0 }, queue: { count: 0, oldestWaitMs: null }, goals: { active: 0, total: 1 },
    tools: { completed10m: 84, failed10m: 1, pending: 0, oldestPendingMs: null,
      p50Ms: 280, p95Ms: 1800, durationSampleCount: 84, byType: [] },
    coverage: { complete: true, recentToolsComplete: true, pendingComplete: true },
    tokens: { unarchived: 240000, monitorDelta: 4800 },
    alerts: { error10m: 0, warn10m: 2, errorPerMinute: 0, warnPerMinute: 0.2 },
  },
  performance: { available: false, byThread: {} },
  networkDetails: {
    sampledAt: now, interfaceName: 'en0',
    addresses: { ipv4: ['192.0.2.20'], ipv6: ['2001:db8::20'] },
    routes: { ipv4: { gateway: '192.0.2.1' }, ipv6: { gateway: '2001:db8::1' } },
    dns: { nameservers: ['192.0.2.53'] },
    systemProxy: { http: { enabled: true, endpoint: 'http://192.0.2.10:7890', probe: { status: 'open' } },
      https: { enabled: false }, socks: { enabled: false }, pac: { enabled: false }, autoDiscovery: false, bypass: [] },
    environmentProxy: [], tunnelInterfaces: [],
  },
  networkProbes: { sampling: false, result: { sampledAt: now - 2000,
    direct: { kind: 'direct', status: 'ok', publicIp: '203.0.113.20', connectivity: directRequest,
      ipLookup: { ...directRequest, httpStatus: 200, target: 'https://ip.example.test/' } },
    proxies: [{ kind: 'proxy', endpoint: 'http://192.0.2.10:7890', sources: ['system.http'], status: 'ok',
      publicIp: '203.0.113.40', connectivity: proxyRequest,
      ipLookup: { ...proxyRequest, httpStatus: 200, target: 'https://ip.example.test/' } }],
  } },
};

const MASK = '████████';

function redactedData() {
  // Redact before layout, wrapping or SVG text generation: there is no original
  // text underneath the bars and no private value in attributes or metadata.
  const sample = structuredClone(data);
  for (const chat of sample.activity.sessions.rows) { chat.label = MASK; chat.model = MASK; }
  const network = sample.networkDetails;
  network.addresses = { ipv4: [MASK], ipv6: [MASK] };
  network.routes.ipv4.gateway = MASK; network.routes.ipv6.gateway = MASK;
  network.dns.nameservers = [MASK];
  for (const kind of ['http', 'https', 'socks']) if (network.systemProxy[kind]?.endpoint) network.systemProxy[kind].endpoint = MASK;
  for (const route of [sample.networkProbes.result.direct, ...sample.networkProbes.result.proxies]) {
    route.publicIp = MASK;
    if (route.endpoint) route.endpoint = MASK;
    for (const request of [route.ipLookup, route.connectivity]) if (request) delete request.target;
  }
  return sample;
}

export const PREVIEW_FILES = Object.freeze({ 'zh-CN': 'preview.svg', 'zh-TW': 'preview-zh-TW.svg', en: 'preview-en.svg', ja: 'preview-ja.svg' });
const demoText = createTranslator(demoCatalog), statusText = createTranslator(statusMessages), dashboardText = createTranslator(dashboardCatalog);

export function renderDemo({ locale = 'zh-CN' } = {}) {
  const language = normalizeLocale(locale);
  if (!language) throw new Error('Unsupported preview language: ' + locale);
  return withLocale(language, () => renderLocalizedDemo(language));
}

function renderLocalizedDemo(locale) {
  const t = demoText, paint = (code, text) => `\x1b[${code}m${text}\x1b[0m`;
  const layout = dashboardLayout(cols);
  const { charts, information, systemStatus } = buildDashboardRegions({ ...redactedData(), locale, width: layout.right }, { detailWidth: layout.secondary });
  const section = tag => information.find(item => item.tag === tag);
  const network = structuredClone(section('NETWORK'));
  network.title = t('networkTitle');
  network.rows = network.rows.map(row => row.label === dashboardText('公网与代理实测')
    ? { ...row, value: t('probeMock'), tone: 'yellow' } : row);
  const header = [
    paint('1;36', statusText('title')) + '  ' + paint('1;33', t('badge')),
    paint('2', t('source') + '  ' + MASK),
    t('model') + ' ' + paint('36', MASK) + paint('2', ' · ' + t('summary')),
    paint('2', '─'.repeat(layout.left)), t('status'), '',
  ];
  const primary = renderInformationSections([
    { title: t('host'), tone: 'magenta', rows: [
      { label: t('hostName'), value: MASK + ' · ' + t('device') },
      { label: 'CPU', value: t('cpuValue') },
      { label: t('memory'), value: t('memoryValue') },
      { label: t('interface'), value: 'en0 · ' + MASK },
      { label: t('sampling'), value: t('samplingValue') },
    ] },
    { title: t('eventTitle'), tone: 'cyan', rows: [
      { label: t('chat'), value: MASK },
      { label: t('type'), value: t('done') },
      { label: t('content'), value: MASK },
      { label: t('age'), value: t('ageValue') }, '',
      paint('36', t('eventDone', { mask: MASK })),
      paint('36', t('eventActive', { mask: MASK })),
      paint('36', t('eventUpdate', { mask: MASK })),
    ] },
    section('TASKS'), section('TOOLS'), section('PROCESSES'),
  ], { width: layout.primary, color: true });
  const secondary = renderInformationSections([
    network, section('CODEX'), section('HEALTH'), section('METRICS'),
    { title: t('noteTitle'), tone: 'yellow', rows: [t('note1'), t('note2'), t('note3')] },
  ].filter(Boolean), { width: layout.secondary, color: true });
  const left = composeInformationPane({ header, primary, secondary }, { layout, height: rows - 2, color: true, scroll: true }).rows;
  const status = fitRows(renderInformationSections([systemStatus], { width: layout.right, color: true }), Math.floor((rows - 2) / 4));
  const right = renderResourcePanel(charts, { width: layout.right, height: rows - 3 - status.length, color: true, presentation: 'charts' }).concat('', status);
  const terminal = Array.from({ length: rows - 2 }, (_, i) => padVis(truncVis(left[i] || '', layout.left), layout.left)
    + paint('2', ' │ ') + (right[i] || ''));
  terminal.push(paint('2', t('keyboard')), paint('1;33', t('footer')));
  if (terminal.some(line => visLen(line) > cols) || terminal.length > rows) throw new Error('Demo exceeds its terminal bounds');

  const palette = { default: '#e7e8ec', 30: '#202126', 31: '#f26868', 32: '#65cf62', 33: '#dcc363',
    34: '#779de8', 35: '#d97bdd', 36: '#5bc9d2', 37: '#e7e8ec', 90: '#8c909a' };
  const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const cellWidth = 8, cellHeight = 16, inset = 24, chrome = 50;
  const width = cols * cellWidth + inset * 2, height = rows * cellHeight + chrome + inset * 2;
  const textNodes = [];
  const ansi = /\x1b\[[0-9;?]*[A-Za-z]/g;
  for (const [lineIndex, line] of terminal.entries()) {
    let column = 0, color = palette.default, bold = false, dim = false;
    for (const token of terminalTokens(line)) {
      for (const match of token.matchAll(/\x1b\[([0-9;?]*)m/g)) {
        for (const code of match[1].split(';').map(Number)) {
          if (code === 0) { color = palette.default; bold = false; dim = false; }
          else if (code === 1) bold = true;
          else if (code === 2) dim = true;
          else if (palette[code]) color = palette[code];
        }
      }
      const text = token.replace(ansi, ''), cells = charW(text);
      if (text === '█') {
        textNodes.push(`<rect x="${inset + column * cellWidth}" y="${chrome + inset + lineIndex * cellHeight - 12}" width="${cells * cellWidth}" height="14" fill="#626975" data-redacted="true"/>`);
      } else if (text !== ' ' && cells) {
        textNodes.push(`<text x="${inset + column * cellWidth}" y="${chrome + inset + lineIndex * cellHeight}" fill="${color}"${bold ? ' font-weight="700"' : ''}${dim ? ' opacity="0.53"' : ''} textLength="${cells * cellWidth}" lengthAdjust="spacingAndGlyphs">${escape(text)}</text>`);
      }
      column += cells;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description" lang="${locale}">
<title id="title">${escape(t('svgTitle'))}</title>
<desc id="description">${escape(t('svgDescription'))}</desc>
<rect width="${width}" height="${height}" rx="18" fill="#1c1d21"/>
<path d="M18 0H${width - 18}Q${width} 0 ${width} 18V48H0V18Q0 0 18 0" fill="#292c33"/>
<g fill="#ff5f57"><circle cx="25" cy="24" r="6"/></g><circle cx="45" cy="24" r="6" fill="#febc2e"/><circle cx="65" cy="24" r="6" fill="#28c840"/>
<text x="88" y="30" fill="#bcc2cf" font-family="monospace" font-size="15">codex-monitor · 251×72</text>
<text x="${width - 24}" y="30" text-anchor="end" fill="#dcc363" font-family="monospace" font-size="15" font-weight="700">${escape(t('badge'))}</text>
<g font-family="Menlo,Consolas,DejaVu Sans Mono,PingFang SC,Noto Sans Mono CJK SC,monospace" font-size="13" xml:space="preserve">
${textNodes.join('\n')}
</g>
</svg>
`;
}

async function main(args) {
  let selected = 'all', destination = new URL('../docs/', import.meta.url);
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].split(/=(.*)/s);
    if (flag === '--help') { console.log('Usage: npm run demo -- [--lang all|zh-CN|zh-TW|en|ja] [--output-dir PATH]'); return; }
    if (!['--lang', '--output-dir'].includes(flag)) throw new Error('Unknown preview option: ' + flag);
    const value = inline ?? args[++i];
    if (!value || value.startsWith('--')) throw new Error(flag + ' requires a value');
    if (flag === '--lang') selected = value;
    else destination = value;
  }
  const locales = selected === 'all' ? SUPPORTED_LOCALES : [normalizeLocale(selected)];
  if (locales.some(locale => !locale)) throw new Error('Unsupported preview language: ' + selected);
  await mkdir(destination, { recursive: true });
  for (const locale of locales) {
    const svg = renderDemo({ locale });
    const output = destination instanceof URL ? new URL(PREVIEW_FILES[locale], destination) : path.join(destination, PREVIEW_FILES[locale]);
    await writeFile(output, svg);
    console.log('Generated ' + PREVIEW_FILES[locale] + ' — 2056×1250; synthetic data, sensitive fields redacted.');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

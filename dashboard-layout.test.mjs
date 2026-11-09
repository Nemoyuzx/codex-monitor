import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardLayout, wrapTerminalLine, renderInformationSections, composeInformationPane } from './dashboard-layout.mjs';
import { visLen } from './resource-panel.mjs';

test('wide windows give two readable information columns and a paired chart pane', () => {
  for (const cols of [180, 200, 251, 360]) {
    const layout = dashboardLayout(cols);
    assert.equal(layout.left + 3 + layout.right, cols);
    assert.equal(layout.columns, 2);
    assert.ok(layout.primary >= 48 && layout.secondary >= 48);
    assert.ok(layout.right >= 78);
    assert.equal(layout.primary + 3 + layout.secondary, layout.left);
  }
  assert.equal(dashboardLayout(110).columns, 1);
  assert.equal(dashboardLayout(80).right, 0);
  assert.equal(dashboardLayout(251).left, 150);
  assert.equal(dashboardLayout(251).right, 98);
});

test('wrapping preserves long Chinese and colored content without overflowing', () => {
  const text = '\x1b[36m中文信息很长，必须保留全部内容 ABCDEFGHIJK\x1b[0m';
  for (const width of [8, 48, 68]) {
    const lines = wrapTerminalLine(text, width);
    assert.ok(lines.every(line => visLen(line) <= width));
    assert.equal(lines.join('').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''), text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));
  }
});

test('wrapping keeps emoji and combining graphemes intact across ANSI color changes', () => {
  const strip = value => value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  for (const cluster of ['👩‍💻', '👨‍👩‍👧‍👦', '👋🏽', '🇨🇳', '1️⃣', '☑️', 'か\u3099', '가']) {
    assert.deepEqual(wrapTerminalLine(cluster + 'X', 2), [cluster, 'X']);
    assert.deepEqual(wrapTerminalLine('A' + cluster + 'B', 1), ['A', 'B']);
  }
  const colored = '\x1b[35m👩\x1b[36m‍💻\x1b[0mX';
  assert.deepEqual(wrapTerminalLine(colored, 2).map(strip), ['👩‍💻', 'X']);
  const accent = '\x1b[35me\x1b[36m\u0301\x1b[0mX';
  assert.deepEqual(wrapTerminalLine(accent, 1).map(strip), ['e\u0301', 'X']);
});

test('too-wide graphemes are omitted without producing empty row chains', () => {
  assert.deepEqual(wrapTerminalLine('中文', 1), []);
  assert.deepEqual(wrapTerminalLine('か\u3099👩‍💻', 1), []);
  assert.deepEqual(wrapTerminalLine('', 1), [''], 'explicit blank rows stay blank');
  assert.deepEqual(wrapTerminalLine('中文a中文b中文', 1), ['a', 'b']);
});

test('details retain both task names and long values rather than truncating the name away', () => {
  const name = '正在执行的任务完整名称';
  const value = '运行 12m20s · gpt-6.1-sol · 最近活动 2s前';
  const rows = renderInformationSections([{ title: '任务与队列', rows: [{ label: name, value }] }], { width: 48, color: true });
  const plain = rows.join('').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  assert.ok(plain.includes(name) && plain.includes(value));
  assert.ok(rows.every(row => visLen(row) <= 48));
});

test('information tables keep two aligned, left-aligned columns without losing wrapped network details', () => {
  const strip = value => value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const values = ['en0', 'https://proxy.example.test/代理/切换/configuration-for-network-monitoring.pac?profile=desktop&mode=rule',
    '2001:db8:1234:5678:90ab:cdef:1234:5678', '192.0.2.53 · 198.51.100.53 · 2001:db8::53', 'HTTP 204 · 368ms'];
  for (const labels of [
    { title: 'IP · 路由 · 代理', table: { label: '项目', value: '内容' }, rows: ['网络接口', 'HTTP 代理', '本机 IPv6', '系统 DNS', '直连 HTTPS'] },
    { title: 'IP · routes · proxies', table: { label: 'Item', value: 'Value' }, rows: ['Interface', 'Monitor environment proxy', 'Local IPv6', 'System DNS', 'Direct HTTPS'] },
  ]) for (const width of [28, 48, 73, 98]) {
    const section = { title: labels.title, table: labels.table, tone: 'cyan',
      rows: labels.rows.map((label, i) => ({ label, value: values[i], tone: i === 4 ? 'green' : 'cyan', separator: i === 4 })) };
    const plain = renderInformationSections([section], { width });
    const colored = renderInformationSections([section], { width, color: true });
    assert.deepEqual(colored.map(strip), plain, 'color must not move table cells');
    assert.ok(colored.some(line => line.includes('\x1b[32m')), 'probe success keeps its tone');
    assert.ok(colored.every(line => visLen(line) <= width));
    const body = plain.filter(line => line.startsWith('│'));
    assert.ok(body.length > section.rows.length, 'long values wrap onto continuation rows');
    const columns = line => [...line.matchAll(/│/g)].map(match => visLen(line.slice(0, match.index)));
    for (const line of body) assert.deepEqual(columns(line), columns(body[0]), 'both column boundaries stay fixed');
    const cells = body.slice(1).map(line => line.split('│').slice(1, -1));
    const content = cells.map(cell => cell[1].trim()).join('').replace(/\s/g, '');
    const items = cells.map(cell => cell[0].trim()).join('').replace(/\s/g, '');
    for (const value of values) assert.ok(content.includes(value.replace(/\s/g, '')), value);
    for (const label of labels.rows) assert.ok(items.includes(label.replace(/\s/g, '')), label);
    assert.ok(cells.some(cell => /^ en0\s+$/.test(cell[1])), 'short values start at the left edge of the content cell');
    assert.ok(cells.some(cell => !cell[0].trim() && cell[1].trim()), 'continuation rows do not repeat their item label');
    assert.equal(plain.filter(line => line.startsWith('├')).length, 2, 'groups have a visible dividing rule');
  }
});

test('narrow information tables fall back without changing ordinary information sections', () => {
  const section = { title: '网络', rows: [{ label: '本机 IPv6', value: '2001:db8:1234:5678::90ab' },
    { label: 'HTTPS', value: 'HTTP 204 · 368ms', tone: 'green', separator: true }] };
  for (const color of [false, true]) for (const width of [12, 27]) {
    const ordinary = renderInformationSections([section], { width, color });
    const table = renderInformationSections([{ ...section, table: { label: '项目', value: '内容' } }], { width, color });
    assert.deepEqual(table, ordinary);
    assert.ok(table.every(line => visLen(line) <= width));
  }
  const mixed = renderInformationSections([
    { ...section, table: { label: '项目', value: '内容' } },
    { title: '任务', rows: [{ label: '正在运行', value: '3' }, '自定义行'] },
  ], { width: 48 });
  const ordinary = renderInformationSections([{ title: '任务', rows: [{ label: '正在运行', value: '3' }, '自定义行'] }], { width: 48 });
  assert.deepEqual(mixed.slice(-ordinary.length), ordinary);
  assert.ok(!ordinary.join('').includes('│'));
});

test('both text columns scroll while the header stays fixed and bounds remain valid', () => {
  const header = ['状态头部'];
  const primary = Array.from({ length: 100 }, (_, i) => '主信息 ' + i);
  const secondary = Array.from({ length: 120 }, (_, i) => '详情 ' + i);
  const layout = dashboardLayout(251);
  const initial = composeInformationPane({ header, primary, secondary }, { layout, height: 70, offset: 0, scroll: true });
  const next = composeInformationPane({ header, primary, secondary }, { layout, height: 70, offset: 1, scroll: true });
  assert.equal(initial.rows[0], next.rows[0]);
  assert.ok(initial.rows[1].includes('主信息 0') && initial.rows[1].includes('详情 0'));
  assert.ok(next.rows[1].includes('主信息 1') && next.rows[1].includes('详情 1'));
  assert.equal(next.offset, 1);
  assert.equal(next.total, 120);
  assert.equal(next.rows.length, 70);
  assert.equal(next.viewportRows, 69);
  assert.ok(next.rows.every(row => visLen(row) <= layout.left));
  const last = composeInformationPane({ header, primary, secondary }, { layout, height: 70, offset: 1e6, scroll: true });
  assert.equal(last.offset, 51);
  assert.ok(last.rows.at(-1).includes('详情 119'));
});

test('narrow layouts keep details reachable and help uses the full information pane', () => {
  const layout = dashboardLayout(80);
  const all = composeInformationPane({ primary: ['主信息'], secondary: ['任务详情'] }, { layout });
  assert.deepEqual(all.rows, ['主信息', '任务详情']);
  const help = composeInformationPane({ primary: ['帮助 '.repeat(40)], secondary: [] }, { layout: dashboardLayout(251), height: 8, help: true });
  assert.ok(help.rows.length <= 8);
  assert.ok(help.rows.every(row => visLen(row) <= dashboardLayout(251).left));
});

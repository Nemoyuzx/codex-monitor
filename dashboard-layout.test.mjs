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

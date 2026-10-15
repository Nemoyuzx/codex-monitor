import assert from 'node:assert/strict';
import test from 'node:test';
import { columnWidths, fitRows, historyGraph, historyStats, renderResourcePanel, truncVis, visLen } from './resource-panel.mjs';

const now = 100_000;
const times = Array.from({ length: 80 }, (_, i) => now - (79 - i) * 1000);
const values = times.map((_, i) => 30 + Math.sin(i / 6) * 10);
const graphOptions = { width: 100, height: 4, now, windowSeconds: 80 };
const model = {
  now, times, windowSeconds: 80,
  sections: [
    { title: '主机资源', tag: 'HOST', tone: 'cyan', footer: '压缩 2.8 GB · swap 963 MB', metrics: [
      { label: 'CPU 负载 · 1m', value: '3.80', values, detail: '5m 3.40 · 15m 4.20 · 12 核', tone: 'green' },
      { label: '内存占用', value: '28%', values, meter: 28, tone: 'green', scale: { max: 100 } },
      { label: '网络 IO', value: '164 KB/s', values },
      { label: '缺页率', value: '11.4K/s', values },
    ] },
    { title: 'Codex 进程', tag: 'CODEX', tone: 'magenta', metrics: [
      { label: 'CPU · 多核', value: '36%', values, detail: '单核 100% · 12 核合计' },
      { label: '日志事件', value: '0/s', values, detail: '按实际采样时间计算' },
    ] },
  ],
};

test('terminal widths and truncation keep complete emoji and combining graphemes', () => {
  for (const cluster of ['👩‍💻', '👨‍👩‍👧‍👦', '👋🏽', '🇨🇳', '1️⃣', '☑️', '⌚', '✅', '◽']) {
    assert.equal(visLen(cluster), 2, cluster);
    assert.equal(truncVis(cluster + 'X', 1), '', cluster);
    assert.equal(truncVis(cluster + 'X', 2), cluster, cluster);
    assert.equal(truncVis(cluster + 'X', 3), cluster + 'X', cluster);
  }
  for (const cluster of ['e\u0301', 'か\u3099', '가']) {
    const width = cluster.startsWith('e') ? 1 : 2;
    assert.equal(visLen(cluster), width);
    assert.equal(truncVis(cluster + 'X', width), cluster);
    assert.equal(truncVis(cluster, width - 1), '');
  }
  assert.equal(visLen('a\u200bb'), 2, 'zero-width spaces do not consume columns');
  assert.equal(visLen('☑︎'), 1, 'text-presentation selectors do not force emoji width');
});

test('ANSI color changes inside a grapheme do not split its visible characters', () => {
  const colored = '\x1b[35m👩\x1b[36m‍💻\x1b[0mX';
  const strip = value => value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  assert.equal(visLen(colored), 3);
  assert.equal(strip(truncVis(colored, 2)), '👩‍💻');
  assert.equal(strip(truncVis(colored, 1)), '');
  const accent = '\x1b[35me\x1b[36m\u0301\x1b[0mX';
  assert.equal(strip(truncVis(accent, 1)), 'e\u0301');
});

test('responsive panels fit terminal width and height with ANSI and Chinese text', () => {
  for (const cols of [84, 110, 180, 240, 360]) {
    for (const height of [6, 8, 22, 38, 58, 90]) {
      for (const color of [false, true]) {
        const { left, right } = columnWidths(cols);
        assert.equal(left + right + 3, cols);
        const rows = renderResourcePanel(model, { width: right, height, color });
        assert.ok(rows.length <= height, `${cols} columns, ${height} rows`);
        for (const row of rows) assert.ok(visLen(row) <= right, `${visLen(row)} > ${right}`);
        if (height >= 38) {
          const text = rows.join('\n');
          for (const metric of model.sections.flatMap(section => section.metrics)) assert.ok(text.includes(metric.label));
        }
      }
    }
  }
});

const expanded = {
  ...model,
  sections: [
    { ...model.sections[0], metrics: [
      ...model.sections[0].metrics.map((metric, index) => ({ ...metric, priority: 100 - index })),
      ...['CPU 使用率', '磁盘读取', '磁盘写入', '内存压力'].map((label, index) => ({ label, value: '12%', values, priority: 40 - index })),
    ], rows: [
      { label: '主机', value: 'Apple M4 Pro · 12 核 · 24 GB', priority: 5 },
      { label: '网络累计', value: '↓ 72 GB · ↑ 53 GB', optional: true },
    ] },
    { ...model.sections[1], metrics: [
      ...model.sections[1].metrics,
      { label: 'Codex RSS', value: '1.8 GB', values },
      { label: '错误 / 警告', value: '0 / 2', values, stats: false },
    ], rows: [
      { label: '进程数量', value: '12', priority: 5 },
      { label: '最后事件', value: '2 秒前', priority: 4 },
      { label: '磁盘空间', value: '可用 2.1 TiB', priority: 3 },
    ] },
    { title: '进程排行', tag: 'TOP', tone: 'cyan', optional: true, rows: [
      '进程                         CPU       RSS',
      { label: 'Codex Helper (Renderer)', value: '36% · 492 MB' },
      { label: 'app-server', value: '12% · 128 MB' },
      { label: '代码工具 · node', value: '4% · 64 MB', tone: 'green' },
      '按 CPU 排序 · 真实进程采样',
    ] },
  ],
};

test('twelve charts and summary/ranking rows fit the screenshot-sized sidebar', () => {
  const rows = renderResourcePanel(expanded, { width: 108, height: 66, color: true });
  const text = rows.join('\n');
  assert.ok(rows.length <= 66 && rows.length >= 55);
  for (const metric of expanded.sections.flatMap(section => section.metrics || [])) assert.ok(text.includes(metric.label), metric.label);
  assert.ok(text.includes('代码工具 · node'));
  assert.ok(text.includes('min ') && text.includes('max ') && text.includes('avg '));
  assert.ok(!text.includes('已隐藏'));
  assert.ok(rows.every(row => visLen(row) <= 108));
});

const chartFocused = {
  ...model,
  sections: [
    { ...model.sections[0], metrics: [
      ...model.sections[0].metrics,
      { label: '磁盘读取', value: '1 MB/s', values },
      { label: '磁盘写入', value: '2 MB/s', values },
    ], rows: [{ label: '逐核 CPU', value: '应移至详情栏' }] },
    model.sections[1],
    { title: '进程排行', rows: ['应移至详情栏'] },
  ],
};
const plainRows = rows => rows.map(row => row.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));
const plotRows = rows => plainRows(rows).filter(row => /^│ [0-9A-Za-z.% ]{0,7}[│└]/u.test(row));

test('chart presentation gives eight paired trends at least eight plot rows each', () => {
  for (const color of [false, true]) {
    const rows = renderResourcePanel(chartFocused, { width: 108, height: 70, color, presentation: 'charts' });
    const text = rows.join('\n');
    assert.ok(rows.length <= 70);
    assert.ok(rows.every(row => visLen(row) <= 108));
    for (const metric of chartFocused.sections.flatMap(section => section.metrics || [])) assert.ok(text.includes(metric.label));
    const curves = plotRows(rows);
    assert.equal(curves.filter(row => row.includes('└')).length, 4, 'four pairs of complete plots');
    assert.ok(curves.length >= 4 * 8, `${curves.length} plot rows across four pairs`);
    assert.ok(curves.length <= 4 * 16);
    assert.ok(text.includes('min ') && text.includes('现在') && text.includes('5m 3.40'));
    assert.ok(!text.includes('逐核 CPU') && !text.includes('进程排行') && !text.includes('应移至详情栏'));
    assert.ok(!text.includes('压缩 2.8 GB') && !text.includes('CPU / 内存') && !text.includes('已隐藏'));
  }
});

test('fewer trends grow taller and short chart panels release metadata before curves', () => {
  const opts = { width: 108, height: 70, presentation: 'charts' };
  const eightHeight = plotRows(renderResourcePanel(chartFocused, opts)).length / 4;
  const sixHeight = plotRows(renderResourcePanel(model, opts)).length / 3;
  assert.ok(sixHeight > eightHeight);
  assert.equal(sixHeight, 16);
  const short = renderResourcePanel(chartFocused, { ...opts, height: 50 });
  assert.ok(plotRows(short).length >= 4 * 8);
  assert.ok(!short.join('\n').includes('min '));
  assert.ok(short.join('\n').includes('现在'));
});

test('chart presentation remains single column below 78 and bounds compact priority layouts', () => {
  for (const width of [1, 15, 16, 40, 77, 78, 108]) {
    for (const height of [0, 1, 4, 8, 22, 38, 70]) {
      const rows = renderResourcePanel(chartFocused, { width, height, color: true, presentation: 'charts' });
      assert.ok(rows.length <= height, `${width} × ${height}`);
      assert.ok(rows.every(row => visLen(row) <= width), `${width} × ${height}`);
      if (width >= 16) assert.equal(rows.filter(row => row.includes('┌')).length, rows.filter(row => row.includes('┘')).length);
    }
  }
  const single = renderResourcePanel(model, { width: 77, height: 70, presentation: 'charts' });
  assert.equal(plotRows(single).filter(row => row.includes('└')).length, 6);
  const compact = renderResourcePanel(expanded, { width: 40, height: 22, presentation: 'charts' }).join('\n');
  assert.ok(compact.includes('CPU 负载 · 1m'));
  assert.match(compact, /已隐藏 \d+ 图/u);
  assert.ok(!/已隐藏 .*行/u.test(compact));
});

test('small panels retain important real curves and report every hidden chart/row', () => {
  for (const color of [true, false]) {
    const rows = renderResourcePanel(expanded, { width: 40, height: 22, color });
    const text = rows.join('\n');
    assert.ok(text.includes('CPU 负载 · 1m'));
    assert.ok(text.includes('内存占用'));
    assert.ok(!text.includes('进程排行'));
    assert.match(text, /已隐藏 \d+ 图、\d+ 行/u);
    assert.match(text, /[\u2801-\u28ff]/u);
    assert.ok(rows.length <= 22);
    assert.ok(rows.every(row => visLen(row) <= 40));
    assert.equal(rows.filter(row => row.includes('┌')).length, rows.filter(row => row.includes('┘')).length);
  }
});

test('optional items are dropped first and larger priorities survive compact layouts', () => {
  const priorityModel = { ...model, sections: [{ title: '资源', metrics: [
    { label: '可选图', value: '1', values, priority: 1000, optional: true },
    { label: '关键图', value: '2', values, priority: 100 },
    { label: '普通图', value: '3', values, priority: 0 },
  ] }] };
  const text = renderResourcePanel(priorityModel, { width: 40, height: 7 }).join('\n');
  assert.ok(text.includes('关键图'));
  assert.ok(!text.includes('可选图') && !text.includes('普通图'));
  assert.ok(text.includes('已隐藏 2 图'));
  assert.match(text, /[\u2801-\u28ff]/u);
});

test('text-only sections align ANSI-colored Chinese rows and keep complete borders', () => {
  const rows = renderResourcePanel({ ...model, sections: [{ title: '进程排行', tag: 'TOP', rows: [
    { label: '\x1b[35m中文 标签\x1b[0m', value: '42 MB', tone: 'green' },
    { label: 'ASCII', value: '7 MB', tone: 'yellow' },
    '来自本地真实采样',
  ] }] }, { width: 48, height: 10, color: true });
  const plain = rows.map(row => row.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));
  assert.ok(plain.filter(row => /^[│┌└]/u.test(row)).every(row => visLen(row) === 48));
  const positions = ['42 MB', '7 MB'].map(value => {
    const row = plain.find(row => row.includes(value));
    return visLen(row.slice(0, row.indexOf(value) + value.length));
  });
  assert.equal(positions[0], positions[1]);
  assert.ok(plain.join('\n').includes('来自本地真实采样'));
});

test('window statistics use observed finite samples only and show unknown for no data', () => {
  assert.deepEqual(historyStats([100, 2, null, 8, Infinity, 500], [0, 30_000, 40_000, 90_000, 99_000, now + 1], { now, windowSeconds: 80 }), { min: 2, max: 8, avg: 5, count: 2 });
  assert.deepEqual(historyStats([null, NaN, 10], [now, now, 0], { now, windowSeconds: 80 }), { min: null, max: null, avg: null, count: 0 });
  const text = renderResourcePanel({ ...model, sections: [{ title: '空数据', metrics: [{ label: '未知指标', value: '—', values: [null] }] }] }, { width: 48, height: 20 }).join('\n');
  assert.ok(text.includes('min — · max — · avg —'));
  assert.ok(!/[\u2801-\u28ff]/u.test(text));
});

test('layout caches are render-local so changed samples and expired windows are never reused', () => {
  const samples = [25, 50];
  const sampled = { now, times: [now - 1000, now], windowSeconds: 80, sections: [{ title: '资源', metrics: [
    { label: 'CPU', value: '50%', values: samples },
  ] }] };
  const options = { width: 48, height: 20 };
  const first = renderResourcePanel(sampled, options).join('\n');
  assert.ok(first.includes('min 25 · max 50 · avg 38'));
  samples[1] = 100;
  const updated = renderResourcePanel(sampled, options).join('\n');
  assert.ok(updated.includes('min 25 · max 100 · avg 63'));
  const expired = renderResourcePanel({ ...sampled, now: now + 81_000 }, options).join('\n');
  assert.ok(expired.includes('min — · max — · avg —'));
  assert.ok(!/[\u2801-\u28ff]/u.test(expired));
});

test('tiny widths/heights and graph axes never exceed their visible budgets', () => {
  for (const width of [0, 1, 2, 4, 10, 15, 16, 32, 78, 108]) {
    for (const height of [0, 1, 2, 3, 4, 5, 6, 8, 22, 66]) {
      const rows = renderResourcePanel(expanded, { width, height, color: true });
      assert.ok(rows.length <= height, `height ${height}`);
      assert.ok(rows.every(row => visLen(row) <= width), `width ${width}`);
    }
    const graph = historyGraph(values, times, { ...graphOptions, width });
    assert.ok(graph.every(row => visLen(row.axis + row.plot) === width));
  }
});

test('history covers the available plot width after the window has been sampled', () => {
  const rows = historyGraph(values, times, graphOptions);
  assert.ok(rows.every(row => visLen(row.axis + row.plot) === graphOptions.width));
  const bottom = rows.at(-1).plot;
  assert.ok(Array.from(bottom).filter(ch => ch !== ' ').length > 90);
});

test('a first sample is right aligned and does not invent earlier history', () => {
  const rows = historyGraph([35], [now], graphOptions);
  assert.match(rows.at(-1).plot, /^ +[^ ]$/u);
});

test('missing samples leave a gap, including between valid observations', () => {
  const rows = historyGraph([30, null, 30], [now - 79_000, now - 40_000, now], graphOptions);
  const bottom = rows.at(-1).plot;
  assert.equal(bottom[Math.floor(bottom.length / 2)], ' ');
  assert.notEqual(bottom[1], ' ');
  assert.notEqual(bottom.at(-1), ' ');
});

test('invalid and expired samples do not draw data', () => {
  for (const [data, at] of [[[null, NaN, Infinity], [now - 2000, now - 1000, now]], [[5], [now - 90_000]]]) {
    assert.ok(historyGraph(data, at, graphOptions).every(row => row.plot.trim() === ''));
  }
});

test('percentage axes stay fixed and large rates use bounded labels', () => {
  const pct = historyGraph([0, 100], [now - 1000, now], { ...graphOptions, max: 100, format: n => n + '%' });
  assert.ok(pct[0].axis.includes('100%'));
  assert.ok(pct.at(-1).axis.includes('0%'));
  const rate = historyGraph([1e12], [now], graphOptions);
  assert.ok(rate.every(row => visLen(row.axis + row.plot) === graphOptions.width));
});

test('time window follows the configured interval and short heights still fit', () => {
  const rows = renderResourcePanel({ ...model, windowSeconds: 240 }, { width: 100, height: 60 });
  assert.ok(rows.join('\n').includes('最近 4m'));
  for (const limit of [0, 1, 8, 24]) assert.equal(fitRows(Array(50).fill('row'), limit).length, limit);
});

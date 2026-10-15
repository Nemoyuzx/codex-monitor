import assert from 'node:assert/strict';
import test from 'node:test';
import { getLocale, SUPPORTED_LOCALES, withLocale } from './i18n.mjs';
import catalog from './locales/resource.mjs';
import { charW, columnWidths, fitRows, renderResourcePanel, truncVis, visLen } from './resource-panel.mjs';

const text = {
  'zh-CN': { host: '主机资源', cpu: 'CPU · 全机', memory: '物理内存', network: '网络 · en0', read: '磁盘读取', write: '磁盘写入', load: 'CPU 负载 · 1m', codex: 'Codex 资源', codexCpu: 'Codex CPU · 多核', rss: 'Codex RSS', power: '电源', footer: '压缩 2.8 GB · swap 963 MB' },
  'zh-TW': { host: '主機資源', cpu: 'CPU · 全機', memory: '實體記憶體', network: '網路 · en0', read: '磁碟讀取', write: '磁碟寫入', load: 'CPU 負載 · 1m', codex: 'Codex 資源', codexCpu: 'Codex CPU · 多核心', rss: 'Codex RSS', power: '電源', footer: '壓縮 2.8 GB · swap 963 MB' },
  en: { host: 'Host resources', cpu: 'CPU · system', memory: 'Physical memory', network: 'Network · en0', read: 'Disk read', write: 'Disk write', load: 'CPU load · 1m', codex: 'Codex resources', codexCpu: 'Codex CPU · multi-core', rss: 'Codex RSS', power: 'Power', footer: 'Compressed 2.8 GB · swap 963 MB' },
  ja: { host: 'ホストリソース', cpu: 'CPU · システム', memory: '物理メモリ', network: 'ネットワーク · en0', read: 'ディスク読取', write: 'ディスク書込', load: 'CPU 負荷 · 1m', codex: 'Codex リソース', codexCpu: 'Codex CPU · 複数コア', rss: 'Codex RSS', power: '電源', footer: '圧縮 2.8 GB · swap 963 MB' },
};
const now = 100_000;
const times = Array.from({ length: 80 }, (_, i) => now - (79 - i) * 1000);
const values = times.map((_, i) => 30 + Math.sin(i / 6) * 10);
function fixture(locale) {
  const s = text[locale];
  const metric = (label, extra = {}) => ({ label, value: '32%', values, ...extra });
  return { locale, now, times, windowSeconds: 80, sections: [
    { title: s.host, tag: 'HOST', tone: 'cyan', footer: s.footer, metrics: [
      metric(s.cpu, { tone: 'green', meter: 32 }), metric(s.load), metric(s.memory, { tone: 'yellow' }),
      metric(s.network, { value: '164 KB/s' }), metric(s.read, { value: '1 MB/s' }), metric(s.write, { value: '2 MB/s' }),
    ], rows: [{ label: s.power, value: '100% · charged' }] },
    { title: s.codex, tag: 'CODEX', tone: 'magenta', metrics: [metric(s.codexCpu), metric(s.rss, { value: '1.8 GB' })] },
  ] };
}
const plain = rows => rows.join('\n').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

test('resource catalog covers every supported locale without empty or implicit fallbacks', () => {
  for (const [key, entry] of Object.entries(catalog)) {
    for (const locale of SUPPORTED_LOCALES) assert.ok(typeof entry[locale] === 'string' && entry[locale], `${key}: ${locale}`);
  }
});

test('translated chart fixtures retain all eight trends at 251 × 72 and localize built-in headings', () => {
  const { right } = columnWidths(251);
  for (const locale of SUPPORTED_LOCALES) {
    for (const color of [false, true]) {
      const model = fixture(locale);
      const rows = renderResourcePanel(model, { width: right, height: 70, color, presentation: 'charts' });
      const output = plain(rows);
      assert.ok(output.startsWith(catalog.title[locale]));
      assert.ok(output.includes(catalog.recent[locale].replace('{duration}', '1m20s')));
      assert.ok(output.includes(catalog.now[locale]));
      for (const section of model.sections) {
        assert.ok(output.includes(section.title));
        for (const metric of section.metrics) assert.ok(output.includes(metric.label), `${locale}: ${metric.label}`);
      }
      assert.ok(output.includes('min ') && output.includes('max ') && output.includes('avg '));
      assert.ok(rows.length <= 70 && rows.every(row => visLen(row) <= right));
      assert.ok(!output.includes(catalog.hidden[locale].split('{items}')[0]));
    }
  }
});

test('translated resources, ANSI frames and omission notices fit wide, narrow and tiny terminals', () => {
  for (const locale of SUPPORTED_LOCALES) {
    const model = fixture(locale);
    for (const width of [0, 1, 2, 10, 15, 16, 40, 77, 78, 108, 140]) {
      for (const height of [0, 1, 2, 3, 4, 7, 22, 38, 70]) {
        for (const color of [false, true]) {
          for (const presentation of [undefined, 'charts']) {
            const rows = renderResourcePanel(model, { width, height, color, presentation });
            assert.ok(rows.length <= height, `${locale}: ${width} × ${height}`);
            assert.ok(rows.every(row => visLen(row) <= width), `${locale}: ${width} × ${height}`);
            if (width >= 16) assert.equal(rows.filter(row => row.includes('┌')).length, rows.filter(row => row.includes('┘')).length);
          }
        }
      }
    }
    const compact = plain(renderResourcePanel(model, { width: 70, height: 7 }));
    assert.ok(compact.includes(catalog.hidden[locale].split('{items}')[0]), locale);
    const full = plain(renderResourcePanel(model, { width: 108, height: 100 }));
    assert.ok(full.includes(catalog.legend[locale] + catalog.low[locale]));
    assert.ok(full.includes(catalog.medium[locale]) && full.includes(catalog.high[locale]));
  }
});

test('render locale overrides are scoped and custom fold messages remain caller-owned', () => {
  const before = getLocale();
  const model = fixture('ja');
  assert.ok(plain(renderResourcePanel(model, { width: 70, height: 30, locale: 'en' })).startsWith('Resources'));
  assert.equal(getLocale(), before);
  withLocale('zh-TW', () => {
    assert.ok(fitRows(['a', 'b', 'c'], 2)[1].includes('已摺疊'));
    assert.equal(fitRows(['a', 'b', 'c'], 2, 'custom 日本語 café')[1], 'custom 日本語 café');
    assert.ok(plain(renderResourcePanel({ ...model, locale: undefined }, { width: 70, height: 30 })).startsWith('資源監視'));
  });
  assert.equal(getLocale(), before);
});

test('accented and combining Latin text and Japanese retain terminal column widths', () => {
  assert.equal(charW('é'), 1);
  assert.equal(charW('\u0301'), 0);
  assert.equal(charW('資'), 2);
  assert.equal(visLen('café'), 4);
  assert.equal(visLen('cafe\u0301'), 4);
  assert.equal(visLen('日本語'), 6);
  assert.equal(truncVis('cafe\u0301 日本語', 4), 'cafe\u0301');
  assert.equal(visLen('\x1b[36mcafe\u0301 日本語\x1b[0m'), 11);
});

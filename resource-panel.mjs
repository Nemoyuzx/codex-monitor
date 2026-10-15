// Pure terminal rendering: no sampling, subprocesses, or access to Codex data.
import { createTranslator, withLocale } from './i18n.mjs';
import catalog from './locales/resource.mjs';

const t = createTranslator(catalog);
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const TERMINAL_TOKEN = /\x1b\[[0-9;?]*[A-Za-z]|[\s\S]/gu;
const SIMPLE_TEXT = /^[\x20-\x7e\u00a0-\u02ff\u2000-\u200a\u2010-\u2027\u2030-\u205e\u2100-\u22ff\u2500-\u9fff\uac00-\ud7a3\uff00-\uffef]*$/u;
const MARK = /\p{Mark}/u;
const EMOJI = /\p{Emoji_Presentation}|\p{Regional_Indicator}{2}|\u20e3|\p{Extended_Pictographic}\ufe0f/u;
const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });
const BRAILLE = [[1, 2, 4, 64], [8, 16, 32, 128]];

function codePointWidth(ch) {
  const c = ch.codePointAt(0);
  if (c < 0x300) return c < 0x20 || (c >= 0x7f && c <= 0x9f) ? 0 : 1;
  if (c >= 0x2800 && c <= 0x28ff) return 1;
  if (MARK.test(ch) || (c >= 0x200b && c <= 0x200f) || c === 0xfeff) return 0;
  if ((c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe10 && c <= 0xfe6f) || (c >= 0xff01 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || c >= 0x20000) return 2;
  if (c >= 0x2300 && EMOJI.test(ch)) return 2;
  return 1;
}

// ASCII, CJK, box drawing and braille dominate ordinary frames. Only strings
// with possible multi-code-point clusters need the grapheme segmenter.
export function terminalTokens(text) {
  const source = String(text);
  const plain = source.includes('\x1b') ? source.replace(ANSI, '') : source;
  if (SIMPLE_TEXT.test(plain) && !MARK.test(plain)) return source.match(TERMINAL_TOKEN) || [];
  if (plain === source) return Array.from(graphemes.segment(plain), item => item.segment);
  const tokens = source.match(TERMINAL_TOKEN) || [];
  const result = [];
  let index = 0;
  for (const { segment } of graphemes.segment(plain)) {
    let raw = '', remaining = segment.length;
    while (remaining > 0 && index < tokens.length) {
      const token = tokens[index++];
      raw += token;
      if (!token.startsWith('\x1b')) remaining -= token.length;
    }
    result.push(raw);
  }
  return result.concat(tokens.slice(index));
}

export function charW(ch) {
  const plain = ch.length > 2 && ch.includes('\x1b') ? ch.replace(ANSI, '') : ch;
  if (!plain) return 0;
  const first = plain.codePointAt(0);
  if (plain.length === (first > 0xffff ? 2 : 1)) {
    return codePointWidth(plain);
  }
  // Emoji modifiers, flags, keycaps and ZWJ sequences occupy one terminal cell
  // pair. Taking the widest component also keeps combining text and Hangul
  // clusters intact without adding the width of their combining components.
  if (EMOJI.test(plain)) return 2;
  let width = 0;
  for (const component of plain) width = Math.max(width, codePointWidth(component));
  return width;
}

export function visLen(s) {
  const plain = String(s).replace(ANSI, '');
  if (/^[\x20-\x7e]*$/.test(plain)) return plain.length;
  if (SIMPLE_TEXT.test(plain) && !MARK.test(plain)) {
    let width = 0;
    for (const ch of plain) width += codePointWidth(ch);
    return width;
  }
  return terminalTokens(plain).reduce((n, ch) => n + charW(ch), 0);
}

export function truncVis(s, width) {
  let out = '', used = 0;
  const colored = String(s).includes('\x1b');
  for (const token of terminalTokens(s)) {
    const size = charW(token);
    if (used + size > width) return out + (colored ? '\x1b[0m' : '');
    out += token;
    used += size;
  }
  return out;
}

export function padVis(s, width) {
  return s + ' '.repeat(Math.max(0, width - visLen(s)));
}

export function columnWidths(cols) {
  const left = Math.floor(cols * 0.56);
  return { left, right: cols - left - 3 };
}

export function fitRows(rows, limit, omission = t('folded')) {
  if (!Number.isFinite(limit) || rows.length <= limit) return rows;
  if (limit <= 0) return [];
  if (limit < 10) return rows.slice(0, limit - 1).concat(omission);
  const tail = Math.min(8, Math.floor(limit / 3));
  return rows.slice(0, limit - tail - 1).concat(omission, rows.slice(-tail));
}

export function compactNumber(n) {
  if (!Number.isFinite(n)) return '—';
  for (const [unit, scale] of [['G', 1e9], ['M', 1e6], ['K', 1e3]]) {
    if (Math.abs(n) >= scale) return (n / scale).toFixed(n / scale >= 100 ? 0 : 1) + unit;
  }
  return n === 0 ? '0' : n.toFixed(n < 10 ? 1 : 0);
}

export function duration(seconds) {
  seconds = Math.round(seconds);
  if (seconds < 60) return Math.round(seconds) + 's';
  const minutes = Math.floor(seconds / 60), rest = seconds % 60;
  return minutes + 'm' + (rest ? rest + 's' : '');
}

// Interpolate only between adjacent, observed samples. Missing samples and the
// unobserved part of the time window remain blank; the newest sample is at right.
export function historyGraph(values, times, { width, height, now, windowSeconds, min = 0, max, format = compactNumber }) {
  width = Math.max(0, Math.floor(width));
  height = Math.max(0, Math.floor(height));
  if (!width || !height) return [];
  const start = now - windowSeconds * 1000;
  const valid = values.filter((v, i) => times[i] >= start && times[i] <= now && Number.isFinite(v));
  const peak = valid.length ? Math.max(...valid) : 0;
  const low = Number.isFinite(min) ? min : 0;
  const high = Number.isFinite(max) && max > low ? max : Math.max(low + 1, peak * 1.15);
  const edgeWidth = width > 1 ? 1 : 0;
  const axisWidth = Math.max(0, Math.min(width - edgeWidth - 1, 7, Math.max(3, visLen(format(high)), visLen(format(low)))));
  const plotWidth = width - axisWidth - edgeWidth;
  const dots = plotWidth * 2, dotHeight = height * 4;
  const cells = new Uint8Array(plotWidth * height);
  const draw = (x, value) => {
    const y = Math.max(0, Math.min(dotHeight - 1, Math.round((1 - (value - low) / (high - low || 1)) * (dotHeight - 1))));
    for (let row = y; row < dotHeight; row++) cells[(row >> 2) * plotWidth + (x >> 1)] |= BRAILLE[x & 1][row & 3];
  };
  const dotTime = x => start + x / Math.max(1, dots - 1) * windowSeconds * 1000;
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i]) || !Number.isFinite(times[i]) || times[i] > now) continue;
    const x = Math.round((times[i] - start) / (windowSeconds * 1000) * (dots - 1));
    if (x >= 0 && x < dots) draw(x, values[i]);
    if (i === 0 || !Number.isFinite(values[i - 1]) || !Number.isFinite(times[i - 1]) || times[i] <= times[i - 1]) continue;
    const from = Math.max(0, Math.ceil((times[i - 1] - start) / (windowSeconds * 1000) * (dots - 1)));
    const to = Math.min(dots - 1, Math.floor((times[i] - start) / (windowSeconds * 1000) * (dots - 1)));
    for (let col = from; col <= to; col++) {
      const ratio = (dotTime(col) - times[i - 1]) / (times[i] - times[i - 1]);
      draw(col, values[i - 1] + ratio * (values[i] - values[i - 1]));
    }
  }
  return Array.from({ length: height }, (_, row) => {
    const label = row === 0 ? format(high) : row === height - 1 ? format(low) : '';
    const edge = row === height - 1 ? '└' : '│';
    const plot = Array.from(cells.slice(row * plotWidth, (row + 1) * plotWidth), bits => bits ? String.fromCharCode(0x2800 + bits) : ' ').join('');
    return { axis: padVis(truncVis(label, axisWidth), axisWidth) + (edgeWidth ? edge : ''), plot };
  });
}

export function historyStats(values, times, { now, windowSeconds }) {
  const start = now - windowSeconds * 1000;
  const valid = values.filter((value, index) => Number.isFinite(value) && Number.isFinite(times[index]) && times[index] >= start && times[index] <= now);
  if (!valid.length) return { min: null, max: null, avg: null, count: 0 };
  return { min: Math.min(...valid), max: Math.max(...valid), avg: valid.reduce((total, value) => total + value, 0) / valid.length, count: valid.length };
}

// sections may contain metrics and/or rows. A row is a string or
// { label, value, tone?, priority?, optional? }. Higher priority is retained
// first; optional items are hidden before required items at the same size.
// presentation: 'charts' reserves the panel for trends. Text rows and footers
// belong in the adjacent detail pane; chart height grows with available space.
export function renderResourcePanel(model, options = {}) {
  const locale = options.locale ?? model.locale;
  return locale ? withLocale(locale, () => renderPanel(model, options)) : renderPanel(model, options);
}

function renderPanel({ sections = [], times = [], now, windowSeconds }, { width, height = 60, color = false, presentation }) {
  width = Math.max(0, Math.floor(width));
  height = Math.max(0, Math.floor(height));
  if (!width || !height) return [];
  const paint = (code, s) => color ? `\x1b[${code}m${s}\x1b[0m` : s;
  const tones = { cyan: 36, magenta: 35, green: 32, yellow: 33, red: 31 };
  const muted = s => paint('2', s);
  const inner = width - 4;
  const paired = inner >= 74;
  const chartsOnly = presentation === 'charts';
  const metricWidth = paired ? Math.floor((inner - 3) / 2) : inner;
  // Layout fitting can try several heights and remove many optional items. A
  // metric's samples do not change during a render, so reuse its plots and
  // statistics across those attempts instead of scanning history repeatedly.
  const graphs = new Map(), statistics = new Map();
  const metricGraph = (metric, graphHeight) => {
    let byHeight = graphs.get(metric);
    if (!byHeight) graphs.set(metric, byHeight = new Map());
    if (!byHeight.has(graphHeight)) byHeight.set(graphHeight, historyGraph(metric.values || [], times, {
      width: metricWidth, height: graphHeight, now, windowSeconds, ...metric.scale,
    }));
    return byHeight.get(graphHeight);
  };
  const metricStats = metric => {
    if (!statistics.has(metric)) statistics.set(metric, historyStats(metric.values || [], times, { now, windowSeconds }));
    return statistics.get(metric);
  };
  const align = (left, right, w) => {
    const rhs = truncVis(right, w);
    const room = Math.max(0, w - visLen(rhs) - 1);
    return padVis(truncVis(left, room), w - visLen(rhs)) + rhs;
  };
  const meter = (pct, w, tone) => {
    const length = Math.max(2, w - 2);
    const filled = Math.round(Math.max(0, Math.min(100, pct)) / 100 * length);
    return muted('[') + paint(tones[tone] || 36, '━'.repeat(filled)) + muted('·'.repeat(length - filled) + ']');
  };
  const timeAxis = w => {
    const left = '−' + duration(windowSeconds), middle = '−' + duration(windowSeconds / 2), right = t('now');
    const center = Math.floor((w - visLen(middle)) / 2);
    return padVis(left, center) + padVis(middle, w - center - visLen(right)) + right;
  };
  const items = sections.flatMap((section, sectionIndex) => [
    ...(section.metrics || []).map((item, index) => ({ item, kind: 'metric', index, sectionIndex })),
    ...(section.rows || []).map((item, index) => ({ item, kind: 'row', index, sectionIndex })),
  ]).filter(entry => !chartsOnly || entry.kind === 'metric').map((entry, order) => ({
    ...entry, order,
    priority: (Number(sections[entry.sectionIndex].priority) || 0) + (Number(entry.item?.priority) || 0),
    optional: Boolean(sections[entry.sectionIndex].optional || entry.item?.optional),
  }));
  const hidden = (charts, rows, includeZero = false) => t('hidden', { items: [
    (charts || includeZero) && t(charts === 1 ? 'hiddenChart' : 'hiddenCharts', { count: charts }),
    (rows || includeZero) && t(rows === 1 ? 'hiddenRow' : 'hiddenRows', { count: rows }),
  ].filter(Boolean).join(t('listSeparator')) });
  const omitted = selected => {
    const charts = items.filter(item => item.kind === 'metric' && !selected.has(item)).length;
    const rows = items.filter(item => item.kind === 'row' && !selected.has(item)).length;
    return charts || rows ? t('hiddenHint', { notice: hidden(charts, rows) }) : '';
  };
  const layouts = [
    { graphHeight: 5, details: true, stats: true, timeline: true, separators: true, footer: true },
    { graphHeight: 4, details: true, stats: true, timeline: true, separators: true, footer: true },
    { graphHeight: 3, details: true, stats: true, timeline: true, separators: true, footer: true },
    { graphHeight: 2, details: true, timeline: true, separators: true, footer: true },
    { graphHeight: 2, timeline: true, separators: true },
    { graphHeight: 2 },
  ];
  const build = ({ graphHeight, details, stats, timeline, separators, footer }, selected) => {
    const rows = [align(paint('1;36', t('title')), muted(t('recent', { duration: duration(windowSeconds) })), width)];
    for (const [sectionIndex, section] of sections.entries()) {
      const members = items.filter(item => item.sectionIndex === sectionIndex && selected.has(item));
      if (!members.length) continue;
      const tone = tones[section.tone] || 36;
      const border = s => muted(s);
      const tag = truncVis(section.tag ? ` ${section.tag} ` : '', Math.max(0, width - 7));
      const title = truncVis(` ${section.title} `, Math.max(0, width - 3 - visLen(tag)));
      const rail = Math.max(0, width - 3 - visLen(title) - visLen(tag));
      rows.push(border('┌─') + paint('1;' + tone, title) + border('─'.repeat(rail)) + muted(tag) + border('┐'));
      const body = line => rows.push(border('│ ') + padVis(truncVis(line, inner), inner) + border(' │'));
      const separator = () => rows.push(border('├' + '─'.repeat(width - 2) + '┤'));
      const metrics = members.filter(item => item.kind === 'metric').map(entry => entry.item);
      for (let i = 0; i < metrics.length; i += paired ? 2 : 1) {
        if (i && separators) separator();
        const chunk = metrics.slice(i, i + (paired ? 2 : 1));
        const rendered = chunk.map(metric => {
          const c = tones[metric.tone] || tone;
          const result = [align(paint('1;' + c, metric.label), paint('1;' + c, metric.value), metricWidth)];
          if (details) {
            result.push(metric.meter != null && Number.isFinite(metric.meter)
              ? meter(metric.meter, metricWidth, metric.tone || section.tone)
              : muted(truncVis(metric.detail || '', metricWidth)));
          }
          if (graphHeight) {
            const graph = metricGraph(metric, graphHeight);
            result.push(...graph.map(row => muted(row.axis) + paint(c, row.plot)));
          }
          if (stats && metric.stats !== false) {
            const observed = metricStats(metric);
            const format = metric.statsFormat || metric.scale?.format || compactNumber;
            const number = value => value == null ? '—' : format(value);
            result.push(muted(`min ${number(observed.min)} · max ${number(observed.max)} · avg ${number(observed.avg)}`));
          } else if (stats) result.push('');
          return result;
        });
        for (let row = 0; row < rendered[0].length; row++) {
          body(paired && rendered[1]
            ? padVis(rendered[0][row], metricWidth) + border(' │ ') + rendered[1][row]
            : rendered[0][row]);
        }
      }
      if (timeline && metrics.length) body(paired
        ? muted(timeAxis(metricWidth)) + border(' │ ') + muted(timeAxis(metricWidth))
        : muted(timeAxis(inner)));
      const textRows = members.filter(item => item.kind === 'row').map(entry => entry.item);
      if (textRows.length && metrics.length && separators) separator();
      for (const row of textRows) {
        body(typeof row === 'string' ? row : align(row.label || '', paint(tones[row.tone] || tone, row.value ?? '—'), inner));
      }
      if (footer && section.footer) body(muted(section.footer));
      rows.push(border('└' + '─'.repeat(width - 2) + '┘'));
    }
    if (footer && items.some(item => item.kind === 'metric' && selected.has(item))) rows.push(muted(t('legend')) + paint(32, t('low')) + muted(' · ') + paint(33, t('medium')) + muted(' · ') + paint(31, t('high')));
    const notice = omitted(selected);
    if (notice) rows.push(muted(notice));
    return rows;
  };
  const bound = rows => rows.slice(0, height).map(row => truncVis(row, width));
  const chartLayout = selected => {
    // Keep useful context when it leaves at least eight plot rows. At shorter
    // heights, release metadata rows before shrinking the curves further.
    const candidates = [
      { details: true, stats: true, timeline: true, separators: true },
      { details: true, timeline: true, separators: true },
      { timeline: true, separators: true },
      { separators: true },
      {},
    ];
    let best;
    for (const candidate of candidates) {
      let overhead = 1 + Number(Boolean(omitted(selected))), groups = 0;
      for (const [sectionIndex] of sections.entries()) {
        const count = [...selected].filter(entry => entry.sectionIndex === sectionIndex).length;
        if (!count) continue;
        const sectionGroups = Math.ceil(count / (paired ? 2 : 1));
        groups += sectionGroups;
        overhead += 2 + sectionGroups * (1 + Number(Boolean(candidate.details)) + Number(Boolean(candidate.stats)))
          + (candidate.timeline ? 1 : 0) + (candidate.separators ? sectionGroups - 1 : 0);
      }
      if (!groups) return { graphHeight: 0 };
      const graphHeight = Math.min(16, Math.floor((height - overhead) / groups));
      if (graphHeight < 2) continue;
      const layout = { ...candidate, graphHeight };
      if (graphHeight >= 8) return layout;
      if (!best || graphHeight > best.graphHeight) best = layout;
    }
    return best;
  };
  const fitSelected = selected => {
    const choices = chartsOnly ? [chartLayout(selected)].filter(Boolean) : layouts;
    for (const layout of choices) {
      const rows = build(layout, selected);
      if (rows.length <= height) return bound(rows);
    }
  };
  const selected = new Set(items);
  if (width >= 16) {
    const complete = fitSelected(selected);
    if (complete) return complete;
    const removable = [...items].sort((a, b) => Number(b.optional) - Number(a.optional) || a.priority - b.priority || (a.kind === b.kind ? b.order - a.order : a.kind === 'row' ? -1 : 1));
    for (const item of removable) {
      // Keep a real trend visible even in a small terminal. A single-row plot is
      // reserved for terminals too short to fit one normal two-row chart.
      const remainingCharts = [...selected].filter(entry => entry.kind === 'metric');
      if (item.kind === 'metric' && remainingCharts.length === 1) {
        const rows = build({ graphHeight: 1 }, selected);
        if (rows.length <= height) return bound(rows);
        break;
      }
      selected.delete(item);
      const compact = fitSelected(selected);
      if (compact) return compact;
    }
  }
  // Very small sizes use a frameless preview so neither a partial box nor an
  // out-of-bounds axis can corrupt the adjacent terminal column.
  const best = [...items].filter(item => item.kind === 'metric').sort((a, b) => Number(a.optional) - Number(b.optional) || b.priority - a.priority || a.order - b.order)[0];
  const tiny = [paint('1;36', t('title'))];
  if (best && height >= 3) {
    tiny.push(align(best.item.label, best.item.value, width));
    if (height >= 4) tiny.push(...historyGraph(best.item.values || [], times, { width, height: 1, now, windowSeconds, ...best.item.scale }).map(row => muted(row.axis) + paint(tones[best.item.tone] || 36, row.plot)));
    tiny.push(muted(omitted(new Set([best])) || t('trendsHint')));
  } else if (height > 1) tiny.push(muted(hidden(items.filter(item => item.kind === 'metric').length, items.filter(item => item.kind === 'row').length, true)));
  return bound(tiny);
}

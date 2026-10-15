import { charW, visLen, truncVis, padVis } from './resource-panel.mjs';

// A wide terminal has two information columns on the left and a separate plot
// pane. Keep enough plot width for two legible charts beside each other.
export function dashboardLayout(cols) {
  cols = Math.max(1, Math.floor(cols));
  if (cols < 84) return { left: cols, right: 0, columns: 1, primary: cols, secondary: cols };
  const right = cols >= 180 ? Math.max(78, cols - Math.floor(cols * 0.60) - 3) : cols - Math.floor(cols * 0.56) - 3;
  const left = cols - right - 3;
  const columns = cols >= 180 ? 2 : 1;
  const primary = columns === 2 ? Math.floor((left - 3) / 2) : left;
  return { left, right, columns, primary, secondary: columns === 2 ? left - primary - 3 : left };
}

export function wrapTerminalLine(text, width) {
  if (width <= 0) return [];
  const rows = [];
  let line = '', used = 0, style = '';
  const tokens = String(text).match(/\x1b\[[0-9;?]*[A-Za-z]|[\s\S]/gu) || [];
  for (const token of tokens) {
    if (token.startsWith('\x1b')) {
      line += token;
      if (token.endsWith('m')) style = token === '\x1b[0m' || token === '\x1b[m' ? '' : style + token;
      continue;
    }
    const size = charW(token);
    if (used + size > width) {
      rows.push(line + (style ? '\x1b[0m' : ''));
      line = style;
      used = 0;
    }
    if (size > width) continue;
    line += token; used += size;
  }
  rows.push(line);
  return rows;
}

export function renderInformationSections(sections, { width, color = false }) {
  const paint = (code, text) => color ? '\x1b[' + code + 'm' + text + '\x1b[0m' : text;
  const tones = { cyan: 36, magenta: 35, green: 32, yellow: 33, red: 31 };
  const result = [];
  for (const section of sections) {
    if (!section.rows?.length) continue;
    if (result.length) result.push('');
    const title = '▍' + section.title + ' ';
    result.push(paint('1;' + (tones[section.tone] || 36), truncVis(title, width)) + paint('2', '─'.repeat(Math.max(0, width - visLen(title)))));
    for (const row of section.rows) {
      if (typeof row === 'string') { result.push(...wrapTerminalLine(row, width)); continue; }
      const label = row.label || '', value = String(row.value ?? '—');
      if (!label) result.push(...wrapTerminalLine(paint(tones[row.tone] || tones[section.tone] || 36, value), width));
      else if (visLen(label) + visLen(value) + 2 <= width) {
        result.push(padVis(label, width - visLen(value)) + paint(tones[row.tone] || tones[section.tone] || 36, value));
      } else {
        result.push(...wrapTerminalLine(label, width));
        result.push(...wrapTerminalLine(paint(tones[row.tone] || tones[section.tone] || 36, '  ' + value), width));
      }
    }
  }
  return result;
}

export function composeInformationPane({ header = [], primary = [], secondary = [] }, { layout, height, offset = 0, color = false, scroll = false, help = false }) {
  const paintSeparator = color ? '\x1b[2m │ \x1b[0m' : ' │ ';
  const pinned = header.map(line => truncVis(line, layout.left));
  const paired = layout.columns === 2 && !help;
  const leftRows = primary.flatMap(line => wrapTerminalLine(line, paired ? layout.primary : layout.left));
  const rightRows = secondary.flatMap(line => wrapTerminalLine(line, paired ? layout.secondary : layout.left));
  const count = paired ? Math.max(leftRows.length, rightRows.length) : leftRows.length + rightRows.length;
  const available = Number.isFinite(height) ? Math.max(0, height - pinned.length) : count;
  const top = scroll ? Math.max(0, Math.min(Math.floor(offset), Math.max(0, count - available))) : 0;
  const body = [];
  const take = scroll || Number.isFinite(height) ? Math.min(available, count - top) : count;
  const single = paired ? null : leftRows.concat(rightRows);
  for (let index = top; index < top + take; index++) {
    body.push(paired ? padVis(leftRows[index] || '', layout.primary) + paintSeparator + (rightRows[index] || '') : single[index]);
  }
  const rows = pinned.concat(body);
  return { rows: Number.isFinite(height) ? rows.slice(0, height) : rows, offset: top, total: count, viewportRows: available };
}

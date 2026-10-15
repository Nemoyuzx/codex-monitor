export const VIEW_NAMES = { overview: '总览', host: '主机', tasks: '任务', diagnostics: '诊断' };

export function commandArgs(args) {
  return args.some(arg => ['-w', '--watch', '--once', '--json', '-h', '--help'].includes(arg)) ? [...args] : ['--watch', ...args];
}

export function parseOptions(args) {
  const result = { watch: false, interval: 1, windowSeconds: null, view: 'overview', interfaceName: undefined,
    json: false, noProbes: false, help: false, once: false, threads: 8, metricsDb: undefined };
  const values = { '-i': 'interval', '--interval': 'interval', '--window': 'windowSeconds', '--view': 'view',
    '--interface': 'interfaceName', '--threads': 'threads', '--metrics-db': 'metricsDb' };
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].split(/=(.*)/s);
    if (values[flag]) {
      const value = inline ?? args[++i];
      if (!value || value.startsWith('--')) throw new Error(flag + ' 缺少参数');
      result[values[flag]] = value;
    } else if (flag === '-w' || flag === '--watch') result.watch = true;
    else if (flag === '--json') result.json = true;
    else if (flag === '--once') result.once = true;
    else if (flag === '--no-probes') result.noProbes = true;
    else if (flag === '-h' || flag === '--help') result.help = true;
    else if (!['--color', '--no-color'].includes(flag)) throw new Error('未知参数：' + flag);
  }
  for (const [field, min, max] of [['interval', 1, 3600], ['windowSeconds', 10, 3600], ['threads', 1, 30]]) {
    if (result[field] == null) continue;
    const value = Number(result[field]);
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) throw new Error(field + ' 需为 ' + min + '–' + max + ' 的整数');
    result[field] = value;
  }
  if (!Object.hasOwn(VIEW_NAMES, result.view)) throw new Error('--view 可选 overview、host、tasks、diagnostics');
  result.windowSeconds ??= Math.min(3600, 80 * result.interval);
  if (result.once) result.watch = false;
  return result;
}

export function reduceKey(state, key, pageRows = 20) {
  const next = { ...state };
  const views = ['overview', 'host', 'tasks', 'diagnostics'];
  if (/^[1-4]$/.test(key)) { next.view = views[Number(key) - 1]; next.leftOffset = 0; next.showHelp = false; }
  else if (key === ' ' || key === 'p') next.paused = !state.paused;
  else if (key === 'q' || key === '\x03') next.quit = true;
  else if (key === 'h' || key === '?') { next.showHelp = !state.showHelp; next.leftOffset = 0; }
  else if (key === 'r') next.refreshRequested = true;
  else if (key === '\x1b[A' || key === 'k') next.leftOffset = Math.max(0, state.leftOffset - 1);
  else if (key === '\x1b[B' || key === 'j') next.leftOffset++;
  else if (key === '\x1b[5~') next.leftOffset = Math.max(0, state.leftOffset - pageRows);
  else if (key === '\x1b[6~') next.leftOffset += pageRows;
  else if (key === '\x1b[H' || key === '\x1b[1~' || key === 'g') next.leftOffset = 0;
  else if (key === '[') next.windowSeconds = Math.max(10, Math.round(state.windowSeconds / 2));
  else if (key === ']') next.windowSeconds = Math.min(3600, state.windowSeconds * 2);
  else return state;
  return next;
}

export function splitKeys(chunk) {
  return String(chunk).match(/\x1b\[[0-9;]*[A-Za-z~]|[\s\S]/gu) || [];
}

export function createKeyDecoder() {
  let pending = '';
  return chunk => {
    pending += String(chunk);
    const keys = [];
    while (pending) {
      if (pending[0] !== '\x1b') { keys.push(pending[0]); pending = pending.slice(1); continue; }
      if (pending.length === 1) break;
      if (pending[1] !== '[') { pending = pending.slice(2); continue; }
      const complete = pending.match(/^\x1b\[[0-9;]*[A-Za-z~]/);
      if (complete) { keys.push(complete[0]); pending = pending.slice(complete[0].length); continue; }
      if (/^\x1b\[[0-9;]*$/.test(pending) && pending.length < 32) break;
      pending = pending.slice(2);
    }
    return keys;
  };
}

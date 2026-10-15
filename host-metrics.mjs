// Read-only host sampling. Unknown, failed, reset, and first-delta samples stay null.
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const CPU_KEYS = ['user', 'nice', 'sys', 'idle', 'irq'];
const DISK_KEYS = { readBytes: 'Bytes (Read)', writeBytes: 'Bytes (Write)', readOps: 'Operations (Read)', writeOps: 'Operations (Write)' };
const SHELLS = new Set(['sh', 'zsh', 'bash', 'fish', 'dash', 'tcsh', 'csh', 'pwsh']);
const RUNTIMES = new Set(['node', 'node_repl', 'python', 'python3', 'python3.11', 'python3.12', 'python3.13', 'uv', 'uvx', 'npx', 'npm', 'bun', 'deno']);
const isRuntime = name => RUNTIMES.has(name) || /^python\d+(?:\.\d+)?$/.test(name);

function defaultRun(file, args) {
  return execFileSync(file, args, { encoding: 'utf8', timeout: 1500, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}
const nonnegative = value => Number.isFinite(value) && value >= 0;
const rate = (current, previous, seconds) => nonnegative(current) && nonnegative(previous) && current >= previous && seconds > 0 ? (current - previous) / seconds : null;

function cpuSnapshot(cpus) {
  return cpus.map(cpu => CPU_KEYS.map(key => nonnegative(cpu?.times?.[key]) ? cpu.times[key] : null));
}

export function cpuUsageBetween(previous, current) {
  const empty = { usagePercent: null, perCore: current.map(() => null), logicalCores: current.length };
  if (!previous || previous.length !== current.length || !current.length) return empty;
  let busy = 0, total = 0;
  const perCore = current.map((ticks, i) => {
    if (ticks.some((value, key) => value === null || previous[i][key] === null || value < previous[i][key])) return null;
    const delta = ticks.map((value, key) => value - previous[i][key]);
    const sum = delta.reduce((a, b) => a + b, 0);
    if (!(sum > 0)) return null;
    total += sum;
    busy += sum - delta[3];
    return (sum - delta[3]) / sum * 100;
  });
  return { usagePercent: perCore.some(value => value === null) || !total ? null : busy / total * 100, perCore, logicalCores: current.length };
}

function elapsedSeconds(text) {
  const match = text.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  return match ? Number(match[1] || 0) * 86400 + Number(match[2] || 0) * 3600 + Number(match[3]) * 60 + Number(match[4]) : null;
}

function executable(command) {
  const match = command.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s+([\s\S]*))?$/);
  const first = match ? { file: match[1] || match[2] || match[3], args: match[4] || '' } : { file: '', args: '' };
  // Never scan past a shell/runtime executable into its command/script arguments.
  if (!first.file.includes('.app/') || /^["']/.test(command) || SHELLS.has(path.basename(first.file)) || isRuntime(path.basename(first.file))) return first;
  // ps does not quote paths with spaces. Match the known application binaries first.
  const app = command.match(/^(.*?\/(?:ChatGPT|Codex)\.app\/Contents\/MacOS\/(?:ChatGPT|Codex))(?=\s|$)/i)
    || command.match(/^(.*?\/(?:Codex|ChatGPT) \((?:Renderer|Service|GPU|Plugin)\)\.app\/Contents\/MacOS\/(?:Codex|ChatGPT) \((?:Renderer|Service|GPU|Plugin)\))(?=\s|$)/i);
  if (app && !/\s+(?:-|\/)/.test(app[1])) return { file: app[1], args: command.slice(app[1].length).trim() };
  return first;
}

function parsePs(text) {
  const result = [];
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;
    const [, pid, ppid, cpu, rss, elapsed, command] = match;
    const exec = executable(command);
    result.push({ pid: Number(pid), ppid: Number(ppid), cpuPercent: Number(cpu), rssBytes: Number(rss) * 1024,
      elapsedSeconds: elapsedSeconds(elapsed), name: path.basename(exec.file).replace(/[^\p{L}\p{N} ._()+-]/gu, ''), exec });
  }
  return result;
}

function runtimeScript(exec) {
  const name = path.basename(exec.file);
  if (!isRuntime(name)) return '';
  // Inspect only executable/script tokens, never inline code, shell text or arbitrary option values.
  const tokens = exec.args.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '-m' && /^python(?:\d+(?:\.\d+)?)?$/.test(name)) return /^[\w.]+$/.test(tokens[i + 1] || '') ? tokens[i + 1] : '';
    if (token === '--from' && ['uv', 'uvx'].includes(name)) return tokens[i + 1] || '';
    if (/^-(?:e|c|p|m|r|l|C)$/.test(token) || token.startsWith('--eval')) return '';
    if (name === 'uv' && ['tool', 'run'].includes(token)) continue;
    if (token.startsWith('-')) continue;
    return token.replace(/^['"]|['"]$/g, '');
  }
  return '';
}

function directRole(proc) {
  const { file, args } = proc.exec;
  const name = path.basename(file);
  if (/^(?:ChatGPT|Codex)$/i.test(name) && /\/(?:ChatGPT|Codex)\.app\/Contents\/MacOS\//i.test(file)) return 'desktop';
  if (/^(?:ChatGPT|Codex) \(Renderer\)$/i.test(name)) return 'renderer';
  if (/^(?:ChatGPT|Codex) \((?:Service|GPU|Plugin)\)$/i.test(name)) return 'service';
  if (name === 'codex-code-mode-host') return 'code-mode';
  if (name !== 'codex') return null;
  // Exact argv tokens are required; merely mentioning a Codex path cannot select a process.
  const tokens = args.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  if (tokens.includes('app-server')) return 'app-server';
  if (tokens.includes('exec-server')) return 'exec-server';
  return 'cli';
}

function descendantsOf(seed, children) {
  const ids = new Set(seed), queue = [...seed];
  for (let i = 0; i < queue.length; i++) for (const child of children.get(queue[i]) || []) {
    if (!ids.has(child.pid)) { ids.add(child.pid); queue.push(child.pid); }
  }
  return ids;
}

function summarizeProcesses(text, ownPid, topLimit) {
  const raw = parsePs(text), children = new Map();
  for (const proc of raw) {
    if (!children.has(proc.ppid)) children.set(proc.ppid, []);
    children.get(proc.ppid).push(proc);
  }
  const monitorIds = raw.filter(proc => /^codex-(?:status|monitor)\.(?:mjs|cjs|js)$/.test(path.basename(runtimeScript(proc.exec)))).map(proc => proc.pid);
  const excluded = descendantsOf([ownPid, ...monitorIds], children);
  const selected = new Map();
  const appRoots = raw.filter(proc => !excluded.has(proc.pid) && ['desktop', 'app-server', 'exec-server', 'cli', 'code-mode'].includes(directRole(proc)));
  const queue = appRoots.map(proc => ({ proc, role: directRole(proc) }));
  for (let i = 0; i < queue.length; i++) {
    const { proc, role } = queue[i];
    if (excluded.has(proc.pid) || selected.has(proc.pid)) continue;
    if (SHELLS.has(path.basename(proc.exec.file))) {
      for (const child of children.get(proc.pid) || []) queue.push({ proc: child, role });
      continue;
    }
    selected.set(proc.pid, { ...proc, role });
    for (const child of children.get(proc.pid) || []) {
      if (excluded.has(child.pid)) continue;
      const name = path.basename(child.exec.file);
      const explicit = directRole(child);
      // User terminals opened by the desktop are not Codex workload. A tool shell itself
      // is omitted, but its actual command descendants can still belong to the worker tree.
      if (SHELLS.has(name)) {
        if (['desktop', 'renderer', 'service'].includes(role)) continue;
        for (const grandchild of children.get(child.pid) || []) queue.push({ proc: grandchild, role: role === 'mcp' ? 'mcp' : 'worker' });
        continue;
      }
      const script = runtimeScript(child.exec);
      const isMcp = /(?:^|[/@_-])mcp(?:[/_.-]|$)|@modelcontextprotocol/i.test(name + '/' + script);
      const childRole = explicit || (isMcp || role === 'mcp' ? 'mcp' : name === 'node_repl' || role === 'code-mode' ? 'code-mode' : 'worker');
      queue.push({ proc: child, role: childRole });
    }
  }
  // Keep all commands private to the classifier. Only short executable names leave it.
  const safe = (proc, role = null) => ({ pid: proc.pid, ppid: proc.ppid, name: proc.name, role, cpuPercent: proc.cpuPercent, rssBytes: proc.rssBytes, elapsedSeconds: proc.elapsedSeconds });
  const items = [...selected.values()].map(proc => safe(proc, proc.role)).sort((a, b) => b.cpuPercent - a.cpuPercent || a.pid - b.pid);
  const counts = {};
  for (const proc of items) counts[proc.role] = (counts[proc.role] || 0) + 1;
  const host = raw.filter(proc => !excluded.has(proc.pid) && !SHELLS.has(path.basename(proc.exec.file))).map(proc => safe(proc, selected.get(proc.pid)?.role || null));
  const available = raw.length > 0;
  return { available, items, counts, cpuPercent: available ? items.reduce((sum, proc) => sum + proc.cpuPercent, 0) : null,
    rssBytes: available ? items.reduce((sum, proc) => sum + proc.rssBytes, 0) : null,
    topCpu: host.toSorted((a, b) => b.cpuPercent - a.cpuPercent || b.rssBytes - a.rssBytes).slice(0, topLimit),
    topRss: host.toSorted((a, b) => b.rssBytes - a.rssBytes || b.cpuPercent - a.cpuPercent).slice(0, topLimit) };
}

export function parseNetworkSnapshot(text) {
  const interfaces = new Map();
  for (const line of text.split('\n')) {
    const columns = line.trim().split(/\s+/);
    if (!/^<Link#\d+>$/.test(columns[2] || '')) continue;
    // Link rows may omit the hardware address. The seven trailing counters are stable.
    const counters = columns.slice(-7).map(Number);
    if (counters.length !== 7 || ![0, 2, 3, 5].every(index => Number.isSafeInteger(counters[index]) && counters[index] >= 0)) continue;
    const name = columns[0].replace(/\*$/, '');
    interfaces.set(name, { name, inBytes: counters[2], outBytes: counters[5] });
  }
  return [...interfaces.values()];
}

export function parseDiskSnapshot(text) {
  const devices = [];
  for (const block of text.split(/(?=\+-o )/)) {
    const header = block.match(/^\+-o .*?<class IOBlockStorageDriver, id (0x[\da-f]+)/i);
    const statistics = block.match(/"Statistics"\s*=\s*\{([^}]*)\}/);
    if (!header || !statistics) continue;
    const device = { id: header[1] };
    for (const [field, key] of Object.entries(DISK_KEYS)) {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = statistics[1].match(new RegExp('"' + escaped + '"\\s*=\\s*(\\d+)'));
      device[field] = match && Number.isSafeInteger(Number(match[1])) ? Number(match[1]) : null;
    }
    if (Object.keys(DISK_KEYS).every(key => device[key] !== null) && !devices.some(previous => previous.id === device.id)) devices.push(device);
  }
  return devices;
}

export function parsePowerSnapshot(text) {
  const match = text.match(/(\d+)%;\s*([^;\n]+)(?:;\s*(\d+):(\d+)\s+remaining)?/);
  if (!match || Number(match[1]) > 100) return null;
  return { pct: Number(match[1]), state: match[2].trim(), source: (text.match(/Now drawing from '([^']+)'/) || [])[1] || null,
    remainingMinutes: match[3] && !/^charged$/i.test(match[2].trim()) ? Number(match[3]) * 60 + Number(match[4]) : null };
}

/**
 * run(file, args) and cpus() are injectable for deterministic tests. sample() is synchronous.
 * CPU is interval usage; process CPU is macOS ps %CPU (a decaying average, single core=100%).
 * RSS is summed resident memory, not unique physical memory (shared pages can overlap).
 * Network follows the default-route interface or an explicit interfaceName, never sums tunnels.
 * Disk counters cover IOBlockStorageDriver devices, including attached disk images.
 */
export function createHostSampler({ interfaceName, now = Date.now, run = defaultRun, cpus = os.cpus, pid = process.pid,
  platform = process.platform, topLimit = 5, peripheralIntervalMs = 30_000, routeIntervalMs = 1000 } = {}) {
  let previousCpu = null, previousNetwork = null, previousDisk = null;
  let peripheralAt = null, routeAt = null, routeInterface = null, power = null, pressure = null;
  const read = (file, args) => { try { const value = run(file, args); return typeof value === 'string' ? value : String(value || ''); } catch { return ''; } };
  return { sample() {
    const at = now();
    let ticks = [];
    try { ticks = cpuSnapshot(cpus()); } catch {}
    const cpu = cpuUsageBetween(previousCpu, ticks);
    previousCpu = ticks.length ? ticks : null;
    const psText = read('ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,etime=,command=']);
    const processes = summarizeProcesses(psText, pid, Math.max(1, Math.floor(topLimit)));
    if (platform === 'darwin' && (peripheralAt === null || at - peripheralAt >= peripheralIntervalMs || at < peripheralAt)) {
      power = parsePowerSnapshot(read('pmset', ['-g', 'batt']));
      const level = Number(read('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']).trim());
      pressure = [1, 2, 4].includes(level) ? { level, state: ({ 1: 'normal', 2: 'warning', 4: 'critical' })[level] } : null;
      peripheralAt = at;
    }
    const counters = platform === 'darwin' ? parseNetworkSnapshot(read('netstat', ['-ibn'])) : [];
    // Route changes are independent of the slower power/pressure cache. If the cached
    // interface vanishes, discover its replacement without waiting for the route TTL.
    const routeMissing = routeInterface !== null && !counters.some(entry => entry.name === routeInterface);
    if (platform === 'darwin' && !interfaceName && (routeAt === null || at - routeAt >= routeIntervalMs || at < routeAt || routeMissing)) {
      routeInterface = (read('route', ['-n', 'get', 'default']).match(/^\s*interface:\s*(\S+)/m) || [])[1] || null;
      routeAt = at;
    }
    const seconds = previousNetwork ? (at - previousNetwork.at) / 1000 : null;
    const interfaces = counters.map(current => {
      const previous = previousNetwork?.interfaces.find(entry => entry.name === current.name);
      return { ...current, inRate: rate(current.inBytes, previous?.inBytes, seconds), outRate: rate(current.outBytes, previous?.outBytes, seconds) };
    });
    const selected = interfaces.find(entry => entry.name === interfaceName)
      || (!interfaceName && interfaces.find(entry => entry.name === routeInterface));
    const network = { interfaceName: selected?.name || interfaceName || routeInterface || null,
      inBytes: selected?.inBytes ?? null, outBytes: selected?.outBytes ?? null, inRate: selected?.inRate ?? null, outRate: selected?.outRate ?? null, interfaces };
    previousNetwork = counters.length ? { at, interfaces: counters } : null;
    // Depth 1 is essential: APFS descendants expose another Statistics dictionary and
    // must not be added to the underlying IOBlockStorageDriver device counters.
    const devices = platform === 'darwin' ? parseDiskSnapshot(read('ioreg', ['-r', '-c', 'IOBlockStorageDriver', '-d', '1', '-k', 'Statistics'])) : [];
    const disk = { readBytes: null, writeBytes: null, readOps: null, writeOps: null, readRate: null, writeRate: null, readIOPS: null, writeIOPS: null, devices };
    if (devices.length) {
      for (const key of Object.keys(DISK_KEYS)) disk[key] = devices.reduce((sum, device) => sum + device[key], 0);
      const sameDevices = previousDisk && devices.length === previousDisk.devices.length && devices.every(device => previousDisk.devices.some(entry => entry.id === device.id));
      if (sameDevices) {
        const seconds = (at - previousDisk.at) / 1000;
        for (const [counter, output] of [['readBytes', 'readRate'], ['writeBytes', 'writeRate'], ['readOps', 'readIOPS'], ['writeOps', 'writeIOPS']]) {
          const rates = devices.map(device => rate(device[counter], previousDisk.devices.find(entry => entry.id === device.id)[counter], seconds));
          disk[output] = rates.every(value => value !== null) ? rates.reduce((sum, value) => sum + value, 0) : null;
        }
      }
    }
    previousDisk = devices.length ? { at, devices } : null;
    const result = { at, cpu, processes, network, disk, power, pressure, thermal: null };
    // Legacy internal diagnostics may inspect this, but JSON exports never contain argv.
    Object.defineProperty(result, 'processSnapshot', { value: psText, enumerable: false });
    return result;
  } };
}

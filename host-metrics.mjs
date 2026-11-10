// Read-only host sampling. Unknown, failed, reset, and first-delta samples stay null.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const CPU_KEYS = ['user', 'nice', 'sys', 'idle', 'irq'];
const DISK_KEYS = { readBytes: 'Bytes (Read)', writeBytes: 'Bytes (Write)', readOps: 'Operations (Read)', writeOps: 'Operations (Write)' };
const SHELLS = new Set(['sh', 'zsh', 'bash', 'fish', 'dash', 'tcsh', 'csh', 'pwsh', 'powershell', 'cmd']);
const RUNTIMES = new Set(['node', 'node_repl', 'python', 'python3', 'python3.11', 'python3.12', 'python3.13', 'uv', 'uvx', 'npx', 'npm', 'bun', 'deno']);
const isRuntime = name => RUNTIMES.has(name) || /^python\d+(?:\.\d+)?$/.test(name);

function defaultRun(file, args) {
  return execFileSync(file, args, { encoding: 'utf8', timeout: file === 'powershell.exe' ? 5000 : 1500, maxBuffer: 8 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
}
const baseName = file => String(file).includes('\\') ? path.win32.basename(file) : path.basename(file);
const executableName = file => baseName(file).replace(/\.exe$/i, '').toLowerCase();
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
  if (!first.file.includes('.app/') || /^["']/.test(command) || SHELLS.has(executableName(first.file)) || isRuntime(executableName(first.file))) return first;
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
      elapsedSeconds: elapsedSeconds(elapsed), name: baseName(exec.file).replace(/[^\p{L}\p{N} ._()+-]/gu, ''), exec });
  }
  return result;
}

function runtimeScript(exec) {
  const name = executableName(exec.file);
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
  const name = executableName(file);
  if (/^(?:ChatGPT|Codex)$/i.test(name) && /\/(?:ChatGPT|Codex)\.app\/Contents\/MacOS\//i.test(file)) return 'desktop';
  if (/^(?:ChatGPT|Codex) \(Renderer\)$/i.test(name)) return 'renderer';
  if (/^(?:ChatGPT|Codex) \((?:Service|GPU|Plugin)\)$/i.test(name)) return 'service';
  if (name === 'codex-code-mode-host') return 'code-mode';
  if (name !== 'codex') return null;
  // Exact argv tokens are required; merely mentioning a Codex path cannot select a process.
  const tokens = args.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  if (tokens.includes('app-server')) return 'app-server';
  if (tokens.includes('exec-server')) return 'exec-server';
  if (tokens.includes('--type=renderer')) return 'renderer';
  if (tokens.some(token => /^--type=(?:gpu-process|utility)$/.test(token))) return 'service';
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
  const raw = Array.isArray(text) ? text : parsePs(text), children = new Map();
  for (const proc of raw) {
    if (!children.has(proc.ppid)) children.set(proc.ppid, []);
    children.get(proc.ppid).push(proc);
  }
  const monitorIds = raw.filter(proc => /^codex-(?:status|monitor)\.(?:mjs|cjs|js)$/.test(baseName(runtimeScript(proc.exec)))).map(proc => proc.pid);
  const excluded = descendantsOf([ownPid, ...monitorIds], children);
  const selected = new Map();
  const appRoots = raw.filter(proc => !excluded.has(proc.pid) && ['desktop', 'app-server', 'exec-server', 'cli', 'code-mode'].includes(directRole(proc)));
  const queue = appRoots.map(proc => ({ proc, role: directRole(proc) }));
  for (let i = 0; i < queue.length; i++) {
    const { proc, role } = queue[i];
    if (excluded.has(proc.pid) || selected.has(proc.pid)) continue;
    if (SHELLS.has(executableName(proc.exec.file))) {
      for (const child of children.get(proc.pid) || []) queue.push({ proc: child, role });
      continue;
    }
    selected.set(proc.pid, { ...proc, role });
    for (const child of children.get(proc.pid) || []) {
      if (excluded.has(child.pid)) continue;
      const name = executableName(child.exec.file);
      const explicit = directRole(child);
      // User terminals opened by the desktop are not Codex workload. A tool shell itself
      // is omitted, but its actual command descendants can still belong to the worker tree.
      if (SHELLS.has(name)) {
        if (['desktop', 'renderer', 'service'].includes(role)) continue;
        for (const grandchild of children.get(child.pid) || []) queue.push({ proc: grandchild, role: role === 'mcp' ? 'mcp' : 'worker' });
        continue;
      }
      const script = runtimeScript(child.exec);
      const isMcp = /(?:^|[/@_-])mcp(?:[/_.-]|$)|@modelcontextprotocol/i.test((name + '/' + script).replaceAll('\\', '/'));
      const childRole = explicit || (isMcp || role === 'mcp' ? 'mcp' : name === 'node_repl' || role === 'code-mode' ? 'code-mode' : 'worker');
      queue.push({ proc: child, role: childRole });
    }
  }
  // Keep all commands private to the classifier. Only short executable names leave it.
  const safe = (proc, role = null) => ({ pid: proc.pid, ppid: proc.ppid, name: proc.name, role, cpuPercent: proc.cpuPercent, rssBytes: proc.rssBytes, elapsedSeconds: proc.elapsedSeconds });
  const cpuOrder = (a, b) => (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1) || a.pid - b.pid;
  const items = [...selected.values()].map(proc => safe(proc, proc.role)).sort(cpuOrder);
  const counts = {};
  for (const proc of items) counts[proc.role] = (counts[proc.role] || 0) + 1;
  const host = raw.filter(proc => !excluded.has(proc.pid) && !SHELLS.has(executableName(proc.exec.file))).map(proc => safe(proc, selected.get(proc.pid)?.role || null));
  const available = raw.length > 0;
  return { available, items, counts, cpuPercent: available && items.every(proc => nonnegative(proc.cpuPercent)) ? items.reduce((sum, proc) => sum + proc.cpuPercent, 0) : null,
    rssBytes: available && items.every(proc => nonnegative(proc.rssBytes)) ? items.reduce((sum, proc) => sum + proc.rssBytes, 0) : null,
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

export function parseLinuxNetworkSnapshot(text) {
  const result = [];
  for (const line of String(text).split('\n').slice(0, 4096)) {
    const match = line.match(/^\s*([^:\s]+):\s*(.+)$/);
    if (!match) continue;
    const fields = match[2].trim().split(/\s+/);
    const incoming = Number(fields[0]), outgoing = Number(fields[8]);
    if (fields.length >= 16 && [incoming, outgoing].every(value => Number.isSafeInteger(value) && value >= 0)) {
      result.push({ name: match[1], inBytes: incoming, outBytes: outgoing });
    }
  }
  return result;
}

export function parseLinuxDefaultInterface(ipv4, ipv6 = '') {
  const candidates = [];
  for (const line of String(ipv4).split('\n').slice(0, 4096)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 8 || fields[1] !== '00000000' || fields[7] !== '00000000') continue;
    const flags = Number.parseInt(fields[3], 16), metric = Number(fields[6]);
    if ((flags & 1) && !(flags & 0x200) && Number.isFinite(metric) && metric >= 0) candidates.push({ name: fields[0], metric, family: 4 });
  }
  for (const line of String(ipv6).split('\n').slice(0, 4096)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10 || !/^0{32}$/.test(fields[0]) || fields[1] !== '00') continue;
    const flags = Number.parseInt(fields[8], 16), metric = Number.parseInt(fields[5], 16);
    if ((flags & 1) && !(flags & 0x200) && Number.isFinite(metric)) candidates.push({ name: fields[9], metric, family: 6 });
  }
  return candidates.sort((a, b) => a.family - b.family || a.metric - b.metric)[0]?.name || null;
}

export function parseLinuxDiskSnapshot(text, isWholeDevice) {
  const result = [];
  for (const line of String(text).split('\n').slice(0, 8192)) {
    const fields = line.trim().split(/\s+/), name = fields[2];
    if (fields.length < 14 || !/^[A-Za-z0-9_.!+-]+$/.test(name || '') || /^(?:loop|ram|fd|zram)\d+$/.test(name)) continue;
    let whole = false;
    try { whole = isWholeDevice(name) === true; } catch {}
    if (!whole) continue;
    const values = [fields[3], fields[5], fields[7], fields[9]].map(Number);
    if (!values.every(value => Number.isSafeInteger(value) && value >= 0)) continue;
    const [readOps, readSectors, writeOps, writeSectors] = values;
    if (![readSectors * 512, writeSectors * 512].every(Number.isSafeInteger)) continue;
    result.push({ id: fields[0] + ':' + fields[1] + ':' + name, readBytes: readSectors * 512, writeBytes: writeSectors * 512, readOps, writeOps });
  }
  return result;
}

const WINDOWS_HOST_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
function Read-Data([scriptblock]$action) { try { @(& $action) } catch { $null } }
$processes = Read-Data { Get-CimInstance Win32_Process | Select-Object -First 16384 | ForEach-Object {
  $p = $_
  [pscustomobject]@{ pid=$p.ProcessId; ppid=$p.ParentProcessId; name=$p.Name; executable=$p.ExecutablePath; command=$p.CommandLine;
    cpu100ns=if($null -ne $p.KernelModeTime -and $null -ne $p.UserModeTime){([decimal]$p.KernelModeTime + [decimal]$p.UserModeTime).ToString('0',[Globalization.CultureInfo]::InvariantCulture)}else{$null};
    rssBytes=[string]$p.WorkingSetSize; startedAt=if($p.CreationDate){([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds()}else{$null} }
} }
$networks = Read-Data { Get-NetAdapter -IncludeHidden | Select-Object -First 1024 | ForEach-Object {
  $adapter = $_; $stats = $adapter | Get-NetAdapterStatistics
  [pscustomobject]@{ name=$adapter.Name; ifIndex=$adapter.ifIndex; inBytes=[string]$stats.ReceivedBytes; outBytes=[string]$stats.SentBytes }
} }
$routes = Read-Data {
  $interfaces = @(Get-NetIPInterface)
  Get-NetRoute -PolicyStore ActiveStore | Where-Object { $_.DestinationPrefix -in @('0.0.0.0/0','::/0') } | Select-Object -First 1024 | ForEach-Object {
    $route = $_; $iface = $interfaces | Where-Object { $_.InterfaceIndex -eq $route.InterfaceIndex -and $_.AddressFamily -eq $route.AddressFamily } | Select-Object -First 1
    [pscustomobject]@{ name=$route.InterfaceAlias; ifIndex=$route.InterfaceIndex; prefix=$route.DestinationPrefix; metric=$route.RouteMetric; interfaceMetric=$iface.InterfaceMetric }
  }
}
$disks = Read-Data { Get-CimInstance Win32_PerfRawData_PerfDisk_PhysicalDisk | Where-Object { $_.Name -ne '_Total' } | Select-Object -First 1024 | ForEach-Object {
  [pscustomobject]@{ id=$_.Name; readBytes=[string]$_.DiskReadBytesPersec; writeBytes=[string]$_.DiskWriteBytesPersec; readOps=[string]$_.DiskReadsPersec; writeOps=[string]$_.DiskWritesPersec }
} }
$battery = Read-Data { Get-CimInstance Win32_Battery | Select-Object -First 8 EstimatedChargeRemaining,BatteryStatus,EstimatedRunTime }
$osInfo = Read-Data { Get-CimInstance Win32_OperatingSystem | Select-Object -First 1 TotalVisibleMemorySize,FreePhysicalMemory,LastBootUpTime }
$pagefiles = Read-Data { Get-CimInstance Win32_PageFileUsage | Select-Object -First 64 AllocatedBaseSize,CurrentUsage }
[ordered]@{ processes=$processes; networks=$networks; routes=$routes; disks=$disks; battery=$battery; operatingSystem=if($osInfo){@($osInfo)[0]}else{$null}; pagefiles=if($null -ne $pagefiles){@($pagefiles)}else{$null} } | ConvertTo-Json -Depth 5 -Compress
`;

const array = value => Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];
const counter = value => value !== null && value !== undefined && value !== '' && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;

function windowsProcesses(snapshot, previous, at) {
  const result = [];
  for (const item of array(snapshot?.processes).slice(0, 16384)) {
    const pid = counter(item.pid), ppid = counter(item.ppid);
    if (!pid || ppid === null) continue;
    const command = typeof item.command === 'string' ? item.command : '';
    const parsed = executable(command);
    const file = typeof item.executable === 'string' && item.executable ? item.executable : parsed.file || (typeof item.name === 'string' ? item.name : '');
    if (!file) continue;
    const args = command.startsWith(file) ? command.slice(file.length).trim() : parsed.args;
    const startedAt = counter(item.startedAt), cpu100ns = counter(item.cpu100ns);
    const before = previous?.items.find(entry => entry.pid === pid && entry.startedAt === startedAt && entry.file === file);
    const seconds = previous ? (at - previous.at) / 1000 : null;
    const delta = startedAt !== null ? rate(cpu100ns, before?.cpu100ns, seconds) : null;
    result.push({ pid, ppid, cpuPercent: delta === null ? null : delta / 100_000, rssBytes: counter(item.rssBytes),
      elapsedSeconds: startedAt !== null && at >= startedAt ? (at - startedAt) / 1000 : null,
      name: baseName(file).replace(/[^\p{L}\p{N} ._()+-]/gu, ''), exec: { file, args }, cpu100ns, startedAt, file, commandKnown: Boolean(command) });
  }
  return result;
}

function windowsNetwork(snapshot) {
  return array(snapshot?.networks).flatMap(item => {
    const inBytes = counter(item.inBytes), outBytes = counter(item.outBytes);
    return typeof item.name === 'string' && inBytes !== null && outBytes !== null ? [{ name: item.name, inBytes, outBytes }] : [];
  });
}

function windowsDefaultInterface(snapshot) {
  return array(snapshot?.routes).filter(route => typeof route.name === 'string' && ['0.0.0.0/0', '::/0'].includes(route.prefix)
    && counter(route.metric) !== null && counter(route.interfaceMetric) !== null)
    .sort((a, b) => (a.prefix === '0.0.0.0/0' ? 0 : 1) - (b.prefix === '0.0.0.0/0' ? 0 : 1)
      || Number(a.metric) + Number(a.interfaceMetric) - Number(b.metric) - Number(b.interfaceMetric))[0]?.name || null;
}

function windowsDisks(snapshot) {
  return array(snapshot?.disks).flatMap(item => {
    const values = Object.keys(DISK_KEYS).map(key => counter(item[key]));
    return typeof item.id === 'string' && item.id !== '_Total' && values.every(value => value !== null)
      ? [{ id: item.id, ...Object.fromEntries(Object.keys(DISK_KEYS).map((key, index) => [key, values[index]])) }] : [];
  });
}

function windowsPower(snapshot) {
  const item = array(snapshot?.battery)[0], pct = counter(item?.EstimatedChargeRemaining), status = counter(item?.BatteryStatus);
  if (pct === null || pct > 100) return null;
  const minutes = counter(item?.EstimatedRunTime);
  return { pct, state: status === 3 ? 'charged' : [6, 7, 8, 9].includes(status) ? 'charging' : [4, 5].includes(status) ? 'discharging' : 'unknown',
    source: null, remainingMinutes: minutes !== null && minutes < 71_582_788 ? minutes : null };
}

/**
 * run(file, args) and cpus() are injectable for deterministic tests. sample() is synchronous.
 * CPU is interval usage; processes use Unix ps %CPU or Windows cumulative time differences (one core=100%).
 * RSS is summed resident memory, not unique physical memory (shared pages can overlap).
 * Network follows the default-route interface or an explicit interfaceName, never sums tunnels.
 * Disk counters cover macOS storage drivers or whole Linux/Windows block devices.
 */
export function createHostSampler({ interfaceName, now = Date.now, run = defaultRun, cpus = os.cpus, pid = process.pid,
  platform = process.platform, topLimit = 5, peripheralIntervalMs = 30_000, routeIntervalMs = 1000,
  readFile = file => fs.readFileSync(file, 'utf8'), readdir = directory => fs.readdirSync(directory),
  wholeDisk = name => {
    const directory = '/sys/class/block/' + name;
    try {
      if (!fs.statSync(directory).isDirectory() || fs.readdirSync(directory + '/slaves').length) return false;
      try { fs.statSync(directory + '/partition'); return false; }
      catch (error) { return error.code === 'ENOENT'; }
    } catch { return false; }
  }, windowsCacheMs = 2500 } = {}) {
  let previousCpu = null, previousNetwork = null, previousDisk = null, previousProcesses = null;
  let peripheralAt = null, routeAt = null, routeInterface = null, power = null, pressure = null;
  let windowsAt = null, windowsResult = null;
  const read = (file, args) => { try { const value = run(file, args); return typeof value === 'string' ? value : String(value || ''); } catch { return ''; } };
  const readText = file => { try { return String(readFile(file)); } catch { return ''; } };
  const linuxPower = () => {
    let names = [];
    try { names = readdir('/sys/class/power_supply').slice(0, 64); } catch {}
    for (const name of names) {
      if (!/^[A-Za-z0-9_.-]+$/.test(name)) continue;
      const prefix = '/sys/class/power_supply/' + name + '/';
      if (readText(prefix + 'type').trim() !== 'Battery') continue;
      const pct = counter(readText(prefix + 'capacity').trim());
      if (pct === null || pct > 100) continue;
      const status = readText(prefix + 'status').trim();
      return { pct, state: ({ Full: 'charged', Charging: 'charging', Discharging: 'discharging' })[status] || 'unknown', source: name, remainingMinutes: null };
    }
    return null;
  };
  return { sample({ force = false } = {}) {
    let at = now();
    if (platform === 'win32' && !force && windowsResult && at >= windowsAt && at - windowsAt < windowsCacheMs) return windowsResult;
    let windowsSnapshot = null, windowsText = '';
    if (platform === 'win32') {
      windowsText = read('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_HOST_SCRIPT, 'utf16le').toString('base64')]);
      try { const parsed = JSON.parse(windowsText.replace(/^\uFEFF/, '')); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) windowsSnapshot = parsed; } catch {}
      at = now();
    }
    let ticks = [];
    try { ticks = cpuSnapshot(cpus()); } catch {}
    const cpu = cpuUsageBetween(previousCpu, ticks);
    previousCpu = ticks.length ? ticks : null;
    const psText = platform === 'win32' ? windowsText : platform === 'linux'
      ? read('ps', ['-eo', 'pid=,ppid=,pcpu=,rss=,etime=,args=']) : platform === 'darwin'
        ? read('ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,etime=,command=']) : '';
    const rawWindowsProcesses = platform === 'win32' ? windowsProcesses(windowsSnapshot, previousProcesses, at) : null;
    const processes = summarizeProcesses(rawWindowsProcesses || psText, pid, Math.max(1, Math.floor(topLimit)));
    if (platform === 'win32') processes.roleCoverageComplete = windowsSnapshot?.processes != null
      && !rawWindowsProcesses.some(proc => executableName(proc.exec.file) === 'codex' && !proc.commandKnown);
    if (platform === 'win32') previousProcesses = rawWindowsProcesses.length ? { at, items: rawWindowsProcesses } : null;
    if (platform === 'darwin' && (peripheralAt === null || at - peripheralAt >= peripheralIntervalMs || at < peripheralAt || force)) {
      power = parsePowerSnapshot(read('pmset', ['-g', 'batt']));
      const level = Number(read('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']).trim());
      pressure = [1, 2, 4].includes(level) ? { level, state: ({ 1: 'normal', 2: 'warning', 4: 'critical' })[level] } : null;
      peripheralAt = at;
    } else if (platform === 'linux' && (peripheralAt === null || at - peripheralAt >= peripheralIntervalMs || at < peripheralAt || force)) {
      power = linuxPower(); peripheralAt = at;
    } else if (platform === 'win32') power = windowsPower(windowsSnapshot);
    const counters = platform === 'darwin' ? parseNetworkSnapshot(read('netstat', ['-ibn']))
      : platform === 'linux' ? parseLinuxNetworkSnapshot(readText('/proc/net/dev')) : platform === 'win32' ? windowsNetwork(windowsSnapshot) : [];
    const routeMissing = routeInterface !== null && !counters.some(entry => entry.name === routeInterface);
    if (!interfaceName && (routeAt === null || at - routeAt >= routeIntervalMs || at < routeAt || routeMissing || force)) {
      routeInterface = platform === 'darwin' ? (read('route', ['-n', 'get', 'default']).match(/^\s*interface:\s*(\S+)/m) || [])[1] || null
        : platform === 'linux' ? parseLinuxDefaultInterface(readText('/proc/net/route'), readText('/proc/net/ipv6_route'))
          : platform === 'win32' ? windowsDefaultInterface(windowsSnapshot) : null;
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
    const devices = platform === 'darwin' ? parseDiskSnapshot(read('ioreg', ['-r', '-c', 'IOBlockStorageDriver', '-d', '1', '-k', 'Statistics']))
      : platform === 'linux' ? parseLinuxDiskSnapshot(readText('/proc/diskstats'), wholeDisk) : platform === 'win32' ? windowsDisks(windowsSnapshot) : [];
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
    Object.defineProperty(result, 'processSnapshot', { value: psText, enumerable: false });
    if (platform === 'win32') {
      Object.defineProperty(result, 'systemSnapshot', { value: windowsSnapshot, enumerable: false });
      windowsAt = at; windowsResult = result;
    }
    return result;
  } };
}

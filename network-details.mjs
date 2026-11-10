// Read-only network configuration. Configuration does not establish a request's actual path.
import os from 'node:os';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { open } from 'node:fs/promises';

const ENVIRONMENT_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];
const MAX_SOURCE_BYTES = 256 * 1024;
const safeInterface = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,64}$/.test(value) ? value : null;
const safeWindowsInterface = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 128
  && !/[\u0000-\u001f\u007f-\u009f]/u.test(value) ? value : null;
const safeAddress = value => {
  if (typeof value !== 'string') return null;
  const [address, zone, ...rest] = value.split('%');
  return net.isIP(address) && !rest.length && (zone === undefined || safeInterface(zone)) ? value : null;
};
const safeHost = value => {
  if (typeof value !== 'string') return null;
  const host = value.trim().replace(/^\[([^\]]+)\]$/, '$1');
  return safeAddress(host) || (/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9_.-]*[a-zA-Z0-9.])?$/.test(host) ? host.toLowerCase() : null);
};
const safePort = value => /^\d+$/.test(String(value ?? '')) && Number(value) > 0 && Number(value) <= 65535 ? Number(value) : null;
const endpointFor = (scheme, host, port) => host ? `${scheme}://${host.includes(':') ? `[${host}]` : host}${port ? `:${port}` : ''}` : null;

function defaultRun(file, args) {
  return new Promise((resolve, reject) => execFile(file, args, {
    encoding: 'utf8', timeout: file === 'powershell.exe' ? 6000 : 1500, maxBuffer: MAX_SOURCE_BYTES, windowsHide: true,
  }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}

async function defaultReadFile(file) {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(MAX_SOURCE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead <= MAX_SOURCE_BYTES ? buffer.toString('utf8', 0, bytesRead) : null;
  } finally { await handle.close(); }
}

/** Returns only scheme, host and port, even when the input contains credentials or a PAC path. */
export function redactNetworkEndpoint(value, defaultScheme = 'http') {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u0020\u007f-\u009f]/u.test(value.trim())) return null;
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `${defaultScheme}://${value}`);
    if (!/^(?:https?|socks(?:4a?|5h?)?)$/.test(url.protocol.slice(0, -1))) return null;
    const host = safeHost(url.hostname);
    return host ? endpointFor(url.protocol.slice(0, -1), host, safePort(url.port)) : null;
  } catch { return null; }
}

export function parseDefaultRoute(text) {
  if (typeof text !== 'string') return null;
  const interfaceName = safeInterface(text.match(/^\s*interface:\s*(\S+)\s*$/m)?.[1]);
  const gateway = safeAddress(text.match(/^\s*gateway:\s*(\S+)\s*$/m)?.[1]);
  return interfaceName ? { gateway, interfaceName } : null;
}

export function parseDnsConfiguration(text) {
  if (typeof text !== 'string' || !/^DNS configuration\b/m.test(text)) return null;
  const nameservers = [...new Set([...text.matchAll(/^\s*nameserver\[\d+\]\s*:\s*(\S+)\s*$/gm)]
    .map(match => safeAddress(match[1])).filter(Boolean))].slice(0, 16);
  return { nameservers };
}

function jsonValue(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_SOURCE_BYTES) return null;
  try { return JSON.parse(text.replace(/^\uFEFF/, '').trim()); } catch { return null; }
}

const metricValue = value => (typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value))
  && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const list = value => Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];
const routeResult = candidate => candidate ? { gateway: candidate.gateway, interfaceName: candidate.interfaceName } : null;
const chooseRoute = candidates => routeResult(candidates.sort((a, b) => a.metric - b.metric)[0]);

export function parseLinuxDefaultRoute(text, family = 4) {
  const entries = jsonValue(text);
  if (!Array.isArray(entries)) return null;
  return chooseRoute(entries.slice(0, 4096).flatMap(entry => {
    if (!entry || typeof entry !== 'object' || !['default', family === 4 ? '0.0.0.0/0' : '::/0'].includes(entry.dst)
      || (entry.type && entry.type !== 'unicast') || (entry.from && !['all', '0.0.0.0/0', '::/0'].includes(entry.from))
      || (entry.flags !== undefined && !Array.isArray(entry.flags)) || entry.flags?.includes('linkdown') || entry.flags?.includes('dead')) return [];
    const interfaceName = safeInterface(entry.dev), metric = entry.metric === undefined ? 0 : metricValue(entry.metric);
    const gateway = entry.gateway === undefined ? null : safeAddress(entry.gateway);
    if (!interfaceName || metric === null || (entry.gateway !== undefined && (!gateway || net.isIP(gateway.split('%')[0]) !== family))) return [];
    return [{ interfaceName, gateway, metric }];
  }));
}

export function parseLinuxProcRoute(text, family = 4, byteOrder = os.endianness()) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_SOURCE_BYTES) return null;
  return chooseRoute(text.split('\n').slice(0, 4096).flatMap(line => {
    const columns = line.trim().split(/\s+/);
    if (family === 4) {
      if (columns.length < 11 || columns[1] !== '00000000' || columns[7] !== '00000000'
        || !/^[a-f\d]{8}$/i.test(columns[2]) || !/^[a-f\d]+$/i.test(columns[3])) return [];
      const flags = Number.parseInt(columns[3], 16), metric = metricValue(columns[6]), interfaceName = safeInterface(columns[0]);
      if (!(flags & 1) || (flags & 0x200) || metric === null || !interfaceName) return [];
      const octets = columns[2].match(/../g);
      const gateway = columns[2] === '00000000' ? null : (byteOrder === 'LE' ? octets.reverse() : octets).map(value => Number.parseInt(value, 16)).join('.');
      return [{ interfaceName, gateway, metric }];
    }
    if (columns.length !== 10 || columns[0] !== '0'.repeat(32) || columns[1] !== '00' || columns[2] !== '0'.repeat(32) || columns[3] !== '00'
      || !/^[a-f\d]{32}$/i.test(columns[4]) || !/^[a-f\d]+$/i.test(columns[5]) || !/^[a-f\d]+$/i.test(columns[8])) return [];
    const flags = Number.parseInt(columns[8], 16), metric = Number.parseInt(columns[5], 16), interfaceName = safeInterface(columns[9]);
    if (!(flags & 1) || (flags & 0x200) || !interfaceName || !Number.isFinite(metric)) return [];
    const gateway = columns[4] === '0'.repeat(32) ? null : columns[4].match(/.{4}/g).join(':').toLowerCase();
    return [{ interfaceName, gateway, metric }];
  }));
}

export function parseResolvConf(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_SOURCE_BYTES) return null;
  const nameservers = [...new Set(text.split('\n').slice(0, 4096).flatMap(line => {
    const value = line.replace(/[;#].*$/, '').match(/^\s*nameserver\s+(\S+)\s*$/)?.[1];
    const address = safeAddress(value);
    return address ? [address] : [];
  }))].slice(0, 16);
  return { nameservers };
}

function safeBypass(values) {
  return [...new Set(values)].filter(value => typeof value === 'string' && value.length <= 253
    && /^(?:<local>|[a-zA-Z0-9.*_\[\]:%/-]+)$/.test(value)).slice(0, 64);
}

export function parseWindowsSystemProxy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const flag = value => value === 0 || value === false ? false : value === 1 || value === true ? true : null;
  const enabled = flag(value.ProxyEnable), server = typeof value.ProxyServer === 'string' ? value.ProxyServer.trim() : '';
  const mappings = new Map();
  let generic = null;
  for (const part of server.split(';').slice(0, 32)) {
    const entry = part.trim().match(/^(http|https|socks)\s*=\s*(.+)$/i);
    if (entry) mappings.set(entry[1].toLowerCase(), entry[2]);
    else if (part.trim() && !part.includes('=')) generic = part.trim();
  }
  const proxy = key => {
    const raw = mappings.get(key) || (key !== 'socks' ? generic : null);
    const endpoint = raw ? redactNetworkEndpoint(raw, key === 'socks' ? 'socks' : 'http') : null;
    let host = null, port = null;
    if (endpoint) {
      const url = new URL(endpoint);
      host = safeHost(url.hostname);
      port = safePort(url.port) || ({ 'http:': 80, 'https:': 443, 'socks:': 1080, 'socks4:': 1080, 'socks5:': 1080, 'socks5h:': 1080 })[url.protocol] || null;
    }
    const configured = enabled === false ? false : enabled === true ? raw ? true : server ? false : null : null;
    return { enabled: configured, host, port, endpoint, probe: null };
  };
  const pacConfigured = typeof value.AutoConfigURL === 'string' && value.AutoConfigURL.trim().length > 0;
  const bypass = safeBypass(typeof value.ProxyOverride === 'string' ? value.ProxyOverride.split(';').map(item => item.trim()) : []);
  return { http: proxy('http'), https: proxy('https'), socks: proxy('socks'),
    pac: { enabled: pacConfigured, url: pacConfigured ? redactNetworkEndpoint(value.AutoConfigURL) : null },
    autoDiscovery: flag(value.AutoDetect), bypass, excludeSimpleHostnames: bypass.includes('<local>'),
    source: value.Source === 'machine' ? 'windows-machine-internet-settings' : 'windows-user-internet-settings' };
}

export function parseWindowsNetworkConfiguration(text, selectedInterface = null) {
  const snapshot = jsonValue(text);
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const route = family => chooseRoute(list(snapshot.routes).slice(0, 4096).flatMap(entry => {
    if (entry?.DestinationPrefix !== (family === 4 ? '0.0.0.0/0' : '::/0')
      || (entry.State !== undefined && typeof entry.State !== 'string') || /^(?:dead|invalid)$/i.test(entry.State || '')) return [];
    const interfaceName = safeWindowsInterface(entry.InterfaceAlias), routeMetric = metricValue(entry.RouteMetric), interfaceMetric = metricValue(entry.InterfaceMetric);
    const gateway = entry.NextHop === '0.0.0.0' || entry.NextHop === '::' ? null : safeAddress(entry.NextHop);
    if (!interfaceName || routeMetric === null || interfaceMetric === null || (entry.NextHop && !gateway && !['0.0.0.0', '::'].includes(entry.NextHop))) return [];
    if (gateway && net.isIP(gateway.split('%')[0]) !== family) return [];
    return [{ interfaceName, gateway, metric: routeMetric + interfaceMetric }];
  }));
  const routes = { ipv4: route(4), ipv6: route(6) };
  const interfaceName = safeWindowsInterface(selectedInterface) || routes.ipv4?.interfaceName || routes.ipv6?.interfaceName || null;
  const dns = snapshot.dns === null || snapshot.dns === undefined || !interfaceName ? null : { nameservers: [...new Set(list(snapshot.dns)
    .filter(entry => typeof entry?.InterfaceAlias === 'string' && entry.InterfaceAlias.toLowerCase() === interfaceName.toLowerCase()).flatMap(entry => (Array.isArray(entry.ServerAddresses)
      ? entry.ServerAddresses : [entry.ServerAddresses]).map(safeAddress).filter(Boolean)))].slice(0, 16) };
  return { routes, interfaceName, dns, systemProxy: parseWindowsSystemProxy(snapshot.proxy) };
}

const WINDOWS_NETWORK_SCRIPT = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$WarningPreference='SilentlyContinue';[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);
$routes=$null;$dns=$null;$proxy=$null;
try{$metrics=@{};foreach($i in @(Get-NetIPInterface -PolicyStore ActiveStore -ErrorAction Stop)){$metrics[([string]$i.InterfaceIndex+'|'+[string]$i.AddressFamily)]=$i.InterfaceMetric};$routes=@(Get-NetRoute -PolicyStore ActiveStore -ErrorAction Stop|Where-Object{$_.DestinationPrefix -eq '0.0.0.0/0' -or $_.DestinationPrefix -eq '::/0'}|ForEach-Object{[pscustomobject]@{InterfaceAlias=$_.InterfaceAlias;InterfaceIndex=$_.InterfaceIndex;DestinationPrefix=$_.DestinationPrefix;NextHop=$_.NextHop;RouteMetric=$_.RouteMetric;InterfaceMetric=$metrics[([string]$_.InterfaceIndex+'|'+[string]$_.AddressFamily)];State=[string]$_.State}})}catch{}
try{$dns=@(Get-DnsClientServerAddress -ErrorAction Stop|Select-Object InterfaceAlias,InterfaceIndex,ServerAddresses)}catch{}
try{$scope='user';$settingsPath='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';$policy=Get-ItemProperty -LiteralPath 'HKLM:\\Software\\Policies\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -Name ProxySettingsPerUser -ErrorAction SilentlyContinue;if($null -ne $policy -and $policy.ProxySettingsPerUser -eq 0){$scope='machine';$settingsPath='HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'};$settings=Get-ItemProperty -LiteralPath $settingsPath -ErrorAction Stop;$proxy=[pscustomobject]@{ProxyEnable=$settings.ProxyEnable;ProxyServer=$settings.ProxyServer;ProxyOverride=$settings.ProxyOverride;AutoConfigURL=$settings.AutoConfigURL;AutoDetect=$settings.AutoDetect;Source=$scope}}catch{}
[pscustomobject]@{routes=$routes;dns=$dns;proxy=$proxy}|ConvertTo-Json -Depth 6 -Compress`;

function proxyDictionary(text) {
  if (typeof text !== 'string') return null;
  const dictionary = new Map();
  let depth = 0, rootStarted = false, rootClosed = false, exceptionsDepth = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    if (!rootStarted) {
      if (!/^\s*<dictionary>\s*\{\s*$/.test(line)) return null;
      rootStarted = true; depth = 1;
      continue;
    }
    if (rootClosed) return null;
    if (/^\s*}\s*$/.test(line)) {
      depth--;
      if (exceptionsDepth !== null && depth < exceptionsDepth) exceptionsDepth = null;
      if (depth === 0) rootClosed = true;
      continue;
    }
    const entry = line.match(/^\s*([^\s:]+)\s*:\s*(.*?)\s*$/);
    if (!entry) continue;
    if (/^<(?:dictionary|array)>\s*\{$/.test(entry[2])) {
      // __SCOPED__/__SUPPLEMENTAL__ can contain other interfaces' configurations.
      // Only the global root dictionary and its own ExceptionsList belong here.
      if (depth === 1 && entry[1] === 'ExceptionsList' && /^<array>/.test(entry[2])) {
        dictionary.set('ExceptionsList', []); exceptionsDepth = 2;
      }
      depth++;
    } else if (depth === 1 && /^[a-zA-Z][a-zA-Z0-9]*$/.test(entry[1]) && entry[1] !== 'ExceptionsList') {
      dictionary.set(entry[1], entry[2]);
    } else if (depth === exceptionsDepth && /^\d+$/.test(entry[1])) {
      dictionary.get('ExceptionsList').push(entry[2]);
    }
  }
  return rootStarted && rootClosed ? dictionary : null;
}

export function parseSystemProxy(text) {
  const dictionary = proxyDictionary(text);
  if (!dictionary) return null;
  const enabled = key => dictionary.has(key) ? ({ 0: false, 1: true })[dictionary.get(key)] ?? null : false;
  const proxy = (prefix, scheme) => {
    const host = safeHost(dictionary.get(`${prefix}Proxy`));
    const port = safePort(dictionary.get(`${prefix}Port`));
    return { enabled: enabled(`${prefix}Enable`), host, port, endpoint: host && port ? endpointFor(scheme, host, port) : null, probe: null };
  };
  // A bypass rule is a domain/IP pattern, never a URL, credential or arbitrary command text.
  const bypass = (dictionary.get('ExceptionsList') || []).filter(value =>
    value.length <= 253 && /^(?:<local>|[a-zA-Z0-9.*_\[\]:%/-]+)$/.test(value));
  return { http: proxy('HTTP', 'http'), https: proxy('HTTPS', 'http'), socks: proxy('SOCKS', 'socks'),
    pac: { enabled: enabled('ProxyAutoConfigEnable'), url: redactNetworkEndpoint(dictionary.get('ProxyAutoConfigURLString')) },
    autoDiscovery: enabled('ProxyAutoDiscoveryEnable'), bypass, excludeSimpleHostnames: enabled('ExcludeSimpleHostnames') };
}

export function environmentProxyState(environment) {
  return ENVIRONMENT_KEYS.map(name => {
    const value = typeof environment?.[name] === 'string' ? environment[name] : '';
    const present = value.trim().length > 0;
    if (name.toUpperCase() === 'NO_PROXY') return { name, present, endpoint: null, valid: null,
      entryCount: present ? value.split(',').filter(item => item.trim()).length : 0 };
    const endpoint = present ? redactNetworkEndpoint(value) : null;
    return { name, present, endpoint, valid: present ? endpoint !== null : null };
  });
}

function loopbackAddress(host) {
  if (host === 'localhost' || host === 'localhost.') return '127.0.0.1';
  if (net.isIP(host) === 4 && host.startsWith('127.')) return host;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return '::1';
  return null;
}

/** TCP handshake only. This function is called only with an already validated loopback IP. */
function defaultProbe({ host, port, timeoutMs }) {
  return new Promise(resolve => {
    let socket, timer, finished = false;
    const finish = status => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve(status);
    };
    try {
      socket = net.createConnection({ host, port });
      socket.once('connect', () => finish('open'));
      socket.once('error', () => finish('closed'));
      timer = setTimeout(() => finish('timeout'), timeoutMs);
    } catch { finish('closed'); }
  });
}

/**
 * sample({ interfaceName, force }) is async and caches configuration for 10 seconds.
 * run(file,args), readFile(path), networkInterfaces(), environment(), probe({host,port,timeoutMs}) and now()
 * are injectable. No command output, environment value, credentials or PAC paths are returned.
 * Missing/failed sources remain null. Port probes establish listener presence, not proxy health.
 */
export function createNetworkDetailsSampler({ now = Date.now, run = defaultRun, platform = process.platform,
  networkInterfaces = os.networkInterfaces, environment = () => process.env, probe = defaultProbe,
  readFile = defaultReadFile, ttlMs = 10_000, probeTimeoutMs = 250 } = {}) {
  const cache = new Map(), pending = new Map();
  const timeoutMs = Math.min(300, Math.max(1, Number(probeTimeoutMs) || 250));
  const read = async (file, args) => {
    try { const value = await run(file, args); return typeof value === 'string' && Buffer.byteLength(value) <= MAX_SOURCE_BYTES ? value : null; } catch { return null; }
  };
  const readSystemFile = async file => {
    try { const value = await readFile(file); return typeof value === 'string' && Buffer.byteLength(value) <= MAX_SOURCE_BYTES ? value : null; } catch { return null; }
  };
  const collect = async (interfaceName, at) => {
    let routes = { ipv4: null, ipv6: null }, dns = null, systemProxy = null;
    if (platform === 'darwin') {
      const [route4, route6, dnsText, proxyText] = await Promise.all([
        read('/sbin/route', ['-n', 'get', 'default']), read('/sbin/route', ['-n', 'get', '-inet6', 'default']),
        read('/usr/sbin/scutil', ['--dns']), read('/usr/sbin/scutil', ['--proxy'])]);
      routes = { ipv4: parseDefaultRoute(route4), ipv6: parseDefaultRoute(route6) };
      dns = parseDnsConfiguration(dnsText);
      systemProxy = parseSystemProxy(proxyText);
    } else if (platform === 'linux') {
      const [route4, route6, proc4, proc6, resolv] = await Promise.all([
        read('ip', ['-j', '-4', 'route', 'show', 'default']), read('ip', ['-j', '-6', 'route', 'show', 'default']),
        readSystemFile('/proc/net/route'), readSystemFile('/proc/net/ipv6_route'), readSystemFile('/etc/resolv.conf')]);
      routes = { ipv4: Array.isArray(jsonValue(route4)) ? parseLinuxDefaultRoute(route4, 4) : parseLinuxProcRoute(proc4, 4),
        ipv6: Array.isArray(jsonValue(route6)) ? parseLinuxDefaultRoute(route6, 6) : parseLinuxProcRoute(proc6, 6) };
      dns = parseResolvConf(resolv);
    } else if (platform === 'win32') {
      const snapshot = parseWindowsNetworkConfiguration(await read('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_NETWORK_SCRIPT]), interfaceName);
      if (snapshot) { routes = snapshot.routes; dns = snapshot.dns; systemProxy = snapshot.systemProxy; }
    }
    let selectedInterface = interfaceName || routes.ipv4?.interfaceName || routes.ipv6?.interfaceName || null;
    let interfaces = null;
    try { interfaces = networkInterfaces(); } catch {}
    if (platform === 'win32' && selectedInterface) selectedInterface = Object.keys(interfaces || {})
      .find(name => name.toLowerCase() === selectedInterface.toLowerCase()) || selectedInterface;
    let addresses = null;
    try {
      const entries = interfaces?.[selectedInterface];
      if (Array.isArray(entries)) addresses = {
        ipv4: [...new Set(entries.filter(entry => (entry.family === 'IPv4' || entry.family === 4) && safeAddress(entry.address)).map(entry => entry.address))].slice(0, 16),
        ipv6: [...new Set(entries.filter(entry => (entry.family === 'IPv6' || entry.family === 6) && safeAddress(entry.address)).map(entry => entry.address))].slice(0, 16),
      };
    } catch {}
    if (systemProxy) {
      const probes = new Map();
      await Promise.all(['http', 'https', 'socks'].map(async key => {
        const entry = systemProxy[key];
        if (entry.enabled !== true || !entry.host || !entry.port) return;
        const host = loopbackAddress(entry.host);
        if (!host) { entry.probe = { status: 'unprobed', sampledAt: at }; return; }
        const probeKey = `${host}:${entry.port}`;
        if (!probes.has(probeKey)) probes.set(probeKey, Promise.resolve().then(() => probe({ host, port: entry.port, timeoutMs })).catch(() => null));
        const status = await probes.get(probeKey);
        entry.probe = { status: ['open', 'closed', 'timeout'].includes(status) ? status : null, sampledAt: at };
      }));
    }
    let environmentProxy = null, tunnelInterfaces = null;
    try { environmentProxy = environmentProxyState(environment()); } catch {}
    if (interfaces) tunnelInterfaces = Object.entries(interfaces).filter(([name, entries]) =>
      (/^(?:utun|tun|tap|wg|ppp|tailscale)\d+$/.test(name) || platform === 'win32' && /(?:tunnel|wireguard|tailscale|vpn)/i.test(name))
      && (platform === 'win32' ? safeWindowsInterface(name) : safeInterface(name))
      && Array.isArray(entries) && entries.some(entry => entry.internal === false && safeAddress(entry.address)))
      .map(([name]) => name).slice(0, 16);
    return { sampledAt: at, interfaceName: selectedInterface, addresses, routes, dns,
      systemProxy, environmentProxy, tunnelInterfaces, configurationOnly: true };
  };
  return { async sample({ interfaceName, force = false } = {}) {
    const selected = platform === 'win32' ? safeWindowsInterface(interfaceName) : safeInterface(interfaceName), key = selected || '', at = now();
    const cached = cache.get(key);
    if (!force && cached && at >= cached.sampledAt && at - cached.sampledAt < ttlMs) return cached;
    if (pending.has(key)) return pending.get(key);
    const task = collect(selected, at).then(result => { cache.set(key, result); return result; }).finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  } };
}

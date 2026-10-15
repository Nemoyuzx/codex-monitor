// Read-only network configuration. Configuration does not establish a request's actual path.
import os from 'node:os';
import net from 'node:net';
import { execFile } from 'node:child_process';

const ENVIRONMENT_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];
const safeInterface = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,64}$/.test(value) ? value : null;
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
    encoding: 'utf8', timeout: 1500, maxBuffer: 256 * 1024, windowsHide: true,
  }, (error, stdout) => error ? reject(error) : resolve(stdout)));
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
 * run(file,args), networkInterfaces(), environment(), probe({host,port,timeoutMs}) and now()
 * are injectable. No command output, environment value, credentials or PAC paths are returned.
 * Missing/failed sources remain null. Port probes establish listener presence, not proxy health.
 */
export function createNetworkDetailsSampler({ now = Date.now, run = defaultRun, platform = process.platform,
  networkInterfaces = os.networkInterfaces, environment = () => process.env, probe = defaultProbe,
  ttlMs = 10_000, probeTimeoutMs = 250 } = {}) {
  const cache = new Map(), pending = new Map();
  const timeoutMs = Math.min(300, Math.max(1, Number(probeTimeoutMs) || 250));
  const read = async (file, args) => {
    try { const value = await run(file, args); return typeof value === 'string' ? value : null; } catch { return null; }
  };
  const collect = async (interfaceName, at) => {
    const [route4, route6, dnsText, proxyText] = platform === 'darwin'
      ? await Promise.all([read('/sbin/route', ['-n', 'get', 'default']), read('/sbin/route', ['-n', 'get', '-inet6', 'default']),
        read('/usr/sbin/scutil', ['--dns']), read('/usr/sbin/scutil', ['--proxy'])]) : [null, null, null, null];
    const routes = { ipv4: parseDefaultRoute(route4), ipv6: parseDefaultRoute(route6) };
    const selectedInterface = interfaceName || routes.ipv4?.interfaceName || routes.ipv6?.interfaceName || null;
    let addresses = null;
    try {
      const entries = networkInterfaces()?.[selectedInterface];
      if (Array.isArray(entries)) addresses = {
        ipv4: [...new Set(entries.filter(entry => (entry.family === 'IPv4' || entry.family === 4) && safeAddress(entry.address)).map(entry => entry.address))].slice(0, 16),
        ipv6: [...new Set(entries.filter(entry => (entry.family === 'IPv6' || entry.family === 6) && safeAddress(entry.address)).map(entry => entry.address))].slice(0, 16),
      };
    } catch {}
    const systemProxy = parseSystemProxy(proxyText);
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
    try { tunnelInterfaces = Object.entries(networkInterfaces() || {}).filter(([name, entries]) =>
      /^(?:utun|tun|tap)\d+$/.test(name) && Array.isArray(entries) && entries.some(entry => entry.internal === false && safeAddress(entry.address)))
      .map(([name]) => name).slice(0, 16); } catch {}
    return { sampledAt: at, interfaceName: selectedInterface, addresses, routes, dns: parseDnsConfiguration(dnsText),
      systemProxy, environmentProxy, tunnelInterfaces, configurationOnly: true };
  };
  return { async sample({ interfaceName, force = false } = {}) {
    const selected = safeInterface(interfaceName), key = selected || '', at = now();
    const cached = cache.get(key);
    if (!force && cached && at >= cached.sampledAt && at - cached.sampledAt < ttlMs) return cached;
    if (pending.has(key)) return pending.get(key);
    const task = collect(selected, at).then(result => { cache.set(key, result); return result; }).finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  } };
}

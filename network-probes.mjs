// Read-only HTTPS probes. No application data, cookies or Codex files are sent.
import { execFile } from 'node:child_process';
import net from 'node:net';
import { redactNetworkEndpoint } from './network-details.mjs';

const DEFAULT_TARGETS = Object.freeze({ ip: 'https://api.ipify.org?format=json', connectivity: 'https://www.gstatic.com/generate_204' });
const ENV_PROXY_KEYS = ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy'];
const BODY_LIMIT = 8192;
const MARKER = '\n__CODEX_NETWORK_PROBE_METRICS__';
const WRITE_OUT = MARKER + JSON.stringify({ httpStatus: '%{http_code}', proxyHttpStatus: '%{http_connect}',
  proxyUsed: '%{proxy_used}', dns: '%{time_namelookup}', connect: '%{time_connect}', tls: '%{time_appconnect}',
  ttfb: '%{time_starttransfer}', total: '%{time_total}' });

function defaultRun(file, args, { input, env, timeoutMs, maxBuffer, signal }) {
  return new Promise(resolve => {
    if (signal.aborted) { resolve({ exitCode: null, aborted: true }); return; }
    const child = execFile(file, args, { env, encoding: 'utf8', timeout: timeoutMs, maxBuffer,
      signal, windowsHide: true, killSignal: 'SIGKILL' }, (error, stdout) => resolve({ stdout,
      exitCode: error ? (Number.isInteger(error.code) ? error.code : null) : 0,
      unavailable: error?.code === 'ENOENT', aborted: signal.aborted,
      timedOut: !!error?.killed && !signal.aborted, overflow: error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }));
    // stdin is the only place proxy credentials are passed; never put them in argv.
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}

function parseProxy(value) {
  const redacted = redactNetworkEndpoint(value);
  if (!redacted) return null;
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `http://${value}`);
    let protocol = url.protocol.slice(0, -1);
    if (['socks', 'socks5', 'socks5h'].includes(protocol)) protocol = 'socks5h';
    if (protocol === 'socks4') protocol = 'socks4a';
    if (!['http', 'https', 'socks4a', 'socks5h'].includes(protocol)) return null;
    const port = url.port || ({ http: 80, https: 443, socks4a: 1080, socks5h: 1080 })[protocol];
    const endpoint = `${protocol}://${url.hostname}:${port}`;
    const username = decodeURIComponent(url.username), password = decodeURIComponent(url.password);
    if (/[\u0000-\u001f\u007f-\u009f]/u.test(username + password) || username.length + password.length > 2048) return null;
    return { endpoint, credentials: username || password ? `${username}:${password}` : null };
  } catch { return null; }
}

function selectProxies(networkDetails, environment) {
  const candidates = [];
  for (const [key, label] of [['http', '系统 HTTP'], ['https', '系统 HTTPS'], ['socks', '系统 SOCKS']]) {
    const value = networkDetails?.systemProxy?.[key];
    if (value?.enabled !== true) continue;
    const parsed = parseProxy(value.endpoint);
    if (parsed) candidates.push({ ...parsed, source: `system.${key}`, label });
  }
  for (const key of ENV_PROXY_KEYS) {
    const value = environment?.[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    const parsed = parseProxy(value.trim());
    if (parsed) candidates.push({ ...parsed, source: `environment.${key}`, label: key });
  }
  const routes = new Map();
  for (const candidate of candidates) {
    // Different authentication identities are distinct routes, even on the same port.
    const key = `${candidate.endpoint}\0${candidate.credentials || ''}`;
    let route = routes.get(key);
    if (!route) {
      if (routes.size === 4) continue;
      route = { endpoint: candidate.endpoint, credentials: candidate.credentials, sources: [], labels: [] };
      routes.set(key, route);
    }
    route.sources.push(candidate.source); route.labels.push(candidate.label);
  }
  return [...routes.values()].map(route => ({ ...route, kind: 'proxy', label: route.labels.join(' / ') }));
}

// Do not label a private, loopback, documentation or multicast API response as a public exit.
function publicAddress(value) {
  if (typeof value !== 'string' || !net.isIP(value)) return null;
  if (net.isIP(value) === 4) {
    const [a, b, c] = value.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113)) return null;
  } else {
    const normalized = value.toLowerCase();
    if (!/^[23][0-9a-f]{3}:/i.test(normalized) || /^2001:0?db8:/i.test(normalized)) return null;
  }
  return value;
}

function parseOutput(result, { target, type, proxy, sampledAt }) {
  const output = typeof result?.stdout === 'string' ? result.stdout : '';
  const marker = output.lastIndexOf(MARKER);
  let metrics = null;
  try { if (marker >= 0) metrics = JSON.parse(output.slice(marker + MARKER.length)); } catch {}
  const body = marker >= 0 ? output.slice(0, marker) : '';
  const code = Number.isInteger(result?.exitCode) ? result.exitCode : null;
  const httpStatus = /^\d{3}$/.test(metrics?.httpStatus) && Number(metrics.httpStatus) > 0 ? Number(metrics.httpStatus) : null;
  const proxyHttpStatus = /^\d{3}$/.test(metrics?.proxyHttpStatus) && Number(metrics.proxyHttpStatus) > 0 ? Number(metrics.proxyHttpStatus) : null;
  const proxyUsed = metrics?.proxyUsed === '1' ? true : metrics?.proxyUsed === '0' ? false : null;
  const time = (key, completed = false) => {
    const value = metrics?.[key];
    if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) return null;
    const ms = Number(value) * 1000;
    return Number.isFinite(ms) && (ms > 0 || completed) ? Math.round(ms * 10) / 10 : null;
  };
  const timing = { dnsMs: time('dns', code === 0), connectMs: time('connect', code === 0),
    tlsMs: time('tls', code === 0), ttfbMs: time('ttfb', code === 0), totalMs: time('total', code === 0) };
  let status = 'unavailable', publicIp = null;
  if (result?.aborted) status = 'cancelled';
  else if (result?.timedOut || code === 28) status = 'timeout';
  else if (proxyHttpStatus === 407 || httpStatus === 407) status = 'proxy-auth';
  else if (proxyHttpStatus !== null && proxyHttpStatus !== 200) status = 'proxy';
  else if (code === 5 || code === 6) status = 'dns';
  else if (code === 7) status = 'tcp';
  else if ([35, 51, 58, 59, 60, 64, 66, 77, 80, 82, 83, 90, 91].includes(code)) status = 'tls';
  else if (code === 97 || (proxy && [52, 55, 56].includes(code) && !proxyHttpStatus)) status = 'proxy';
  else if (result?.overflow || code === 63 || Buffer.byteLength(body) > BODY_LIMIT) status = 'invalid-response';
  else if (code !== 0 || !metrics) status = 'unavailable';
  else if (proxy && proxyUsed !== true && proxyHttpStatus !== 200) status = 'proxy-unverified';
  else if (httpStatus !== (type === 'ip' ? 200 : 204)) status = 'http';
  else if (type === 'ip') {
    try {
      const data = JSON.parse(body);
      publicIp = data && !Array.isArray(data) && publicAddress(data.ip);
    } catch {}
    status = publicIp ? 'ok' : 'invalid-response';
  } else status = body.length === 0 ? 'ok' : 'invalid-response';
  return { status, publicIp: status === 'ok' ? publicIp : null, target: new URL(target).hostname,
    sampledAt, httpStatus, proxyHttpStatus, proxyUsed, timing };
}

const quoteConfig = value => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
function cleanEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment || {}).filter(([key, value]) => typeof value === 'string'
    && !/proxy$/i.test(key) && !/^(?:CURL_HOME|CURL_CA_BUNDLE|SSLKEYLOGFILE)$/i.test(key)));
}

/**
 * Each route makes two fixed, anonymous HTTPS GETs; at most four explicit proxies.
 * Timing fields are cumulative milliseconds since request start, including origin,
 * proxy and TLS work. They are not a ping, pure node RTT or direct physical route.
 * Test-only targets/caFile let fixtures exercise TLS verification without --insecure.
 */
export function createNetworkProbeSampler({ now = Date.now, run = defaultRun, env = () => process.env,
  ttlMs = 60_000, timeoutMs = 5000, concurrency = 2, targets = DEFAULT_TARGETS, caFile = null, curlPath = 'curl' } = {}) {
  const requestTimeout = Math.min(10_000, Math.max(100, Number(timeoutMs) || 5000));
  const maxConcurrent = Math.min(4, Math.max(1, Math.trunc(Number(concurrency) || 2)));
  for (const key of ['ip', 'connectivity']) {
    const target = new URL(targets[key]);
    if (target.protocol !== 'https:' || target.username || target.password) throw new TypeError('Network probe targets require HTTPS without credentials');
  }
  let cached = null, cachedKey = null, pending = null, controller = null, closed = false;
  const disabledResult = () => ({ sampledAt: now(), disabled: true, direct: null, proxies: [], pac: null,
    provenance: { measurement: 'anonymous HTTPS GET; cumulative request timings, not ping RTT' } });
  const collect = async (networkDetails, environment, selected, signal) => {
    const started = now();
    const requestEnvironment = cleanEnvironment(environment);
    const pacFlag = networkDetails?.systemProxy?.pac?.enabled;
    const pacEnabled = typeof pacFlag === 'boolean' ? pacFlag : null;
    const routes = [{ kind: 'direct', label: '直连（系统路由）', endpoint: null, sources: ['direct'] }, ...selected];
    const requests = routes.flatMap(route => ['ip', 'connectivity'].map(type => ({ route, type })));
    const responses = new Map(routes.map(route => [route, {}]));
    let index = 0;
    const worker = async () => {
      while (index < requests.length && !signal.aborted) {
        const { route, type } = requests[index++];
        const args = ['-q', '--silent', '--globoff', '--proto', '=https', '--proto-redir', '=https',
          '--connect-timeout', String(Math.min(3000, requestTimeout) / 1000), '--max-time', String(requestTimeout / 1000),
          '--retry', '0', '--max-filesize', String(BODY_LIMIT), '--max-redirs', '0', '--request', 'GET',
          '--proxy', route.endpoint || '', '--noproxy', route.endpoint ? '' : '*', '--config', '-',
          '--output', '-', '--write-out', WRITE_OUT];
        if (caFile) args.push('--cacert', caFile, '--proxy-cacert', caFile);
        args.push('--url', targets[type]);
        let result;
        try {
          result = await run(curlPath, args, { input: route.credentials ? `proxy-user = ${quoteConfig(route.credentials)}\n` : '',
            env: requestEnvironment, timeoutMs: requestTimeout + 500, maxBuffer: BODY_LIMIT + 2048, signal });
        } catch { result = { exitCode: null, aborted: signal.aborted }; }
        responses.get(route)[type] = parseOutput(result, { target: targets[type], type, proxy: !!route.endpoint, sampledAt: now() });
      }
    };
    await Promise.all(Array.from({ length: Math.min(maxConcurrent, requests.length) }, worker));
    const summary = route => {
      const results = responses.get(route), successes = [results.ip, results.connectivity].filter(value => value?.status === 'ok').length;
      return { kind: route.kind, label: route.label, endpoint: route.endpoint, sources: route.sources,
        sampledAt: now(), status: successes === 2 ? 'ok' : successes === 1 ? 'partial' : 'failed',
        publicIp: results.ip?.publicIp || null, ipLookup: results.ip || null, connectivity: results.connectivity || null };
    };
    return { sampledAt: now(), startedAt: started, disabled: false, direct: summary(routes[0]), proxies: routes.slice(1).map(summary),
      pac: { enabled: pacEnabled, status: pacEnabled === true ? 'unresolved' : pacEnabled === false ? 'disabled' : 'unknown' },
      provenance: { measurement: 'anonymous HTTPS GET; cumulative request timings, not ping RTT', directUsesSystemRoute: true,
        tlsVerification: 'enabled', targets: [...new Set(Object.values(targets).map(target => new URL(target).hostname))], ttlMs, maxRequests: 10, concurrency: maxConcurrent,
        bypassRulesApplied: false, redirectsFollowed: false } };
  };
  return {
    async sample({ networkDetails, force = false, enabled = true } = {}) {
      if (!enabled || closed) { controller?.abort(); return disabledResult(); }
      let environment = {};
      try { environment = typeof env === 'function' ? env() : env || {}; } catch {}
      const selected = selectProxies(networkDetails, environment);
      const key = JSON.stringify([selected.map(route => [route.endpoint, route.sources, route.credentials]), networkDetails?.systemProxy?.pac?.enabled]);
      const at = now();
      if (!force && cached && key === cachedKey && at >= cached.sampledAt && at - cached.sampledAt < ttlMs) return cached;
      if (pending) return pending;
      controller = new AbortController();
      const signal = controller.signal;
      pending = collect(networkDetails, environment, selected, signal).then(result => {
        if (!signal.aborted) { cached = result; cachedKey = key; }
        return result;
      }).finally(() => { pending = null; controller = null; });
      return pending;
    },
    cancel() { controller?.abort(); },
    close() { closed = true; controller?.abort(); },
  };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createNetworkProbeSampler } from './network-probes.mjs';

const execute = promisify(execFile);
const MARKER = '\n__CODEX_NETWORK_PROBE_METRICS__';
const details = (...entries) => ({ systemProxy: Object.fromEntries(entries.map(([key, endpoint]) => [key, { enabled: true, endpoint }])) });
const metrics = (body = '', extra = {}) => ({ exitCode: 0, stdout: body + MARKER + JSON.stringify({ httpStatus: body ? '200' : '204',
  proxyHttpStatus: '000', proxyUsed: '0', dns: '0.001', connect: '0.005', tls: '0.02', ttfb: '0.03', total: '0.031', ...extra }) });
const successfulRun = async (_file, args) => metrics(args.at(-1).includes('ipify') ? '{"ip":"8.8.8.8"}' : '',
  { proxyUsed: args[args.indexOf('--proxy') + 1] ? '1' : '0' });

test('two independent validated HTTPS requests report public exit and cumulative timing', async () => {
  const sampler = createNetworkProbeSampler({ env: {}, now: () => 5000, run: successfulRun });
  const result = await sampler.sample();
  assert.equal(result.direct.status, 'ok');
  assert.equal(result.direct.publicIp, '8.8.8.8');
  assert.equal(result.direct.connectivity.httpStatus, 204);
  assert.deepEqual(result.direct.connectivity.timing, { dnsMs: 1, connectMs: 5, tlsMs: 20, ttfbMs: 30, totalMs: 31 });
  assert.equal(result.provenance.directUsesSystemRoute, true);
});

test('direct disables all implicit proxies, curlrc, redirects and credential output', async () => {
  const calls = [];
  const sampler = createNetworkProbeSampler({ env: { HTTPS_PROXY: 'http://alice:p%40ss@127.0.0.1:1234/private?q=secret',
    NO_PROXY: '*', no_proxy: '*', SSLKEYLOGFILE: '/tmp/leaked-keys', PATH: process.env.PATH }, run: async (...args) => {
    calls.push(args); return successfulRun(...args);
  } });
  const result = await sampler.sample();
  assert.equal(calls.length, 4);
  for (const [_file, args, options] of calls) {
    assert.equal(args[0], '-q');
    assert.equal(args.includes('--insecure'), false);
    assert.equal(args.includes('-k'), false);
    assert.equal(args.includes('--location'), false);
    assert.equal(options.env.HTTPS_PROXY, undefined);
    assert.equal(options.env.NO_PROXY, undefined);
    assert.equal(options.env.SSLKEYLOGFILE, undefined);
    assert.equal(args.some(arg => /alice|p%40ss|secret|private/.test(arg)), false);
    assert.equal(options.maxBuffer, 10240);
    const proxy = args[args.indexOf('--proxy') + 1];
    assert.equal(args[args.indexOf('--noproxy') + 1], proxy ? '' : '*');
    assert.equal(options.input, proxy ? 'proxy-user = "alice:p@ss"\n' : '');
  }
  assert.equal(result.proxies[0].endpoint, 'http://127.0.0.1:1234');
  assert.doesNotMatch(JSON.stringify(result), /alice|p%40ss|p@ss|secret|private/);
});

test('same HTTP proxy deduplicates system protocols and environment sources; SOCKS uses remote DNS', async () => {
  let calls = 0;
  const result = await createNetworkProbeSampler({ env: { HTTP_PROXY: 'http://localhost:7890', HTTPS_PROXY: 'http://localhost:7890',
    ALL_PROXY: 'socks5://localhost:7890' }, run: async (...args) => { calls++; return successfulRun(...args); } })
    .sample({ networkDetails: details(['http', 'http://localhost:7890'], ['https', 'http://localhost:7890'], ['socks', 'socks://localhost:7890']) });
  assert.equal(calls, 6);
  assert.equal(result.proxies.length, 2);
  assert.deepEqual(result.proxies[0].sources, ['system.http', 'system.https', 'environment.HTTPS_PROXY', 'environment.HTTP_PROXY']);
  assert.equal(result.proxies[1].endpoint, 'socks5h://localhost:7890');
});

test('four-proxy and request concurrency limits hold', async () => {
  let active = 0, peak = 0, calls = 0;
  const sampler = createNetworkProbeSampler({ env: { HTTPS_PROXY: 'http://localhost:1004', ALL_PROXY: 'http://localhost:1005', HTTP_PROXY: 'http://localhost:1006' },
    run: async (...args) => { calls++; active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 5));
      active--; return successfulRun(...args); } });
  const result = await sampler.sample({ networkDetails: details(['http', 'http://localhost:1001'], ['https', 'http://localhost:1002'], ['socks', 'socks://localhost:1003']) });
  assert.equal(result.proxies.length, 4);
  assert.equal(calls, 10);
  assert.equal(peak, 2);
});

test('cache, force, config changes, clock rollback and single-flight are bounded', async () => {
  let at = 1000, calls = 0;
  const sampler = createNetworkProbeSampler({ env: {}, now: () => at, run: async (...args) => { calls++; await Promise.resolve(); return successfulRun(...args); } });
  const [a, b] = await Promise.all([sampler.sample(), sampler.sample()]);
  assert.equal(a, b); assert.equal(calls, 2);
  at += 59000; assert.equal(await sampler.sample(), a); assert.equal(calls, 2);
  await sampler.sample({ force: true }); assert.equal(calls, 4);
  at += 60000; await sampler.sample(); assert.equal(calls, 6);
  at = 0; await sampler.sample(); assert.equal(calls, 8);
  await sampler.sample({ networkDetails: details(['http', 'http://localhost:1000']) }); assert.equal(calls, 12);
});

test('PAC remains unresolved and does not cause an invented proxy request', async () => {
  let calls = 0;
  const result = await createNetworkProbeSampler({ env: {}, run: async (...args) => { calls++; return successfulRun(...args); } })
    .sample({ networkDetails: { systemProxy: { pac: { enabled: true, url: 'https://private.test/private.pac' } } } });
  assert.equal(calls, 2); assert.deepEqual(result.pac, { enabled: true, status: 'unresolved' });
  assert.doesNotMatch(JSON.stringify(result), /private/);
});

test('unknown or malformed PAC configuration stays unknown instead of disabled', async () => {
  for (const systemProxy of [null, {}, { pac: {} }, { pac: { enabled: null } }, { pac: { enabled: '0' } }]) {
    const result = await createNetworkProbeSampler({ env: {}, run: successfulRun })
      .sample({ networkDetails: { systemProxy } });
    assert.deepEqual(result.pac, { enabled: null, status: 'unknown' });
    assert.equal(result.direct.status, 'ok');
  }
  const sampler = createNetworkProbeSampler({ env: {}, run: successfulRun });
  const disabled = await sampler.sample({ networkDetails: { systemProxy: { pac: { enabled: false } } } });
  assert.deepEqual(disabled.pac, { enabled: false, status: 'disabled' });
  const unknown = await sampler.sample({ networkDetails: { systemProxy: null } });
  assert.deepEqual(unknown.pac, { enabled: null, status: 'unknown' });
  assert.notEqual(unknown, disabled);
});

test('each collection shares one sanitized environment snapshot across its requests', async () => {
  const environments = [];
  const environment = { PATH: process.env.PATH, SAFE_VALUE: 'before', HTTPS_PROXY: 'http://localhost:7890', SSLKEYLOGFILE: '/private/keylog' };
  const sampler = createNetworkProbeSampler({ env: environment, run: async (...args) => {
    environments.push(args[2].env);
    environment.SAFE_VALUE = 'after';
    return successfulRun(...args);
  } });
  await sampler.sample();
  assert.equal(environments.length, 4);
  assert.ok(environments.every(value => value === environments[0]));
  assert.equal(environments[0].SAFE_VALUE, 'before');
  assert.equal(environments[0].HTTPS_PROXY, undefined);
  assert.equal(environments[0].SSLKEYLOGFILE, undefined);
});

test('HTTP refusals, redirects, HTML, invalid IP and private IP never validate an exit', async () => {
  for (const [body, httpStatus] of [['{"ip":"8.8.8.8"}', '403'], ['{"ip":"8.8.8.8"}', '302'], ['<html>OK</html>', '200'],
    ['{"error":"blocked"}', '200'], ['{"ip":"bad-ip"}', '200'], ['{"ip":"127.0.0.1"}', '200'],
    ['{"ip":"10.0.0.1"}', '200'], ['{"ip":"2001:db8::1"}', '200'], ['{"ip":"fc00::1"}', '200']]) {
    const result = await createNetworkProbeSampler({ env: {}, run: async () => metrics(body, { httpStatus }) }).sample();
    assert.equal(result.direct.publicIp, null, body);
    assert.notEqual(result.direct.ipLookup.status, 'ok', body);
  }
});

test('globally routed IPv6 exit is accepted', async () => {
  const result = await createNetworkProbeSampler({ env: {}, run: async (_file, args) =>
    args.at(-1).includes('ipify') ? metrics('{"ip":"2606:4700:4700::1111"}') : metrics() }).sample();
  assert.equal(result.direct.publicIp, '2606:4700:4700::1111');
});

test('204 must be exact and empty, proxy use requires evidence, and one successful target stays partial', async () => {
  const result = await createNetworkProbeSampler({ env: {}, run: async (_file, args) => {
    const proxy = !!args[args.indexOf('--proxy') + 1];
    return args.at(-1).includes('ipify') ? metrics('{"ip":"8.8.8.8"}', { proxyUsed: proxy ? '1' : '0' })
      : metrics('fake successful page', { httpStatus: '204', proxyUsed: proxy ? '1' : '0' });
  } }).sample({ networkDetails: details(['http', 'http://localhost:7890']) });
  assert.equal(result.proxies[0].status, 'partial');
  assert.equal(result.proxies[0].ipLookup.status, 'ok');
  assert.equal(result.proxies[0].connectivity.status, 'invalid-response');
  const unverified = await createNetworkProbeSampler({ env: {}, run: async () => metrics() })
    .sample({ networkDetails: details(['http', 'http://localhost:7890']) });
  assert.equal(unverified.proxies[0].connectivity.status, 'proxy-unverified');
});

test('failure categories omit raw error strings and absent measurements stay blank', async () => {
  for (const [failure, expected] of [[{ exitCode: 28 }, 'timeout'], [{ exitCode: 7 }, 'tcp'], [{ exitCode: 6 }, 'dns'],
    [{ exitCode: 60 }, 'tls'], [{ exitCode: 97 }, 'proxy'], [{ exitCode: 63 }, 'invalid-response'], [{ exitCode: null }, 'unavailable']]) {
    const result = await createNetworkProbeSampler({ env: {}, run: async () => ({ ...failure, stderr: 'secret user:pass' }) }).sample();
    assert.equal(result.direct.connectivity.status, expected);
    assert.equal(result.direct.connectivity.timing.totalMs, null);
    assert.doesNotMatch(JSON.stringify(result), /secret|user:pass/);
  }
  const auth = await createNetworkProbeSampler({ env: {}, run: async () => ({ ...metrics('', { proxyHttpStatus: '407', httpStatus: '000' }), exitCode: 56 }) }).sample();
  assert.equal(auth.direct.connectivity.status, 'proxy-auth');
});

test('body and output limits reject oversized success responses', async () => {
  for (const response of [metrics('x'.repeat(8193)), { exitCode: 0, overflow: true }]) {
    const result = await createNetworkProbeSampler({ env: {}, run: async () => response }).sample();
    assert.equal(result.direct.ipLookup.status, 'invalid-response');
  }
});

test('disabled and closed samplers never launch requests; cancellation aborts queued work', async () => {
  let calls = 0;
  const sampler = createNetworkProbeSampler({ env: {}, run: async (_file, _args, { signal }) => {
    calls++; await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); return { aborted: true };
  } });
  assert.equal((await sampler.sample({ enabled: false })).disabled, true); assert.equal(calls, 0);
  const pending = sampler.sample({ networkDetails: details(['http', 'http://localhost:7890']) });
  await Promise.resolve(); sampler.cancel();
  const result = await pending;
  assert.equal(calls, 2); assert.equal(result.direct.ipLookup.status, 'cancelled');
  sampler.close(); assert.equal((await sampler.sample()).disabled, true); assert.equal(calls, 2);
});

const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
function trackServer(t, server) {
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return server;
}

test('real curl uses verified local TLS, HTTP CONNECT and remote-DNS SOCKS5 with NO_PROXY=*', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-network-probes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keyPath = path.join(directory, 'key.pem'), certPath = path.join(directory, 'cert.pem'), configPath = path.join(directory, 'openssl.cnf');
  await writeFile(configPath, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n');
  await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-config', configPath]);
  const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
  let origins = 0, connectRequests = 0, socksRequests = 0;
  const origin = trackServer(t, https.createServer({ key, cert }, (request, response) => {
    origins++;
    if (request.url === '/ip') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"ip":"8.8.8.8"}'); }
    else { response.writeHead(204); response.end(); }
  }));
  const originPort = await listen(origin);
  const connectProxy = trackServer(t, http.createServer());
  const tunnelConnect = (request, client, head) => {
    connectRequests++; assert.equal(request.url, `localhost:${originPort}`);
    const upstream = net.connect(originPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head);
      upstream.pipe(client); client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy()); client.on('close', () => upstream.destroy());
  };
  connectProxy.on('connect', tunnelConnect);
  const connectPort = await listen(connectProxy);
  const tlsProxy = trackServer(t, https.createServer({ key, cert }));
  tlsProxy.on('connect', tunnelConnect);
  const tlsProxyPort = await listen(tlsProxy);
  const socksProxy = trackServer(t, net.createServer(client => {
    let phase = 0, buffer = Buffer.alloc(0);
    const consume = data => {
      buffer = Buffer.concat([buffer, data]);
      if (phase === 0) {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
        assert.equal(buffer[0], 5); buffer = buffer.subarray(2 + buffer[1]); phase = 1; client.write(Buffer.from([5, 0]));
      }
      if (phase === 1 && buffer.length >= 5) {
        assert.equal(buffer[0], 5); assert.equal(buffer[1], 1); assert.equal(buffer[3], 3);
        const needed = 7 + buffer[4]; if (buffer.length < needed) return;
        assert.equal(buffer.subarray(5, 5 + buffer[4]).toString(), 'localhost');
        assert.equal(buffer.readUInt16BE(5 + buffer[4]), originPort); socksRequests++; phase = 2;
        client.removeListener('data', consume);
        const remainder = buffer.subarray(needed);
        const upstream = net.connect(originPort, '127.0.0.1', () => {
          client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          if (remainder.length) upstream.write(remainder); upstream.pipe(client); client.pipe(upstream);
        });
        upstream.on('error', () => client.destroy()); client.on('close', () => upstream.destroy());
      }
    };
    client.on('data', consume);
  }));
  const socksPort = await listen(socksProxy);
  const sampler = createNetworkProbeSampler({ env: { PATH: process.env.PATH, NO_PROXY: '*', no_proxy: '*', HTTPS_PROXY: `http://127.0.0.1:${connectPort}` },
    caFile: certPath, targets: { ip: `https://localhost:${originPort}/ip`, connectivity: `https://localhost:${originPort}/204` } });
  t.after(() => sampler.close());
  const result = await sampler.sample({ networkDetails: details(['http', `http://127.0.0.1:${connectPort}`],
    ['https', `https://127.0.0.1:${tlsProxyPort}`], ['socks', `socks://127.0.0.1:${socksPort}`]) });
  assert.equal(result.direct.status, 'ok', JSON.stringify(result.direct));
  assert.equal(result.proxies.length, 3);
  for (const proxy of result.proxies) { assert.equal(proxy.status, 'ok', JSON.stringify(proxy)); assert.equal(proxy.publicIp, '8.8.8.8'); assert.equal(proxy.connectivity.proxyUsed, true); }
  assert.equal(connectRequests, 4); assert.equal(socksRequests, 2); assert.equal(origins, 8);
  // Basic proxy credentials must survive URL decoding and stdin config, never argv.
  let authorized = 0;
  const authenticated = trackServer(t, http.createServer());
  authenticated.on('connect', (request, client, head) => {
    assert.equal(request.headers['proxy-authorization'], `Basic ${Buffer.from('alice:p@ss').toString('base64')}`);
    authorized++; tunnelConnect(request, client, head);
  });
  const authenticatedPort = await listen(authenticated);
  const authSampler = createNetworkProbeSampler({ env: { PATH: process.env.PATH,
    HTTPS_PROXY: `http://alice:p%40ss@127.0.0.1:${authenticatedPort}/secret?q=private` }, caFile: certPath,
    targets: { ip: `https://localhost:${originPort}/ip`, connectivity: `https://localhost:${originPort}/204` } });
  t.after(() => authSampler.close());
  const authenticatedResult = await authSampler.sample();
  assert.equal(authenticatedResult.proxies[0].status, 'ok'); assert.equal(authorized, 2);
  assert.doesNotMatch(JSON.stringify(authenticatedResult), /alice|p@ss|secret|private/);
  // Removing the fixture CA must fail: validation was not silently disabled.
  const untrusted = createNetworkProbeSampler({ env: {}, targets: { ip: `https://127.0.0.1:${originPort}/ip`, connectivity: `https://127.0.0.1:${originPort}/204` } });
  t.after(() => untrusted.close());
  const denied = await untrusted.sample();
  assert.equal(denied.direct.connectivity.status, 'tls');
  assert.equal(denied.direct.publicIp, null);
});

test('real curl distinguishes closed port, fake listener, proxy auth and CONNECT refusal without fallback', async t => {
  const unused = trackServer(t, net.createServer());
  const unusedPort = await listen(unused); await new Promise(resolve => unused.close(resolve));
  const fake = trackServer(t, net.createServer());
  const fakePort = await listen(fake);
  const denied = trackServer(t, http.createServer());
  denied.on('connect', (_request, client) => client.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'));
  const deniedPort = await listen(denied);
  const refused = trackServer(t, http.createServer());
  refused.on('connect', (_request, client) => client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'));
  const refusedPort = await listen(refused);
  const sampler = createNetworkProbeSampler({ env: {}, timeoutMs: 200, targets: { ip: 'https://127.0.0.1:1/ip', connectivity: 'https://127.0.0.1:1/204' } });
  t.after(() => sampler.close());
  const result = await sampler.sample({ networkDetails: details(['http', `http://127.0.0.1:${unusedPort}`], ['https', `http://127.0.0.1:${fakePort}`],
    ['socks', `http://127.0.0.1:${deniedPort}`]) });
  assert.deepEqual(result.proxies.map(proxy => proxy.connectivity.status), ['tcp', 'timeout', 'proxy-auth']);
  const refusal = await sampler.sample({ force: true, networkDetails: details(['http', `http://127.0.0.1:${refusedPort}`]) });
  assert.equal(refusal.proxies[0].connectivity.status, 'proxy');
  assert.equal(refusal.proxies[0].connectivity.proxyHttpStatus, 403);
  assert.ok(result.proxies.every(proxy => proxy.status === 'failed' && proxy.publicIp === null));
});

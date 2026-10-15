import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { createNetworkDetailsSampler, environmentProxyState, parseDefaultRoute, parseDnsConfiguration,
  parseSystemProxy, redactNetworkEndpoint } from './network-details.mjs';

const proxyFixture = `<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : 192.168.0.0/16
    2 : *.local
    3 : <local>
    4 : http://user:password@private.example/path?key=secret
  }
  HTTPEnable : 1
  HTTPPort : 4958
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 4958
  HTTPSProxy : localhost
  SOCKSEnable : 1
  SOCKSPort : 1080
  SOCKSProxy : proxy.example
  ProxyAutoConfigEnable : 1
  ProxyAutoConfigURLString : https://user:password@pac.example/path/to/private.pac?key=secret#private
  ProxyAutoDiscoveryEnable : 1
}`;

const fixture = (options = {}) => {
  const state = { at: 0, calls: [], probes: [], fail: [], proxy: proxyFixture, ...options.state };
  const sampler = createNetworkDetailsSampler({ platform: 'darwin', now: () => state.at,
    networkInterfaces: () => ({ en0: [{ family: 'IPv4', address: '192.168.1.2', internal: false },
      { family: 'IPv6', address: 'fe80::1234', internal: false }, { family: 'IPv4', address: '192.168.1.2', internal: false }],
    en7: [{ family: 4, address: '10.0.0.2', internal: false }],
    utun3: [{ family: 'IPv6', address: 'fe80::2', internal: false }], lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }] }),
    environment: () => ({ HTTPS_PROXY: 'http://user:password@127.0.0.1:4958/private?key=secret', NO_PROXY: 'localhost,127.0.0.1' }),
    async run(file, args) {
      state.calls.push([file, args]);
      if (state.fail.includes(args.at(-1))) throw new Error('private command error');
      if (args.includes('--proxy')) return state.proxy;
      if (args.includes('--dns')) return 'DNS configuration\nresolver #1\n nameserver[0] : 114.114.114.114\n nameserver[1] : fe80::1%en0\n nameserver[2] : 114.114.114.114';
      return args.includes('-inet6') ? 'gateway: fe80::1%en0\n interface: en0\n' : 'gateway: 192.168.1.1\n interface: en0\n';
    },
    async probe(details) { state.probes.push(details); return 'open'; }, ...options.sampler });
  return { sampler, state };
};

test('default-route and DNS parsers retain valid IPv4, IPv6 zones, and source unavailability', () => {
  assert.deepEqual(parseDefaultRoute(' gateway: fe80::1%en0\n interface: en0\n'), { gateway: 'fe80::1%en0', interfaceName: 'en0' });
  assert.deepEqual(parseDefaultRoute('gateway: link#7\ninterface: utun2'), { gateway: null, interfaceName: 'utun2' });
  assert.equal(parseDefaultRoute('route: writing to routing socket: not in table'), null);
  assert.equal(parseDnsConfiguration(null), null);
  assert.equal(parseDnsConfiguration('failed'), null);
  assert.deepEqual(parseDnsConfiguration('DNS configuration\n nameserver[0] : 8.8.8.8\n nameserver[1] : 8.8.8.8\n nameserver[2] : ::1\n nameserver[3] : secret@host'), { nameservers: ['8.8.8.8', '::1'] });
});

test('system proxy parses HTTP, HTTPS, SOCKS, PAC, discovery and safe bypass patterns', () => {
  const sample = parseSystemProxy(proxyFixture);
  assert.deepEqual(sample.http, { enabled: true, host: '127.0.0.1', port: 4958, endpoint: 'http://127.0.0.1:4958', probe: null });
  assert.equal(sample.https.endpoint, 'http://localhost:4958');
  assert.equal(sample.socks.endpoint, 'socks://proxy.example:1080');
  assert.deepEqual(sample.pac, { enabled: true, url: 'https://pac.example' });
  assert.equal(sample.autoDiscovery, true);
  assert.deepEqual(sample.bypass, ['127.0.0.1', '192.168.0.0/16', '*.local', '<local>']);
  assert.equal(sample.excludeSimpleHostnames, false);
  assert.ok(!JSON.stringify(sample).match(/password|secret|private\.pac/));
});

test('successful empty system dictionary is disabled while failures and malformed flags remain unknown', () => {
  const disabled = parseSystemProxy('<dictionary> {\n}');
  assert.equal(disabled.http.enabled, false);
  assert.equal(disabled.pac.enabled, false);
  assert.equal(parseSystemProxy(''), null);
  assert.equal(parseSystemProxy('<dictionary> {\n HTTPEnable : 0'), null);
  const malformed = parseSystemProxy('<dictionary> {\n HTTPEnable : unknown\n HTTPPort : 999999\n HTTPProxy : user:password@host\n}');
  assert.equal(malformed.http.enabled, null);
  assert.equal(malformed.http.host, null);
  assert.equal(malformed.http.port, null);
});

test('scoped and supplemental proxy dictionaries never overwrite global settings or bypass rules', () => {
  const sample = parseSystemProxy(`<dictionary> {
  HTTPEnable : 0
  HTTPProxy : global.example
  HTTPPort : 8080
  ExceptionsList : <array> {
    0 : *.global.example
  }
  __SCOPED__ : <dictionary> {
    en0 : <dictionary> {
      HTTPEnable : 1
      HTTPProxy : 127.0.0.1
      HTTPPort : 9999
      HTTPSProxy : scoped.example
      ExceptionsList : <array> {
        0 : *.scoped.example
      }
    }
  }
  __SUPPLEMENTAL__ : <array> {
    0 : <dictionary> {
      HTTPEnable : 1
      HTTPProxy : supplemental.example
      HTTPPort : 3128
    }
  }
  SOCKSEnable : 1
  SOCKSProxy : global-socks.example
  SOCKSPort : 1080
}`);
  assert.equal(sample.http.enabled, false);
  assert.equal(sample.http.endpoint, 'http://global.example:8080');
  assert.equal(sample.https.host, null);
  assert.equal(sample.socks.endpoint, 'socks://global-socks.example:1080');
  assert.deepEqual(sample.bypass, ['*.global.example']);
  assert.ok(!JSON.stringify(sample).match(/scoped\.example|supplemental\.example|9999/));
  assert.equal(parseSystemProxy('<dictionary> {\n __SCOPED__ : <dictionary> {\n}'), null);
  assert.deepEqual(parseSystemProxy('<dictionary> {\n ExceptionsList : invalid\n}').bypass, []);
});

test('DNS and each address family are deduplicated and bounded to sixteen entries', async () => {
  const nameservers = Array.from({ length: 30 }, (_, i) => ` nameserver[${i}] : 10.0.0.${i + 1}`);
  assert.equal(parseDnsConfiguration(`DNS configuration\n${nameservers.join('\n')}`).nameservers.length, 16);
  const addresses = Array.from({ length: 30 }, (_, i) => [
    { family: 'IPv4', address: `10.0.0.${i + 1}`, internal: false },
    { family: 'IPv6', address: `2001:db8::${i + 1}`, internal: false },
  ]).flat();
  const { sampler } = fixture({ sampler: { networkInterfaces: () => ({ en0: addresses }) } });
  const sample = await sampler.sample();
  assert.equal(sample.addresses.ipv4.length, 16);
  assert.equal(sample.addresses.ipv6.length, 16);
});

test('proxy URL redaction never returns authentication, path, query, fragment or invalid URL text', () => {
  assert.equal(redactNetworkEndpoint('http://user:password@host.example:8080/path?secret=x#fragment'), 'http://host.example:8080');
  assert.equal(redactNetworkEndpoint('socks5h://user:password@[::1]:1080/path'), 'socks5h://[::1]:1080');
  assert.equal(redactNetworkEndpoint('127.0.0.1:8080'), 'http://127.0.0.1:8080');
  for (const value of ['invalid text', 'file:///private/file', 'http://', 'http://host:99999', '\u001b[31mhttp://secret']) assert.equal(redactNetworkEndpoint(value), null);
});

test('environment status handles case-sensitive variables and NO_PROXY without mislabeling it as a URL', () => {
  const result = environmentProxyState({ HTTP_PROXY: 'http://alice:password@proxy.example:3128/path?q=secret',
    http_proxy: 'socks5://127.0.0.1:1080', NO_PROXY: 'localhost, 127.0.0.1,,example.test', no_proxy: '', ALL_PROXY: 'invalid proxy' });
  assert.equal(result.find(entry => entry.name === 'HTTP_PROXY').endpoint, 'http://proxy.example:3128');
  assert.equal(result.find(entry => entry.name === 'http_proxy').endpoint, 'socks5://127.0.0.1:1080');
  assert.deepEqual(result.find(entry => entry.name === 'NO_PROXY'), { name: 'NO_PROXY', present: true, endpoint: null, valid: null, entryCount: 3 });
  assert.equal(result.find(entry => entry.name === 'ALL_PROXY').valid, false);
  assert.equal(result.find(entry => entry.name === 'HTTPS_PROXY').present, false);
  assert.ok(!JSON.stringify(result).match(/password|secret|alice|localhost/));
});

test('sampler selects current interface addresses and routes, with finite tunnel presence and no raw source text', async () => {
  const { sampler, state } = fixture();
  const sample = await sampler.sample();
  assert.equal(sample.interfaceName, 'en0');
  assert.deepEqual(sample.addresses, { ipv4: ['192.168.1.2'], ipv6: ['fe80::1234'] });
  assert.deepEqual(sample.routes.ipv4, { gateway: '192.168.1.1', interfaceName: 'en0' });
  assert.deepEqual(sample.dns.nameservers, ['114.114.114.114', 'fe80::1%en0']);
  assert.deepEqual(sample.tunnelInterfaces, ['utun3']);
  assert.equal(sample.configurationOnly, true);
  assert.ok(!JSON.stringify(sample).match(/password|secret|private command|wpad\.dat/));
  assert.equal(state.calls.length, 4);
  assert.deepEqual(state.probes, [{ host: '127.0.0.1', port: 4958, timeoutMs: 250 }]);
  assert.equal(sample.systemProxy.http.probe.status, 'open');
  assert.equal(sample.systemProxy.https.probe.status, 'open');
  assert.equal(sample.systemProxy.socks.probe.status, 'unprobed');
});

test('sampling TTL, forced refresh, interface changes and concurrent callers avoid redundant commands', async () => {
  const { sampler, state } = fixture();
  const [first, concurrent] = await Promise.all([sampler.sample(), sampler.sample()]);
  assert.equal(first, concurrent);
  state.at = 9999;
  assert.equal(await sampler.sample(), first);
  assert.equal(state.calls.length, 4);
  await sampler.sample({ force: true });
  assert.equal(state.calls.length, 8);
  const explicit = await sampler.sample({ interfaceName: 'en7' });
  assert.deepEqual(explicit.addresses.ipv4, ['10.0.0.2']);
  assert.equal(state.calls.length, 12);
  state.at = 20000;
  await sampler.sample();
  assert.equal(state.calls.length, 16);
  state.at = 100;
  await sampler.sample();
  assert.equal(state.calls.length, 20);
});

test('failure after a cached success returns unknown configuration instead of stale direct status', async () => {
  const { sampler, state } = fixture();
  await sampler.sample();
  state.at = 10000;
  state.fail = ['--proxy', '--dns', 'default'];
  const failed = await sampler.sample();
  assert.equal(failed.systemProxy, null);
  assert.equal(failed.dns, null);
  assert.deepEqual(failed.routes, { ipv4: null, ipv6: null });
  assert.equal(failed.addresses, null);
  assert.equal(failed.interfaceName, null);
});

test('port checks only target enabled valid loopback listeners and cap timeout at 300ms', async () => {
  const { sampler, state } = fixture({ sampler: { probeTimeoutMs: 1000 }, state: { proxy: `<dictionary> {
 HTTPEnable : 0
 HTTPProxy : 127.0.0.1
 HTTPPort : 1
 HTTPSEnable : 1
 HTTPSProxy : ::1
 HTTPSPort : 2
 SOCKSEnable : 1
 SOCKSProxy : 127.0.0.1.external.example
 SOCKSPort : 3
}` } });
  const sample = await sampler.sample();
  assert.deepEqual(state.probes, [{ host: '::1', port: 2, timeoutMs: 300 }]);
  assert.equal(sample.systemProxy.http.probe, null);
  assert.equal(sample.systemProxy.socks.probe.status, 'unprobed');
});

test('unsupported platforms leave system sources unknown while explicit interface and env remain available', async () => {
  const { sampler, state } = fixture({ sampler: { platform: 'linux' } });
  const result = await sampler.sample({ interfaceName: 'en7' });
  assert.deepEqual(result.addresses.ipv4, ['10.0.0.2']);
  assert.equal(result.systemProxy, null);
  assert.equal(result.dns, null);
  assert.equal(state.calls.length, 0);
  assert.equal(state.probes.length, 0);
});

test('real loopback listener check sends no payload and promptly closes the socket', async t => {
  const received = [], sockets = [];
  const server = net.createServer(socket => { sockets.push(socket); socket.on('data', data => received.push(data)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  const port = server.address().port;
  const { sampler } = fixture({ sampler: { probe: undefined }, state: { proxy: `<dictionary> {\n HTTPEnable : 1\n HTTPProxy : 127.0.0.1\n HTTPPort : ${port}\n}` } });
  const result = await sampler.sample();
  assert.equal(result.systemProxy.http.probe.status, 'open');
  assert.equal(received.length, 0);
});

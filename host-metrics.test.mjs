import assert from 'node:assert/strict';
import test from 'node:test';
import { createHostSampler, cpuUsageBetween, parseDiskSnapshot, parseNetworkSnapshot, parsePowerSnapshot } from './host-metrics.mjs';

const net = (name, incoming, outgoing, address = 'aa:bb:cc:dd:ee:ff') => `${name} 1500 <Link#7> ${address} 7 0 ${incoming} 9 0 ${outgoing} 0`;
const device = (id, read, write, readOps, writeOps) => `+-o IOBlockStorageDriver <class IOBlockStorageDriver, id ${id}, registered>\n "Statistics" = {"Bytes (Read)"=${read},"Operations (Write)"=${writeOps},"Bytes (Write)"=${write},"Operations (Read)"=${readOps}}`;
const proc = (pid, ppid, cpu, rss, command, elapsed = '01:30') => `${pid} ${ppid} ${cpu} ${rss} ${elapsed} ${command}`;
const fixture = (options = {}) => {
  const state = { at: 0, cpus: [{ times: { user: 10, nice: 0, sys: 10, idle: 80, irq: 0 } }],
    ps: proc(1, 0, 0, 10, '/sbin/launchd'), net: net('en7', 100, 200), disk: device('0x1', 100, 200, 10, 20),
    route: 'interface: en7', battery: "Now drawing from 'AC Power'\n100%; charged; 0:00 remaining", pressure: '1', calls: [], ...options };
  const sampler = createHostSampler({ platform: 'darwin', pid: 9999, now: () => state.at, cpus: () => state.cpus,
    run(file, args) {
      state.calls.push([file, args]);
      if (state.fail?.includes(file)) throw new Error('unavailable');
      return ({ ps: state.ps, netstat: state.net, ioreg: state.disk, route: state.route, pmset: state.battery, sysctl: state.pressure })[file] || '';
    }, ...options.sampler });
  return { state, sampler };
};

test('CPU reports interval busy time per core and weighted host usage, with unknown initial/reset/topology samples', () => {
  const before = [[10, 0, 10, 80, 0], [10, 0, 10, 80, 0]];
  assert.deepEqual(cpuUsageBetween(null, before), { usagePercent: null, perCore: [null, null], logicalCores: 2 });
  const next = [[30, 0, 40, 130, 0], [20, 0, 20, 100, 0]];
  const sample = cpuUsageBetween(before, next);
  assert.deepEqual(sample.perCore, [50, 50]);
  assert.equal(sample.usagePercent, 50);
  assert.equal(cpuUsageBetween(before, [[11, 0, 10, 79, 0], next[1]]).usagePercent, null);
  assert.deepEqual(cpuUsageBetween(before, next.slice(0, 1)).perCore, [null]);
  assert.equal(cpuUsageBetween(before, before).usagePercent, null);
});

test('CPU sampler uses os tick deltas instead of load averages or ps percentages', () => {
  const { sampler, state } = fixture();
  assert.equal(sampler.sample().cpu.usagePercent, null);
  state.at = 1000;
  state.cpus[0].times = { user: 20, nice: 0, sys: 20, idle: 160, irq: 0 };
  assert.equal(sampler.sample().cpu.usagePercent, 20);
});

test('process grouping follows real executable roots and descendants, excluding monitors, terminals and argument false positives', () => {
  const { sampler, state } = fixture({ ps: [
    proc(10, 1, 1, 1000, '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT', '2-03:04:05'),
    proc(11, 10, 2, 2000, '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex -c features.foo=true app-server'),
    proc(12, 10, 3, 3000, '/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer) --type=renderer'),
    proc(13, 11, 4, 4000, '/usr/local/bin/codex-code-mode-host'),
    proc(14, 11, 5, 5000, '/usr/bin/python3 /plugins/freecad_mcp_client.py --token=private-token'),
    proc(15, 14, 6, 6000, '/usr/bin/python3 /plugins/child.py'),
    proc(16, 11, 7, 7000, '/usr/bin/node /plugins/unidentified-server.js'),
    proc(20, 10, 10, 8000, '/bin/zsh -l'),
    proc(21, 20, 10, 8000, '/usr/bin/python3 /terminal/user_job.py'),
    proc(30, 11, 10, 8000, '/bin/zsh -lc something'),
    proc(31, 30, 8, 8000, '/usr/bin/python3 /tools/compile.py'),
    proc(40, 11, 50, 9000, '/usr/bin/node /repo/codex-status.mjs -w'),
    proc(41, 40, 50, 9000, '/usr/bin/python3 /monitor-helper.py'),
    proc(50, 1, 90, 10000, '/bin/zsh -c /Applications/ChatGPT.app/Contents/MacOS/ChatGPT'),
    proc(51, 1, 90, 10000, '/usr/bin/node /repo/codex-something.mjs app-server'),
    proc(52, 1, 90, 10000, '/usr/bin/python3 -c "print(\"codex app-server\")"'),
    proc(53, 1, 90, 10000, '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node /Applications/ChatGPT.app/Contents/MacOS/ChatGPT'),
    proc(9999, 11, 20, 2000, '/usr/bin/node /repo/custom-monitor.mjs'),
    proc(9998, 9999, 20, 2000, 'ps -axo pid=,ppid=,pcpu=,rss=,etime=,command='),
  ].join('\n') });
  const sample = sampler.sample(), p = sample.processes;
  assert.deepEqual(p.items.map(entry => entry.pid).toSorted((a, b) => a - b), [10, 11, 12, 13, 14, 15, 16, 31]);
  assert.equal(p.cpuPercent, 36);
  assert.equal(p.rssBytes, 36000 * 1024);
  assert.deepEqual(p.counts, { worker: 2, mcp: 2, 'code-mode': 1, renderer: 1, 'app-server': 1, desktop: 1 });
  assert.equal(p.items.find(entry => entry.pid === 10).elapsedSeconds, 2 * 86400 + 3 * 3600 + 4 * 60 + 5);
  assert.equal(state.calls.filter(([file]) => file === 'ps').length, 1);
  assert.ok(sample.processSnapshot.includes('private-token'));
  assert.ok(!JSON.stringify(sample).includes('private-token'));
  assert.ok(!JSON.stringify(sample).includes('command'));
  assert.equal(p.topRss[0].rssBytes, 10000 * 1024);
});

test('failed ps collection remains unavailable instead of reporting zero resource use', () => {
  const { sampler } = fixture({ fail: ['ps'] });
  const { processes } = sampler.sample();
  assert.equal(processes.available, false);
  assert.equal(processes.cpuPercent, null);
  assert.equal(processes.rssBytes, null);
  assert.deepEqual(processes.items, []);
});

test('MCP modules and uv tool packages are recognized without treating inline script text as a server name', () => {
  const { sampler } = fixture({ ps: [
    proc(10, 1, 1, 100, '/usr/local/bin/codex app-server'),
    proc(11, 10, 1, 100, '/usr/bin/python3 -m paddleocr_mcp --token hidden'),
    proc(12, 10, 1, 100, '/usr/bin/uv tool run --from paddleocr-mcp paddleocr_mcp'),
    proc(13, 10, 1, 100, '/usr/bin/node -e "const mcp_server = 1"'),
  ].join('\n') });
  const { items } = sampler.sample().processes;
  assert.equal(items.find(entry => entry.pid === 11).role, 'mcp');
  assert.equal(items.find(entry => entry.pid === 12).role, 'mcp');
  assert.equal(items.find(entry => entry.pid === 13).role, 'worker');
});

test('network parser selects Link counters once, tolerating missing MAC addresses, inactive suffixes and IP aliases', () => {
  const output = [net('en7', 1000, 2000), net('utun4', 3000, 4000, ''), net('en8*', 0, 0),
    'en7 1500 192.168.0/24 192.168.0.2 7 - 1000 9 - 2000 -',
    'lo0 16384 <Link#1> 9 0 7000 9 0 7000 0', 'broken 1500 <Link#9> 1 0 ??? 2 0 300 0'].join('\n');
  assert.deepEqual(parseNetworkSnapshot(output), [
    { name: 'en7', inBytes: 1000, outBytes: 2000 }, { name: 'utun4', inBytes: 3000, outBytes: 4000 },
    { name: 'en8', inBytes: 0, outBytes: 0 }, { name: 'lo0', inBytes: 7000, outBytes: 7000 },
  ]);
});

test('network follows real default interface, computes separate timed directions and leaves reset/missing samples blank', () => {
  const { sampler, state } = fixture({ net: [net('en7', 100, 200), net('utun4', 90000, 90000)].join('\n') });
  const first = sampler.sample().network;
  assert.equal(first.interfaceName, 'en7');
  assert.equal(first.inRate, null);
  state.at = 2000;
  state.net = net('en7', 300, 260);
  assert.equal(sampler.sample().network.inRate, 100);
  state.at = 3000;
  state.net = net('en7', 10, 270);
  const reset = sampler.sample().network;
  assert.equal(reset.inRate, null);
  assert.equal(reset.outRate, 10);
  state.at = 4000;
  state.fail = ['netstat'];
  assert.equal(sampler.sample().network.inBytes, null);
  state.at = 5000;
  state.fail = [];
  state.net = net('en7', 1000, 2000);
  assert.equal(sampler.sample().network.inRate, null);
});

test('explicit network interface never silently falls back to another interface', () => {
  const { sampler } = fixture({ sampler: { interfaceName: 'en99' } });
  const { network } = sampler.sample();
  assert.equal(network.interfaceName, 'en99');
  assert.equal(network.inBytes, null);
  assert.equal(network.inRate, null);
});

test('disk parser reads each driver dictionary rather than maxima or APFS child counters', () => {
  const text = [device('0x1', 100, 200, 10, 20), device('0x2', 30, 40, 3, 4),
    '+-o AppleAPFSContainer <class AppleAPFSContainer, id 0x3, registered>\n "Statistics" = {"Bytes (Read)"=999999,"Bytes (Write)"=999999,"Operations (Read)"=999999,"Operations (Write)"=999999}',
    device('0x1', 100, 200, 10, 20)].join('\n');
  assert.deepEqual(parseDiskSnapshot(text), [
    { id: '0x1', readBytes: 100, writeBytes: 200, readOps: 10, writeOps: 20 },
    { id: '0x2', readBytes: 30, writeBytes: 40, readOps: 3, writeOps: 4 },
  ]);
});

test('disk rates sum matching driver deltas and invalidate resets, topology changes and failures', () => {
  const { sampler, state } = fixture({ disk: [device('0x1', 100, 200, 10, 20), device('0x2', 30, 40, 3, 4)].join('\n') });
  const first = sampler.sample().disk;
  assert.equal(first.readBytes, 130);
  assert.equal(first.readRate, null);
  state.at = 2000;
  state.disk = [device('0x2', 70, 80, 5, 8), device('0x1', 160, 220, 14, 22)].join('\n');
  const next = sampler.sample().disk;
  assert.equal(next.readRate, 50);
  assert.equal(next.writeRate, 30);
  assert.equal(next.readIOPS, 3);
  assert.equal(next.writeIOPS, 3);
  state.at = 3000;
  state.disk = [device('0x2', 1, 80, 1, 8), device('0x1', 170, 230, 15, 23)].join('\n');
  assert.equal(sampler.sample().disk.readRate, null);
  state.at = 4000;
  state.disk = device('0x1', 180, 240, 16, 24);
  assert.equal(sampler.sample().disk.writeRate, null);
  state.at = 5000;
  state.fail = ['ioreg'];
  assert.equal(sampler.sample().disk.readBytes, null);
  state.at = 6000;
  state.fail = [];
  assert.equal(sampler.sample().disk.readRate, null);
  assert.ok(state.calls.filter(([file]) => file === 'ioreg').every(([, args]) => args.includes('-d') && args.includes('1')));
});

test('power and memory pressure are parsed conservatively and peripheral commands are cached', () => {
  assert.deepEqual(parsePowerSnapshot("Now drawing from 'Battery Power'\n42%; discharging; 2:13 remaining present: true"),
    { pct: 42, state: 'discharging', source: 'Battery Power', remainingMinutes: 133 });
  assert.equal(parsePowerSnapshot('No batteries found'), null);
  assert.equal(parsePowerSnapshot('101%; charging; 1:00 remaining'), null);
  const { sampler, state } = fixture();
  const first = sampler.sample();
  assert.equal(first.power.pct, 100);
  assert.equal(first.power.remainingMinutes, null);
  assert.equal(first.pressure.state, 'normal');
  assert.equal(first.thermal, null);
  state.at = 1000;
  sampler.sample();
  assert.equal(state.calls.filter(([file]) => file === 'pmset').length, 1);
  state.at = 30_000;
  state.pressure = '4';
  assert.equal(sampler.sample().pressure.state, 'critical');
  state.at = 60_000;
  state.fail = ['pmset', 'sysctl'];
  const unavailable = sampler.sample();
  assert.equal(unavailable.power, null);
  assert.equal(unavailable.pressure, null);
});

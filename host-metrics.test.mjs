import assert from 'node:assert/strict';
import test from 'node:test';
import { createHostSampler, cpuUsageBetween, parseDiskSnapshot, parseNetworkSnapshot, parsePowerSnapshot,
  parseLinuxNetworkSnapshot, parseLinuxDefaultInterface, parseLinuxDiskSnapshot } from './host-metrics.mjs';

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

test('default route refreshes independently while the old network interface still exists', () => {
  const { sampler, state } = fixture({ net: [net('en7', 100, 200), net('en8', 90000, 90000)].join('\n') });
  assert.equal(sampler.sample().network.interfaceName, 'en7');
  state.route = 'interface: en8';
  state.at = 999;
  assert.equal(sampler.sample().network.interfaceName, 'en7');
  assert.equal(state.calls.filter(([file]) => file === 'route').length, 1);
  state.at = 1000;
  assert.equal(sampler.sample().network.interfaceName, 'en8');
  assert.equal(state.calls.filter(([file]) => file === 'route').length, 2);
  assert.equal(state.calls.filter(([file]) => file === 'pmset').length, 1);
  assert.equal(state.calls.filter(([file]) => file === 'sysctl').length, 1);
});

test('a missing cached route interface triggers discovery before its configured TTL', () => {
  const { sampler, state } = fixture({ net: [net('en7', 100, 200), net('en8', 300, 400)].join('\n'), sampler: { routeIntervalMs: 60_000 } });
  assert.equal(sampler.sample().network.interfaceName, 'en7');
  state.at = 100;
  state.route = 'interface: en8';
  state.net = net('en8', 400, 500);
  assert.equal(sampler.sample().network.interfaceName, 'en8');
  assert.equal(state.calls.filter(([file]) => file === 'route').length, 2);
  state.at = 200;
  sampler.sample();
  assert.equal(state.calls.filter(([file]) => file === 'route').length, 2);
});

test('failed default-route discovery stays unknown and recovers without guessing from cumulative traffic', () => {
  const { sampler, state } = fixture({ net: [net('en7', 100, 200), net('utun4', 90000, 90000)].join('\n') });
  assert.equal(sampler.sample().network.interfaceName, 'en7');
  state.at = 1000;
  state.fail = ['route'];
  const unavailable = sampler.sample().network;
  assert.equal(unavailable.interfaceName, null);
  assert.equal(unavailable.inBytes, null);
  assert.equal(unavailable.outBytes, null);
  assert.equal(unavailable.inRate, null);
  assert.equal(unavailable.outRate, null);
  assert.equal(unavailable.interfaces.length, 2);
  state.at = 2000;
  state.fail = [];
  state.route = 'interface: utun4';
  assert.equal(sampler.sample().network.interfaceName, 'utun4');
});

test('explicit network interface never queries the default route or silently falls back to another interface', () => {
  const { sampler, state } = fixture({ sampler: { interfaceName: 'en99' } });
  const { network } = sampler.sample();
  assert.equal(network.interfaceName, 'en99');
  assert.equal(network.inBytes, null);
  assert.equal(network.inRate, null);
  state.at = 30_000;
  sampler.sample();
  assert.equal(state.calls.filter(([file]) => file === 'route').length, 0);
  const explicit = fixture({ net: [net('en7', 100, 200), net('en8', 300, 400)].join('\n'), sampler: { interfaceName: 'en8' } });
  assert.equal(explicit.sampler.sample().network.interfaceName, 'en8');
  assert.equal(explicit.state.calls.filter(([file]) => file === 'route').length, 0);
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

test('Linux proc parsers use route metrics and 512-byte disk sectors while excluding partitions', () => {
  assert.deepEqual(parseLinuxNetworkSnapshot('Inter-| Receive\n eth0: 100 1 0 0 0 0 0 0 200 2 0 0 0 0 0 0\n bad: nope 1 0 0 0 0 0 0 5 1 0 0 0 0 0 0'),
    [{ name: 'eth0', inBytes: 100, outBytes: 200 }]);
  const routes = 'Iface Destination Gateway Flags RefCnt Use Metric Mask\neth0 00000000 0100000A 0003 0 0 200 00000000\nwlan0 00000000 0100000A 0003 0 0 100 00000000';
  assert.equal(parseLinuxDefaultInterface(routes), 'wlan0');
  assert.equal(parseLinuxDefaultInterface('', '00000000000000000000000000000000 00 00000000000000000000000000000000 00 00000000000000000000000000000001 00000064 00000000 00000000 00000003 eth0'), 'eth0');
  assert.equal(parseLinuxDefaultInterface('eth0 00000000 0100000A 0000 0 0 100 00000000'), null);
  assert.equal(parseLinuxDefaultInterface('lo 00000000 00000000 0201 0 0 0 00000000'), null);
  const disk = '8 0 sda 10 0 20 0 30 0 40 0 0 0 0\n8 1 sda1 100 0 200 0 300 0 400 0 0 0 0\n7 0 loop0 100 0 200 0 300 0 400 0 0 0 0';
  assert.deepEqual(parseLinuxDiskSnapshot(disk, name => name === 'sda'), [{ id: '8:0:sda', readBytes: 10240, writeBytes: 20480, readOps: 10, writeOps: 30 }]);
  assert.deepEqual(parseLinuxDiskSnapshot(disk, () => { throw Error('missing sysfs'); }), []);
});

test('Linux host sampler provides routed traffic, physical IO and process tree without Darwin commands', () => {
  let at = 1000, incoming = 100, sectors = 10, fail = false;
  const commands = [];
  const sampler = createHostSampler({ platform: 'linux', pid: 9999, now: () => at,
    cpus: () => Array.from({ length: 8 }, () => ({ times: { user: at, nice: 0, sys: at, idle: at * 8, irq: 0 } })),
    wholeDisk: name => name === 'nvme0n1', readdir: () => [],
    readFile(file) {
      if (fail) throw Error('source failed');
      return ({ '/proc/net/dev': `eth0: ${incoming} 1 0 0 0 0 0 0 200 1 0 0 0 0 0 0`,
        '/proc/net/route': 'eth0 00000000 0100000A 0003 0 0 100 00000000',
        '/proc/diskstats': `259 0 nvme0n1 2 0 ${sectors} 0 3 0 20 0 0 0 0` })[file] || '';
    }, run(file, args) { commands.push([file, args]); return proc(10, 1, 2, 100, '/opt/codex app-server') + '\n' + proc(11, 10, 3, 200, '/usr/bin/python3 /plugins/example_mcp.py --secret hidden'); } });
  const first = sampler.sample();
  assert.equal(first.network.interfaceName, 'eth0'); assert.equal(first.network.inRate, null);
  assert.equal(first.disk.readRate, null); assert.equal(first.processes.counts.mcp, 1);
  at = 3000; incoming = 500; sectors = 30;
  const second = sampler.sample();
  assert.equal(second.network.inRate, 200); assert.equal(second.disk.readRate, 5120);
  assert.equal(second.cpu.usagePercent, 20); assert.equal(second.processes.cpuPercent, 5);
  assert.ok(commands.every(([file]) => file === 'ps'));
  assert.ok(!JSON.stringify(second).includes('hidden'));
  at = 4000; fail = true; assert.equal(sampler.sample().network.inRate, null);
  at = 5000; fail = false; assert.equal(sampler.sample().network.inRate, null);
});

const windowsFixture = () => ({
  processes: [
    { pid: 10, ppid: 1, executable: 'C:\\Program Files\\Codex\\codex.exe', command: '"C:\\Program Files\\Codex\\codex.exe" app-server', cpu100ns: '10000000', rssBytes: '1024', startedAt: 1000 },
    { pid: 11, ppid: 10, executable: 'C:\\Python\\python.exe', command: 'C:\\Python\\python.exe C:\\plugins\\mcp_server.py --token private-token', cpu100ns: '10000000', rssBytes: '2048', startedAt: 1000 },
    { pid: 12, ppid: 10, executable: 'C:\\Windows\\System32\\cmd.exe', command: 'cmd.exe /c job.exe', cpu100ns: '10000000', rssBytes: '1024', startedAt: 1000 },
    { pid: 13, ppid: 12, executable: 'C:\\tools\\job.exe', command: 'C:\\tools\\job.exe', cpu100ns: '10000000', rssBytes: '4096', startedAt: 1000 },
  ],
  networks: [{ name: 'Ethernet', inBytes: '1000', outBytes: '2000' }, { name: 'Tunnel', inBytes: '999999', outBytes: '999999' }],
  routes: [{ name: 'Ethernet', prefix: '0.0.0.0/0', metric: 0, interfaceMetric: 10 }],
  disks: [{ id: '0 C:', readBytes: '1000', writeBytes: '2000', readOps: '10', writeOps: '20' }],
  battery: { EstimatedChargeRemaining: 80, BatteryStatus: 6, EstimatedRunTime: 71582788 },
  operatingSystem: { TotalVisibleMemorySize: '10000', FreePhysicalMemory: '6000' },
  pagefiles: [{ AllocatedBaseSize: 1024, CurrentUsage: 10 }],
});

test('Windows host uses one bounded PowerShell snapshot and real multi-core process CPU deltas', () => {
  let at = 2000, value = windowsFixture(), calls = 0;
  const sampler = createHostSampler({ platform: 'win32', pid: 9999, now: () => at,
    cpus: () => Array.from({ length: 8 }, () => ({ times: { user: at, nice: 0, sys: at, idle: at * 8, irq: 0 } })),
    run(file, args) {
      calls++; assert.equal(file, 'powershell.exe');
      assert.ok(args.includes('-NoProfile') && args.includes('-NonInteractive'));
      const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
      assert.ok(script.includes('Win32_Process') && script.includes('Win32_PerfRawData_PerfDisk_PhysicalDisk'));
      assert.ok(!script.includes('Set-') && !script.includes('ExecutionPolicy'));
      return JSON.stringify(value);
    } });
  const first = sampler.sample();
  assert.equal(first.processes.cpuPercent, null); assert.equal(first.processes.rssBytes, 7168);
  assert.deepEqual(first.processes.items.map(item => item.pid).toSorted((a, b) => a - b), [10, 11, 13]);
  assert.equal(first.processes.counts.mcp, 1);
  assert.equal(first.network.interfaceName, 'Ethernet'); assert.equal(first.network.inRate, null);
  assert.equal(first.power.state, 'charging'); assert.equal(first.power.remainingMinutes, null);
  at = 3000; assert.equal(sampler.sample(), first); assert.equal(calls, 1);
  at = 5000;
  for (const item of value.processes) item.cpu100ns = '70000000';
  value.networks[0].inBytes = '4000'; value.disks[0].readBytes = '7000';
  const second = sampler.sample();
  assert.equal(second.processes.cpuPercent, 600); assert.equal(second.network.inRate, 1000); assert.equal(second.disk.readRate, 2000);
  assert.equal(second.systemSnapshot.operatingSystem.FreePhysicalMemory, '6000');
  assert.ok(!JSON.stringify(second).includes('private-token') && !JSON.stringify(second).includes('command'));
  at = 6000; const forced = sampler.sample({ force: true }); assert.equal(calls, 3); assert.equal(forced.processes.cpuPercent, 0);
});

test('Windows CPU resets, PID reuse, command failures and missing route metadata stay unknown', () => {
  let at = 2000, value = windowsFixture(), fail = false;
  const sampler = createHostSampler({ platform: 'win32', pid: 9999, now: () => at, windowsCacheMs: 0,
    cpus: () => [], run() { if (fail) throw Error('unavailable'); return JSON.stringify(value); } });
  sampler.sample(); at = 3000;
  value.processes[0].cpu100ns = '1'; value.processes[1].startedAt = 2500;
  value.routes = [];
  const reset = sampler.sample();
  assert.equal(reset.processes.cpuPercent, null); assert.equal(reset.network.interfaceName, null);
  at = 4000; fail = true;
  const missing = sampler.sample(); assert.equal(missing.processes.available, false); assert.equal(missing.systemSnapshot, null);
  assert.equal(missing.disk.readRate, null); assert.equal(missing.network.inRate, null);
  at = 5000; fail = false; value = windowsFixture(); assert.equal(sampler.sample().processes.cpuPercent, null);
  at = 6000;
  value.processes = [{ pid: 10, ppid: 1, name: 'Codex.exe', executable: null, command: null, cpu100ns: '10000000', rssBytes: '1024', startedAt: 1000 }];
  const restricted = sampler.sample().processes;
  assert.equal(restricted.available, true); assert.equal(restricted.roleCoverageComplete, false);
  assert.equal(restricted.items[0].name, 'Codex.exe'); assert.equal(restricted.rssBytes, 1024);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlatformSystemSampler, parseLinuxMeminfo, parseLinuxVmstat, parseWindowsSystemSnapshot } from './platform-system.mjs';

const KB = 1024, MB = KB ** 2, GB = KB ** 3;
const osApi = {
  cpus: () => [{ model: 'Fixture CPU' }, { model: 'Fixture CPU' }], totalmem: () => 16 * GB,
  freemem: () => 4 * GB, uptime: () => 100, loadavg: () => [1.25, 1, 0.75],
};
const statfs = () => ({ bsize: 4096n, blocks: 1000n, bfree: 400n, bavail: 300n });
const meminfo = [
  'MemTotal: 8388608 kB', 'MemAvailable: 3145728 kB', 'MemFree: 1048576 kB',
  'SwapTotal: 2097152 kB', 'SwapFree: 1572864 kB', 'AnonPages: 1048576 kB',
  'Cached: 2097152 kB', 'Zswap: 65536 kB', 'Zswapped: 131072 kB',
].join('\n');

test('Linux memory uses MemAvailable and validates units and mutually consistent counters', () => {
  const result = parseLinuxMeminfo(meminfo);
  assert.equal(result.total, 8 * GB);
  assert.equal(result.available, 3 * GB);
  assert.equal(result.used, 5 * GB);
  assert.deepEqual(result.swap, { used: 512 * MB, total: 2 * GB });
  assert.equal(result.anonymousBytes, GB);
  assert.equal(result.cachedBytes, 2 * GB);
  assert.equal(result.compressedBytes, 64 * MB);
  assert.equal(result.compressedOriginalBytes, 128 * MB);
  for (const text of ['', 'MemTotal: 0 kB\nMemAvailable: 0 kB', 'MemTotal: 1 kB\nMemAvailable: 2 kB', 'MemTotal: 8 MB\nMemAvailable: 4 MB', 'MemTotal: 8388608 kB\nMemFree: 100 kB']) {
    assert.equal(parseLinuxMeminfo(text).used, null, text);
  }
  assert.equal(parseLinuxMeminfo('SwapTotal: 0 kB\nSwapFree: 0 kB').swap.used, 0);
  assert.equal(parseLinuxMeminfo('SwapTotal: 10 kB\nSwapFree: 11 kB').swap.used, null);
});

test('Linux VM counters remain cumulative values and unsupported data stays unknown', () => {
  assert.deepEqual(parseLinuxVmstat('pgfault 100\npswpin 20\npswpout 0\npgmajfault 9\n'), { 'Translation faults': 100, Pageins: 20, Pageouts: 0 });
  assert.deepEqual(parseLinuxVmstat('pgfault -1\npswpin NaN\npswpout 9007199254740992'), { 'Translation faults': null, Pageins: null, Pageouts: null });
});

test('Windows CIM memory and pagefile units are explicit and malformed totals are never partial successes', () => {
  const result = parseWindowsSystemSnapshot({ operatingSystem: { TotalVisibleMemorySize: '8388608', FreePhysicalMemory: '2097152' },
    pagefiles: [{ AllocatedBaseSize: 1024, CurrentUsage: 128 }, { AllocatedBaseSize: 2048, CurrentUsage: 256 }] });
  assert.equal(result.total, 8 * GB);
  assert.equal(result.available, 2 * GB);
  assert.equal(result.used, 6 * GB);
  assert.deepEqual(result.swap, { used: 384 * MB, total: 3 * GB });
  assert.deepEqual(parseWindowsSystemSnapshot({ pagefiles: [] }).swap, { used: 0, total: 0 });
  for (const source of [null, {}, { pagefiles: null }, { pagefiles: [{ AllocatedBaseSize: 1, CurrentUsage: 2 }] },
    { pagefiles: [{ AllocatedBaseSize: 10, CurrentUsage: 2 }, { CurrentUsage: 1 }] }]) {
    assert.deepEqual(parseWindowsSystemSnapshot(source).swap, { used: null, total: null });
  }
  assert.equal(parseWindowsSystemSnapshot({ operatingSystem: { TotalVisibleMemorySize: 0, FreePhysicalMemory: 0 } }).used, null);
});

test('Linux sampler exposes native memory and VM values without substituting a macOS page size', () => {
  const commands = [];
  const sampler = createPlatformSystemSampler({ platform: 'linux', now: () => 1_700_000_000_000, osApi, statfs,
    readFile: file => file === '/proc/meminfo' ? meminfo : 'pgfault 100\npswpin 10\npswpout 1',
    run: (file, args) => { commands.push([file, args]); return '65536\n'; } });
  const result = sampler.sample({ path: '/fixture' });
  assert.equal(result.sys.brand, 'Fixture CPU');
  assert.equal(result.sys.ncpu, 2);
  assert.equal(result.sys.mem, 8 * GB);
  assert.equal(result.sys.bootSec, 1_699_999_900);
  assert.deepEqual(result.load, [1.25, 1, 0.75]);
  assert.equal(result.memory.memUsed, 5 * GB);
  assert.equal(result.memory.memUnused, 3 * GB);
  assert.equal(result.memory.memComp, 64 * MB);
  assert.equal(result.memory.memWired, null);
  assert.equal(result.vm.pageSize, 65536);
  assert.equal(result.vm.Pageins, 10);
  assert.equal(result.vm.anonymousBytes, GB);
  assert.deepEqual(commands, [['getconf', ['PAGESIZE']]]);
  assert.deepEqual(result.disk, { availableBytes: 300 * 4096, totalBytes: 1000 * 4096, usedPercent: 60 });
});

test('Linux proc failures clear native metrics rather than reuse old memory or invent compression', () => {
  let at = 1000, failed = false;
  const sampler = createPlatformSystemSampler({ platform: 'linux', now: () => at, osApi, statfs,
    readFile: file => { if (failed) throw Error('unavailable'); return file === '/proc/meminfo' ? meminfo : 'pgfault 30'; },
    run: () => { throw Error('getconf unavailable'); } });
  const first = sampler.sample();
  assert.equal(first.memory.memUsed, 5 * GB);
  assert.equal(first.vm.pageSize, null);
  at += 3000; failed = true;
  const next = sampler.sample();
  assert.equal(next.sys.mem, 16 * GB);
  for (const value of Object.values(next.memory)) assert.equal(value, null);
  assert.equal(next.vm['Translation faults'], null);
  assert.deepEqual(next.swap, { used: null, total: null });
});

test('Windows sampler shares the host snapshot and never launches another query when it is supplied', () => {
  let calls = 0;
  const sampler = createPlatformSystemSampler({ platform: 'win32', osApi, statfs, run: () => { calls++; throw Error('unexpected'); } });
  const native = { operatingSystem: { TotalVisibleMemorySize: 8388608, FreePhysicalMemory: 2097152 }, pagefiles: [], secret: 'never-project-this' };
  const result = sampler.sample({ path: 'C:\\fixture', windowsSnapshot: native });
  assert.equal(result.memory.memUsed, 6 * GB);
  assert.equal(result.sys.mem, 8 * GB);
  assert.deepEqual(result.load, [null, null, null]);
  assert.equal(result.vm.pageSize, null);
  assert.equal(calls, 0);
  assert.ok(!JSON.stringify(result).includes('never-project-this'));
  sampler.sample({ force: true, windowsSnapshot: null });
  assert.equal(calls, 0);
});

test('standalone Windows sampling performs one bounded local CIM command and handles BOM JSON', () => {
  let calls = 0;
  const sampler = createPlatformSystemSampler({ platform: 'win32', osApi, statfs, run: (file, args) => {
    calls++;
    assert.equal(file, 'powershell.exe');
    assert.ok(args.includes('-NoProfile') && args.includes('-NonInteractive') && args.includes('-Command'));
    assert.ok(!args.includes('-ComputerName'));
    return '\uFEFF'+JSON.stringify({ operatingSystem: { TotalVisibleMemorySize: 8388608, FreePhysicalMemory: 0 }, pagefiles: [{ AllocatedBaseSize: 1024, CurrentUsage: 10 }] });
  } });
  const result = sampler.sample();
  assert.equal(calls, 1);
  assert.equal(result.memory.memUsed, 8 * GB);
  assert.equal(result.memory.memUnused, 0);
  assert.equal(result.swap.used, 10 * MB);
});

test('cache refreshes on force, path or supplied snapshot changes and clock rollback', () => {
  let at = 1000, diskCalls = 0;
  const sampler = createPlatformSystemSampler({ platform: 'win32', now: () => at, osApi,
    statfs: () => { diskCalls++; return statfs(); }, run: () => { throw Error('must reuse host sample'); } });
  const input = { operatingSystem: { TotalVisibleMemorySize: 100, FreePhysicalMemory: 20 }, pagefiles: [] };
  const first = sampler.sample({ path: 'one', windowsSnapshot: input });
  at = 1500;
  assert.equal(sampler.sample({ path: 'one', windowsSnapshot: input }), first);
  sampler.sample({ path: 'two', windowsSnapshot: input });
  sampler.sample({ path: 'two', windowsSnapshot: input, force: true });
  sampler.sample({ path: 'two', windowsSnapshot: { ...input } });
  at = 500;
  sampler.sample({ path: 'two', windowsSnapshot: input });
  assert.equal(diskCalls, 5);
});

test('disk errors and unrepresentable or inconsistent block counters remain unknown', () => {
  for (const value of [null, { bsize: 4096, blocks: 10, bfree: 1, bavail: 2 }, { bsize: 4096, blocks: 10, bfree: 11, bavail: 1 },
    { bsize: 4096, blocks: Number.MAX_SAFE_INTEGER, bfree: 0, bavail: 0 }, { bsize: 1.5, blocks: 10, bfree: 2, bavail: 1 }]) {
    const sampler = createPlatformSystemSampler({ platform: 'win32', osApi, statfs: () => value });
    assert.deepEqual(sampler.sample({ windowsSnapshot: null }).disk, { availableBytes: null, totalBytes: null, usedPercent: null });
  }
  const sampler = createPlatformSystemSampler({ platform: 'win32', osApi, statfs: () => { throw Error('missing directory'); } });
  assert.equal(sampler.sample({ windowsSnapshot: null }).disk.totalBytes, null);
});

test('malformed native memory cannot mix a new total with old fallback used bytes', () => {
  const sampler = createPlatformSystemSampler({ platform: 'win32', osApi, statfs });
  const result = sampler.sample({ windowsSnapshot: { operatingSystem: { TotalVisibleMemorySize: 1, FreePhysicalMemory: 2 } } });
  assert.equal(result.sys.mem, KB);
  assert.equal(result.memory.memUsed, null);
  assert.equal(result.memory.memUnused, null);
  const failures = createPlatformSystemSampler({ platform: 'linux', osApi: {}, readFile: () => '', run: () => '', statfs: () => null });
  assert.deepEqual(failures.sample().sys, { brand: null, ncpu: null, mem: null, bootSec: null });
});

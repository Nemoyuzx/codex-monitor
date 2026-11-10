import os from 'node:os';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const KB = 1024, MB = KB ** 2;
const WINDOWS_SYSTEM_SCRIPT = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $o=$null; $p=$null; try {$o=Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory} catch {}; try {$p=@(Get-CimInstance Win32_PageFileUsage | Select-Object AllocatedBaseSize,CurrentUsage)} catch {}; @{operatingSystem=$o;pagefiles=$p} | ConvertTo-Json -Depth 4 -Compress";
const valid = value => Number.isFinite(value) && value >= 0;
const positive = value => valid(value) && value > 0;
const numeric = value => typeof value === 'number' ? value : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : null;
const count = value => {
  const parsed = numeric(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};
const bytes = (value, multiplier = 1) => {
  const parsed = count(value), scaled = parsed === null ? null : parsed * multiplier;
  return Number.isSafeInteger(scaled) && scaled >= 0 ? scaled : null;
};
const subtract = (total, free) => valid(total) && valid(free) && free <= total ? total - free : null;
const safeCall = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };

function defaultRun(file, args) {
  return execFileSync(file, args, { encoding: 'utf8', timeout: 2500, maxBuffer: 2 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
}

export function parseLinuxMeminfo(text) {
  const fields = {};
  for (const line of String(text || '').split('\n')) {
    const match = line.match(/^([A-Za-z_()]+):\s+(\d+)\s+kB\s*$/);
    if (match) fields[match[1]] = bytes(match[2], KB);
  }
  const total = positive(fields.MemTotal) ? fields.MemTotal : null, available = fields.MemAvailable ?? null;
  return {
    total, available: subtract(total, available) === null ? null : available,
    used: subtract(total, available), swap: { total: fields.SwapTotal ?? null, used: subtract(fields.SwapTotal, fields.SwapFree) },
    anonymousBytes: fields.AnonPages ?? null, cachedBytes: fields.Cached ?? null,
    compressedBytes: fields.Zswap ?? null, compressedOriginalBytes: fields.Zswapped ?? null,
  };
}

export function parseLinuxVmstat(text) {
  const fields = {};
  for (const line of String(text || '').split('\n')) {
    const match = line.match(/^(pgfault|pswpin|pswpout)\s+(\d+)\s*$/);
    if (match) fields[match[1]] = count(match[2]);
  }
  return { 'Translation faults': fields.pgfault ?? null, Pageins: fields.pswpin ?? null, Pageouts: fields.pswpout ?? null };
}

export function parseWindowsSystemSnapshot(snapshot) {
  const source = snapshot?.operatingSystem;
  const reported = bytes(source?.TotalVisibleMemorySize, KB), total = positive(reported) ? reported : null;
  const available = bytes(source?.FreePhysicalMemory, KB);
  let swap = { used: null, total: null };
  if (Array.isArray(snapshot?.pagefiles) && snapshot.pagefiles.length <= 128) {
    const rows = snapshot.pagefiles.map(row => ({ used: bytes(row?.CurrentUsage, MB), total: bytes(row?.AllocatedBaseSize, MB) }));
    if (rows.every(row => subtract(row.total, row.used) !== null)) {
      const used = rows.reduce((sum, row) => sum + row.used, 0), allocated = rows.reduce((sum, row) => sum + row.total, 0);
      if (Number.isSafeInteger(used) && Number.isSafeInteger(allocated)) swap = { used, total: allocated };
    }
  }
  return { total, available: subtract(total, available) === null ? null : available,
    used: subtract(total, available), swap };
}

function emptyVm() {
  return { pageSize: null, 'Translation faults': null, Pageins: null, Pageouts: null, anonymousBytes: null,
    cachedBytes: null, compressedBytes: null, compressedOriginalBytes: null };
}

function diskSnapshot(statfs, directory) {
  const value = safeCall(() => statfs(directory, { bigint: true }));
  const block = numeric(typeof value?.bsize === 'bigint' ? value.bsize.toString() : value?.bsize);
  const blocks = count(typeof value?.blocks === 'bigint' ? value.blocks.toString() : value?.blocks);
  const free = count(typeof value?.bfree === 'bigint' ? value.bfree.toString() : value?.bfree);
  const available = count(typeof value?.bavail === 'bigint' ? value.bavail.toString() : value?.bavail);
  const empty = { availableBytes: null, totalBytes: null, usedPercent: null };
  if (!Number.isSafeInteger(block) || !positive(block) || !positive(blocks) || free === null || available === null || available > free || free > blocks) return empty;
  const totalBytes = bytes(blocks, block), availableBytes = bytes(available, block);
  return totalBytes === null || availableBytes === null ? empty : { availableBytes, totalBytes, usedPercent: (blocks - free) / blocks * 100 };
}

export function createPlatformSystemSampler({ platform = process.platform, now = Date.now, run = defaultRun,
  readFile = file => fs.readFileSync(file, 'utf8'), osApi = os, statfs = fs.statfsSync, cacheMs = 2500 } = {}) {
  let cached = null, cachedAt = null, cachedPath = null, cachedInput = undefined, pageSize = null;
  const read = file => {
    const value = safeCall(() => readFile(file));
    return typeof value === 'string' && value.length <= 1024 * 1024 ? value : '';
  };
  return { sample({ path: directory = process.cwd(), force = false, windowsSnapshot } = {}) {
    const at = now();
    if (!force && cached && at >= cachedAt && at - cachedAt < cacheMs && directory === cachedPath && windowsSnapshot === cachedInput) return cached;
    const cpus = safeCall(() => osApi.cpus(), []);
    const total = safeCall(() => osApi.totalmem()), free = safeCall(() => osApi.freemem()), uptime = safeCall(() => osApi.uptime());
    const bootSec = valid(at) && valid(uptime) ? Math.floor(at / 1000 - uptime) : null;
    const sys = { brand: typeof cpus?.[0]?.model === 'string' ? cpus[0].model : null,
      ncpu: Array.isArray(cpus) && cpus.length ? cpus.length : null, mem: positive(total) ? total : null,
      bootSec: valid(bootSec) ? bootSec : null };
    let load = [null, null, null];
    if (platform !== 'win32') {
      const values = safeCall(() => osApi.loadavg());
      if (Array.isArray(values) && values.length >= 3 && values.slice(0, 3).every(valid)) load = values.slice(0, 3);
    }
    let memory = { memUsed: subtract(sys.mem, free), memUnused: subtract(sys.mem, free) === null ? null : free, memComp: null, memWired: null };
    let swap = { used: null, total: null }, vm = emptyVm();
    if (platform === 'linux') {
      const native = parseLinuxMeminfo(read('/proc/meminfo'));
      if (positive(native.total)) sys.mem = native.total;
      memory = { memUsed: native.used, memUnused: native.available, memComp: native.compressedBytes, memWired: null };
      swap = native.swap;
      if (pageSize === null) pageSize = count(String(safeCall(() => run('getconf', ['PAGESIZE']), '')).trim());
      if (!positive(pageSize)) pageSize = null;
      vm = { ...vm, ...parseLinuxVmstat(read('/proc/vmstat')), pageSize, anonymousBytes: native.anonymousBytes,
        cachedBytes: native.cachedBytes, compressedBytes: native.compressedBytes, compressedOriginalBytes: native.compressedOriginalBytes };
    } else if (platform === 'win32') {
      let snapshot = windowsSnapshot;
      if (windowsSnapshot === undefined) {
        const result = safeCall(() => run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_SYSTEM_SCRIPT]));
        const text = typeof result === 'string' ? result : result?.stdout;
        snapshot = typeof text === 'string' && text.length <= 2 * 1024 * 1024 ? safeCall(() => JSON.parse(text.replace(/^\uFEFF/, '').trim())) : null;
      }
      const native = parseWindowsSystemSnapshot(snapshot);
      if (native.total !== null) {
        sys.mem = native.total;
        memory = { ...memory, memUsed: native.used, memUnused: native.available };
      }
      swap = native.swap;
    }
    cached = { at, sys, load, memory, swap, vm, disk: diskSnapshot(statfs, directory) };
    cachedAt = at; cachedPath = directory; cachedInput = windowsSnapshot;
    return cached;
  } };
}

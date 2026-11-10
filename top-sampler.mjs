import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createPlatformSystemSampler } from './platform-system.mjs';

const runTop = promisify(execFile);
const rateFields = [
  ['netByteIn', 'netInRate'], ['netByteOut', 'netOutRate'],
  ['netPktIn', 'netPktInRate'], ['netPktOut', 'netPktOutRate'],
  ['diskByteRead', 'diskReadRate'], ['diskByteWrite', 'diskWriteRate'],
  ['diskOpRead', 'diskOpReadRate'], ['diskOpWrite', 'diskOpWriteRate'],
];
function bytes(value, unit) {
  return Number(value) * ({ '': 1, B: 1, K: 1024, M: 1048576, G: 1073741824, T: 1099511627776 }[(unit || '').toUpperCase()] || 1);
}

// A missing/reset counter or missing baseline establishes no measured rate.
export function parseTopSnapshot(text, at, previous = null) {
  const s = String(text || ''), out = { at };
  let m;
  if ((m = s.match(/Processes:\s*(\d+)\s*total,\s*(\d+)\s*running,\s*(?:(\d+)\s*stuck,\s*)?(\d+)\s*sleeping,\s*(\d+)\s*threads/))) {
    out.procTotal = Number(m[1]); out.procRunning = Number(m[2]); out.procSleeping = Number(m[4]); out.threads = Number(m[5]);
  }
  if ((m = s.match(/CPU usage:\s*([\d.]+)%\s*user,\s*([\d.]+)%\s*sys,\s*([\d.]+)%\s*idle/))) {
    out.cpuUser = Number(m[1]); out.cpuSys = Number(m[2]); out.cpuIdle = Number(m[3]);
  }
  if ((m = s.match(/PhysMem:\s*([\d.]+)([KMG]?)\s*used\s*\(([\d.]+)([KMG]?)\s*wired,\s*([\d.]+)([KMG]?)\s*compressor\),\s*([\d.]+)([KMG]?)\s*unused/))) {
    out.memUsed = bytes(m[1], m[2]); out.memWired = bytes(m[3], m[4]); out.memComp = bytes(m[5], m[6]); out.memUnused = bytes(m[7], m[8]);
  }
  if ((m = s.match(/([\d,]+)\(\d+\)\s*swapins,\s*([\d,]+)\(\d+\)\s*swapouts/))) {
    out.swapins = Number(m[1].replace(/,/g, '')); out.swapouts = Number(m[2].replace(/,/g, ''));
  }
  if ((m = s.match(/Networks:\s*packets:\s*(\d+)\/([\d.]+)([KMG]?)\s*in,\s*(\d+)\/([\d.]+)([KMG]?)\s*out/))) {
    out.netPktIn = Number(m[1]); out.netByteIn = bytes(m[2], m[3]); out.netPktOut = Number(m[4]); out.netByteOut = bytes(m[5], m[6]);
  }
  if ((m = s.match(/Disks:\s*(\d+)\/([\d.]+)([KMG]?)\s*read,\s*(\d+)\/([\d.]+)([KMG]?)\s*written/))) {
    out.diskOpRead = Number(m[1]); out.diskByteRead = bytes(m[2], m[3]); out.diskOpWrite = Number(m[4]); out.diskByteWrite = bytes(m[5], m[6]);
  }
  const seconds = (at - previous?.at) / 1000;
  for (const [counter, output] of rateFields) {
    const current = out[counter], before = previous?.[counter];
    out[output] = Number.isFinite(current) && Number.isFinite(before) && current >= before && Number.isFinite(seconds) && seconds > 0
      ? (current - before) / seconds : null;
  }
  return out;
}

export function portableTopSnapshot(system, host, at) {
  const result = { at, ...(system?.memory || {}) };
  for (const [, output] of rateFields) result[output] = null;
  const numeric = value => Number.isFinite(value) && value >= 0 ? value : undefined;
  const cpu = numeric(host?.cpu?.usagePercent);
  if (cpu !== undefined && cpu <= 100) result.cpuIdle = 100 - cpu;
  const mappings = {
    netByteIn: host?.network?.inBytes, netByteOut: host?.network?.outBytes,
    netInRate: host?.network?.inRate, netOutRate: host?.network?.outRate,
    diskByteRead: host?.disk?.readBytes, diskByteWrite: host?.disk?.writeBytes,
    diskOpRead: host?.disk?.readOps, diskOpWrite: host?.disk?.writeOps,
    diskReadRate: host?.disk?.readRate, diskWriteRate: host?.disk?.writeRate,
    diskOpReadRate: host?.disk?.readIOPS, diskOpWriteRate: host?.disk?.writeIOPS,
  };
  for (const [key, value] of Object.entries(mappings)) if (numeric(value) !== undefined) result[key] = value;
  return result;
}

export function createTopSampler({ now = Date.now, cacheMs = 2500, run = runTop, platform = process.platform,
  portableSystem = createPlatformSystemSampler({ platform, now }) } = {}) {
  let cached = null, cachedAt = null, previous = null, pending = null;
  return {
    sample({ force = false, signal, systemSnapshot, hostSnapshot } = {}) {
      if (pending) return pending;
      const at = now();
      if (!force && cached && at >= cachedAt && at - cachedAt < cacheMs) return Promise.resolve(cached);
      pending = (async () => {
        let text = '';
        try {
          if (platform !== 'darwin') {
            const system = signal?.aborted ? null : systemSnapshot === undefined ? portableSystem.sample({ force }) : systemSnapshot;
            cached = signal?.aborted ? parseTopSnapshot('', at) : portableTopSnapshot(system, hostSnapshot, at);
            previous = cached; cachedAt = at;
            return cached;
          }
          if (!signal?.aborted) ({ stdout: text } = await run('top', ['-l', '1', '-n', '0'], {
            encoding: 'utf8', timeout: 3500, maxBuffer: 16 * 1024 * 1024, signal,
          }));
        } catch {}
        cached = parseTopSnapshot(text, at, previous);
        previous = cached; cachedAt = at;
        return cached;
      })().finally(() => { pending = null; });
      return pending;
    },
  };
}


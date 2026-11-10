import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const clean = (value, limit = 256) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, limit) : '';

function splitToml(text, separator = '\n') {
  const parts = [];
  let buffer = '', quote = '', triple = false, depth = 0, escaped = false, complete = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      buffer += ch;
      if (escaped) { escaped = false; continue; }
      if (quote === '"' && ch === '\\') { escaped = true; continue; }
      if (ch === quote && (!triple || text.slice(i, i + 3) === quote.repeat(3))) {
        if (triple) { buffer += quote.repeat(2); i += 2; }
        quote = ''; triple = false;
      }
      continue;
    }
    if (ch === '#') {
      while (i + 1 < text.length && text[i + 1] !== '\n') i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch; triple = text.slice(i, i + 3) === ch.repeat(3);
      buffer += triple ? ch.repeat(3) : ch;
      if (triple) i += 2;
      continue;
    }
    if (ch === '[' || ch === '{') depth++;
    if (ch === ']' || ch === '}') { depth--; if (depth < 0) complete = false; }
    if (ch === separator && depth === 0) {
      if (buffer.trim()) parts.push(buffer.trim());
      buffer = '';
      if (parts.length >= 10000) return { parts, complete: false };
    } else buffer += ch;
  }
  if (buffer.trim()) parts.push(buffer.trim());
  return { parts, complete: complete && !quote && depth === 0 };
}

function stringValue(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (text.startsWith('"""') && text.endsWith('"""') && text.length >= 6) return text.slice(3, -3).replace(/^\r?\n/, '');
  if (text.startsWith("'''") && text.endsWith("'''")) return text.slice(3, -3).replace(/^\r?\n/, '');
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) return text.slice(1, -1);
  if (text.startsWith('"') && text.endsWith('"') && !text.startsWith('"""')) {
    try {
      return JSON.parse(text.replace(/\\U([0-9a-fA-F]{8})/g, (_, hex) => JSON.stringify(String.fromCodePoint(parseInt(hex, 16))).slice(1, -1)));
    } catch { return null; }
  }
  return null;
}

function keyPath(raw) {
  const values = [];
  let rest = raw.trim();
  while (rest) {
    let value, used;
    if (rest[0] === '"' || rest[0] === "'") {
      const quote = rest[0];
      let end = 1, escape = false;
      for (; end < rest.length; end++) {
        if (escape) { escape = false; continue; }
        if (quote === '"' && rest[end] === '\\') { escape = true; continue; }
        if (rest[end] === quote) break;
      }
      if (end >= rest.length) return null;
      value = stringValue(rest.slice(0, end + 1)); used = end + 1;
    } else {
      const match = rest.match(/^[a-zA-Z0-9_-]+/);
      if (!match) return null;
      value = match[0]; used = value.length;
    }
    if (value == null || !value) return null;
    values.push(value); rest = rest.slice(used).trimStart();
    if (!rest) break;
    if (rest[0] !== '.') return null;
    rest = rest.slice(1).trimStart();
    if (!rest) return null;
  }
  return values.length ? values : null;
}

function assignment(text) {
  let quote = '', escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (quote === '"' && ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '=') {
      const keys = keyPath(text.slice(0, i));
      return keys ? { keys, value: text.slice(i + 1).trim() } : null;
    }
  }
  return null;
}

export function parseCapabilityConfiguration(text) {
  const parsed = splitToml(String(text));
  const result = { complete: parsed.complete, mcp: new Map(), plugins: new Map(), skills: [], projects: new Map(), bundled: null };
  const tables = new Set(), assignments = new Set();
  let section = [], skill = null, arrayId = 0, arraySerial = 0;
  const boolean = raw => raw === 'true' ? true : raw === 'false' ? false : null;
  const mcpFields = (record, field, raw) => {
    if (field === 'enabled') { record.enabled = boolean(raw); if (record.enabled == null) result.complete = false; }
    else if (field === 'command') { record.command = Boolean(stringValue(raw)?.trim()); if (!record.command) result.complete = false; }
    else if (field === 'url') { record.url = Boolean(stringValue(raw)?.trim()); if (!record.url) result.complete = false; }
    else if (field === 'type' || field === 'transport') record.transport = clean(stringValue(raw));
  };
  const apply = (keys, raw) => {
    if ((keys[0] === 'mcp_servers' && keys.length < 3) || (keys[0] === 'plugins' && (keys.length < 3 || (keys[2] === 'mcp_servers' && keys.length < 5)))) {
      if (!raw.startsWith('{') || !raw.endsWith('}')) { result.complete = false; return; }
      const values = splitToml(raw.slice(1, -1), ',');
      if (!values.complete) result.complete = false;
      for (const value of values.parts) {
        const pair = assignment(value);
        if (pair) apply([...keys, ...pair.keys], pair.value); else result.complete = false;
      }
      return;
    }
    if (keys[0] === 'mcp_servers' && keys.length >= 3) {
      const record = result.mcp.get(keys[1]) || {};
      if (keys.length === 3) mcpFields(record, keys[2], raw);
      result.mcp.set(keys[1], record);
    } else if (keys[0] === 'plugins' && keys.length >= 3) {
      const record = result.plugins.get(keys[1]) || { servers: new Map() };
      if (keys.length === 3 && keys[2] === 'enabled') {
        record.enabled = boolean(raw); if (record.enabled == null) result.complete = false;
      } else if (keys[2] === 'mcp_servers' && keys.length >= 5) {
        const server = record.servers.get(keys[3]) || {};
        if (keys.length === 5) mcpFields(server, keys[4], raw);
        record.servers.set(keys[3], server);
      }
      result.plugins.set(keys[1], record);
    } else if (keys[0] === 'projects' && keys.length === 3 && keys[2] === 'trust_level') {
      result.projects.set(keys[1], stringValue(raw));
    } else if (keys.join('.') === 'skills.bundled.enabled') {
      result.bundled = boolean(raw); if (result.bundled == null) result.complete = false;
    } else if (keys.join('.') === 'skills.config' && raw.startsWith('[') && raw.endsWith(']')) {
      const values = splitToml(raw.slice(1, -1), ',');
      if (!values.complete) result.complete = false;
      for (const value of values.parts) {
        if (!value.startsWith('{') || !value.endsWith('}')) { result.complete = false; continue; }
        const entry = {};
        for (const part of splitToml(value.slice(1, -1), ',').parts) {
          const pair = assignment(part);
          if (!pair || pair.keys.length !== 1) { result.complete = false; continue; }
          if (pair.keys[0] === 'enabled') entry.enabled = boolean(pair.value);
          else if (['name', 'path'].includes(pair.keys[0])) entry[pair.keys[0]] = stringValue(pair.value);
        }
        result.skills.push(entry);
      }
    }
  };
  for (const statement of parsed.parts) {
    if (statement.startsWith('[')) {
      const array = statement.startsWith('[['), suffix = array ? ']]' : ']';
      const keys = statement.endsWith(suffix) ? keyPath(statement.slice(array ? 2 : 1, -suffix.length)) : null;
      if (!keys) { result.complete = false; section = []; skill = null; continue; }
      section = keys; skill = null;
      if (array) arrayId = ++arraySerial;
      else {
        arrayId = 0;
        const key = JSON.stringify(keys);
        if (tables.has(key)) result.complete = false;
        tables.add(key);
      }
      if (array && keys.join('.') === 'skills.config') { skill = {}; result.skills.push(skill); }
      if (!array && keys[0] === 'mcp_servers' && keys.length >= 2 && !result.mcp.has(keys[1])) result.mcp.set(keys[1], {});
      continue;
    }
    const pair = assignment(statement);
    if (!pair) { result.complete = false; continue; }
    const assigned = JSON.stringify([arrayId, ...section, ...pair.keys]);
    if (assignments.has(assigned)) result.complete = false;
    assignments.add(assigned);
    if (skill && pair.keys.length === 1) {
      const key = pair.keys[0];
      if (key === 'enabled') skill.enabled = boolean(pair.value);
      else if (key === 'path' || key === 'name') skill[key] = stringValue(pair.value);
    } else apply([...section, ...pair.keys], pair.value);
  }
  for (const rule of result.skills) if (typeof rule.enabled !== 'boolean' || Boolean(rule.path) === Boolean(rule.name)) result.complete = false;
  return result;
}

export function parseSkillMetadata(text) {
  const front = String(text).replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!front) return null;
  const read = key => {
    const lines = front.split(/\r?\n/), index = lines.findIndex(line => line.startsWith(key + ':'));
    if (index < 0) return '';
    let value = lines[index].slice(key.length + 1).trim();
    if (/^[>|][+-]?$/.test(value)) {
      const values = [];
      for (let i = index + 1; i < lines.length && (!lines[i].trim() || /^\s/.test(lines[i])); i++) values.push(lines[i].trim());
      value = values.join(' ');
    } else if (value.startsWith('"')) {
      try { value = JSON.parse(value); } catch { return ''; }
    } else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replaceAll("''", "'");
    else value = value.replace(/\s+#.*$/, '');
    return clean(value, key === 'name' ? 160 : 600);
  };
  const name = read('name'), description = read('description');
  return name && description ? { name, description } : null;
}

const typeOf = entry => entry?.url ? (entry.transport === 'sse' ? 'sse' : 'http') : entry?.command ? 'stdio' : 'unknown';
const inside = (root, target, paths) => { const relative = paths.relative(root, target); return relative === '' || (!relative.startsWith('..' + paths.sep) && relative !== '..' && !paths.isAbsolute(relative)); };

export function createCapabilityInventorySampler({ home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), userHome = os.homedir(), cwd = process.cwd(),
  fileSystem = fs, paths = path, now = Date.now, ttlMs = 15000, platform = process.platform,
  adminRoots = platform === 'win32' ? [] : ['/etc/codex/skills'], projectTrusted,
  maxEntries = 12000, maxFiles = 2000, maxDepth = 8, maxBytes = 16 * 1024 * 1024 } = {}) {
  home = paths.resolve(home); userHome = paths.resolve(userHome); cwd = paths.resolve(cwd);
  let cached = null, cachedAt = null, closed = false;
  const sample = ({ force = false } = {}) => {
    const sampledAt = now();
    if (cached && !force && sampledAt >= cachedAt && sampledAt - cachedAt < ttlMs) return structuredClone(cached);
    const coverage = { complete: true, bounded: true, unreadable: 0, truncated: false, invalidSkills: 0, unverifiedPlugins: 0,
      ambiguousPluginVersions: 0, skippedProjectConfigs: 0, projectConfigTrusted: null, effectiveConfigurationVerified: false };
    let entriesLeft = maxEntries, filesLeft = maxFiles, bytesLeft = maxBytes;
    const unknown = () => ({ available: false, total: null, enabled: null, disabled: null, unknown: null, items: [] });
    if (closed) return { sampledAt, available: false, coverage: { ...coverage, complete: false }, mcp: unknown(), skills: unknown() };
    const unavailable = () => { coverage.complete = false; coverage.unreadable++; };
    const bound = () => { coverage.complete = false; coverage.truncated = true; };
    const stat = name => { try { return fileSystem.statSync(name); } catch (error) { if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') unavailable(); return null; } };
    const exists = name => Boolean(stat(name));
    const read = (name, limit, prefix = false) => {
      const info = stat(name);
      if (!info) return null;
      if (!info.isFile()) { unavailable(); return null; }
      if (filesLeft-- <= 0 || bytesLeft <= 0) { bound(); return null; }
      if (!prefix && info.size > limit) { bound(); return null; }
      const length = Math.min(info.size, limit, bytesLeft);
      if (length < Math.min(info.size, limit)) { bound(); return null; }
      let fd;
      try {
        fd = fileSystem.openSync(name, 'r'); const buffer = Buffer.alloc(length);
        const count = fileSystem.readSync(fd, buffer, 0, length, 0); bytesLeft -= count;
        return buffer.subarray(0, count).toString('utf8');
      } catch { unavailable(); return null; }
      finally { if (fd !== undefined) try { fileSystem.closeSync(fd); } catch {} }
    };
    const list = name => {
      if (!stat(name)?.isDirectory()) return [];
      let directory;
      const entries = [];
      try {
        directory = fileSystem.opendirSync(name);
        for (;;) {
          const entry = directory.readSync(); if (!entry) break;
          if (entriesLeft-- <= 0) { bound(); break; }
          entries.push(entry.name);
        }
      } catch { unavailable(); }
      finally { if (directory) try { directory.closeSync(); } catch {} }
      return entries.sort();
    };
    const json = name => { const text = read(name, 1024 * 1024); if (text == null) return null; try { return JSON.parse(text); } catch { unavailable(); return null; } };
    const config = name => { const text = read(name, 1024 * 1024); if (text == null) return null; const value = parseCapabilityConfiguration(text); if (!value.complete) coverage.complete = false; return value; };
    const homeAvailable = stat(home)?.isDirectory() || false, userAvailable = stat(userHome)?.isDirectory() || false;
    const globalFilename = paths.join(home, 'config.toml'), globalPresent = exists(globalFilename);
    const global = config(globalFilename);
    const globalReadable = !globalPresent || global !== null;
    const projectDirs = [];
    let current = cwd, foundRepository = false;
    for (let depth = 0; depth < 32; depth++) {
      projectDirs.push(current);
      if (exists(paths.join(current, '.git'))) { foundRepository = true; break; }
      const parent = paths.dirname(current); if (parent === current) break;
      current = parent;
      if (depth === 31) bound();
    }
    if (!foundRepository) projectDirs.splice(1);
    let trusted = typeof projectTrusted === 'boolean' ? projectTrusted : null;
    if (trusted == null && global) {
      let nearest = -1;
      for (const [root, level] of global.projects) {
        if (!paths.isAbsolute(root)) continue;
        const resolved = paths.resolve(root);
        if (inside(resolved, cwd, paths) && resolved.length > nearest && ['trusted', 'untrusted'].includes(level)) {
          trusted = level === 'trusted'; nearest = resolved.length;
        }
      }
    }
    coverage.projectConfigTrusted = trusted;
    const configs = global ? [{ value: global, source: 'user' }] : [];
    for (const dir of [...projectDirs].reverse()) {
      const filename = paths.join(dir, '.codex', 'config.toml');
      if (!exists(filename) || paths.resolve(filename) === paths.join(home, 'config.toml')) continue;
      if (trusted !== true) { coverage.skippedProjectConfigs++; coverage.complete = false; continue; }
      const value = config(filename); if (value) configs.push({ value, source: 'project' });
    }
    const serverMap = new Map(), pluginSettings = new Map(), rules = [];
    let bundled = true;
    for (const { value, source } of configs) {
      if (value.bundled != null) bundled = value.bundled;
      rules.push(...value.skills);
      for (const [name, record] of value.mcp) serverMap.set(name, { ...serverMap.get(name), ...record, source });
      for (const [id, record] of value.plugins) {
        const previous = pluginSettings.get(id);
        pluginSettings.set(id, { ...previous, ...record, servers: new Map([...(previous?.servers || []), ...record.servers]) });
      }
    }
    const mcpItems = [...serverMap].map(([name, record]) => ({ name: clean(name), type: typeOf(record), enabled: record.enabled === undefined ? true : record.enabled, source: record.source, plugin: null }));
    const skillItems = new Map(), visited = new Set();
    const scanSkills = (root, source, enabled = true, plugin = null, depth = 0, allowedPluginRoot = null) => {
      if (!stat(root)?.isDirectory()) return;
      let real;
      try { real = fileSystem.realpathSync(root); } catch { unavailable(); return; }
      if (allowedPluginRoot && !inside(allowedPluginRoot, real, paths)) { coverage.complete = false; return; }
      const filename = paths.join(root, 'SKILL.md');
      let realFile = paths.join(real, 'SKILL.md'), fileAllowed = true;
      if (exists(filename)) {
        try { realFile = fileSystem.realpathSync(filename); } catch { unavailable(); fileAllowed = false; }
        if (allowedPluginRoot && !inside(allowedPluginRoot, realFile, paths)) { coverage.complete = false; fileAllowed = false; }
      }
      const effectiveSource = source === 'user' && inside(paths.join(home, 'skills', '.system'), root, paths) ? 'system' : source;
      if (fileAllowed && skillItems.has(realFile)) {
        const existing = skillItems.get(realFile);
        if (!existing.sources.includes(effectiveSource)) existing.sources.push(effectiveSource);
        return;
      }
      if (visited.has(real)) return;
      visited.add(real);
      const text = fileAllowed ? read(filename, 16 * 1024, true) : null;
      if (text != null) {
        const metadata = parseSkillMetadata(text);
        if (metadata) {
          let state = enabled;
          for (const rule of rules) {
            let pathMatches = rule.path && paths.isAbsolute(rule.path) && [paths.resolve(filename), paths.resolve(realFile)].includes(paths.resolve(rule.path));
            if (!pathMatches && rule.path && paths.isAbsolute(rule.path)) try { pathMatches = fileSystem.realpathSync(rule.path) === realFile; } catch {}
            if (pathMatches || rule.name === metadata.name) state = typeof rule.enabled === 'boolean' ? rule.enabled : null;
          }
          if (enabled === false || (effectiveSource === 'system' && !bundled)) state = false;
          skillItems.set(realFile, { ...metadata, path: filename, source: effectiveSource, sources: [effectiveSource], plugin, enabled: state });
        } else { coverage.invalidSkills++; coverage.complete = false; }
      }
      const children = list(root).filter(name => !['.git', 'node_modules'].includes(name));
      if (depth >= maxDepth) { if (children.some(name => stat(paths.join(root, name))?.isDirectory())) bound(); return; }
      for (const child of children) if (stat(paths.join(root, child))?.isDirectory()) scanSkills(paths.join(root, child), source, enabled, plugin, depth + 1, allowedPluginRoot);
    };
    for (const dir of projectDirs) scanSkills(paths.join(dir, '.agents', 'skills'), 'project');
    scanSkills(paths.join(userHome, '.agents', 'skills'), 'user');
    scanSkills(paths.join(home, 'skills'), 'user');
    for (const root of adminRoots) scanSkills(root, 'admin');
    const pluginCache = paths.join(home, 'plugins', 'cache');
    const plugins = [];
    for (const marketplace of list(pluginCache)) for (const name of list(paths.join(pluginCache, marketplace))) {
      if (name.startsWith('.')) continue;
      const root = paths.join(pluginCache, marketplace, name), id = name + '@' + marketplace;
      const settings = pluginSettings.get(id);
      const marker = json(paths.join(root, '.codex-remote-plugin-install.json'));
      if (!settings && !(marker && typeof marker.remote_plugin_id === 'string')) continue;
      plugins.push({ root, id, settings });
    }
    for (const [id, settings] of pluginSettings) {
      if (plugins.some(plugin => plugin.id === id)) continue;
      const name = id.split('@')[0];
      if (/^[a-zA-Z0-9_.-]+$/.test(name)) plugins.push({ root: paths.join(home, 'plugins', name), id, settings });
    }
    for (const plugin of plugins) {
      let roots = [];
      if (exists(paths.join(plugin.root, 'plugin.json')) || exists(paths.join(plugin.root, '.codex-plugin', 'plugin.json'))) roots = [plugin.root];
      else roots = list(plugin.root).filter(name => !name.startsWith('.')).map(name => paths.join(plugin.root, name))
        .filter(dir => exists(paths.join(dir, 'plugin.json')) || exists(paths.join(dir, '.codex-plugin', 'plugin.json')));
      if (roots.length !== 1) { coverage.complete = false; coverage.ambiguousPluginVersions++; continue; }
      const root = roots[0], portable = json(paths.join(root, 'plugin.json'));
      const manifest = portable || json(paths.join(root, '.codex-plugin', 'plugin.json'));
      if (!manifest || typeof manifest.name !== 'string') { coverage.complete = false; continue; }
      let realPluginRoot;
      try { realPluginRoot = fileSystem.realpathSync(root); } catch { unavailable(); continue; }
      const enabled = typeof plugin.settings?.enabled === 'boolean' ? plugin.settings.enabled : null;
      if (enabled == null) { coverage.unverifiedPlugins++; coverage.complete = false; }
      const resolveComponent = component => {
        if (typeof component !== 'string' || !component.startsWith('./') || component.split(/[\\/]/).includes('..')) return null;
        const resolved = paths.resolve(root, component);
        if (!inside(root, resolved, paths)) return null;
        if (!exists(resolved)) return resolved;
        try { return inside(fileSystem.realpathSync(root), fileSystem.realpathSync(resolved), paths) ? resolved : null; }
        catch { unavailable(); return null; }
      };
      const components = portable ? ['./skills'] : Array.isArray(manifest.skills) ? manifest.skills : typeof manifest.skills === 'string' ? [manifest.skills] : [];
      for (const component of components) {
        const resolved = resolveComponent(component);
        if (resolved) scanSkills(resolved, 'plugin', enabled, clean(plugin.id), 0, realPluginRoot); else { coverage.complete = false; }
      }
      if (enabled == null) continue;
      const mcpFile = resolveComponent(portable ? './mcp.json' : typeof manifest.mcpServers === 'string' ? manifest.mcpServers : './.mcp.json');
      const inline = !portable && manifest.mcpServers && typeof manifest.mcpServers === 'object' && !Array.isArray(manifest.mcpServers) ? manifest.mcpServers : null;
      const servers = inline ? inline.mcpServers || inline : mcpFile ? json(mcpFile)?.mcpServers : null;
      if (servers && typeof servers === 'object' && !Array.isArray(servers)) {
        const entries = Object.entries(servers);
        if (entries.length > 256) bound();
        for (const [name, record] of entries.slice(0, 256)) {
          if (!record || typeof record !== 'object') continue;
          const policy = plugin.settings?.servers.get(name);
          const type = typeof record.url === 'string' ? record.type === 'sse' ? 'sse' : 'http' : typeof record.command === 'string' ? 'stdio' : 'unknown';
          mcpItems.push({ name: clean(name), type, enabled: enabled === false ? false : policy?.enabled === undefined ? true : policy.enabled, source: 'plugin', plugin: clean(plugin.id) });
        }
      }
    }
    const summarize = (items, available) => ({ available, total: available ? items.length : null,
      enabled: available ? items.filter(item => item.enabled === true).length : null,
      disabled: available ? items.filter(item => item.enabled === false).length : null,
      unknown: available ? items.filter(item => item.enabled == null).length : null,
      items: items.sort((a, b) => a.name.localeCompare(b.name) || (a.path || a.plugin || '').localeCompare(b.path || b.plugin || '')) });
    cached = { sampledAt, available: homeAvailable || userAvailable || skillItems.size > 0, coverage,
      mcp: summarize(mcpItems, globalReadable && (homeAvailable || configs.length > 0 || mcpItems.length > 0)),
      skills: summarize([...skillItems.values()], (homeAvailable || userAvailable || skillItems.size > 0) && !((coverage.unreadable || coverage.truncated) && !skillItems.size)) };
    cachedAt = sampledAt;
    return structuredClone(cached);
  };
  return { sample, close: () => { closed = true; cached = null; } };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCapabilityInventorySampler, parseCapabilityConfiguration, parseSkillMetadata } from './capability-inventory.mjs';

function fixture(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-capabilities-'));
  const userHome = path.join(directory, 'user'), home = path.join(userHome, '.codex'), repo = path.join(directory, 'repo'), cwd = path.join(repo, 'nested');
  for (const dir of [home, cwd, path.join(repo, '.git')]) fs.mkdirSync(dir, { recursive: true });
  const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content)); return file; };
  const skill = (directory, name = path.basename(directory), description = 'A fixture skill.') => write(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nPrivate instructions are not metadata.\n`);
  const sampler = (options = {}) => createCapabilityInventorySampler({ home, userHome, cwd, adminRoots: [], ...options });
  try { return callback({ directory, userHome, home, repo, cwd, write, skill, sampler }); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test('capability configuration extracts metadata without retaining commands, URLs or credentials', () => {
  const parsed = parseCapabilityConfiguration(`
[mcp_servers."one.with.dots"]
command = "node SECRET-COMMAND"
args = [
 "ignore [mcp_servers.phantom]", "SECRET-ARG"
]
enabled = false # disabled explicitly
[mcp_servers."one.with.dots".env]
API_KEY = "SECRET-ENV"
[mcp_servers.remote]
url = "https://secret-user:SECRET-PASSWORD@example.test/SECRET-PATH?token=SECRET-QUERY#SECRET-HASH"
http_headers = { Authorization = "SECRET-HEADER" }
[mcp_servers.remote.oauth]
client_secret = "SECRET-OAUTH"
[mcp_servers]
inline = {command = 'python', enabled = true}
[plugins."fixture@local".mcp_servers.remote]
enabled = false
[[skills.config]]
name = "disabled"
enabled = false
`);
  assert.equal(parsed.complete, true);
  assert.deepEqual([...parsed.mcp.keys()], ['one.with.dots', 'remote', 'inline']);
  assert.deepEqual(parsed.mcp.get('one.with.dots'), { command: true, enabled: false });
  assert.deepEqual(parsed.mcp.get('remote'), { url: true });
  assert.deepEqual(parsed.plugins.get('fixture@local').servers.get('remote'), { enabled: false });
  const projected = JSON.stringify({ mcp: [...parsed.mcp], plugins: [...parsed.plugins], skills: parsed.skills });
  assert.ok(!projected.includes('SECRET'));
  assert.equal(parseCapabilityConfiguration('[mcp_servers.bad]\nenabled = "false"').complete, false);
  assert.equal(parseCapabilityConfiguration('[mcp_servers.bad]\nargs = ["unterminated').complete, false);
  assert.equal(parseCapabilityConfiguration('[mcp_servers.bad]\nenabled = true\nenabled = false').complete, false);
  assert.equal(parseCapabilityConfiguration('[mcp_servers.bad]\ncommand = "node"\n[mcp_servers.bad]\nenabled = false').complete, false);
});

test('skill metadata reads folded frontmatter while ignoring instructions and terminal controls', () => {
  assert.deepEqual(parseSkillMetadata('---\nname: "测试\\u001b[31m"\ndescription: >-\n  First line\n  and second line.\n---\nname: SECRET-BODY\n'),
    { name: '测试 [31m', description: 'First line and second line.' });
  assert.equal(parseSkillMetadata('name: no-frontmatter\ndescription: bad'), null);
  assert.equal(parseSkillMetadata('---\nname: incomplete\n---\n'), null);
});

test('global MCP configuration and trusted project overrides preserve safe distinct entries', () => fixture(({ home, repo, cwd, write, sampler }) => {
  write(path.join(home, 'config.toml'), `[projects.${JSON.stringify(repo)}]\ntrust_level='trusted'\n[mcp_servers.shared]\ncommand='SECRET-COMMAND'\n[mcp_servers.remote]\nurl='https://example.test/SECRET-ENDPOINT'\n[mcp_servers.disabled]\ncommand='node'\nenabled=false\n`);
  write(path.join(repo, '.codex', 'config.toml'), '[mcp_servers.shared]\nenabled=false\n[mcp_servers.project]\ncommand="node"\n');
  write(path.join(cwd, '.codex', 'config.toml'), '[mcp_servers.project]\nenabled=true\n');
  const result = sampler().sample();
  assert.equal(result.mcp.available, true);
  assert.equal(result.mcp.total, 4);
  assert.equal(result.mcp.enabled, 2);
  assert.equal(result.mcp.disabled, 2);
  assert.deepEqual(result.mcp.items.find(item => item.name === 'shared'), { name: 'shared', type: 'stdio', enabled: false, source: 'project', plugin: null });
  assert.ok(!JSON.stringify(result).includes('SECRET'));
  assert.equal(result.coverage.projectConfigTrusted, true);
}));

test('untrusted and unknown project settings are not represented as effective MCP policy', () => fixture(({ home, repo, write, sampler }) => {
  write(path.join(home, 'config.toml'), '[mcp_servers.user]\ncommand="node"\n');
  write(path.join(repo, '.codex', 'config.toml'), '[mcp_servers.project]\ncommand="node"\n');
  for (const projectTrusted of [undefined, false]) {
    const result = sampler({ projectTrusted }).sample();
    assert.deepEqual(result.mcp.items.map(item => item.name), ['user']);
    assert.equal(result.coverage.skippedProjectConfigs, 1);
    assert.equal(result.coverage.complete, false);
    assert.equal(result.coverage.effectiveConfigurationVerified, false);
  }
}));

test('skills deduplicate physical paths, retain equal names at different paths and apply last matching policies', () => fixture(({ home, userHome, repo, cwd, write, skill, sampler }) => {
  const original = skill(path.join(home, 'skills', 'shared'), 'shared-name');
  const other = skill(path.join(userHome, '.agents', 'skills', 'other'), 'shared-name');
  skill(path.join(home, 'skills', '.system', 'bundled'), 'bundled');
  skill(path.join(repo, '.agents', 'skills', 'project'), 'project');
  skill(path.join(cwd, '.agents', 'skills', 'nested'), 'nested');
  const alias = path.join(userHome, '.agents', 'skills', 'alias');
  fs.symlinkSync(path.dirname(original), alias, process.platform === 'win32' ? 'junction' : 'dir');
  fs.symlinkSync(path.dirname(original), path.join(path.dirname(original), 'cycle'), process.platform === 'win32' ? 'junction' : 'dir');
  write(path.join(home, 'config.toml'), `[skills.bundled]\nenabled=false\n[[skills.config]]\nname='shared-name'\nenabled=false\n[[skills.config]]\npath=${JSON.stringify(other)}\nenabled=true\n`);
  const result = sampler().sample();
  assert.equal(result.skills.total, 5);
  assert.equal(result.skills.items.filter(item => item.name === 'shared-name').length, 2);
  assert.equal(result.skills.items.find(item => item.path === other).enabled, true);
  assert.equal(result.skills.items.find(item => item.name === 'shared-name' && item.path !== other).enabled, false);
  assert.equal(result.skills.items.find(item => item.name === 'bundled').enabled, false);
  assert.equal(result.skills.items.find(item => item.name === 'bundled').source, 'system');
  assert.deepEqual(result.skills.items.filter(item => item.source === 'project').map(item => item.name), ['nested', 'project']);
  assert.ok(!JSON.stringify(result).includes('Private instructions'));
}));

test('disabled absolute skill selectors match the canonical target of a symlink', () => fixture(({ home, userHome, write, skill, sampler }) => {
  const file = skill(path.join(home, 'skills', 'shared'), 'shared');
  const alias = path.join(userHome, '.agents', 'skills', 'alias');fs.mkdirSync(path.dirname(alias), { recursive: true });
  fs.symlinkSync(path.dirname(file), alias, process.platform === 'win32' ? 'junction' : 'dir');
  write(path.join(home, 'config.toml'), `[[skills.config]]\npath=${JSON.stringify(file)}\nenabled=false\n`);
  assert.equal(sampler().sample().skills.items[0].enabled, false);
}));

test('plugin inventory requires installation evidence and distinguishes unknown from disabled', () => fixture(({ home, write, skill, sampler }) => {
  write(path.join(home, 'config.toml'), `[plugins."enabled@fixture"]\nenabled=true\n[plugins."enabled@fixture".mcp_servers.remote]\nenabled=false\n[plugins."disabled@fixture"]\nenabled=false\n`);
  const plugin = (name, marker = false) => {
    const base = path.join(home, 'plugins', 'cache', 'fixture', name);
    const version = path.join(base, '1.0.0');
    write(path.join(version, '.codex-plugin', 'plugin.json'), { name, skills: './skills', mcpServers: './.mcp.json' });
    skill(path.join(version, 'skills', 'workflow'), name + '-skill');
    write(path.join(version, '.mcp.json'), { mcpServers: { remote: { url: 'https://user:SECRET@example.test/SECRET?auth=SECRET', headers: { Authorization: 'SECRET' } } } });
    if (marker) write(path.join(base, '.codex-remote-plugin-install.json'), { schema_version: 1, remote_plugin_id: 'fixture-' + name });
    return base;
  };
  plugin('enabled');plugin('disabled');plugin('unknown', true);plugin('stale-cache');
  const ambiguous = plugin('ambiguous', true);
  write(path.join(ambiguous, '2.0.0', '.codex-plugin', 'plugin.json'), { name: 'ambiguous', skills: './skills' });
  skill(path.join(ambiguous, '2.0.0', 'skills', 'workflow'), 'ambiguous-skill');
  const result = sampler().sample();
  assert.deepEqual(result.skills.items.map(item => [item.name, item.enabled]), [['disabled-skill', false], ['enabled-skill', true], ['unknown-skill', null]]);
  assert.equal(result.skills.unknown, 1);
  assert.equal(result.coverage.unverifiedPlugins, 1);
  assert.equal(result.coverage.ambiguousPluginVersions, 1);
  assert.equal(result.mcp.total, 2);
  assert.ok(result.mcp.items.every(item => item.enabled === false));
  assert.ok(!JSON.stringify(result).includes('SECRET'));
}));

test('plugin MCP limits disclose truncation for inline and file manifests without exposing server values', () => fixture(({ home, write, sampler }) => {
  write(path.join(home, 'config.toml'), '[plugins."bounded@fixture"]\nenabled=true\n');
  const root = path.join(home, 'plugins', 'cache', 'fixture', 'bounded', '1.0.0');
  for (const inline of [true, false]) for (const count of [256, 257]) {
    const servers = Object.fromEntries(Array.from({ length: count }, (_, index) => ['server-' + index, { command: 'SECRET-COMMAND', args: ['SECRET-ARG'], env: { API_KEY: 'SECRET-ENV' } }]));
    write(path.join(root, '.codex-plugin', 'plugin.json'), { name: 'bounded', mcpServers: inline ? { mcpServers: servers } : './.mcp.json' });
    if (!inline) write(path.join(root, '.mcp.json'), { mcpServers: servers });
    const result = sampler().sample();
    assert.equal(result.mcp.total, 256);
    assert.equal(result.mcp.items.length, 256);
    assert.equal(result.coverage.truncated, count > 256);
    assert.equal(result.coverage.complete, count === 256);
    assert.ok(!JSON.stringify(result).includes('SECRET'));
  }
}));

test('TTL, forced refresh, rollback and caller mutations do not leave stale installations cached forever', () => fixture(({ home, write, skill, sampler }) => {
  let at = 1000;
  const file = skill(path.join(home, 'skills', 'one'), 'one');
  write(path.join(home, 'config.toml'), '[mcp_servers.first]\ncommand="node"\n');
  const before = fs.readFileSync(file), mtime = fs.statSync(file).mtimeMs;
  const collector = sampler({ now: () => at, ttlMs: 100 });
  const first = collector.sample();first.skills.items[0].name = 'mutated';
  skill(path.join(home, 'skills', 'two'), 'two');
  assert.equal(collector.sample().skills.total, 1);
  assert.equal(collector.sample().skills.items[0].name, 'one');
  assert.equal(collector.sample({ force: true }).skills.total, 2);
  fs.rmSync(path.join(home, 'skills', 'two'), { recursive: true });at = 900;
  assert.equal(collector.sample().skills.total, 1);
  at = 1101;skill(path.join(home, 'skills', 'three'), 'three');
  assert.equal(collector.sample().skills.total, 2);
  assert.deepEqual(fs.readFileSync(file), before);assert.equal(fs.statSync(file).mtimeMs, mtime);
  collector.close();assert.equal(collector.sample().available, false);
}));

test('plugin component symlinks cannot turn unrelated directories into installed plugin skills or MCPs', () => fixture(({ directory, home, write, skill, sampler }) => {
  write(path.join(home, 'config.toml'), '[plugins."escape@fixture"]\nenabled=true\n');
  const root = path.join(home, 'plugins', 'cache', 'fixture', 'escape', '1.0.0');
  write(path.join(root, '.codex-plugin', 'plugin.json'), { name: 'escape', skills: './skills', mcpServers: './external/mcp.json' });
  const outside = path.join(directory, 'unrelated');skill(path.join(outside, 'skill'), 'not-installed');
  write(path.join(outside, 'mcp.json'), { mcpServers: { secret: { command: 'SECRET-COMMAND' } } });
  fs.symlinkSync(outside, path.join(root, 'skills'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.symlinkSync(outside, path.join(root, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = sampler().sample();
  assert.equal(result.skills.total, 0);assert.equal(result.mcp.total, 0);
  assert.equal(result.coverage.complete, false);
  assert.ok(!JSON.stringify(result).includes('SECRET'));
}));

test('plugin skill recursion rejects nested directory symlinks outside the real plugin root', () => fixture(({ directory, home, write, skill, sampler }) => {
  write(path.join(home, 'config.toml'), '[plugins."nested@fixture"]\nenabled=true\n');
  const root = path.join(home, 'plugins', 'cache', 'fixture', 'nested', '1.0.0');
  write(path.join(root, '.codex-plugin', 'plugin.json'), { name: 'nested', skills: './skills' });
  const insideSkill = path.dirname(skill(path.join(root, 'skills', 'inside'), 'inside'));
  const outside = path.join(directory, 'unrelated');skill(path.join(outside, 'private'), 'not-installed');
  fs.symlinkSync(outside, path.join(insideSkill, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.symlinkSync(insideSkill, path.join(root, 'skills', 'internal-alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const opened = [];
  const result = sampler({ fileSystem: { ...fs, openSync: (filename, ...args) => {
    opened.push(fs.realpathSync(filename));return fs.openSync(filename, ...args);
  } } }).sample();
  assert.deepEqual(result.skills.items.map(item => item.name), ['inside']);
  assert.equal(result.coverage.complete, false);
  assert.ok(opened.every(filename => !filename.startsWith(outside + path.sep)), 'out-of-root metadata is never opened');
}));

test('plugin skill files cannot symlink outside the plugin while ordinary user skill links remain supported', () => fixture(({ directory, home, userHome, write, skill, sampler }) => {
  write(path.join(home, 'config.toml'), '[plugins."file-link@fixture"]\nenabled=true\n');
  const root = path.join(home, 'plugins', 'cache', 'fixture', 'file-link', '1.0.0');
  write(path.join(root, '.codex-plugin', 'plugin.json'), { name: 'file-link', skills: './skills' });
  const outsideFile = skill(path.join(directory, 'outside'), 'outside');
  const linkedFile = path.join(root, 'skills', 'linked', 'SKILL.md');
  fs.mkdirSync(path.dirname(linkedFile), { recursive: true });
  let fileSystem = fs;
  if (process.platform === 'win32') {
    write(linkedFile, '---\nname: simulated-link\ndescription: fixture\n---\n');
    fileSystem = { ...fs, realpathSync: filename => path.resolve(filename) === linkedFile ? outsideFile : fs.realpathSync(filename) };
  } else fs.symlinkSync(outsideFile, linkedFile, 'file');
  const userAlias = path.join(userHome, '.agents', 'skills', 'user-link');fs.mkdirSync(path.dirname(userAlias), { recursive: true });
  fs.symlinkSync(path.dirname(outsideFile), userAlias, process.platform === 'win32' ? 'junction' : 'dir');
  const result = sampler({ fileSystem }).sample();
  assert.equal(result.skills.total, 1);
  assert.equal(result.skills.items[0].name, 'outside');
  assert.deepEqual(result.skills.items[0].sources, ['user'], 'blocked plugin paths cannot add a plugin attribution to a user skill');
  assert.equal(result.coverage.complete, false);
}));

test('unreadable configuration and exhausted scan limits do not appear as verified empty inventories', () => fixture(({ home, write, skill, sampler }) => {
  write(path.join(home, 'config.toml'), '[mcp_servers.private]\ncommand="SECRET"\n');
  skill(path.join(home, 'skills', 'installed'), 'installed');
  const denied = sampler({ fileSystem: { ...fs, openSync: () => { const error = new Error('SECRET');error.code = 'EACCES';throw error; } } }).sample();
  assert.equal(denied.mcp.available, false);assert.equal(denied.mcp.total, null);
  assert.equal(denied.skills.available, false);assert.equal(denied.skills.total, null);
  const bounded = sampler({ maxFiles: 0 }).sample();
  assert.equal(bounded.coverage.truncated, true);assert.equal(bounded.mcp.total, null);assert.equal(bounded.skills.total, null);
  assert.ok(!JSON.stringify(denied).includes('SECRET'));
}));

test('absent, malformed and bounded sources remain distinguishable without creating files', () => fixture(({ directory, home, userHome, write, skill, sampler }) => {
  const missing = createCapabilityInventorySampler({ home: path.join(directory, 'missing'), userHome: path.join(directory, 'missing-user'), cwd: path.join(directory, 'missing-repo'), adminRoots: [] }).sample();
  assert.equal(missing.available, false);assert.equal(missing.skills.total, null);assert.equal(missing.mcp.total, null);
  assert.equal(fs.existsSync(path.join(directory, 'missing')), false);
  write(path.join(home, 'skills', 'invalid', 'SKILL.md'), '---\nname: no-description\n---\n');
  skill(path.join(home, 'skills', 'valid'), 'valid');
  const invalid = sampler().sample();assert.equal(invalid.coverage.invalidSkills, 1);assert.equal(invalid.skills.total, 1);
  const bounded = sampler({ maxEntries: 1 }).sample();assert.equal(bounded.coverage.truncated, true);assert.equal(bounded.coverage.complete, false);
  const denied = sampler({ fileSystem: { ...fs, opendirSync: () => { const error = new Error('PRIVATE');error.code = 'EACCES';throw error; } } }).sample();
  assert.ok(denied.coverage.unreadable > 0);assert.ok(!JSON.stringify(denied).includes('PRIVATE'));
}));

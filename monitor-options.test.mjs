import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { parseOptions, reduceKey, splitKeys, createKeyDecoder, commandArgs, VIEW_NAMES, getViewNames } from './monitor-options.mjs';
import { withLocale } from './i18n.mjs';

test('options preserve defaults and validate bounded configurable views/windows', () => {
  assert.equal(parseOptions([]).windowSeconds, 80);
  assert.equal(parseOptions(['-i', '3']).windowSeconds, 240);
  const result = parseOptions(['-w', '--view=tasks', '--window', '120', '--interface', 'en7', '--threads', '12', '--no-probes', '--json']);
  assert.equal(result.view, 'tasks'); assert.equal(result.windowSeconds, 120);
  assert.equal(result.interfaceName, 'en7'); assert.equal(result.threads, 12);
  assert.ok(result.watch && result.noProbes && result.json);
  for (const args of [['--window', '-1'], ['-i', '0'], ['--threads', 'NaN'], ['--window', '1e12'], ['--view', 'oops'], ['--view', 'toString'], ['--bad'], ['--interface']]) {
    assert.throws(() => parseOptions(args));
  }
});

test('language options accept canonical names and common system locale aliases', () => {
  const aliases = {
    'zh-CN': 'zh-CN', 'zh-Hans': 'zh-CN', 'zh_Hans_CN.UTF-8': 'zh-CN',
    'zh-TW': 'zh-TW', 'zh-Hant': 'zh-TW', 'zh-HK': 'zh-TW', 'zh_TW.UTF-8': 'zh-TW',
    en: 'en', 'en_US.UTF-8': 'en', ja: 'ja', 'ja_JP.UTF-8': 'ja',
  };
  for (const [name, expected] of Object.entries(aliases)) {
    assert.equal(parseOptions(['--lang', name], { env: {} }).lang, expected, name);
    assert.equal(parseOptions(['--lang=' + name], { env: {} }).lang, expected, name);
  }
  assert.equal(parseOptions(['--language=en'], { env: { LANG: 'zh-CN' } }).lang, 'en');
  assert.equal(parseOptions(['--lang=zh-TW', '--lang=en'], { env: {} }).lang, 'en');
  assert.equal(parseOptions([], { env: {} }).lang, 'en');
  assert.equal(parseOptions(['--lang=auto'], { env: { LANG: 'ja_JP.UTF-8' } }).lang, 'ja');
});

test('automatic language detection respects environment precedence and explicit overrides', () => {
  const env = { CODEX_MONITOR_LANG: 'ja', LC_ALL: 'en_US.UTF-8', LC_MESSAGES: 'zh-TW', LANG: 'zh-CN' };
  assert.equal(parseOptions([], { env }).lang, 'ja');
  assert.equal(parseOptions([], { env: { ...env, CODEX_MONITOR_LANG: '' } }).lang, 'en');
  assert.equal(parseOptions([], { env: { LC_MESSAGES: 'zh-TW', LANG: 'zh-CN' } }).lang, 'zh-TW');
  assert.equal(parseOptions([], { env: { LANG: 'zh_CN.UTF-8' } }).lang, 'zh-CN');
  assert.equal(parseOptions(['--lang=en'], { env }).lang, 'en');
  assert.equal(parseOptions([], { env: { LC_ALL: 'de_DE.UTF-8', LANG: 'zh-CN' } }).lang, 'en');
  assert.equal(parseOptions([], { env: { CODEX_MONITOR_LANG: 'auto', LANG: 'zh-TW' } }).lang, 'zh-TW');
});

test('language selection precedes validation and localizes option errors', () => {
  assert.throws(() => parseOptions(['--bad', '--lang=en'], { env: { LANG: 'zh-CN' } }), /^Error: Unknown option: --bad$/);
  assert.throws(() => parseOptions(['--interface', '--lang=en'], { env: { LANG: 'zh-CN' } }), /缺少参数/);
  assert.throws(() => parseOptions(['--lang=en', '--interface'], { env: {} }), /--interface requires a value/);
  assert.throws(() => parseOptions(['--view=bad', '--lang=zh-TW'], { env: {} }), /--view 可選/);
  assert.throws(() => parseOptions(['--threads=31', '--lang=ja'], { env: {} }), /threads は 1〜30 の整数/);
  assert.throws(() => parseOptions(['--window=1', '--lang=en'], { env: {} }), /windowSeconds must be an integer from 10 to 3600/);
  assert.throws(() => parseOptions(['--lang=de'], { env: {} }), /^RangeError: Unsupported language: de/);
  assert.throws(() => parseOptions(['--lang=de'], { env: { LANG: 'zh-TW' } }), /不支援的語言：de/);
  for (const args of [['--lang'], ['--lang='], ['--lang', '--once'], ['--lang', '-w']]) {
    assert.throws(() => parseOptions(args, { env: {} }), /--lang requires a value/);
  }
  for (const args of [['--bad', '--lang=en'], ['--interface', '--lang=en'], ['--window=1'], ['--view=bad'], ['--lang=de']]) {
    assert.throws(() => parseOptions(args, { env: { LANG: 'zh_TW.UTF-8' } }), error => {
      assert.equal(error.locale, args[0] === '--bad' ? 'en' : 'zh-TW');
      return true;
    });
  }
});

test('language tokens remain option values and installed-command watch defaults are preserved', () => {
  const args = ['--lang', 'en', '--metrics-db', '/tmp/--lang=ja.sqlite', '--interface', 'en7'];
  const result = parseOptions(commandArgs(args), { env: { LANG: 'zh-CN' } });
  assert.equal(result.lang, 'en');
  assert.equal(result.metricsDb, '/tmp/--lang=ja.sqlite');
  assert.equal(result.interfaceName, 'en7');
  assert.equal(result.watch, true);
  assert.equal(parseOptions(commandArgs(['--lang=en', '--once']), { env: {} }).watch, false);
  assert.equal(parseOptions(commandArgs(['--lang=en', '--json']), { env: {} }).watch, false);
});

test('localized view names preserve stable view keys and legacy Chinese labels', () => {
  assert.deepEqual(getViewNames('en'), { overview: 'Overview', host: 'Host', tasks: 'Tasks', diagnostics: 'Diagnostics' });
  assert.equal(getViewNames('zh-TW').overview, '總覽');
  assert.equal(getViewNames('ja').tasks, 'タスク');
  assert.equal(withLocale('en', () => getViewNames().host), 'Host');
  assert.deepEqual(VIEW_NAMES, { overview: '总览', host: '主机', tasks: '任务', diagnostics: '诊断' });
});

test('CLI reports unknown flags in a later explicit language before sampling', () => {
  const result = spawnSync(process.execPath, ['codex-status.mjs', '--bad', '--lang', 'en'], {
    cwd: new URL('.', import.meta.url), encoding: 'utf8', env: { ...process.env, CODEX_MONITOR_LANG: 'zh-CN', LANG: 'zh_CN.UTF-8' }, timeout: 10000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr.split('\n')[0], /^Unknown option: --bad$/);
  assert.match(result.stderr, /Use --help for usage/);
  assert.doesNotMatch(result.stderr, /[\u3400-\u9fff]/);
  assert.equal(result.stdout, '');
});

test('fragmented escape sequences never become window shortcut keys', () => {
  const decode = createKeyDecoder();
  assert.deepEqual(decode('\x1b'), []);
  assert.deepEqual(decode('['), []);
  assert.deepEqual(decode('A'), ['\x1b[A']);
  assert.deepEqual(decode('\x1b[5'), []);
  assert.deepEqual(decode('~q'), ['\x1b[5~', 'q']);
  assert.deepEqual(decode('['), ['[']);
});

test('the installed one-word command starts watch mode while help, once and JSON remain bounded', () => {
  assert.equal(parseOptions(commandArgs([])).watch, true);
  assert.equal(parseOptions(commandArgs([])).interval, 1);
  assert.equal(parseOptions(commandArgs(['--view', 'tasks'])).watch, true);
  assert.equal(parseOptions(commandArgs(['--no-probes'])).watch, true);
  assert.equal(parseOptions(commandArgs(['--once'])).watch, false);
  assert.equal(parseOptions(commandArgs(['--once', '-w'])).watch, false);
  assert.equal(parseOptions(commandArgs(['--json'])).watch, false);
  assert.equal(parseOptions(commandArgs(['--json', '-w'])).watch, true);
  assert.equal(parseOptions(commandArgs(['--help'])).help, true);
  assert.equal(parseOptions(commandArgs(['--help'])).watch, false);
});

test('keyboard changes views, pauses and scrolls without mutating input state', () => {
  const state = { view: 'overview', paused: false, leftOffset: 0, windowSeconds: 80 };
  assert.equal(reduceKey(state, '3').view, 'tasks');
  assert.equal(reduceKey(state, ' ').paused, true);
  assert.equal(reduceKey(state, '\x1b[A').leftOffset, 0);
  assert.equal(reduceKey(state, '\x1b[6~', 30).leftOffset, 30);
  assert.equal(reduceKey(state, ']').windowSeconds, 160);
  assert.equal(reduceKey({ ...state, windowSeconds: 3600 }, ']').windowSeconds, 3600);
  assert.equal(reduceKey({ ...state, windowSeconds: 10 }, '[').windowSeconds, 10);
  assert.equal(reduceKey(state, 'r').refreshRequested, true);
  assert.equal(reduceKey(state, 'q').quit, true);
  assert.equal(reduceKey({ ...state, leftOffset: 50 }, 'h').leftOffset, 0);
  assert.equal(state.paused, false);
  assert.equal(state.view, 'overview');
  assert.deepEqual(splitKeys('2\x1b[Bq'), ['2', '\x1b[B', 'q']);
});

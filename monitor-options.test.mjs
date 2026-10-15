import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOptions, reduceKey, splitKeys, createKeyDecoder, commandArgs } from './monitor-options.mjs';

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

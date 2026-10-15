import assert from 'node:assert/strict';
import test from 'node:test';
import { createBackgroundProbes } from './background-probes.mjs';

test('slow probes are single flight and retain the last completed result while refreshing', async () => {
  let complete, calls = 0, at = 0;
  const controller = createBackgroundProbes({ now: () => at, sample: () => { calls++; return new Promise(resolve => { complete = resolve; }); } });
  const first = controller.refresh({});
  assert.equal(controller.getState().sampling, true);
  assert.equal(controller.getState().result, null);
  await Promise.resolve();
  assert.equal(controller.refresh({}, { force: true }), first);
  assert.equal(calls, 1);
  complete({ publicIp: '192.0.2.5' }); await first;
  assert.equal(controller.getState().result.publicIp, '192.0.2.5');
  await controller.refresh({}); assert.equal(calls, 1);
  at = 60_001;
  const second = controller.refresh({}); await Promise.resolve();
  assert.equal(controller.getState().sampling, true);
  assert.equal(controller.getState().result.publicIp, '192.0.2.5');
  complete({ publicIp: '192.0.2.6' }); await second;
  assert.equal(calls, 2);
  controller.close();
});

test('configuration changes and explicit refresh invalidate the cache without stacking work', async () => {
  let calls = 0;
  const forces = [];
  const controller = createBackgroundProbes({ sample: async (_, flags) => { forces.push(flags.force); return ++calls; } });
  await controller.refresh({}, { key: 'direct' });
  await controller.refresh({}, { key: 'proxy' });
  await controller.refresh({}, { key: 'proxy', force: true });
  assert.equal(calls, 3);
  assert.deepEqual(forces, [false, true, true]);
  controller.close();
});

test('disabled probes make no requests; failures do not leak errors or become successful zero latency', async () => {
  let calls = 0;
  const disabled = createBackgroundProbes({ enabled: false, sample: async () => { calls++; } });
  await disabled.refresh({}); assert.equal(calls, 0); assert.equal(disabled.getState().disabled, true);
  const failed = createBackgroundProbes({ sample: async () => { throw new Error('password=secret'); } });
  await failed.refresh({});
  assert.equal(failed.getState().result, null);
  assert.equal(failed.getState().error, 'unavailable');
  assert.ok(!JSON.stringify(failed.getState()).includes('secret'));
  failed.close(); disabled.close();
});

test('closing cancels work and never publishes a late result or starts another request', async () => {
  let resolve, calls = 0, cancelled = 0, updates = 0;
  const controller = createBackgroundProbes({ sample: () => { calls++; return new Promise(done => { resolve = done; }); }, cancel: () => cancelled++, onUpdate: () => updates++ });
  const pending = controller.refresh({}); await Promise.resolve();
  controller.close();
  const stoppedUpdates = updates;
  resolve({ result: 'late' }); await pending;
  await controller.refresh({}, { force: true });
  assert.equal(controller.getState().result, null);
  assert.equal(calls, 1); assert.equal(cancelled, 1); assert.equal(updates, stoppedUpdates);
});

test('closing before the queued microtask prevents the request from starting', async () => {
  let calls = 0;
  const controller = createBackgroundProbes({ sample: async () => ++calls });
  const pending = controller.refresh({});
  controller.close(); await pending;
  assert.equal(calls, 0);
});

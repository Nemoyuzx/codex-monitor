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
  assert.equal(controller.refresh({}), first);
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

test('an explicit refresh during a flight queues one forced sample with the latest input', async () => {
  const requests = [];
  let active = 0, peak = 0;
  const controller = createBackgroundProbes({ sample: (input, flags) => {
    const deferred = Promise.withResolvers();
    requests.push({ input, flags, ...deferred });
    peak = Math.max(peak, ++active);
    return deferred.promise.finally(() => active--);
  } });
  const first = controller.refresh({ version: 1 }, { key: 'direct' });
  await Promise.resolve();
  assert.equal(controller.refresh({ version: 2 }, { key: 'direct', force: true }), first);
  assert.equal(controller.refresh({ version: 3 }, { key: 'direct', force: true }), first);
  assert.equal(controller.refresh({ version: 4 }, { key: 'direct' }), first);
  assert.equal(requests.length, 1);
  requests[0].resolve('old');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].input, { version: 4 });
  assert.deepEqual(requests[1].flags, { force: true });
  assert.equal(controller.getState().sampling, true);
  assert.equal(controller.getState().result, 'old');
  requests[1].resolve('new');
  assert.equal(await first, 'new');
  await controller.refresh({}, { key: 'direct' });
  assert.equal(requests.length, 2);
  assert.equal(peak, 1);
  controller.close();
});

test('configuration churn coalesces to the latest key without caching an old result as the new key', async () => {
  const requests = [];
  const controller = createBackgroundProbes({ sample: (input, flags) => {
    const deferred = Promise.withResolvers(); requests.push({ input, flags, ...deferred }); return deferred.promise;
  } });
  const first = controller.refresh('initial', { key: 'a' }); await Promise.resolve();
  controller.refresh('obsolete b', { key: 'b' });
  controller.refresh('obsolete c', { key: 'c' });
  controller.refresh('latest d', { key: 'd' });
  for (let i = 0; i < 25; i++) controller.refresh('latest d', { key: 'd' });
  requests[0].resolve('result a'); await Promise.resolve();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].input, 'latest d');
  assert.deepEqual(requests[1].flags, { force: true });
  assert.equal(controller.getState().result, 'result a');
  assert.equal(controller.getState().sampling, true);
  controller.refresh('same d', { key: 'd' });
  requests[1].resolve('result d'); await first;
  await controller.refresh('cached d', { key: 'd' });
  assert.equal(requests.length, 2);
  const changedBack = controller.refresh('new a', { key: 'a' }); await Promise.resolve();
  assert.equal(requests.length, 3);
  assert.equal(requests[2].input, 'new a');
  requests[2].resolve('fresh result a'); await changedBack;
  controller.close();
});

test('a configuration reverted during a flight needs no queued ordinary sample', async () => {
  let complete, calls = 0;
  const controller = createBackgroundProbes({ sample: () => {
    calls++; return new Promise(resolve => { complete = resolve; });
  } });
  const first = controller.refresh({}, { key: 'a' }); await Promise.resolve();
  controller.refresh({}, { key: 'b' });
  controller.refresh({}, { key: 'a' });
  complete('result a'); await first;
  assert.equal(calls, 1);
  assert.equal(controller.getState().sampling, false);
  controller.close();
});

test('a failed flight still runs one queued retry and caches only its completed result', async () => {
  const requests = [];
  const controller = createBackgroundProbes({ sample: (input, flags) => {
    const deferred = Promise.withResolvers(); requests.push({ input, flags, ...deferred }); return deferred.promise;
  } });
  const first = controller.refresh({}, { key: 'a' }); await Promise.resolve();
  controller.refresh({}, { key: 'a', force: true });
  requests[0].reject(new Error('credential=secret')); await Promise.resolve();
  assert.equal(requests.length, 2);
  assert.equal(controller.getState().sampling, true);
  assert.equal(controller.getState().result, null);
  assert.equal(controller.getState().error, 'unavailable');
  assert.doesNotMatch(JSON.stringify(controller.getState()), /secret/);
  requests[1].resolve('recovered'); await first;
  assert.equal(controller.getState().error, null);
  assert.equal(controller.getState().result, 'recovered');
  await controller.refresh({}, { key: 'a' });
  assert.equal(requests.length, 2);
  controller.close();
});

test('a refresh queued by the final publication microtask is never stranded or cleared by the old flight', async () => {
  const requests = [], secondGate = Promise.withResolvers();
  let controller, followup, requested = false, active = 0, peak = 0;
  controller = createBackgroundProbes({
    sample: async (input, flags) => {
      requests.push({ input, flags }); peak = Math.max(peak, ++active);
      try {
        if (input === 'b') await secondGate.promise;
        return input;
      } finally { active--; }
    },
    onUpdate: state => {
      if (!state.sampling && state.result === 'a' && !requested) {
        requested = true;
        queueMicrotask(() => { followup = controller.refresh('b', { key: 'b', force: true }); });
      }
    },
  });
  const first = controller.refresh('a', { key: 'a' });
  assert.equal(await first, 'a');
  assert.deepEqual(requests.map(request => request.input), ['a', 'b']);
  assert.equal(controller.getState().sampling, true);
  // The completed flight must not clear the newer flight's pending promise.
  assert.equal(controller.refresh('c', { key: 'c', force: true }), followup);
  assert.equal(requests.length, 2);
  secondGate.resolve();
  assert.equal(await followup, 'c');
  assert.deepEqual(requests, [
    { input: 'a', flags: { force: false } },
    { input: 'b', flags: { force: true } },
    { input: 'c', flags: { force: true } },
  ]);
  assert.equal(peak, 1);
  assert.equal(controller.getState().sampling, false);
  controller.close();
});

test('closing in the completion microtask prevents its replacement flight from starting', async () => {
  let controller, followup, calls = 0, requested = false;
  controller = createBackgroundProbes({ sample: async input => { calls++; return input; }, onUpdate: state => {
    if (!state.sampling && state.result === 'a' && !requested) {
      requested = true;
      queueMicrotask(() => {
        followup = controller.refresh('b', { key: 'b', force: true });
        controller.close();
      });
    }
  } });
  await controller.refresh('a', { key: 'a' });
  await followup;
  assert.equal(calls, 1);
  assert.equal(controller.getState().result, 'a');
  assert.equal(controller.getState().sampling, false);
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

test('closing discards a queued refresh and suppresses its late result', async () => {
  let complete, calls = 0, cancelled = 0, updates = 0;
  const controller = createBackgroundProbes({ sample: () => {
    calls++; return new Promise(resolve => { complete = resolve; });
  }, cancel: () => cancelled++, onUpdate: () => updates++ });
  const first = controller.refresh({}, { key: 'a' }); await Promise.resolve();
  controller.refresh({}, { key: 'b', force: true });
  controller.close(); const stoppedUpdates = updates;
  complete('late'); await first;
  await controller.refresh({}, { key: 'b', force: true });
  assert.equal(calls, 1);
  assert.equal(cancelled, 1);
  assert.equal(updates, stoppedUpdates);
  assert.equal(controller.getState().sampling, false);
  assert.equal(controller.getState().result, null);
});

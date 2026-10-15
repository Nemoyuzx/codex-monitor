// Keep bounded network work off the dashboard's sampling/render loop.
export function createBackgroundProbes({ sample, cancel = () => {}, now = Date.now, ttlMs = 60_000,
  enabled = true, onUpdate = () => {} }) {
  let state = { result: null, sampling: false, disabled: !enabled, sampledAt: null, error: null };
  let pending = null, stopped = false, lastKey = null;
  const publish = () => { if (!stopped) onUpdate(state); };
  return {
    getState() { return state; },
    refresh(input, { force = false, key = '' } = {}) {
      if (stopped || !enabled) return Promise.resolve(state.result);
      if (pending) return pending;
      const current = now();
      if (!force && lastKey === key && state.sampledAt != null && current >= state.sampledAt && current - state.sampledAt < ttlMs) return Promise.resolve(state.result);
      const changed = lastKey !== null && lastKey !== key;
      lastKey = key;
      state = { ...state, sampling: true, error: null };
      publish();
      pending = Promise.resolve().then(() => stopped ? null : sample(input, { force: force || changed })).then(result => {
        if (!stopped) state = { result, sampling: false, disabled: false, sampledAt: now(), error: null };
        return result;
      }, () => {
        // Never forward subprocess errors or proxy credentials to UI/JSON.
        if (!stopped) state = { result: null, sampling: false, disabled: false, sampledAt: now(), error: 'unavailable' };
        return null;
      }).finally(() => { pending = null; publish(); });
      return pending;
    },
    close() {
      stopped = true;
      state = { ...state, sampling: false };
      try { cancel(); } catch {}
    },
  };
}

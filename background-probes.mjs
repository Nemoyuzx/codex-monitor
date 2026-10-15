// Keep bounded network work off the dashboard's sampling/render loop.
export function createBackgroundProbes({ sample, cancel = () => {}, now = Date.now, ttlMs = 60_000,
  enabled = true, onUpdate = () => {} }) {
  let state = { result: null, sampling: false, disabled: !enabled, sampledAt: null, error: null };
  let pending = null, stopped = false, lastKey = null, activeKey = null, queued = null;
  const publish = () => { if (!stopped) onUpdate(state); };
  const finish = flight => {
    if (pending !== flight) return;
    pending = null; activeKey = null;
  };
  const collect = async (initial, flight) => {
    let request = initial, result = state.result;
    try {
      while (request && !stopped) {
        activeKey = request.key;
        const changed = lastKey !== null && lastKey !== request.key;
        let error = null;
        try { result = await sample(request.input, { force: request.force || changed }); }
        catch {
          // Never forward subprocess errors or proxy credentials to UI/JSON.
          result = null; error = 'unavailable';
        }
        if (stopped) break;
        lastKey = request.key;
        request = queued; queued = null;
        if (request) activeKey = request.key;
        // Release the flight before announcing completion. A synchronous or
        // microtask refresh from onUpdate must start work instead of being stranded.
        else finish(flight);
        state = { result, sampling: !!request, disabled: false, sampledAt: now(), error };
        publish();
      }
    } finally { finish(flight); }
    return result;
  };
  return {
    getState() { return state; },
    refresh(input, { force = false, key = '' } = {}) {
      if (stopped || !enabled) return Promise.resolve(state.result);
      if (pending) {
        // Coalesce refreshes to one latest input, retaining an explicit refresh.
        // Reverting to the active configuration needs no second ordinary sample.
        if (force || key !== activeKey || queued) {
          const forced = force || queued?.force || false;
          queued = key === activeKey && !forced ? null : { input, key, force: forced };
        }
        return pending;
      }
      const current = now();
      if (!force && lastKey === key && state.sampledAt != null && current >= state.sampledAt && current - state.sampledAt < ttlMs) return Promise.resolve(state.result);
      activeKey = key;
      state = { ...state, sampling: true, error: null };
      const flight = Promise.resolve().then(() => collect({ input, key, force }, flight));
      pending = flight;
      publish();
      return pending;
    },
    close() {
      stopped = true;
      queued = null;
      state = { ...state, sampling: false };
      try { cancel(); } catch {}
    },
  };
}

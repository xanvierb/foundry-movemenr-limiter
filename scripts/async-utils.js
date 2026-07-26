const DEFAULT_TIMER_SLICE_MS = 250;

export function monotonicNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

/**
 * Wait until an absolute monotonic deadline.
 *
 * Recomputing the remaining time after every wake-up is important in inactive
 * browser tabs, where a requested 250 ms timer can be clamped to a full second.
 */
export async function delayUntil(
  deadlineMs,
  {
    signal = null,
    now = monotonicNow,
    sleep = (durationMs) =>
      new Promise((resolve) => globalThis.setTimeout(resolve, durationMs)),
    sliceMs = DEFAULT_TIMER_SLICE_MS
  } = {}
) {
  const deadline = Number(deadlineMs) || 0;
  const maximumSlice = Math.max(1, Number(sliceMs) || DEFAULT_TIMER_SLICE_MS);
  while (!signal?.aborted) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) return "elapsed";
    const durationMs = Math.min(remainingMs, maximumSlice);
    if (!signal) {
      await sleep(durationMs);
      continue;
    }

    let onAbort;
    const aborted = new Promise((resolve) => {
      if (signal.aborted) {
        resolve(true);
        return;
      }
      onAbort = () => resolve(true);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    const didAbort = await Promise.race([
      Promise.resolve(sleep(durationMs)).then(() => false),
      aborted
    ]);
    if (onAbort) signal.removeEventListener("abort", onAbort);
    if (didAbort) return "aborted";
  }
  return "aborted";
}

/**
 * Observe a promise without allowing it to hold a movement lock forever.
 * The original promise remains safely observed if it settles after the timeout.
 */
export async function settleWithin(promise, timeoutMs, { signal = null } = {}) {
  const observed = Promise.resolve(promise).then(
    (value) => ({ status: "fulfilled", value }),
    (error) => ({ status: "rejected", error })
  );

  let timeout;
  let onAbort;
  const timeoutPromise = new Promise((resolve) => {
    timeout = globalThis.setTimeout(
      () => resolve({ status: "timeout" }),
      Math.max(0, Number(timeoutMs) || 0)
    );
  });
  const abortPromise = new Promise((resolve) => {
    if (!signal) return;
    if (signal.aborted) {
      resolve({ status: "aborted", reason: signal.reason });
      return;
    }
    onAbort = () =>
      resolve({ status: "aborted", reason: signal.reason });
    signal.addEventListener("abort", onAbort, { once: true });
  });

  const result = await Promise.race([observed, timeoutPromise, abortPromise]);
  globalThis.clearTimeout(timeout);
  if (onAbort) signal.removeEventListener("abort", onAbort);
  return result;
}

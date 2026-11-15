/** Bound backend work, transferring a released slot directly to the oldest waiter. */
export function createRequestQueue(limit) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Request limit must be a positive integer.');
  let active = 0;
  const waiting = [];
  return async function slot(fn) {
    if (active >= limit) await new Promise(resolve => waiting.push(resolve));
    else active++;
    try { return await fn(); }
    finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

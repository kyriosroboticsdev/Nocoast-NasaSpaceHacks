import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestQueue } from '../src/dashboard/requests.mjs';
import { gameScore } from '../src/dashboard/game.js';

test('backend request queue bounds bursts and preserves the selected-site-first order', async () => {
  const slot = createRequestQueue(2), started = [];
  let active = 0, peak = 0;
  const jobs = Array.from({ length: 12 }, (_, i) => slot(async () => {
    started.push(i); peak = Math.max(peak, ++active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return i;
  }));
  assert.deepEqual(await Promise.all(jobs), Array.from({ length: 12 }, (_, i) => i));
  assert.equal(peak, 2);
  assert.deepEqual(started, Array.from({ length: 12 }, (_, i) => i));
});

test('failed backend requests release their slot for queued work', async () => {
  const slot = createRequestQueue(1);
  const failed = slot(async () => { throw new Error('backend unavailable'); });
  const next = slot(async () => 'recovered');
  await assert.rejects(failed, /backend unavailable/);
  assert.equal(await next, 'recovered');
});

test('a newly submitted request cannot steal a slot reserved for a waiting request', async () => {
  const slot = createRequestQueue(1), started = [];
  let release;
  const first = slot(() => new Promise(resolve => { release = resolve; }));
  const second = slot(async () => { started.push(2); });
  release();
  const third = first.then(() => slot(async () => { started.push(3); }));
  await Promise.all([first, second, third]);
  assert.deepEqual(started, [2, 3]);
});

test('mission game does not turn pending terrain validation into a mission-ready grade', () => {
  const score = gameScore({ mission: { viability: { score: 100 } }, verdict: 'preliminary', capacityWh: 0 });
  assert.equal(score.total, null);
});

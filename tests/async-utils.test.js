import assert from "node:assert/strict";
import test from "node:test";

import { delayUntil, settleWithin } from "../scripts/async-utils.js";

test("deadline waiting does not stack browser timer clamping", async () => {
  let now = 0;
  let sleeps = 0;
  const result = await delayUntil(1000, {
    now: () => now,
    sleep: async () => {
      sleeps += 1;
      // Simulate a background browser turning a requested 250 ms timer into
      // one real second.
      now += 1000;
    }
  });

  assert.equal(result, "elapsed");
  assert.equal(sleeps, 1);
  assert.equal(now, 1000);
});

test("deadline waiting exits when movement is aborted", async () => {
  const controller = new AbortController();
  let now = 0;
  const result = await delayUntil(1000, {
    signal: controller.signal,
    now: () => now,
    sleep: async () => {
      now += 250;
      controller.abort("cancelled");
    }
  });

  assert.equal(result, "aborted");
});

test("abort wakes a currently pending timer without waiting for its slice", async () => {
  const controller = new AbortController();
  const waiting = delayUntil(1000, {
    signal: controller.signal,
    now: () => 0,
    sleep: () => new Promise(() => {})
  });

  controller.abort("paused");
  assert.equal(await waiting, "aborted");
});

test("a never-settling promise is bounded", async () => {
  const outcome = await settleWithin(new Promise(() => {}), 5);
  assert.equal(outcome.status, "timeout");
});

test("promise success and failure remain observable", async () => {
  assert.deepEqual(await settleWithin(Promise.resolve(true), 50), {
    status: "fulfilled",
    value: true
  });

  const error = new Error("movement failed");
  const rejected = await settleWithin(Promise.reject(error), 50);
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.error, error);
});

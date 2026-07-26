import assert from "node:assert/strict";
import test from "node:test";

import {
  minimumSegmentDurationMs,
  scheduleSegment,
  splitSegmentByCost
} from "../scripts/path-utils.js";

test("long movement is divided into bounded real position updates", () => {
  const path = splitSegmentByCost(
    { x: 0, y: 0, elevation: 0 },
    { x: 2000, y: 0, elevation: 0, snapped: true },
    20,
    1.5
  );
  assert.equal(path.length, 14);
  assert.deepEqual(path.at(-1), {
    x: 2000,
    y: 0,
    elevation: 0,
    snapped: true
  });
});

test("two squares per second requires at least half a second per square", () => {
  assert.equal(minimumSegmentDurationMs(1, 2), 500);
  assert.equal(minimumSegmentDurationMs(2, 2), 1000);
  assert.equal(minimumSegmentDurationMs(0.5, 0.5), 1000);
});

test("small segments are not slowed by an artificial duration floor", () => {
  assert.equal(minimumSegmentDurationMs(0.1, 20), 5);
});

test("cumulative pacing recovers per-segment execution overhead", () => {
  const costs = Array.from({ length: 6 }, () => 1);
  const speed = 2;
  const overheadMs = 100;
  let now = 0;
  let deadline = 0;

  for (const cost of costs) {
    const timing = scheduleSegment(deadline, cost, speed, now);
    deadline = timing.deadline;
    now += timing.durationMs + overheadMs;
  }

  const idealDurationMs = (costs.length / speed) * 1000;
  assert.equal(now, idealDurationMs + overheadMs);
});

test("a later movement only waits for the unelapsed part of its interval", () => {
  const priorDeadline = 500;
  const timing = scheduleSegment(priorDeadline, 1, 2, 900);

  assert.equal(timing.deadline, 1000);
  assert.equal(timing.durationMs, 100);
});

test("an expired token deadline allows the next movement immediately", () => {
  const timing = scheduleSegment(500, 1, 2, 1200);

  assert.equal(timing.deadline, 1000);
  assert.equal(timing.durationMs, 0);
});

test("five seconds at two squares per second commits no more than eleven boundaries", () => {
  const duration = minimumSegmentDurationMs(1, 2);
  const commitTimes = Array.from({ length: 30 }, (_, index) => index * duration);
  assert.equal(commitTimes.filter((time) => time <= 5000).length, 11);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  minimumSegmentDurationMs,
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

test("five seconds at two squares per second commits no more than eleven boundaries", () => {
  const duration = minimumSegmentDurationMs(1, 2);
  const commitTimes = Array.from({ length: 30 }, (_, index) => index * duration);
  assert.equal(commitTimes.filter((time) => time <= 5000).length, 11);
});

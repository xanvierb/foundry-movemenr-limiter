import assert from "node:assert/strict";
import test from "node:test";

import {
  currentPosition,
  measuredGridSpaces,
  minimumSegmentDurationMs,
  sanitizeWaypoint,
  scheduleSegment,
  splitSegmentByCost
} from "../scripts/path-utils.js";

test("current position uses source coordinates during an animation", () => {
  const token = {
    x: 500,
    y: 500,
    elevation: 20,
    _source: { x: 100, y: 200, elevation: 5, level: "ground" }
  };

  assert.deepEqual(currentPosition(token), {
    x: 100,
    y: 200,
    elevation: 5,
    level: "ground"
  });
});

test("elevation-only movement waypoints are retained", () => {
  assert.deepEqual(sanitizeWaypoint({ elevation: 10, checkpoint: true }), {
    elevation: 10,
    checkpoint: true
  });
});

test("physical spaces take precedence over multiplied movement cost", () => {
  const spaces = measuredGridSpaces(
    { cost: 25, distance: 5, spaces: 1, euclidean: 100 },
    { gridDistance: 5, gridSize: 100 }
  );

  assert.equal(spaces, 1);
  assert.equal(minimumSegmentDurationMs(spaces, 1), 1000);
});

test("scene distance units do not change the number of physical spaces", () => {
  assert.equal(
    measuredGridSpaces(
      { cost: 5, distance: 5, spaces: 1 },
      { gridDistance: 5, gridSize: 100 }
    ),
    1
  );
  assert.equal(
    measuredGridSpaces(
      { cost: 1.5, distance: 1.5, spaces: 1 },
      { gridDistance: 1.5, gridSize: 100 }
    ),
    1
  );
});

test("fractional physical distance is not rounded up to whole spaces", () => {
  assert.equal(
    measuredGridSpaces(
      { cost: 25, distance: 6.25, spaces: 2 },
      { gridDistance: 5, gridSize: 100 }
    ),
    1.25
  );
});

test("gridless measurement falls back to configured pixel grid size", () => {
  assert.equal(
    measuredGridSpaces(
      { spaces: 0, distance: 0, euclidean: 150 },
      { gridless: true, gridSize: 100 }
    ),
    1.5
  );
});

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

test("path splitting refuses to allocate beyond its hard limit", () => {
  assert.equal(
    splitSegmentByCost(
      { x: 0, y: 0 },
      { x: 1000000, y: 0 },
      10000,
      1,
      100
    ),
    null
  );
});

test("configured speed maps directly to one segment time window", () => {
  assert.equal(minimumSegmentDurationMs(1, 1), 1000);
  assert.equal(minimumSegmentDurationMs(1, 2), 500);
  assert.equal(minimumSegmentDurationMs(0.5, 0.5), 1000);
  assert.equal(minimumSegmentDurationMs(0.1, 20), 5);
});

test("cumulative pacing recovers ordinary per-segment overhead", () => {
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

  assert.equal(now, 3100);
});

test("a future or corrupt deadline can never exceed one segment interval", () => {
  const now = 900;
  const intervalMs = minimumSegmentDurationMs(1, 2);

  for (const priorDeadline of [901, 1000, 5000, Number.POSITIVE_INFINITY]) {
    const timing = scheduleSegment(priorDeadline, 1, 2, now);
    assert.ok(timing.durationMs >= 0);
    assert.ok(timing.durationMs <= intervalMs);
  }
});

test("a stale deadline never adds a fresh interval after processing overhead", () => {
  const timing = scheduleSegment(500, 1, 2, 5000);

  assert.equal(timing.deadline, 5000);
  assert.equal(timing.durationMs, 0);
});

test("every segment in a mixed path remains bounded by its own interval", () => {
  const speed = 1;
  const costs = [1.5, 0.1, 1, 0.4];
  let now = 1000;
  let deadline = now;

  for (const cost of costs) {
    const intervalMs = minimumSegmentDurationMs(cost, speed);
    const timing = scheduleSegment(deadline, cost, speed, now);
    assert.ok(timing.durationMs > 0);
    assert.ok(timing.durationMs <= intervalMs);
    deadline = timing.deadline;
    now = deadline;
  }

  assert.equal(now, 4000);
});

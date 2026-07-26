import assert from "node:assert/strict";
import test from "node:test";

import { MovementBucket } from "../scripts/movement-bucket.js";

test("a bucket starts full and never stores more than maximum burst", () => {
  const bucket = new MovementBucket(2, 2, 0);
  bucket.consume(2, 0);
  assert.equal(bucket.snapshot(1000).available, 2);
  assert.equal(bucket.snapshot(10000).available, 2);
});

test("allowance regenerates using real elapsed time", () => {
  const bucket = new MovementBucket(2, 2, 0);
  bucket.consume(2, 0);
  assert.equal(bucket.snapshot(250).available, 0.5);
  assert.equal(bucket.delayFor(1, 250), 250);
  assert.equal(bucket.delayFor(1, 500), 0);
});

test("separate token buckets do not share allowance", () => {
  const tokenA = new MovementBucket(2, 2, 0);
  const tokenB = new MovementBucket(2, 2, 0);
  tokenA.consume(2, 0);
  assert.equal(tokenA.snapshot(0).available, 0);
  assert.equal(tokenB.snapshot(0).available, 2);
});

test("an indivisible segment larger than burst creates repayable debt", () => {
  const bucket = new MovementBucket(2, 0.5, 0);
  assert.equal(bucket.delayFor(1, 0), 0);
  bucket.consume(1, 0);
  assert.equal(bucket.snapshot(0).available, -0.5);
  assert.equal(bucket.delayFor(1, 0), 500);
  assert.equal(bucket.delayFor(1, 500), 0);
});

test("a low burst does not reduce sustained throughput", () => {
  const bucket = new MovementBucket(20, 0.1, 0);
  bucket.consume(1.5, 0);
  assert.equal(bucket.delayFor(1.5, 75), 0);
});

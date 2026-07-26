/**
 * A real-time token bucket measured in grid spaces.
 *
 * A segment can be larger than the configured capacity (for example, a single
 * diagonal when the burst is very small). In that case the segment is treated
 * as indivisible and may create a temporary negative balance. The debt must be
 * regenerated before another segment can start, preserving the long-term rate.
 */
export class MovementBucket {
  constructor(rate, capacity, now = MovementBucket.now()) {
    this.rate = MovementBucket.#positive(rate);
    this.capacity = MovementBucket.#positive(capacity);
    this.tokens = this.capacity;
    this.lastRefill = now;
    this.lastElapsedSeconds = 0;
  }

  static now() {
    return globalThis.performance?.now?.() ?? Date.now();
  }

  configure(rate, capacity, now = MovementBucket.now()) {
    this.refill(now);
    this.rate = MovementBucket.#positive(rate);
    this.capacity = MovementBucket.#positive(capacity);
    this.tokens = Math.min(this.tokens, this.capacity);
  }

  refill(now = MovementBucket.now()) {
    const elapsedMs = Math.max(0, now - this.lastRefill);
    this.lastElapsedSeconds = elapsedMs / 1000;
    this.tokens = Math.min(
      this.capacity,
      this.tokens + this.lastElapsedSeconds * this.rate
    );
    this.lastRefill = now;
    return this.tokens;
  }

  delayFor(cost, now = MovementBucket.now()) {
    const normalizedCost = Math.max(0, Number(cost) || 0);
    if (normalizedCost === 0) return 0;

    this.refill(now);
    const required = Math.min(normalizedCost, this.capacity);
    if (this.tokens >= required) return 0;
    return ((required - this.tokens) / this.rate) * 1000;
  }

  consume(cost, now = MovementBucket.now()) {
    const normalizedCost = Math.max(0, Number(cost) || 0);
    this.refill(now);
    this.tokens -= normalizedCost;
    return this.tokens;
  }

  reset(now = MovementBucket.now()) {
    this.tokens = this.capacity;
    this.lastRefill = now;
    this.lastElapsedSeconds = 0;
  }

  snapshot(now = MovementBucket.now()) {
    this.refill(now);
    return {
      rate: this.rate,
      capacity: this.capacity,
      available: this.tokens,
      elapsedSeconds: this.lastElapsedSeconds
    };
  }

  static #positive(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0.01;
  }
}

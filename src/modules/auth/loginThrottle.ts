interface AttemptState {
  count: number;
  windowStart: number;
  lockedUntil: number;
}

/**
 * Counts failures per key inside a sliding window and locks the key once a limit is reached.
 * ponytail: in-memory, so counters reset on restart and assume a single API instance; the
 * per-IP rate limiter and bcrypt cost still bound guessing speed across restarts.
 */
export class LoginThrottle {
  private attempts = new Map<string, AttemptState>();

  constructor(
    private windowMs: number,
    private maxEntries = 10_000
  ) {}

  isLocked(key: string, now = Date.now()): boolean {
    return (this.attempts.get(key)?.lockedUntil ?? 0) > now;
  }

  recordFailure(key: string, limit: number, now = Date.now()): void {
    this.prune(now);
    const current = this.attempts.get(key);
    const state =
      current && now - current.windowStart < this.windowMs
        ? current
        : { count: 0, windowStart: now, lockedUntil: 0 };
    state.count++;
    if (state.count >= limit) state.lockedUntil = now + this.windowMs;
    // Re-inserting moves the key to the end, so the Map stays ordered oldest-first for eviction.
    this.attempts.delete(key);
    this.attempts.set(key, state);
  }

  clear(key: string): void {
    this.attempts.delete(key);
  }

  private prune(now: number): void {
    for (const [key, state] of this.attempts) {
      const windowOver = now - state.windowStart >= this.windowMs;
      if (windowOver && state.lockedUntil <= now) this.attempts.delete(key);
    }
    while (this.attempts.size >= this.maxEntries) {
      const oldest = this.attempts.keys().next().value;
      if (oldest === undefined) break;
      this.attempts.delete(oldest);
    }
  }
}

import { describe, expect, it } from 'vitest';
import { LoginThrottle } from '../src/modules/auth/loginThrottle';

const WINDOW = 15 * 60_000;

describe('LoginThrottle', () => {
  it('locks a key at the limit and unlocks it when the window passes', () => {
    const throttle = new LoginThrottle(WINDOW);
    for (let i = 0; i < 5; i++) throttle.recordFailure('a', 5, 0);

    expect(throttle.isLocked('a', 1)).toBe(true);
    expect(throttle.isLocked('a', WINDOW + 1)).toBe(false);
  });

  it('starts a new count once the window of earlier failures has passed', () => {
    const throttle = new LoginThrottle(WINDOW);
    for (let i = 0; i < 4; i++) throttle.recordFailure('a', 5, 0);
    throttle.recordFailure('a', 5, WINDOW + 1);

    expect(throttle.isLocked('a', WINDOW + 2)).toBe(false);
  });

  it('forgets expired entries and never holds more than its size cap', () => {
    const throttle = new LoginThrottle(WINDOW, 100);
    for (let i = 0; i < 1000; i++) throttle.recordFailure(`key-${i}`, 5, i);

    expect(
      (throttle as unknown as { attempts: Map<string, unknown> }).attempts.size
    ).toBeLessThanOrEqual(100);
    throttle.recordFailure('late', 5, 10 * WINDOW);
    expect((throttle as unknown as { attempts: Map<string, unknown> }).attempts.size).toBe(1);
  });

  it('never evicts active locks and reports saturation when they fill the table', () => {
    const throttle = new LoginThrottle(WINDOW, 3);
    for (const key of ['a', 'b', 'c']) throttle.recordFailure(key, 1, 0);
    throttle.recordFailure('d', 1, 1);

    expect(['a', 'b', 'c'].every((key) => throttle.isLocked(key, 2))).toBe(true);
    expect(throttle.isSaturated(2)).toBe(true);
    expect(throttle.isSaturated(WINDOW + 1)).toBe(false);
  });
});

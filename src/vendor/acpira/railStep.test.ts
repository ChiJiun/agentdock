import { describe, expect, it } from 'vitest';
import { railStep } from './railStep';

describe('Acpira railStep MIT helper', () => {
  it('approaches the target smoothly without overshooting', () => {
    const step = railStep(0, 100, 50, 100);
    expect(step).toBeGreaterThan(0);
    expect(step).toBeLessThan(100);
  });
  it('rejects negative elapsed intervals by clamping elapsed time', () => {
    expect(railStep(40, 100, -10, 100)).toBe(40);
  });
  it('snaps near the target', () => {
    expect(railStep(99.9, 100, 16, 100)).toBe(100);
  });
});

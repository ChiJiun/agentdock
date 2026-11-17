// Source: hotic/acpira/packages/ui/ui/railStep.ts
// Commit: 0481995e3a55abcd707f6808df9d7f396483c3e1 (MIT)
// Pure easing for ConnectedRail's length, kept free of DOM types so tests can import it.
export const SNAP_DISTANCE = 0.25;

// One easing step toward the target. Elapsed time is clamped: a negative interval made the rate negative and
// pushed the length away from its target (below zero, where the line vanished and the dot jumped to the icon).
export function railStep(current: number, target: number, elapsedMs: number, tau: number): number {
  if (Math.abs(target - current) < SNAP_DISTANCE) return target;
  const rate = 1 - Math.exp(-Math.max(0, elapsedMs) / tau);
  return current + (target - current) * rate;
}

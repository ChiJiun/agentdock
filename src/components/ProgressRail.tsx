import { useEffect, useState } from 'react';
import { railStep } from '../vendor/acpira/railStep';

export function ProgressRail({ value }: { value: number }) {
  const bounded = Math.max(0, Math.min(1, value));
  const [display, setDisplay] = useState(bounded);

  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setDisplay(bounded);
      return;
    }
    let raf = 0;
    let previous = performance.now();
    let current = display;
    const tick = (now: number) => {
      current = railStep(current * 100, bounded * 100, now - previous, 160) / 100;
      previous = now;
      setDisplay(current);
      if (Math.abs(current - bounded) > 0.0025) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // A new target starts from the currently displayed progress, which is captured when this effect begins.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounded]);

  return (
    <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(bounded * 100)} aria-label="Task progress">
      <div className="progress-fill" style={{ width: `${display * 100}%` }} />
    </div>
  );
}

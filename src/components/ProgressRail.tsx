import { useEffect, useState } from 'react';

export function ProgressRail({ value }: { value: number }) {
  const bounded = Math.max(0, Math.min(1, value));
  const [display, setDisplay] = useState(bounded);

  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setDisplay(bounded);
      return;
    }
    let raf = 0;
    const started = performance.now();
    const initial = display;
    const tick = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - started) / 160));
      const eased = t * t * (3 - 2 * t);
      setDisplay(initial + (bounded - initial) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
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

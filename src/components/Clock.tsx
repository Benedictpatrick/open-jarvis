'use client';

import { useEffect, useState } from 'react';

/** Its own component purely for performance: the time changes every second,
 * and keeping that state in the page meant re-rendering the whole tree —
 * reactor, transcript and all — once a second. On phones the clock is hidden
 * entirely, so that work bought nothing at all. Isolated here, only these few
 * characters re-render. */
export function Clock({ className }: { className?: string }) {
  const [now, setNow] = useState('');

  useEffect(() => {
    const update = () =>
      setNow(
        new Date().toLocaleTimeString('en-GB', {
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }),
      );
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, []);

  return <span className={className}>{now}</span>;
}

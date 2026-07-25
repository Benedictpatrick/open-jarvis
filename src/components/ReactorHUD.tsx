'use client';

import { useMemo } from 'react';

type Phase = 'idle' | 'listening' | 'thinking' | 'speaking';

const CENTER = 200;

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function polar(radius: number, deg: number): readonly [number, number] {
  const rad = (deg - 90) * (Math.PI / 180);
  return [round(CENTER + radius * Math.cos(rad)), round(CENTER + radius * Math.sin(rad))] as const;
}

function trianglePoints(radius: number): string {
  return [0, 120, 240].map((deg) => polar(radius, deg).join(',')).join(' ');
}

function TickRing({
  radius,
  count,
  shortLen,
  longLen,
  longEvery = 5,
  className,
}: {
  radius: number;
  count: number;
  shortLen: number;
  longLen: number;
  longEvery?: number;
  className?: string;
}) {
  const ticks = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => {
        const deg = (360 / count) * i;
        const isLong = i % longEvery === 0;
        const len = isLong ? longLen : shortLen;
        const [x1, y1] = polar(radius, deg);
        const [x2, y2] = polar(radius - len, deg);
        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} strokeWidth={isLong ? 2 : 1} />;
      }),
    [radius, count, shortLen, longLen, longEvery],
  );
  return <g className={className}>{ticks}</g>;
}

function IrisRing({
  innerRadius,
  outerRadius,
  count,
  skewDeg,
  className,
}: {
  innerRadius: number;
  outerRadius: number;
  count: number;
  skewDeg: number;
  className?: string;
}) {
  const blades = useMemo(() => {
    const step = 360 / count;
    const bladeWidth = step * 0.6;
    return Array.from({ length: count }, (_, i) => {
      const start = step * i;
      const [x1, y1] = polar(innerRadius, start);
      const [x2, y2] = polar(outerRadius, start + skewDeg);
      const [x3, y3] = polar(outerRadius, start + skewDeg + bladeWidth);
      const [x4, y4] = polar(innerRadius, start + bladeWidth);
      return <polygon key={i} points={`${x1},${y1} ${x2},${y2} ${x3},${y3} ${x4},${y4}`} />;
    });
  }, [innerRadius, outerRadius, count, skewDeg]);
  return <g className={className}>{blades}</g>;
}

function SegmentArc({
  radius,
  centerDeg,
  spanDeg,
  count,
  blockLen,
  blockWidth,
  className,
}: {
  radius: number;
  centerDeg: number;
  spanDeg: number;
  count: number;
  blockLen: number;
  blockWidth: number;
  className?: string;
}) {
  const blocks = useMemo(() => {
    const start = centerDeg - spanDeg / 2;
    const step = spanDeg / (count - 1);
    return Array.from({ length: count }, (_, i) => {
      const deg = start + step * i;
      const [x, y] = polar(radius, deg);
      return (
        <rect
          key={i}
          x={x - blockWidth / 2}
          y={y - blockLen / 2}
          width={blockWidth}
          height={blockLen}
          transform={`rotate(${deg} ${x} ${y})`}
        />
      );
    });
  }, [radius, centerDeg, spanDeg, count, blockLen, blockWidth]);
  return <g className={className}>{blocks}</g>;
}

export function ReactorHUD({ phase }: { phase: Phase }) {
  return (
    <svg viewBox="0 0 400 400" className={`reactor-svg phase-${phase}`} aria-hidden>
      <defs>
        <radialGradient id="jarvis-core-gradient" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="22%" stopColor="#e2fbff" />
          <stop offset="55%" stopColor="#4cd9ff" />
          <stop offset="100%" stopColor="#0a3040" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="jarvis-core-gradient-amber" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#fffaf0" />
          <stop offset="22%" stopColor="#ffe6bf" />
          <stop offset="55%" stopColor="#ffb454" />
          <stop offset="100%" stopColor="#3a2308" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="jarvis-bloom-gradient" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#bdf3ff" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#bdf3ff" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="jarvis-bloom-gradient-amber" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#ffd7a0" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#ffd7a0" stopOpacity="0" />
        </radialGradient>
        <filter id="jarvis-glow" x="-100%" y="-100%" width="300%" height="300%">
          <feGaussianBlur stdDeviation="3.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter id="jarvis-bloom" x="-200%" y="-200%" width="500%" height="500%">
          <feGaussianBlur stdDeviation="9" />
        </filter>
      </defs>

      <g className="ring outer-dash">
        <circle cx={CENTER} cy={CENTER} r={188} fill="none" strokeDasharray="2 7" />
      </g>

      <TickRing radius={168} count={72} shortLen={5} longLen={11} longEvery={6} className="ring tick-ring-outer" />

      <g className="ring segments">
        <SegmentArc radius={146} centerDeg={0} spanDeg={70} count={13} blockLen={9} blockWidth={4} />
        <SegmentArc radius={146} centerDeg={180} spanDeg={70} count={13} blockLen={9} blockWidth={4} />
      </g>

      <g className="ring dash-mid">
        <circle cx={CENTER} cy={CENTER} r={128} fill="none" strokeDasharray="14 5 3 5" />
      </g>

      <TickRing radius={108} count={48} shortLen={4} longLen={8} longEvery={4} className="ring tick-ring-inner" />

      <circle cx={CENTER} cy={CENTER} r={88} fill="none" className="ring core-ring" />

      <circle cx={CENTER} cy={CENTER} r={92} fill="url(#jarvis-bloom-gradient)" className="core-bloom" />

      <IrisRing innerRadius={56} outerRadius={82} count={18} skewDeg={22} className="ring iris" />

      <circle cx={CENTER} cy={CENTER} r={46} fill="url(#jarvis-core-gradient)" className="core-fill" />

      <polygon points={trianglePoints(32)} className="core-triangle" />
      <circle cx={CENTER} cy={CENTER} r={4.5} className="core-badge" />

      <rect
        x={CENTER - 58}
        y={CENTER + 96}
        width={116}
        height={22}
        rx={3}
        className="core-label-plate"
      />
      <text x={CENTER} y={CENTER + 112} textAnchor="middle" className="core-text">
        J.A.R.V.I.S
      </text>
    </svg>
  );
}

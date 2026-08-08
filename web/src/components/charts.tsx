/**
 * Charts, drawn as plain SVG.
 *
 * They animate in rather than appearing complete: a line draws itself along its
 * own length, bars grow from the baseline, an arc sweeps to its value. That is
 * not decoration — it makes the shape of the data legible in the order it
 * matters, left to right through the day, and it gives the eye somewhere to
 * land when a screen redraws after a live update. All of it is disabled under
 * prefers-reduced-motion, where the finished chart simply appears.
 *
 * No charting library: the shapes needed here are a line, an area, some bars
 * and a donut, and hand-drawn SVG keeps the bundle small, the styling
 * consistent with the rest of the interface, and the colours tied to the same
 * Konecta custom properties everything else uses.
 *
 * Every chart is described in a 0-100 viewBox and stretched by CSS, so they
 * scale to any container without recalculating on resize.
 */

import { useId, useMemo } from 'react';

const PAD = { left: 9, right: 2, top: 6, bottom: 12 };

function scaleX(index: number, count: number): number {
  if (count <= 1) return PAD.left;
  return PAD.left + (index / (count - 1)) * (100 - PAD.left - PAD.right);
}

function scaleY(value: number, max: number): number {
  if (max <= 0) return 100 - PAD.bottom;
  const usable = 100 - PAD.top - PAD.bottom;
  return 100 - PAD.bottom - (value / max) * usable;
}

export interface Series {
  label: string;
  values: number[];
  color: string;
  /** Draw as a filled area under the line. */
  area?: boolean;
  /** Draw as a dashed line — used for the planned figure against the actual. */
  dashed?: boolean;
}

export function LineChart({
  series,
  labels,
  height = 200,
  yMax,
  yFormat = (v) => String(v),
  ariaLabel,
}: {
  series: Series[];
  labels: string[];
  height?: number;
  yMax?: number;
  yFormat?: (value: number) => string;
  ariaLabel: string;
}) {
  const gradientId = useId();
  const max = useMemo(() => {
    const highest = Math.max(1, ...series.flatMap((s) => s.values));
    return yMax ?? niceCeiling(highest);
  }, [series, yMax]);

  const count = labels.length;
  if (count === 0) return <p className="empty">Nothing to plot.</p>;

  // Only a handful of x labels, or they collide.
  const tickEvery = Math.max(1, Math.round(count / 6));

  return (
    <figure className="chart" style={{ height }} role="img" aria-label={ariaLabel}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="chart-svg">
        <defs>
          {series.map((s, i) => (
            <linearGradient key={i} id={`${gradientId}-${i}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity="0.38" />
              <stop offset="100%" stopColor={s.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>

        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <line
            key={t}
            x1={PAD.left}
            x2={100 - PAD.right}
            y1={scaleY(max * t, max)}
            y2={scaleY(max * t, max)}
            className="chart-grid"
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {series.map((s, i) => (
          <g key={i}>
            {s.area && (
              <path
                d={`${linePath(s.values, max)} L ${scaleX(count - 1, count)} ${100 - PAD.bottom} L ${PAD.left} ${100 - PAD.bottom} Z`}
                fill={`url(#${gradientId}-${i})`}
                className="chart-area"
                style={{ animationDelay: `${i * 120 + 160}ms` }}
              />
            )}
            <path
              d={linePath(s.values, max)}
              fill="none"
              stroke={s.color}
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
              strokeDasharray={s.dashed ? '4 3' : undefined}
              vectorEffect="non-scaling-stroke"
              // A dashed series is already using strokeDasharray to be dashed,
              // so only solid lines can borrow it to draw themselves.
              className={s.dashed ? undefined : 'chart-draw'}
              style={{ animationDelay: `${i * 120}ms` }}
            />
          </g>
        ))}
      </svg>

      {/* Labels sit outside the stretched SVG so text is never distorted. */}
      <div className="chart-y">
        {[1, 0.5, 0].map((t) => (
          <span key={t}>{yFormat(Math.round(max * t))}</span>
        ))}
      </div>
      <div className="chart-x">
        {labels.map((label, i) => (i % tickEvery === 0 ? <span key={i}>{label}</span> : null))}
      </div>
      <figcaption className="chart-legend">
        {series.map((s) => (
          <span key={s.label}>
            <i style={{ background: s.color, borderStyle: s.dashed ? 'dashed' : 'solid' }} />
            {s.label}
          </span>
        ))}
      </figcaption>
    </figure>
  );

  function linePath(values: number[], maximum: number): string {
    return values
      .map((v, i) => `${i === 0 ? 'M' : 'L'} ${scaleX(i, count)} ${scaleY(v, maximum)}`)
      .join(' ');
  }
}

/**
 * Coverage: scheduled headcount as bars against the required line. Bars that
 * fall short of the line are coloured differently, because the gap is the
 * entire point of the chart.
 */
export function CoverageChart({
  labels,
  required,
  scheduled,
  height = 220,
}: {
  labels: string[];
  required: number[];
  scheduled: number[];
  height?: number;
}) {
  const max = niceCeiling(Math.max(1, ...required, ...scheduled));
  const count = labels.length;
  const barWidth = (100 - PAD.left - PAD.right) / Math.max(1, count) - 0.25;
  const tickEvery = Math.max(1, Math.round(count / 8));

  return (
    <figure className="chart" style={{ height }} role="img" aria-label="Scheduled headcount against requirement">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="chart-svg">
        {[0, 0.5, 1].map((t) => (
          <line
            key={t}
            x1={PAD.left}
            x2={100 - PAD.right}
            y1={scaleY(max * t, max)}
            y2={scaleY(max * t, max)}
            className="chart-grid"
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {scheduled.map((value, i) => {
          const short = value < required[i];
          const y = scaleY(value, max);
          return (
            <rect
              key={i}
              x={scaleX(i, count) - barWidth / 2}
              y={y}
              width={barWidth}
              height={Math.max(0, 100 - PAD.bottom - y)}
              className={`chart-bar ${short ? 'bar-short' : 'bar-ok'}`}
              // Scaling from the baseline rather than the box centre, so a bar
              // grows out of the axis the way the eye expects.
              style={{
                transformOrigin: `0 ${100 - PAD.bottom}px`,
                animationDelay: `${Math.min(i * 14, 420)}ms`,
              }}
            />
          );
        })}

        <path
          d={required.map((v, i) => `${i === 0 ? 'M' : 'L'} ${scaleX(i, count)} ${scaleY(v, max)}`).join(' ')}
          fill="none"
          stroke="var(--warn)"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
          className="chart-draw"
          style={{ animationDelay: '220ms' }}
        />
      </svg>

      <div className="chart-y">
        {[1, 0.5, 0].map((t) => (
          <span key={t}>{Math.round(max * t)}</span>
        ))}
      </div>
      <div className="chart-x">
        {labels.map((label, i) => (i % tickEvery === 0 ? <span key={i}>{label}</span> : null))}
      </div>
      <figcaption className="chart-legend">
        <span>
          <i className="swatch-ok" /> Covered
        </span>
        <span>
          <i className="swatch-short" /> Short
        </span>
        <span>
          <i className="swatch-required" /> Required
        </span>
      </figcaption>
    </figure>
  );
}

/** Horizontal bars — used where the categories have names worth reading. */
export function BarList({
  items,
  formatValue = (v) => String(v),
}: {
  items: { label: string; value: number; hint?: string; tone?: string }[];
  formatValue?: (value: number) => string;
}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  if (items.length === 0) return <p className="empty">Nothing to show.</p>;

  return (
    <ul className="barlist">
      {items.map((item, i) => (
        <li key={item.label} style={{ '--i': i } as React.CSSProperties}>
          <span className="barlist-label" title={item.hint}>
            {item.label}
          </span>
          <span className="barlist-track">
            <span
              className={`barlist-fill ${item.tone ? `barlist-${item.tone}` : ''}`}
              style={{ width: `${(item.value / max) * 100}%`, animationDelay: `${i * 70}ms` }}
            />
          </span>
          <span className="barlist-value num">{formatValue(item.value)}</span>
        </li>
      ))}
    </ul>
  );
}

/** A single proportion, for a headline percentage. */
export function Gauge({
  value,
  label,
  tone = 'accent',
}: {
  value: number;
  label: string;
  tone?: 'accent' | 'good' | 'warn' | 'error';
}) {
  const clamped = Math.max(0, Math.min(100, value));
  const circumference = 2 * Math.PI * 42;
  const dash = (clamped / 100) * circumference;

  return (
    <figure className="gauge" role="img" aria-label={`${label}: ${clamped}%`}>
      <svg viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="42" className="gauge-track" />
        <circle
          cx="50"
          cy="50"
          r="42"
          className={`gauge-value gauge-${tone}`}
          strokeDasharray={`${dash} ${circumference}`}
          transform="rotate(-90 50 50)"
          // Transitioning the dash offset is what makes the arc travel to a new
          // reading instead of jumping when live figures update.
          style={{ strokeDashoffset: 0 }}
        />
        <text x="50" y="49" className="gauge-number">
          {Math.round(clamped)}
        </text>
        <text x="50" y="63" className="gauge-unit">
          %
        </text>
      </svg>
      <figcaption>{label}</figcaption>
    </figure>
  );
}

/** Round a maximum up to something a human would choose for an axis. */
function niceCeiling(value: number): number {
  if (value <= 5) return Math.ceil(value);
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / (magnitude / 2)) * (magnitude / 2);
}

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Group, Issue } from '../api';

export function Card({
  title,
  subtitle,
  actions,
  children,
  tone,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  tone?: 'default' | 'quiet';
}) {
  return (
    <section className={`card ${tone === 'quiet' ? 'card-quiet' : ''}`}>
      {(title || actions) && (
        <header className="card-head">
          <div>
            {title && <h2>{title}</h2>}
            {subtitle && <p className="muted">{subtitle}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Button({
  children,
  variant = 'default',
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'danger' | 'ghost' }) {
  return (
    <button className={`btn btn-${variant}`} {...rest}>
      {children}
    </button>
  );
}

/**
 * Time entry on a 24 hour clock. The colon is inserted after two digits so a
 * user can type `0500` and get `05:00` — the leading zero is required, which is
 * exactly the mistake this saves them from making.
 */
export function TimeInput({
  value,
  onChange,
  disabled,
  title,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  title?: string;
}) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);

  function handle(raw: string) {
    const digits = raw.replace(/\D/g, '').slice(0, 4);
    const next = digits.length > 2 ? `${digits.slice(0, 2)}:${digits.slice(2)}` : digits;
    setDraft(next);
    if (/^([01]\d|2[0-3]):[0-5]\d$/.test(next)) onChange(next);
  }

  return (
    <input
      className={`time-input ${/^([01]\d|2[0-3]):[0-5]\d$/.test(draft) ? '' : 'invalid'}`}
      value={draft}
      title={title}
      disabled={disabled}
      inputMode="numeric"
      placeholder="00:00"
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        setDraft(value);
      }}
      onChange={(e) => handle(e.target.value)}
    />
  );
}

export function DateField({
  value,
  onChange,
  label,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <label className="field">
      {label && <span>{label}</span>}
      <input type="date" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

export function GroupPicker({
  groups,
  value,
  onChange,
  label = 'Who',
}: {
  groups: Group[];
  value: string;
  onChange: (next: string) => void;
  label?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {groups.map((g) => (
          <option key={g.key} value={g.key}>
            {g.name} ({g.memberIds.length})
          </option>
        ))}
      </select>
    </label>
  );
}

export function Chip({ label, tone = 'neutral', title }: { label: string; tone?: string; title?: string }) {
  return (
    <span className={`chip chip-${tone}`} title={title}>
      {label}
    </span>
  );
}

/** Exception codes get a warning tone so a card's problems read at a glance. */
const EXCEPTION_CODES = new Set(['LT', 'LE', 'LLU', 'LB', 'ABS', 'NCS', 'MAA', 'UTO', 'FLXU', 'FLXD']);

export function CodeChip({ code }: { code: string }) {
  const tone = EXCEPTION_CODES.has(code) ? 'warn' : code === '(W)' ? 'good' : 'neutral';
  return <Chip label={code} tone={tone} />;
}

export function Issues({ issues }: { issues: Issue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="issues">
      {issues.map((issue, i) => (
        <li key={i} className={`issue issue-${issue.level}`}>
          <strong>{issue.level === 'error' ? 'Error' : 'Check'}</strong> {issue.message}
        </li>
      ))}
    </ul>
  );
}

export function Banner({ tone, children }: { tone: 'info' | 'warn' | 'error' | 'good'; children: ReactNode }) {
  return <div className={`banner banner-${tone}`}>{children}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function Loading({ what = 'data' }: { what?: string }) {
  return <p className="empty">Loading {what}…</p>;
}

/**
 * Skeletons.
 *
 * "Loading forecast…" tells you nothing about what is coming; a shape that
 * matches the thing you asked for tells you it is on its way and stops the
 * layout jumping when it lands. Everything below is decorative, so it is hidden
 * from assistive technology and announced once, in words, instead.
 */
export function SkeletonTable({ rows = 6, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div className="skeleton-wrap" role="status" aria-label="Loading">
      <div className="sr-only">Loading…</div>
      {/* The rows carry their own flex column: the gap has to live on the
          element that actually contains them, or they touch and read as one
          solid block rather than as a table. */}
      <div className="skeleton-rows" aria-hidden="true">
        <div className="skeleton-row skeleton-head">
          {Array.from({ length: columns }, (_, c) => (
            <span key={c} className="skeleton-cell" />
          ))}
        </div>
        {Array.from({ length: rows }, (_, r) => (
          <div className="skeleton-row" key={r} style={{ animationDelay: `${r * 45}ms` }}>
            {Array.from({ length: columns }, (_, c) => (
              <span key={c} className="skeleton-cell" style={{ width: `${cellWidth(r, c)}%` }} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function SkeletonChart({ height = 200 }: { height?: number }) {
  // Bars of varied height read as a chart arriving rather than a grey box.
  const bars = [42, 66, 55, 78, 60, 88, 72, 95, 70, 58, 80, 48];
  return (
    <div className="skeleton-wrap" role="status" aria-label="Loading chart" style={{ height }}>
      <div className="sr-only">Loading chart…</div>
      <div className="skeleton-chart" aria-hidden="true">
        {bars.map((h, i) => (
          <span key={i} style={{ height: `${h}%`, animationDelay: `${i * 55}ms` }} />
        ))}
      </div>
    </div>
  );
}

export function SkeletonKpis({ count = 5 }: { count?: number }) {
  return (
    <div className="kpis" role="status" aria-label="Loading figures">
      <div className="sr-only">Loading figures…</div>
      {Array.from({ length: count }, (_, i) => (
        <div className="kpi skeleton-kpi" key={i} aria-hidden="true" style={{ animationDelay: `${i * 60}ms` }}>
          <span className="skeleton-cell" style={{ width: '60%', height: '0.6rem' }} />
          <span className="skeleton-cell" style={{ width: '38%', height: '1.5rem' }} />
          <span className="skeleton-cell" style={{ width: '72%', height: '0.55rem' }} />
        </div>
      ))}
    </div>
  );
}

/** Deterministic width jitter, so the placeholder does not look like a grid. */
function cellWidth(row: number, column: number): number {
  const seed = (row * 7 + column * 13) % 5;
  return [92, 64, 78, 55, 85][seed];
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ''}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="toolbar">{children}</div>;
}

/** Split `YYYY-MM-DD HH:MM` for display: the date only matters when it changes. */
export function Stamp({ value, reference }: { value: string; reference?: string | null }) {
  if (!value) return <span className="muted">—</span>;
  const date = value.slice(0, 10);
  const time = value.slice(11, 16);
  const sameDay = reference ? date === reference.slice(0, 10) : false;
  return (
    <span className="stamp">
      <span className="stamp-time">{time}</span>
      {!sameDay && <span className="stamp-date">{date}</span>}
    </span>
  );
}

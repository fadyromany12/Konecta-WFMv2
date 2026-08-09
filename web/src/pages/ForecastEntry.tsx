import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useAsync, useSession } from '../state';
import { useToast } from '../components/Toast';
import { Banner, Button, Card, DateField, SkeletonTable, Stat, Toolbar } from '../components/ui';
import { LineChart } from '../components/charts';
import { today } from '../lib/time';
import { pulseSuccess } from '../lib/interaction';

/**
 * Entering the forecast.
 *
 * The Erlang engine, the coverage chart and the auto-scheduler all read from
 * this and there was no way to put anything into it — the planning half of the
 * tool was answering a question nobody could ask. A `PUT /forecast` existed;
 * this is the screen for it.
 *
 * Built around paste rather than typing. Nobody produces a forecast in a
 * workforce tool; it arrives from a planning model or a spreadsheet, and the
 * realistic action is pasting two columns out of Excel. Typing forty-eight
 * numbers into forty-eight boxes is a fallback, not the workflow.
 */

interface ForecastRow {
  startTime: string;
  volume: number;
  ahtSeconds: number;
}

interface ForecastResponse {
  date: string;
  projectId: string;
  settings: { serviceGoal: number; targetSeconds: number; shrinkage: number };
  forecast: ForecastRow[];
  coverage: { startTime: string; requiredAgents: number; scheduledAgents: number }[];
}

export function ForecastEntry() {
  const { user } = useSession();
  const toast = useToast();
  const [date, setDate] = useState(today());
  const [rows, setRows] = useState<ForecastRow[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [paste, setPaste] = useState('');
  const [nonce, setNonce] = useState(0);

  const loaded = useAsync<ForecastResponse | null>(
    () => api.get<ForecastResponse>(`/forecast?date=${date}`),
    [date, nonce],
  );

  useEffect(() => {
    if (loaded.data?.forecast) {
      setRows(loaded.data.forecast);
      setDirty(false);
    }
  }, [loaded.data]);

  const totals = useMemo(() => {
    const volume = rows.reduce((sum, r) => sum + r.volume, 0);
    const weighted = rows.reduce((sum, r) => sum + r.volume * r.ahtSeconds, 0);
    return {
      volume,
      // Volume-weighted, because an average of averages over half hours with
      // wildly different traffic is not the day's handling time.
      aht: volume > 0 ? Math.round(weighted / volume) : 0,
      workloadHours: Math.round((weighted / 3600) * 10) / 10,
      busiest: rows.reduce((best, r) => (r.volume > (best?.volume ?? -1) ? r : best), rows[0]),
    };
  }, [rows]);

  function update(startTime: string, patch: Partial<ForecastRow>) {
    setRows((current) => current.map((r) => (r.startTime === startTime ? { ...r, ...patch } : r)));
    setDirty(true);
  }

  /**
   * Read pasted spreadsheet content.
   *
   * Accepts a bare column of volumes in interval order, or `time volume [aht]`
   * per line in any order. Anything unparseable is reported by count rather
   * than swallowed — a paste that silently drops half its rows is worse than
   * one that refuses.
   */
  function applyPaste() {
    const lines = paste
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      toast.warn('Nothing to paste.');
      return;
    }

    const next = new Map(rows.map((r) => [r.startTime, { ...r }]));
    let applied = 0;
    let ignored = 0;

    const bareNumbers = lines.every((l) => /^[\d.,\s]+$/.test(l));
    if (bareNumbers) {
      // A single column, in interval order from the top of the grid.
      const values = lines.flatMap((l) => l.split(/[\s,]+/).filter(Boolean)).map(Number);
      rows.forEach((row, i) => {
        if (i < values.length && Number.isFinite(values[i])) {
          next.set(row.startTime, { ...row, volume: Math.max(0, values[i]) });
          applied++;
        }
      });
      ignored = Math.max(0, values.length - rows.length);
    } else {
      for (const line of lines) {
        const parts = line.split(/[\t,;]|\s{2,}|\s/).filter(Boolean);
        const time = parts[0]?.match(/^(\d{1,2}):(\d{2})$/);
        if (!time) {
          ignored++;
          continue;
        }
        const startTime = `${time[1].padStart(2, '0')}:${time[2]}`;
        const existing = next.get(startTime);
        if (!existing) {
          ignored++;
          continue;
        }
        const volume = Number(parts[1]);
        const aht = parts[2] !== undefined ? Number(parts[2]) : undefined;
        if (!Number.isFinite(volume)) {
          ignored++;
          continue;
        }
        next.set(startTime, {
          ...existing,
          volume: Math.max(0, volume),
          ahtSeconds: Number.isFinite(aht) ? Math.max(1, aht!) : existing.ahtSeconds,
        });
        applied++;
      }
    }

    if (applied === 0) {
      toast.error('None of that could be read.', 'Expected a column of volumes, or “09:00 42 240” per line.');
      return;
    }
    setRows([...next.values()]);
    setDirty(true);
    setPasting(false);
    setPaste('');
    toast.success(
      `Read ${applied} interval${applied === 1 ? '' : 's'}.`,
      ignored > 0 ? `${ignored} line${ignored === 1 ? '' : 's'} ignored.` : 'Nothing saved yet — check it, then Save.',
    );
  }

  async function save(element?: HTMLElement | null) {
    setSaving(true);
    try {
      await api.put('/forecast', { date, rows });
      pulseSuccess(element);
      toast.success('Forecast saved.', 'Coverage and auto-scheduling now plan against it.');
      setDirty(false);
      setNonce((n) => n + 1);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function clearAll() {
    setRows((current) => current.map((r) => ({ ...r, volume: 0 })));
    setDirty(true);
  }

  const settings = loaded.data?.settings;
  const daytime = rows.filter((r) => r.volume > 0);

  if (!user?.isSupervisor) return <Banner tone="error">Forecasting is a supervisor function.</Banner>;

  return (
    <>
      <Toolbar>
        <DateField label="Date" value={date} onChange={setDate} />
        <Button onClick={() => setPasting((v) => !v)}>{pasting ? 'Cancel paste' : 'Paste from spreadsheet'}</Button>
        <Button onClick={clearAll}>Clear</Button>
        <Button variant="primary" onClick={(e) => void save(e.currentTarget)} disabled={!dirty || saving}>
          {saving ? 'Saving…' : 'Save forecast'}
        </Button>
        <div style={{ flex: 1 }} />
        <div className="stats">
          <Stat label="Contacts" value={Math.round(totals.volume)} />
          <Stat label="Average handling" value={`${totals.aht}s`} />
          <Stat label="Workload" value={`${totals.workloadHours}h`} />
          <Stat label="Busiest" value={totals.busiest?.startTime ?? '—'} />
        </div>
      </Toolbar>

      {pasting && (
        <Card
          title="Paste your forecast"
          subtitle="A single column of volumes in interval order, or one line per interval as “09:00 42 240” — time, contacts, handling time in seconds."
        >
          <textarea
            className="paste-box"
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            rows={8}
            placeholder={'09:00\t42\t240\n09:30\t51\t235\n10:00\t63\t228'}
            aria-label="Forecast to paste"
          />
          <Toolbar>
            <Button variant="primary" onClick={applyPaste} disabled={!paste.trim()}>
              Read it
            </Button>
            <span className="muted">
              Nothing is saved until you press Save — read it first and check the shape of the curve.
            </span>
          </Toolbar>
        </Card>
      )}

      {loaded.error && <Banner tone="error">{loaded.error}</Banner>}
      {loaded.loading && !loaded.data && <SkeletonTable rows={8} columns={4} />}

      {settings && (
        <p className="muted" style={{ marginBottom: '0.8rem' }}>
          Required headcount is derived from this by an Erlang C model, planning to answer{' '}
          {Math.round(settings.serviceGoal * 100)}% within {settings.targetSeconds} seconds with{' '}
          {Math.round(settings.shrinkage * 100)}% shrinkage on top. The model assumes a single queue — if the work
          is genuinely multi-skilled, treat the requirement as optimistic.
        </p>
      )}

      {daytime.length > 0 && (
        <Card title="The shape of the day" subtitle="What you are about to save.">
          <LineChart
            ariaLabel="Forecast contact volume through the day"
            labels={daytime.map((r) => r.startTime)}
            series={[
              {
                label: 'Contacts per half hour',
                values: daytime.map((r) => r.volume),
                color: 'var(--k-cyan)',
                area: true,
              },
            ]}
          />
        </Card>
      )}

      <Card title="Intervals" subtitle="Half hours across the day. Volume drives the requirement; handling time scales it.">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Interval</th>
                <th className="right">Contacts</th>
                <th className="right">Handling time (s)</th>
                <th className="right">Workload (min)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.startTime} className={row.volume > 0 ? '' : 'row-quiet'}>
                  <td className="mono">{row.startTime}</td>
                  <td className="right">
                    <input
                      type="number"
                      min={0}
                      step={1}
                      className="num-input"
                      value={row.volume}
                      onChange={(e) => update(row.startTime, { volume: Math.max(0, Number(e.target.value)) })}
                      aria-label={`Contacts at ${row.startTime}`}
                    />
                  </td>
                  <td className="right">
                    <input
                      type="number"
                      min={1}
                      step={5}
                      className="num-input"
                      value={row.ahtSeconds}
                      onChange={(e) => update(row.startTime, { ahtSeconds: Math.max(1, Number(e.target.value)) })}
                      aria-label={`Handling time at ${row.startTime}`}
                    />
                  </td>
                  <td className="right num muted">
                    {Math.round((row.volume * row.ahtSeconds) / 60)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useAsync, useSession } from '../state';
import { useLiveEvent } from '../live';
import { useToast } from '../components/Toast';
import {
  Banner,
  Button,
  Card,
  Chip,
  DateField,
  Empty,
  GroupPicker,
  SkeletonChart,
  Stat,
  Toolbar,
} from '../components/ui';
import { CoverageChart, LineChart } from '../components/charts';
import { today } from '../lib/time';

interface CoverageInterval {
  startTime: string;
  volume: number;
  requiredAgents: number;
  scheduledAgents: number;
  variance: number;
  serviceLevel: number;
  occupancy: number;
}

interface ForecastResponse {
  date: string;
  projectId: string;
  settings: { serviceGoal: number; targetSeconds: number; shrinkage: number };
  coverage: CoverageInterval[];
  forecast: { startTime: string; volume: number; ahtSeconds: number }[];
  summary: {
    intervals: number;
    totalVolume: number;
    requiredHours: number;
    scheduledHours: number;
    understaffedIntervals: number;
    worstVariance: number;
    projectedServiceLevel: number;
  };
}

/**
 * Forecast and coverage — the planning half of the tool. Volume in, required
 * headcount out via Erlang C, compared against what is actually rostered.
 */
export function Planning() {
  const { groups } = useSession();
  const toast = useToast();
  const [group, setGroup] = useState('');
  const [date, setDate] = useState(today());
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!group && groups.length > 0) {
      setGroup(groups.find((g) => g.type === 'SYSTEM')?.key ?? groups[0].key);
    }
  }, [groups, group]);

  const data = useAsync<ForecastResponse | null>(
    () =>
      group
        ? api.get<ForecastResponse>(`/forecast?date=${date}&group=${encodeURIComponent(group)}`)
        : Promise.resolve(null),
    [group, date, nonce],
  );

  const daytime = useMemo(() => (data.data?.coverage ?? []).filter((c) => c.volume > 0), [data.data]);

  // Coverage is a function of the roster, so anything that moves a shift makes
  // this chart stale the moment it happens.
  useLiveEvent(['schedule.changed', 'swap.changed', 'extra-hours.changed'], () => setNonce((n) => n + 1));

  async function runAutoSchedule() {
    setBusy(true);
    try {
      const res = await api.post<any>('/forecast/auto-schedule', { date });
      const headline =
        `Drafted ${res.created.length} shift${res.created.length === 1 ? '' : 's'} for ${date}.`;
      const detail =
        `Short intervals went from ${res.before.understaffedIntervals} to ${res.after.understaffedIntervals}.` +
        (res.skipped.length > 0 ? ` ${res.skipped.length} advisor(s) skipped.` : '');
      if (res.created.length > 0) toast.success(headline, detail);
      else toast.warn('Nothing could be drafted.', detail);
      setNonce((n) => n + 1);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const summary = data.data?.summary;
  const settings = data.data?.settings;

  return (
    <>
      <Toolbar>
        <GroupPicker groups={groups} value={group} onChange={setGroup} />
        <DateField label="Date" value={date} onChange={setDate} />
        <Button onClick={() => setNonce((n) => n + 1)}>Go</Button>
        <Button variant="primary" onClick={runAutoSchedule} disabled={busy}>
          {busy ? 'Drafting…' : 'Auto-schedule to cover'}
        </Button>
        <div style={{ flex: 1 }} />
        {summary && (
          <div className="stats">
            <Stat label="Forecast volume" value={summary.totalVolume} />
            <Stat label="Required" value={`${summary.requiredHours}h`} />
            <Stat
              label="Scheduled"
              value={`${summary.scheduledHours}h`}
              tone={summary.scheduledHours < summary.requiredHours ? 'warn' : 'good'}
            />
            <Stat
              label="Short intervals"
              value={summary.understaffedIntervals}
              tone={summary.understaffedIntervals > 0 ? 'warn' : 'good'}
            />
            <Stat
              label="Projected SL"
              value={`${Math.round(summary.projectedServiceLevel * 100)}%`}
              tone={summary.projectedServiceLevel >= (settings?.serviceGoal ?? 0.8) ? 'good' : 'error'}
            />
          </div>
        )}
      </Toolbar>

      {data.error && <Banner tone="error">{data.error}</Banner>}
      {data.loading && !data.data && (
        <Card title="Cover against requirement">
          <SkeletonChart height={250} />
        </Card>
      )}

      {settings && (
        <p className="muted" style={{ marginBottom: '0.8rem' }}>
          Planning to answer {Math.round(settings.serviceGoal * 100)}% of contacts within{' '}
          {settings.targetSeconds} seconds, with {Math.round(settings.shrinkage * 100)}% shrinkage added on top
          of the phone requirement. Required headcount comes from an Erlang C model of the forecast volume and
          handling time.
        </p>
      )}

      {daytime.length === 0 && !data.loading && (
        <Card>
          <Empty>No forecast volumes for this date.</Empty>
        </Card>
      )}

      {daytime.length > 0 && (
        <>
          <Card title="Cover against requirement" subtitle="Bars are rostered headcount; the line is the requirement.">
            <CoverageChart
              labels={daytime.map((c) => c.startTime)}
              required={daytime.map((c) => c.requiredAgents)}
              scheduled={daytime.map((c) => c.scheduledAgents)}
              height={250}
            />
          </Card>

          <div className="grid-2">
            <Card title="Forecast volume and handling time" tone="quiet">
              <LineChart
                ariaLabel="Forecast contact volume through the day"
                labels={daytime.map((c) => c.startTime)}
                series={[
                  {
                    label: 'Contacts per half hour',
                    values: daytime.map((c) => c.volume),
                    color: 'var(--k-cyan)',
                    area: true,
                  },
                ]}
              />
            </Card>

            <Card title="Projected service level" tone="quiet" subtitle="What the current roster would deliver.">
              <LineChart
                ariaLabel="Projected service level through the day"
                labels={daytime.map((c) => c.startTime)}
                yMax={100}
                yFormat={(v) => `${v}%`}
                series={[
                  {
                    label: 'Projected',
                    values: daytime.map((c) => Math.round(c.serviceLevel * 100)),
                    color: 'var(--k-teal)',
                    area: true,
                  },
                  {
                    label: 'Goal',
                    values: daytime.map(() => Math.round((settings?.serviceGoal ?? 0.8) * 100)),
                    color: 'var(--warn)',
                    dashed: true,
                  },
                ]}
              />
            </Card>
          </div>

          <Card title="Interval detail" subtitle="Every half hour with volume forecast.">
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Interval</th>
                    <th className="right">Volume</th>
                    <th className="right">Required</th>
                    <th className="right">Scheduled</th>
                    <th className="right">Variance</th>
                    <th className="right">Projected SL</th>
                    <th className="right">Occupancy</th>
                  </tr>
                </thead>
                <tbody>
                  {daytime.map((c) => (
                    <tr key={c.startTime} className={c.variance < 0 ? 'row-error' : ''}>
                      <td className="mono">{c.startTime}</td>
                      <td className="right num">{c.volume}</td>
                      <td className="right num">{c.requiredAgents}</td>
                      <td className="right num">{c.scheduledAgents}</td>
                      <td className="right num">
                        <Chip
                          label={c.variance > 0 ? `+${c.variance}` : String(c.variance)}
                          tone={c.variance < 0 ? 'error' : c.variance > 2 ? 'warn' : 'good'}
                        />
                      </td>
                      <td className="right num">{Math.round(c.serviceLevel * 100)}%</td>
                      <td className="right num">
                        {c.occupancy > 0 ? `${Math.round(c.occupancy * 100)}%` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted">
              Occupancy above about 85% is a warning sign rather than an achievement: it means advisors have no
              recovery time between contacts, and attrition follows.
            </p>
          </Card>
        </>
      )}
    </>
  );
}

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAsync, useSession } from '../state';
import { Banner, Button, Card, Chip, Empty, GroupPicker, Loading, Toolbar } from '../components/ui';
import { CoverageChart, Gauge } from '../components/charts';
import { Home } from './Home';
import { today } from '../lib/time';

interface LivePerson {
  userId: number;
  employeeId: string;
  name: string;
  state: string;
  activityName: string | null;
  minutesInState: number;
  scheduledActivity: string | null;
  outOfAdherence: boolean;
  minutesLate: number | null;
}

interface Snapshot {
  at: string;
  people: LivePerson[];
  totals: {
    scheduledOn: number;
    clockedOn: number;
    onPhone: number;
    onBreakOrLunch: number;
    notClockedOn: number;
    late: number;
    outOfAdherence: number;
    adherencePct: number;
  };
  alerts: { severity: string; userId: number; name: string; message: string }[];
}

const STATE_LABELS: Record<string, string> = {
  ON_PHONE: 'On phone',
  OTHER_WORK: 'Other work',
  BREAK: 'Break',
  LUNCH: 'Lunch',
  NOT_CLOCKED_ON: 'Not on yet',
  LATE: 'Late',
  OFF_SHIFT: 'Off shift',
  CLOCKED_OFF_EARLY: 'Left early',
};

/**
 * The landing screen. Supervisors get the intraday command centre — what is
 * happening right now, which is the only window in which they can still change
 * the outcome. Advisors get their clock, because that is their whole job here.
 */
export function Dashboard() {
  const { user } = useSession();
  if (!user?.isSupervisor) return <Home />;
  return <CommandCentre />;
}

function CommandCentre() {
  const { groups } = useSession();
  const navigate = useNavigate();
  const [group, setGroup] = useState('');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!group && groups.length > 0) {
      setGroup(groups.find((g) => g.type === 'SYSTEM')?.key ?? groups[0].key);
    }
  }, [groups, group]);

  // The whole value of this screen is that it is current, so it refreshes
  // itself rather than waiting to be reloaded.
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 30000);
    return () => clearInterval(timer);
  }, []);

  const live = useAsync(
    () =>
      group
        ? api.get<Snapshot>(`/intraday?group=${encodeURIComponent(group)}`)
        : Promise.resolve(null as unknown as Snapshot),
    [group, tick],
  );

  const coverage = useAsync(
    () =>
      group
        ? api.get<any>(`/forecast?date=${today()}&group=${encodeURIComponent(group)}`)
        : Promise.resolve(null),
    [group, tick],
  );

  const totals = live.data?.totals;
  const onShift = live.data?.people.filter((p) => p.state !== 'OFF_SHIFT') ?? [];
  const cov = coverage.data?.coverage ?? [];
  const daytime = cov.filter((c: any) => c.volume > 0);

  return (
    <>
      <Toolbar>
        <GroupPicker groups={groups} value={group} onChange={setGroup} />
        <div style={{ flex: 1 }} />
        <span className="muted">
          <span className="live-dot" />
          Live · updated {live.data?.at.slice(11) ?? '—'} · refreshes every 30s
        </span>
        <Button onClick={() => setTick((t) => t + 1)}>Refresh now</Button>
      </Toolbar>

      {live.loading && !live.data && <Loading what="the live picture" />}
      {live.error && <Banner tone="error">{live.error}</Banner>}

      {totals && (
        <div className="kpis">
          <Kpi label="On shift now" value={totals.scheduledOn} hint={`${totals.clockedOn} clocked on`} />
          <Kpi
            label="On the phone"
            value={totals.onPhone}
            hint={`${totals.onBreakOrLunch} on break or lunch`}
            tone={totals.onPhone === 0 && totals.scheduledOn > 0 ? 'warn' : undefined}
          />
          <Kpi
            label="Not clocked on"
            value={totals.notClockedOn + totals.late}
            hint={totals.late > 0 ? `${totals.late} already late` : 'all accounted for'}
            tone={totals.late > 0 ? 'error' : totals.notClockedOn > 0 ? 'warn' : 'good'}
          />
          <Kpi
            label="Out of adherence"
            value={totals.outOfAdherence}
            hint="doing something unplanned"
            tone={totals.outOfAdherence > 2 ? 'warn' : 'good'}
          />
          <Kpi
            label="Live adherence"
            value={`${totals.adherencePct}%`}
            hint="of those on shift"
            tone={totals.adherencePct >= 90 ? 'good' : totals.adherencePct >= 80 ? 'warn' : 'error'}
          />
        </div>
      )}

      <div className="grid-2">
        <Card
          title="Who is on right now"
          subtitle={`${onShift.length} on shift, ${(live.data?.people.length ?? 0) - onShift.length} off`}
        >
          {onShift.length === 0 && !live.loading && <Empty>Nobody is scheduled at this moment.</Empty>}
          <div className="board">
            {onShift.map((person) => (
              <div
                key={person.userId}
                className={`board-cell board-${person.state} ${person.outOfAdherence ? 'board-out' : ''}`}
                title={
                  person.scheduledActivity
                    ? `Planned: ${person.scheduledActivity}`
                    : 'Nothing planned for this moment'
                }
              >
                <div className="board-name">{person.name}</div>
                <div className="board-state">
                  {STATE_LABELS[person.state] ?? person.state}
                  {person.minutesInState > 0 ? ` · ${person.minutesInState}m` : ''}
                  {person.minutesLate ? ` · ${person.minutesLate}m late` : ''}
                </div>
                {person.outOfAdherence && person.scheduledActivity && (
                  <div className="muted" style={{ fontSize: '0.68rem' }}>
                    planned: {person.scheduledActivity}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>

        <div>
          <Card title="Needs attention" subtitle="Things still fixable today">
            {(live.data?.alerts.length ?? 0) === 0 && <Empty>Nothing needs chasing right now.</Empty>}
            <ul className="issues">
              {live.data?.alerts.map((alert, i) => (
                <li key={i} className={`issue issue-${alert.severity === 'high' ? 'error' : 'warning'}`}>
                  <strong>{alert.name}</strong> {alert.message}
                </li>
              ))}
            </ul>
          </Card>

          {totals && (
            <Card title="Adherence right now" tone="quiet">
              <div style={{ display: 'flex', justifyContent: 'center' }}>
                <Gauge
                  value={totals.adherencePct}
                  label="In adherence"
                  tone={totals.adherencePct >= 90 ? 'good' : totals.adherencePct >= 80 ? 'warn' : 'error'}
                />
              </div>
            </Card>
          )}
        </div>
      </div>

      <Card
        title="Cover against forecast — today"
        subtitle="Bars are scheduled headcount, the line is what the forecast asks for."
        actions={<Button onClick={() => navigate('/scheduling/forecast')}>Open planning</Button>}
      >
        {coverage.loading && !coverage.data && <Loading what="coverage" />}
        {daytime.length === 0 && !coverage.loading && (
          <Empty>No forecast loaded for today. Add volumes under Scheduling → Forecast &amp; Coverage.</Empty>
        )}
        {daytime.length > 0 && (
          <>
            <CoverageChart
              labels={daytime.map((c: any) => c.startTime)}
              required={daytime.map((c: any) => c.requiredAgents)}
              scheduled={daytime.map((c: any) => c.scheduledAgents)}
            />
            <div className="stats" style={{ marginTop: '0.6rem' }}>
              <Chip
                label={`${coverage.data.summary.understaffedIntervals} short intervals`}
                tone={coverage.data.summary.understaffedIntervals > 0 ? 'warn' : 'good'}
              />
              <Chip label={`${coverage.data.summary.scheduledHours}h scheduled`} />
              <Chip label={`${coverage.data.summary.requiredHours}h required`} />
              <Chip
                label={`projected SL ${Math.round(coverage.data.summary.projectedServiceLevel * 100)}%`}
                tone={coverage.data.summary.projectedServiceLevel >= 0.8 ? 'good' : 'warn'}
              />
            </div>
          </>
        )}
      </Card>
    </>
  );
}

function Kpi({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: string;
}) {
  return (
    <div className={`kpi ${tone ? `kpi-${tone}` : ''}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {hint && <div className="kpi-hint">{hint}</div>}
    </div>
  );
}

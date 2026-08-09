import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAsync, useSession } from '../state';
import { useLive, useLiveEvent } from '../live';
import { Ticker } from '../components/Ticker';
import { useToast } from '../components/Toast';
import {
  Banner,
  Button,
  Card,
  Chip,
  Empty,
  GroupPicker,
  SkeletonChart,
  SkeletonKpis,
  Toolbar,
} from '../components/ui';
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
  alerts: {
    key: string;
    severity: string;
    userId: number;
    name: string;
    message: string;
    ackedBy?: string | null;
  }[];
}

const STATE_LABELS: Record<string, string> = {
  ON_PHONE: 'On phone',
  OTHER_WORK: 'Other work',
  BREAK: 'Break',
  LUNCH: 'Lunch',
  NOT_CLOCKED_ON: 'Not on yet',
  LATE: 'Late',
  NO_SHOW: 'No show',
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
  const { connected } = useLive();
  const toast = useToast();
  const [group, setGroup] = useState('');
  const [tick, setTick] = useState(0);
  /** Set briefly when a push arrives, so the change is visible as movement. */
  const [pulsed, setPulsed] = useState(false);

  useEffect(() => {
    if (!group && groups.length > 0) {
      setGroup(groups.find((g) => g.type === 'SYSTEM')?.key ?? groups[0].key);
    }
  }, [groups, group]);

  // A punch or an approval changes this screen, so it redraws the moment one
  // lands rather than up to half a minute later.
  useLiveEvent(['punch', 'timecard.approved', 'schedule.changed'], () => {
    setTick((t) => t + 1);
    setPulsed(true);
  });

  useEffect(() => {
    if (!pulsed) return;
    const timer = setTimeout(() => setPulsed(false), 1200);
    return () => clearTimeout(timer);
  }, [pulsed]);

  // The poll stays as a floor. When the stream is up it is a slow safety net;
  // when the stream cannot run at all it is the only thing keeping this honest.
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), connected ? 120000 : 30000);
    return () => clearInterval(timer);
  }, [connected]);

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

  /**
   * Claiming an alert.
   *
   * Two supervisors watching the same board both ring the same advisor and
   * neither finds out. This is the smallest thing that fixes it: the list is
   * still derived fresh every read, but who picked one up persists.
   */
  async function claim(alert: { key: string; userId: number; name: string }) {
    try {
      const res = await api.post<{ ok: boolean; message: string }>(
        `/alerts/${encodeURIComponent(alert.key)}/ack`,
        { userId: alert.userId },
      );
      if (res.ok) toast.success(res.message, alert.name);
      else toast.warn(res.message, `Leave ${alert.name} to them.`);
      setTick((t) => t + 1);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function release(key: string) {
    try {
      await api.del(`/alerts/${encodeURIComponent(key)}/ack`);
      toast.success('Handed back.', 'It is on the list for anybody to pick up.');
      setTick((t) => t + 1);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  const totals = live.data?.totals;
  const onShift = live.data?.people.filter((p) => p.state !== 'OFF_SHIFT') ?? [];
  const cov = coverage.data?.coverage ?? [];
  const daytime = cov.filter((c: any) => c.volume > 0);

  return (
    <>
      <Toolbar>
        <GroupPicker groups={groups} value={group} onChange={setGroup} />
        <div style={{ flex: 1 }} />
        <span className={`live-badge ${connected ? 'is-live' : ''} ${pulsed ? 'pulsed' : ''}`}>
          <span className="live-dot" />
          {connected ? 'Live' : 'Periodic'} · updated {live.data?.at.slice(11) ?? '—'}
          <span className="muted"> · {connected ? 'pushed as it happens' : 'every 30s'}</span>
        </span>
        <Button onClick={() => setTick((t) => t + 1)}>Refresh now</Button>
      </Toolbar>

      {live.loading && !live.data && <SkeletonKpis count={5} />}
      {live.error && <Banner tone="error">{live.error}</Banner>}

      {totals && (
        <div className="kpis">
          <Kpi index={0} label="On shift now" value={totals.scheduledOn} hint={`${totals.clockedOn} clocked on`} />
          <Kpi
            index={1}
            label="On the phone"
            value={totals.onPhone}
            hint={`${totals.onBreakOrLunch} on break or lunch`}
            tone={totals.onPhone === 0 && totals.scheduledOn > 0 ? 'warn' : undefined}
          />
          <Kpi
            index={2}
            label="Not clocked on"
            value={totals.notClockedOn + totals.late}
            hint={totals.late > 0 ? `${totals.late} already late` : 'all accounted for'}
            tone={totals.late > 0 ? 'error' : totals.notClockedOn > 0 ? 'warn' : 'good'}
          />
          <Kpi
            index={3}
            label="Out of adherence"
            value={totals.outOfAdherence}
            hint="doing something unplanned"
            tone={totals.outOfAdherence > 2 ? 'warn' : 'good'}
          />
          <Kpi
            index={4}
            label="Live adherence"
            value={totals.adherencePct}
            suffix="%"
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
            {onShift.map((person, i) => (
              <div
                key={person.userId}
                style={{ '--i': Math.min(i, 24) } as React.CSSProperties}
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
                  {/* A no-show already says everything the minute count would;
                      "No show · 403m late" is the same fact told twice, the
                      second time in a unit nobody needs. */}
                  {person.state === 'LATE' && person.minutesLate
                    ? ` · ${person.minutesLate}m late`
                    : ''}
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
          <Card
            title="Needs attention"
            subtitle="Things still fixable today. Pick one up so nobody else chases the same person."
          >
            {(live.data?.alerts.length ?? 0) === 0 && <Empty>Nothing needs chasing right now.</Empty>}
            <ul className="issues">
              {live.data?.alerts.map((alert) => (
                <li
                  key={alert.key}
                  className={`issue issue-${alert.severity === 'high' ? 'error' : 'warning'} ${
                    alert.ackedBy ? 'issue-claimed' : ''
                  }`}
                >
                  <div className="issue-line">
                    <span>
                      <strong>{alert.name}</strong> {alert.message}
                    </span>
                    {alert.ackedBy ? (
                      <button className="btn btn-ghost" onClick={() => release(alert.key)}>
                        {alert.ackedBy} has it — hand back
                      </button>
                    ) : (
                      <button className="btn" onClick={() => claim(alert)}>
                        I'll take it
                      </button>
                    )}
                  </div>
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
        {coverage.loading && !coverage.data && <SkeletonChart height={220} />}
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
  index = 0,
  suffix = '',
}: {
  label: string;
  value: number;
  hint?: string;
  tone?: string;
  index?: number;
  suffix?: string;
}) {
  return (
    <div className={`kpi ${tone ? `kpi-${tone}` : ''}`} style={{ '--i': index } as React.CSSProperties}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">
        <Ticker value={value} format={(n) => `${n}${suffix}`} />
      </div>
      {hint && <div className="kpi-hint">{hint}</div>}
    </div>
  );
}

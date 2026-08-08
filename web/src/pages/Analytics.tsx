import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAsync, useSession } from '../state';
import { Banner, Card, DateField, Empty, GroupPicker, SkeletonChart, SkeletonTable, Stat, Toolbar, Chip } from '../components/ui';
import { BarList, LineChart } from '../components/charts';
import { addDays, today } from '../lib/time';

interface AnalyticsResponse {
  start: string;
  end: string;
  trend: {
    date: string;
    adherencePct: number;
    regularHours: number;
    absenceHours: number;
    exceptions: number;
    headcount: number;
  }[];
  scorecards: {
    userId: number;
    employeeId: string;
    name: string;
    daysWorked: number;
    adherencePct: number;
    regularHours: number;
    absenceHours: number;
    lateCount: number;
    lateMinutes: number;
    leaveEarlyCount: number;
    longLunchCount: number;
    absenceCount: number;
    exceptionCount: number;
  }[];
  exceptionMix: { code: string; name: string; count: number; formatted: string }[];
  shrinkage: { activity: string; name: string; formatted: string; pct: number; minutes: number }[];
  totals: {
    adherencePct: number;
    regularHours: number;
    absenceHours: number;
    exceptions: number;
    advisors: number;
  };
}

/**
 * The same timecards read across time instead of a day at a time. A single
 * exception is a conversation; a pattern of them is a different one, and only
 * this view shows the difference.
 */
export function Analytics() {
  const { groups } = useSession();
  const [group, setGroup] = useState('');
  const [start, setStart] = useState(addDays(today(), -14));
  const [end, setEnd] = useState(today());

  useEffect(() => {
    if (!group && groups.length > 0) {
      setGroup(groups.find((g) => g.type === 'SYSTEM')?.key ?? groups[0].key);
    }
  }, [groups, group]);

  const data = useAsync<AnalyticsResponse | null>(
    () =>
      group
        ? api.get<AnalyticsResponse>(
            `/analytics?group=${encodeURIComponent(group)}&start=${start}&end=${end}`,
          )
        : Promise.resolve(null),
    [group, start, end],
  );

  const result = data.data;
  const trend = result?.trend ?? [];

  function exportScorecards() {
    const rows = result?.scorecards ?? [];
    const header = [
      'employee_id', 'name', 'days_worked', 'adherence_pct', 'regular_hours',
      'absence_hours', 'late_count', 'late_minutes', 'leave_early', 'long_lunch', 'absences', 'exceptions',
    ];
    const csv = [
      header.join(','),
      ...rows.map((r) =>
        [r.employeeId, r.name, r.daysWorked, r.adherencePct, r.regularHours, r.absenceHours,
         r.lateCount, r.lateMinutes, r.leaveEarlyCount, r.longLunchCount, r.absenceCount, r.exceptionCount]
          .map((v) => JSON.stringify(v ?? ''))
          .join(','),
      ),
    ].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `pulse-scorecards-${start}-to-${end}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <Toolbar>
        <GroupPicker groups={groups} value={group} onChange={setGroup} />
        <DateField label="From" value={start} onChange={setStart} />
        <DateField label="To" value={end} onChange={setEnd} />
        <div style={{ flex: 1 }} />
        {result && (
          <div className="stats">
            <Stat
              label="Adherence"
              value={`${result.totals.adherencePct}%`}
              tone={result.totals.adherencePct >= 90 ? 'good' : result.totals.adherencePct >= 80 ? 'warn' : 'error'}
            />
            <Stat label="Regular hours" value={result.totals.regularHours} />
            <Stat label="Absence hours" value={result.totals.absenceHours} tone={result.totals.absenceHours > 0 ? 'warn' : undefined} />
            <Stat label="Exceptions" value={result.totals.exceptions} />
            <Stat label="Advisors" value={result.totals.advisors} />
          </div>
        )}
      </Toolbar>

      {data.error && <Banner tone="error">{data.error}</Banner>}
      {data.loading && !result && (
        <>
          <Card title="Adherence over time">
            <SkeletonChart height={200} />
          </Card>
          <Card title="Advisor scorecards">
            <SkeletonTable rows={6} columns={10} />
          </Card>
        </>
      )}
      {result && trend.length === 0 && (
        <Card>
          <Empty>No worked time in that range.</Empty>
        </Card>
      )}

      {trend.length > 0 && result && (
        <>
          <Card title="Adherence over time" subtitle="Averaged across every advisor who worked that day.">
            <LineChart
              ariaLabel="Adherence percentage by day"
              labels={trend.map((t) => t.date.slice(5))}
              yMax={100}
              yFormat={(v) => `${v}%`}
              series={[
                { label: 'Adherence', values: trend.map((t) => t.adherencePct), color: 'var(--k-cyan)', area: true },
                { label: 'Target 90%', values: trend.map(() => 90), color: 'var(--warn)', dashed: true },
              ]}
            />
          </Card>

          <div className="grid-2">
            <Card title="Hours worked and lost" tone="quiet">
              <LineChart
                ariaLabel="Regular and absence hours by day"
                labels={trend.map((t) => t.date.slice(5))}
                series={[
                  { label: 'Regular hours', values: trend.map((t) => t.regularHours), color: 'var(--k-teal)', area: true },
                  { label: 'Absence hours', values: trend.map((t) => t.absenceHours), color: 'var(--k-magenta)' },
                ]}
              />
            </Card>

            <Card title="Exceptions raised" tone="quiet">
              <LineChart
                ariaLabel="Exception count by day"
                labels={trend.map((t) => t.date.slice(5))}
                series={[
                  { label: 'Exceptions', values: trend.map((t) => t.exceptions), color: 'var(--k-magenta)', area: true },
                ]}
              />
            </Card>
          </div>

          <div className="grid-2">
            <Card title="What the exceptions are" subtitle="Where supervisor time is going.">
              <BarList
                items={result.exceptionMix.map((e) => ({
                  label: `${e.code} ${e.name}`,
                  value: e.count,
                  hint: `${e.formatted} total`,
                  tone: ['NCS', 'ABS', 'LT'].includes(e.code) ? 'error' : 'warn',
                }))}
              />
            </Card>

            <Card title="Where paid time goes off the phone" subtitle="Shrinkage by activity.">
              <BarList
                items={result.shrinkage.map((s) => ({
                  label: s.name,
                  value: s.minutes,
                  hint: `${s.formatted} — ${s.pct}% of shrinkage`,
                }))}
                formatValue={(v) => `${Math.round(v / 60)}h`}
              />
            </Card>
          </div>

          <Card
            title="Advisor scorecards"
            subtitle="Sorted by exception count — the top of this list is where a conversation is due."
            actions={
              <button className="btn" onClick={exportScorecards}>
                Export CSV
              </button>
            }
          >
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Advisor</th>
                    <th className="right">Days</th>
                    <th className="right">Adherence</th>
                    <th className="right">Regular</th>
                    <th className="right">Absence</th>
                    <th className="right">Late</th>
                    <th className="right">Left early</th>
                    <th className="right">Long lunch</th>
                    <th className="right">Absences</th>
                    <th className="right">Exceptions</th>
                  </tr>
                </thead>
                <tbody>
                  {result.scorecards.map((s) => (
                    <tr key={s.userId}>
                      <td>
                        {s.name}
                        <div className="muted mono">{s.employeeId}</div>
                      </td>
                      <td className="right num">{s.daysWorked}</td>
                      <td className="right num">
                        <Chip
                          label={`${s.adherencePct}%`}
                          tone={s.adherencePct >= 90 ? 'good' : s.adherencePct >= 80 ? 'warn' : 'error'}
                        />
                      </td>
                      <td className="right num">{s.regularHours}h</td>
                      <td className="right num">{s.absenceHours}h</td>
                      <td className="right num">
                        {s.lateCount > 0 ? `${s.lateCount} (${s.lateMinutes}m)` : '—'}
                      </td>
                      <td className="right num">{s.leaveEarlyCount || '—'}</td>
                      <td className="right num">{s.longLunchCount || '—'}</td>
                      <td className="right num">{s.absenceCount || '—'}</td>
                      <td className="right num">
                        <Chip
                          label={String(s.exceptionCount)}
                          tone={s.exceptionCount >= 5 ? 'error' : s.exceptionCount > 0 ? 'warn' : 'good'}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </>
  );
}

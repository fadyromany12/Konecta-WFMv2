import { useEffect, useMemo, useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import { SubTabs } from '../App';
import { api, type AdherenceResponse, type Person } from '../api';
import { useAsync, useSession } from '../state';
import {
  Banner,
  Button,
  Card,
  Chip,
  CodeChip,
  DateField,
  Empty,
  GroupPicker,
  Loading,
  Stat,
  Toolbar,
} from '../components/ui';
import { addDays, durationBetween, today, toMinutes } from '../lib/time';

export function Reports() {
  const { user } = useSession();
  const items = [{ to: '/reports', label: 'Pulse Report' }];
  if (user?.isSupervisor) {
    items.push({ to: '/reports/exceptions', label: 'Non-Worked Exceptions' }, { to: '/reports/query', label: 'Query Tool' });
  }
  return (
    <>
      <SubTabs items={items} />
      <Routes>
        <Route index element={<PulseReport />} />
        <Route path="exceptions" element={<ExceptionReport />} />
        <Route path="query" element={<QueryTool />} />
      </Routes>
    </>
  );
}

/**
 * The Pulse Report: schedule against reality for one advisor on one day. This
 * is the daily read — the questions it raises are the ones worth putting to the
 * advisor before anything gets corrected.
 */
function PulseReport() {
  const { groups, user } = useSession();
  const [group, setGroup] = useState('');
  const [personId, setPersonId] = useState<number | null>(null);
  const [date, setDate] = useState(addDays(today(), -1));

  useEffect(() => {
    if (!group && groups.length > 0) setGroup(groups.find((g) => g.type === 'SYSTEM')?.key ?? groups[0].key);
  }, [groups, group]);

  const people = useAsync(
    () =>
      group && user?.isSupervisor
        ? api.get<{ people: Person[] }>(`/people?group=${encodeURIComponent(group)}`)
        : Promise.resolve({ people: [] }),
    [group, user],
  );

  useEffect(() => {
    const list = people.data?.people ?? [];
    if (list.length > 0 && !list.some((p) => p.id === personId)) setPersonId(list[0].id);
  }, [people.data, personId]);

  const target = user?.isSupervisor ? personId : user?.id;

  const report = useAsync<AdherenceResponse | null>(
    () =>
      target
        ? api.get<AdherenceResponse>(`/reports/adherence?userId=${target}&date=${date}`)
        : Promise.resolve(null),
    [target, date],
  );

  const data = report.data;

  return (
    <>
      <Toolbar>
        {user?.isSupervisor && (
          <>
            <GroupPicker groups={groups} value={group} onChange={setGroup} />
            <label className="field">
              <span>Advisor</span>
              <select value={personId ?? ''} onChange={(e) => setPersonId(Number(e.target.value))}>
                {people.data?.people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <DateField label="Payroll date" value={date} onChange={setDate} />
        <Button onClick={() => setDate(addDays(date, -1))}>← Previous day</Button>
        <Button onClick={() => setDate(addDays(date, 1))}>Next day →</Button>
      </Toolbar>

      {report.loading && <Loading what="report" />}
      {report.error && <Banner tone="error">{report.error}</Banner>}

      {data && (
        <>
          <Toolbar>
            <div className="stats">
              <Stat
                label="Adherence"
                value={`${data.report.adherencePct}%`}
                tone={data.report.adherencePct >= 90 ? 'good' : data.report.adherencePct >= 80 ? 'warn' : 'error'}
              />
              <Stat label="Scheduled" value={fmt(data.report.scheduledMinutes)} />
              <Stat label="Actual" value={fmt(data.report.actualMinutes)} />
              {data.punctuality && (
                <>
                  <Stat
                    label="Start variance"
                    value={`${data.punctuality.startVarianceMinutes > 0 ? '+' : ''}${data.punctuality.startVarianceMinutes}m`}
                    tone={data.punctuality.startVarianceMinutes > 3 ? 'warn' : 'good'}
                  />
                  <Stat
                    label="End variance"
                    value={`${data.punctuality.endVarianceMinutes > 0 ? '+' : ''}${data.punctuality.endVarianceMinutes}m`}
                    tone={data.punctuality.endVarianceMinutes < -3 ? 'warn' : 'good'}
                  />
                </>
              )}
            </div>
          </Toolbar>

          <Card title={`${data.user.name} — ${data.date}`} subtitle="Green is time spent in the planned state.">
            <AdherenceBar bands={data.report.bands} />

            <div className="grid-2" style={{ marginTop: '1rem' }}>
              <div>
                <h3 style={{ fontSize: '0.8rem', textTransform: 'uppercase', color: 'var(--text-dim)' }}>
                  Worth asking about
                </h3>
                {data.report.observations.length === 0 ? (
                  <Empty>Nothing stands out. The day ran to plan.</Empty>
                ) : (
                  <ul className="issues">
                    {data.report.observations.map((o, i) => (
                      <li key={i} className="issue issue-warning">
                        {o}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <h3 style={{ fontSize: '0.8rem', textTransform: 'uppercase', color: 'var(--text-dim)' }}>
                  Scheduled vs actual
                </h3>
                <table>
                  <thead>
                    <tr>
                      <th>Activity</th>
                      <th className="right">Scheduled</th>
                      <th className="right">Actual</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mergeTotals(data.report.scheduledTotals, data.report.actualTotals).map((row) => (
                      <tr key={row.activity}>
                        <td>
                          <Chip label={row.activity} /> {row.name}
                        </td>
                        <td className="right num">{row.scheduled}</td>
                        <td className="right num">{row.actual}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </Card>

          <div className="grid-2">
            <Card title="Planned" tone="quiet">
              {data.shifts.length === 0 && <Empty>Nothing scheduled.</Empty>}
              {data.shifts.map((shift) =>
                shift.rows.map((row, i) => {
                  const endAt = i + 1 < shift.rows.length ? shift.rows[i + 1].startAt : shift.endAt;
                  return (
                    <div key={`${shift.shiftNo}-${i}`} className="timeline-row">
                      <span className="mono">
                        {row.startAt.slice(11)}–{endAt.slice(11)}
                      </span>
                      <span>{row.activityKey.replace(/_/g, ' ').toLowerCase()}</span>
                    </div>
                  );
                }),
              )}
            </Card>

            <Card title="Actual" tone="quiet">
              {(data.timecard?.rows.length ?? 0) === 0 && <Empty>No time recorded.</Empty>}
              {data.timecard?.rows.map((row, i) => (
                <div key={i} className="timeline-row">
                  <span className="mono">
                    {row.startAt.slice(11)}–{row.endAt.slice(11)}
                  </span>
                  <span>
                    <CodeChip code={row.code} /> {row.activity}{' '}
                    <span className="muted">{durationBetween(row.startAt, row.endAt)}</span>
                  </span>
                </div>
              ))}
            </Card>
          </div>
        </>
      )}
    </>
  );
}

function AdherenceBar({ bands }: { bands: AdherenceResponse['report']['bands'] }) {
  const total = useMemo(() => {
    if (bands.length === 0) return 0;
    return toMinutes(bands[bands.length - 1].endAt) - toMinutes(bands[0].startAt);
  }, [bands]);

  if (bands.length === 0) return <Empty>No time to compare.</Empty>;

  return (
    <>
      <div className="bands">
        {bands.map((band, i) => {
          const width = ((toMinutes(band.endAt) - toMinutes(band.startAt)) / total) * 100;
          const cls = band.adherent ? 'band-ok' : band.scheduled || band.actual ? 'band-off' : 'band-idle';
          return (
            <div
              key={i}
              className={`band ${cls}`}
              style={{ width: `${width}%` }}
              title={`${band.startAt.slice(11)}–${band.endAt.slice(11)}\nplanned: ${band.scheduled ?? 'nothing'}\nactual: ${band.actual ?? 'nothing'}`}
            />
          );
        })}
      </div>
      <div className="band-legend">
        <span>{bands[0].startAt.slice(11)}</span>
        <span style={{ flex: 1 }} />
        <span>in plan</span>
        <span>out of plan</span>
        <span style={{ flex: 1 }} />
        <span>{bands[bands.length - 1].endAt.slice(11)}</span>
      </div>
    </>
  );
}

function mergeTotals(
  scheduled: { activity: string; name: string; formatted: string }[],
  actual: { activity: string; name: string; formatted: string }[],
) {
  const map = new Map<string, { activity: string; name: string; scheduled: string; actual: string }>();
  for (const s of scheduled) map.set(s.activity, { activity: s.activity, name: s.name, scheduled: s.formatted, actual: '—' });
  for (const a of actual) {
    const existing = map.get(a.activity);
    if (existing) existing.actual = a.formatted;
    else map.set(a.activity, { activity: a.activity, name: a.name, scheduled: '—', actual: a.formatted });
  }
  return [...map.values()];
}

/** Every exception code across a group and a date range. */
function ExceptionReport() {
  const { groups } = useSession();
  const [group, setGroup] = useState('');
  const [start, setStart] = useState(addDays(today(), -7));
  const [end, setEnd] = useState(today());

  useEffect(() => {
    if (!group && groups.length > 0) setGroup(groups.find((g) => g.type === 'SYSTEM')?.key ?? groups[0].key);
  }, [groups, group]);

  const data = useAsync(
    () =>
      group
        ? api.get<{ rows: any[] }>(`/reports/exceptions?group=${encodeURIComponent(group)}&start=${start}&end=${end}`)
        : Promise.resolve({ rows: [] }),
    [group, start, end],
  );

  const byCode = useMemo(() => {
    const acc = new Map<string, number>();
    for (const row of data.data?.rows ?? []) acc.set(row.code, (acc.get(row.code) ?? 0) + 1);
    return [...acc.entries()].sort((a, b) => b[1] - a[1]);
  }, [data.data]);

  return (
    <>
      <Toolbar>
        <GroupPicker groups={groups} value={group} onChange={setGroup} />
        <DateField label="From" value={start} onChange={setStart} />
        <DateField label="To" value={end} onChange={setEnd} />
        <div style={{ flex: 1 }} />
        <div className="stats">
          {byCode.map(([code, count]) => (
            <Stat key={code} label={code} value={count} />
          ))}
        </div>
      </Toolbar>

      <Card title="Non-worked exceptions">
        {data.loading && <Loading what="exceptions" />}
        {data.data?.rows.length === 0 && !data.loading && <Empty>No exceptions in that range. </Empty>}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Advisor</th>
                <th>Code</th>
                <th>Activity</th>
                <th>From</th>
                <th>To</th>
                <th className="right">Duration</th>
                <th>Approved</th>
              </tr>
            </thead>
            <tbody>
              {data.data?.rows.map((row, i) => (
                <tr key={i}>
                  <td className="mono">{row.payroll_date}</td>
                  <td>
                    {row.name}
                    <div className="muted mono">{row.employee_id}</div>
                  </td>
                  <td>
                    <CodeChip code={row.code} />
                  </td>
                  <td className="mono">{row.activity}</td>
                  <td className="mono">{row.start_at.slice(11)}</td>
                  <td className="mono">{row.end_at.slice(11)}</td>
                  <td className="right num">{durationBetween(row.start_at, row.end_at)}</td>
                  <td>{row.approved ? <Chip label="yes" tone="good" /> : <Chip label="no" tone="warn" />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

/** Ad-hoc slice across timecard rows, for the questions no fixed report answers. */
function QueryTool() {
  const { groups, catalog } = useSession();
  const [group, setGroup] = useState('');
  const [start, setStart] = useState(addDays(today(), -7));
  const [end, setEnd] = useState(today());
  const [code, setCode] = useState('');
  const [activity, setActivity] = useState('');

  useEffect(() => {
    if (!group && groups.length > 0) setGroup(groups.find((g) => g.type === 'SYSTEM')?.key ?? groups[0].key);
  }, [groups, group]);

  const data = useAsync(
    () =>
      group
        ? api.get<{ rows: any[] }>(
            `/reports/query?group=${encodeURIComponent(group)}&start=${start}&end=${end}&code=${encodeURIComponent(code)}&activity=${encodeURIComponent(activity)}`,
          )
        : Promise.resolve({ rows: [] }),
    [group, start, end, code, activity],
  );

  const totalMinutes = (data.data?.rows ?? []).reduce((sum, r) => sum + (r.minutes ?? 0), 0);

  function exportCsv() {
    const rows = data.data?.rows ?? [];
    const header = ['employee_id', 'name', 'payroll_date', 'code', 'project', 'activity', 'start_at', 'end_at', 'minutes'];
    const csv = [
      header.join(','),
      ...rows.map((r) => header.map((h) => JSON.stringify(r[h] ?? '')).join(',')),
    ].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `pulse-query-${start}-to-${end}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <Toolbar>
        <GroupPicker groups={groups} value={group} onChange={setGroup} />
        <DateField label="From" value={start} onChange={setStart} />
        <DateField label="To" value={end} onChange={setEnd} />
        <label className="field">
          <span>Code</span>
          <select value={code} onChange={(e) => setCode(e.target.value)}>
            <option value="">Any</option>
            {catalog?.codes.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code} {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Activity</span>
          <select value={activity} onChange={(e) => setActivity(e.target.value)}>
            <option value="">Any</option>
            {catalog?.activities.map((a) => (
              <option key={a.code} value={a.code}>
                {a.code} {a.name}
              </option>
            ))}
          </select>
        </label>
        <Button onClick={exportCsv} disabled={(data.data?.rows.length ?? 0) === 0}>
          Export CSV
        </Button>
        <div style={{ flex: 1 }} />
        <div className="stats">
          <Stat label="Rows" value={data.data?.rows.length ?? 0} />
          <Stat label="Total" value={fmt(Math.round(totalMinutes))} />
        </div>
      </Toolbar>

      <Card>
        {data.loading && <Loading what="results" />}
        {data.data?.rows.length === 0 && !data.loading && <Empty>Nothing matched those filters.</Empty>}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Advisor</th>
                <th>Code</th>
                <th>Project</th>
                <th>Activity</th>
                <th>From</th>
                <th>To</th>
                <th className="right">Minutes</th>
              </tr>
            </thead>
            <tbody>
              {data.data?.rows.map((row, i) => (
                <tr key={i}>
                  <td className="mono">{row.payroll_date}</td>
                  <td>{row.name}</td>
                  <td>
                    <CodeChip code={row.code} />
                  </td>
                  <td className="mono">{row.project}</td>
                  <td className="mono">{row.activity}</td>
                  <td className="mono">{row.start_at.slice(11)}</td>
                  <td className="mono">{row.end_at.slice(11)}</td>
                  <td className="right num">{Math.round(row.minutes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

function fmt(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

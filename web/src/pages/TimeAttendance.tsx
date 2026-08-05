import { useEffect, useMemo, useState } from 'react';
import { Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { SubTabs } from '../App';
import {
  api,
  type EditDecision,
  type PayrollSummaryRow,
  type ScheduleShift,
  type Timecard,
  type TimecardRow,
} from '../api';
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
  Issues,
  Loading,
  Stamp,
  Stat,
  TimeInput,
  Toolbar,
} from '../components/ui';
import { addDays, durationBetween, rollForward, timeOf, toMinutes, today, withTime } from '../lib/time';

export function TimeAttendance() {
  const items = [
    { to: '/time', label: 'Payroll Summary' },
    { to: '/time/calendar', label: 'Worked Calendar' },
  ];
  return (
    <>
      <SubTabs items={items} />
      <Routes>
        <Route index element={<PayrollSummary />} />
        <Route path="calendar" element={<WorkedCalendar />} />
        <Route path="card/:userId/:date" element={<TimecardEditor />} />
      </Routes>
    </>
  );
}

/**
 * The screen a supervisor lives in: one row per timecard, the codes it carries,
 * and the approval checkbox. Anything odd is meant to be visible without
 * opening the card.
 */
function PayrollSummary() {
  const { groups, user } = useSession();
  const navigate = useNavigate();
  const [group, setGroup] = useState('');
  const [start, setStart] = useState(addDays(today(), -3));
  const [end, setEnd] = useState(today());
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    if (!group && groups.length > 0) {
      setGroup(groups.find((g) => g.type === 'SYSTEM')?.key ?? groups[0].key);
    }
  }, [groups, group]);

  const summary = useAsync(
    () =>
      group
        ? api.get<{ rows: PayrollSummaryRow[]; editWindowDays: number }>(
            `/payroll/summary?group=${encodeURIComponent(group)}&start=${start}&end=${end}`,
          )
        : Promise.resolve({ rows: [], editWindowDays: 0 }),
    [group, start, end],
  );

  async function toggleApproval(row: PayrollSummaryRow, approved: boolean) {
    setFlash(null);
    try {
      const res = await api.post<{ ok: boolean; message: string }>(
        `/timecards/${row.userId}/${row.payrollDate}/approve`,
        { approved },
      );
      setFlash(res.message);
      summary.reload();
    } catch (err) {
      setFlash((err as Error).message);
    }
  }

  const rows = summary.data?.rows ?? [];
  const pending = rows.filter((r) => !r.approved && !r.inProgress).length;
  const withExceptions = rows.filter((r) => r.exceptions.length > 0).length;

  return (
    <>
      <Toolbar>
        <GroupPicker groups={groups} value={group} onChange={setGroup} />
        <DateField label="Start" value={start} onChange={setStart} />
        <DateField label="End" value={end} onChange={setEnd} />
        <Button onClick={() => summary.reload()}>Go</Button>
        <div style={{ flex: 1 }} />
        <div className="stats">
          <Stat label="Timecards" value={rows.length} />
          <Stat label="Unapproved" value={pending} tone={pending > 0 ? 'warn' : 'good'} />
          <Stat label="With exceptions" value={withExceptions} tone={withExceptions > 0 ? 'warn' : undefined} />
        </div>
      </Toolbar>

      {flash && <Banner tone="info">{flash}</Banner>}
      {user && (
        <p className="muted" style={{ marginBottom: '0.6rem' }}>
          Your edit window is {user.editWindowDays} days. Cards older than that must go to your Operations Manager.
        </p>
      )}

      <Card>
        {summary.loading && <Loading what="payroll summary" />}
        {summary.error && <Banner tone="error">{summary.error}</Banner>}
        {!summary.loading && rows.length === 0 && <Empty>No timecards in that range.</Empty>}

        {rows.length > 0 && (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Payroll date</th>
                  <th>Advisor</th>
                  <th>Codes</th>
                  <th className="right">Regular</th>
                  <th className="right">Overtime</th>
                  <th className="right">Absence</th>
                  <th className="right">Extra hours</th>
                  <th>Flags</th>
                  <th>Approved</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={`${row.userId}-${row.payrollDate}`}
                    className={`${row.approved ? 'row-approved' : ''} ${row.hasErrors ? 'row-error' : ''}`}
                  >
                    <td className="mono nowrap">{row.payrollDate}</td>
                    <td className="nowrap">
                      {row.name}
                      <div className="muted">{row.employeeId}</div>
                    </td>
                    <td>
                      {row.codes.map((c) => (
                        <CodeChip key={c} code={c} />
                      ))}
                    </td>
                    <td className="right num">{row.regular}</td>
                    <td className="right num">{row.overtime}</td>
                    <td className="right num">{row.absence}</td>
                    <td className="right num">{row.extraHours}</td>
                    <td className="nowrap">
                      {row.inProgress && <Chip label="in progress" tone="accent" />}
                      {row.assumedOff && <Chip label="assumed off" tone="warn" title="No clock off punch" />}
                      {row.hasErrors && <Chip label="errors" tone="error" />}
                      {row.protectDate && <Chip label="protected" tone="warn" title={`Payroll run ${row.protectDate}`} />}
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={row.approved}
                        disabled={row.inProgress}
                        onChange={(e) => toggleApproval(row, e.target.checked)}
                      />
                    </td>
                    <td>
                      <Button onClick={() => navigate(`/time/card/${row.userId}/${row.payrollDate}`)}>
                        Timecard
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

const EMPTY_ROW = (project: string, anchor: string): TimecardRow => ({
  code: '(W)',
  project,
  activity: '01-001',
  startAt: anchor,
  endAt: anchor,
});

/**
 * The timecard grid. Every edit is local until Save, at which point the server
 * re-validates the whole card — the checks a supervisor is told to run by hand
 * after each change are the ones that run here.
 */
function TimecardEditor() {
  const { userId, date } = useParams();
  const { catalog, user } = useSession();
  const navigate = useNavigate();

  const [rows, setRows] = useState<TimecardRow[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [flash, setFlash] = useState<{ tone: 'good' | 'error' | 'warn'; text: string } | null>(null);
  const [saveIssues, setSaveIssues] = useState<any[]>([]);

  const loaded = useAsync(
    () =>
      api.get<{ timecard: Timecard | null; decision: EditDecision; shifts: ScheduleShift[] }>(
        `/timecards/${userId}/${date}`,
      ),
    [userId, date],
  );

  useEffect(() => {
    if (loaded.data?.timecard) {
      setRows(loaded.data.timecard.rows);
      setDirty(false);
      setSaveIssues([]);
    }
  }, [loaded.data]);

  const card = loaded.data?.timecard ?? null;
  const decision = loaded.data?.decision;
  const readOnly = !decision?.allowed || !user?.isSupervisor || !!card?.approved;

  const totals = useMemo(() => {
    let paid = 0;
    for (const row of rows) {
      const code = catalog?.codes.find((c) => c.code === row.code);
      const activity = catalog?.activities.find((a) => a.code === row.activity);
      if (code?.paid && activity?.paid) paid += toMinutes(row.endAt) - toMinutes(row.startAt);
    }
    return paid;
  }, [rows, catalog]);

  function update(index: number, patch: Partial<TimecardRow>) {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
    setDirty(true);
  }

  function updateTime(index: number, field: 'startAt' | 'endAt', time: string) {
    setRows((current) => {
      const next = current.map((row, i) => (i === index ? { ...row, [field]: withTime(row[field], time) } : row));
      // Re-derive dates across the card so a time typed past midnight lands on
      // the right day rather than creating a negative duration.
      const anchor = next[0]?.startAt ?? `${date} 00:00`;
      const stamps = rollForward(
        next.flatMap((r) => [r.startAt, r.endAt]),
        anchor,
      );
      return next.map((row, i) => ({ ...row, startAt: stamps[i * 2], endAt: stamps[i * 2 + 1] }));
    });
    setDirty(true);
  }

  function insertBelow(index: number) {
    setRows((current) => {
      const anchor = current[index]?.endAt ?? `${date} 00:00`;
      const copy = [...current];
      copy.splice(index + 1, 0, EMPTY_ROW(current[index]?.project ?? user?.projectId ?? '', anchor));
      return copy;
    });
    setDirty(true);
  }

  function removeRow(index: number) {
    setRows((current) => current.filter((_, i) => i !== index));
    setSelected(null);
    setDirty(true);
  }

  async function save() {
    setFlash(null);
    setSaveIssues([]);
    try {
      const res = await api.put<{ ok: boolean; issues: any[]; decision: EditDecision }>(
        `/timecards/${userId}/${date}`,
        { rows: rows.map(({ id: _id, ...rest }) => rest) },
      );
      setSaveIssues(res.issues);
      setFlash({
        tone: res.decision.postPayroll ? 'warn' : 'good',
        text: res.decision.postPayroll
          ? 'Saved as a post-payroll correction. It transfers on the next payroll run.'
          : 'Timecard saved.',
      });
      setDirty(false);
      loaded.reload();
    } catch (err: any) {
      setSaveIssues(err.body?.issues ?? []);
      setFlash({ tone: 'error', text: err.message });
    }
  }

  async function approve(next: boolean) {
    try {
      const res = await api.post<{ message: string }>(`/timecards/${userId}/${date}/approve`, { approved: next });
      setFlash({ tone: 'good', text: res.message });
      loaded.reload();
    } catch (err) {
      setFlash({ tone: 'error', text: (err as Error).message });
    }
  }

  async function rebuild() {
    try {
      await api.post(`/timecards/${userId}/${date}/rebuild`);
      setFlash({ tone: 'good', text: 'Rebuilt from the punch record. Any manual edits were discarded.' });
      loaded.reload();
    } catch (err) {
      setFlash({ tone: 'error', text: (err as Error).message });
    }
  }

  if (loaded.loading) return <Loading what="timecard" />;
  if (loaded.error) return <Banner tone="error">{loaded.error}</Banner>;
  if (!card) return <Empty>No timecard exists for that date.</Empty>;

  return (
    <>
      <Toolbar>
        <Button onClick={() => navigate('/time')}>← Payroll Summary</Button>
        <div style={{ flex: 1 }} />
        <div className="stats">
          <Stat label="Regular" value={card.summary.formatted.regular} />
          <Stat label="Overtime" value={card.summary.formatted.overtime} />
          <Stat label="Absence" value={card.summary.formatted.absence} tone={card.summary.formatted.absence !== '00:00' ? 'warn' : undefined} />
          <Stat label="Unpaid meal" value={card.summary.formatted.unpaidMeal} />
          <Stat label="Unsaved paid" value={durationOf(totals)} tone={dirty ? 'warn' : undefined} />
        </div>
      </Toolbar>

      <Card
        title={`${card.userName} — ${card.payrollDate}`}
        subtitle={`${card.employeeId} · shift ${card.shiftNo}`}
        actions={
          <>
            {!readOnly && (
              <Button variant="primary" onClick={save} disabled={!dirty}>
                Save
              </Button>
            )}
            {user?.isSupervisor && (
              <Button onClick={() => approve(!card.approved)} disabled={card.inProgress}>
                {card.approved ? 'Remove approval' : 'Approve'}
              </Button>
            )}
            {user?.isSupervisor && !card.approved && (
              <Button variant="ghost" onClick={rebuild} title="Discard edits and rebuild from punches">
                Rebuild from punches
              </Button>
            )}
          </>
        }
      >
        {flash && <Banner tone={flash.tone === 'warn' ? 'warn' : flash.tone === 'error' ? 'error' : 'good'}>{flash.text}</Banner>}

        {decision && !decision.allowed && <Banner tone="error">{decision.reason}</Banner>}
        {decision?.postPayroll && decision.allowed && <Banner tone="warn">{decision.reason}</Banner>}
        {card.approved && <Banner tone="good">Approved by {card.approvedBy} at {card.approvedAt}. Remove the approval to edit.</Banner>}
        {card.assumedOff && (
          <Banner tone="warn">
            No clock off punch. The scheduled end has been assumed — check the last row before approving.
          </Banner>
        )}
        {card.inProgress && <Banner tone="info">This shift is still running. The card is provisional.</Banner>}
        {card.notes.map((note, i) => (
          <p key={i} className="muted">
            {note}
          </p>
        ))}

        <div className="table-scroll">
          <table className="sched-table">
            <thead>
              <tr>
                <th className="radio-cell" />
                <th>Code</th>
                <th>Project</th>
                <th>Activity</th>
                <th>Start</th>
                <th>End</th>
                <th className="right">Duration</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => {
                const minutes = toMinutes(row.endAt) - toMinutes(row.startAt);
                return (
                  <tr key={i} className={selected === i ? 'selected' : ''}>
                    <td className="radio-cell">
                      <input type="radio" name="row" checked={selected === i} onChange={() => setSelected(i)} />
                    </td>
                    <td>
                      <select value={row.code} disabled={readOnly} onChange={(e) => update(i, { code: e.target.value })}>
                        {catalog?.codes.map((c) => (
                          <option key={c.code} value={c.code} title={c.description}>
                            {c.code} {c.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        style={{ width: '5rem' }}
                        className="mono"
                        value={row.project}
                        disabled={readOnly}
                        onChange={(e) => update(i, { project: e.target.value })}
                      />
                    </td>
                    <td>
                      <select
                        value={row.activity}
                        disabled={readOnly}
                        onChange={(e) => update(i, { activity: e.target.value })}
                      >
                        {catalog?.activities.map((a) => (
                          <option key={a.code} value={a.code}>
                            {a.code} {a.name}
                            {a.paid ? '' : ' (unpaid)'}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <TimeInput
                        value={timeOf(row.startAt)}
                        disabled={readOnly}
                        title={row.startAt}
                        onChange={(t) => updateTime(i, 'startAt', t)}
                      />
                      {row.startAt.slice(0, 10) !== card.payrollDate && (
                        <div className="muted mono">{row.startAt.slice(0, 10)}</div>
                      )}
                    </td>
                    <td>
                      <TimeInput
                        value={timeOf(row.endAt)}
                        disabled={readOnly}
                        title={row.endAt}
                        onChange={(t) => updateTime(i, 'endAt', t)}
                      />
                    </td>
                    <td className={`right num ${minutes < 0 ? 'chip-error' : ''}`}>{durationBetween(row.startAt, row.endAt)}</td>
                    <td className="nowrap">
                      {!readOnly && (
                        <>
                          <Button variant="ghost" title="Insert a row below" onClick={() => insertBelow(i)}>
                            +
                          </Button>
                          <Button variant="ghost" title="Delete this row" onClick={() => removeRow(i)}>
                            ×
                          </Button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <Issues issues={[...saveIssues, ...card.issues]} />
      </Card>

      <div className="grid-2">
        <Card title="Payroll shift detail" tone="quiet">
          <table>
            <tbody>
              <tr>
                <th>Payroll date</th>
                <td className="mono">{card.payrollDate}</td>
              </tr>
              <tr>
                <th>Start</th>
                <td>
                  <Stamp value={card.detail.startAt ?? ''} />
                  <span className={card.detail.startDate === card.payrollDate ? '' : 'chip chip-error'}>
                    {card.detail.startDate === card.payrollDate ? '' : ' start date must equal the payroll date'}
                  </span>
                </td>
              </tr>
              <tr>
                <th>End</th>
                <td>
                  <Stamp value={card.detail.endAt ?? ''} />
                  {card.detail.crossesMidnight && <Chip label="crosses midnight" tone="accent" />}
                </td>
              </tr>
              <tr>
                <th>Protect date</th>
                <td className="mono">
                  {card.protectDate ?? <span className="muted">not set — payroll has not run for this period</span>}
                </td>
              </tr>
              <tr>
                <th>Manual check</th>
                <td>
                  <ManualCheck card={card} userId={Number(userId)} date={date!} onDone={loaded.reload} />
                </td>
              </tr>
            </tbody>
          </table>
        </Card>

        <Card title="Scheduled shift" tone="quiet">
          {loaded.data?.shifts.length === 0 && <Empty>Nothing scheduled on this date.</Empty>}
          {loaded.data?.shifts.map((shift) => (
            <div key={shift.shiftNo}>
              <div className="shift-head">
                <strong>Shift {shift.shiftNo}</strong>
                <span className="muted">ends {shift.endAt.slice(11)}</span>
              </div>
              <table>
                <tbody>
                  {shift.rows.map((row, i) => (
                    <tr key={i}>
                      <td className="mono">{row.startAt.slice(11)}</td>
                      <td>{catalog?.scheduleActivities.find((s) => s.key === row.activityKey)?.name ?? row.activityKey}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </Card>
      </div>
    </>
  );
}

function ManualCheck({
  card,
  userId,
  date,
  onDone,
}: {
  card: Timecard;
  userId: number;
  date: string;
  onDone: () => void;
}) {
  const { catalog } = useSession();
  const [error, setError] = useState<string | null>(null);

  async function change(status: string) {
    setError(null);
    try {
      await api.post(`/timecards/${userId}/${date}/manual-check`, { status });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      <select value={card.manualCheckStatus} onChange={(e) => change(e.target.value)} disabled={!card.protectDate}>
        {catalog?.manualCheckStatuses.map((s) => (
          <option key={s} value={s}>
            {s.replace(/_/g, ' ').toLowerCase()}
          </option>
        ))}
      </select>
      {error && <div className="muted">{error}</div>}
    </>
  );
}

/** A month of one person's worked time, for spotting patterns rather than editing. */
function WorkedCalendar() {
  const { user, groups } = useSession();
  const [group, setGroup] = useState('-Me');
  const [start, setStart] = useState(addDays(today(), -28));
  const [end, setEnd] = useState(today());

  const data = useAsync(
    () =>
      api.get<{ rows: PayrollSummaryRow[] }>(
        `/payroll/summary?group=${encodeURIComponent(group)}&start=${start}&end=${end}`,
      ),
    [group, start, end],
  );

  const byPerson = useMemo(() => {
    const map = new Map<string, PayrollSummaryRow[]>();
    for (const row of data.data?.rows ?? []) {
      const list = map.get(row.name) ?? [];
      list.push(row);
      map.set(row.name, list);
    }
    return [...map.entries()];
  }, [data.data]);

  return (
    <>
      <Toolbar>
        {user?.isSupervisor && <GroupPicker groups={groups} value={group} onChange={setGroup} />}
        <DateField label="From" value={start} onChange={setStart} />
        <DateField label="To" value={end} onChange={setEnd} />
      </Toolbar>

      {data.loading && <Loading what="worked calendar" />}
      {byPerson.length === 0 && !data.loading && <Empty>No worked time in that range.</Empty>}

      {byPerson.map(([name, rows]) => (
        <Card key={name} title={name} subtitle={`${rows.length} days`}>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th className="right">Regular</th>
                  <th className="right">Absence</th>
                  <th>Codes</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.payrollDate}>
                    <td className="mono">{row.payrollDate}</td>
                    <td className="right num">{row.regular}</td>
                    <td className="right num">{row.absence}</td>
                    <td>
                      {row.codes.map((c) => (
                        <CodeChip key={c} code={c} />
                      ))}
                    </td>
                    <td>{row.approved ? <Chip label="approved" tone="good" /> : <Chip label="open" tone="warn" />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ))}
    </>
  );
}

function durationOf(minutes: number): string {
  const sign = minutes < 0 ? '-' : '';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

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
import { useLiveEvent } from '../live';
import { useToast } from '../components/Toast';
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
  SkeletonTable,
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
  const toast = useToast();
  const [group, setGroup] = useState('');
  const [start, setStart] = useState(addDays(today(), -3));
  const [end, setEnd] = useState(today());
  const [busy, setBusy] = useState(false);
  /** Rows whose approval is in flight, shown as approved before the server says so. */
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});
  // Forty advisors across a week is 280 rows, and the twelve that need reading
  // are scattered through it. Without these the screen is a wall.
  const [filter, setFilter] = useState<'all' | 'unapproved' | 'exceptions' | 'errors'>('all');
  const [sort, setSort] = useState<'date' | 'name' | 'exceptions'>('date');
  const [search, setSearch] = useState('');

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

  // Somebody else approving a card, or an advisor clocking off, changes what is
  // on this screen. Refresh when it happens rather than when it is noticed.
  useLiveEvent(['timecard.approved', 'timecard.saved', 'punch'], () => summary.reload());

  /**
   * Approval, applied to the checkbox immediately and rolled back if the server
   * refuses. The refusals here are real — a card with errors, a shift still
   * running — so the rollback has to be visible, not silent.
   */
  async function toggleApproval(row: PayrollSummaryRow, approved: boolean) {
    const key = `${row.userId}-${row.payrollDate}`;
    setOptimistic((current) => ({ ...current, [key]: approved }));
    try {
      const res = await api.post<{ ok: boolean; message: string }>(
        `/timecards/${row.userId}/${row.payrollDate}/approve`,
        { approved },
      );
      if (res.ok) toast.success(res.message, `${row.name} · ${row.payrollDate}`);
      else {
        setOptimistic((current) => ({ ...current, [key]: !approved }));
        toast.warn(res.message, `${row.name} · ${row.payrollDate}`);
      }
      summary.reload();
    } catch (err) {
      // Put the checkbox back where the user found it, and say why.
      setOptimistic((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      toast.error((err as Error).message, `${row.name} · ${row.payrollDate}`);
    }
  }

  /**
   * The payroll file: one row per advisor, per day, per code, approved only.
   *
   * Everything else in this tool stops at a screen. Without this the last step
   * is somebody reading figures off a monitor and retyping them somewhere else,
   * which is exactly where the errors the product exists to prevent get put
   * back in.
   */
  async function exportPayroll() {
    try {
      const res = await api.get<{ rows: any[] }>(
        `/payroll/export?group=${encodeURIComponent(group)}&start=${start}&end=${end}`,
      );
      if (res.rows.length === 0) {
        toast.warn('Nothing approved in that range to export.', 'Approve the cards first.');
        return;
      }
      const header = ['employee_id', 'name', 'payroll_date', 'code', 'project', 'activity', 'minutes'];
      const csv = [
        header.join(','),
        ...res.rows.map((r) =>
          [r.employeeId, r.name, r.payrollDate, r.code, r.project, r.activity, r.minutes]
            .map((v) => JSON.stringify(v ?? ''))
            .join(','),
        ),
      ].join('\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `pulse-payroll-${start}-to-${end}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${res.rows.length} lines.`, 'Approved cards only.');
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  /** Approve everything the server judges clean. It decides, not this screen. */
  async function approveClean() {
    setBusy(true);
    try {
      const res = await api.post<{
        approved: string[];
        skipped: { name: string; date: string; reason: string }[];
        message: string;
      }>('/payroll/approve-clean', { group, start, end });

      if (res.approved.length === 0) {
        toast.warn(res.message, 'Every remaining card needs a person to look at it.');
      } else {
        toast.success(
          res.message,
          res.skipped.length > 0
            ? res.skipped
                .slice(0, 4)
                .map((s) => `${s.name} ${s.date}: ${s.reason}`)
                .join(' · ')
            : undefined,
        );
      }
      setOptimistic({});
      summary.reload();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const allRows = (summary.data?.rows ?? []).map((row) => {
    const pendingChange = optimistic[`${row.userId}-${row.payrollDate}`];
    return pendingChange === undefined ? row : { ...row, approved: pendingChange };
  });
  const pending = allRows.filter((r) => !r.approved && !r.inProgress).length;
  const withExceptions = allRows.filter((r) => r.exceptions.length > 0).length;

  const needle = search.trim().toLowerCase();
  const rows = allRows
    .filter((r) => {
      if (filter === 'unapproved' && (r.approved || r.inProgress)) return false;
      if (filter === 'exceptions' && r.exceptions.length === 0) return false;
      if (filter === 'errors' && !r.hasErrors && !r.assumedOff) return false;
      if (needle && !`${r.name} ${r.employeeId}`.toLowerCase().includes(needle)) return false;
      return true;
    })
    .sort((a, b) => {
      // Sorting by exception count puts the cards that need a person to read
      // them at the top, which is the entire job on this screen.
      if (sort === 'exceptions') {
        const diff = b.exceptions.length - a.exceptions.length;
        if (diff !== 0) return diff;
      }
      if (sort === 'name') {
        const diff = a.name.localeCompare(b.name);
        if (diff !== 0) return diff;
      }
      return a.payrollDate.localeCompare(b.payrollDate) || a.name.localeCompare(b.name);
    });
  // The same test the server applies, so the button's count is honest.
  const cleanCount = rows.filter(
    (r) =>
      !r.approved &&
      !r.inProgress &&
      !r.hasErrors &&
      !r.assumedOff &&
      r.exceptions.length === 0 &&
      r.payrollDate < today(),
  ).length;

  return (
    <>
      <Toolbar>
        <GroupPicker groups={groups} value={group} onChange={setGroup} />
        <DateField label="Start" value={start} onChange={setStart} />
        <DateField label="End" value={end} onChange={setEnd} />
        <Button onClick={() => summary.reload()}>Go</Button>
        <Button onClick={exportPayroll} title="One row per advisor, per day, per code — approved cards only">
          Payroll file
        </Button>
        <Button
          variant="primary"
          data-tour="bulk-approve"
          onClick={approveClean}
          disabled={busy || cleanCount === 0}
          title="Approves only cards with no exceptions, no errors, a real clock-off and a finished day"
        >
          {busy ? 'Approving…' : `Approve ${cleanCount} clean`}
        </Button>
        <div style={{ flex: 1 }} />
        <div className="stats">
          <Stat label="Timecards" value={rows.length} />
          <Stat label="Unapproved" value={pending} tone={pending > 0 ? 'warn' : 'good'} />
          <Stat label="With exceptions" value={withExceptions} tone={withExceptions > 0 ? 'warn' : undefined} />
        </div>
      </Toolbar>

      <Toolbar>
        <div className="segmented" role="group" aria-label="Filter timecards">
          {(
            [
              ['all', `All ${allRows.length}`],
              ['unapproved', `Unapproved ${pending}`],
              ['exceptions', `Exceptions ${withExceptions}`],
              ['errors', 'Needs a look'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              className={filter === key ? 'active' : ''}
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="field">
          <span>Sort by</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
            <option value="date">Date</option>
            <option value="name">Advisor</option>
            <option value="exceptions">Exceptions first</option>
          </select>
        </label>
        <label className="field" style={{ flex: 1, minWidth: '10rem' }}>
          <span>Find an advisor</span>
          <input
            value={search}
            placeholder="Name or employee ID"
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        {rows.length !== allRows.length && (
          <span className="muted">
            {rows.length} of {allRows.length} shown
          </span>
        )}
      </Toolbar>

      {user && (
        <p className="muted" style={{ marginBottom: '0.6rem' }}>
          Your edit window is {user.editWindowDays} days. Cards older than that must go to your Operations Manager.
          Bulk approval deliberately skips anything carrying an exception — those are the ones worth reading.
        </p>
      )}

      <Card>
        {summary.loading && !summary.data && <SkeletonTable rows={7} columns={9} />}
        {summary.error && <Banner tone="error">{summary.error}</Banner>}
        {!summary.loading && rows.length === 0 && (
          <Empty>
            {allRows.length === 0
              ? 'No timecards in that range.'
              : 'Nothing matches that filter. Everything in range is already clean.'}
          </Empty>
        )}

        {rows.length > 0 && (
          <div className="table-scroll">
            <table aria-label="Timecards and their approval state">
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
                        // Eighteen identical "checkbox, checked" announcements
                        // is not a usable approvals screen. The name has to
                        // carry whose card and which day.
                        aria-label={`Approve ${row.name}'s timecard for ${row.payrollDate}`}
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
  const toast = useToast();

  const [rows, setRows] = useState<TimecardRow[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveIssues, setSaveIssues] = useState<any[]>([]);
  /** Required once payroll has run over this date; the server insists too. */
  const [reason, setReason] = useState('');

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

  /**
   * Keyboard flow across the grid.
   *
   * A supervisor correcting thirty cards a day was reaching for the mouse on
   * every field. Arrow keys move between rows, Ctrl-Enter saves, and Alt-Enter
   * and Alt-Backspace add and remove a row — so a whole card can be corrected
   * without leaving the keyboard, which is the difference between a tool people
   * tolerate and one they are fast in.
   *
   * Plain Enter is deliberately not save: in a grid of inputs it is the key
   * people press to move on, and binding it to a write would cost somebody a
   * half-finished card.
   */
  function onGridKeyDown(e: React.KeyboardEvent<HTMLTableSectionElement>) {
    if (readOnly) return;
    const target = e.target as HTMLElement;
    const cell = target.closest('td');
    const row = target.closest('tr');
    if (!row) return;
    const index = Number(row.dataset.row);
    if (!Number.isFinite(index)) return;

    // Let the browser handle text editing within a field.
    const editing = target.tagName === 'INPUT' || target.tagName === 'SELECT';

    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && (!editing || e.altKey || target.tagName === 'INPUT')) {
      if (target.tagName === 'SELECT' && !e.altKey) return; // arrows change the option
      e.preventDefault();
      const next = e.key === 'ArrowDown' ? index + 1 : index - 1;
      if (next < 0 || next >= rows.length) return;
      setSelected(next);
      const column = cell ? Array.from(row.children).indexOf(cell) : 1;
      const destination = document.querySelector<HTMLElement>(`tr[data-row="${next}"]`);
      const field = destination?.children[column]?.querySelector<HTMLElement>('input, select');
      (field ?? destination)?.focus();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (dirty) void save();
    } else if (e.key === 'Enter' && e.altKey) {
      e.preventDefault();
      insertBelow(index);
    } else if (e.key === 'Backspace' && e.altKey) {
      e.preventDefault();
      if (rows.length > 1) removeRow(index);
    }
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
    setSaveIssues([]);
    try {
      const res = await api.put<{ ok: boolean; issues: any[]; decision: EditDecision }>(
        `/timecards/${userId}/${date}`,
        {
          rows: rows.map(({ id: _id, ...rest }) => rest),
          correctionReason: reason.trim() || undefined,
        },
      );
      setSaveIssues(res.issues);
      if (res.decision.postPayroll) {
        toast.warn(
          'Saved as a post-payroll correction.',
          'It transfers on the next payroll run rather than this one.',
        );
      } else {
        toast.success('Timecard saved.', `${card?.userName ?? ''} · ${date}`);
      }
      setDirty(false);
      loaded.reload();
    } catch (err: any) {
      // The issues list is the useful part of a refusal; the toast is the part
      // that makes sure it was noticed.
      setSaveIssues(err.body?.issues ?? []);
      toast.error(err.message, 'Nothing was saved — the card is unchanged on the server.');
    }
  }

  async function approve(next: boolean) {
    try {
      const res = await api.post<{ ok: boolean; message: string }>(`/timecards/${userId}/${date}/approve`, {
        approved: next,
      });
      if (res.ok) toast.success(res.message);
      else toast.warn(res.message);
      loaded.reload();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function rebuild() {
    try {
      await api.post(`/timecards/${userId}/${date}/rebuild`);
      toast.success('Rebuilt from the punch record.', 'Any manual edits to this card were discarded.');
      loaded.reload();
    } catch (err) {
      toast.error((err as Error).message);
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
              <Button
                variant="primary"
                onClick={save}
                disabled={!dirty || (!!decision?.postPayroll && !reason.trim())}
                title={
                  decision?.postPayroll && !reason.trim()
                    ? 'Give a reason for the correction first'
                    : 'Save (Ctrl-Enter)'
                }
              >
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
        {decision && !decision.allowed && <Banner tone="error">{decision.reason}</Banner>}
        {decision?.postPayroll && decision.allowed && (
          <>
            <Banner tone="warn">{decision.reason}</Banner>
            {/* A correction to a period that has already been paid is a
                financial adjustment. "Somebody edited it" is not an answer at
                audit, so the reason is required rather than encouraged. */}
            <label className="field" style={{ marginBottom: '0.7rem' }}>
              <span>Reason for this correction (required, goes on the audit record)</span>
              <input
                value={reason}
                placeholder="e.g. Advisor worked the overtime; missed on the original run"
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
          </>
        )}
        {card?.correctionReason && (
          <Banner tone="info">Corrected after payroll: {card.correctionReason}</Banner>
        )}
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
            <tbody onKeyDown={onGridKeyDown}>
              {rows.map((row, i) => {
                const minutes = toMinutes(row.endAt) - toMinutes(row.startAt);
                return (
                  <tr key={i} data-row={i} className={selected === i ? 'selected' : ''}>
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

        {!readOnly && (
          <p className="muted keys">
            <kbd>↑</kbd> <kbd>↓</kbd> move between rows · <kbd>Alt</kbd>+<kbd>↵</kbd> insert a row ·{' '}
            <kbd>Alt</kbd>+<kbd>⌫</kbd> delete one · <kbd>Ctrl</kbd>+<kbd>↵</kbd> save
          </p>
        )}

        <Issues issues={[...saveIssues, ...card.issues]} />
      </Card>

      <div className="grid-2">
        <Card title="Payroll shift detail" tone="quiet">
          <table aria-label="Timecard rows">
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

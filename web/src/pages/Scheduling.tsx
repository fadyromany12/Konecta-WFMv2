import { useEffect, useMemo, useState } from 'react';
import { Route, Routes, useSearchParams } from 'react-router-dom';
import { SubTabs } from '../App';
import { api, type Person, type ScheduleShift } from '../api';
import { useAsync, useSession } from '../state';
import { useToast } from '../components/Toast';
import {
  Banner,
  Button,
  Card,
  Chip,
  DateField,
  Empty,
  GroupPicker,
  Issues,
  SkeletonTable,
  TimeInput,
  Toolbar,
} from '../components/ui';
import { addDays, durationBetween, rollForward, timeOf, today, withTime } from '../lib/time';
import { Planning } from './Planning';
import { ForecastEntry } from './ForecastEntry';
import { TeamWeek } from './TeamWeek';
import { MultiSkill } from './MultiSkill';

export function Scheduling() {
  return (
    <>
      <SubTabs
        items={[
          { to: '/scheduling', label: 'Edit Advisor Schedule' },
          { to: '/scheduling/week', label: 'Team Week' },
          { to: '/scheduling/group', label: 'Group Schedule Exceptions' },
          { to: '/scheduling/forecast', label: 'Forecast & Coverage' },
          { to: '/scheduling/volumes', label: 'Enter Forecast' },
          { to: '/scheduling/skills', label: 'Multi-Skill' },
        ]}
      />
      <Routes>
        <Route index element={<EditSchedule />} />
        <Route path="week" element={<TeamWeek />} />
        <Route path="group" element={<GroupExceptions />} />
        <Route path="forecast" element={<Planning />} />
        <Route path="volumes" element={<ForecastEntry />} />
        <Route path="skills" element={<MultiSkill />} />
      </Routes>
    </>
  );
}

/**
 * The schedule editor. A row is a start time plus an activity; its end is the
 * next row's start. Insert Row Above, Delete Row and Add Shift are the three
 * gestures that cover almost every real edit.
 */
function EditSchedule() {
  const { groups, catalog } = useSession();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [group, setGroup] = useState('');
  // The command palette lands here with ?userId=, so the screen opens on the
  // person you asked for rather than whoever is first alphabetically.
  const [personId, setPersonId] = useState<number | null>(
    params.get('userId') ? Number(params.get('userId')) : null,
  );
  const [date, setDate] = useState(params.get('date') ?? today());
  const [shifts, setShifts] = useState<ScheduleShift[]>([]);
  const [selected, setSelected] = useState<{ shift: number; row: number } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [issues, setIssues] = useState<any[]>([]);

  useEffect(() => {
    if (!group && groups.length > 0) setGroup(groups.find((g) => g.type === 'SYSTEM')?.key ?? groups[0].key);
  }, [groups, group]);

  // Follow the URL when the palette is used again while already on this screen.
  useEffect(() => {
    const requested = params.get('userId');
    if (requested && Number(requested) !== personId) setPersonId(Number(requested));
  }, [params, personId]);

  // A shift clicked in the team week arrives with a day attached. Keyed on the
  // parameter rather than on `date`, so picking a different day afterwards is
  // not immediately snapped back to whatever the URL still says.
  const dateParam = params.get('date');
  useEffect(() => {
    if (dateParam) setDate(dateParam);
  }, [dateParam]);

  const people = useAsync(
    () => (group ? api.get<{ people: Person[] }>(`/people?group=${encodeURIComponent(group)}`) : Promise.resolve({ people: [] })),
    [group],
  );

  useEffect(() => {
    const list = people.data?.people ?? [];
    if (list.length > 0 && !list.some((p) => p.id === personId)) setPersonId(list[0].id);
  }, [people.data, personId]);

  function choosePerson(id: number) {
    setPersonId(id);
    // Keep the URL honest so the screen can be shared or reloaded.
    setParams({ userId: String(id) }, { replace: true });
  }

  const schedule = useAsync(
    () =>
      personId
        ? api.get<{ days: { date: string; shifts: ScheduleShift[] }[] }>(`/schedules/${personId}?start=${date}&end=${date}`)
        : Promise.resolve({ days: [] }),
    [personId, date],
  );

  useEffect(() => {
    setShifts(schedule.data?.days[0]?.shifts ?? []);
    setDirty(false);
    setIssues([]);
  }, [schedule.data]);

  function mutate(next: ScheduleShift[]) {
    setShifts(next);
    setDirty(true);
  }

  function updateRowTime(shiftIndex: number, rowIndex: number, time: string) {
    const next = shifts.map((shift, si) => {
      if (si !== shiftIndex) return shift;
      const rows = shift.rows.map((row, ri) => (ri === rowIndex ? { ...row, startAt: withTime(row.startAt, time) } : row));
      // Times are authoritative; dates follow from them.
      const stamps = rollForward([...rows.map((r) => r.startAt), shift.endAt], rows[0].startAt);
      return {
        ...shift,
        rows: rows.map((r, i) => ({ ...r, startAt: stamps[i] })),
        endAt: stamps[stamps.length - 1],
      };
    });
    mutate(next);
  }

  function updateEnd(shiftIndex: number, time: string) {
    mutate(
      shifts.map((shift, si) => {
        if (si !== shiftIndex) return shift;
        const stamps = rollForward([...shift.rows.map((r) => r.startAt), withTime(shift.endAt, time)], shift.rows[0].startAt);
        return { ...shift, endAt: stamps[stamps.length - 1] };
      }),
    );
  }

  function updateActivity(shiftIndex: number, rowIndex: number, activityKey: string) {
    mutate(
      shifts.map((shift, si) =>
        si === shiftIndex
          ? { ...shift, rows: shift.rows.map((row, ri) => (ri === rowIndex ? { ...row, activityKey } : row)) }
          : shift,
      ),
    );
  }

  function insertAbove() {
    if (!selected) return;
    mutate(
      shifts.map((shift, si) => {
        if (si !== selected.shift) return shift;
        const anchor = shift.rows[selected.row];
        const rows = [...shift.rows];
        rows.splice(selected.row, 0, { startAt: anchor.startAt, activityKey: 'OPEN_TIME' });
        return { ...shift, rows };
      }),
    );
  }

  function deleteRow() {
    if (!selected) return;
    mutate(
      shifts.map((shift, si) =>
        si === selected.shift ? { ...shift, rows: shift.rows.filter((_, ri) => ri !== selected.row) } : shift,
      ),
    );
    setSelected(null);
  }

  function addShift() {
    const shiftNo = Math.max(0, ...shifts.map((s) => s.shiftNo)) + 1;
    mutate([
      ...shifts,
      {
        shiftNo,
        rows: [{ startAt: `${date} 08:00`, activityKey: 'EXTRA_HOURS' }],
        endAt: `${date} 12:00`,
      },
    ]);
  }

  async function save() {
    setIssues([]);
    try {
      const res = await api.put<{ ok: boolean; issues: any[] }>(`/schedules/${personId}/${date}`, { shifts });
      setIssues(res.issues);
      toast.success('Schedule saved.', 'The timecard has been re-derived from the new plan.');
      setDirty(false);
      schedule.reload();
    } catch (err: any) {
      setIssues(err.body?.issues ?? []);
      toast.error(err.message, 'Nothing was saved — the schedule is unchanged.');
    }
  }

  const person = people.data?.people.find((p) => p.id === personId);

  return (
    <>
      <Toolbar>
        <GroupPicker groups={groups} value={group} onChange={setGroup} />
        <label className="field">
          <span>Advisor</span>
          <select value={personId ?? ''} onChange={(e) => choosePerson(Number(e.target.value))}>
            {people.data?.people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.employee_id})
              </option>
            ))}
          </select>
        </label>
        <DateField label="Date" value={date} onChange={setDate} />
        <Button onClick={() => schedule.reload()}>Go</Button>
      </Toolbar>

      <Card
        title={person ? `${person.name} — ${date}` : 'Schedule'}
        subtitle="A row runs until the next row starts. Times use a 24 hour clock; the date follows from the times."
        actions={
          <>
            <Button onClick={insertAbove} disabled={!selected}>
              Insert row above
            </Button>
            <Button onClick={deleteRow} disabled={!selected}>
              Delete row
            </Button>
            <Button onClick={addShift}>Add shift</Button>
            <Button variant="primary" onClick={save} disabled={!dirty}>
              Save
            </Button>
          </>
        }
      >
        {schedule.loading && !schedule.data && <SkeletonTable rows={5} columns={5} />}
        {!schedule.loading && shifts.length === 0 && <Empty>Nothing scheduled. Use Add shift to create one.</Empty>}

        {shifts.map((shift, si) => (
          <div key={shift.shiftNo}>
            <div className="shift-head">
              <strong>Shift {shift.shiftNo}</strong>
              <span className="muted">
                {shift.rows[0]?.startAt.slice(0, 10)} · {durationBetween(shift.rows[0]?.startAt ?? shift.endAt, shift.endAt)} long
              </span>
            </div>
            <div className="table-scroll">
              <table className="sched-table">
                <thead>
                  <tr>
                    <th className="radio-cell" />
                    <th>Time</th>
                    <th>Date</th>
                    <th>Schedule activity</th>
                    <th className="right">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {shift.rows.map((row, ri) => {
                    const endAt = ri + 1 < shift.rows.length ? shift.rows[ri + 1].startAt : shift.endAt;
                    return (
                      <tr key={ri} className={selected?.shift === si && selected?.row === ri ? 'selected' : ''}>
                        <td className="radio-cell">
                          <input
                            type="radio"
                            name="schedrow"
                            checked={selected?.shift === si && selected?.row === ri}
                            onChange={() => setSelected({ shift: si, row: ri })}
                          />
                        </td>
                        <td>
                          <TimeInput value={timeOf(row.startAt)} onChange={(t) => updateRowTime(si, ri, t)} />
                        </td>
                        <td className="mono muted">{row.startAt.slice(0, 10)}</td>
                        <td>
                          <select value={row.activityKey} onChange={(e) => updateActivity(si, ri, e.target.value)}>
                            {catalog?.scheduleActivities
                              .filter((s) => s.key !== 'SHIFT_END')
                              .map((s) => (
                                <option key={s.key} value={s.key}>
                                  {s.name}
                                </option>
                              ))}
                          </select>
                        </td>
                        <td className="right num">{durationBetween(row.startAt, endAt)}</td>
                      </tr>
                    );
                  })}
                  <tr>
                    <td className="radio-cell" />
                    <td>
                      <TimeInput value={timeOf(shift.endAt)} onChange={(t) => updateEnd(si, t)} />
                    </td>
                    <td className="mono muted">{shift.endAt.slice(0, 10)}</td>
                    <td>
                      <em className="muted">End of Shift</em>
                    </td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        ))}

        <Issues issues={issues} />
      </Card>
    </>
  );
}

/** Drop one exception across a whole group — a team meeting, a focus group. */
function GroupExceptions() {
  const { groups, catalog } = useSession();
  const toast = useToast();
  const [group, setGroup] = useState('');
  const [date, setDate] = useState(today());
  const [activityKey, setActivityKey] = useState('TEAM_MEETING');
  const [startTime, setStartTime] = useState('10:00');
  const [endTime, setEndTime] = useState('10:30');
  const [result, setResult] = useState<{ applied: number[]; skipped: { userId: number; reason: string }[] } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!group && groups.length > 0) setGroup(groups.find((g) => g.type === 'SYSTEM')?.key ?? groups[0].key);
  }, [groups, group]);

  const people = useAsync(
    () => (group ? api.get<{ people: Person[] }>(`/people?group=${encodeURIComponent(group)}`) : Promise.resolve({ people: [] })),
    [group],
  );

  const names = useMemo(() => new Map((people.data?.people ?? []).map((p) => [p.id, p.name])), [people.data]);

  async function apply() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.post<{ applied: number[]; skipped: { userId: number; reason: string }[] }>(
        '/schedules/group-exception',
        { group, date, activityKey, startTime, endTime },
      );
      setResult(res);
      const detail =
        res.skipped.length > 0
          ? `${res.skipped.length} skipped — see the list below for why.`
          : 'Everyone in the group had a shift that could take it.';
      if (res.applied.length > 0) {
        toast.success(
          `Applied to ${res.applied.length} schedule${res.applied.length === 1 ? '' : 's'}.`,
          detail,
        );
      } else {
        toast.warn('Nothing was changed.', detail);
      }
    } catch (err) {
      setError((err as Error).message);
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Undo.
   *
   * Applying a meeting to twenty people took one click and removing it took
   * twenty edits — which meant in practice it never got removed, and a meeting
   * that moved stayed on the schedule counting against everybody's adherence
   * for the rest of the week.
   */
  async function remove() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.post<{ removed: number[]; skipped: { userId: number; reason: string }[] }>(
        '/schedules/group-exception/remove',
        { group, date, activityKey, startTime, endTime },
      );
      setResult({ applied: res.removed, skipped: res.skipped });
      if (res.removed.length > 0) {
        toast.success(
          `Removed from ${res.removed.length} schedule${res.removed.length === 1 ? '' : 's'}.`,
          'The timecards have been re-derived without it.',
        );
      } else {
        toast.warn('Nothing matched.', 'Check the activity and start time are exactly as they were applied.');
      }
    } catch (err) {
      setError((err as Error).message);
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Group Schedule Exceptions"
      subtitle="Insert the same activity into everybody's schedule at once. Anyone without a shift that day is skipped."
    >
      <Toolbar>
        <GroupPicker groups={groups} value={group} onChange={setGroup} />
        <DateField label="Date" value={date} onChange={setDate} />
        <label className="field">
          <span>Activity</span>
          <select value={activityKey} onChange={(e) => setActivityKey(e.target.value)}>
            {catalog?.scheduleActivities
              .filter((s) => !['SHIFT_START', 'SHIFT_END', 'OPEN_TIME'].includes(s.key))
              .map((s) => (
                <option key={s.key} value={s.key}>
                  {s.name}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          <span>From</span>
          <TimeInput value={startTime} onChange={setStartTime} />
        </label>
        <label className="field">
          <span>To</span>
          <TimeInput value={endTime} onChange={setEndTime} />
        </label>
        <Button variant="primary" onClick={apply} disabled={busy}>
          Apply to group
        </Button>
        <Button onClick={remove} disabled={busy} title="Take this exception back off everyone's schedule">
          Remove from group
        </Button>
      </Toolbar>

      {error && <Banner tone="error">{error}</Banner>}

      {result && (
        <>
          <Banner tone={result.applied.length > 0 ? 'good' : 'warn'}>
            Applied to {result.applied.length} schedule{result.applied.length === 1 ? '' : 's'}
            {result.skipped.length > 0 ? `, skipped ${result.skipped.length}.` : '.'}
          </Banner>
          {result.applied.map((id) => (
            <Chip key={id} label={names.get(id) ?? String(id)} tone="good" />
          ))}
          {result.skipped.length > 0 && (
            <ul className="issues">
              {result.skipped.map((s) => (
                <li key={s.userId} className="issue issue-warning">
                  <strong>{names.get(s.userId) ?? s.userId}</strong> {s.reason}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <p className="muted">
        Extra Hours are pre-approved additional hours offered to augment staffing. Flex Up covers unplanned time that
        needs an Operations Manager's approval. Flex Down records an advisor pulled offline while still working.
      </p>
    </Card>
  );
}

/** Exposed for the schedule preview elsewhere. */
export function shiftLabel(shift: ScheduleShift): string {
  return `${shift.rows[0]?.startAt.slice(11) ?? '??'}–${shift.endAt.slice(11)}`;
}

export { addDays };

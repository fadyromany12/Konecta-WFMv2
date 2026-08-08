import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type ScheduleShift } from '../api';
import { useAsync, useSession } from '../state';
import { useToast } from '../components/Toast';
import { Banner, Button, Card, Chip, GroupPicker, SkeletonTable, Toolbar } from '../components/ui';
import { addDays, today } from '../lib/time';

/**
 * The team's week, one screen.
 *
 * The day editor answers "what is Layla doing on Thursday". Nobody opens a
 * scheduling tool with that question — they open it with "who is off on
 * Thursday", "is anyone doing a double", "is Friday covered at all", and none
 * of those could be answered without clicking through fourteen people one day
 * at a time.
 *
 * Shifts drag between days. That is the one bulk edit worth having here: the
 * common change is *when* somebody works, not what they do while working, and
 * moving a whole shift is a gesture where retyping six rows is a chore. Editing
 * the inside of a shift still belongs in the day editor, so a click goes there.
 */

interface TeamWeekPerson {
  userId: number;
  employeeId: string;
  name: string;
  role: string;
  days: { date: string; shifts: ScheduleShift[] }[];
  minutes: number;
}

interface TeamWeekResult {
  start: string;
  end: string;
  dates: string[];
  people: TeamWeekPerson[];
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function weekdayOf(date: string): string {
  return WEEKDAY[new Date(`${date}T00:00:00Z`).getUTCDay()];
}

/** Monday-start week containing the given date. */
function weekStart(date: string): string {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, -((day + 6) % 7));
}

interface Drag {
  userId: number;
  fromDate: string;
  shiftNo: number;
}

export function TeamWeek() {
  const { groups } = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const [group, setGroup] = useState('');
  const [start, setStart] = useState(weekStart(today()));
  const [nonce, setNonce] = useState(0);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const end = addDays(start, 6);

  useEffect(() => {
    if (!group && groups.length > 0) setGroup(groups.find((g) => g.type === 'SYSTEM')?.key ?? groups[0].key);
  }, [groups, group]);

  const week = useAsync<TeamWeekResult | null>(
    () =>
      group
        ? api.get<TeamWeekResult>(
            `/schedules/team?group=${encodeURIComponent(group)}&start=${start}&end=${end}`,
          )
        : Promise.resolve(null),
    [group, start, end, nonce],
  );

  const dates = week.data?.dates ?? [];
  const people = week.data?.people ?? [];

  /** Cover per day, so a thin Friday is visible without counting rows. */
  const perDay = useMemo(() => {
    const counts = new Map<string, number>();
    for (const person of people) {
      for (const day of person.days) {
        if (day.shifts.length > 0) counts.set(day.date, (counts.get(day.date) ?? 0) + 1);
      }
    }
    return counts;
  }, [people]);

  async function drop(toDate: string) {
    const source = drag;
    setDrag(null);
    setOver(null);
    if (!source || source.fromDate === toDate) return;

    setMoving(true);
    try {
      await api.post('/schedules/move', {
        userId: source.userId,
        fromDate: source.fromDate,
        toDate,
        shiftNo: source.shiftNo,
      });
      toast.success(`Shift moved to ${toDate}.`, 'They have been told, and both days were re-derived.');
      setNonce((n) => n + 1);
    } catch (err) {
      toast.error('That move was refused.', (err as Error).message);
    } finally {
      setMoving(false);
    }
  }

  return (
    <>
      <Toolbar>
        <GroupPicker groups={groups} value={group} onChange={setGroup} />
        <Button onClick={() => setStart(addDays(start, -7))}>← Previous</Button>
        <Button onClick={() => setStart(weekStart(today()))}>This week</Button>
        <Button onClick={() => setStart(addDays(start, 7))}>Next →</Button>
        <div style={{ flex: 1 }} />
        <span className="muted">
          {start} to {end}
          {moving ? ' · moving…' : ''}
        </span>
      </Toolbar>

      {week.error && <Banner tone="error">{week.error}</Banner>}
      {week.loading && !week.data && <SkeletonTable rows={8} columns={8} />}

      {week.data && people.length === 0 && (
        <Banner tone="info">Nobody in that group. Pick another from Who.</Banner>
      )}

      {people.length > 0 && (
        <Card
          title="The week"
          subtitle="Drag a shift onto another day to move it. Click one to open that day in the editor."
        >
          <div className="table-scroll">
            <table className="team-week">
              <thead>
                <tr>
                  <th>Advisor</th>
                  {dates.map((date) => (
                    <th key={date} className={date === today() ? 'is-today' : ''}>
                      <div className="tw-head">
                        <span>{weekdayOf(date)}</span>
                        <span className="muted mono">{date.slice(5)}</span>
                        <span className="muted">{perDay.get(date) ?? 0} on</span>
                      </div>
                    </th>
                  ))}
                  <th className="right">Hours</th>
                </tr>
              </thead>
              <tbody>
                {people.map((person) => (
                  <tr key={person.userId}>
                    <th scope="row" className="tw-name">
                      <span>{person.name}</span>
                      <span className="muted mono">{person.employeeId}</span>
                    </th>

                    {person.days.map((day) => {
                      const cellKey = `${person.userId}|${day.date}`;
                      const isTarget = over === cellKey && drag?.userId === person.userId;
                      const past = day.date < today();
                      return (
                        <td
                          key={day.date}
                          className={`tw-cell ${isTarget ? 'is-target' : ''} ${past ? 'is-past' : ''}`}
                          onDragOver={(e) => {
                            // Only this person's own row, and only forwards:
                            // the server refuses anything else, and a drop
                            // target that refuses on release is a worse
                            // interface than one that never lights up.
                            if (!drag || drag.userId !== person.userId || past) return;
                            e.preventDefault();
                            setOver(cellKey);
                          }}
                          onDragLeave={() => setOver((k) => (k === cellKey ? null : k))}
                          onDrop={(e) => {
                            e.preventDefault();
                            void drop(day.date);
                          }}
                        >
                          {day.shifts.length === 0 ? (
                            <span className="tw-off">·</span>
                          ) : (
                            day.shifts.map((shift) => (
                              <button
                                key={shift.shiftNo}
                                type="button"
                                className="tw-shift"
                                draggable={!past}
                                onDragStart={() =>
                                  setDrag({ userId: person.userId, fromDate: day.date, shiftNo: shift.shiftNo })
                                }
                                onDragEnd={() => {
                                  setDrag(null);
                                  setOver(null);
                                }}
                                onClick={() =>
                                  navigate(`/scheduling?userId=${person.userId}&date=${day.date}`)
                                }
                                title={`${person.name} · ${day.date} · open in the day editor`}
                              >
                                <span className="mono">
                                  {shift.rows[0]?.startAt.slice(11) ?? '??'}–{shift.endAt.slice(11)}
                                </span>
                              </button>
                            ))
                          )}
                        </td>
                      );
                    })}

                    <td className="right num">
                      {Math.round((person.minutes / 60) * 10) / 10}
                      {/* Only advisors are meant to have a roster. Flagging a
                          team leader's empty week as a problem would train
                          people to ignore the flag. */}
                      {person.minutes === 0 && person.role === 'ADVISOR' && (
                        <Chip label="none" tone="warn" />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <p className="muted">
        Moving a shift keeps its shape — an overnight shift dragged forward is still overnight. Days that have
        already happened cannot be dragged: their timecards are already derived against the plan that was in force,
        and rewriting it after the fact would change what somebody was measured against. Correct those in the day
        editor, where the edit window applies.
      </p>
    </>
  );
}

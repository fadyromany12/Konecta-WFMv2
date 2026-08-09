import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type ScheduleShift } from '../api';
import { useAsync, useSession } from '../state';
import { useToast } from '../components/Toast';
import { Banner, Button, Card, Chip, GroupPicker, SkeletonTable, Toolbar } from '../components/ui';
import { addDays, today } from '../lib/time';
import { pulseSuccess } from '../lib/interaction';

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

interface Breach {
  kind: 'rest' | 'consecutive' | 'weekly';
  date: string;
  message: string;
  over: number;
}

interface TeamWeekPerson {
  userId: number;
  employeeId: string;
  name: string;
  role: string;
  days: { date: string; shifts: ScheduleShift[]; leave: string | null }[];
  minutes: number;
  breaches: Breach[];
}

interface DayCover {
  date: string;
  peakRequired: number;
  worstAt: string | null;
  requiredAtWorst: number;
  scheduledAtWorst: number;
  worstVariance: number;
  shortIntervals: number;
  demandIntervals: number;
  forecast: boolean;
}

interface TeamWeekResult {
  start: string;
  end: string;
  dates: string[];
  people: TeamWeekPerson[];
  /** Unpublished person-days in the range. */
  drafts: number;
  breaching: number;
  cover: DayCover[];
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
  const [publishing, setPublishing] = useState(false);
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
  const drafts = week.data?.drafts ?? 0;
  const breaching = week.data?.breaching ?? 0;
  const cover = useMemo(
    () => new Map((week.data?.cover ?? []).map((c) => [c.date, c])),
    [week.data],
  );

  /** On shift, and away on approved leave — two different answers to "who is off". */
  const perDay = useMemo(() => {
    const counts = new Map<string, { on: number; leave: number }>();
    for (const person of people) {
      for (const day of person.days) {
        const cell = counts.get(day.date) ?? { on: 0, leave: 0 };
        if (day.shifts.length > 0) cell.on++;
        if (day.leave) cell.leave++;
        counts.set(day.date, cell);
      }
    }
    return counts;
  }, [people]);

  async function publish(element?: HTMLElement | null) {
    setPublishing(true);
    try {
      const result = await api.post<{ published: number; affected: { userId: number }[] }>(
        '/schedules/publish',
        { group, start, end },
      );
      pulseSuccess(element);
      toast.success(
        `Published ${result.published} day${result.published === 1 ? '' : 's'}.`,
        result.affected.length === 0
          ? 'Nothing was waiting.'
          : `${result.affected.length} ${result.affected.length === 1 ? 'person has' : 'people have'} been told, each with their own days.`,
      );
      setNonce((n) => n + 1);
    } catch (err) {
      toast.error('Could not publish.', (err as Error).message);
    } finally {
      setPublishing(false);
    }
  }

  async function drop(toDate: string) {
    const source = drag;
    setDrag(null);
    setOver(null);
    if (!source || source.fromDate === toDate) return;

    setMoving(true);
    try {
      const result = await api.post<{ ok: boolean; warnings?: Breach[] }>('/schedules/move', {
        userId: source.userId,
        fromDate: source.fromDate,
        toDate,
        shiftNo: source.shiftNo,
      });
      // A move that breaches a working-time limit still happens — the whole
      // point is that these are judgement calls — but it says so rather than
      // reporting a clean success and leaving it to be discovered.
      if (result.warnings && result.warnings.length > 0) {
        toast.warn(`Moved to ${toDate}, but look at this.`, result.warnings.map((w) => w.message).join(' '));
      } else {
        toast.success(`Shift moved to ${toDate}.`, 'They have been told, and both days were re-derived.');
      }
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
        <Button variant="primary" onClick={(e) => void publish(e.currentTarget)} disabled={drafts === 0 || publishing}>
          {publishing ? 'Publishing…' : drafts === 0 ? 'Nothing to publish' : `Publish ${drafts} day${drafts === 1 ? '' : 's'}`}
        </Button>
        <div style={{ flex: 1 }} />
        <span className="muted">
          {start} to {end}
          {moving ? ' · moving…' : ''}
        </span>
      </Toolbar>

      {breaching > 0 && (
        <Banner tone="warn">
          {breaching} {breaching === 1 ? 'person' : 'people'} in this week breach a working-time limit — too
          little rest between shifts, too many days in a row, or too many hours. Hover the ⚠ beside a name for
          which. These are warnings, not refusals: somebody volunteering to cover is a real thing, and a tool
          that blocked it would just be worked around on paper.
        </Banner>
      )}

      {drafts > 0 && (
        <Banner tone="info">
          {drafts} day{drafts === 1 ? '' : 's'} in this week {drafts === 1 ? 'is' : 'are'} still a draft. Only you
          can see {drafts === 1 ? 'it' : 'them'} — nobody is expected to work a shift they have not been shown, and
          the clock will not open on one.
        </Banner>
      )}

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
            <table className="team-week" aria-label="Team schedule for the week">
              <thead>
                <tr>
                  <th>Advisor</th>
                  {dates.map((date) => (
                    <th key={date} className={date === today() ? 'is-today' : ''}>
                      <div className="tw-head">
                        <span>{weekdayOf(date)}</span>
                        <span className="muted mono">{date.slice(5)}</span>
                        <span className="muted">
                          {perDay.get(date)?.on ?? 0} on
                          {(perDay.get(date)?.leave ?? 0) > 0 && ` · ${perDay.get(date)!.leave} away`}
                        </span>
                        <CoverLine cover={cover.get(date)} />
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
                      {person.breaches.length > 0 && (
                        <span
                          className="tw-breach"
                          title={person.breaches.map((b) => b.message).join('\n')}
                        >
                          ⚠ {breachLabel(person.breaches)}
                        </span>
                      )}
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
                            day.leave ? (
                              <span className="tw-leave" title={`Approved ${day.leave.toLowerCase()}`}>
                                {day.leave.replace(/_/g, ' ').toLowerCase()}
                              </span>
                            ) : (
                              <span className="tw-off">·</span>
                            )
                          ) : (
                            day.shifts.map((shift) => (
                              <button
                                key={shift.shiftNo}
                                type="button"
                                className={`tw-shift ${shift.status === 'DRAFT' ? 'is-draft' : ''}`}
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
                                title={
                                  `${person.name} · ${day.date}` +
                                  (shift.status === 'DRAFT' ? ' · draft, not yet visible to them' : '') +
                                  ' · open in the day editor'
                                }
                              >
                                <span className="mono">
                                  {shift.rows[0]?.startAt.slice(11) ?? '??'}–{shift.endAt.slice(11)}
                                </span>
                                {shift.status === 'DRAFT' && <span className="tw-draft-dot" aria-label="draft" />}
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
        A day you build is a draft until you publish it: only you can see it, and the clock will not open on a
        shift nobody has been shown. Editing an already-published day does not retract it — the advisor sees the
        change and is told about it, because taking a day back off somebody's week silently is worse than changing
        it openly.
      </p>

      <p className="muted">
        Moving a shift keeps its shape — an overnight shift dragged forward is still overnight. Days that have
        already happened cannot be dragged: their timecards are already derived against the plan that was in force,
        and rewriting it after the fact would change what somebody was measured against. Correct those in the day
        editor, where the edit window applies.
      </p>
    </>
  );
}

/**
 * The requirement under each date.
 *
 * Read at the day's worst half hour, not its busiest. Requirements tie all day
 * long, so "the peak" is whichever tied interval happens to come first — two
 * days with the same roster reported wildly different cover before this was
 * fixed. The worst interval is unambiguous, and it is the one somebody has to
 * do something about.
 */
function CoverLine({ cover }: { cover?: DayCover }) {
  if (!cover) return null;
  if (!cover.forecast) return <span className="tw-cover muted">no forecast</span>;

  if (cover.worstVariance >= 0) {
    return <span className="tw-cover is-ok">covered · peak {cover.peakRequired}</span>;
  }
  return (
    <span className="tw-cover is-short" title={`Worst at ${cover.worstAt}. Peak requirement ${cover.peakRequired}.`}>
      {cover.scheduledAtWorst}/{cover.requiredAtWorst} at {cover.worstAt} · {cover.shortIntervals}/
      {cover.demandIntervals} short
    </span>
  );
}

/** The shortest true summary of what a person's week breaches. */
function breachLabel(breaches: Breach[]): string {
  const kinds = new Set(breaches.map((b) => b.kind));
  const parts: string[] = [];
  if (kinds.has('rest')) parts.push('rest');
  if (kinds.has('consecutive')) parts.push('days in a row');
  if (kinds.has('weekly')) parts.push('hours');
  return parts.join(', ');
}

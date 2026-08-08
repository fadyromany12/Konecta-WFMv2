import { useMemo, useState } from 'react';
import { api, type ScheduleShift } from '../api';
import { useAsync, useSession } from '../state';
import { Button, Card, Chip, Empty, SkeletonTable, Toolbar } from '../components/ui';
import { addDays, durationBetween, today } from '../lib/time';

/**
 * An advisor's own week.
 *
 * The most common reason anybody opens a workforce tool — "when am I working?"
 * — and it was the one question this one could not answer. My Shifts held
 * swaps, bids and time off: everything about *changing* the schedule, and
 * nothing that simply showed it.
 */

interface Day {
  date: string;
  shifts: ScheduleShift[];
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

export function MyWeek() {
  const { user, catalog } = useSession();
  const [start, setStart] = useState(weekStart(today()));
  const end = addDays(start, 6);

  const schedule = useAsync(
    () =>
      user
        ? api.get<{ days: Day[] }>(`/schedules/${user.id}?start=${start}&end=${end}`)
        : Promise.resolve({ days: [] }),
    [user, start, end],
  );

  const byDate = useMemo(
    () => new Map((schedule.data?.days ?? []).map((d) => [d.date, d.shifts])),
    [schedule.data],
  );

  const dates = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(start, i)), [start]);

  const totalMinutes = useMemo(() => {
    let minutes = 0;
    for (const shifts of byDate.values()) {
      for (const shift of shifts) {
        const from = shift.rows[0]?.startAt;
        if (from) minutes += minutesBetween(from, shift.endAt);
      }
    }
    return minutes;
  }, [byDate]);

  const activityName = (key: string) =>
    catalog?.scheduleActivities.find((s) => s.key === key)?.name ?? key.replace(/_/g, ' ').toLowerCase();

  return (
    <>
      <Toolbar>
        <Button onClick={() => setStart(addDays(start, -7))}>← Previous week</Button>
        <Button onClick={() => setStart(weekStart(today()))}>This week</Button>
        <Button onClick={() => setStart(addDays(start, 7))}>Next week →</Button>
        <div style={{ flex: 1 }} />
        <span className="muted">
          {start} to {end} · {Math.round((totalMinutes / 60) * 10) / 10} hours scheduled
        </span>
      </Toolbar>

      {schedule.loading && !schedule.data && <SkeletonTable rows={7} columns={3} />}

      <div className="week">
        {dates.map((date) => {
          const shifts = byDate.get(date) ?? [];
          const isToday = date === today();
          return (
            <Card key={date} tone={shifts.length === 0 ? 'quiet' : undefined}>
              <div className={`week-head ${isToday ? 'is-today' : ''}`}>
                <strong>{weekdayOf(date)}</strong>
                <span className="muted mono">{date.slice(5)}</span>
                {isToday && <Chip label="today" tone="accent" />}
              </div>

              {shifts.length === 0 ? (
                <Empty>Not scheduled.</Empty>
              ) : (
                shifts.map((shift) => (
                  <div key={shift.shiftNo} className="week-shift">
                    <div className="week-span mono">
                      {shift.rows[0]?.startAt.slice(11)}–{shift.endAt.slice(11)}
                      <span className="muted">
                        {' '}
                        {durationBetween(shift.rows[0]?.startAt ?? shift.endAt, shift.endAt)}
                      </span>
                    </div>
                    <ul className="week-rows">
                      {shift.rows.map((row, i) => {
                        const to = i + 1 < shift.rows.length ? shift.rows[i + 1].startAt : shift.endAt;
                        return (
                          <li key={i}>
                            <span className="mono">{row.startAt.slice(11)}</span>
                            <span>{activityName(row.activityKey)}</span>
                            <span className="muted mono">{durationBetween(row.startAt, to)}</span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))
              )}
            </Card>
          );
        })}
      </div>

      <p className="muted">
        This is the published schedule. If a swap or extra hours are approved, they appear here — that is what
        lets you clock on for them.
      </p>
    </>
  );
}

function minutesBetween(from: string, to: string): number {
  return Math.max(
    0,
    (Date.parse(`${to.replace(' ', 'T')}:00Z`) - Date.parse(`${from.replace(' ', 'T')}:00Z`)) / 60000,
  );
}

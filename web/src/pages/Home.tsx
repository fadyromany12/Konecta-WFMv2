import { useEffect, useState } from 'react';
import { api, type ClockState } from '../api';
import { useAsync, useSession } from '../state';
import { relativeTime, useLive } from '../live';
import { useToast } from '../components/Toast';
import { Banner, Button, Card, Chip, Empty, Loading, Stamp } from '../components/ui';

/** The web clock and the notifications waiting for this user. */
export function Home() {
  const { user } = useSession();
  const toast = useToast();
  const { notifications, markRead } = useLive();
  const [now, setNow] = useState(new Date());
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState('');

  const clock = useAsync(() => api.get<ClockState>('/clock'), []);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const state = clock.data;

  useEffect(() => {
    if (state && !activity) {
      setActivity(state.activity ?? state.availableActivities[0]?.code ?? '');
    }
  }, [state, activity]);

  async function punch(type: 'ON' | 'OFF' | 'CHANGE', code?: string) {
    setBusy(true);
    try {
      const res = await api.post<{ ok: boolean; message: string }>('/clock/punch', {
        type,
        activity: type === 'OFF' ? null : (code ?? activity),
      });
      // A punch that raises a Late exception is still a successful punch, but
      // the advisor needs to read that sentence rather than watch it fade.
      if (res.message.includes('late')) toast.warn(res.message);
      else toast.success(res.message);
      clock.reload();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const hhmm = now.toTimeString().slice(0, 8);

  return (
    <div className="grid-2">
      <Card title="Web Clock" subtitle={state?.payrollDate ? `Payroll date ${state.payrollDate}` : undefined}>
        {clock.loading && <Loading what="your clock" />}

        {state && (
          <>
            <div className="clock">
              <div className="clock-time">{hhmm}</div>
              <div className="clock-state">
                <span className={`dot ${state.clockedOn ? 'dot-on' : 'dot-off'}`} />
                {state.message}
              </div>
              {state.scheduledStart && (
                <div className="muted">
                  Scheduled <Stamp value={state.scheduledStart} /> to <Stamp value={state.scheduledEnd ?? ''} />
                </div>
              )}

              <div className="clock-actions">
                {!state.clockedOn ? (
                  <>
                    <select value={activity} onChange={(e) => setActivity(e.target.value)}>
                      {state.availableActivities.map((a) => (
                        <option key={a.code} value={a.code}>
                          {a.code} {a.name}
                        </option>
                      ))}
                    </select>
                    <Button variant="primary" disabled={busy || !state.canClockOn} onClick={() => punch('ON')}>
                      Clock on
                    </Button>
                  </>
                ) : (
                  <>
                    <select value={activity} onChange={(e) => setActivity(e.target.value)}>
                      {state.availableActivities.map((a) => (
                        <option key={a.code} value={a.code}>
                          {a.code} {a.name}
                        </option>
                      ))}
                    </select>
                    <Button
                      disabled={busy || activity === state.activity}
                      onClick={() => punch('CHANGE')}
                      title={state.mealLockUntil ?? undefined}
                    >
                      Change activity
                    </Button>
                    <Button variant="danger" disabled={busy} onClick={() => punch('OFF')}>
                      Clock off
                    </Button>
                  </>
                )}
              </div>
            </div>

            {state.availableActivities.length === 0 && (
              <Banner tone="warn">
                You have no timekeeping activities. This normally means your project or department code needs
                correcting in the HR record before you can clock time.
              </Banner>
            )}

            <h3 style={{ fontSize: '0.8rem', textTransform: 'uppercase', color: 'var(--text-dim)', marginTop: '1rem' }}>
              Today's punches
            </h3>
            {state.todaySegments.length === 0 ? (
              <Empty>No punches recorded yet for this payroll date.</Empty>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>From</th>
                      <th>To</th>
                      <th>Activity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.todaySegments.map((s, i) => (
                      <tr key={i}>
                        <td>
                          <Stamp value={s.startAt} reference={state.payrollDate ?? undefined} />
                        </td>
                        <td>{s.endAt ? <Stamp value={s.endAt} reference={state.payrollDate ?? undefined} /> : <em className="muted">now</em>}</td>
                        <td>
                          <Chip label={s.activity} /> {s.name}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Card>

      <Card
        title="Messages"
        subtitle={`Signed in as ${user?.roleLabel}`}
        actions={
          notifications.some((n) => !n.read) ? (
            <Chip label={`${notifications.filter((n) => !n.read).length} unread`} tone="accent" />
          ) : undefined
        }
      >
        {notifications.length === 0 && <Empty>Nothing needs your attention.</Empty>}
        {notifications.slice(0, 12).map((m) => (
          <div key={m.id} style={{ marginBottom: '0.7rem' }} onMouseEnter={() => !m.read && void markRead(m.id)}>
            <Banner tone={m.severity === 'WARN' ? 'warn' : 'info'}>
              <strong>{m.subject}</strong>
              <div>{m.body}</div>
              <div className="muted">{relativeTime(m.createdAt)}</div>
            </Banner>
          </div>
        ))}
      </Card>
    </div>
  );
}

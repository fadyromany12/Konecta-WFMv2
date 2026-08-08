import { useState } from 'react';
import { api } from '../api';
import { useAsync, useSession } from '../state';
import { useToast } from '../components/Toast';
import { Button, Card, Chip, DateField, Empty, Loading, SkeletonTable, Toolbar } from '../components/ui';
import { addDays, today } from '../lib/time';

/**
 * Time off. Requests are checked against the accrual balance when they are
 * raised, so an advisor cannot book leave they have not earned, and the balance
 * only moves when a supervisor approves.
 */
export function Absence() {
  const { user } = useSession();
  const toast = useToast();

  const accruals = useAsync(() => api.get<{ accruals: any[] }>('/absence/accruals'), []);
  const requests = useAsync(() => api.get<{ requests: any[] }>('/absence/requests'), []);

  // What approving each pending request would cost, fetched when a supervisor
  // asks rather than for every row — it is several coverage computations.
  const [impacts, setImpacts] = useState<Record<number, any>>({});
  const [checking, setChecking] = useState<number | null>(null);

  async function checkImpact(id: number) {
    setChecking(id);
    try {
      const res = await api.get<any>(`/absence/requests/${id}/impact`);
      setImpacts((current) => ({ ...current, [id]: res }));
      if (res.severity === 'high') toast.warn(res.summary, 'Worth a look before you approve.');
      else if (res.severity === 'watch') toast.warn(res.summary);
      else toast.success(res.summary);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setChecking(null);
    }
  }

  const [type, setType] = useState('VACATION');
  const [start, setStart] = useState(addDays(today(), 14));
  const [end, setEnd] = useState(addDays(today(), 15));
  const [hours, setHours] = useState(16);
  const [reason, setReason] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api.post('/absence/requests', {
        accrualType: type,
        startDate: start,
        endDate: end,
        hours,
        reason: reason || undefined,
      });
      toast.success('Request submitted for approval.', 'Your balance moves only once it is approved.');
      setReason('');
      requests.reload();
    } catch (err) {
      // Almost always "you asked for more than you have accrued", which is the
      // one message an advisor actually needs to read.
      toast.error((err as Error).message);
    }
  }

  async function decide(id: number, status: 'APPROVED' | 'DECLINED') {
    try {
      await api.post(`/absence/requests/${id}/decision`, { status });
      toast.success(
        status === 'APPROVED' ? 'Time off approved.' : 'Request declined.',
        status === 'APPROVED' ? 'The hours have come off their balance.' : 'Their balance is unchanged.',
      );
      requests.reload();
      accruals.reload();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <div className="grid-2">
      <Card title="Request time off" subtitle="Checked against your accrued balance when you submit.">
        <form onSubmit={submit}>
          <Toolbar>
            <label className="field">
              <span>Type</span>
              <select value={type} onChange={(e) => setType(e.target.value)}>
                <option value="VACATION">Vacation</option>
                <option value="SICK">Sick</option>
                <option value="UNPAID">Unpaid</option>
              </select>
            </label>
            <DateField label="From" value={start} onChange={setStart} />
            <DateField label="To" value={end} onChange={setEnd} />
            <label className="field">
              <span>Hours</span>
              <input
                type="number"
                min={1}
                step={0.5}
                value={hours}
                style={{ width: '5.5rem' }}
                onChange={(e) => setHours(Number(e.target.value))}
              />
            </label>
          </Toolbar>
          <label className="field" style={{ marginBottom: '0.6rem' }}>
            <span>Reason (optional)</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <Button variant="primary" type="submit">
            Submit request
          </Button>
        </form>

        <h3 style={{ fontSize: '0.8rem', textTransform: 'uppercase', color: 'var(--text-dim)', marginTop: '1.2rem' }}>
          Your balances
        </h3>
        {accruals.loading && <Loading what="balances" />}
        <table>
          <tbody>
            {accruals.data?.accruals.map((a) => (
              <tr key={a.accrual_type}>
                <th>{a.accrual_type}</th>
                <td className="num right">{a.balance_hours.toFixed(1)} hours</td>
                <td className="muted">as of {a.as_of}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {accruals.data?.accruals.length === 0 && <Empty>No accrual balances are published for your region.</Empty>}
      </Card>

      <Card
        title={user?.isSupervisor ? 'Team requests' : 'Your requests'}
        subtitle={
          user?.isSupervisor
            ? 'Check cover before approving — the answer is advisory, not a block.'
            : undefined
        }
      >
        {requests.loading && !requests.data && <SkeletonTable rows={5} columns={6} />}
        {requests.data?.requests.length === 0 && <Empty>No requests.</Empty>}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {user?.isSupervisor && <th>Advisor</th>}
                <th>Type</th>
                <th>Dates</th>
                <th className="right">Hours</th>
                <th>Status</th>
                {user?.isSupervisor && <th />}
              </tr>
            </thead>
            <tbody>
              {requests.data?.requests.map((r) => (
                <tr key={r.id}>
                  {user?.isSupervisor && <td>{r.user_name}</td>}
                  <td>{r.accrual_type}</td>
                  <td className="mono nowrap">
                    {r.start_date} → {r.end_date}
                  </td>
                  <td className="right num">{r.hours}</td>
                  <td>
                    <Chip
                      label={r.status.toLowerCase()}
                      tone={r.status === 'APPROVED' ? 'good' : r.status === 'DECLINED' ? 'error' : 'warn'}
                    />
                  </td>
                  {user?.isSupervisor && (
                    <td className="nowrap">
                      {r.status === 'PENDING' && r.user_id !== user.id && (
                        <>
                          <Button onClick={() => checkImpact(r.id)} disabled={checking === r.id}>
                            {checking === r.id ? 'Checking…' : 'Check cover'}
                          </Button>{' '}
                          <Button onClick={() => decide(r.id, 'APPROVED')}>Approve</Button>{' '}
                          <Button variant="danger" onClick={() => decide(r.id, 'DECLINED')}>
                            Decline
                          </Button>
                          {impacts[r.id] && (
                            <div
                              className={`cover-note cover-${impacts[r.id].severity}`}
                              role="status"
                            >
                              {impacts[r.id].summary}
                            </div>
                          )}
                        </>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

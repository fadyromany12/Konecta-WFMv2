import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAsync, useSession } from '../state';
import { useLiveEvent } from '../live';
import { useToast } from '../components/Toast';
import { Button, Card, Chip, DateField, Empty, SkeletonTable, Toolbar } from '../components/ui';
import { TimeInput } from '../components/ui';
import { addDays, today } from '../lib/time';

interface Swap {
  id: number;
  requesterId: number;
  requesterName: string;
  requesterDate: string;
  counterpartyId: number;
  counterpartyName: string;
  counterpartyDate: string;
  reason: string | null;
  status: string;
}

const SWAP_STATUS: Record<string, { label: string; tone: string }> = {
  PENDING_PEER: { label: 'waiting on colleague', tone: 'warn' },
  PENDING_APPROVAL: { label: 'waiting on supervisor', tone: 'accent' },
  APPROVED: { label: 'approved', tone: 'good' },
  DECLINED: { label: 'declined', tone: 'error' },
};

/**
 * Shift swaps. Two advisors agree, then a supervisor approves — the approval
 * is what actually exchanges the schedules, so nothing moves behind anyone's
 * back.
 */
export function Swaps() {
  const { user } = useSession();
  const toast = useToast();
  const [myDate, setMyDate] = useState(addDays(today(), 2));
  const [theirId, setTheirId] = useState<number | ''>('');
  const [theirDate, setTheirDate] = useState(addDays(today(), 3));
  const [reason, setReason] = useState('');

  const swaps = useAsync(() => api.get<{ swaps: Swap[] }>('/swaps'), []);
  const candidates = useAsync(
    () => api.get<{ candidates: any[] }>(`/swaps/candidates?date=${today()}`),
    [],
  );

  useEffect(() => {
    const list = candidates.data?.candidates ?? [];
    if (list.length > 0 && theirId === '') setTheirId(list[0].id);
  }, [candidates.data, theirId]);

  // The other side of a swap moves without you doing anything, so this list
  // has to follow the event rather than wait for a reload.
  useLiveEvent(['swap.changed'], () => swaps.reload());

  async function act(fn: () => Promise<any>) {
    try {
      const res = await fn();
      if (res.ok === false) toast.warn(res.message ?? 'That could not be done.');
      else toast.success(res.message ?? 'Done.');
      swaps.reload();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  // Unique colleagues out of the date-expanded candidate list.
  const people = Array.from(
    new Map((candidates.data?.candidates ?? []).map((c: any) => [c.id, c])).values(),
  ) as any[];

  return (
    <>
      <Card title="Request a swap" subtitle="Give one of your shifts and take one of theirs.">
        <Toolbar>
          <DateField label="My shift on" value={myDate} onChange={setMyDate} />
          <label className="field">
            <span>Swap with</span>
            <select value={theirId} onChange={(e) => setTheirId(Number(e.target.value))}>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.employee_id})
                </option>
              ))}
            </select>
          </label>
          <DateField label="Their shift on" value={theirDate} onChange={setTheirDate} />
          <label className="field" style={{ flex: 1, minWidth: '12rem' }}>
            <span>Reason (optional)</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <Button
            variant="primary"
            disabled={theirId === ''}
            onClick={() =>
              act(() =>
                api.post('/swaps', {
                  requesterDate: myDate,
                  counterpartyId: Number(theirId),
                  counterpartyDate: theirDate,
                  reason: reason || undefined,
                }),
              )
            }
          >
            Request swap
          </Button>
        </Toolbar>
        {people.length === 0 && !candidates.loading && (
          <Empty>No colleagues with upcoming shifts to swap with.</Empty>
        )}
      </Card>

      <Card title={user?.isSupervisor ? 'Team swaps' : 'Your swaps'}>
        {swaps.loading && !swaps.data && <SkeletonTable rows={4} columns={5} />}
        {(swaps.data?.swaps.length ?? 0) === 0 && !swaps.loading && <Empty>No swap requests.</Empty>}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Giving</th>
                <th>Taking</th>
                <th>Reason</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {swaps.data?.swaps.map((swap) => {
                const meta = SWAP_STATUS[swap.status] ?? { label: swap.status, tone: 'neutral' };
                const iAmCounterparty = swap.counterpartyId === user?.id;
                return (
                  <tr key={swap.id}>
                    <td>
                      {swap.requesterName}
                      <div className="muted mono">{swap.requesterDate}</div>
                    </td>
                    <td>
                      {swap.counterpartyName}
                      <div className="muted mono">{swap.counterpartyDate}</div>
                    </td>
                    <td className="muted">{swap.reason ?? '—'}</td>
                    <td>
                      <Chip label={meta.label} tone={meta.tone} />
                    </td>
                    <td className="nowrap">
                      {swap.status === 'PENDING_PEER' && iAmCounterparty && (
                        <>
                          <Button onClick={() => act(() => api.post(`/swaps/${swap.id}/respond`, { accept: true }))}>
                            Accept
                          </Button>{' '}
                          <Button
                            variant="danger"
                            onClick={() => act(() => api.post(`/swaps/${swap.id}/respond`, { accept: false }))}
                          >
                            Decline
                          </Button>
                        </>
                      )}
                      {swap.status === 'PENDING_APPROVAL' && user?.isSupervisor && (
                        <>
                          <Button
                            variant="primary"
                            onClick={() => act(() => api.post(`/swaps/${swap.id}/decide`, { approve: true }))}
                          >
                            Approve
                          </Button>{' '}
                          <Button
                            variant="danger"
                            onClick={() => act(() => api.post(`/swaps/${swap.id}/decide`, { approve: false }))}
                          >
                            Decline
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
      </Card>
    </>
  );
}

/**
 * Extra hours: supervisors post what they need covered, advisors bid, the
 * supervisor awards. Awarding adds the block to the advisor's schedule, which
 * is what lets them clock on for it at all.
 */
export function ExtraHours() {
  const { user } = useSession();
  const toast = useToast();
  const [openOffer, setOpenOffer] = useState<number | null>(null);
  const [date, setDate] = useState(addDays(today(), 4));
  const [startTime, setStartTime] = useState('18:00');
  const [endTime, setEndTime] = useState('22:00');
  const [slots, setSlots] = useState(2);
  const [note, setNote] = useState('');

  const offers = useAsync(() => api.get<{ offers: any[] }>('/extra-hours'), []);
  const bids = useAsync(
    () => (openOffer ? api.get<{ bids: any[] }>(`/extra-hours/${openOffer}/bids`) : Promise.resolve({ bids: [] })),
    [openOffer],
  );

  // A colleague bidding, or a supervisor awarding, changes this table.
  useLiveEvent(['extra-hours.changed'], () => {
    offers.reload();
    bids.reload();
  });

  async function act(fn: () => Promise<any>) {
    try {
      const res = await fn();
      if (res.ok === false) toast.warn(res.message ?? 'That could not be done.');
      else toast.success(res.message ?? 'Done.');
      offers.reload();
      bids.reload();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <>
      {user?.isSupervisor && (
        <Card title="Offer extra hours" subtitle="Post a block for the team to bid on.">
          <Toolbar>
            <DateField label="Date" value={date} onChange={setDate} />
            <label className="field">
              <span>From</span>
              <TimeInput value={startTime} onChange={setStartTime} />
            </label>
            <label className="field">
              <span>To</span>
              <TimeInput value={endTime} onChange={setEndTime} />
            </label>
            <label className="field">
              <span>Slots</span>
              <input
                type="number"
                min={1}
                value={slots}
                style={{ width: '4.5rem' }}
                onChange={(e) => setSlots(Number(e.target.value))}
              />
            </label>
            <label className="field" style={{ flex: 1, minWidth: '10rem' }}>
              <span>Note</span>
              <input value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
            <Button
              variant="primary"
              onClick={() =>
                act(async () => {
                  await api.post('/extra-hours', {
                    date,
                    startTime,
                    endTime,
                    slots,
                    note: note || undefined,
                  });
                  return { message: 'Extra hours offered to the team.' };
                })
              }
            >
              Post offer
            </Button>
          </Toolbar>
        </Card>
      )}

      <Card title="Open offers">
        {offers.loading && !offers.data && <SkeletonTable rows={4} columns={7} />}
        {(offers.data?.offers.length ?? 0) === 0 && !offers.loading && <Empty>Nothing on offer.</Empty>}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Hours</th>
                <th>Slots</th>
                <th>Bids</th>
                <th>Note</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {offers.data?.offers.map((offer) => (
                <tr key={offer.id}>
                  <td className="mono">{offer.date}</td>
                  <td className="mono">
                    {offer.start_time}–{offer.end_time}
                  </td>
                  <td className="num right">{offer.slots}</td>
                  <td className="num right">{offer.bid_count}</td>
                  <td className="muted">{offer.note ?? '—'}</td>
                  <td>
                    <Chip label={offer.status.toLowerCase()} tone={offer.status === 'OPEN' ? 'good' : 'neutral'} />
                  </td>
                  <td className="nowrap">
                    {!user?.isSupervisor && offer.status === 'OPEN' && (
                      <Button
                        variant={offer.my_bid ? 'ghost' : 'primary'}
                        disabled={!!offer.my_bid}
                        onClick={() => act(() => api.post(`/extra-hours/${offer.id}/bid`))}
                      >
                        {offer.my_bid ? `Bid ${String(offer.my_bid).toLowerCase()}` : 'Bid for this'}
                      </Button>
                    )}
                    {user?.isSupervisor && (
                      <Button onClick={() => setOpenOffer(openOffer === offer.id ? null : offer.id)}>
                        {openOffer === offer.id ? 'Hide bids' : `View ${offer.bid_count} bids`}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {openOffer && user?.isSupervisor && (
          <div style={{ marginTop: '1rem' }}>
            <h3 style={{ fontSize: '0.8rem', textTransform: 'uppercase', color: 'var(--text-dim)' }}>
              Bids for this offer
            </h3>
            {(bids.data?.bids.length ?? 0) === 0 && <Empty>Nobody has bid yet.</Empty>}
            <table>
              <tbody>
                {bids.data?.bids.map((bid: any) => (
                  <tr key={bid.id}>
                    <td>
                      {bid.name}
                      <div className="muted mono">{bid.employee_id}</div>
                    </td>
                    <td>
                      <Chip label={bid.status.toLowerCase()} tone={bid.status === 'AWARDED' ? 'good' : 'warn'} />
                    </td>
                    <td className="right">
                      {bid.status === 'PENDING' && (
                        <Button
                          variant="primary"
                          onClick={() => act(() => api.post(`/extra-hours/bids/${bid.id}/award`))}
                        >
                          Award
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted">
              Awarding adds the block to their schedule as a second shift. That is what lets them clock on — the
              web clock only opens inside a scheduled window.
            </p>
          </div>
        )}
      </Card>
    </>
  );
}

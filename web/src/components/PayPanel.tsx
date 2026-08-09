/**
 * What a day costs, beside the card it costs it for.
 *
 * Cost is in hours at the base rate — eight hours worked on a public holiday
 * reads as twenty-four paid hours — because no salary is held anywhere in
 * Pulse. That is a deliberate limit and the panel says so rather than leaving
 * somebody to wonder where the money went.
 *
 * The panel's real job is the settlement. A worked public holiday can be paid
 * at three times, or at twice plus a day added to the annual bank, and the
 * choice is the supervisor's at the moment they approve the card. So it is here
 * — next to the hours it applies to — rather than on a settings screen where
 * the decision would be made about somebody in the abstract.
 */

import { useState } from 'react';
import { api, type HolidayElection, type PayBreakdown, type PublicHoliday, type Timecard } from '../api';
import { useToast } from './Toast';
import { pulseSuccess } from '../lib/interaction';
import { Banner, Button, Card, Chip } from './ui';

const CHARACTER: Record<string, { label: string; tone: 'accent' | 'warn' | undefined }> = {
  ORDINARY: { label: 'Ordinary day', tone: undefined },
  REST_DAY: { label: 'Rest day worked', tone: 'warn' },
  PUBLIC_HOLIDAY: { label: 'Public holiday', tone: 'accent' },
};

export function PayPanel({
  pay,
  holiday,
  card,
  canSettle,
  onSettled,
}: {
  pay: PayBreakdown | null;
  holiday: PublicHoliday | null;
  card: Timecard;
  canSettle: boolean;
  onSettled: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  if (!pay) return null;
  const character = CHARACTER[pay.dayCharacter] ?? CHARACTER.ORDINARY;

  async function settle(election: HolidayElection, el: HTMLElement) {
    setBusy(true);
    try {
      const result = await api.post<{ ok: boolean; message: string }>(
        `/pay/timecards/${card.id}/holiday-election`,
        { election },
      );
      if (result.ok) toast.success(result.message, `${card.userName} · ${card.payrollDate}`);
      else toast.warn(result.message, `${card.userName} · ${card.payrollDate}`);
      if (result.ok) {
        pulseSuccess(el);
        onSettled();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not settle that.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card tone="quiet">
      <div className="pay-head">
        <Chip label={character.label} tone={character.tone} />
        {holiday && (
          <span className="muted">
            {holiday.name}
            {!holiday.confirmed && ' · date not yet confirmed'}
          </span>
        )}
      </div>

      {/*
        A list rather than a table. The aside is a narrow column and four
        numeric columns do not fit in it — the cost, which is the number the
        whole panel exists to show, was the one being clipped off the right
        edge. Label above, arithmetic beneath it, cost on the right.
      */}
      <dl className="pay-lines">
        {pay.lines.map((line) => (
          <div className="pay-line" key={line.kind}>
            <dt>
              {line.label}
              <span className="pay-working num">
                {hhmm(line.minutes)} × {line.multiplier}
              </span>
            </dt>
            <dd className="num">{hhmm(line.paidMinutes)}</dd>
          </div>
        ))}
        {pay.lines.length === 0 && <p className="muted">Nothing paid on this card.</p>}

        <div className="pay-line pay-total">
          <dt>
            Cost
            <span className="pay-working num">{pay.formatted.worked} worked</span>
          </dt>
          <dd className="num">
            <strong>{pay.formatted.paid}</strong>
          </dd>
        </div>

        {pay.premiumMinutes > 0 && (
          <div className="pay-line pay-line-quiet">
            <dt>of which premium</dt>
            <dd className="num">{pay.formatted.premium}</dd>
          </div>
        )}
        {pay.dayInLieuHours > 0 && (
          <div className="pay-line pay-line-quiet">
            <dt>banked as annual</dt>
            <dd className="num">{pay.dayInLieuHours}h</dd>
          </div>
        )}
      </dl>

      {pay.dayCharacter === 'PUBLIC_HOLIDAY' && pay.workedMinutes > 0 && (
        <div className="pay-settle">
          {pay.electionOutstanding ? (
            <Banner tone="warn">
              This holiday was worked and has not been settled. It is costed at the higher rate
              until somebody chooses.
            </Banner>
          ) : (
            <p className="muted">
              Settled at {pay.election === 'PAY_3X' ? 'triple time' : 'double time plus a banked day'}.
            </p>
          )}

          {canSettle ? (
            <div className="pay-choices">
              <Button
                variant={pay.election === 'PAY_3X' ? 'primary' : undefined}
                disabled={busy}
                onClick={(e) => void settle('PAY_3X', e.currentTarget)}
              >
                Pay 3× ({hhmm(pay.workedMinutes * 3)})
              </Button>
              <Button
                variant={pay.election === 'PAY_2X_PLUS_DAY' ? 'primary' : undefined}
                disabled={busy}
                onClick={(e) => void settle('PAY_2X_PLUS_DAY', e.currentTarget)}
              >
                Pay 2× + a day ({hhmm(pay.workedMinutes * 2)})
              </Button>
            </div>
          ) : (
            <p className="muted">Your supervisor settles this when they approve the card.</p>
          )}
        </div>
      )}

      {pay.notes.map((note) => (
        <p key={note} className="muted pay-note">
          {note}
        </p>
      ))}

      <p className="muted pay-note">
        Cost is in hours at the base rate. Pulse holds no salaries, so this multiplies into money
        wherever the rates live.
      </p>
    </Card>
  );
}

/** Minutes as `HH:MM`, matching every other duration in the app. */
function hhmm(minutes: number): string {
  const sign = minutes < 0 ? '-' : '';
  const abs = Math.abs(Math.round(minutes));
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/**
 * What to do about today.
 *
 * The coverage chart already showed a supervisor where the day is thin. This
 * screen is the answer rather than the diagnosis, so it is built as a list of
 * actions in the order they should be taken — free cover first, money second,
 * and an honest "this cannot be closed" third.
 *
 * Each action is a card with one button, because the whole point is that
 * pressing it is the end of the task. An action nobody can complete on the
 * screen that proposes it is a to-do list, not a tool.
 */

import { useState } from 'react';
import { api, type RebalancePlan, type Recommendation } from '../api';
import { useAsync } from '../state';
import { useToast } from '../components/Toast';
import { Button, Card, Chip, DateField, Empty, Loading, Toolbar } from '../components/ui';
import { today } from '../lib/time';

const KIND_TONE: Record<Recommendation['kind'], string> = {
  MOVE_BREAKS: 'good',
  OFFER_EXTRA_HOURS: 'warn',
  UNFILLABLE: 'error',
};

const KIND_LABEL: Record<Recommendation['kind'], string> = {
  MOVE_BREAKS: 'Free',
  OFFER_EXTRA_HOURS: 'Costs hours',
  UNFILLABLE: 'Cannot be covered',
};

export function Rebalance() {
  const [date, setDate] = useState(today());
  const toast = useToast();
  const [posted, setPosted] = useState<Set<string>>(new Set());

  const plan = useAsync(
    () => api.get<RebalancePlan>(`/rebalance?date=${date}`),
    [date],
  );

  const data = plan.data;
  const actions = data?.recommendations ?? [];
  const free = mergeByGap(actions.filter((a) => a.kind === 'MOVE_BREAKS'));
  const costly = actions.filter((a) => a.kind === 'OFFER_EXTRA_HOURS');
  const stuck = actions.filter((a) => a.kind === 'UNFILLABLE');

  // Counted from what is on screen rather than taken from the server, which
  // counts before the cards are merged — a header reading "6 actions" above
  // five cards is a small thing that makes somebody recount everything else.
  const shown = free.length + costly.length + stuck.length;
  const summary =
    shown === 0
      ? 'The day is covered. Nothing to do.'
      : [
          `${shown} ${shown === 1 ? 'action' : 'actions'}`,
          free.length > 0 ? `${free.length} free` : null,
          costly.length > 0 ? `${costly.length} needing extra hours` : null,
          stuck.length > 0 ? `${stuck.length} that cannot be covered` : null,
        ]
          .filter(Boolean)
          .join(', ') + '.';

  async function postOffer(action: Recommendation) {
    const key = `${action.gap.from}-${action.gap.to}`;
    try {
      // The headline already carries the window that should be posted, so the
      // offer matches what the supervisor was shown rather than being
      // recomputed into something slightly different.
      const [from, to] = action.headline.split(' for ')[1].split('–');
      await api.post('/rebalance/offer', {
        date,
        startTime: from.trim(),
        endTime: to.trim(),
        slots: action.people,
        note: `Cover for ${from.trim()}–${to.trim()}, ${action.gap.shortBy} short at worst.`,
      });
      setPosted((p) => new Set(p).add(key));
      toast.success(
        `Offered ${action.people} ${action.people === 1 ? 'slot' : 'slots'} for ${from.trim()}–${to.trim()}.`,
        'It is now visible to everyone who is off and under their weekly limit.',
      );
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <>
      <Toolbar>
        <DateField value={date} onChange={setDate} label="Day" />
        {data && <span className="ops-summary">{summary}</span>}
      </Toolbar>

      {plan.loading && <Loading what="the day" />}
      {plan.error && <Empty>{plan.error}</Empty>}

      {data && actions.length === 0 && (
        <Card>
          <div className="ops-clear">
            <span className="ops-clear-mark" aria-hidden="true" />
            <div>
              <h3>The day is covered</h3>
              <p className="muted">
                Every interval with volume in it has the people the forecast asks for. Nothing to
                do.
              </p>
            </div>
          </div>
        </Card>
      )}

      {/* Ordered deliberately: free before costly before impossible. A screen
          that sorted by size would put a large gap that costs money above a
          small one that costs nothing, and the cheap fix is always first. */}
      {free.length > 0 && (
        <Section
          title="Cover you already have"
          note="The people are rostered; their breaks are in the wrong place. These cost nothing."
        >
          {free.map((action, i) => (
            <ActionCard key={`free-${i}`} action={action} sources={action.sources} />
          ))}
        </Section>
      )}

      {costly.length > 0 && (
        <Section
          title="Cover you would have to buy"
          note="What moving breaks cannot close. Posting an offer makes it visible to everyone off that day and under their weekly limit."
        >
          {costly.map((action, i) => {
            const key = `${action.gap.from}-${action.gap.to}`;
            return (
              <ActionCard
                key={`buy-${i}`}
                action={action}
                onAct={() => postOffer(action)}
                actLabel={posted.has(key) ? 'Offer posted' : `Offer ${action.people} ${action.people === 1 ? 'slot' : 'slots'}`}
                acted={posted.has(key)}
              />
            );
          })}
        </Section>
      )}

      {stuck.length > 0 && (
        <Section
          title="Cover you do not have"
          note="Nobody is available who is under the 48 hour weekly limit. These need a decision rather than a roster change."
        >
          {stuck.map((action, i) => (
            <ActionCard key={`stuck-${i}`} action={action} />
          ))}
        </Section>
      )}

      {data && data.candidates.length > 0 && (
        <Card
          title={`${data.candidates.length} available for extra hours`}
          subtitle="Off this day, not on approved leave, and with room under the 48 hour week."
        >
          <div className="candidate-grid">
            {data.candidates.map((c) => (
              <div key={c.userId} className="candidate">
                <div className="candidate-name">{c.name}</div>
                <div className="muted small">
                  {c.weekHours}h rostered · <strong>{c.headroom}h</strong> room
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}

/**
 * One gap, one card.
 *
 * A gap wide enough to need cover from two different surpluses came back as
 * two recommendations with the same headline, which on screen read as the same
 * suggestion printed twice — the exact thing that makes somebody stop trusting
 * an automated list. The sources are merged into one card that names each of
 * them, because "take 2.5 hours from the morning and 5.5 from mid-morning" is
 * one decision, not two.
 */
function mergeByGap(actions: Recommendation[]): Merged[] {
  const byGap = new Map<string, Merged>();
  for (const action of actions) {
    const key = `${action.gap.from}-${action.gap.to}`;
    const existing = byGap.get(key);
    if (existing) {
      existing.covers += action.covers;
      existing.sources.push(action);
    } else {
      byGap.set(key, { ...action, covers: action.covers, sources: [action] });
    }
  }
  return [...byGap.values()];
}

interface Merged extends Recommendation {
  sources: Recommendation[];
}

function Section({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section className="ops-section">
      <div className="ops-section-head">
        <h3>{title}</h3>
        <p className="muted">{note}</p>
      </div>
      <div className="ops-actions">{children}</div>
    </section>
  );
}

function ActionCard({
  action,
  sources,
  onAct,
  actLabel,
  acted,
}: {
  action: Recommendation;
  sources?: Recommendation[];
  onAct?: () => void;
  actLabel?: string;
  acted?: boolean;
}) {
  const shortHours = (action.gap.agentIntervals * 30) / 60;
  const coveredHours = ((sources ?? [action]).reduce((sum, s) => sum + s.covers, 0) * 30) / 60;
  const many = (sources?.length ?? 1) > 1;

  return (
    <article className={`ops-action ops-action-${action.kind.toLowerCase().replace(/_/g, '-')}`}>
      <header>
        <Chip label={KIND_LABEL[action.kind]} tone={KIND_TONE[action.kind]} />
        <h4>{action.headline}</h4>
      </header>
      {many ? (
        <>
          <p>
            {coveredHours} of the {shortHours} agent hours short can be covered by moving breaks
            from {sources!.length} quieter stretches, at no cost.
          </p>
          <ul className="ops-sources">
            {sources!.map((s, i) => (
              <li key={i}>
                <strong>{s.source ? `${s.source.from}–${s.source.to}` : 'nearby'}</strong> —{' '}
                {(s.covers * 30) / 60} agent hours
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p>{action.detail}</p>
      )}
      <dl className="ops-facts">
        <div>
          <dt>Short by</dt>
          <dd>{action.gap.shortBy}</dd>
        </div>
        <div>
          <dt>Agent hours</dt>
          <dd>{shortHours}</dd>
        </div>
        <div>
          <dt>Worst service level</dt>
          <dd>{Math.round(action.gap.worstServiceLevel * 100)}%</dd>
        </div>
      </dl>
      {onAct && (
        <Toolbar>
          <Button variant={acted ? 'default' : 'primary'} onClick={onAct} disabled={acted}>
            {actLabel}
          </Button>
        </Toolbar>
      )}
    </article>
  );
}

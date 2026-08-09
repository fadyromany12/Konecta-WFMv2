/**
 * Absence patterns.
 *
 * Deliberately not a leaderboard. The screen leads with the people over a
 * trigger and then stops — everybody else is behind a disclosure, because a
 * ranked list of every advisor by absence invites comparison that the score was
 * never meant to support.
 *
 * Each row states the shape of the record in words before it states the number.
 * "Six separate occasions, every one a single day" is what a conversation is
 * about; 216 is not, and a team leader reading a bare score will reach for the
 * wrong tone.
 */

import { useEffect, useState } from 'react';
import { api, type AbsencePatterns as Patterns, type AbsenceProfile, type TriggerBand } from '../api';
import { useAsync, useSession } from '../state';
import { Banner, Card, Chip, Empty, GroupPicker, Loading, Toolbar } from '../components/ui';

const BAND_TONE: Record<TriggerBand, string> = {
  NONE: 'neutral',
  REVIEW: 'warn',
  CONCERN: 'warn',
  FORMAL: 'error',
};

export function AbsencePatterns() {
  const { groups } = useSession();
  const [group, setGroup] = useState('');
  const [showEveryone, setShowEveryone] = useState(false);

  // Without this the picker rendered its first option — "-Me" — while the
  // request went out with no group at all and came back with the whole floor,
  // so the control on screen disagreed with the data under it.
  useEffect(() => {
    if (!group && groups.length > 0) {
      setGroup(groups.find((g) => g.type === 'SYSTEM')?.key ?? groups[0].key);
    }
  }, [groups, group]);

  const data = useAsync(
    () => api.get<Patterns>(`/absence/patterns${group ? `?group=${encodeURIComponent(group)}` : ''}`),
    [group],
  );

  const d = data.data;
  const profiles = d?.profiles ?? [];
  const triggered = profiles.filter((p) => p.band !== 'NONE');
  const rest = profiles.filter((p) => p.band === 'NONE' && p.spells > 0);
  const clear = profiles.filter((p) => p.spells === 0);

  return (
    <>
      <Toolbar>
        <GroupPicker groups={groups} value={group} onChange={setGroup} />
        {d && (
          <span className="ops-summary">
            {d.start} to {d.end}
          </span>
        )}
      </Toolbar>

      {data.loading && <Loading what="absence patterns" />}
      {data.error && <Empty>{data.error}</Empty>}

      {d && (
        <>
          <Banner tone="info">
            The Bradford Factor weights how <em>often</em> somebody is absent over how long — ten
            scattered single days score 1000, one ten-day illness scores 10. A score above a trigger
            is a reason to have a conversation, not a conclusion about somebody. Booked leave is not
            counted at all.
          </Banner>

          <Card
            title={
              triggered.length === 0
                ? 'Nobody is over a trigger'
                : `${triggered.length} over a trigger`
            }
            subtitle="Worst first."
          >
            {triggered.length === 0 ? (
              <Empty>No attendance record in this team crosses the first trigger.</Empty>
            ) : (
              <div className="pattern-list">
                {triggered.map((p) => (
                  <PatternRow key={p.userId} profile={p} />
                ))}
              </div>
            )}
          </Card>

          {(rest.length > 0 || clear.length > 0) && (
            <Card>
              <Toolbar>
                <button className="linklike" onClick={() => setShowEveryone((v) => !v)}>
                  {showEveryone ? 'Hide' : 'Show'} the other {rest.length + clear.length} people
                </button>
                <span className="muted small">
                  {rest.length} with some absence, {clear.length} with none
                </span>
              </Toolbar>
              {showEveryone && (
                <div className="pattern-list">
                  {rest.map((p) => (
                    <PatternRow key={p.userId} profile={p} />
                  ))}
                  {clear.length > 0 && (
                    <p className="muted small">
                      No unplanned absence at all: {clear.map((p) => p.name).join(', ')}.
                    </p>
                  )}
                </div>
              )}
            </Card>
          )}

          <Card title="Trigger bands" subtitle="Defaults over a rolling 52 weeks; a real policy sets its own.">
            <div className="trigger-bands">
              {d.triggers.map((t) => (
                <div key={t.band} className={`trigger trigger-${t.band.toLowerCase()}`}>
                  <div className="trigger-score">{t.from === 0 ? 'under 51' : `${t.from}+`}</div>
                  <div className="trigger-label">{t.label}</div>
                </div>
              ))}
            </div>
          </Card>
        </>
      )}
    </>
  );
}

function PatternRow({ profile }: { profile: AbsenceProfile }) {
  return (
    <article className="pattern">
      <div className="pattern-head">
        <div>
          <div className="pattern-name">{profile.name}</div>
          <div className="muted small">
            {profile.employeeId}
            {profile.managerName ? ` · ${profile.managerName}` : ''}
          </div>
        </div>
        <Chip label={profile.bandLabel} tone={BAND_TONE[profile.band]} />
      </div>

      {/* The words before the number, deliberately. */}
      <p className="pattern-summary">{profile.summary}</p>

      <dl className="ops-facts">
        <div>
          <dt>Occasions</dt>
          <dd>{profile.spells}</dd>
        </div>
        <div>
          <dt>Days</dt>
          <dd>{profile.days}</dd>
        </div>
        <div>
          <dt>Score</dt>
          <dd>{profile.score}</dd>
        </div>
        <div>
          <dt>Since last</dt>
          <dd>{profile.daysSinceLast === null ? '—' : `${profile.daysSinceLast}d`}</dd>
        </div>
      </dl>

      {profile.spellDetail.length > 0 && (
        <div className="spells">
          {profile.spellDetail.map((s) => (
            <span key={s.start} className="spell" title={s.codes.join(', ')}>
              {s.start === s.end ? s.start : `${s.start}–${s.end}`}
              {s.days > 1 ? ` (${s.days}d)` : ''}
            </span>
          ))}
        </div>
      )}
    </article>
  );
}

import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  GETTING_AROUND,
  ROLE_GUIDES,
  TAB_GUIDES,
  guideForPath,
  roleGuide,
  roleNoteFor,
} from '../content/guide';
import { restartTour } from './Tour';
import { useSession } from '../state';

/**
 * A slide-in guide that already knows where you are and who you are, so it
 * opens on the screen you are stuck on rather than at a table of contents.
 * Opens with the ? key.
 */
export function GuideDrawer({
  open,
  onClose,
  onStartTour,
}: {
  open: boolean;
  onClose: () => void;
  onStartTour?: () => void;
}) {
  const { user } = useSession();
  const location = useLocation();
  const [showAll, setShowAll] = useState(false);

  const tab = guideForPath(location.pathname);
  const mine = user ? roleGuide(user.role) : undefined;
  // What this screen is for *this* role, which is a different question from
  // what the screen is for.
  const note = user ? roleNoteFor(location.pathname, user.role) : undefined;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && open) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Reset to the contextual view each time it opens.
  useEffect(() => {
    if (open) setShowAll(false);
  }, [open]);

  if (!open) return null;

  return (
    <>
      <div className="guide-scrim" onClick={onClose} aria-hidden="true" />
      <aside className="guide" role="dialog" aria-label="Guide">
        <header className="guide-head">
          <div>
            <h2>{showAll ? 'Full guide' : (tab?.tab ?? 'Guide')}</h2>
            <p className="muted">
              {showAll ? 'Every role and every tab' : (tab?.whenToUse ?? 'Guidance for this screen')}
            </p>
          </div>
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            <button className="btn" onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'This screen' : 'Everything'}
            </button>
            <button className="btn btn-ghost" onClick={onClose} aria-label="Close guide">
              ✕
            </button>
          </div>
        </header>

        <div className="guide-body">
          {!showAll && tab && (
            <>
              <p className="guide-purpose">{tab.purpose}</p>

              {note && (
                <div className="guide-role-note">
                  <h3>As {article(mine?.label ?? 'user')}</h3>
                  <p>{note.focus}</p>
                  {note.steps && (
                    <ol className="guide-steps">
                      {note.steps.map((step) => (
                        <li key={step.title}>
                          <strong>{step.title}</strong>
                          <span>{step.body}</span>
                        </li>
                      ))}
                    </ol>
                  )}
                  {note.watchFor && (
                    <ul className="issues">
                      {note.watchFor.map((item, i) => (
                        <li key={i} className="issue issue-warning">
                          {item}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              <Section title="How to use it">
                <ol className="guide-steps">
                  {tab.steps.map((step) => (
                    <li key={step.title}>
                      <strong>{step.title}</strong>
                      <span>{step.body}</span>
                    </li>
                  ))}
                </ol>
              </Section>

              <Section title="Watch for">
                <ul className="issues">
                  {tab.watchFor.map((item, i) => (
                    <li key={i} className="issue issue-warning">
                      {item}
                    </li>
                  ))}
                </ul>
              </Section>
            </>
          )}

          {!showAll && mine && <RoleCard guide={mine} heading={`You are signed in as a ${mine.label}`} />}

          {!showAll && !tab && <p className="empty">No specific guidance for this screen yet.</p>}

          {/* These work everywhere, so they belong beside every screen's guide
              rather than inside one of them. */}
          {!showAll && <GettingAround />}

          {showAll && (
            <>
              <GettingAround />

              <Section title="Roles">
                {ROLE_GUIDES.map((role) => (
                  <RoleCard key={role.role} guide={role} heading={role.label} compact />
                ))}
              </Section>

              <Section title="Tabs">
                {TAB_GUIDES.map((g) => (
                  <div key={g.path} className="guide-block">
                    <h4>{g.tab}</h4>
                    <p className="guide-purpose">{g.purpose}</p>
                    <ol className="guide-steps">
                      {g.steps.map((step) => (
                        <li key={step.title}>
                          <strong>{step.title}</strong>
                          <span>{step.body}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                ))}
              </Section>
            </>
          )}
        </div>

        <footer className="guide-foot">
          {onStartTour && (
            <button
              className="btn"
              onClick={() => {
                restartTour();
                onClose();
                onStartTour();
              }}
            >
              Take the tour again
            </button>
          )}
          <span className="muted">
            Press <kbd>?</kbd> anywhere to open this, <kbd>Esc</kbd> to close.
          </span>
        </footer>
      </aside>
    </>
  );
}

/** "an Advisor", "a Team Leader" — the labels are data, so the article is too. */
function article(label: string): string {
  return `${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${label}`;
}

function GettingAround() {
  return (
    <Section title="Getting around">
      <ol className="guide-steps">
        {GETTING_AROUND.map((step) => (
          <li key={step.title}>
            <strong>{step.title}</strong>
            <span>{step.body}</span>
          </li>
        ))}
      </ol>
    </Section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="guide-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function RoleCard({
  guide,
  heading,
  compact,
}: {
  guide: (typeof ROLE_GUIDES)[number];
  heading: string;
  compact?: boolean;
}) {
  return (
    <div className="guide-block">
      <h4>{heading}</h4>
      <p className="guide-purpose">{guide.oneLine}</p>

      {!compact && (
        <>
          <h5>Your routine</h5>
          <ol className="guide-steps">
            {guide.routine.map((item, i) => (
              <li key={i}>
                <span>{item}</span>
              </li>
            ))}
          </ol>
        </>
      )}

      <div className="guide-can">
        <div>
          <h5>Can</h5>
          <ul>
            {guide.canDo.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </div>
        <div>
          <h5>Cannot</h5>
          <ul>
            {guide.cannotDo.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

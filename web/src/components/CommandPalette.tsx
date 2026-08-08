import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type Person } from '../api';
import { useSession } from '../state';
import { applyTheme, type ThemeChoice } from '../theme';

/**
 * The command palette.
 *
 * A tool with six tabs, sub-tabs under half of them and a person picker inside
 * most of those has a real navigation cost: getting to one advisor's timecard
 * is four decisions. Cmd-K collapses that to typing their name. It is the one
 * addition that changes how fast the app feels to someone who uses it daily,
 * and it costs a beginner nothing because every route it reaches is still
 * reachable by clicking.
 */

interface Command {
  id: string;
  label: string;
  hint?: string;
  group: string;
  run: () => void;
  /** Extra words to match on that are not worth showing. */
  keywords?: string;
}

export function CommandPalette({
  open,
  onClose,
  onOpenGuide,
}: {
  open: boolean;
  onClose: () => void;
  onOpenGuide: () => void;
}) {
  const navigate = useNavigate();
  const { user, signOut } = useSession();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [people, setPeople] = useState<Person[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset each time it opens: a palette that remembers your last search is a
  // palette you have to clear before you can use it.
  useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
      // Focus after paint, or the browser puts the caret nowhere.
      requestAnimationFrame(() => input.current?.focus());
    }
  }, [open]);

  // The roster is loaded once, on first open, so typing a name is instant.
  useEffect(() => {
    if (!open || !user?.isSupervisor || people.length > 0) return;
    api
      .get<{ people: Person[] }>('/people')
      .then((res) => setPeople(res.people))
      .catch(() => setPeople([]));
  }, [open, user, people.length]);

  const commands = useMemo<Command[]>(() => {
    const go = (to: string) => () => {
      navigate(to);
      onClose();
    };

    const list: Command[] = [
      { id: 'nav-dashboard', group: 'Go to', label: 'Dashboard', hint: 'Live picture', run: go('/dashboard') },
      { id: 'nav-time', group: 'Go to', label: 'Payroll Summary', hint: 'Time & Attendance', run: go('/time') },
      { id: 'nav-calendar', group: 'Go to', label: 'Worked Calendar', run: go('/time/calendar') },
      { id: 'nav-my', group: 'Go to', label: 'My Shifts', run: go('/my') },
      { id: 'nav-reports', group: 'Go to', label: 'Pulse Report', hint: 'Schedule against reality', run: go('/reports') },
    ];

    if (user?.isSupervisor) {
      list.push(
        { id: 'nav-sched', group: 'Go to', label: 'Edit Advisor Schedule', run: go('/scheduling') },
        { id: 'nav-group', group: 'Go to', label: 'Group Schedule Exceptions', run: go('/scheduling/group') },
        {
          id: 'nav-forecast',
          group: 'Go to',
          label: 'Forecast & Coverage',
          hint: 'Erlang C staffing',
          keywords: 'planning erlang staffing coverage',
          run: go('/scheduling/forecast'),
        },
        { id: 'nav-analytics', group: 'Go to', label: 'Analytics', hint: 'Trends and scorecards', run: go('/reports/analytics') },
        { id: 'nav-exceptions', group: 'Go to', label: 'Non-Worked Exceptions', run: go('/reports/exceptions') },
        { id: 'nav-query', group: 'Go to', label: 'Query Tool', run: go('/reports/query') },
        { id: 'nav-admin', group: 'Go to', label: 'Admin', hint: 'Groups, alternates, audit', run: go('/admin') },
      );
    }

    list.push(
      {
        id: 'guide',
        group: 'Help',
        label: 'Open the guide for this screen',
        hint: '?',
        keywords: 'help how do i explain',
        run: () => {
          onOpenGuide();
          onClose();
        },
      },
      ...(['light', 'dark', 'system'] as ThemeChoice[]).map((choice) => ({
        id: `theme-${choice}`,
        group: 'Appearance',
        label: `Switch to ${choice} theme`,
        keywords: 'colour color dark light mode contrast',
        run: () => {
          applyTheme(choice);
          onClose();
        },
      })),
      {
        id: 'sign-out',
        group: 'Session',
        label: 'Sign out',
        run: () => {
          onClose();
          signOut();
        },
      },
    );

    // Jumping straight to a person is the whole reason this exists. Both
    // destinations read ?userId from the URL, so the screen opens already
    // pointed at them rather than at whoever is first alphabetically.
    for (const person of people) {
      list.push({
        id: `person-report-${person.id}`,
        group: 'People',
        label: person.name,
        hint: `${person.employee_id} · Pulse Report`,
        keywords: `${person.employee_id} ${person.email ?? ''} report adherence`,
        run: go(`/reports?userId=${person.id}`),
      });
      list.push({
        id: `person-sched-${person.id}`,
        group: 'People',
        label: `${person.name} — schedule`,
        hint: person.employee_id,
        keywords: `${person.employee_id} schedule shifts`,
        run: go(`/scheduling?userId=${person.id}`),
      });
    }

    return list;
  }, [navigate, onClose, onOpenGuide, people, signOut, user]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands.filter((c) => c.group !== 'People').slice(0, 12);
    return commands
      .map((c) => ({ command: c, score: score(c, q) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map((r) => r.command);
  }, [commands, query]);

  useEffect(() => setCursor(0), [query]);

  // Keep the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [cursor, matches]);

  if (!open) return null;

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(matches.length - 1, c + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      matches[cursor]?.run();
    }
  }

  let lastGroup = '';

  return (
    <div className="palette-scrim" onClick={onClose} role="presentation">
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="palette-input">
          <span aria-hidden="true">⌘</span>
          <input
            ref={input}
            value={query}
            placeholder="Jump to a screen, a person, or a setting…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            aria-label="Search commands"
            aria-activedescendant={matches[cursor] ? `cmd-${matches[cursor].id}` : undefined}
          />
          <kbd>esc</kbd>
        </div>

        <div className="palette-list" ref={listRef} role="listbox">
          {matches.length === 0 && <p className="empty">Nothing matches “{query}”.</p>}
          {matches.map((command, i) => {
            const heading = command.group !== lastGroup ? command.group : null;
            lastGroup = command.group;
            return (
              <div key={command.id}>
                {heading && <div className="palette-group">{heading}</div>}
                <button
                  id={`cmd-${command.id}`}
                  role="option"
                  aria-selected={i === cursor}
                  data-active={i === cursor}
                  className={`palette-item ${i === cursor ? 'active' : ''}`}
                  onMouseEnter={() => setCursor(i)}
                  onClick={command.run}
                >
                  <span>{command.label}</span>
                  {command.hint && <span className="muted">{command.hint}</span>}
                </button>
              </div>
            );
          })}
        </div>

        <footer className="palette-foot muted">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> to move
          </span>
          <span>
            <kbd>↵</kbd> to open
          </span>
          <span>
            <kbd>?</kbd> for the guide
          </span>
        </footer>
      </div>
    </div>
  );
}

/**
 * Ranking, in three passes of decreasing confidence.
 *
 * The obvious implementation — a loose subsequence match over the label, hint
 * and keywords all concatenated — is worse than useless here: searching "sara"
 * finds the s in "pulse", the a in "Ashraf" and so on, so a roster of twenty
 * people returns twenty results and the one you wanted is buried. So the
 * substring passes run against the label first, keywords only ever match as a
 * whole substring, and the loose acronym pass is limited to word initials on
 * short queries, which is the only case where it earns its keep ("fc" →
 * "Forecast & Coverage").
 */
function score(command: Command, needle: string): number {
  const label = command.label.toLowerCase();

  // 1. The label itself, weighted by where the match falls.
  if (label.startsWith(needle)) return 1000;
  const wordStart = label.indexOf(` ${needle}`);
  if (wordStart >= 0) return 900 - wordStart;
  const anywhere = label.indexOf(needle);
  if (anywhere > 0) return 700 - anywhere;

  // 2. Hint and keywords, as a whole substring only — never a subsequence.
  const extras = `${command.hint ?? ''} ${command.keywords ?? ''}`.toLowerCase();
  if (extras.includes(needle)) return 400;

  // 3. Initials, for short queries only: "fc" reaches "Forecast & Coverage",
  // but a four-letter name never drags in an unrelated row.
  if (needle.length <= 4) {
    const initials = label
      .split(/[\s&—-]+/)
      .filter(Boolean)
      .map((word) => word[0])
      .join('');
    if (initials.startsWith(needle)) return 300;
  }

  return 0;
}

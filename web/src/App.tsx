import { useCallback, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useSession } from './state';
import { GuideDrawer } from './components/Guide';
import { Tour, TourPrompt } from './components/Tour';
import { ThemeToggle } from './components/ThemeToggle';
import { NotificationBell } from './components/Notifications';
import { PulseLine } from './components/PulseLine';
import { CommandPalette } from './components/CommandPalette';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { TimeAttendance } from './pages/TimeAttendance';
import { Scheduling } from './pages/Scheduling';
import { MyShifts } from './pages/MyShifts';
import { Admin } from './pages/Admin';
import { Reports } from './pages/Reports';

/**
 * Six tabs, matching how the work actually divides up: clocking, time and
 * attendance, scheduling, absence, administration and reporting.
 */
const TABS = [
  { to: '/dashboard', label: 'Dashboard', supervisorOnly: false },
  { to: '/time', label: 'Time & Attendance', supervisorOnly: false },
  { to: '/scheduling', label: 'Scheduling', supervisorOnly: true },
  { to: '/my', label: 'My Shifts', supervisorOnly: false },
  { to: '/admin', label: 'Admin', supervisorOnly: true },
  { to: '/reports', label: 'Reports', supervisorOnly: false },
];

export function App() {
  const { user, catalog, loading, signOut } = useSession();
  const location = useLocation();
  const [guideOpen, setGuideOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [tour, setTour] = useState<{ open: boolean; at: number }>({ open: false, at: 0 });
  const startTour = useCallback((at = 0) => setTour({ open: true, at }), []);

  const toggleGuide = useCallback(() => setGuideOpen((v) => !v), []);
  const togglePalette = useCallback(() => setPaletteOpen((v) => !v), []);
  const openGuide = useCallback(() => setGuideOpen(true), []);

  // The guide is reachable from anywhere with ?, not just the header button.
  useHotkey('?', toggleGuide);
  // Cmd-K / Ctrl-K, the shortcut every user already has in their fingers.
  useCommandKey(togglePalette);

  if (loading) {
    return (
      <div className="login-wrap">
        <p className="empty">Starting Konecta Pulse…</p>
      </div>
    );
  }

  if (!user) return <Login />;

  const tabs = TABS.filter((t) => !t.supervisorOnly || user.isSupervisor);

  return (
    <div className="app">
      {/* First in the tab order, invisible until focused. Without it a
          keyboard user tabs through the brand, search, bell, theme, guide,
          identity and every navigation tab before reaching the screen they
          asked for — on every single page load. */}
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            Konecta <span>Pulse</span>
          </span>
          <PulseLine />
          <span className="brand-sub">{catalog?.product.acronym}</span>
        </div>
        <div className="topbar-spacer" />
        <button
          className="cmdk"
          onClick={() => setPaletteOpen(true)}
          title="Search and jump anywhere"
          aria-label="Open the command palette"
        >
          <span className="cmdk-label">Search</span>
          <kbd>{isMac() ? '⌘' : 'Ctrl'}K</kbd>
        </button>
        <NotificationBell />
        <ThemeToggle />
        <button
          className="help-btn"
          onClick={openGuide}
          title="Guide for this screen (?)"
          aria-label="Open the guide"
        >
          ?
        </button>
        <div className="who">
          <div className="who-name">{user.name}</div>
          <div className="who-role">
            {user.roleLabel} · {user.employeeId}
            {user.projectId ? ` · ${user.projectId}` : ''}
          </div>
        </div>
        <button className="btn btn-ghost" onClick={signOut}>
          Sign out
        </button>
      </header>

      <nav className="tabs">
        {tabs.map((tab, i) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            style={{ '--i': i } as React.CSSProperties}
            className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>

      {/* Keying on the tab restarts the entrance animation on navigation, so a
          new screen arrives rather than swapping in place. */}
      {/* `tabIndex={-1}` is what makes the skip link actually work. Without it
          the hash changes, the page scrolls, and focus stays on the body — so
          the next Tab goes back to the header the link just skipped. */}
      <main id="main" tabIndex={-1} key={location.pathname.split('/')[1]}>
        {/* Every page had no h1 at all, so a screen reader's heading outline
            started at the first card and never said which screen this was. */}
        <h1 className="sr-only">{tabs.find((t) => location.pathname.startsWith(t.to))?.label ?? 'Konecta Pulse'}</h1>
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/home" element={<Navigate to="/dashboard" replace />} />
          <Route path="/time/*" element={<TimeAttendance />} />
          <Route path="/scheduling/*" element={user.isSupervisor ? <Scheduling /> : <Navigate to="/dashboard" />} />
          <Route path="/my/*" element={<MyShifts />} />
          <Route path="/absence/*" element={<Navigate to="/my" replace />} />
          <Route path="/admin/*" element={user.isSupervisor ? <Admin /> : <Navigate to="/dashboard" />} />
          <Route path="/reports/*" element={<Reports />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </main>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onOpenGuide={openGuide}
        onStartTour={() => startTour(0)}
      />
      <GuideDrawer open={guideOpen} onClose={() => setGuideOpen(false)} onStartTour={() => startTour(0)} />
      <Tour open={tour.open} startAt={tour.at} onClose={() => setTour({ open: false, at: 0 })} />
      {!tour.open && !guideOpen && <TourPrompt onStart={startTour} />}
    </div>
  );
}

function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/**
 * Cmd-K, or Ctrl-K off a Mac. Unlike the `?` shortcut this one deliberately
 * works while a field has focus — the whole point is to leave wherever you are.
 */
function useCommandKey(action: () => void) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        action();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [action]);
}

/** Global single-key shortcut that stays out of the way while typing. */
function useHotkey(key: string, action: () => void) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      if (el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return;
      if (e.key === key) {
        e.preventDefault();
        action();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [key, action]);
}

export function SubTabs({ items }: { items: { to: string; label: string }[] }) {
  return (
    <nav className="subtabs">
      {items.map((item) => (
        <NavLink key={item.to} to={item.to} className={({ isActive }) => `subtab ${isActive ? 'active' : ''}`} end>
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}

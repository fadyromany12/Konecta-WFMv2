import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useSession } from './state';
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
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            Konecta <span>Pulse</span>
          </span>
          <span className="brand-sub">{catalog?.product.acronym}</span>
        </div>
        <div className="topbar-spacer" />
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
        {tabs.map((tab) => (
          <NavLink key={tab.to} to={tab.to} className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}>
            {tab.label}
          </NavLink>
        ))}
      </nav>

      {/* Keying on the tab restarts the entrance animation on navigation, so a
          new screen arrives rather than swapping in place. */}
      <main key={location.pathname.split('/')[1]}>
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
    </div>
  );
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

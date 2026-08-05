import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useSession } from './state';
import { Login } from './pages/Login';
import { Home } from './pages/Home';
import { TimeAttendance } from './pages/TimeAttendance';
import { Scheduling } from './pages/Scheduling';
import { Absence } from './pages/Absence';
import { Admin } from './pages/Admin';
import { Reports } from './pages/Reports';

/**
 * Six tabs, matching how the work actually divides up: clocking, time and
 * attendance, scheduling, absence, administration and reporting.
 */
const TABS = [
  { to: '/home', label: 'Home', supervisorOnly: false },
  { to: '/time', label: 'Time & Attendance', supervisorOnly: false },
  { to: '/scheduling', label: 'Scheduling', supervisorOnly: true },
  { to: '/absence', label: 'Absence', supervisorOnly: false },
  { to: '/admin', label: 'Admin', supervisorOnly: true },
  { to: '/reports', label: 'Reports', supervisorOnly: false },
];

export function App() {
  const { user, catalog, loading, signOut } = useSession();

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

      <main>
        <Routes>
          <Route path="/" element={<Navigate to="/home" replace />} />
          <Route path="/home" element={<Home />} />
          <Route path="/time/*" element={<TimeAttendance />} />
          <Route path="/scheduling/*" element={user.isSupervisor ? <Scheduling /> : <Navigate to="/home" />} />
          <Route path="/absence/*" element={<Absence />} />
          <Route path="/admin/*" element={user.isSupervisor ? <Admin /> : <Navigate to="/home" />} />
          <Route path="/reports/*" element={<Reports />} />
          <Route path="*" element={<Navigate to="/home" replace />} />
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

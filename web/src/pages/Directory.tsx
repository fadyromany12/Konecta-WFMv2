/**
 * The directory: starters, moves and leavers.
 *
 * Built around the three things that actually happen to a floor rather than
 * around the users table. A starter needs a password handed over, so the
 * temporary one is shown once, large, with a warning that it will not be shown
 * again. A move is a change of manager and nothing else nine times out of ten,
 * so it is one control rather than a form. A leaver is a date.
 */

import { useState } from 'react';
import { api, type Person, type User } from '../api';
import { useAsync, useSession } from '../state';
import { useToast } from '../components/Toast';
import { Banner, Button, Card, Chip, DateField, Empty, Loading, Toolbar } from '../components/ui';
import { today } from '../lib/time';

const ROLE_LABEL: Record<string, string> = {
  ADVISOR: 'Advisor',
  TEAM_LEADER: 'Team Leader',
  TRAINER: 'Trainer',
  OPS_MANAGER: 'Operations Manager',
  ADMIN: 'System Administrator',
};

const STATUS_TONE: Record<string, string> = {
  ACTIVE: 'good',
  ON_LEAVE: 'warn',
  SUSPENDED: 'warn',
  TERMINATED: 'error',
};

export function Directory() {
  const { user } = useSession();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Person | null>(null);
  const [issued, setIssued] = useState<{ name: string; password: string } | null>(null);
  const [query, setQuery] = useState('');

  const people = useAsync(() => api.get<{ people: Person[] }>('/people'), []);
  const canAdminister = (user?.canAdminister ?? []).length > 0;

  const rows = (people.data?.people ?? []).filter((p) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [p.name, p.email, p.employee_id, ROLE_LABEL[p.role] ?? p.role]
      .join(' ')
      .toLowerCase()
      .includes(q);
  });

  async function reload() {
    await people.reload();
  }

  if (!canAdminister) {
    return (
      <Empty>
        Your role can see people but not change their employment records. An Operations Manager or
        System Administrator adds starters and records leavers.
      </Empty>
    );
  }

  return (
    <>
      {issued && (
        <Card title="Hand this over now">
          <Banner tone="warn">
            This is the only time it will be shown. It cannot be looked up afterwards — if it is
            lost, reset the password and issue a new one.
          </Banner>
          <p className="issued-for">{issued.name} signs in with:</p>
          <p className="issued-password">{issued.password}</p>
          <p className="muted">
            They can sign in with it and do nothing else until they choose a password of their own.
          </p>
          <Toolbar>
            <Button onClick={() => setIssued(null)}>I have written it down</Button>
          </Toolbar>
        </Card>
      )}

      <Toolbar>
        <input
          className="search-field"
          type="search"
          placeholder="Search by name, email, employee ID or role"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search the directory"
        />
        <Button variant="primary" onClick={() => { setEditing(null); setAdding(true); }}>
          Add a starter
        </Button>
      </Toolbar>

      {adding && (
        <PersonForm
          user={user!}
          people={people.data?.people ?? []}
          onCancel={() => setAdding(false)}
          onCreated={async (created) => {
            setAdding(false);
            setIssued({ name: created.name, password: created.temporaryPassword });
            await reload();
          }}
        />
      )}

      {editing && (
        <EditPerson
          person={editing}
          user={user!}
          people={people.data?.people ?? []}
          onClose={() => setEditing(null)}
          onChanged={async () => { setEditing(null); await reload(); }}
          onIssued={(name, password) => { setEditing(null); setIssued({ name, password }); }}
        />
      )}

      <Card title={`${rows.length} ${rows.length === 1 ? 'person' : 'people'}`}>
        {people.loading ? (
          <Loading what="the directory" />
        ) : rows.length === 0 ? (
          <Empty>Nobody matches that search.</Empty>
        ) : (
          <div className="table-scroll">
            <table className="grid">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Employee ID</th>
                  <th>Role</th>
                  <th>Reports to</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className={p.effective_status === 'TERMINATED' ? 'row-gone' : undefined}>
                    <td>
                      <div className="person-name">{p.name}</div>
                      <div className="muted small">{p.email}</div>
                    </td>
                    <td className="tabular">{p.employee_id}</td>
                    <td>{ROLE_LABEL[p.role] ?? p.role}</td>
                    <td>{p.manager_name ?? <span className="muted">—</span>}</td>
                    <td>
                      <Chip
                        label={p.leaving ? `Leaves ${p.leave_date}` : p.effective_status.replace('_', ' ')}
                        tone={p.leaving ? 'warn' : STATUS_TONE[p.effective_status] ?? 'neutral'}
                      />
                      {!!p.must_change_password && (
                        <Chip label="Password not yet set" tone="warn" title="Signed in on a temporary password." />
                      )}
                    </td>
                    <td>
                      <Button onClick={() => { setAdding(false); setEditing(p); }}>Manage</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

interface Created {
  id: number;
  name: string;
  temporaryPassword: string;
}

function PersonForm({
  user,
  people,
  onCancel,
  onCreated,
}: {
  user: User;
  people: Person[];
  onCancel: () => void;
  onCreated: (created: Created) => void | Promise<void>;
}) {
  const toast = useToast();
  const [form, setForm] = useState({
    employeeId: '',
    name: '',
    email: '',
    role: 'ADVISOR',
    managerId: '' as string,
    projectId: '',
    departmentCode: '10000',
    shiftRule: 'CR1',
    hireDate: today(),
    region: 'EMEA',
  });
  const [problems, setProblems] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const managers = people.filter((p) => p.role !== 'ADVISOR' && p.effective_status === 'ACTIVE');
  const set = (key: keyof typeof form, value: string) => setForm((f) => ({ ...f, [key]: value }));

  async function submit() {
    setSaving(true);
    setProblems([]);
    try {
      const created = await api.post<Created>('/people', {
        ...form,
        managerId: form.managerId ? Number(form.managerId) : null,
        projectId: form.projectId || null,
        hireDate: form.hireDate || null,
      });
      toast.success(`${created.name} added.`, 'Hand over the temporary password shown on screen.');
      await onCreated(created);
    } catch (err) {
      const body = (err as { body?: { problems?: string[] } }).body;
      if (body?.problems?.length) setProblems(body.problems);
      else toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card title="A new starter">
      {problems.length > 0 && (
        <ul className="problem-list">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div className="form-grid">
        <label>
          <span>Full name</span>
          <input value={form.name} onChange={(e) => set('name', e.target.value)} autoFocus />
        </label>
        <label>
          <span>Employee ID</span>
          <input value={form.employeeId} onChange={(e) => set('employeeId', e.target.value)} />
        </label>
        <label>
          <span>Email</span>
          <input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} />
        </label>
        <label>
          <span>Role</span>
          <select value={form.role} onChange={(e) => set('role', e.target.value)}>
            {user.canAdminister.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r] ?? r}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Reports to</span>
          <select value={form.managerId} onChange={(e) => set('managerId', e.target.value)}>
            <option value="">Nobody</option>
            {managers.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} — {ROLE_LABEL[m.role] ?? m.role}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Start date</span>
          <DateField value={form.hireDate} onChange={(v) => set('hireDate', v)} />
        </label>
      </div>
      <Toolbar>
        <Button variant="primary" onClick={submit} disabled={saving}>
          {saving ? 'Adding…' : 'Add and issue a password'}
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </Toolbar>
    </Card>
  );
}

function EditPerson({
  person,
  user,
  people,
  onClose,
  onChanged,
  onIssued,
}: {
  person: Person;
  user: User;
  people: Person[];
  onClose: () => void;
  onChanged: () => void | Promise<void>;
  onIssued: (name: string, password: string) => void;
}) {
  const toast = useToast();
  const [managerId, setManagerId] = useState(person.manager_id ? String(person.manager_id) : '');
  const [role, setRole] = useState(person.role);
  const [leaveDate, setLeaveDate] = useState(person.leave_date ?? today());
  const [busy, setBusy] = useState(false);

  const managers = people.filter(
    (p) => p.id !== person.id && p.role !== 'ADVISOR' && p.effective_status === 'ACTIVE',
  );
  const isSelf = person.id === user.id;

  async function run(action: () => Promise<unknown>, success: string, detail?: string) {
    setBusy(true);
    try {
      await action();
      toast.success(success, detail);
      await onChanged();
    } catch (err) {
      const body = (err as { body?: { problems?: string[] } }).body;
      toast.error((err as Error).message, body?.problems?.join(' '));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={`Manage ${person.name}`}>
      <div className="form-grid">
        <label>
          <span>Reports to</span>
          <select value={managerId} onChange={(e) => setManagerId(e.target.value)} disabled={isSelf}>
            <option value="">Nobody</option>
            {managers.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} — {ROLE_LABEL[m.role] ?? m.role}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Role</span>
          <select value={role} onChange={(e) => setRole(e.target.value)} disabled={isSelf}>
            {user.canAdminister.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r] ?? r}
              </option>
            ))}
          </select>
        </label>
      </div>
      {isSelf && (
        <Banner tone="info">
          You cannot change your own role or reporting line. Somebody else does it, so the audit
          trail has two names in it.
        </Banner>
      )}
      <Toolbar>
        <Button
          variant="primary"
          disabled={busy || isSelf}
          onClick={() =>
            run(
              () =>
                api.patch('/people/' + person.id, {
                  managerId: managerId ? Number(managerId) : null,
                  role,
                }),
              `${person.name} updated.`,
            )
          }
        >
          Save changes
        </Button>
        <Button onClick={onClose}>Close</Button>
      </Toolbar>

      <hr className="rule" />

      <h4>Password</h4>
      <p className="muted">
        Issues a new temporary password and locks the account to the password screen until it is
        changed. Their existing password stops working immediately.
      </p>
      <Toolbar>
        <Button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const out = await api.post<{ temporaryPassword: string }>(
                `/people/${person.id}/reset-password`,
              );
              onIssued(person.name, out.temporaryPassword);
            } catch (err) {
              toast.error((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Reset password
        </Button>
      </Toolbar>

      <hr className="rule" />

      <h4>Leaving</h4>
      {person.leaving || person.effective_status === 'TERMINATED' ? (
        <>
          <p className="muted">
            {person.effective_status === 'TERMINATED'
              ? `Left on ${person.leave_date}. Access ended the morning after.`
              : `Last working day is ${person.leave_date}. They keep full access until the end of it.`}
          </p>
          <Toolbar>
            <Button
              disabled={busy}
              onClick={() =>
                run(() => api.post(`/people/${person.id}/reinstate`), `${person.name} reinstated.`, 'Any lockout was cleared too.')
              }
            >
              Cancel the leaving date
            </Button>
          </Toolbar>
        </>
      ) : (
        <>
          <p className="muted">
            Access ends the morning after the last working day, so the notice period stays workable.
            Anyone reporting to them has to be moved first.
          </p>
          <Toolbar>
            <DateField value={leaveDate} onChange={setLeaveDate} />
            <Button
              variant="danger"
              disabled={busy || isSelf}
              onClick={() =>
                run(
                  () => api.post(`/people/${person.id}/leave`, { leaveDate }),
                  `${person.name} leaves on ${leaveDate}.`,
                  'Access ends the following morning.',
                )
              }
            >
              Record leaving date
            </Button>
          </Toolbar>
        </>
      )}
    </Card>
  );
}

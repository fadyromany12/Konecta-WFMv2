import { useEffect, useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import { SubTabs } from '../App';
import { api, type Person } from '../api';
import { useAsync, useSession } from '../state';
import { Banner, Button, Card, Chip, DateField, Empty, GroupPicker, Loading, Toolbar } from '../components/ui';
import { addDays, today } from '../lib/time';

export function Admin() {
  return (
    <>
      <SubTabs
        items={[
          { to: '/admin', label: 'Details of Who' },
          { to: '/admin/supervisor', label: 'Supervisor Admin' },
          { to: '/admin/alternate', label: 'Alternate Team Leader' },
          { to: '/admin/audit', label: 'Audit Trail' },
        ]}
      />
      <Routes>
        <Route index element={<DetailsOfWho />} />
        <Route path="supervisor" element={<SupervisorAdmin />} />
        <Route path="alternate" element={<AlternateUser />} />
        <Route path="audit" element={<AuditTrail />} />
      </Routes>
    </>
  );
}

/** Who you can see, and the custom groups you have built out of them. */
function DetailsOfWho() {
  const { groups, refreshGroups } = useSession();
  const [group, setGroup] = useState('');
  const [checked, setChecked] = useState<number[]>([]);
  const [name, setName] = useState('');
  const [flash, setFlash] = useState<{ tone: 'good' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (!group && groups.length > 0) setGroup(groups.find((g) => g.type === 'SYSTEM')?.key ?? groups[0].key);
  }, [groups, group]);

  const people = useAsync(
    () => (group ? api.get<{ people: Person[] }>(`/people?group=${encodeURIComponent(group)}`) : Promise.resolve({ people: [] })),
    [group],
  );

  const current = groups.find((g) => g.key === group);

  async function createGroup() {
    setFlash(null);
    try {
      await api.post('/admin/groups', { name, userIds: checked });
      setFlash({ tone: 'good', text: `Custom group -${name} created.` });
      setName('');
      setChecked([]);
      await refreshGroups();
    } catch (err) {
      setFlash({ tone: 'error', text: (err as Error).message });
    }
  }

  async function deleteGroup() {
    if (!current || current.type !== 'CUSTOM') return;
    try {
      await api.del(`/admin/groups/${encodeURIComponent(current.key.replace(/^-/, ''))}`);
      setFlash({ tone: 'good', text: `Deleted ${current.key}.` });
      setGroup('');
      await refreshGroups();
    } catch (err) {
      setFlash({ tone: 'error', text: (err as Error).message });
    }
  }

  return (
    <>
      <Toolbar>
        <GroupPicker groups={groups} value={group} onChange={setGroup} />
        {current?.type === 'CUSTOM' && (
          <Button variant="danger" onClick={deleteGroup}>
            Delete group
          </Button>
        )}
        <div style={{ flex: 1 }} />
        <label className="field">
          <span>New custom group from ticked rows</span>
          <input value={name} placeholder="Group name" onChange={(e) => setName(e.target.value)} />
        </label>
        <Button variant="primary" onClick={createGroup} disabled={!name || checked.length === 0}>
          Save group
        </Button>
      </Toolbar>

      {flash && <Banner tone={flash.tone}>{flash.text}</Banner>}

      <Card
        title={current?.name ?? 'People'}
        subtitle="Groups prefixed -- come from the reporting hierarchy, - are your own, ALT_ are delegated to you."
      >
        {people.loading && <Loading what="people" />}
        {people.data?.people.length === 0 && !people.loading && <Empty>No employees in this group.</Empty>}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th />
                <th>Employee</th>
                <th>Role</th>
                <th>Project</th>
                <th>Department</th>
                <th>Shift rule</th>
                <th>Reports to</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {people.data?.people.map((p) => (
                <tr key={p.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={checked.includes(p.id)}
                      onChange={(e) =>
                        setChecked((c) => (e.target.checked ? [...c, p.id] : c.filter((id) => id !== p.id)))
                      }
                    />
                  </td>
                  <td>
                    {p.name}
                    <div className="muted mono">{p.employee_id}</div>
                  </td>
                  <td>{p.role.replace(/_/g, ' ').toLowerCase()}</td>
                  <td className="mono">{p.project_id ?? <span className="muted">none</span>}</td>
                  <td className="mono">{p.department_code}</td>
                  <td className="mono">{p.shift_rule}</td>
                  <td className="muted">{p.manager_name ?? '—'}</td>
                  <td>
                    <Chip label={p.status.toLowerCase()} tone={p.status === 'ACTIVE' ? 'good' : 'warn'} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

/** Shift rules, which may only ever be changed with effect from a future date. */
function SupervisorAdmin() {
  const { groups, catalog } = useSession();
  const [group, setGroup] = useState('');
  const [personId, setPersonId] = useState<number | null>(null);
  const [rule, setRule] = useState('CR1');
  const [effective, setEffective] = useState(addDays(today(), 14));
  const [flash, setFlash] = useState<{ tone: 'good' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (!group && groups.length > 0) setGroup(groups.find((g) => g.type === 'SYSTEM')?.key ?? groups[0].key);
  }, [groups, group]);

  const people = useAsync(
    () => (group ? api.get<{ people: Person[] }>(`/people?group=${encodeURIComponent(group)}`) : Promise.resolve({ people: [] })),
    [group],
  );

  useEffect(() => {
    const list = people.data?.people ?? [];
    if (list.length > 0 && !list.some((p) => p.id === personId)) setPersonId(list[0].id);
  }, [people.data, personId]);

  const detail = useAsync(
    () => (personId ? api.get<any>(`/people/${personId}`) : Promise.resolve(null)),
    [personId],
  );

  async function save() {
    setFlash(null);
    try {
      const res = await api.post<{ message: string }>('/admin/shift-rule', {
        userId: personId,
        shiftRule: rule,
        effectiveDate: effective,
      });
      setFlash({ tone: 'good', text: res.message });
      detail.reload();
    } catch (err) {
      setFlash({ tone: 'error', text: (err as Error).message });
    }
  }

  return (
    <>
      <Toolbar>
        <GroupPicker groups={groups} value={group} onChange={setGroup} />
        <label className="field">
          <span>Employee</span>
          <select value={personId ?? ''} onChange={(e) => setPersonId(Number(e.target.value))}>
            {people.data?.people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.employee_id})
              </option>
            ))}
          </select>
        </label>
      </Toolbar>

      {flash && <Banner tone={flash.tone}>{flash.text}</Banner>}

      <div className="grid-2">
        <Card title="Default shift rule" subtitle="A change can only take effect from a future date.">
          <Toolbar>
            <label className="field">
              <span>Shift rule</span>
              <select value={rule} onChange={(e) => setRule(e.target.value)}>
                {catalog?.shiftRules.map((r) => (
                  <option key={r.code} value={r.code}>
                    {r.code} — {r.name}
                  </option>
                ))}
              </select>
            </label>
            <DateField label="Effective date" value={effective} onChange={setEffective} />
            <Button variant="primary" onClick={save}>
              Save
            </Button>
          </Toolbar>
          <p className="muted">{catalog?.shiftRules.find((r) => r.code === rule)?.description}</p>

          <h3 style={{ fontSize: '0.8rem', textTransform: 'uppercase', color: 'var(--text-dim)', marginTop: '1rem' }}>
            History
          </h3>
          {detail.data?.shiftRuleHistory?.length === 0 && <Empty>No rule changes recorded.</Empty>}
          <table>
            <tbody>
              {detail.data?.shiftRuleHistory?.map((h: any) => (
                <tr key={h.id}>
                  <td className="mono">{h.effective_date}</td>
                  <td className="mono">{h.shift_rule}</td>
                  <td>{h.pending ? <Chip label="pending" tone="warn" /> : <Chip label="in force" tone="good" />}</td>
                  <td className="muted">by {h.created_by_name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card title="Employee record" tone="quiet">
          {detail.loading && <Loading what="employee" />}
          {detail.data && (
            <table>
              <tbody>
                <tr>
                  <th>Employee ID</th>
                  <td className="mono">{detail.data.person.employeeId}</td>
                </tr>
                <tr>
                  <th>Role</th>
                  <td>{detail.data.person.roleLabel}</td>
                </tr>
                <tr>
                  <th>Project</th>
                  <td className="mono">
                    {detail.data.project
                      ? `${detail.data.project.activity_id} — ${detail.data.project.name}, ${detail.data.project.site}`
                      : 'none'}
                  </td>
                </tr>
                <tr>
                  <th>Financial number</th>
                  <td className="mono">{detail.data.project?.financial_number ?? '—'}</td>
                </tr>
                <tr>
                  <th>Department</th>
                  <td className="mono">{detail.data.person.departmentCode}</td>
                </tr>
                <tr>
                  <th>Rule in force</th>
                  <td>
                    {detail.data.shiftRule.code} — {detail.data.shiftRule.name}
                    <div className="muted">
                      {detail.data.shiftRule.lateGraceMinutes} min grace · {detail.data.shiftRule.lunchMinutes} min meal
                    </div>
                  </td>
                </tr>
                <tr>
                  <th>Accruals</th>
                  <td>
                    {detail.data.accruals.map((a: any) => (
                      <div key={a.accrual_type} className="mono">
                        {a.accrual_type}: {a.balance_hours.toFixed(1)}h
                      </div>
                    ))}
                  </td>
                </tr>
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
}

/** Delegation: exactly one alternate at a time, and it must be removed before reassigning. */
function AlternateUser() {
  const [employeeId, setEmployeeId] = useState('');
  const [flash, setFlash] = useState<{ tone: 'good' | 'error'; text: string } | null>(null);
  const alternate = useAsync(() => api.get<any>('/admin/alternate'), []);

  async function assign() {
    setFlash(null);
    try {
      const res = await api.post<{ message: string }>('/admin/alternate', { employeeId });
      setFlash({ tone: 'good', text: res.message });
      setEmployeeId('');
      alternate.reload();
    } catch (err) {
      setFlash({ tone: 'error', text: (err as Error).message });
    }
  }

  async function remove() {
    await api.del('/admin/alternate');
    alternate.reload();
  }

  return (
    <div className="grid-2">
      <Card title="Assign an alternate" subtitle="Your alternate sees your team and your custom groups while assigned.">
        {flash && <Banner tone={flash.tone}>{flash.text}</Banner>}
        <Toolbar>
          <label className="field">
            <span>Alternate employee ID</span>
            <input
              className="mono"
              value={employeeId}
              placeholder="TL0000102"
              onChange={(e) => setEmployeeId(e.target.value)}
            />
          </label>
          <Button variant="primary" onClick={assign} disabled={!employeeId}>
            Assign as alternate
          </Button>
        </Toolbar>

        <h3 style={{ fontSize: '0.8rem', textTransform: 'uppercase', color: 'var(--text-dim)' }}>Current alternate</h3>
        {alternate.data?.current ? (
          <p>
            <Chip label={alternate.data.current.employee_id} tone="accent" /> {alternate.data.current.name}{' '}
            <Button variant="danger" onClick={remove}>
              Remove
            </Button>
          </p>
        ) : (
          <Empty>No alternate assigned.</Empty>
        )}
      </Card>

      <Card title="Delegated to you" tone="quiet">
        {alternate.data?.delegatedToMe?.length === 0 && <Empty>Nobody has delegated their team to you.</Empty>}
        {alternate.data?.delegatedToMe?.map((d: any) => (
          <p key={d.id}>
            <Chip label={`ALT_${d.employee_id}`} tone="accent" /> {d.name}
          </p>
        ))}
      </Card>
    </div>
  );
}

/** Every schedule edit, timecard edit and approval, with who did it. */
function AuditTrail() {
  const [entity, setEntity] = useState('');
  const audit = useAsync(
    () => api.get<{ entries: any[] }>(`/admin/audit${entity ? `?entity=${entity}` : ''}`),
    [entity],
  );

  return (
    <Card title="Audit trail" subtitle="Timecards are financial records. Every change is attributable.">
      <Toolbar>
        <label className="field">
          <span>Entity</span>
          <select value={entity} onChange={(e) => setEntity(e.target.value)}>
            <option value="">All</option>
            <option value="timecard">Timecards</option>
            <option value="schedule">Schedules</option>
            <option value="punch">Punches</option>
            <option value="payroll">Payroll runs</option>
          </select>
        </label>
      </Toolbar>
      {audit.loading && <Loading what="audit trail" />}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>Entity</th>
              <th>Action</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {audit.data?.entries.map((e) => (
              <tr key={e.id}>
                <td className="mono nowrap">{e.at}</td>
                <td>{e.actor_name ?? <span className="muted">system</span>}</td>
                <td className="mono">
                  {e.entity} {e.entity_id}
                </td>
                <td>
                  <Chip
                    label={e.action}
                    tone={e.action.startsWith('EDIT') ? 'warn' : e.action === 'APPROVE' ? 'good' : 'neutral'}
                  />
                </td>
                <td className="muted mono" style={{ maxWidth: '30rem', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {e.detail?.slice(0, 160)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

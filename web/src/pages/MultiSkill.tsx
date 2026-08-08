import { useMemo, useState } from 'react';
import { api } from '../api';
import { useSession } from '../state';
import { useToast } from '../components/Toast';
import { Banner, Button, Card, Chip, Stat, Toolbar } from '../components/ui';

/**
 * Sizing a centre where advisors are not interchangeable.
 *
 * Every other staffing number in this tool comes from Erlang C, which assumes
 * one queue served by identical people. The screens say so, and "treat the
 * requirement as optimistic" is the most useless sentence in the product: it
 * tells a planner their number is wrong and gives them nothing to do about it.
 *
 * This gives them the number. Describe the skills and who can take them, and
 * it simulates the routing rather than assuming it away. The two Erlang bounds
 * are shown beside the answer on purpose — a planner who has sized on pooled
 * Erlang C for years needs to see how far this sits from the figure they know
 * and in which direction, or they will not believe it.
 */

interface SkillRow {
  key: string;
  volume: number;
  ahtSeconds: number;
}

interface PoolRow {
  key: string;
  skills: string[];
}

interface Plan {
  pools: { key: string; agents: number; occupancy: number }[];
  perSkill: { key: string; serviceLevel: number; asaSeconds: number; answered: number }[];
  worstServiceLevel: number;
  overallServiceLevel: number;
  agentsOnPhone: number;
  requiredAgents: number;
  pooledEquivalent: number;
  isolatedEquivalent: number;
  capped: boolean;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function MultiSkill() {
  const { user } = useSession();
  const toast = useToast();

  const [skills, setSkills] = useState<SkillRow[]>([
    { key: 'English', volume: 50, ahtSeconds: 240 },
    { key: 'Arabic', volume: 30, ahtSeconds: 270 },
  ]);
  const [pools, setPools] = useState<PoolRow[]>([
    { key: 'English only', skills: ['English'] },
    { key: 'Arabic only', skills: ['Arabic'] },
    { key: 'Both', skills: ['English', 'Arabic'] },
  ]);
  const [serviceGoal, setServiceGoal] = useState(0.8);
  const [targetSeconds, setTargetSeconds] = useState(20);
  const [shrinkage, setShrinkage] = useState(0.3);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const totalVolume = useMemo(() => skills.reduce((sum, s) => sum + s.volume, 0), [skills]);

  function updateSkill(i: number, patch: Partial<SkillRow>) {
    setSkills((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  function renameSkill(i: number, next: string) {
    const previous = skills[i].key;
    updateSkill(i, { key: next });
    // Keep the pools pointing at the skill they were pointing at, rather than
    // silently un-training everybody the moment somebody fixes a typo.
    setPools((rows) =>
      rows.map((p) => ({ ...p, skills: p.skills.map((k) => (k === previous ? next : k)) })),
    );
  }

  function removeSkill(i: number) {
    const key = skills[i].key;
    setSkills((rows) => rows.filter((_, j) => j !== i));
    setPools((rows) =>
      rows.map((p) => ({ ...p, skills: p.skills.filter((k) => k !== key) })).filter((p) => p.skills.length > 0),
    );
  }

  function togglePoolSkill(i: number, key: string) {
    setPools((rows) =>
      rows.map((p, j) =>
        j === i
          ? { ...p, skills: p.skills.includes(key) ? p.skills.filter((k) => k !== key) : [...p.skills, key] }
          : p,
      ),
    );
  }

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const result = await api.post<Plan>('/forecast/multi-skill', {
        skills,
        pools: pools.filter((p) => p.skills.length > 0),
        serviceGoal,
        targetSeconds,
        shrinkage,
      });
      setPlan(result);
      if (result.capped) {
        toast.warn('The goal could not be met at any headcount tried.', 'Check that every skill has somebody trained on it.');
      }
    } catch (err) {
      setError((err as Error).message);
      setPlan(null);
    } finally {
      setRunning(false);
    }
  }

  if (!user?.isSupervisor) return <Banner tone="error">Planning is a supervisor function.</Banner>;

  return (
    <>
      <Toolbar>
        <label className="field">
          <span>Answer</span>
          <select value={serviceGoal} onChange={(e) => setServiceGoal(Number(e.target.value))}>
            {[0.7, 0.75, 0.8, 0.85, 0.9].map((g) => (
              <option key={g} value={g}>
                {pct(g)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Within (s)</span>
          <input
            type="number"
            className="num-input"
            min={1}
            value={targetSeconds}
            onChange={(e) => setTargetSeconds(Math.max(1, Number(e.target.value)))}
          />
        </label>
        <label className="field">
          <span>Shrinkage</span>
          <select value={shrinkage} onChange={(e) => setShrinkage(Number(e.target.value))}>
            {[0, 0.1, 0.2, 0.3, 0.35, 0.4].map((g) => (
              <option key={g} value={g}>
                {pct(g)}
              </option>
            ))}
          </select>
        </label>
        <Button variant="primary" onClick={run} disabled={running || skills.length === 0}>
          {running ? 'Simulating…' : 'Size it'}
        </Button>
        <div style={{ flex: 1 }} />
        <span className="muted">{totalVolume} contacts in the half hour</span>
      </Toolbar>

      {error && <Banner tone="error">{error}</Banner>}

      <div className="grid-2">
        <Card title="Skills" subtitle="What arrives, and how long each kind takes to handle.">
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Skill</th>
                  <th className="right">Contacts</th>
                  <th className="right">Handling (s)</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {skills.map((skill, i) => (
                  <tr key={i}>
                    <td>
                      <input
                        value={skill.key}
                        onChange={(e) => renameSkill(i, e.target.value)}
                        aria-label={`Skill ${i + 1} name`}
                      />
                    </td>
                    <td className="right">
                      <input
                        type="number"
                        min={0}
                        className="num-input"
                        value={skill.volume}
                        onChange={(e) => updateSkill(i, { volume: Math.max(0, Number(e.target.value)) })}
                        aria-label={`${skill.key} contacts`}
                      />
                    </td>
                    <td className="right">
                      <input
                        type="number"
                        min={1}
                        className="num-input"
                        value={skill.ahtSeconds}
                        onChange={(e) => updateSkill(i, { ahtSeconds: Math.max(1, Number(e.target.value)) })}
                        aria-label={`${skill.key} handling time`}
                      />
                    </td>
                    <td className="right">
                      <Button onClick={() => removeSkill(i)}>Remove</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Toolbar>
            <Button
              onClick={() =>
                setSkills((rows) => [...rows, { key: `Skill ${rows.length + 1}`, volume: 20, ahtSeconds: 240 }])
              }
            >
              Add a skill
            </Button>
          </Toolbar>
        </Card>

        <Card title="Who can take what" subtitle="A pool trained on several skills is your flexibility.">
          <ul className="pools">
            {pools.map((pool, i) => (
              <li key={i}>
                <input
                  value={pool.key}
                  onChange={(e) =>
                    setPools((rows) => rows.map((p, j) => (j === i ? { ...p, key: e.target.value } : p)))
                  }
                  aria-label={`Pool ${i + 1} name`}
                />
                <div className="pool-skills">
                  {skills.map((skill) => (
                    <label key={skill.key} className="pool-skill">
                      <input
                        type="checkbox"
                        checked={pool.skills.includes(skill.key)}
                        onChange={() => togglePoolSkill(i, skill.key)}
                      />
                      <span>{skill.key}</span>
                    </label>
                  ))}
                </div>
                <Button onClick={() => setPools((rows) => rows.filter((_, j) => j !== i))}>Remove</Button>
              </li>
            ))}
          </ul>
          <Toolbar>
            <Button onClick={() => setPools((rows) => [...rows, { key: `Pool ${rows.length + 1}`, skills: [] }])}>
              Add a pool
            </Button>
          </Toolbar>
        </Card>
      </div>

      {plan && (
        <>
          <Toolbar>
            <div className="stats">
              <Stat label="On the phone" value={plan.agentsOnPhone} />
              <Stat label="Rostered" value={plan.requiredAgents} tone="accent" />
              <Stat
                label="Worst skill"
                value={pct(plan.worstServiceLevel)}
                tone={plan.worstServiceLevel >= serviceGoal ? 'good' : 'error'}
              />
              <Stat label="Overall" value={pct(plan.overallServiceLevel)} />
            </div>
          </Toolbar>

          {plan.capped && (
            <Banner tone="error">
              No headcount tried met the goal on every skill. Usually that means a skill nobody is trained on, or
              a target so tight that no roster reaches it.
            </Banner>
          )}

          <Card title="What it costs to have skills" subtitle="The same traffic, sized three ways.">
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Model</th>
                    <th className="right">On the phone</th>
                    <th>What it assumes</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>One pooled queue</td>
                    <td className="right num">{plan.pooledEquivalent}</td>
                    <td className="muted">
                      Everybody can take everything. This is what the rest of the tool assumes, and it under-staffs
                      by {Math.max(0, plan.agentsOnPhone - plan.pooledEquivalent)}.
                    </td>
                  </tr>
                  <tr className="row-strong">
                    <td>
                      Simulated routing <Chip label="this plan" tone="accent" />
                    </td>
                    <td className="right num">{plan.agentsOnPhone}</td>
                    <td className="muted">
                      The skills and pools as described, with contacts routed to the least flexible advisor who can
                      take them.
                    </td>
                  </tr>
                  <tr>
                    <td>Each skill on its own</td>
                    <td className="right num">{plan.isolatedEquivalent}</td>
                    <td className="muted">
                      No cross-training at all. The gap to the row above is what your flexible people are worth:{' '}
                      {Math.max(0, plan.isolatedEquivalent - plan.agentsOnPhone)} advisors.
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>

          <div className="grid-2">
            <Card title="Where to put them" tone="quiet">
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Pool</th>
                      <th className="right">Advisors</th>
                      <th className="right">Occupancy</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.pools.map((pool) => (
                      <tr key={pool.key}>
                        <td>{pool.key}</td>
                        <td className="right num">{pool.agents}</td>
                        <td className="right num">
                          {pct(pool.occupancy)}
                          {pool.occupancy > 0.85 && <Chip label="high" tone="warn" />}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card title="How each skill fares" tone="quiet">
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Skill</th>
                      <th className="right">Answered in target</th>
                      <th className="right">Average wait</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.perSkill.map((skill) => (
                      <tr key={skill.key}>
                        <td>{skill.key}</td>
                        <td className="right num">
                          {pct(skill.serviceLevel)}
                          {skill.serviceLevel < serviceGoal && <Chip label="under" tone="error" />}
                        </td>
                        <td className="right num">{Math.round(skill.asaSeconds)}s</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        </>
      )}

      <p className="muted">
        This simulates rather than assuming. Contacts arrive at random, handling times vary, and a contact goes to
        the least flexible advisor who can take it — so the people trained on everything stay free for the queue
        that has nobody else. The generator is seeded, so the same inputs give the same answer every time; a
        planning figure that moves when you reload is worse than one that is slightly wrong.
      </p>
    </>
  );
}

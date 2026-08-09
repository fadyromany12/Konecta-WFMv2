/**
 * How wrong the forecast was.
 *
 * Leads with WAPE rather than MAPE, and with the direction of the error rather
 * than its size, because those are the two things a planner can act on: a
 * consistent bias is corrected with one number, and noise is not correctable at
 * all. The plain-English reading sits above the figures for the same reason —
 * "the forecast ran 8% low, so the floor was short" is an instruction, and
 * "WAPE 0.084" is a fact nobody does anything with.
 */

import { useState } from 'react';
import { api, type AccuracyReport } from '../api';
import { useAsync } from '../state';
import { Card, DateField, Empty, Loading, Toolbar } from '../components/ui';
import { addDays, today } from '../lib/time';

const pct = (n: number | null, digits = 1) => (n === null ? '—' : `${(n * 100).toFixed(digits)}%`);

/** Below 10% is good for a contact centre; past 20% the roster is guesswork. */
function qualityOf(wape: number | null): 'good' | 'warn' | 'bad' | 'none' {
  if (wape === null) return 'none';
  if (wape <= 0.1) return 'good';
  if (wape <= 0.2) return 'warn';
  return 'bad';
}

export function Accuracy() {
  const [end, setEnd] = useState(addDays(today(), -1));
  const [start, setStart] = useState(addDays(today(), -28));

  const report = useAsync(
    () => api.get<AccuracyReport>(`/accuracy?start=${start}&end=${end}`),
    [start, end],
  );

  const d = report.data;

  return (
    <>
      <Toolbar>
        <DateField value={start} onChange={setStart} label="From" />
        <DateField value={end} onChange={setEnd} label="To" />
      </Toolbar>

      {report.loading && <Loading what="forecast accuracy" />}
      {report.error && <Empty>{report.error}</Empty>}

      {d && (
        <>
          <Card>
            {/* The reading first. Everything below it is the evidence. */}
            <ul className="reading">
              {d.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </Card>

          <div className="kpis">
            <Figure
              label="Weighted error"
              value={pct(d.wape)}
              tone={qualityOf(d.wape)}
              note="Total error over total volume. The one to lead with — a busy interval 10% out matters more than a quiet one that doubled."
            />
            <Figure
              label="Direction"
              value={d.bias === null ? '—' : `${d.bias > 0 ? '+' : ''}${pct(d.bias)}`}
              tone={d.bias === null ? 'none' : Math.abs(d.bias) < 0.05 ? 'good' : 'warn'}
              note={
                d.bias === null
                  ? 'Nothing measurable.'
                  : d.bias > 0
                    ? 'Positive means the forecast ran low and the floor was short.'
                    : 'Negative means the floor was staffed for work that did not come.'
              }
            />
            <Figure
              label="Mean error"
              value={pct(d.mape)}
              tone="none"
              note="The unweighted average, for comparison. Quiet intervals move it a long way."
            />
            <Figure
              label="Handling time"
              value={d.ahtBiasSeconds === null ? '—' : `${d.ahtBiasSeconds > 0 ? '+' : ''}${Math.round(d.ahtBiasSeconds)}s`}
              tone={d.ahtBiasSeconds === null ? 'none' : Math.abs(d.ahtBiasSeconds) < 10 ? 'good' : 'warn'}
              note="Calls running long costs staffing even when the volume forecast is right."
            />
            <Figure
              label="Measured"
              value={`${d.measured}`}
              tone={d.unmeasured > d.measured ? 'warn' : 'none'}
              note={`${d.unmeasured} interval${d.unmeasured === 1 ? '' : 's'} with a forecast but no actual, excluded.`}
            />
          </div>

          <Card
            title="Where it went wrong"
            subtitle="Ranked by calls, not by percentage — a quiet interval that doubled did not hurt anybody."
          >
            {d.worst.length === 0 ? (
              <Empty>Nothing measured in this period.</Empty>
            ) : (
              <div className="table-scroll">
                <table className="grid">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Interval</th>
                      <th className="num">Forecast</th>
                      <th className="num">Actual</th>
                      <th className="num">Out by</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.worst.map((w) => (
                      <tr key={`${w.date} ${w.startTime}`}>
                        <td>{w.date}</td>
                        <td className="tabular">{w.startTime}</td>
                        <td className="num tabular">{w.forecastVolume}</td>
                        <td className="num tabular">{w.actualVolume}</td>
                        <td className={`num tabular ${w.error > 0 ? 'delta-short' : 'delta-over'}`}>
                          {w.error > 0 ? '+' : ''}
                          {w.error}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="Day by day" subtitle="So a bad Tuesday is visible rather than averaged away.">
            {d.byDay.length === 0 ? (
              <Empty>No days in this range have anything recorded.</Empty>
            ) : (
              <div className="daybars">
                {d.byDay.map((day) => {
                  const worst = Math.max(...d.byDay.map((x) => Math.max(x.forecast, x.actual)), 1);
                  return (
                    <div key={day.date} className="daybar" title={`${day.date}: forecast ${day.forecast}, actual ${day.actual}`}>
                      <div className="daybar-pair">
                        <span
                          className="daybar-forecast"
                          style={{ height: `${(day.forecast / worst) * 100}%` }}
                        />
                        <span
                          className="daybar-actual"
                          style={{ height: `${(day.actual / worst) * 100}%` }}
                        />
                      </div>
                      <div className="daybar-label">{day.date.slice(8)}</div>
                    </div>
                  );
                })}
              </div>
            )}
            <p className="muted small legend">
              <span className="swatch swatch-forecast" /> forecast
              <span className="swatch swatch-actual" /> actual
            </p>
          </Card>
        </>
      )}
    </>
  );
}

function Figure({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note: string;
  tone: 'good' | 'warn' | 'bad' | 'none';
}) {
  return (
    <div className={`figure figure-${tone}`}>
      <div className="figure-label">{label}</div>
      <div className="figure-value tabular">{value}</div>
      <div className="figure-note">{note}</div>
    </div>
  );
}

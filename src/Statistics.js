// src/Statistics.js
//
// Long-term audit of doctor scheduling. Reads ALL data live on mount —
// no materialised aggregates, no caching. Cheap at the clinic's scale
// (~25 doctors × few quarters/year).
//
// Sources:
//   • assignments/{year}_Q{n}     — who worked when (the ground truth)
//   • dayStyles/{uid}             — preference history (negative requests)
//   • settings/{uid}              — name, shortcut, shiftInterval
//   • generateHolidays() (utils)  — Czech holidays for 2020-2030
//
// Metrics:
//   1. Per-year + lifetime totals
//   2. Day-of-week split per doctor (Po-Čt / Pá / So / Ne)
//   3. Holiday shift count
//   4. Average negative-preference days per month (from dayStyles)
//   5. Penalty audit (5 SKYNET-style patterns) — see computePenalties().
//
// Penalties are computed from raw assignments without knowledge of past
// `desired_duty` waivers, so destroyed_weekend will fire on Fri+Sun pairs
// even if the doctor explicitly asked for them. That's correct for an
// audit: it surfaces patterns regardless of intent.

import React, { useState, useEffect, useMemo } from 'react';
import { db } from './firebase';
import { collection, getDocs } from 'firebase/firestore';
import { generateHolidays } from './utils';

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

// Mirrors Scheduler.js getEffectiveStatus — keep aligned.
function effectiveStatus(status) {
  if (!status) return null;
  if (status.endsWith('_unblocked')) return 'unblocked';
  if (status.endsWith('_blocked')) return 'blocked';
  return status;
}

function isNegativePref(status) {
  const eff = effectiveStatus(status);
  return eff === 'not available' || eff === 'blocked';
}

function baseGroup(value) {
  return value ? value.replace(/_u$/, '') : null;
}

// UTC date avoids DST midnight oddities when computing day-of-week / gaps.
function dateUTC(dateStr) {
  return new Date(dateStr + 'T00:00:00Z');
}

function daysBetween(a, b) {
  return Math.round((dateUTC(b) - dateUTC(a)) / 86400000);
}

const DOW_LABELS_CS = ['Ne', 'Po', 'Út', 'St', 'Čt', 'Pá', 'So']; // Sun=0 … Sat=6

// ────────────────────────────────────────────────────────────────────
// Aggregation
// ────────────────────────────────────────────────────────────────────

function buildHistory(allAssignments, users, holidaySet) {
  const out = {};
  for (const u of users) out[u.uid] = [];

  for (const [key, value] of Object.entries(allAssignments)) {
    const sep = key.indexOf('_');
    if (sep < 0) continue;
    const date = key.slice(0, sep);
    const uid = key.slice(sep + 1);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (!out[uid]) out[uid] = []; // doctor without settings doc — still count.

    const d = dateUTC(date);
    const dow = d.getUTCDay();           // 0=Sun, 5=Fri, 6=Sat
    const isWeekend = dow === 0 || dow === 6;
    const isHoliday = holidaySet.has(date);

    out[uid].push({
      date,
      group: baseGroup(value),
      year: date.slice(0, 4),
      month: date.slice(0, 7),
      dow,
      isWeekend,
      isHoliday,
    });
  }

  // Sort by date for the pair-wise penalty scan.
  for (const uid of Object.keys(out)) {
    out[uid].sort((a, b) => a.date.localeCompare(b.date));
  }
  return out;
}

// O(n²) over a single doctor's entries, but bounded by gap≤14 (early break),
// so effectively O(n × constant). Fine for any realistic shift count.
function computePenalties(entries, minInterval) {
  const out = {
    consecutive: 0,        // dva po sobě jdoucí dny
    interval: 0,           // gap < minInterval (doctor's own setting)
    destroyed_weekend: 0,  // Pá D, Ne D+2 (or within 1-3 days)
    consec_wk_weeks: 0,    // dvě víkendové služby do 7 dnů
    weekend_spacing: 0,    // dvě víkendové služby 8-14 dnů od sebe
  };
  for (let i = 0; i < entries.length; i++) {
    const a = entries[i];
    for (let j = i + 1; j < entries.length; j++) {
      const b = entries[j];
      const gap = daysBetween(a.date, b.date);
      if (gap > 14) break; // sorted; no closer pairs further on

      if (gap === 1) out.consecutive++;
      if (gap < minInterval) out.interval++;
      // destroyed_weekend: a is Friday, b is Sunday, gap 1-3 days.
      // (Sun could be the same week's Sun, gap=2; or next week's, gap=9 — only count ≤3.)
      if (a.dow === 5 && b.dow === 0 && gap >= 1 && gap <= 3) out.destroyed_weekend++;
      // Both weekend (Sat/Sun) duties.
      if (a.isWeekend && b.isWeekend) {
        if (gap <= 7) out.consec_wk_weeks++;
        else if (gap <= 14) out.weekend_spacing++;
      }
    }
  }
  return out;
}

function computeBlockedAvg(styles, yearFilter) {
  // Per-month negative-pref count → average over months that have any data.
  // yearFilter: 'all' or 'YYYY'.
  const byMonth = {};
  for (const s of styles) {
    if (!s || !s.date || !s.status) continue;
    if (yearFilter !== 'all' && !s.date.startsWith(String(yearFilter))) continue;
    const month = s.date.slice(0, 7);
    if (!byMonth[month]) byMonth[month] = 0;
    if (isNegativePref(s.status)) byMonth[month]++;
  }
  const months = Object.keys(byMonth);
  if (months.length === 0) return null;
  const total = months.reduce((s, m) => s + byMonth[m], 0);
  return total / months.length;
}

function computeAllStats(history, dayStylesAll, users, yearFilter) {
  const byUid = {};
  for (const u of users) {
    const allEntries = history[u.uid] || [];
    const filtered = yearFilter === 'all'
      ? allEntries
      : allEntries.filter(e => e.year === String(yearFilter));

    const minInterval = parseInt(u.shiftInterval, 10) || 7;
    const yearly = {};
    for (const e of allEntries) yearly[e.year] = (yearly[e.year] || 0) + 1;
    const byMonthDow = {}; // {YYYY-MM: [n0..n6]}
    for (const e of filtered) {
      if (!byMonthDow[e.month]) byMonthDow[e.month] = [0, 0, 0, 0, 0, 0, 0];
      byMonthDow[e.month][e.dow]++;
    }

    byUid[u.uid] = {
      uid: u.uid,
      shortcut: u.shortcut || (u.firstName ? u.firstName.slice(0, 4) : u.uid.slice(0, 6)),
      name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.shortcut || '',
      total: filtered.length,
      // dow buckets for the summary table
      weekday: filtered.filter(e => e.dow >= 1 && e.dow <= 4).length, // Po-Čt
      friday:  filtered.filter(e => e.dow === 5).length,
      saturday: filtered.filter(e => e.dow === 6).length,
      sunday:   filtered.filter(e => e.dow === 0).length,
      holidays: filtered.filter(e => e.isHoliday).length,
      blockedAvg: computeBlockedAvg(dayStylesAll[u.uid] || [], yearFilter),
      penalties: computePenalties(filtered, minInterval),
      minInterval,
      yearly,         // {year: count} — for lifetime view
      byMonthDow,     // for per-doctor monthly breakdown
    };
  }
  return byUid;
}

// ────────────────────────────────────────────────────────────────────
// UI
// ────────────────────────────────────────────────────────────────────

const sectionStyle = {
  marginBottom: 20,
  padding: 14,
  border: '1px solid #ddd',
  borderRadius: 6,
  background: '#fafbfc',
};
const sectionTitleStyle = {
  margin: '0 0 10px',
  fontSize: '1em',
  color: '#1976d2',
  fontWeight: 600,
};
const tableStyle = {
  borderCollapse: 'collapse',
  fontSize: '0.85em',
  width: '100%',
};
const thStyle = {
  padding: '6px 8px',
  borderBottom: '2px solid #ccc',
  background: '#eef2f6',
  fontWeight: 600,
  textAlign: 'right',
  whiteSpace: 'nowrap',
};
const tdStyle = {
  padding: '4px 8px',
  borderBottom: '1px solid #eee',
  textAlign: 'right',
};
const tdNameStyle = { ...tdStyle, textAlign: 'left', fontWeight: 500 };
const thNameStyle = { ...thStyle, textAlign: 'left' };

export default function Statistics() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [users, setUsers] = useState([]);
  const [allAssignments, setAllAssignments] = useState({});
  const [dayStylesAll, setDayStylesAll] = useState({});
  const [selectedYear, setSelectedYear] = useState('all');
  const [selectedDoctor, setSelectedDoctor] = useState('all');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        // Three parallel collection reads. Each typically ~10-30 docs.
        const [settingsSnap, assignSnap, stylesSnap] = await Promise.all([
          getDocs(collection(db, 'settings')),
          getDocs(collection(db, 'assignments')),
          getDocs(collection(db, 'dayStyles')),
        ]);

        const usersList = settingsSnap.docs.map(d => ({ uid: d.id, ...d.data() }));

        // Each assignments doc id is "{year}_Q{n}" with field shape
        // {`${date}_${uid}`: groupString}. Merge them all into one map —
        // keys are globally unique (date+uid), so collision-free.
        const merged = {};
        for (const d of assignSnap.docs) {
          Object.assign(merged, d.data());
        }

        const stylesMap = {};
        for (const d of stylesSnap.docs) {
          stylesMap[d.id] = d.data().styles || [];
        }

        if (cancelled) return;
        setUsers(usersList);
        setAllAssignments(merged);
        setDayStylesAll(stylesMap);
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        console.error('Statistics load failed:', e);
        setError(e.message || String(e));
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [reloadKey]);

  // Holiday set — once per data load, covers all years referenced.
  const holidaySet = useMemo(() => {
    const set = new Set();
    for (const h of generateHolidays()) set.add(h.date);
    return set;
  }, []);

  const history = useMemo(
    () => buildHistory(allAssignments, users, holidaySet),
    [allAssignments, users, holidaySet]
  );

  const yearsAvailable = useMemo(() => {
    const years = new Set();
    for (const entries of Object.values(history)) {
      for (const e of entries) years.add(e.year);
    }
    return [...years].sort();
  }, [history]);

  const stats = useMemo(
    () => computeAllStats(history, dayStylesAll, users, selectedYear),
    [history, dayStylesAll, users, selectedYear]
  );

  // Doctors to render = those with any history (in the selected scope) or
  // selected by the doctor filter. Sorted by shortcut.
  const visibleDoctors = useMemo(() => {
    const all = Object.values(stats);
    let kept;
    if (selectedDoctor !== 'all') {
      kept = all.filter(s => s.uid === selectedDoctor);
    } else {
      kept = all.filter(s => s.total > 0 || (s.yearly && Object.keys(s.yearly).length > 0));
    }
    return kept.sort((a, b) => a.shortcut.localeCompare(b.shortcut, 'cs'));
  }, [stats, selectedDoctor]);

  if (loading) {
    return (
      <div style={{ padding: 24 }}>
        <h2>Statistiky</h2>
        <p style={{ color: '#666' }}>Načítám historická data…</p>
      </div>
    );
  }
  if (error) {
    return (
      <div style={{ padding: 24 }}>
        <h2>Statistiky</h2>
        <div style={{
          padding: 14, background: '#f8d7da', color: '#721c24',
          borderLeft: '4px solid #dc3545', borderRadius: 4,
        }}>
          <strong>✗ Načtení selhalo:</strong> {error}
        </div>
        <button onClick={() => setReloadKey(k => k + 1)} style={{ marginTop: 12 }}>
          Zkusit znovu
        </button>
      </div>
    );
  }

  const hasAnyData = Object.values(history).some(arr => arr.length > 0);

  return (
    <div style={{ padding: '16px 24px', maxWidth: 1300, margin: '0 auto' }}>
      <h2 style={{ margin: '0 0 12px', fontSize: '1.4em' }}>
        Statistiky
        <span style={{ marginLeft: 10, fontSize: '0.62em', color: '#777', fontWeight: 400 }}>
          audit · živý výpočet
        </span>
      </h2>

      {/* Filtry */}
      <div style={{
        display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap',
        marginBottom: 16, padding: '8px 12px',
        background: '#f5f7fa', border: '1px solid #d0d7de', borderRadius: 4,
        fontSize: '0.92em',
      }}>
        <label>
          <span style={{ marginRight: 4 }}>Rok:</span>
          <select value={selectedYear} onChange={e => setSelectedYear(e.target.value)}>
            <option value="all">Vše (lifetime)</option>
            {yearsAvailable.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </label>
        <label>
          <span style={{ marginRight: 4 }}>Doktor:</span>
          <select value={selectedDoctor} onChange={e => setSelectedDoctor(e.target.value)}>
            <option value="all">Všichni</option>
            {users
              .filter(u => (history[u.uid] || []).length > 0)
              .sort((a, b) => (a.shortcut || '').localeCompare(b.shortcut || '', 'cs'))
              .map(u => (
                <option key={u.uid} value={u.uid}>
                  {u.shortcut || `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.uid.slice(0, 6)}
                </option>
              ))}
          </select>
        </label>
        <button
          onClick={() => setReloadKey(k => k + 1)}
          style={{
            marginLeft: 'auto', padding: '4px 12px', fontSize: '0.85em',
            background: '#fff', border: '1px solid #c0c7d0',
            borderRadius: 3, cursor: 'pointer', color: '#555',
          }}
          title="Načíst data znovu z Firestore"
        >
          ⟳ Přepočítat
        </button>
      </div>

      {!hasAnyData && (
        <div style={{ padding: 14, background: '#fff3cd', borderRadius: 4, color: '#856404' }}>
          Zatím žádné rozpisy. Vyplň pár kvartálů v Plánovači a vrať se sem.
        </div>
      )}

      {hasAnyData && (
        <>
          <SummarySection
            stats={visibleDoctors}
            yearFilter={selectedYear}
          />
          <PenaltySection
            stats={visibleDoctors}
          />
          <LifetimeSection
            stats={visibleDoctors}
            years={yearsAvailable}
          />
          {selectedDoctor !== 'all' && visibleDoctors[0] && (
            <MonthlyBreakdownSection
              doctorStats={visibleDoctors[0]}
              yearFilter={selectedYear}
            />
          )}
        </>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Sections
// ────────────────────────────────────────────────────────────────────

function SummarySection({ stats, yearFilter }) {
  const scopeLabel = yearFilter === 'all' ? 'Lifetime' : `Rok ${yearFilter}`;
  return (
    <div style={sectionStyle}>
      <h3 style={sectionTitleStyle}>Souhrn — {scopeLabel}</h3>
      <div style={{ overflowX: 'auto' }}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thNameStyle}>Doktor</th>
              <th style={thStyle} title="Všechny služby ve filtrovaném období">Celkem</th>
              <th style={thStyle} title="Pondělí–čtvrtek">Po-Čt</th>
              <th style={thStyle}>Pá</th>
              <th style={thStyle}>So</th>
              <th style={thStyle}>Ne</th>
              <th style={thStyle} title="Služby na český svátek">Sváteční</th>
              <th style={thStyle} title="Průměrný počet zablokovaných dní/měsíc ze záporných požadavků (dayStyles)">
                Bloky/měs
              </th>
            </tr>
          </thead>
          <tbody>
            {stats.map(s => (
              <tr key={s.uid}>
                <td style={tdNameStyle} title={s.name}>{s.shortcut}</td>
                <td style={{ ...tdStyle, fontWeight: 600 }}>{s.total}</td>
                <td style={tdStyle}>{s.weekday}</td>
                <td style={{ ...tdStyle, color: '#0288d1' }}>{s.friday}</td>
                <td style={{ ...tdStyle, color: '#e65100' }}>{s.saturday}</td>
                <td style={{ ...tdStyle, color: '#e65100' }}>{s.sunday}</td>
                <td style={tdStyle}>{s.holidays}</td>
                <td style={tdStyle}>
                  {s.blockedAvg === null
                    ? <span style={{ color: '#999' }}>—</span>
                    : s.blockedAvg.toFixed(1)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PenaltySection({ stats }) {
  // Color: 0 = green, 1-2 = amber, 3+ = red.
  const cellColor = (n) => {
    if (n === 0) return '#d4edda';
    if (n <= 2)  return '#fff3cd';
    return '#f8d7da';
  };
  return (
    <div style={sectionStyle}>
      <h3 style={sectionTitleStyle}>Penalizace (audit)</h3>
      <div style={{ fontSize: '0.82em', color: '#666', marginBottom: 8 }}>
        Počet výskytů jednotlivých vzorců v rozpisu. Audit nezná původní „desired_duty"
        výjimky — započítává <em>všechny</em> výskyty, i ty, které si doktor sám přál.
        Zelená 0 · žlutá 1-2 · červená 3+.
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thNameStyle}>Doktor</th>
              <th style={thStyle} title="Dvě služby po sobě jdoucích dnů (kritické)">
                Po sobě
              </th>
              <th style={thStyle} title="Služby blíž než nastavený min. interval doktora">
                &lt; interval
              </th>
              <th style={thStyle} title="Pátek + neděle do 3 dnů (zničený volný víkend)">
                Zničený VK
              </th>
              <th style={thStyle} title="Dvě víkendové služby do 7 dnů od sebe">
                2 VK ≤7d
              </th>
              <th style={thStyle} title="Dvě víkendové služby 8-14 dnů od sebe">
                2 VK ≤14d
              </th>
            </tr>
          </thead>
          <tbody>
            {stats.map(s => {
              const p = s.penalties;
              return (
                <tr key={s.uid}>
                  <td style={tdNameStyle} title={`${s.name} · interval=${s.minInterval}d`}>
                    {s.shortcut}
                  </td>
                  <td style={{ ...tdStyle, background: cellColor(p.consecutive), fontWeight: 600 }}>
                    {p.consecutive}
                  </td>
                  <td style={{ ...tdStyle, background: cellColor(p.interval) }}>
                    {p.interval}
                  </td>
                  <td style={{ ...tdStyle, background: cellColor(p.destroyed_weekend) }}>
                    {p.destroyed_weekend}
                  </td>
                  <td style={{ ...tdStyle, background: cellColor(p.consec_wk_weeks) }}>
                    {p.consec_wk_weeks}
                  </td>
                  <td style={{ ...tdStyle, background: cellColor(p.weekend_spacing) }}>
                    {p.weekend_spacing}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LifetimeSection({ stats, years }) {
  if (years.length === 0) return null;
  return (
    <div style={sectionStyle}>
      <h3 style={sectionTitleStyle}>Lifetime — počet služeb po letech</h3>
      <div style={{ overflowX: 'auto' }}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thNameStyle}>Doktor</th>
              {years.map(y => (
                <th key={y} style={thStyle}>{y}</th>
              ))}
              <th style={{ ...thStyle, borderLeft: '2px solid #1976d2', background: '#e3f2fd' }}>
                Celkem
              </th>
            </tr>
          </thead>
          <tbody>
            {stats.map(s => {
              const lifetimeTotal = Object.values(s.yearly || {}).reduce((a, b) => a + b, 0);
              return (
                <tr key={s.uid}>
                  <td style={tdNameStyle} title={s.name}>{s.shortcut}</td>
                  {years.map(y => (
                    <td key={y} style={tdStyle}>
                      {s.yearly?.[y] ?? <span style={{ color: '#ccc' }}>0</span>}
                    </td>
                  ))}
                  <td style={{ ...tdStyle, fontWeight: 700, borderLeft: '2px solid #1976d2', background: '#e3f2fd' }}>
                    {lifetimeTotal}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MonthlyBreakdownSection({ doctorStats, yearFilter }) {
  const months = Object.keys(doctorStats.byMonthDow).sort();
  if (months.length === 0) {
    return (
      <div style={sectionStyle}>
        <h3 style={sectionTitleStyle}>
          Detail: {doctorStats.shortcut}{doctorStats.name && ` (${doctorStats.name})`}
        </h3>
        <p style={{ color: '#666', fontSize: '0.9em' }}>
          Žádné služby ve filtrovaném období.
        </p>
      </div>
    );
  }
  // Render dow columns in human order: Po Út St Čt Pá So Ne (1,2,3,4,5,6,0).
  const dowOrder = [1, 2, 3, 4, 5, 6, 0];
  return (
    <div style={sectionStyle}>
      <h3 style={sectionTitleStyle}>
        Detail: {doctorStats.shortcut}{doctorStats.name && ` (${doctorStats.name})`} — {yearFilter === 'all' ? 'lifetime' : yearFilter}
      </h3>
      <div style={{ overflowX: 'auto' }}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thNameStyle}>Měsíc</th>
              {dowOrder.map(d => (
                <th key={d} style={{
                  ...thStyle,
                  color: (d === 0 || d === 6) ? '#e65100' : (d === 5 ? '#0288d1' : '#333'),
                }}>
                  {DOW_LABELS_CS[d]}
                </th>
              ))}
              <th style={{ ...thStyle, borderLeft: '2px solid #1976d2', background: '#e3f2fd' }}>
                Σ
              </th>
            </tr>
          </thead>
          <tbody>
            {months.map(m => {
              const buckets = doctorStats.byMonthDow[m];
              const total = buckets.reduce((a, b) => a + b, 0);
              return (
                <tr key={m}>
                  <td style={tdNameStyle}>{m}</td>
                  {dowOrder.map(d => (
                    <td key={d} style={tdStyle}>
                      {buckets[d] || <span style={{ color: '#ccc' }}>·</span>}
                    </td>
                  ))}
                  <td style={{ ...tdStyle, fontWeight: 700, borderLeft: '2px solid #1976d2', background: '#e3f2fd' }}>
                    {total}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

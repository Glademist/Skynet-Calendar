// SchedulerView.js — extracted UI primitives shared by Scheduler.js (Plánovač)
// and Optimizer.js. The grid + group toggles + per-doctor stats + note modal
// all live here as composable components. Each parent owns its own state
// (Firestore-backed for Scheduler; in-memory for Optimizer) and passes it
// in as props together with handlers and optional decorations.
//
// Design choices:
//  - No `mode: 'scheduler' | 'optimizer'` flag. If behaviour differs between
//    parents, that's a missing prop, not a missing branch. Callbacks stay
//    optional so Scheduler can opt out of Optimizer-only features (locks /
//    ace) by simply not passing the prop.
//  - Helpers exported as pure functions so parents can reuse them when
//    computing derived state (visibleUsers, displayedDays, weekend solver).
//  - getCellClasses lives inside ScheduleGrid because it depends on the
//    component-local data (assignments + userPreferences + days). Parents
//    that need violation info elsewhere can call the exported helpers
//    independently.

import React, { useMemo, useState } from 'react';
import { generateHolidays } from './utils';
import { clsx } from 'clsx';
import './Scheduler.css';

const cn = (...inputs) => clsx(inputs);

// Stable display order for doctor columns. Doctors not in this list fall
// to the end (sorted by arrival). Mirrors Scheduler.js doctorOrder.
export const doctorOrder = [
  'Hro', 'Hv', 'ValM', 'Bee', 'Chre', 'Šk', 'Šd', 'Bia', 'Ble', 'Har',
  'Koc', 'Brz', 'Dvo', 'Sib', 'Sal', 'Žd', 'ValJ', 'MarB', 'Pli',
  'Mud', 'Kul', 'Hru', 'Pro', 'Kep', 'Švr', 'Mrk',
];

// =====================================================================
// Pure helpers
// =====================================================================

// dayStyles entries store composite states like 'preferred_blocked' or
// 'unblocked'. These two helpers split that into a base demand (preferred /
// not available / null) and an effective override (blocked / unblocked / the
// base demand if no override is set).
export const getBaseStatus = (status) =>
  status ? status.replace(/_(blocked|unblocked)$/, '') : null;

export const getEffectiveStatus = (status) => {
  if (!status) return null;
  if (status.endsWith('_unblocked')) return 'unblocked';
  if (status.endsWith('_blocked')) return 'blocked';
  return status;
};

// Assignment values use a `_u` suffix to mark "this cell was assigned on an
// unblocked day"; the base group is what matters for fairness counting and
// most rendering. isUnblockedAssignment is just a convenience.
export const getBaseGroup = (val) => (val ? val.replace(/_u$/, '') : null);
export const isUnblockedAssignment = (val) => (val?.endsWith('_u') || false);

export const getDisplayLabel = (assigned, groupLabel) => {
  if (!assigned) return '';
  const base = getBaseGroup(assigned);
  const label = groupLabel[base] || base;
  return isUnblockedAssignment(assigned) ? label + 'U' : label;
};

// Czech holidays + weekends. Used for the date-row blue tint and for
// visualising the weekend block boundary in the grid.
export const isWeekendOrHoliday = (date) => {
  const d = new Date(date);
  return d.getDay() === 0 || d.getDay() === 6 ||
    generateHolidays().some(h => h.date === date);
};

// =====================================================================
// Derived collections — exported so parents can compute them too
// (Scheduler needs `visibleUsers` for exports / weekend solver; Optimizer
// needs it for the cell-cycle handler.)
// =====================================================================

// Flatten + sort + tag isActive based on which groups are expanded.
// `users` is the grouped roster: { staří: [...], střední: [...], mladí: [...] }.
// `collapsed[groupName] === true` hides that group from the active set, but
// the doctor still renders (greyed) if at least one of their groups is
// expanded.
export function computeVisibleUsers(users, collapsed, groupOrder) {
  const allDoctors = [];
  const seen = new Set();

  groupOrder.forEach(group => {
    if (users[group]) {
      users[group].forEach(u => {
        if (!seen.has(u.uid)) {
          seen.add(u.uid);
          allDoctors.push({ ...u });
        }
      });
    }
  });

  allDoctors.sort((a, b) => {
    const aPos = doctorOrder.indexOf(a.shortcut);
    const bPos = doctorOrder.indexOf(b.shortcut);
    return (aPos === -1 ? Infinity : aPos) - (bPos === -1 ? Infinity : bPos);
  });

  return allDoctors.map(doctor => ({
    ...doctor,
    isActive: (doctor.groups || []).some(g => !collapsed[g]),
  }));
}

// Filter `days` by the all/weekends pill.
export function computeDisplayedDays(days, viewMode) {
  if (viewMode === 'all') return days;
  return days.filter(date => {
    const dow = new Date(date).getDay();
    return dow === 5 || dow === 6 || dow === 0;
  });
}

// Merge per-quarter overrides of weekdayShifts/weekendShifts/shiftInterval
// into the flat user list. `overrides` is the raw doc data from
// `quarterShiftOverrides/{year}_Q${quarter}` keyed by uid. Any missing field
// (or empty string) keeps the global value from `settings/{uid}`. Sets
// `_overrideKeys` on each touched user so headers can render an indicator
// without re-reading the override doc.
const OVERRIDE_FIELDS = ['weekdayShifts', 'weekendShifts', 'shiftInterval'];
export function applyShiftOverrides(allUsers, overrides) {
  if (!overrides) return allUsers;
  return allUsers.map(u => {
    const o = overrides[u.uid];
    if (!o) return u;
    const merged = { ...u };
    const usedKeys = [];
    for (const k of OVERRIDE_FIELDS) {
      if (o[k] !== undefined && o[k] !== '') {
        merged[k] = o[k];
        usedKeys.push(k);
      }
    }
    merged._overrideKeys = usedKeys;
    return merged;
  });
}

// =====================================================================
// <GroupToggleBar> — group expand/collapse pills + view-mode toggle.
// Sits at the top of the right panel in both Scheduler and Optimizer.
// =====================================================================

export function GroupToggleBar({
  groupOrder,
  groupLabel,
  users,
  collapsed,
  setCollapsed,
  viewMode,
  setViewMode,
}) {
  const toggleGroup = (group) =>
    setCollapsed(prev => ({ ...prev, [group]: !prev[group] }));

  return (
    <div className="mb-6">
      <h3 className="text-sm font-semibold text-gray-600 mb-3">
        Skupiny lékařů + zobrazení
      </h3>
      <div className="flex flex-wrap gap-2 items-center">
        {groupOrder.map(group => {
          const count = users[group]?.length || 0;
          const isCollapsed = !!collapsed[group];
          return (
            <button
              key={group}
              onClick={() => toggleGroup(group)}
              className={cn(
                "px-3.5 py-1 rounded-lg text-sm font-medium transition-all min-w-[90px]",
                isCollapsed
                  ? "bg-gray-200 text-gray-600 hover:bg-gray-300"
                  : "bg-blue-600 text-white hover:bg-blue-700 shadow-sm"
              )}
            >
              {group.charAt(0).toUpperCase() + group.slice(1)} ({count})
            </button>
          );
        })}
        <button
          onClick={() => setViewMode(prev => prev === 'all' ? 'weekends' : 'all')}
          className={cn(
            "px-3.5 py-1 rounded-lg text-sm font-medium transition shadow-sm whitespace-nowrap",
            viewMode === 'weekends'
              ? "bg-indigo-600 text-white hover:bg-indigo-700"
              : "bg-gray-300 text-gray-700 hover:bg-gray-400"
          )}
          title={viewMode === 'all' ? "Zobrazit jen víkendy" : "Zobrazit všechny dny"}
        >
          {viewMode === 'all' ? 'Víkendy' : 'Vše'}
        </button>
      </div>
    </div>
  );
}

// =====================================================================
// <ScheduleGrid> — the calendar table. The visual heart of the app.
//
// Click semantics:
//   onCellClick(date, user)             — left click; parent decides cycle.
//   onCellContextMenu(date, user)       — right click on a cell; parent
//                                          decides (Scheduler: block toggle,
//                                          Optimizer: lock toggle).
//   onDoctorClick(user)                 — left click on a doctor's <th>;
//                                          Scheduler opens note modal,
//                                          Optimizer typically no-op.
//   onDoctorContextMenu(user)           — right click on a doctor's <th>;
//                                          Optimizer toggles ace, Scheduler
//                                          omits it.
//
// Decoration:
//   cellDecoration(date, user)?         — { locked: true } draws a 🔒 in
//                                          the top-right corner.
//   doctorDecoration(user)?             — { ace: true } strikes through
//                                          the header text and adds 🚫.
// =====================================================================

export function ScheduleGrid({
  visibleUsers,
  displayedDays,
  days,                // full quarter span (incl. pre-quarter Friday lead-in) — needed for interval checks
  assignments,
  userPreferences,
  quarterNotes = {},
  groupLabel,
  targetYear,
  targetQuarter,
  onCellClick,
  onCellContextMenu,
  onDoctorClick,
  onDoctorContextMenu,
  cellDecoration,
  doctorDecoration,
  userOverrideStatus,  // (u) => 0|1|2|3 — colors header by # of per-quarter limit overrides.
}) {
  // Interval/weekend conflict heatmap. Re-derived per render — cheap because
  // it only iterates the visible cells, and assignments rarely changes
  // between renders. Returns { className, hasIntervalViolation } per cell.
  const getCellClasses = (date, user) => {
    const key = `${date}_${user.uid}`;
    const assigned = !!assignments[key];
    const fullStatus = userPreferences[user.uid]?.[date];
    const effective = getEffectiveStatus(fullStatus);

    if (effective === 'not available') return { className: 'bg-gray-500 text-white line-through', hasIntervalViolation: false };
    if (effective === 'preferred') return { className: 'bg-green-600 text-white font-bold', hasIntervalViolation: false };

    if (effective === 'unblocked') {
      return {
        className: assigned
          ? 'bg-amber-600 text-white font-bold border-2 border-yellow-300'
          : 'bg-amber-100 border-2 border-amber-400 text-amber-700 font-medium',
        hasIntervalViolation: false,
      };
    }

    if (effective === 'blocked') return { className: 'bg-gray-800 text-gray-200 line-through select-none', hasIntervalViolation: false };

    const d = new Date(date);
    const dayOfWeek = d.getDay();
    const isWeekendDay = dayOfWeek === 5 || dayOfWeek === 6 || dayOfWeek === 0;

    if (!isWeekendDay) {
      return {
        className: assigned ? 'bg-blue-600 text-white' : 'hover:bg-gray-100',
        hasIntervalViolation: false,
      };
    }

    // Weekend conflict logic: any other shift this user has in the
    // surrounding Fri-Sun span (this week, prev week, next week).
    const currentFriday = new Date(d);
    if (dayOfWeek === 5) currentFriday.setDate(currentFriday.getDate());
    else if (dayOfWeek === 6) currentFriday.setDate(currentFriday.getDate() - 1);
    else currentFriday.setDate(currentFriday.getDate() - 2);

    const nearbyDates = [];
    for (const week of [-7, 0, 7]) {
      for (let i = 0; i < 3; i++) {
        const dt = new Date(currentFriday);
        dt.setDate(dt.getDate() + week + i);
        nearbyDates.push(dt.toLocaleDateString('en-CA'));
      }
    }

    const nearbyShifts = nearbyDates.filter(dt => assignments[`${dt}_${user.uid}`]);
    const hasWeekendConflict = nearbyShifts.length > 1;

    let hasIntervalViolation = false;
    if (assigned && user.shiftInterval && user.shiftInterval > 0) {
      const minDays = Number(user.shiftInterval);
      const allShifts = days.filter(dt => assignments[`${dt}_${user.uid}`]);
      const thisIdx = allShifts.indexOf(date);

      if (thisIdx > 0) {
        const prev = new Date(allShifts[thisIdx - 1]);
        const diff = Math.floor((d - prev) / 86400000);
        if (diff < minDays) hasIntervalViolation = true;
      }
      if (thisIdx < allShifts.length - 1) {
        const next = new Date(allShifts[thisIdx + 1]);
        const diff = Math.floor((next - d) / 86400000);
        if (diff < minDays) hasIntervalViolation = true;
      }
    }

    if (hasWeekendConflict) {
      return { className: assigned ? 'bg-red-600 text-white font-black' : 'bg-red-100', hasIntervalViolation: false };
    }
    if (hasIntervalViolation) {
      return { className: assigned ? 'bg-purple-600 text-white font-bold' : 'bg-purple-100', hasIntervalViolation: true };
    }
    if (nearbyShifts.length > 0) {
      return { className: assigned ? 'bg-orange-600 text-white font-bold' : 'bg-orange-100', hasIntervalViolation: false };
    }

    const isFriday = dayOfWeek === 5;
    return {
      className: assigned
        ? (isFriday ? 'bg-blue-500 text-white' : 'bg-blue-600 text-white')
        : (isFriday ? 'bg-blue-100' : 'bg-blue-100'),
      hasIntervalViolation: false,
    };
  };

  return (
    <div className="flex-1 overflow-auto bg-white rounded-2xl shadow-xl">
      <table className="w-full table-fixed border-collapse text-sm">
        <thead className="sticky top-0 bg-blue-700 text-white z-20">
          <tr>
            <th className="text-left pl-3 py- py-0 h-6 w-20 sticky left-0 bg-blue-700 z-30 text-xs font-semibold text-white">
              Datum
            </th>
            {visibleUsers.map(u => {
              const note = quarterNotes[u.uid];
              const hasNote = !!(note && note.trim());
              const wd = (u.weekdayShifts ?? '?');
              const wk = (u.weekendShifts ?? '?');
              const intv = (u.shiftInterval ?? '?');
              const settingsLine = `Limity: ${wd}+${wk} / měs · interval ${intv} dní`;
              const ostatus = userOverrideStatus?.(u) ?? 0;
              const overrideLine = ostatus > 0
                ? `\n⚠️ ${ostatus}/3 limitů přepsáno pro Q${targetQuarter}/${targetYear}`
                : '';
              const tooltip = hasNote
                ? `${settingsLine}${overrideLine}\n\n${note}`
                : `${settingsLine}${overrideLine}${onDoctorClick ? `\n(Klikni pro přidání poznámky pro Q${targetQuarter}/${targetYear})` : ''}`;
              const deco = doctorDecoration?.(u);
              const isAce = !!deco?.ace;
              // Override status colors the active header so admin sees at a
              // glance which doctors have per-quarter limit overrides.
              // Inactive (collapsed-group) headers stay grey regardless.
              let activeBg = "text-white bg-blue-700 hover:bg-blue-600";
              if (u.isActive && ostatus === 1) activeBg = "text-gray-900 bg-yellow-400 hover:bg-yellow-300";
              else if (u.isActive && ostatus === 2) activeBg = "text-white bg-orange-500 hover:bg-orange-400";
              else if (u.isActive && ostatus === 3) activeBg = "text-white bg-red-500 hover:bg-red-400";
              return (
                <th
                  key={u.uid}
                  title={tooltip}
                  onClick={onDoctorClick ? () => onDoctorClick(u) : undefined}
                  onContextMenu={onDoctorContextMenu ? (e) => {
                    e.preventDefault();
                    onDoctorContextMenu(u);
                  } : undefined}
                  className={cn(
                    "py-0 h-6 text-xs font-semibold transition-colors",
                    (onDoctorClick || onDoctorContextMenu) && "cursor-pointer",
                    u.isActive
                      ? activeBg
                      : "text-gray-400 bg-gray-600 opacity-70 hover:bg-gray-500",
                    isAce && "line-through opacity-70"
                  )}
                >
                  {u.shortcut}
                  {hasNote && <span style={{ marginLeft: 2, color: '#ffd54f' }}>•</span>}
                  {isAce && <span style={{ marginLeft: 2 }}>🚫</span>}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {displayedDays.map(date => {
            const allAssignmentsForDate = Object.keys(assignments)
              .filter(k => k.startsWith(date + "_"))
              .map(k => getBaseGroup(assignments[k]));

            const count = { S: 0, M: 0, J: 0 };
            allAssignmentsForDate.forEach(g => {
              if (g === 'staří') count.S++;
              if (g === 'střední') count.M++;
              if (g === 'mladí') count.J++;
            });

            const perfect =
              count.S === 1 && count.M === 1 && count.J === 1;
            const error =
              count.S > 1 || count.M > 1 || count.J > 1;
            const warning =
              !error && !perfect && allAssignmentsForDate.length > 0;

            let bgClass = "bg-white text-gray-800";
            if (isWeekendOrHoliday(date)) bgClass = "bg-blue-100 text-gray-800";
            if (error) bgClass = "bg-red-500 text-white font-bold";
            else if (warning) bgClass = "bg-amber-500 text-white font-bold";
            else if (perfect) bgClass = "bg-green-500 text-white font-bold";

            return (
              <tr key={date} className="hover:bg-gray-50">
                <td className={cn(
                  "sticky left-0 z-10 text-left pl-2 pr-3 py-0 font-medium text-[11px] leading-3 border-r-4 border-gray-300 whitespace-nowrap h-6 text-gray-800",
                  bgClass
                )}>
                  {date.slice(8, 10) + '.' + date.slice(5, 7) + '.'}
                </td>
                {visibleUsers.map(u => {
                  const cellInfo = getCellClasses(date, u);
                  const cellKey = `${date}_${u.uid}`;
                  const assignedRaw = assignments[cellKey];
                  const fullStatus = userPreferences[u.uid]?.[date];
                  const effective = getEffectiveStatus(fullStatus);
                  const deco = cellDecoration?.(date, u);
                  const isLocked = !!deco?.locked;

                  return (
                    <td
                      key={u.uid}
                      onClick={onCellClick && u.isActive
                        ? () => onCellClick(date, u)
                        : undefined}
                      onContextMenu={onCellContextMenu && u.isActive
                        ? (e) => {
                          e.preventDefault();
                          onCellContextMenu(date, u);
                        }
                        : undefined}
                      style={{ position: 'relative' }}
                      className={cn(
                        "px-0.5 py-0 text-center select-none font-bold text-[10px] leading-3 border border-gray-300 transition-all h-6",
                        !u.isActive && "bg-gray-800 text-gray-400 opacity-75 cursor-default",
                        !u.isActive && assignedRaw && "bg-gray-200 text-gray-900 font-black opacity-95 border-gray-500",
                        u.isActive && cellInfo.className,
                        assignedRaw && cellInfo.className.includes('red') && "opacity-100 font-black",
                        assignedRaw && cellInfo.className.includes('purple') && "opacity-100 font-black"
                      )}
                    >
                      {(() => {
                        const display = assignedRaw ? getDisplayLabel(assignedRaw, groupLabel) : '';
                        if (!u.isActive) return display || '';
                        let content = display;
                        if (!content) {
                          if (effective === 'unblocked') content = 'U';
                          if (effective === 'blocked') content = 'BLOCK';
                        }
                        return (
                          <>
                            {content}
                            {cellInfo.hasIntervalViolation && u.shiftInterval && (
                              <span className="text-[8px] align-super opacity-80 ml-0.5">
                                ({u.shiftInterval})
                              </span>
                            )}
                          </>
                        );
                      })()}
                      {isLocked && (
                        <span
                          aria-hidden="true"
                          style={{
                            position: 'absolute',
                            top: 0,
                            right: 1,
                            fontSize: 8,
                            lineHeight: 1,
                            pointerEvents: 'none',
                          }}
                        >
                          🔒
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// =====================================================================
// <StatsPanel> — per-group, per-month shift counts.
//
// Two display modes (toggle in header):
//   • # Počty   — raw shift counts per category (default)
//   • Δ Diff    — counts minus the doctor's target (`actual − target`).
//                 Target = (numeric u.weekdayShifts) × multiplier; for 'X'
//                 (flexible) doctors the target is the per-group calendar
//                 ideal computed exactly like the GA does it. multiplier = 3
//                 for the quarter view, 1 for a month view.
//
// Categorisation rules (svátek wins):
//   • Holiday (any DOW)  → weekend (so 1.5. on a Friday counts as weekend)
//   • DOW 0 / 6          → weekend
//   • DOW 1–5, !holiday  → weekday  (Po–Pá)
//   • Friday counter (informative — never feeds weekday or weekend totals):
//       DOW 5 && !holiday          → counted
//       DOW 4 && nextDay = Fri+holiday → counted (substitution: Thursday
//         carries the "Friday-feel" when Friday is a holiday)
//
// Used by Scheduler in the right panel; Optimizer can opt in for fairness
// at-a-glance. selectedMonth: 0 = quarter total; 1/2/3 = first/second/third
// month of the quarter.
// =====================================================================

const MONTH_NAMES = [
  '', 'Leden', 'Únor', 'Březen', 'Duben', 'Květen', 'Červen',
  'Červenec', 'Srpen', 'Září', 'Říjen', 'Listopad', 'Prosinec',
];

// String-or-'X' limit parser. Returns { numeric: number|null, isFlex: bool }.
// '' or 'X' (case-insensitive) → flexible; numeric string → numeric; anything
// else (garbage) → numeric=null + isFlex=false (defensive).
function parseLimit(raw) {
  if (raw === undefined || raw === null) return { numeric: null, isFlex: true };
  const s = String(raw).trim();
  if (s === '' || s.toUpperCase() === 'X') return { numeric: null, isFlex: true };
  const n = Number(s);
  if (Number.isFinite(n)) return { numeric: n, isFlex: false };
  return { numeric: null, isFlex: false };
}

export function StatsPanel({
  groupOrder,
  users,
  visibleUsers,
  collapsed,
  assignments,
  days,
  qStartMonth,
  targetQuarter,
  selectedMonth,
  setSelectedMonth,
}) {
  // Toggle "# Počty" ↔ "Δ Diff". Per-instance state — Plánovač and
  // Optimizér each keep their own preference.
  const [diffMode, setDiffMode] = useState(false);

  const quarterMonths = useMemo(
    () => [qStartMonth + 1, qStartMonth + 2, qStartMonth + 3],
    [qStartMonth]
  );

  // Czech holidays as a Set of date strings. Recomputed once per render —
  // generateHolidays() returns the full 2020–2030 list which is cheap, but
  // Set lookup keeps the per-day check O(1).
  const holidaySet = useMemo(
    () => new Set(generateHolidays().map(h => h.date)),
    []
  );

  // ── Period day counts for the group-ideal calculation ──────────────────
  // Both per-month (1/2/3) and quarter totals. Indexed identically to
  // getMonthlyStats(user) so we can sum or pick the right slice.
  const periodDayCounts = useMemo(() => {
    const buckets = {
      1: { wd: 0, wk: 0 },
      2: { wd: 0, wk: 0 },
      3: { wd: 0, wk: 0 },
    };
    for (const date of days) {
      const d = new Date(date);
      const realMonth = d.getMonth() + 1;
      const mIndex = quarterMonths.indexOf(realMonth) + 1;
      if (mIndex === 0) continue;          // pre-quarter Friday lead-in etc.
      const dow = d.getDay();
      const holiday = holidaySet.has(date);
      if (dow === 0 || dow === 6 || holiday) buckets[mIndex].wk += 1;
      else buckets[mIndex].wd += 1;
    }
    return buckets;
  }, [days, quarterMonths, holidaySet]);

  const periodForView = (mIdx) => {
    if (mIdx === 0) {
      return {
        wd: periodDayCounts[1].wd + periodDayCounts[2].wd + periodDayCounts[3].wd,
        wk: periodDayCounts[1].wk + periodDayCounts[2].wk + periodDayCounts[3].wk,
      };
    }
    return periodDayCounts[mIdx];
  };

  // Per-doctor per-month stats. fridays is informative only — it never feeds
  // weekday or weekend (which are mutually exclusive buckets that already
  // sum to total).
  const getMonthlyStats = (user) => {
    const stats = {
      1: { weekday: 0, fridays: 0, weekend: 0, total: 0 },
      2: { weekday: 0, fridays: 0, weekend: 0, total: 0 },
      3: { weekday: 0, fridays: 0, weekend: 0, total: 0 },
    };
    days.forEach(date => {
      const key = `${date}_${user.uid}`;
      if (!assignments[key]) return;
      const d = new Date(date);
      const realMonth = d.getMonth() + 1;
      const mIndex = quarterMonths.indexOf(realMonth) + 1;
      if (mIndex === 0) return;
      const dow = d.getDay();
      const holiday = holidaySet.has(date);

      // Fairness bucket — svátek wins.
      if (dow === 0 || dow === 6 || holiday) stats[mIndex].weekend += 1;
      else stats[mIndex].weekday += 1;

      // Friday counter (informational). Normal Fri = +1; if today is Thu and
      // tomorrow is a Friday-holiday, Thu substitutes (it's the actual
      // "before-the-long-weekend" shift).
      if (dow === 5 && !holiday) {
        stats[mIndex].fridays += 1;
      } else if (dow === 4) {
        const next = new Date(d);
        next.setDate(next.getDate() + 1);
        const nextStr = next.toLocaleDateString('en-CA');
        if (next.getDay() === 5 && holidaySet.has(nextStr)) {
          stats[mIndex].fridays += 1;
        }
      }

      stats[mIndex].total += 1;
    });
    return stats;
  };

  const getStatsForView = (user) => {
    const m = getMonthlyStats(user);
    if (selectedMonth === 0) {
      return {
        weekday: m[1].weekday + m[2].weekday + m[3].weekday,
        fridays: m[1].fridays + m[2].fridays + m[3].fridays,
        weekend: m[1].weekend + m[2].weekend + m[3].weekend,
        total: m[1].total + m[2].total + m[3].total,
      };
    }
    return m[selectedMonth];
  };

  // ── Group-level ideal target for 'X' doctors ─────────────────────────
  // Mirrors skynet_v08_claude.timespan_ideal_values. Computed per group +
  // per period (quarter / month) — different groups have different sizes
  // and different mixes of hard/'X' limits, so each table has its own ideal.
  const computeGroupIdeal = (groupVisibleUsers) => {
    const period = periodForView(selectedMonth);
    const multiplier = selectedMonth === 0 ? 3 : 1;
    let minus_wd = 0, minus_wk = 0;
    let n_flex_wd = 0, n_flex_wk = 0;
    for (const u of groupVisibleUsers) {
      const wd = parseLimit(u.weekdayShifts);
      const wk = parseLimit(u.weekendShifts);
      if (wd.isFlex) n_flex_wd += 1;
      else if (wd.numeric !== null) minus_wd += wd.numeric * multiplier;
      if (wk.isFlex) n_flex_wk += 1;
      else if (wk.numeric !== null) minus_wk += wk.numeric * multiplier;
    }
    const ideal_wd = n_flex_wd > 0 ? Math.max(0, period.wd - minus_wd) / n_flex_wd : 0;
    const ideal_wk = n_flex_wk > 0 ? Math.max(0, period.wk - minus_wk) / n_flex_wk : 0;
    return { ideal_wd, ideal_wk };
  };

  // Per-doctor target = (numeric × multiplier) OR (group ideal for 'X').
  // null = unknown (no limit configured at all).
  const getTargetForView = (user, groupIdeal) => {
    const wd = parseLimit(user.weekdayShifts);
    const wk = parseLimit(user.weekendShifts);
    const multiplier = selectedMonth === 0 ? 3 : 1;
    const target_wd = wd.numeric !== null
      ? wd.numeric * multiplier
      : (wd.isFlex ? groupIdeal.ideal_wd : null);
    const target_wk = wk.numeric !== null
      ? wk.numeric * multiplier
      : (wk.isFlex ? groupIdeal.ideal_wk : null);
    return { target_wd, target_wk };
  };

  // Render-cell formatter. In Diff mode returns a coloured string; in count
  // mode returns the absolute integer.
  const formatCell = (actual, target) => {
    if (!diffMode) return { value: actual, className: '' };
    if (target === null) return { value: '—', className: 'text-gray-400' };
    const diff = actual - Math.round(target);
    return {
      value: diff > 0 ? `+${diff}` : String(diff),
      className: diff < 0 ? 'text-red-600 font-semibold'
               : diff > 0 ? 'text-emerald-600 font-semibold'
               : 'text-gray-500',
    };
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-800">Statistiky služeb</h3>
        <button
          type="button"
          onClick={() => setDiffMode(d => !d)}
          title={diffMode
            ? 'Přepnout na absolutní počty'
            : 'Přepnout na rozdíl vůči požadavku doktora (×3 pro kvartál, ×1 pro měsíc)'}
          className={cn(
            "px-2 py-0.5 rounded text-xs font-medium transition-colors",
            diffMode
              ? "bg-purple-600 text-white hover:bg-purple-700"
              : "bg-gray-200 text-gray-700 hover:bg-gray-300"
          )}
        >
          {diffMode ? 'Δ Diff' : '# Počty'}
        </button>
      </div>
      <div className="flex flex-wrap gap-2 mb-4">
        <button
          onClick={() => setSelectedMonth(0)}
          className={cn(
            "px-3 py-1.5 rounded-lg text-sm font-medium transition-all",
            selectedMonth === 0
              ? "bg-blue-600 text-white hover:bg-blue-700"
              : "bg-gray-200 text-gray-600 hover:bg-gray-300"
          )}
        >
          Q{targetQuarter} (celkem)
        </button>
        {[1, 2, 3].map(m => {
          const realMonthNum = qStartMonth + m;
          const monthName = MONTH_NAMES[realMonthNum];
          return (
            <button
              key={m}
              onClick={() => setSelectedMonth(m)}
              className={cn(
                "px-3 py-1.5 rounded-lg text-sm font-medium transition-all",
                selectedMonth === m
                  ? "bg-blue-600 text-white hover:bg-blue-700"
                  : "bg-gray-200 text-gray-600 hover:bg-gray-300"
              )}
            >
              {monthName} ({realMonthNum}.)
            </button>
          );
        })}
      </div>
      {groupOrder.map(group => {
        const groupVisibleUsers = visibleUsers.filter(u => u.groups?.includes(group));
        if (collapsed[group] || groupVisibleUsers.length === 0) return null;
        const groupIdeal = computeGroupIdeal(groupVisibleUsers);
        return (
          <div key={group} className="bg-gray-50 rounded-xl p-4 border border-gray-200">
            <h4 className="font-medium text-gray-700 mb-3">
              {group.charAt(0).toUpperCase() + group.slice(1)} ({groupVisibleUsers.length})
            </h4>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-gray-500 border-b">
                  <th className="pb-2"></th>
                  {groupVisibleUsers.map(u => (
                    <th key={u.uid} className="pb-2 px-1 text-center font-medium">
                      {u.shortcut}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                <tr>
                  <td className="py-1.5 font-medium text-gray-600">Všední</td>
                  {groupVisibleUsers.map(u => {
                    const stats = getStatsForView(u);
                    const t = getTargetForView(u, groupIdeal);
                    const c = formatCell(stats.weekday, t.target_wd);
                    return (
                      <td key={u.uid} className={cn("text-center py-1.5", c.className)}>
                        {c.value}
                      </td>
                    );
                  })}
                </tr>
                <tr>
                  <td className="py-1.5 font-medium text-gray-600">Víkend</td>
                  {groupVisibleUsers.map(u => {
                    const stats = getStatsForView(u);
                    const t = getTargetForView(u, groupIdeal);
                    const c = formatCell(stats.weekend, t.target_wk);
                    // Keep the orange tint for raw counts; in Diff mode the
                    // colour from formatCell wins (red/green/grey).
                    const className = diffMode
                      ? c.className
                      : 'text-orange-600 font-medium';
                    return (
                      <td key={u.uid} className={cn("text-center py-1.5", className)}>
                        {c.value}
                      </td>
                    );
                  })}
                </tr>
                <tr className="font-bold bg-blue-50">
                  <td className="py-2 text-gray-800">Celkem</td>
                  {groupVisibleUsers.map(u => {
                    const stats = getStatsForView(u);
                    const t = getTargetForView(u, groupIdeal);
                    const totalTarget = (t.target_wd !== null && t.target_wk !== null)
                      ? t.target_wd + t.target_wk
                      : null;
                    const c = formatCell(stats.total, totalTarget);
                    return (
                      <td key={u.uid} className={cn("text-center py-2 font-bold",
                        diffMode ? c.className : 'text-gray-900')}>
                        {c.value}
                      </td>
                    );
                  })}
                </tr>
                <tr className="border-t border-gray-300">
                  <td className="py-1.5 font-medium text-gray-500 italic">Pátek (info)</td>
                  {groupVisibleUsers.map(u => (
                    <td key={u.uid} className="text-center py-1.5 text-sky-600 italic">
                      {getStatsForView(u).fridays}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

// =====================================================================
// <NoteModal> — quarter-note editor. Scheduler-only. Opens via
// onDoctorClick handler. Doctors edit the same note via Settings.js.
// =====================================================================

export function NoteModal({
  users,
  editingNoteUid,
  editingNoteText,
  setEditingNoteUid,
  setEditingNoteText,
  saveQuarterNote,
  targetYear,
  targetQuarter,
}) {
  if (!editingNoteUid) return null;
  const target = Object.values(users).flat().find(u => u.uid === editingNoteUid);
  const label = target?.shortcut || editingNoteUid.slice(0, 6);
  const wd = target?.weekdayShifts ?? '?';
  const wk = target?.weekendShifts ?? '?';
  const intv = target?.shiftInterval ?? '?';
  return (
    <div
      onClick={() => setEditingNoteUid(null)}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
        zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'white', padding: 20, borderRadius: 8,
          width: 'min(560px, 90vw)', boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
        }}
      >
        <h3 style={{ margin: 0, marginBottom: 8 }}>
          Poznámka pro {label} — Q{targetQuarter}/{targetYear}
        </h3>
        <div style={{
          margin: '0 0 10px', padding: '6px 10px',
          background: '#eef4fb', borderLeft: '3px solid #1976d2',
          borderRadius: 3, fontSize: '0.85em', color: '#333',
        }}>
          Limity: <strong>{wd}+{wk}</strong> / měsíc · interval <strong>{intv}</strong> dní
          <span style={{ color: '#888', marginLeft: 8 }}>(uprav v Admin panelu)</span>
        </div>
        <p style={{ margin: 0, marginBottom: 10, fontSize: '0.85em', color: '#666' }}>
          Krátký kontext k preferencím tohoto kvartálu (např. „prefer either 31.7+2.8 OR 7.8+9.8, ne obojí").
          Lékař vidí a edituje stejnou poznámku ve svém Nastavení.
        </p>
        <textarea
          value={editingNoteText}
          onChange={(e) => setEditingNoteText(e.target.value)}
          rows={5}
          style={{
            width: '100%', padding: 8, fontSize: '0.95em',
            border: '1px solid #ccc', borderRadius: 4, fontFamily: 'inherit',
            resize: 'vertical',
          }}
          autoFocus
        />
        <div style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            onClick={() => setEditingNoteUid(null)}
            style={{
              padding: '8px 14px', background: '#eee', border: 'none',
              borderRadius: 4, cursor: 'pointer',
            }}
          >
            Zrušit
          </button>
          <button
            onClick={() => saveQuarterNote(editingNoteUid, editingNoteText)}
            style={{
              padding: '8px 14px', background: '#1976d2', color: 'white',
              border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 500,
            }}
          >
            Uložit
          </button>
        </div>
      </div>
    </div>
  );
}

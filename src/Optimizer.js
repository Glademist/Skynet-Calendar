// Optimizer.js — SKYNET / Pyodide GA driver, redesigned to share the
// Plánovač's grid via SchedulerView.js.
//
// Workflow:
//   1. Open Optimizer → grid mirrors current Plánovač state for the quarter.
//   2. Left-click cycles a cell's group (in-memory only).
//   3. Right-click on a cell → 🔒 lock (in-memory).
//   4. Right-click on a doctor name → 🚫 ace mode (in-memory).
//   5. Click Spustit → builds payload from in-memory state + locks + ace,
//      runs GA in worker, merges result into in-memory grid (preserving
//      locks and non-target-group cells).
//   6. Click Aplikovat → writes target-group cells to Firestore (with
//      fixation gate).
//
// Persistence: session-only. Refresh wipes locks/ace/edits. The legacy
// Firestore docs `locks/{...}` and `aceDoctors/{...}` are no longer read
// or written; they remain as deadweight in the database until a one-time
// admin cleanup.

import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { db } from './firebase';
import { collection, getDocs, doc, getDoc, setDoc } from 'firebase/firestore';
import { generateHolidays } from './utils';
import { clsx } from 'clsx';
import {
  GroupToggleBar,
  ScheduleGrid,
  StatsPanel,
  computeVisibleUsers,
  computeDisplayedDays,
  getEffectiveStatus,
  getBaseGroup,
  getDisplayLabel,
  applyShiftOverrides,
} from './SchedulerView';

const cn = (...inputs) => clsx(inputs);

const GROUPS = ['staří', 'střední', 'mladí'];

function quarterBounds(year, quarter) {
  const startMonth = (quarter - 1) * 3;
  const start = new Date(year, startMonth, 1);
  const end = new Date(year, startMonth + 3, 0);
  return {
    startStr: start.toLocaleDateString('en-CA'),
    endStr: end.toLocaleDateString('en-CA'),
    startTuple: [year, startMonth + 1, 1],
    endTuple: [year, startMonth + 3, end.getDate()],
  };
}

function defaultQuarter() {
  // Default to next quarter — that's the one a scheduler is actively
  // working on.
  const today = new Date();
  const currentQ = Math.floor(today.getMonth() / 3) + 1;
  let quarter = currentQ + 1;
  let year = today.getFullYear();
  if (quarter > 4) { quarter = 1; year += 1; }
  return { year, quarter };
}

// Worker log messages → coarse phase strings. Matched in order; first hit
// wins. Keep aligned with optimizerWorker.js log calls.
const PHASE_PATTERNS = [
  [/Loading Pyodide/i, 'Načítám Pyodide…'],
  [/Pyodide.*ready/i, 'Pyodide připraven, načítám SKYNET…'],
  [/Fetching .*skynet/i, 'Načítám SKYNET…'],
  [/Module imported/i, 'Optimalizuji… (může trvat ~2 min)'],
  [/Optimization complete/i, 'Dokončuji…'],
];

export default function Optimizer() {
  // ── Quarter selectors ────────────────────────────────────────────────
  const initial = defaultQuarter();
  const [selectedGroup, setSelectedGroup] = useState('mladí');
  const [year, setYear] = useState(initial.year);
  const [quarter, setQuarter] = useState(initial.quarter);
  const [quickMode, setQuickMode] = useState(true);
  const [scaleLimitsByMonths, setScaleLimitsByMonths] = useState(true);
  // Default ON: Saša's confirmed mental model is "limits are hints, I do
  // fair-share ±1 in my head." Flexible 'X' for everyone matches that.
  const [ignoreLimits, setIgnoreLimits] = useState(true);

  // ── Loaded baseline from Firestore (read on quarter change) ─────────
  const [users, setUsers] = useState({});            // grouped: { staří: [], ... }
  const [userPreferences, setUserPreferences] = useState({});
  const [days, setDays] = useState([]);
  const [loaded, setLoaded] = useState(false);

  // ── In-memory editable state ────────────────────────────────────────
  // Seeded from Firestore on (year, quarter) change. Mutated by left-click
  // (cycle) and by run-result merge. Never written back automatically;
  // only Aplikovat persists.
  const [optimizerAssignments, setOptimizerAssignments] = useState({});
  // Locked cells (only these become forced overrides on re-run). Keys:
  // `${date}_${uid}`. Session-only; cleared on quarter change.
  const [lockedCells, setLockedCells] = useState(() => new Set());
  // Ace doctors (no new placements; locks still force them). Values: uid.
  // Session-only; cleared on quarter change.
  const [aceDoctors, setAceDoctors] = useState(() => new Set());

  // ── UI state shared with SchedulerView ──────────────────────────────
  const [collapsed, setCollapsed] = useState({});
  const [viewMode, setViewMode] = useState('all');
  const [selectedMonth, setSelectedMonth] = useState(0);  // 0 = quarter total

  // ── Run state ────────────────────────────────────────────────────────
  const [logs, setLogs] = useState([]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [phase, setPhase] = useState(null);
  const [showLogs, setShowLogs] = useState(false);
  const [lastInput, setLastInput] = useState(null);

  // ── Apply state ──────────────────────────────────────────────────────
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(null);
  const [applyError, setApplyError] = useState(null);

  const workerRef = useRef(null);

  const groupOrder = useMemo(() => GROUPS, []);
  const groupLabel = useMemo(() => ({ staří: 'S', střední: 'M', mladí: 'J' }), []);

  const qStartMonth = (quarter - 1) * 3;

  // Worker cleanup on unmount.
  useEffect(() => {
    return () => {
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
    };
  }, []);

  // ──────────────────────────────────────────────────────────────────────
  // Load baseline on (year, quarter) change. Mirrors Scheduler.js so the
  // grid renders identically with all groups visible. Also clears
  // session-only state (locks, ace, edits, last result).
  // ──────────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    const fetchData = async () => {
      const settingsSnap = await getDocs(collection(db, 'settings'));
      const allUsersRaw = settingsSnap.docs.map(d => ({ uid: d.id, ...d.data() }));

      // Pull per-quarter limit overrides BEFORE grouping. Merging here means
      // every consumer (GA payload, StatsPanel, ScheduleGrid interval check)
      // sees the overridden weekdayShifts/weekendShifts/shiftInterval without
      // a separate code path.
      const overridesSnap = await getDoc(
        doc(db, 'quarterShiftOverrides', `${year}_Q${quarter}`)
      );
      const overridesData = overridesSnap.exists() ? overridesSnap.data() : {};
      const allUsers = applyShiftOverrides(allUsersRaw, overridesData);

      const grouped = {};
      allUsers.forEach(u => {
        (u.groups || []).forEach(g => {
          if (!grouped[g]) grouped[g] = [];
          grouped[g].push(u);
        });
      });
      const sortedGroups = {};
      groupOrder.forEach(g => { if (grouped[g]) sortedGroups[g] = grouped[g]; });

      const prefs = {};
      for (const group of Object.values(sortedGroups)) {
        for (const u of group) {
          const snap = await getDoc(doc(db, 'dayStyles', u.uid));
          prefs[u.uid] = snap.exists()
            ? Object.fromEntries((snap.data().styles || []).map(s => [s.date, s.status]))
            : {};
        }
      }

      const qDays = [];
      const qStart = new Date(year, qStartMonth, 1);
      const prevFriday = new Date(qStart);
      const dow = qStart.getDay();
      const toFriday = dow === 0 ? 2 : (dow + 2) % 7;
      prevFriday.setDate(prevFriday.getDate() - toFriday);
      for (let d = new Date(prevFriday); d < qStart; d.setDate(d.getDate() + 1)) {
        qDays.push(d.toLocaleDateString('en-CA'));
      }
      for (let m = qStartMonth; m < qStartMonth + 3; m++) {
        const last = new Date(year, m + 1, 0).getDate();
        for (let i = 1; i <= last; i++) {
          qDays.push(new Date(year, m, i).toLocaleDateString('en-CA'));
        }
      }

      const assignSnap = await getDoc(doc(db, 'assignments', `${year}_Q${quarter}`));
      const baseline = assignSnap.exists() ? assignSnap.data() : {};

      if (cancelled) return;
      setUsers(sortedGroups);
      setUserPreferences(prefs);
      setDays(qDays);
      setOptimizerAssignments({ ...baseline });   // seed in-memory from Firestore
      setLockedCells(new Set());
      setAceDoctors(new Set());
      setResult(null);
      setLastInput(null);
      setApplied(null);
      setApplyError(null);
      setError(null);
      setLogs([]);
      setLoaded(true);
    };
    fetchData().catch(e => {
      console.error('Optimizer load failed:', e);
      if (!cancelled) {
        setError(e.message || String(e));
        setLoaded(true);
      }
    });
    return () => { cancelled = true; };
  }, [year, quarter, qStartMonth, groupOrder]);

  // Default collapsed state: only target group expanded. Re-runs whenever
  // selectedGroup or the loaded users change — so a fresh load restores
  // sensible defaults too.
  useEffect(() => {
    if (!loaded) return;
    const next = {};
    Object.keys(users).forEach(g => { next[g] = (g !== selectedGroup); });
    setCollapsed(next);
  }, [selectedGroup, loaded, users]);

  // ──────────────────────────────────────────────────────────────────────
  // Derived collections (memoized for stable references in ScheduleGrid).
  // ──────────────────────────────────────────────────────────────────────
  const visibleUsers = useMemo(
    () => computeVisibleUsers(users, collapsed, groupOrder),
    [users, collapsed, groupOrder]
  );
  const displayedDays = useMemo(
    () => computeDisplayedDays(days, viewMode),
    [days, viewMode]
  );

  // ──────────────────────────────────────────────────────────────────────
  // Cell handlers
  // ──────────────────────────────────────────────────────────────────────

  // Left click: cycle through user's allowed groups, like Scheduler.
  // Mutates only optimizerAssignments — no Firestore write.
  const handleCellClick = useCallback((date, user) => {
    const key = `${date}_${user.uid}`;
    const fullStatus = userPreferences[user.uid]?.[date];
    const effective = getEffectiveStatus(fullStatus);
    const userGroups = user.groups || [];
    const cycle = ['staří', 'střední', 'mladí'];

    if (effective === 'blocked') {
      window.notify?.('Den je blokován (nastav v Plánovači). Klik tady neudělá nic.', 'warning');
      return;
    }

    setOptimizerAssignments(prev => {
      const current = prev[key];
      const isUnblockedDay = effective === 'unblocked';
      let next = null;
      if (!current) {
        next = userGroups.find(g => cycle.includes(g));
        if (isUnblockedDay && next) next += '_u';
      } else {
        const baseCurrent = getBaseGroup(current);
        const idx = cycle.indexOf(baseCurrent);
        next = cycle.slice(idx + 1).find(g => userGroups.includes(g));
        if (isUnblockedDay && next) next += '_u';
        if (!next) {
          // End of cycle → clear cell.
          const { [key]: _, ...rest } = prev;
          window.notify?.(`${user.shortcut} odebrán (jen v paměti)`, 'info');
          return rest;
        }
      }
      if (next) {
        window.notify?.(`${user.shortcut} → ${getDisplayLabel(next, groupLabel)}`, 'success');
        return { ...prev, [key]: next };
      }
      return prev;
    });
  }, [userPreferences, groupLabel]);

  // Right click on cell: toggle lock.
  const handleCellRightClick = useCallback((date, user) => {
    const key = `${date}_${user.uid}`;
    setLockedCells(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
        window.notify?.(`Odemknuto ${user.shortcut} ${date}`, 'info');
      } else {
        next.add(key);
        window.notify?.(`Uzamknuto ${user.shortcut} ${date}`, 'success');
      }
      return next;
    });
  }, []);

  // ── Bulk lock operations over currently-expanded groups ────────────────
  // Scope: every cell in `optimizerAssignments` whose base group is in the
  // set of groups currently expanded in the GroupToggleBar (collapsed[g]
  // === false). Spans the whole quarter — independent of selectedMonth.
  const handleLockAll = useCallback(() => {
    const activeGroups = new Set(GROUPS.filter(g => !collapsed[g]));
    if (activeGroups.size === 0) {
      window.notify?.('Žádná skupina není rozbalená.', 'info');
      return;
    }
    setLockedCells(prev => {
      const next = new Set(prev);
      let added = 0;
      for (const [key, value] of Object.entries(optimizerAssignments)) {
        if (!value) continue;
        const g = getBaseGroup(value);
        if (!g || !activeGroups.has(g)) continue;
        if (!next.has(key)) { next.add(key); added++; }
      }
      if (added > 0) {
        window.notify?.(`🔒 Uzamčeno ${added} buněk`, 'success');
      } else {
        window.notify?.('Vše už bylo uzamčené.', 'info');
      }
      return next;
    });
  }, [collapsed, optimizerAssignments]);

  const handleUnlockAll = useCallback(() => {
    const activeGroups = new Set(GROUPS.filter(g => !collapsed[g]));
    if (activeGroups.size === 0) {
      window.notify?.('Žádná skupina není rozbalená.', 'info');
      return;
    }
    setLockedCells(prev => {
      const next = new Set(prev);
      let removed = 0;
      for (const [key, value] of Object.entries(optimizerAssignments)) {
        if (!value) continue;
        const g = getBaseGroup(value);
        if (!g || !activeGroups.has(g)) continue;
        if (next.has(key)) { next.delete(key); removed++; }
      }
      if (removed > 0) {
        window.notify?.(`🔓 Odemčeno ${removed} buněk`, 'success');
      } else {
        window.notify?.('Žádné buňky nebyly uzamčené.', 'info');
      }
      return next;
    });
  }, [collapsed, optimizerAssignments]);

  const handleToggleLocks = useCallback(() => {
    const activeGroups = new Set(GROUPS.filter(g => !collapsed[g]));
    if (activeGroups.size === 0) {
      window.notify?.('Žádná skupina není rozbalená.', 'info');
      return;
    }
    setLockedCells(prev => {
      const next = new Set(prev);
      let locked = 0, unlocked = 0;
      for (const [key, value] of Object.entries(optimizerAssignments)) {
        if (!value) continue;
        const g = getBaseGroup(value);
        if (!g || !activeGroups.has(g)) continue;
        if (next.has(key)) { next.delete(key); unlocked++; }
        else                { next.add(key);    locked++;   }
      }
      if (locked || unlocked) {
        window.notify?.(`🔁 +${locked} 🔒 / −${unlocked} 🔓`, 'success');
      } else {
        window.notify?.('Žádné buňky k toggle.', 'info');
      }
      return next;
    });
  }, [collapsed, optimizerAssignments]);

  // Right click on doctor name: toggle ace.
  const handleDoctorRightClick = useCallback((user) => {
    setAceDoctors(prev => {
      const next = new Set(prev);
      if (next.has(user.uid)) {
        next.delete(user.uid);
        window.notify?.(`Ace OFF: ${user.shortcut}`, 'info');
      } else {
        next.add(user.uid);
        window.notify?.(`🚫 Ace ON: ${user.shortcut} (jen lock-vynutí)`, 'success');
      }
      return next;
    });
  }, []);

  const cellDecoration = useCallback((date, user) =>
    lockedCells.has(`${date}_${user.uid}`) ? { locked: true } : null,
    [lockedCells]
  );

  const doctorDecoration = useCallback((user) =>
    aceDoctors.has(user.uid) ? { ace: true } : null,
    [aceDoctors]
  );

  // ──────────────────────────────────────────────────────────────────────
  // Run: build payload from in-memory state, post to worker.
  // wireWorkerHandlers and result-merge are inlined inside runOptimizer
  // so they close over the run's exact (startStr, endStr, selectedGroup,
  // lockedCells, nameToUid). Hoisting them into useCallback would race
  // against setLastInput — the callback closure would read stale lastInput
  // because state updates happen after the worker's onmessage is wired.
  // ──────────────────────────────────────────────────────────────────────
  const append = (msg) => setLogs(prev => [...prev, msg]);

  const runOptimizer = useCallback(async () => {
    if (!loaded) {
      window.alert('Data ještě nejsou načtená.');
      return;
    }
    setLogs([]);
    setResult(null);
    setError(null);
    setApplied(null);
    setApplyError(null);
    setRunning(true);
    setPhase('Připravuji vstup…');

    try {
      const { startStr, endStr, startTuple, endTuple } = quarterBounds(year, quarter);
      append(`Target quarter: ${year}_Q${quarter}  (${startStr} → ${endStr})`);
      append(`Group: "${selectedGroup}"`);

      const groupUsers = (users[selectedGroup] || []).filter(u => u.approved === true);
      append(`  ${groupUsers.length} approved & in "${selectedGroup}"`);

      if (groupUsers.length < 4) {
        throw new Error(
          `Only ${groupUsers.length} doctors in "${selectedGroup}" — need at least 4 for a feasible schedule.`
        );
      }

      // Holidays in quarter.
      const allHolidays = generateHolidays();
      const holidays = {};
      for (const h of allHolidays) {
        if (h.date >= startStr && h.date <= endStr) holidays[h.date] = 1.6;
      }
      append(`Holidays in quarter: ${Object.keys(holidays).length}`);

      // Every YYYY-MM-DD in the quarter — used by ace mode.
      const allQuarterDates = [];
      {
        const cur = new Date(startStr);
        const end = new Date(endStr);
        while (cur <= end) {
          allQuarterDates.push(cur.toLocaleDateString('en-CA'));
          cur.setDate(cur.getDate() + 1);
        }
      }

      // Build name maps. Worker key = shortcut.
      const uidToName = {};
      const usedNames = new Set();
      for (const u of groupUsers) {
        let name = (u.shortcut || u.displayName || u.uid.slice(0, 6)).trim();
        if (!name) name = u.uid.slice(0, 6);
        let candidate = name, n = 2;
        while (usedNames.has(candidate)) { candidate = `${name}#${n++}`; }
        usedNames.add(candidate);
        uidToName[u.uid] = candidate;
      }
      const nameToUid = {};
      for (const [uid, name] of Object.entries(uidToName)) nameToUid[name] = uid;

      // Limit scaling.
      const limitMultiplier = scaleLimitsByMonths ? 3 : 1;

      const workers = {};
      let preferredCount = 0;
      let unavailableCount = 0;
      let crossGroupConflicts = 0;
      const monthlyLimits = {};

      for (const u of groupUsers) {
        const styles = userPreferences[u.uid] || {};
        const desired = [];
        const undesired = [];
        const externalDuties = [];

        for (const [date, status] of Object.entries(styles)) {
          if (date < startStr || date > endStr) continue;
          const eff = getEffectiveStatus(status);
          if (eff === 'preferred') {
            desired.push(date);
            preferredCount++;
          } else if (eff === 'not available' || eff === 'blocked') {
            undesired.push(date);
            unavailableCount++;
          }
        }

        // Cross-group conflicts: doctor's other-group cells in the in-memory
        // state. Using optimizerAssignments here so manual edits in
        // non-target groups feed into spacing rules correctly.
        for (const [key, value] of Object.entries(optimizerAssignments)) {
          const sep = key.indexOf('_');
          if (sep < 0) continue;
          const date = key.slice(0, sep);
          const uid = key.slice(sep + 1);
          if (uid !== u.uid) continue;
          if (date < startStr || date > endStr) continue;
          const grp = getBaseGroup(value);
          if (grp && grp !== selectedGroup) {
            if (!undesired.includes(date)) {
              undesired.push(date);
              crossGroupConflicts++;
            }
            if (!externalDuties.includes(date)) externalDuties.push(date);
          }
        }

        const name = uidToName[u.uid];

        const rawWd = u.weekdayShifts;
        const rawWk = u.weekendShifts;
        const wdNum = (rawWd !== undefined && rawWd !== null && rawWd !== '' && rawWd !== 'X')
          ? Number(rawWd) : null;
        const wkNum = (rawWk !== undefined && rawWk !== null && rawWk !== '' && rawWk !== 'X')
          ? Number(rawWk) : null;
        const scaledWd = wdNum !== null ? String(wdNum * limitMultiplier) : 'X';
        const scaledWk = wkNum !== null ? String(wkNum * limitMultiplier) : 'X';
        const finalWd = ignoreLimits ? 'X' : scaledWd;
        const finalWk = ignoreLimits ? 'X' : scaledWk;

        monthlyLimits[name] = {
          monthly_wd: ignoreLimits ? null : wdNum,
          monthly_wk: ignoreLimits ? null : wkNum,
          period_wd: ignoreLimits ? null : (wdNum !== null ? wdNum * limitMultiplier : null),
          period_wk: ignoreLimits ? null : (wkNum !== null ? wkNum * limitMultiplier : null),
        };

        // Ace mode: replace desired/undesired with "all dates undesired,
        // none preferred." Locks still force placement via overrides.
        const isAce = aceDoctors.has(u.uid);
        const finalDesired = isAce ? [] : desired;
        const finalUndesired = isAce ? allQuarterDates.slice() : undesired;

        workers[name] = {
          limit_workday: finalWd,
          limit_weekend: finalWk,
          employment: 1.0,
          min_interval: parseInt(u.shiftInterval, 10) || 7,
          desired_duty: finalDesired,
          undesired_duty: finalUndesired,
          external_duties: externalDuties,
        };
      }

      // Build overrides ONLY from explicit user locks. Each locked cell
      // pins the currently-displayed value at run time.
      const overrides = {};
      let userLocksApplied = 0;
      for (const key of lockedCells) {
        const sep = key.indexOf('_');
        if (sep < 0) continue;
        const date = key.slice(0, sep);
        const uid = key.slice(sep + 1);
        if (date < startStr || date > endStr) continue;
        const value = optimizerAssignments[key];
        if (!value) continue;
        // Only target-group locks override; non-target locks are preserved
        // in optimizerAssignments but skipped from worker payload.
        if (getBaseGroup(value) !== selectedGroup) continue;
        const name = uidToName[uid];
        if (!name) continue;
        overrides[date] = name;
        userLocksApplied++;
      }

      append(`\nPayload summary:`);
      append(`  workers: ${Object.keys(workers).length}`);
      append(`  preferences: ${preferredCount} preferred / ${unavailableCount} not-available`);
      append(`  cross-group conflicts: ${crossGroupConflicts}`);
      append(`  user locks: ${userLocksApplied}`);
      const aceList = [...aceDoctors]
        .map(uid => uidToName[uid])
        .filter(n => n && Object.prototype.hasOwnProperty.call(workers, n));
      if (aceList.length > 0) append(`  Ace mode: ${aceList.join(', ')}`);

      append(`\nSpawning worker.`);
      setPhase('Spouštím Web Worker…');

      setLastInput({
        monthlyLimits,
        scaleLimitsByMonths,
        startStr,
        endStr,
        group: selectedGroup,
        year,
        quarter,
        nameToUid,
      });

      const worker = new Worker('/optimizerWorker.js');
      workerRef.current = worker;

      // Inline onmessage so the result-merge closure captures the exact
      // (startStr, endStr, selectedGroup, lockedCells, nameToUid) of THIS
      // run. Capture lockedCells as a snapshot — toggling locks during a
      // long run shouldn't change which cells the result preserves.
      const runLockedCells = new Set(lockedCells);
      const runGroup = selectedGroup;
      const runNameToUid = nameToUid;
      const runStartStr = startStr;
      const runEndStr = endStr;
      worker.onmessage = (e) => {
        const { type, msg, data } = e.data;
        if (type === 'log') {
          setLogs(prev => [...prev, msg]);
          for (const [re, label] of PHASE_PATTERNS) {
            if (re.test(msg)) { setPhase(label); break; }
          }
        } else if (type === 'ok') {
          setResult(data);
          setRunning(false);
          setPhase(null);
          worker.terminate();
          workerRef.current = null;

          // Merge result into optimizerAssignments. Strategy:
          //   1. Drop unlocked target-group cells in date range.
          //   2. Apply result (worker name → uid via runNameToUid).
          // Non-target-group cells and locked cells survive.
          if (data && data.assignments) {
            setOptimizerAssignments(prev => {
              const next = { ...prev };
              for (const key of Object.keys(next)) {
                const sep = key.indexOf('_');
                if (sep < 0) continue;
                const date = key.slice(0, sep);
                if (date < runStartStr || date > runEndStr) continue;
                if (getBaseGroup(next[key]) !== runGroup) continue;
                if (runLockedCells.has(key)) continue;
                delete next[key];
              }
              for (const [date, name] of Object.entries(data.assignments)) {
                if (!name) continue;
                if (date < runStartStr || date > runEndStr) continue;
                const uid = runNameToUid[name];
                if (!uid) continue;
                next[`${date}_${uid}`] = runGroup;
              }
              return next;
            });
          }
        } else if (type === 'error') {
          setError(msg);
          setRunning(false);
          setPhase(null);
          worker.terminate();
          workerRef.current = null;
        }
      };
      worker.onerror = (ev) => {
        setError(`Worker error: ${ev.message || '(no message — check browser console)'}`);
        setRunning(false);
        setPhase(null);
      };

      worker.postMessage({
        cmd: 'run_real',
        payload: {
          workers,
          holidays,
          overrides,
          start: startTuple,
          end: endTuple,
          quick: quickMode,
        },
      });
    } catch (e) {
      setError(e.message);
      setRunning(false);
      setPhase(null);
      console.error(e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    loaded, year, quarter, selectedGroup, quickMode, scaleLimitsByMonths,
    ignoreLimits, users, userPreferences, optimizerAssignments,
    lockedCells, aceDoctors,
  ]);

  // ──────────────────────────────────────────────────────────────────────
  // Apply: write target-group cells to Firestore (with fixation gate).
  // ──────────────────────────────────────────────────────────────────────
  const applyToFirestore = useCallback(async () => {
    if (!lastInput) {
      setApplyError('Nelze aplikovat — nejdřív spusť optimalizátor.');
      return;
    }
    const { startStr, endStr, group, year: rYear, quarter: rQuarter } = lastInput;

    if (group !== selectedGroup || rYear !== year || rQuarter !== quarter) {
      setApplyError(
        `Selectory se změnily od posledního běhu (${group} Q${rQuarter}/${rYear}) → ` +
        `(${selectedGroup} Q${quarter}/${year}). Spusť optimizer znovu před aplikací.`
      );
      return;
    }

    // Count target-group cells in optimizerAssignments within range.
    let cellCount = 0;
    for (const [key, value] of Object.entries(optimizerAssignments)) {
      const date = key.slice(0, key.indexOf('_'));
      if (date < startStr || date > endStr) continue;
      if (getBaseGroup(value) === group) cellCount++;
    }

    const ok = window.confirm(
      `Zapsat ${cellCount} buněk do assignments/${rYear}_Q${rQuarter}?\n\n` +
      `Skupina: "${group}"\n` +
      `Období: ${startStr} → ${endStr}\n\n` +
      `Stávající rozpis skupiny "${group}" v tomto období bude přepsán. ` +
      `Rozpisy ostatních skupin zůstanou nedotčené.`
    );
    if (!ok) return;

    setApplying(true);
    setApplyError(null);
    setApplied(null);

    try {
      // Fixation gate — fetched fresh on each Apply (no caching) so a
      // fix performed in another tab takes effect immediately.
      const fixSnap = await getDoc(doc(db, 'quarterFixed', `${rYear}_Q${rQuarter}`));
      if (fixSnap.exists()) {
        const fixedAt = fixSnap.data().fixedAt;
        throw new Error(
          `Kvartál ${group} Q${rQuarter}/${rYear} je zafixovaný` +
          (fixedAt ? ` (od ${new Date(fixedAt).toLocaleString('cs-CZ')})` : '') +
          `. V Plánovači klikni „🔒 Zafixováno" pro odfixování a zkus to znovu.`
        );
      }

      const docRef = doc(db, 'assignments', `${rYear}_Q${rQuarter}`);
      const snap = await getDoc(docRef);
      const next = snap.exists() ? { ...snap.data() } : {};

      // 1. Drop target-group cells in date range from existing.
      let dropped = 0;
      for (const key of Object.keys(next)) {
        const sep = key.indexOf('_');
        if (sep < 0) continue;
        const date = key.slice(0, sep);
        if (date < startStr || date > endStr) continue;
        if (getBaseGroup(next[key]) === group) {
          delete next[key];
          dropped++;
        }
      }

      // 2. Add target-group cells from optimizerAssignments.
      let added = 0;
      for (const [key, value] of Object.entries(optimizerAssignments)) {
        const sep = key.indexOf('_');
        if (sep < 0) continue;
        const date = key.slice(0, sep);
        if (date < startStr || date > endStr) continue;
        if (getBaseGroup(value) !== group) continue;
        next[key] = value;
        added++;
      }

      await setDoc(docRef, next);

      setApplied({ count: added, dropped, group, year: rYear, quarter: rQuarter, ts: Date.now() });
    } catch (e) {
      console.error('Apply failed:', e);
      setApplyError(e.message || String(e));
    } finally {
      setApplying(false);
    }
  }, [lastInput, optimizerAssignments, selectedGroup, year, quarter]);

  // ──────────────────────────────────────────────────────────────────────
  // Render
  // ──────────────────────────────────────────────────────────────────────
  const yearOptions = [];
  const thisYear = new Date().getFullYear();
  for (let y = thisYear - 1; y <= thisYear + 2; y++) yearOptions.push(y);

  const handlePrev = () => {
    if (quarter === 1) { setYear(y => y - 1); setQuarter(4); }
    else setQuarter(q => q - 1);
  };
  const handleNext = () => {
    if (quarter === 4) { setYear(y => y + 1); setQuarter(1); }
    else setQuarter(q => q + 1);
  };

  const lockCount = lockedCells.size;
  const aceCount = aceDoctors.size;

  return (
    <div className="flex flex-col h-full bg-gray-50">
      <div className="flex flex-1 overflow-auto gap-6 p-6">
        <ScheduleGrid
          visibleUsers={visibleUsers}
          displayedDays={displayedDays}
          days={days}
          assignments={optimizerAssignments}
          userPreferences={userPreferences}
          quarterNotes={{}}
          groupLabel={groupLabel}
          targetYear={year}
          targetQuarter={quarter}
          onCellClick={handleCellClick}
          onCellContextMenu={handleCellRightClick}
          onDoctorContextMenu={handleDoctorRightClick}
          cellDecoration={cellDecoration}
          doctorDecoration={doctorDecoration}
          userOverrideStatus={u => (u._overrideKeys?.length ?? 0)}
        />

        {/* PRAVÝ PANEL — kompaktní, jen run/apply */}
        <div className="flex-shrink-0 w-full lg:w-auto lg:min-w-[380px] bg-white rounded-2xl shadow-xl p-6 overflow-y-auto border border-gray-200">
          <GroupToggleBar
            groupOrder={groupOrder}
            groupLabel={groupLabel}
            users={users}
            collapsed={collapsed}
            setCollapsed={setCollapsed}
            viewMode={viewMode}
            setViewMode={setViewMode}
          />

          {/* Quarter navigation */}
          <div className="flex items-center gap-3 mb-6">
            <button
              onClick={handlePrev}
              disabled={running}
              className="px-5 py-2 bg-gray-100 rounded-lg hover:bg-gray-200 font-medium transition disabled:opacity-50"
            >
              ← Pre
            </button>
            <div className="flex-1 text-center">
              <div className="text-xl font-bold text-blue-700">
                Q{quarter} {year}
              </div>
            </div>
            <button
              onClick={handleNext}
              disabled={running}
              className="px-5 py-2 bg-gray-100 rounded-lg hover:bg-gray-200 font-medium transition disabled:opacity-50"
            >
              Nx →
            </button>
          </div>

          {/* Statistiky služeb — same widget as Plánovač, fed from in-memory
              optimizerAssignments so the user sees fairness signal of any
              run / manual edits without leaving the panel. */}
          <StatsPanel
            groupOrder={groupOrder}
            users={users}
            visibleUsers={visibleUsers}
            collapsed={collapsed}
            assignments={optimizerAssignments}
            days={days}
            qStartMonth={qStartMonth}
            targetQuarter={quarter}
            selectedMonth={selectedMonth}
            setSelectedMonth={setSelectedMonth}
          />

          {/* ── Optimalizátor — kompaktní ovládání pod statistikami ────── */}
          <div className="mt-8 pt-4 border-t border-gray-200">
            <h3 className="text-sm font-semibold text-gray-600 mb-3">
              Optimalizátor
            </h3>

            {/* Row 1: skupina + Spustit + Aplikovat — pill-sized, matching
                the group toggle bar. The dropdown shares the height/radius
                of the pills so the line reads as one row. */}
            <div className="flex flex-wrap gap-2 items-center mb-3">
              <select
                value={selectedGroup}
                onChange={e => setSelectedGroup(e.target.value)}
                disabled={running}
                className="px-3 py-1 rounded-lg text-sm font-medium bg-gray-200 text-gray-700 hover:bg-gray-300 border border-gray-300 disabled:opacity-50"
              >
                {GROUPS.map(g => <option key={g} value={g}>{g}</option>)}
              </select>
              <button
                onClick={runOptimizer}
                disabled={running || !loaded}
                className={cn(
                  "px-3.5 py-1 rounded-lg text-sm font-medium transition shadow-sm",
                  (running || !loaded)
                    ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                    : "bg-blue-600 text-white hover:bg-blue-700"
                )}
              >
                {running ? 'Běží…' : 'Spustit'}
              </button>
              <button
                onClick={applyToFirestore}
                disabled={applying || !lastInput}
                title={!lastInput
                  ? 'Nejdřív spusť optimalizátor.'
                  : 'Zapíše aktuální rozpis cílové skupiny do Plánovače.'}
                className={cn(
                  "px-3.5 py-1 rounded-lg text-sm font-medium transition shadow-sm",
                  (applying || !lastInput)
                    ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                    : "bg-green-700 text-white hover:bg-green-800"
                )}
              >
                {applying ? 'Zapisuji…' : 'Aplikovat'}
              </button>
            </div>

            {/* Row 2: option checkboxes — single line, compact. */}
            <div className="flex flex-wrap gap-3 text-[11px] text-gray-700 mb-2">
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={quickMode} onChange={e => setQuickMode(e.target.checked)} disabled={running} />
                <span title="Kratší cyklus (~2 min). Vypni pro plné cykly.">Quick</span>
              </label>
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={scaleLimitsByMonths}
                  onChange={e => setScaleLimitsByMonths(e.target.checked)}
                  disabled={running || ignoreLimits}
                />
                <span style={{ color: ignoreLimits ? '#999' : 'inherit' }}>Limity ×3</span>
              </label>
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={ignoreLimits} onChange={e => setIgnoreLimits(e.target.checked)} disabled={running} />
                <span title="Všichni flexibilní 'X' — fair-share z kalendáře.">Ignoruj limity</span>
              </label>
            </div>

            <div className="text-[10px] text-gray-500 mb-3 leading-snug">
              <strong>🔒 {lockCount}</strong> buněk · <strong>🚫 {aceCount}</strong> ace.
              Pravým klikem na buňku → lock. Na jméno doktora → ace. Refresh smaže.
            </div>

            {/* Bulk lock ops — operují na rozbalených skupinách v GroupToggleBar */}
            <div className="flex flex-wrap gap-2 mb-3">
              <button
                type="button"
                onClick={handleLockAll}
                disabled={running}
                className="px-3 py-1 rounded-lg text-xs font-medium bg-gray-200 text-gray-700 hover:bg-gray-300 border border-gray-300 disabled:opacity-50"
                title="Uzamkne všechny obsazené buňky aktivních skupin."
              >
                🔒 Lock all
              </button>
              <button
                type="button"
                onClick={handleUnlockAll}
                disabled={running}
                className="px-3 py-1 rounded-lg text-xs font-medium bg-gray-200 text-gray-700 hover:bg-gray-300 border border-gray-300 disabled:opacity-50"
                title="Odemkne všechny zamčené buňky aktivních skupin."
              >
                🔓 Unlock all
              </button>
              <button
                type="button"
                onClick={handleToggleLocks}
                disabled={running}
                className="px-3 py-1 rounded-lg text-xs font-medium bg-gray-200 text-gray-700 hover:bg-gray-300 border border-gray-300 disabled:opacity-50"
                title="Invertuje lock-stav buněk aktivních skupin."
              >
                🔁 Toggle
              </button>
            </div>

            {/* Progress / status panel */}
            {(running || (logs.length > 0 && !result && !error)) && (
              <div className="mb-3 p-2 rounded border border-gray-300 bg-gray-50">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-medium">
                    {running ? '⏳' : '⏸'} {phase || (running ? 'Pracuji…' : 'Připraveno')}
                  </span>
                  {logs.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setShowLogs(v => !v)}
                      className="ml-auto px-2 py-0.5 text-[10px] border rounded text-gray-600 hover:bg-gray-100"
                    >
                      {showLogs ? '▲ Skrýt' : `▼ Detaily (${logs.length})`}
                    </button>
                  )}
                </div>
                {running && (
                  <progress className="w-full h-1 mt-2 block" aria-label={phase || 'Pracuji'} />
                )}
                {showLogs && logs.length > 0 && (
                  <pre className="mt-2 mb-0 bg-gray-900 text-gray-100 p-2 text-[10px] max-h-64 overflow-auto whitespace-pre-wrap break-words rounded font-mono">
                    {logs.join('\n')}
                  </pre>
                )}
              </div>
            )}

            {/* Result summary */}
            {result && (
              <div className="mb-3 p-2 rounded border border-green-300 bg-green-50 text-green-900 text-xs">
                <div className="font-semibold">✓ Hotovo</div>
                {result.elapsed_sec !== undefined && (
                  <div className="text-[11px] mt-1">
                    {result.elapsed_sec.toFixed(2)}s Python · {result.wall_sec?.toFixed(2)}s wall
                  </div>
                )}
                {result.score && (
                  <div className="text-[11px] mt-1">
                    total_adjusted: <strong>{result.score.total_adjusted.toFixed(2)}</strong>
                    {' · '}variance: {result.score.variance.toFixed(2)}
                    {' · '}workers_at_best: {result.score.workers_at_best}/{result.n_workers ?? '?'}
                    {result.cells_filled !== undefined && (
                      <> · cells: {result.cells_filled}/{result.cells_total}</>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Apply feedback */}
            {applied && (
              <div className="mb-3 p-2 rounded bg-green-100 border-l-4 border-green-700 text-xs text-green-900">
                ✓ Zapsáno do <code>assignments/{applied.year}_Q{applied.quarter}</code>:
                {' '}{applied.count} buněk
                {applied.dropped > 0 && <> (přepsalo {applied.dropped})</>}.
              </div>
            )}
            {applyError && (
              <div className="mb-3 p-2 rounded bg-red-100 border-l-4 border-red-700 text-xs text-red-900">
                ✗ Apply selhal: {applyError}
              </div>
            )}
            {error && (
              <div className="mb-3 p-2 rounded bg-red-100 border-l-4 border-red-700 text-xs text-red-900">
                <div className="font-semibold">✗ Run selhal</div>
                <pre className="mt-1 text-[10px] whitespace-pre-wrap break-words">{error}</pre>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

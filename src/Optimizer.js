import React, { useState, useRef, useEffect, useCallback } from 'react';
import { db } from './firebase';
import { collection, getDocs, doc, getDoc, setDoc } from 'firebase/firestore';
import { generateHolidays } from './utils';

// Optimizer panel — Pyodide-in-Web-Worker integration of SKYNET.
//
// Reads the selected quarter from Firestore for one group, builds the
// optimizer payload, runs the GA in a Web Worker, previews the proposed
// schedule, and offers Apply (write back to Firestore). Diagnostic modes
// (smoke / phase1) were removed once the pipeline stabilised — keep the
// worker's `cmd: 'smoke' | 'phase1_test'` paths for ad-hoc debugging from
// the browser console.

const GROUPS = ['staří', 'střední', 'mladí'];

// Mirrors Scheduler.js getEffectiveStatus — keep behaviour aligned.
function effectiveStatus(status) {
  if (!status) return null;
  if (status.endsWith('_unblocked')) return 'unblocked';
  if (status.endsWith('_blocked'))   return 'blocked';
  return status;
}

// Strip the `_u` "unblocked-assignment" suffix used in assignment values.
function baseGroup(value) {
  return value ? value.replace(/_u$/, '') : null;
}

function quarterBounds(year, quarter) {
  const startMonth = (quarter - 1) * 3;            // 0-indexed
  const start = new Date(year, startMonth, 1);
  const end   = new Date(year, startMonth + 3, 0); // last day of quarter
  return {
    startStr: start.toLocaleDateString('en-CA'),
    endStr:   end.toLocaleDateString('en-CA'),
    startTuple: [year, startMonth + 1, 1],
    endTuple:   [year, startMonth + 3, end.getDate()],
  };
}

function defaultQuarter() {
  // Default to the next quarter — that's the one a scheduler is actively
  // working on.
  const today = new Date();
  const currentQ = Math.floor(today.getMonth() / 3) + 1;
  let quarter = currentQ + 1;
  let year    = today.getFullYear();
  if (quarter > 4) { quarter = 1; year += 1; }
  return { year, quarter };
}

export default function Optimizer() {
  const [logs, setLogs] = useState([]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  // Coarse-grained phase shown in the status panel while running. Updated
  // imperatively from runRealQuarter and from log-message pattern matching
  // in wireWorkerHandlers (see PHASE_PATTERNS below). Cleared on completion.
  const [phase, setPhase] = useState(null);
  // Whether the verbose log block is expanded. Default collapsed — the
  // status line + progress bar carry the headline; logs are for debugging.
  const [showLogs, setShowLogs] = useState(false);

  const [selectedGroup, setSelectedGroup] = useState('mladí');
  const initial = defaultQuarter();
  const [year, setYear] = useState(initial.year);
  const [quarter, setQuarter] = useState(initial.quarter);
  const [quickMode, setQuickMode] = useState(true);
  const [scaleLimitsByMonths, setScaleLimitsByMonths] = useState(true);
  // Default ON: Saša's confirmed mental model is "limits are hints, I do
  // fair-share ±1 in my head." Flexible 'X' for everyone matches that.
  // The few doctors with real constraints (e.g. Hv strict 2+1) belong
  // in the admin-rules layer (planned).
  const [ignoreLimits, setIgnoreLimits] = useState(true);
  const [ignoreExisting, setIgnoreExisting] = useState(false);

  // Snapshot of the input we sent to the worker — used by the result panel
  // to show per-doctor limits alongside the realised counts.
  const [lastInput, setLastInput] = useState(null);

  // Apply (write to Firestore) state. Separate from the run state so the
  // result panel can show "applied" feedback without clobbering run logs.
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(null);   // { count, group, year, quarter, ts }
  const [applyError, setApplyError] = useState(null);

  // Per-(group, quarter) cell locks. Shape: { date: name }, where `name` is the
  // optimizer's worker name (shortcut). Locked cells become forced overrides
  // on the next run. Persisted at locks/{year}_Q${quarter}_${group}.
  // Workflow: run optimizer → preview → click 🔒 on cells you like → re-run
  // (locked cells are forced, others get re-optimized) → Apply when satisfied.
  const [locks, setLocks] = useState({});

  // Per-(group, quarter) "Ace mode" doctors. Shape: { name: true }.
  // Ace = "block this doctor from any NEW placement; allow only locked shifts."
  // Implementation: when running, for each Ace doctor we set
  //   undesired_duty = every date in the quarter
  //   desired_duty   = []
  // This makes the GA refuse to place them. Locked cells go through the
  // overrides path, which clobbers possible_duty regardless of undesired_duty,
  // so locks still force placement. Net effect: the only shifts an Ace doctor
  // can have are the ones explicitly locked.
  // Persisted at aceDoctors/{year}_Q${quarter}_${group}.
  const [aceDoctors, setAceDoctors] = useState({});

  const workerRef = useRef(null);

  useEffect(() => {
    return () => {
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
    };
  }, []);

  // Reload locks whenever the (group, year, quarter) target changes. A failed
  // load is treated as "no locks" — that's safer than blocking the panel,
  // and a re-run / re-toggle would write fresh data anyway.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ref = doc(db, 'locks', `${year}_Q${quarter}_${selectedGroup}`);
        const snap = await getDoc(ref);
        if (cancelled) return;
        setLocks(snap.exists() ? snap.data() : {});
      } catch (e) {
        console.error('Locks load failed:', e);
        if (!cancelled) setLocks({});
      }
    })();
    return () => { cancelled = true; };
  }, [year, quarter, selectedGroup]);

  // Reload Ace doctors when the target changes. Same scoping as locks.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ref = doc(db, 'aceDoctors', `${year}_Q${quarter}_${selectedGroup}`);
        const snap = await getDoc(ref);
        if (cancelled) return;
        setAceDoctors(snap.exists() ? snap.data() : {});
      } catch (e) {
        console.error('Ace load failed:', e);
        if (!cancelled) setAceDoctors({});
      }
    })();
    return () => { cancelled = true; };
  }, [year, quarter, selectedGroup]);

  const toggleAce = useCallback(async (name) => {
    const prior = aceDoctors;
    const next = { ...aceDoctors };
    if (next[name]) {
      delete next[name];
    } else {
      next[name] = true;
    }
    setAceDoctors(next);
    try {
      const ref = doc(db, 'aceDoctors', `${year}_Q${quarter}_${selectedGroup}`);
      await setDoc(ref, next);
    } catch (e) {
      console.error('Ace save failed:', e);
      setAceDoctors(prior);
      alert('Uložení Ace selhalo: ' + (e.message || e));
    }
  }, [aceDoctors, year, quarter, selectedGroup]);

  // Persist a locks snapshot to Firestore. Called from toggle / lock-all /
  // clear handlers. Reverts UI to the prior state if the write fails.
  const saveLocks = useCallback(async (next, prior) => {
    try {
      const ref = doc(db, 'locks', `${year}_Q${quarter}_${selectedGroup}`);
      await setDoc(ref, next);
    } catch (e) {
      console.error('Locks save failed:', e);
      setLocks(prior);
      alert('Uložení locku selhalo: ' + (e.message || e));
    }
  }, [year, quarter, selectedGroup]);

  const toggleLock = useCallback((date) => {
    if (!result || !result.assignments) return;
    const name = result.assignments[date];
    if (!name) return;
    const prior = locks;
    const next = { ...locks };
    if (next[date] === name) {
      delete next[date];   // already locked to this name → unlock
    } else {
      next[date] = name;   // not locked, or locked to stale name → lock to current
    }
    setLocks(next);
    saveLocks(next, prior);
  }, [locks, result, saveLocks]);

  const lockAll = useCallback(() => {
    if (!result || !result.assignments) return;
    const prior = locks;
    const next = { ...locks };
    for (const [date, name] of Object.entries(result.assignments)) {
      if (name) next[date] = name;
    }
    setLocks(next);
    saveLocks(next, prior);
  }, [locks, result, saveLocks]);

  const clearLocks = useCallback(() => {
    if (Object.keys(locks).length === 0) return;
    if (!window.confirm(`Odemknout všech ${Object.keys(locks).length} buněk?`)) return;
    const prior = locks;
    setLocks({});
    saveLocks({}, prior);
  }, [locks, saveLocks]);

  const append = (msg) => setLogs(prev => [...prev, msg]);

  // Worker log messages → coarse phase strings. Matched in order; first hit
  // wins. Keep these aligned with optimizerWorker.js log calls — if a phrase
  // there is renamed, update here too. Anything not matching falls through
  // and just appends to the verbose log without changing the phase.
  const PHASE_PATTERNS = [
    [/Loading Pyodide/i,                 'Načítám Pyodide…'],
    [/Pyodide.*ready/i,                  'Pyodide připraven, načítám SKYNET…'],
    [/Fetching .*skynet/i,               'Načítám SKYNET…'],
    [/Module imported/i,                 'Optimalizuji… (může trvat ~2 min)'],
    [/Optimization complete/i,           'Dokončuji…'],
  ];

  const wireWorkerHandlers = (worker) => {
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
      } else if (type === 'error') {
        setError(msg);
        setRunning(false);
        setPhase(null);
        worker.terminate();
        workerRef.current = null;
      }
    };
    worker.onerror = (e) => {
      setError(`Worker error: ${e.message || '(no message — check browser console)'}`);
      setRunning(false);
      setPhase(null);
    };
  };

  const runRealQuarter = useCallback(async () => {
    setLogs([]);
    setResult(null);
    setError(null);
    setApplied(null);
    setApplyError(null);
    setRunning(true);
    setPhase('Načítám data z Firestore…');

    try {
      const { startStr, endStr, startTuple, endTuple } = quarterBounds(year, quarter);
      append(`Target quarter: ${year}_Q${quarter}  (${startStr} → ${endStr})`);
      append(`Group: "${selectedGroup}"`);

      append('\nReading settings collection…');
      const settingsSnap = await getDocs(collection(db, 'settings'));
      const allUsers = settingsSnap.docs.map(d => ({ uid: d.id, ...d.data() }));
      append(`  ${allUsers.length} total users`);

      const groupUsers = allUsers.filter(u =>
        u.approved === true && (u.groups || []).includes(selectedGroup)
      );
      append(`  ${groupUsers.length} approved & in "${selectedGroup}"`);

      if (groupUsers.length < 4) {
        throw new Error(
          `Only ${groupUsers.length} doctors in "${selectedGroup}" — need at least 4 for a feasible schedule. ` +
          `(staří has 10, střední 9, mladí 8 in production.)`
        );
      }

      append('Reading dayStyles per doctor…');
      const dayStyles = {};
      for (const u of groupUsers) {
        const snap = await getDoc(doc(db, 'dayStyles', u.uid));
        dayStyles[u.uid] = snap.exists() ? (snap.data().styles || []) : [];
      }
      const totalStyleEntries = Object.values(dayStyles)
        .reduce((s, arr) => s + arr.length, 0);
      append(`  ${totalStyleEntries} style entries across ${groupUsers.length} doctors`);

      append(`Reading assignments doc: ${year}_Q${quarter}…`);
      const assignSnap = await getDoc(doc(db, 'assignments', `${year}_Q${quarter}`));
      const existing = assignSnap.exists() ? assignSnap.data() : {};
      const existingCount = Object.keys(existing).length;
      append(`  ${existingCount} existing cells across all groups`);

      // Holiday dict: any Czech holiday inside the quarter span.
      const allHolidays = generateHolidays();
      const holidays = {};
      for (const h of allHolidays) {
        if (h.date >= startStr && h.date <= endStr) {
          holidays[h.date] = 1.6;
        }
      }
      append(`Holidays in quarter: ${Object.keys(holidays).length}`);

      // Every YYYY-MM-DD in the quarter — used to expand Ace mode's
      // "block from any new placement" into a concrete undesired_duty list.
      const allQuarterDates = [];
      {
        const cur = new Date(startStr);
        const end = new Date(endStr);
        while (cur <= end) {
          allQuarterDates.push(cur.toLocaleDateString('en-CA'));
          cur.setDate(cur.getDate() + 1);
        }
      }

      // Build workers payload. Worker key = shortcut (compact, unique-ish).
      // Falls back to displayName or uid prefix if shortcut missing.
      const uidToName = {};
      const usedNames = new Set();
      for (const u of groupUsers) {
        let name = (u.shortcut || u.displayName || u.uid.slice(0, 6)).trim();
        if (!name) name = u.uid.slice(0, 6);
        // Disambiguate collisions (rare)
        let candidate = name, n = 2;
        while (usedNames.has(candidate)) { candidate = `${name}#${n++}`; }
        usedNames.add(candidate);
        uidToName[u.uid] = candidate;
      }

      // The Settings.js form stores weekdayShifts / weekendShifts as monthly
      // quotas (defaults of 5/2 only make sense per month for a 10-doctor
      // group). The optimizer treats them as period-totals, so we scale by
      // the number of months in the quarter (always 3) when the user has the
      // option enabled. With this off, we pass values raw — useful if the
      // user has already entered per-quarter totals.
      const limitMultiplier = scaleLimitsByMonths ? 3 : 1;

      const workers = {};
      let sameGroupLocks = 0;
      let crossGroupConflicts = 0;
      let preferredCount = 0;
      let unavailableCount = 0;
      const monthlyLimits = {};   // for the result table

      for (const u of groupUsers) {
        const styles = dayStyles[u.uid];
        const desired = [];
        const undesired = [];
        // Dates this doctor has shifts in OTHER groups during this quarter.
        // Used by the GA's spacing/interval/destroyed_weekend rules so that
        // a Mladí Friday adjacent to a Střední Sunday for the same doctor
        // correctly fires the destroyed_weekend penalty. They're ALSO in
        // `undesired` (so the GA can't schedule the doctor twice on the
        // same date), but external_duties is the new signal that lets the
        // scorer count those dates toward this doctor's full schedule.
        const externalDuties = [];

        for (const s of styles) {
          if (!s || !s.date) continue;
          if (s.date < startStr || s.date > endStr) continue;
          const eff = effectiveStatus(s.status);
          if (eff === 'preferred') {
            desired.push(s.date);
            preferredCount++;
          } else if (eff === 'not available' || eff === 'blocked') {
            undesired.push(s.date);
            unavailableCount++;
          }
          // 'unblocked' → no preference signal; fall through.
        }

        // Cross-group conflict: this doctor is on staří/střední on Jan 5,
        // we're optimizing mladí — must mark Jan 5 as undesired so the GA
        // can't schedule them twice on the same day, AND add to externalDuties
        // so spacing/interval rules see those dates as "she's working that day."
        for (const [key, value] of Object.entries(existing)) {
          const sep = key.indexOf('_');
          if (sep < 0) continue;
          const date = key.slice(0, sep);
          const uid  = key.slice(sep + 1);
          if (uid !== u.uid) continue;
          if (date < startStr || date > endStr) continue;
          const grp = baseGroup(value);
          if (grp && grp !== selectedGroup) {
            if (!undesired.includes(date)) {
              undesired.push(date);
              crossGroupConflicts++;
            }
            if (!externalDuties.includes(date)) {
              externalDuties.push(date);
            }
          }
        }

        const name = uidToName[u.uid];

        // Scale numeric limits by limitMultiplier (3 for monthly→quarterly).
        // 'X' (flexible) passes through unchanged.
        const rawWd = u.weekdayShifts;
        const rawWk = u.weekendShifts;
        const wdNum = (rawWd !== undefined && rawWd !== null && rawWd !== '' && rawWd !== 'X')
          ? Number(rawWd) : null;
        const wkNum = (rawWk !== undefined && rawWk !== null && rawWk !== '' && rawWk !== 'X')
          ? Number(rawWk) : null;

        const scaledWd = wdNum !== null ? String(wdNum * limitMultiplier) : 'X';
        const scaledWk = wkNum !== null ? String(wkNum * limitMultiplier) : 'X';

        // If ignoreLimits is on, force everyone to flexible 'X'. The optimizer
        // then computes fair-share targets from total calendar slots / n_workers.
        // Useful when Settings limits are placeholders and don't reflect reality.
        const finalWd = ignoreLimits ? 'X' : scaledWd;
        const finalWk = ignoreLimits ? 'X' : scaledWk;

        monthlyLimits[name] = {
          monthly_wd: ignoreLimits ? null : wdNum,
          monthly_wk: ignoreLimits ? null : wkNum,
          period_wd:  ignoreLimits ? null : (wdNum !== null ? wdNum * limitMultiplier : null),
          period_wk:  ignoreLimits ? null : (wkNum !== null ? wkNum * limitMultiplier : null),
        };

        // Ace mode: doctor is blocked from NEW placements (locks still force
        // them on locked dates because overrides clobber possible_duty). We
        // implement by replacing desired/undesired with "all quarter dates
        // undesired, no preferences." Cross-group external_duties stay so
        // spacing rules continue to fire for any remaining locked shifts.
        const isAce = !!aceDoctors[name];
        const finalDesired   = isAce ? [] : desired;
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

      // Build overrides (locks) from existing same-group assignments.
      // ignoreExisting = on means "schedule the target group from scratch":
      // skip same-group locks but keep cross-group conflicts (already added
      // above to undesired_duty), since a doctor still can't be in two groups
      // on the same day.
      const overrides = {};
      if (!ignoreExisting) {
        for (const [key, value] of Object.entries(existing)) {
          const sep = key.indexOf('_');
          if (sep < 0) continue;
          const date = key.slice(0, sep);
          const uid  = key.slice(sep + 1);
          if (date < startStr || date > endStr) continue;
          const grp = baseGroup(value);
          if (grp !== selectedGroup) continue;
          if (!uidToName[uid]) continue;   // doctor not in group user list (data quirk)
          overrides[date] = uidToName[uid];
          sameGroupLocks++;
        }
      }

      // Explicit user locks (set via 🔒 in the result preview) win over
      // existing-assignment same-group locks. They're persisted separately at
      // locks/{year}_Q${quarter}_${group} and survive Apply, so a workflow of
      // "run → lock the good ones → re-run with shared doctors → lock more →
      // Apply" stays intact across multiple runs.
      let userLocksApplied = 0;
      for (const [date, name] of Object.entries(locks)) {
        if (date < startStr || date > endStr) continue;
        if (!Object.prototype.hasOwnProperty.call(workers, name)) continue;
        overrides[date] = name;
        userLocksApplied++;
      }

      append(`\nPayload summary:`);
      append(`  workers: ${Object.keys(workers).length}`);
      if (ignoreLimits) {
        append(`  limits: ALL FLEXIBLE ('X') — ignoring Settings values`);
      } else {
        append(`  limit scaling: ${scaleLimitsByMonths ? 'monthly × 3 → per-quarter' : 'raw (treated as per-quarter)'}`);
      }
      append(`  preferences: ${preferredCount} preferred / ${unavailableCount} not-available`);
      append(`  cross-group conflicts (auto-blocked + counted for spacing): ${crossGroupConflicts}`);
      if (ignoreExisting) {
        append(`  same-group locks: SKIPPED (full re-schedule mode)`);
      } else {
        append(`  same-group locks (existing assignments): ${sameGroupLocks}`);
      }
      if (userLocksApplied > 0) {
        append(`  user locks (🔒 from preview, take precedence): ${userLocksApplied}`);
      }
      const aceList = Object.keys(aceDoctors).filter(n => aceDoctors[n] && Object.prototype.hasOwnProperty.call(workers, n));
      if (aceList.length > 0) {
        append(`  Ace mode (no new placements, locks-only): ${aceList.join(', ')}`);
      }
      append(`\nSpawning worker. This will take a while.`);
      setPhase('Spouštím Web Worker…');

      // Capture context the result panel will need.
      // nameToUid lets the Apply button resolve optimizer's name keys back to
      // Firestore uids for `{date}_{uid}` assignment keys.
      const nameToUid = {};
      for (const [uid, name] of Object.entries(uidToName)) nameToUid[name] = uid;
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
      wireWorkerHandlers(worker);
      worker.postMessage({
        cmd: 'run_real',
        payload: {
          workers,
          holidays,
          overrides,
          start: startTuple,
          end:   endTuple,
          quick: quickMode,
        },
      });
    } catch (e) {
      setError(e.message);
      setRunning(false);
      setPhase(null);
      console.error(e);
    }
  }, [year, quarter, selectedGroup, quickMode, scaleLimitsByMonths, ignoreLimits, ignoreExisting, locks, aceDoctors]);

  // Apply the current `result.assignments` to `assignments/{year}_Q{quarter}`.
  // Strategy:
  //   1. Read the existing doc.
  //   2. Delete every key whose date is in the quarter range AND whose value
  //      (stripped of `_u`) equals the run's group. This clears the group's
  //      previous schedule so the new one fully replaces it.
  //   3. Add `{date}_{uid}: groupString` for every cell in result.assignments,
  //      mapping name → uid via lastInput.nameToUid.
  //   4. setDoc full replace (Scheduler.js writes assignments the same way).
  // Other groups' cells in the same date range are preserved untouched.
  const applyToFirestore = useCallback(async () => {
    if (!result || !result.assignments || !lastInput) {
      setApplyError('Nothing to apply (no result loaded).');
      return;
    }
    const { startStr, endStr, group, year: rYear, quarter: rQuarter, nameToUid } = lastInput;

    // Sanity check: result must align with what we last sent the worker.
    // If user changed group/quarter selectors after a run we'd otherwise
    // write to the wrong target.
    if (group !== selectedGroup || rYear !== year || rQuarter !== quarter) {
      setApplyError(
        `Selectory se změnily od posledního běhu (${group} Q${rQuarter}/${rYear}) → ` +
        `(${selectedGroup} Q${quarter}/${year}). Spusť optimizer znovu před aplikací.`
      );
      return;
    }

    const cellCount = Object.values(result.assignments).filter(Boolean).length;
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
      // Fixation gate — Plánovač's "Zafixovat kvartál" button writes a doc
      // to quarterFixed/{year}_Q{n}; if it exists, the quarter is locked
      // against any writes from the optimizer too. Fetched fresh on each
      // Apply (no caching) so a fix performed in another tab takes effect
      // immediately.
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
      const existing = snap.exists() ? snap.data() : {};
      const next = { ...existing };

      // 1. Drop all same-group cells in date range.
      let dropped = 0;
      for (const key of Object.keys(next)) {
        const sep = key.indexOf('_');
        if (sep < 0) continue;
        const date = key.slice(0, sep);
        if (date < startStr || date > endStr) continue;
        const val = next[key];
        if (baseGroup(val) === group) {
          delete next[key];
          dropped++;
        }
      }

      // 2. Add new cells.
      let added = 0;
      const missingUids = [];
      for (const [date, name] of Object.entries(result.assignments)) {
        if (!name) continue;
        if (date < startStr || date > endStr) continue;   // paranoia
        const uid = nameToUid[name];
        if (!uid) { missingUids.push(name); continue; }
        next[`${date}_${uid}`] = group;
        added++;
      }

      if (missingUids.length) {
        // Don't silently lose assignments — surface as a partial-write warning.
        console.warn('Apply: no uid for names', missingUids);
      }

      // 3. Write.
      await setDoc(docRef, next);

      setApplied({
        count: added,
        dropped,
        group,
        year: rYear,
        quarter: rQuarter,
        ts: Date.now(),
        missingUids,
      });
    } catch (e) {
      console.error('Apply failed:', e);
      setApplyError(e.message || String(e));
    } finally {
      setApplying(false);
    }
  }, [result, lastInput, selectedGroup, year, quarter]);

  const btnStyle = (color, disabled) => ({
    padding: '10px 18px',
    fontSize: '0.95em',
    background: disabled ? '#999' : color,
    color: 'white',
    border: 'none',
    borderRadius: 4,
    cursor: disabled ? 'not-allowed' : 'pointer',
  });

  const yearOptions = [];
  const thisYear = new Date().getFullYear();
  for (let y = thisYear - 1; y <= thisYear + 2; y++) yearOptions.push(y);

  // Per-doctor × per-month + per-quarter shift counts. Headline view for
  // judging fairness. Each cell shows total shifts in that month;
  // weekend-vs-weekday split shown with subscripts (wd / wk).
  const renderShiftStats = () => {
    if (!result || !result.assignments || !lastInput) return null;
    const { monthlyLimits, scaleLimitsByMonths: scaled, startStr, endStr } = lastInput;

    // Compute months covered by the run.
    const months = [];
    {
      const s = new Date(startStr);
      const e = new Date(endStr);
      const cur = new Date(s.getFullYear(), s.getMonth(), 1);
      while (cur <= e) {
        months.push(cur.toLocaleDateString('en-CA').slice(0, 7));
        cur.setMonth(cur.getMonth() + 1);
      }
    }

    // Aggregate: per worker per month, split by weekday / weekend.
    // Weekend = Sat or Sun (matches script's day_type bucketing roughly).
    const stats = {};   // {worker: {month: {wd, wk, total}, total: {wd, wk, total}}}
    for (const name of Object.keys(monthlyLimits)) {
      stats[name] = { byMonth: {}, total: { wd: 0, wk: 0, total: 0 } };
      for (const m of months) stats[name].byMonth[m] = { wd: 0, wk: 0, total: 0 };
    }
    for (const [date, doc] of Object.entries(result.assignments)) {
      if (!doc || !stats[doc]) continue;
      const m = date.slice(0, 7);
      if (!stats[doc].byMonth[m]) continue;
      const dow = new Date(date).getDay();
      const isWeekend = (dow === 0 || dow === 6);   // Sun(0), Sat(6)
      const bucket = isWeekend ? 'wk' : 'wd';
      stats[doc].byMonth[m][bucket]++;
      stats[doc].byMonth[m].total++;
      stats[doc].total[bucket]++;
      stats[doc].total.total++;
    }

    const sortedNames = Object.keys(monthlyLimits).sort();

    const cellStyle = { padding: '4px 8px', borderBottom: '1px solid #eee', textAlign: 'right' };
    const headerStyle = { ...cellStyle, fontWeight: 600, background: '#f5f5f5', textAlign: 'center' };
    const nameStyle = { ...cellStyle, textAlign: 'left', fontWeight: 500 };

    // Color a cell red if total exceeds period_wd+period_wk by >2,
    // amber if >1, green if within ±1, light grey if no limit set.
    const totalCellStyle = (worker, total) => {
      const lim = monthlyLimits[worker];
      if (!lim || lim.period_wd === null) return { ...cellStyle, fontWeight: 700 };
      const limTotal = (lim.period_wd ?? 0) + (lim.period_wk ?? 0);
      const delta = total - limTotal;
      const bg =
        Math.abs(delta) <= 1 ? '#d4edda' :
        Math.abs(delta) <= 2 ? '#fff3cd' :
                               '#f8d7da';
      return { ...cellStyle, fontWeight: 700, background: bg };
    };

    return (
      <div style={{ marginTop: 14 }}>
        <h4 style={{ margin: '12px 0 6px' }}>Per-doctor shift counts</h4>
        <div style={{ fontSize: '0.85em', color: '#555', marginBottom: 6 }}>
          Limit interpretation: <strong>{scaled ? 'monthly × 3 → per-quarter' : 'raw (per-quarter)'}</strong>.
          Green / amber / red on the Total column = within ±1 / ±2 / further from the limit.
          <br />
          <span style={{ color: '#7b1fa2', fontWeight: 500 }}>
            🚫 = Ace mode
          </span>
          : doctor je zablokovaný pro <em>nové</em> přiřazení (locks ho dál vynutí). Použij pro „Aces"
          jako MarB / Pli, které chceš nasadit jen tam, kam je explicitně uzamkneš.
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: '0.82em', width: '100%' }}>
            <thead>
              <tr>
                <th style={headerStyle}>Doctor</th>
                <th style={headerStyle} title="Ace mode: blokuj pro nové přiřazení">🚫</th>
                <th style={headerStyle}>Limit (m)</th>
                <th style={headerStyle}>Limit (Q)</th>
                {months.map(m => (
                  <React.Fragment key={m}>
                    <th style={headerStyle} colSpan={3}>{m}</th>
                  </React.Fragment>
                ))}
                <th style={headerStyle} colSpan={3}>Quarter total</th>
              </tr>
              <tr>
                <th style={headerStyle}></th>
                <th style={headerStyle}></th>
                <th style={headerStyle}>wd / wk</th>
                <th style={headerStyle}>wd / wk</th>
                {months.map(m => (
                  <React.Fragment key={m + '-sub'}>
                    <th style={{ ...headerStyle, fontSize: '0.85em', fontWeight: 400 }}>wd</th>
                    <th style={{ ...headerStyle, fontSize: '0.85em', fontWeight: 400 }}>wk</th>
                    <th style={{ ...headerStyle, fontSize: '0.85em', fontWeight: 400 }}>tot</th>
                  </React.Fragment>
                ))}
                <th style={{ ...headerStyle, fontSize: '0.85em', fontWeight: 400 }}>wd</th>
                <th style={{ ...headerStyle, fontSize: '0.85em', fontWeight: 400 }}>wk</th>
                <th style={{ ...headerStyle, fontSize: '0.85em', fontWeight: 400 }}>tot</th>
              </tr>
            </thead>
            <tbody>
              {sortedNames.map(n => {
                const lim = monthlyLimits[n];
                const t = stats[n].total;
                const isAce = !!aceDoctors[n];
                const rowStyle = isAce ? { background: '#f3e5f5' } : {};
                return (
                  <tr key={n} style={rowStyle}>
                    <td style={{ ...nameStyle, ...rowStyle }}>{n}</td>
                    <td style={{ ...cellStyle, ...rowStyle, textAlign: 'center', padding: 0 }}>
                      <button
                        type="button"
                        onClick={() => toggleAce(n)}
                        title={isAce
                          ? `Vypni Ace pro ${n} — bude zase běžně přiřazován.`
                          : `Zapni Ace pro ${n} — GA mu už nebude přidávat nové směny, jen lock-vynutí.`}
                        style={{
                          background: 'transparent', border: 'none',
                          cursor: 'pointer', padding: '2px 4px',
                          fontSize: '0.95em',
                          opacity: isAce ? 1 : 0.25,
                        }}
                      >
                        🚫
                      </button>
                    </td>
                    <td style={{ ...cellStyle, ...rowStyle }}>
                      {lim.monthly_wd ?? 'X'} / {lim.monthly_wk ?? 'X'}
                    </td>
                    <td style={{ ...cellStyle, ...rowStyle }}>
                      {lim.period_wd ?? 'X'} / {lim.period_wk ?? 'X'}
                    </td>
                    {months.map(m => {
                      const c = stats[n].byMonth[m];
                      return (
                        <React.Fragment key={n + m}>
                          <td style={cellStyle}>{c.wd}</td>
                          <td style={cellStyle}>{c.wk}</td>
                          <td style={{ ...cellStyle, fontWeight: 600 }}>{c.total}</td>
                        </React.Fragment>
                      );
                    })}
                    <td style={cellStyle}>{t.wd}</td>
                    <td style={cellStyle}>{t.wk}</td>
                    <td style={totalCellStyle(n, t.total)}>{t.total}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  // Day-by-day preview, grouped by month. Each cell has a 🔒 toggle that
  // pins the current assignment for the next run (forced override) and is
  // persisted to locks/{year}_Q${quarter}_${group} so it survives Apply
  // and reloads.
  const renderPreview = () => {
    if (!result || !result.assignments) return null;
    const dates = Object.keys(result.assignments).sort();
    const byMonth = {};
    for (const d of dates) {
      const m = d.slice(0, 7);
      (byMonth[m] = byMonth[m] || []).push(d);
    }
    const lockCount = Object.keys(locks).length;
    const cellCount = dates.filter(d => result.assignments[d]).length;
    return (
      <div style={{ marginTop: 14 }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          flexWrap: 'wrap', marginBottom: 6,
        }}>
          <h4 style={{ margin: 0 }}>Proposed schedule</h4>
          <span style={{ fontSize: '0.85em', color: '#555' }}>
            🔒 {lockCount}/{cellCount} buněk uzamčeno
            {lockCount > 0 && ' (přežijí Apply, vynutí se v dalším běhu)'}
          </span>
          <button
            type="button"
            onClick={lockAll}
            disabled={lockCount === cellCount}
            style={{
              padding: '4px 10px', fontSize: '0.82em',
              background: lockCount === cellCount ? '#ccc' : '#1976d2',
              color: 'white', border: 'none', borderRadius: 3,
              cursor: lockCount === cellCount ? 'not-allowed' : 'pointer',
            }}
          >
            Uzamknout vše
          </button>
          <button
            type="button"
            onClick={clearLocks}
            disabled={lockCount === 0}
            style={{
              padding: '4px 10px', fontSize: '0.82em',
              background: lockCount === 0 ? '#ccc' : '#757575',
              color: 'white', border: 'none', borderRadius: 3,
              cursor: lockCount === 0 ? 'not-allowed' : 'pointer',
            }}
          >
            Odemknout vše
          </button>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
          {Object.entries(byMonth).map(([m, ds]) => (
            <div key={m} style={{ minWidth: 260 }}>
              <div style={{ fontWeight: 'bold', fontSize: '0.9em', marginBottom: 4 }}>{m}</div>
              <table style={{ borderCollapse: 'collapse', fontSize: '0.82em' }}>
                <tbody>
                  {ds.map(d => {
                    const dayName = new Date(d).toLocaleDateString('cs', { weekday: 'short' });
                    const isWeekend = ['so', 'ne'].includes(dayName.toLowerCase().slice(0, 2));
                    const assigned = result.assignments[d];
                    const lockedTo = locks[d];
                    const isLocked = lockedTo && lockedTo === assigned;
                    // Stale lock = lock pointing at someone different from the
                    // currently-displayed assignment (e.g. lock from a previous
                    // group state). Show distinctly so Saša can see it.
                    const staleLock = lockedTo && !isLocked;
                    return (
                      <tr key={d} style={{
                        background: isLocked
                          ? '#e3f2fd'
                          : (isWeekend ? '#fff3cd' : 'transparent'),
                      }}>
                        <td style={{ padding: '2px 6px', color: '#666' }}>{d.slice(5)}</td>
                        <td style={{ padding: '2px 6px', color: '#999', fontStyle: 'italic' }}>{dayName}</td>
                        <td style={{ padding: '2px 6px', fontWeight: 500 }}>
                          {assigned || '—'}
                          {staleLock && (
                            <span
                              style={{ marginLeft: 6, color: '#c62828', fontSize: '0.85em' }}
                              title={`Lock byl pro „${lockedTo}", aktuální výsledek má jiného. Klikni 🔒 pro přepsání lockem na aktuální.`}
                            >
                              (stale: {lockedTo})
                            </span>
                          )}
                        </td>
                        <td style={{ padding: '2px 4px', textAlign: 'center' }}>
                          {assigned && (
                            <button
                              type="button"
                              onClick={() => toggleLock(d)}
                              title={
                                isLocked
                                  ? `Odemknout (zatím uzamčeno: ${lockedTo})`
                                  : `Uzamknout ${assigned} na ${d}`
                              }
                              style={{
                                background: 'transparent', border: 'none',
                                cursor: 'pointer', fontSize: '1em', padding: 0,
                                opacity: isLocked ? 1 : 0.3,
                                lineHeight: 1,
                              }}
                            >
                              🔒
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div style={{ padding: '16px 24px', maxWidth: 1100, margin: '0 auto' }}>
      <h2 style={{ margin: '0 0 4px', fontSize: '1.4em' }}>
        Optimalizátor
        <span style={{ marginLeft: 10, fontSize: '0.62em', color: '#777', fontWeight: 400 }}>
          SKYNET / Pyodide
        </span>
      </h2>

      <fieldset style={{ border: '2px solid #1976d2', borderRadius: 6, padding: 12, marginBottom: 12 }}>
        <legend style={{ padding: '0 8px', fontWeight: 600, color: '#1976d2', fontSize: '0.95em' }}>
          Optimalizace
        </legend>

        {/* Row 1: target selectors + run button — all on one line. */}
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
          <label style={{ fontSize: '0.9em' }}>
            <span style={{ marginRight: 4 }}>Skupina:</span>
            <select value={selectedGroup} onChange={e => setSelectedGroup(e.target.value)} disabled={running}>
              {GROUPS.map(g => <option key={g} value={g}>{g}</option>)}
            </select>
          </label>
          <label style={{ fontSize: '0.9em' }}>
            <span style={{ marginRight: 4 }}>Rok:</span>
            <select value={year} onChange={e => setYear(parseInt(e.target.value, 10))} disabled={running}>
              {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </label>
          <label style={{ fontSize: '0.9em' }}>
            <span style={{ marginRight: 4 }}>Kvartál:</span>
            <select value={quarter} onChange={e => setQuarter(parseInt(e.target.value, 10))} disabled={running}>
              {[1, 2, 3, 4].map(q => <option key={q} value={q}>Q{q}</option>)}
            </select>
          </label>
          <button
            onClick={runRealQuarter}
            disabled={running}
            style={{ ...btnStyle('#1976d2', running), padding: '8px 18px', fontSize: '0.95em', marginLeft: 'auto' }}
          >
            {running ? 'Běží…' : `Spustit ${selectedGroup} Q${quarter}/${year}`}
          </button>
        </div>

        {/* Row 2: options as compact checkboxes. */}
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', fontSize: '0.82em', color: '#444' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={quickMode} onChange={e => setQuickMode(e.target.checked)} disabled={running} />
            <span title="Kratší cyklus (~2 min). Vypni pro plné cykly [80,120,100].">Quick</span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input
              type="checkbox"
              checked={scaleLimitsByMonths}
              onChange={e => setScaleLimitsByMonths(e.target.checked)}
              disabled={running || ignoreLimits}
            />
            <span style={{ color: ignoreLimits ? '#999' : 'inherit' }} title="Settings ukládá měsíční kvóty; při zaškrtnutí se násobí ×3 na kvartál.">
              Limity ×3
            </span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={ignoreLimits} onChange={e => setIgnoreLimits(e.target.checked)} disabled={running} />
            <span title="Všichni flexibilní 'X' — fair-share z kalendáře.">Ignoruj limity</span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={ignoreExisting} onChange={e => setIgnoreExisting(e.target.checked)} disabled={running} />
            <span title="Smaže stávající rozpis této skupiny a naplánuje od nuly. Ostatní skupiny zůstanou.">Plný přepis</span>
          </label>
        </div>

        <div style={{ marginTop: 8, fontSize: '0.78em', color: '#777', lineHeight: 1.4 }}>
          <strong>Workflow:</strong> spusť → 🔒 uzamkni dobré buňky → 🚫 nastav „Ace mode" doktorům typu MarB / Pli →
          spusť znovu → <strong>Aplikovat</strong> (locks i Ace přežijí).
        </div>
      </fieldset>

      {/* Status panel — one-line phase + indeterminate progress bar while running.
          Verbose logs hidden behind a Detaily toggle for debugging. */}
      {(running || (logs.length > 0 && !result && !error)) && (
        <div style={{
          marginBottom: 12, padding: '10px 14px',
          background: '#f5f7fa', border: '1px solid #d0d7de', borderRadius: 4,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: '0.92em' }}>
            <span style={{ fontWeight: 500 }}>
              {running ? '⏳' : '⏸'} {phase || (running ? 'Pracuji…' : 'Připraveno')}
            </span>
            {logs.length > 0 && (
              <button
                type="button"
                onClick={() => setShowLogs(v => !v)}
                style={{
                  marginLeft: 'auto', padding: '2px 8px', fontSize: '0.82em',
                  background: 'transparent', border: '1px solid #c0c7d0',
                  borderRadius: 3, cursor: 'pointer', color: '#555',
                }}
              >
                {showLogs ? '▲ Skrýt detaily' : `▼ Detaily (${logs.length})`}
              </button>
            )}
          </div>
          {running && (
            <progress
              style={{ width: '100%', height: 4, marginTop: 8, display: 'block' }}
              aria-label={phase || 'Pracuji'}
            />
          )}
          {showLogs && logs.length > 0 && (
            <pre style={{
              marginTop: 10, marginBottom: 0,
              background: '#1e1e1e', color: '#d4d4d4', padding: 10,
              fontSize: '0.78em', maxHeight: 320, overflow: 'auto',
              whiteSpace: 'pre-wrap', wordBreak: 'break-word', borderRadius: 3,
              fontFamily: 'Consolas, Monaco, monospace'
            }}>
              {logs.join('\n')}
            </pre>
          )}
        </div>
      )}

      {result && (
        <div style={{
          marginTop: 16, padding: 14, background: '#d4edda', color: '#155724',
          borderLeft: '4px solid #28a745', borderRadius: 4
        }}>
          <strong>✓ Hotovo</strong>
          {result.elapsed_sec !== undefined && (
            <span style={{ marginLeft: 8 }}>
              ({result.elapsed_sec.toFixed(2)}s Python, {result.wall_sec?.toFixed(2)}s wall)
            </span>
          )}
          {result.score && (
            <div style={{ marginTop: 6, fontSize: '0.9em' }}>
              total_adjusted: <strong>{result.score.total_adjusted.toFixed(2)}</strong>
              {' · '}variance: {result.score.variance.toFixed(2)}
              {' · '}workers_at_best: {result.score.workers_at_best}/{result.n_workers ?? '?'}
              {result.cells_filled !== undefined && (
                <>{' · '}cells: {result.cells_filled}/{result.cells_total}</>
              )}
            </div>
          )}
          {lastInput && (
            <div style={{
              marginTop: 12, padding: 10,
              background: 'rgba(255,255,255,0.6)', borderRadius: 4,
              display: 'flex', flexDirection: 'column', gap: 8,
            }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <button
                  onClick={applyToFirestore}
                  disabled={applying}
                  style={btnStyle('#2e7d32', applying)}
                >
                  {applying
                    ? 'Zapisuji…'
                    : `Aplikovat do Firestore (${lastInput.group} Q${lastInput.quarter}/${lastInput.year})`}
                </button>
                <span style={{ fontSize: '0.85em', color: '#555' }}>
                  Přepíše stávající rozpis skupiny <strong>{lastInput.group}</strong> v období
                  {' '}{lastInput.startStr} → {lastInput.endStr}. Ostatní skupiny zůstanou nedotčené.
                </span>
              </div>
              {applied && (
                <div style={{
                  padding: 8, background: '#c8e6c9', borderLeft: '3px solid #2e7d32',
                  borderRadius: 3, fontSize: '0.88em',
                }}>
                  ✓ Zapsáno do <code>assignments/{applied.year}_Q{applied.quarter}</code>:
                  {' '}{applied.count} nových buněk
                  {applied.dropped > 0 && <> (přepsalo {applied.dropped} stávajících)</>}.
                  {' '}V Plánovači se zobrazí po reloadu panelu.
                  {applied.missingUids.length > 0 && (
                    <div style={{ marginTop: 4, color: '#b71c1c' }}>
                      ⚠ {applied.missingUids.length} buněk se nezapsalo (neznámé uid pro jména:
                      {' '}{[...new Set(applied.missingUids)].join(', ')}).
                    </div>
                  )}
                </div>
              )}
              {applyError && (
                <div style={{
                  padding: 8, background: '#ffcdd2', borderLeft: '3px solid #c62828',
                  borderRadius: 3, fontSize: '0.88em', color: '#b71c1c',
                }}>
                  ✗ Apply selhal: {applyError}
                </div>
              )}
            </div>
          )}
          {renderShiftStats()}
          {renderPreview()}
        </div>
      )}

      {error && (
        <div style={{
          marginTop: 16, padding: 14, background: '#f8d7da', color: '#721c24',
          borderLeft: '4px solid #dc3545', borderRadius: 4
        }}>
          <strong>✗ Selhalo</strong>
          <pre style={{
            marginTop: 8, fontSize: '0.8em',
            background: 'rgba(0,0,0,0.05)', padding: 8, whiteSpace: 'pre-wrap'
          }}>
            {error}
          </pre>
        </div>
      )}
    </div>
  );
}

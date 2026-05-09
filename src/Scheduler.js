// Scheduler.js — Plánovač panel. Firestore-backed view of the quarter's
// assignments + dayStyles. Renders the shared <ScheduleGrid> and friends
// from SchedulerView.js with handlers wired to Firestore.
//
// Refactor note: the calendar grid, group-toggle bar, stats panel, and
// note modal all live in SchedulerView.js so Optimizer.js can render the
// same UI with in-memory state. Anything Scheduler-specific (Auto Weekends
// solver, Memory M1/M2, Vymazat / Obnovit, Fixation, exports) lives here.

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { db } from './firebase';
import {
  collection,
  getDocs,
  doc,
  getDoc,
  setDoc,
  deleteDoc,
} from 'firebase/firestore';
import './Scheduler.css';
import { clsx } from 'clsx';
import {
  GroupToggleBar,
  ScheduleGrid,
  StatsPanel,
  NoteModal,
  computeVisibleUsers,
  computeDisplayedDays,
  getBaseStatus,
  getEffectiveStatus,
  getBaseGroup,
  getDisplayLabel,
  applyShiftOverrides,
} from './SchedulerView';

const cn = (...inputs) => clsx(inputs);

export default function Scheduler() {
  const [currentQOffset, setCurrentQOffset] = useState(1);
  const [users, setUsers] = useState({});
  const [collapsed, setCollapsed] = useState({});
  const [assignments, setAssignments] = useState({});
  const [days, setDays] = useState([]);
  const [userPreferences, setUserPreferences] = useState({});
  const [selectedMonth, setSelectedMonth] = useState(0);
  const [viewMode, setViewMode] = useState('all'); // 'all' | 'weekends'
  const [memories, setMemories] = useState({ M1: null, M2: null });
  const [assignmentsLoaded, setAssignmentsLoaded] = useState(false);

  // Per-quarter doctor commentary. Doctors write a short free-text note in
  // their Settings tab scoped to a specific quarter (e.g. "Prefer either
  // 31.7+2.8 OR 7.8+9.8, not both"). Admin reads via tooltip on the doctor's
  // name in the table header. Stored at quarterNotes/{year}_Q{quarter} with
  // shape { uid: text }. Sibling of dayStyles, but per-quarter free text
  // rather than per-day status.
  const [quarterNotes, setQuarterNotes] = useState({});
  const [editingNoteUid, setEditingNoteUid] = useState(null);
  const [editingNoteText, setEditingNoteText] = useState('');

  // One-shot undo for "Vymazat služby". When the user clears assignments
  // for the active (expanded) groups, the deleted slice is snapshotted to
  // assignmentsBackups/{year}_Q{quarter} and held in this state so the
  // Restore button can render conditionally without an extra read on click.
  // Overwritten on each clear; cleared after a successful restore.
  const [lastClearBackup, setLastClearBackup] = useState(null);

  // Quarter fixation = write-protect flag on the entire quarter. When fixed,
  // ALL mutation paths refuse to fire (cell click, auto-weekends, clear,
  // restore, memory load, the auto-save useEffect itself as last resort).
  // Optimizer.applyToFirestore checks the same flag independently.
  // Persisted at quarterFixed/{year}_Q{quarter} as { fixedAt, fixedBy }.
  // Doc presence = fixed; doc absence = editable.
  const [fixation, setFixation] = useState(null);
  const isFixed = fixation !== null;

  const groupOrder = useMemo(() => ['staří', 'střední', 'mladí'], []);
  const groupLabel = useMemo(() => ({ staří: 'S', střední: 'M', mladí: 'J' }), []);

  const today = new Date();
  const currentQuarter = Math.floor(today.getMonth() / 3) + 1;
  const targetQuarter = ((currentQuarter + currentQOffset - 1) % 4) + 1;
  const targetYear = currentQuarter + currentQOffset > 4 ? today.getFullYear() + 1 : today.getFullYear();
  const qStartMonth = (targetQuarter - 1) * 3;

  // ==================== NAČTENÍ DAT ====================
  useEffect(() => {
    setAssignmentsLoaded(false);
    const fetchData = async () => {
      const snapshot = await getDocs(collection(db, 'settings'));
      const allUsersRaw = snapshot.docs.map(d => ({ uid: d.id, ...d.data() }));

      // Load per-quarter limit overrides BEFORE grouping, so the per-doctor
      // weekdayShifts/weekendShifts/shiftInterval values inside `users` (and
      // therefore everything downstream — StatsPanel diff targets, interval
      // violations in ScheduleGrid, header indicator) reflect what the admin
      // configured for this quarter.
      const overridesSnap = await getDoc(
        doc(db, 'quarterShiftOverrides', `${targetYear}_Q${targetQuarter}`)
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
      groupOrder.forEach(g => {
        if (grouped[g]) sortedGroups[g] = grouped[g];
      });

      setUsers(sortedGroups);
      setCollapsed(Object.keys(sortedGroups).reduce((a, g) => ({ ...a, [g]: false }), {}));

      const prefs = {};
      for (const group of Object.values(sortedGroups)) {
        for (const u of group) {
          const snap = await getDoc(doc(db, 'dayStyles', u.uid));
          if (snap.exists()) {
            const styles = snap.data().styles || [];
            prefs[u.uid] = Object.fromEntries(styles.map(s => [s.date, s.status]));
          } else {
            prefs[u.uid] = {};
          }
        }
      }
      setUserPreferences(prefs);

      const qDays = [];
      const qStart = new Date(targetYear, qStartMonth, 1);
      const prevFriday = new Date(qStart);
      const dow = qStart.getDay();
      const toFriday = dow === 0 ? 2 : (dow + 2) % 7;
      prevFriday.setDate(prevFriday.getDate() - toFriday);

      for (let d = new Date(prevFriday); d < qStart; d.setDate(d.getDate() + 1)) {
        qDays.push(d.toLocaleDateString('en-CA'));
      }
      for (let m = qStartMonth; m < qStartMonth + 3; m++) {
        const last = new Date(targetYear, m + 1, 0).getDate();
        for (let i = 1; i <= last; i++) {
          qDays.push(new Date(targetYear, m, i).toLocaleDateString('en-CA'));
        }
      }
      setDays(qDays);

      const snap = await getDoc(doc(db, 'assignments', `${targetYear}_Q${targetQuarter}`));
      setAssignments(snap.exists() ? snap.data() : {});
      setAssignmentsLoaded(true);

      const notesSnap = await getDoc(doc(db, 'quarterNotes', `${targetYear}_Q${targetQuarter}`));
      setQuarterNotes(notesSnap.exists() ? notesSnap.data() : {});
    };

    fetchData();
  }, [currentQOffset, groupOrder, qStartMonth, targetQuarter, targetYear]);

  // Load last-clear backup for the current quarter so the "Obnovit" button
  // can render without an extra read on click.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const snap = await getDoc(
        doc(db, 'assignmentsBackups', `${targetYear}_Q${targetQuarter}`)
      );
      if (cancelled) return;
      const data = snap.exists() ? snap.data() : null;
      setLastClearBackup(data && data.cells ? data : null);
    };
    load();
    return () => { cancelled = true; };
  }, [targetYear, targetQuarter]);

  // Load fixation status for the current quarter. Doc presence = fixed.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const snap = await getDoc(
          doc(db, 'quarterFixed', `${targetYear}_Q${targetQuarter}`)
        );
        if (cancelled) return;
        setFixation(snap.exists() ? snap.data() : null);
      } catch (e) {
        console.error('Fixation load failed:', e);
        if (!cancelled) setFixation(null);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [targetYear, targetQuarter]);

  // Toggle fixation. Both directions require explicit confirmation.
  const toggleFixation = useCallback(async () => {
    const refQ = doc(db, 'quarterFixed', `${targetYear}_Q${targetQuarter}`);
    if (isFixed) {
      const ok = window.confirm(
        `Odfixovat Q${targetQuarter}/${targetYear}?\n\n` +
        `Po odfixování budou opět aktivní:\n` +
        `  • klik na buňku\n  • Vymazat / Obnovit\n  • Memory Load\n  • Auto Weekends\n  • Optimalizátor → Aplikovat`
      );
      if (!ok) return;
      try {
        await deleteDoc(refQ);
        setFixation(null);
        window.notify?.(`Q${targetQuarter}/${targetYear} odfixováno.`, 'success');
      } catch (e) {
        console.error('Unfix failed:', e);
        window.alert('Odfixování selhalo: ' + (e.message || e));
      }
    } else {
      const ok = window.confirm(
        `Zafixovat Q${targetQuarter}/${targetYear}?\n\n` +
        `Po zafixování nebude možné kvartál editovat — ani klikem do tabulky, ` +
        `ani Vymazáním, ani Optimalizátorem. Pro úpravy bude třeba nejdřív odfixovat.`
      );
      if (!ok) return;
      const payload = {
        fixedAt: new Date().toISOString(),
        fixedBy: 'admin',
      };
      try {
        await setDoc(refQ, payload);
        setFixation(payload);
        window.notify?.(`Q${targetQuarter}/${targetYear} zafixováno. Edity blokovány.`, 'success');
      } catch (e) {
        console.error('Fix failed:', e);
        window.alert('Zafixování selhalo: ' + (e.message || e));
      }
    }
  }, [isFixed, targetYear, targetQuarter]);

  // Admin edit of someone else's note (or the admin's own).
  const saveQuarterNote = useCallback(async (uid, text) => {
    const trimmed = text.trim();
    const ref = doc(db, 'quarterNotes', `${targetYear}_Q${targetQuarter}`);
    const next = { ...quarterNotes };
    if (trimmed) {
      next[uid] = trimmed;
    } else {
      delete next[uid];
    }
    setQuarterNotes(next);
    await setDoc(ref, next);
    setEditingNoteUid(null);
    setEditingNoteText('');
  }, [quarterNotes, targetYear, targetQuarter]);

  // Derived collections — memoized at the parent so SchedulerView's
  // ScheduleGrid sees stable references.
  const visibleUsers = useMemo(
    () => computeVisibleUsers(users, collapsed, groupOrder),
    [users, collapsed, groupOrder]
  );

  const displayedDays = useMemo(
    () => computeDisplayedDays(days, viewMode),
    [days, viewMode]
  );

  const exportDays = useMemo(() => {
    const quarterStartStr = `${targetYear}-${String(qStartMonth + 1).padStart(2, '0')}-01`;
    return days.filter(date => date >= quarterStartStr);
  }, [days, targetYear, qStartMonth]);

  // ── Clear assignments + one-shot Restore ────────────────────────────────
  const clearAssignments = useCallback(async () => {
    if (isFixed) {
      window.alert(`Q${targetQuarter}/${targetYear} je zafixováno (🔒). Pro mazání nejdřív odfixovat.`);
      return;
    }
    const scope = groupOrder.filter(g => !collapsed[g]);
    if (scope.length === 0) {
      window.alert('Žádné aktivní (rozbalené) skupiny. Rozbal alespoň jednu.');
      return;
    }

    const toDelete = {};
    for (const [key, val] of Object.entries(assignments)) {
      if (scope.includes(getBaseGroup(val))) {
        toDelete[key] = val;
      }
    }
    const count = Object.keys(toDelete).length;
    if (count === 0) {
      window.alert(`Skupiny ${scope.join(', ')} nemají žádné přiřazené služby.`);
      return;
    }

    const collapsedList = groupOrder.filter(g => collapsed[g]);
    const ok = window.confirm(
      `Opravdu vymazat ${count} služeb pro Q${targetQuarter} ${targetYear}?\n\n` +
      `Skupiny: ${scope.join(', ')}\n` +
      `Sbalené (zachovány): ${collapsedList.length ? collapsedList.join(', ') : '(žádné)'}\n\n` +
      `Záloha bude přepsána. Předchozí "Obnovit" už nebude funkční.`
    );
    if (!ok) return;

    const backup = {
      cells: toDelete,
      scope,
      clearedAt: new Date().toISOString(),
      count,
    };
    try {
      await setDoc(
        doc(db, 'assignmentsBackups', `${targetYear}_Q${targetQuarter}`),
        backup
      );
    } catch (err) {
      console.error('Backup write failed:', err);
      window.alert('Záloha selhala. Mazání zrušeno.');
      return;
    }

    const next = { ...assignments };
    for (const key of Object.keys(toDelete)) delete next[key];
    setAssignments(next);
    setLastClearBackup(backup);

    window.notify?.(`Smazáno ${count} služeb. Lze obnovit.`, 'success');
  }, [assignments, collapsed, groupOrder, targetQuarter, targetYear, isFixed]);

  const restoreLastClear = useCallback(async () => {
    if (!lastClearBackup) return;
    if (isFixed) {
      window.alert(`Q${targetQuarter}/${targetYear} je zafixováno (🔒). Pro obnovu nejdřív odfixovat.`);
      return;
    }
    const { cells, scope, count } = lastClearBackup;

    let conflicts = 0;
    for (const key of Object.keys(cells)) {
      if (assignments[key]) conflicts++;
    }

    const ok = window.confirm(
      `Obnovit ${count} smazaných služeb (skupiny: ${scope.join(', ')})?\n\n` +
      (conflicts > 0
        ? `POZOR: ${conflicts} buněk je nyní obsazeno — budou přepsány.\n\n`
        : '') +
      `Záloha bude smazána.`
    );
    if (!ok) return;

    const next = { ...assignments, ...cells };
    setAssignments(next);

    try {
      await setDoc(
        doc(db, 'assignmentsBackups', `${targetYear}_Q${targetQuarter}`),
        {}
      );
    } catch (err) {
      console.error('Backup clear failed:', err);
    }
    setLastClearBackup(null);

    window.notify?.(`Obnoveno ${count} služeb.`, 'success');
  }, [assignments, lastClearBackup, targetQuarter, targetYear, isFixed]);

  // Auto-save assignments — last-line-of-defense gate against fixation.
  useEffect(() => {
    if (!assignmentsLoaded) return;
    if (isFixed) return;
    setDoc(doc(db, 'assignments', `${targetYear}_Q${targetQuarter}`), assignments);
  }, [assignments, targetQuarter, targetYear, assignmentsLoaded, isFixed]);

  // ==================== MEMORY SLOTS (temporary, per quarter) ====================
  const MEMORY_KEY = `scheduler_mem_${targetYear}_Q${targetQuarter}`;

  useEffect(() => {
    const saved = sessionStorage.getItem(MEMORY_KEY);
    if (saved) {
      setMemories(JSON.parse(saved));
    } else {
      setMemories({ M1: null, M2: null });
    }
  }, [targetYear, targetQuarter, MEMORY_KEY]);

  useEffect(() => {
    sessionStorage.setItem(MEMORY_KEY, JSON.stringify(memories));
  }, [memories], MEMORY_KEY);

  const handlePrev = () => setCurrentQOffset(o => o - 1);
  const handleNext = () => setCurrentQOffset(o => o + 1);

  // Cell click: cycle through user's allowed groups.
  const handleCellClick = useCallback((date, user) => {
    if (isFixed) {
      window.notify?.(`Q${targetQuarter}/${targetYear} je zafixováno (🔒). Pro úpravy nejdřív odfixovat.`, 'warning');
      return;
    }
    const key = `${date}_${user.uid}`;
    const current = assignments[key];
    const fullStatus = userPreferences[user.uid]?.[date];
    const effective = getEffectiveStatus(fullStatus);
    const userGroups = user.groups || [];
    const cycle = ['staří', 'střední', 'mladí'];

    if (effective === 'blocked') {
      window.notify?.("Den je blokován. Pravým klikem nejprve unblock.", 'warning');
      return;
    }

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
        setAssignments(prev => {
          const { [key]: _, ...rest } = prev;
          window.notify?.(`${user.shortcut} odebrán (unblocked zůstává)`, 'info');
          return rest;
        });
        return;
      }
    }

    if (next) {
      setAssignments(prev => ({ ...prev, [key]: next }));
      window.notify?.(`${user.shortcut} → ${getDisplayLabel(next, { staří: 'S', střední: 'M', mladí: 'J' })}`, 'success');
    }
  }, [assignments, userPreferences, isFixed, targetQuarter, targetYear]);

  // Right-click on a cell: cycle the dayStyles status (block / unblock /
  // restore original demand). Persisted to dayStyles/{uid} as part of the
  // user's preference list. Independent from `assignments`.
  const handleContextMenu = useCallback(async (date, user) => {
    const currentStatus = userPreferences[user.uid]?.[date] || null;
    const baseStatus = getBaseStatus(currentStatus);
    const effective = getEffectiveStatus(currentStatus);

    let newStatus = null;
    let notifyMsg = '';
    let notifyType = 'info';

    if (effective === 'blocked') {
      newStatus = (baseStatus === 'preferred' || baseStatus === 'not available')
        ? `${baseStatus}_unblocked`
        : 'unblocked';
      notifyMsg = `✅ Unblocked: ${user.shortcut} – ${date}`;
      notifyType = 'success';
    } else if (effective === 'unblocked') {
      newStatus = (baseStatus === 'preferred' || baseStatus === 'not available')
        ? baseStatus
        : null;
      notifyMsg = newStatus
        ? `Original demand restored (${newStatus}): ${user.shortcut} – ${date}`
        : `Unblock removed: ${user.shortcut} – ${date}`;
      notifyType = newStatus ? 'success' : 'info';
    } else {
      newStatus = (baseStatus === 'preferred' || baseStatus === 'not available')
        ? `${baseStatus}_blocked`
        : 'blocked';
      notifyMsg = `⛔ Blocked: ${user.shortcut} – ${date}`;
      notifyType = 'warning';
    }

    const ref = doc(db, 'dayStyles', user.uid);
    const snap = await getDoc(ref);
    let styles = snap.exists() ? snap.data().styles || [] : [];
    styles = styles.filter(s => s.date !== date);
    if (newStatus) styles.push({ date, status: newStatus });

    await setDoc(ref, { styles }, { merge: true });

    setUserPreferences(prev => {
      const newPrefs = { ...prev };
      if (!newPrefs[user.uid]) newPrefs[user.uid] = {};
      if (newStatus) {
        newPrefs[user.uid][date] = newStatus;
      } else {
        delete newPrefs[user.uid][date];
      }
      return newPrefs;
    });

    window.notify?.(notifyMsg, notifyType);
  }, [userPreferences]);

  const onDoctorClick = useCallback((user) => {
    setEditingNoteUid(user.uid);
    setEditingNoteText(quarterNotes[user.uid] || '');
  }, [quarterNotes]);

  // ==================== EXPORTS ====================
  const exportToTSV = () => {
    let tsv = 'Datum\t';
    visibleUsers.forEach(u => tsv += `${u.shortcut}\t`);
    tsv = tsv.trim() + '\n';

    exportDays.forEach(date => {
      tsv += date + '\t';
      visibleUsers.forEach(u => {
        const key = `${date}_${u.uid}`;
        const base = getBaseGroup(assignments[key]);
        tsv += (base ? groupLabel[base] : '') + '\t';
      });
      tsv = tsv.trim() + '\n';
    });

    const blob = new Blob([tsv], { type: 'text/tab-separated-values' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sluzby_Q${targetQuarter}_${targetYear}.tsv`;
    a.click();
  };

  const exportPreferencesToTSV = () => {
    let tsv = 'Datum\tDoktor\tZkratka\tPreference\n';
    visibleUsers.forEach(u => {
      const prefs = userPreferences[u.uid] || {};
      Object.entries(prefs).forEach(([date, status]) => {
        const prefText = status === 'preferred' ? 'ANO' : status === 'not available' ? 'NE' : '';
        if (prefText) {
          tsv += `${date}\t${u.name}\t${u.shortcut}\t${prefText}\n`;
        }
      });
    });

    const blob = new Blob([tsv], { type: 'text/tab-separated-values' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pozadavky_Q${targetQuarter}_${targetYear}.tsv`;
    a.click();
  };

  const exportToBIT = () => {
    let tsv = '';
    exportDays.forEach(date => {
      const sDoc = visibleUsers.find(u => getBaseGroup(assignments[`${date}_${u.uid}`]) === 'staří')?.shortcut || '';
      const mDoc = visibleUsers.find(u => getBaseGroup(assignments[`${date}_${u.uid}`]) === 'střední')?.shortcut || '';
      const jDoc = visibleUsers.find(u => getBaseGroup(assignments[`${date}_${u.uid}`]) === 'mladí')?.shortcut || '';
      tsv += `${sDoc}\t${mDoc}\t${jDoc}\n`;
    });

    const blob = new Blob([tsv], { type: 'text/tab-separated-values' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bit_Q${targetQuarter}_${targetYear}.tsv`;
    a.click();

    window.notify?.(`BIT export hotový (${exportDays.length} dní od 1.${qStartMonth + 1}.)`, 'success');
  };

  // ==================== WEEKEND SOLVER ====================
  const weekendBlocks = useMemo(() => {
    const blocks = [];
    let current = [];
    days.forEach(date => {
      const d = new Date(date);
      const dow = d.getDay();
      if (dow === 5 || dow === 6 || dow === 0) {
        current.push(date);
      } else if (current.length > 0) {
        blocks.push([...current]);
        current = [];
      }
    });
    if (current.length > 0) blocks.push(current);
    return blocks;
  }, [days]);

  const autoAssignWeekends = useCallback(async () => {
    if (isFixed) {
      window.alert(`Q${targetQuarter}/${targetYear} je zafixováno (🔒). Pro Auto Weekends nejdřív odfixovat.`);
      return;
    }
    if (!window.confirm('Spustit Auto Weekends?\n\nPřiřadí víkendy dle priorit: 24h buffer (striktní) -> max 1 směna za víkend -> střídání víkendů.')) return;

    let newAssignments = { ...assignments };
    let changes = 0;
    let problems = [];

    const groupMap = {
      staří: users['staří'] || [],
      střední: users['střední'] || [],
      mladí: users['mladí'] || [],
    };

    const hasAdjacentShift = (user, dateStr, currentAssigns) => {
      const d = new Date(dateStr);
      const prev = new Date(d); prev.setDate(prev.getDate() - 1);
      const next = new Date(d); next.setDate(next.getDate() + 1);
      const prevStr = prev.toLocaleDateString('en-CA');
      const nextStr = next.toLocaleDateString('en-CA');
      return (
        currentAssigns[`${prevStr}_${user.uid}`] ||
        currentAssigns[`${nextStr}_${user.uid}`]
      );
    };

    const workedInSameBlock = (user, dateStr, currentAssigns) => {
      const block = weekendBlocks.find(b => b.includes(dateStr));
      if (!block) return false;
      return block.some(d => d !== dateStr && currentAssigns[`${d}_${user.uid}`]);
    };

    const hasAdjacentWeekendBlackout = (user, dateStr, currentAssigns) => {
      const bIdx = weekendBlocks.findIndex(b => b.includes(dateStr));
      if (bIdx === -1) return false;
      let blackout = false;
      if (bIdx > 0) {
        blackout = blackout || weekendBlocks[bIdx - 1].some(d => currentAssigns[`${d}_${user.uid}`]);
      }
      if (bIdx < weekendBlocks.length - 1) {
        blackout = blackout || weekendBlocks[bIdx + 1].some(d => currentAssigns[`${d}_${user.uid}`]);
      }
      return blackout;
    };

    const isAvailable = (user, dateStr) => {
      const fullStatus = userPreferences[user.uid]?.[dateStr];
      const effective = getEffectiveStatus(fullStatus);
      return effective !== 'blocked' && effective !== 'not available';
    };

    const weekendDates = days.filter(d => {
      const dow = new Date(d).getDay();
      return dow === 5 || dow === 6 || dow === 0;
    });

    for (const date of weekendDates) {
      const neededGroups = ['staří', 'střední', 'mladí'].filter(g => {
        return !Object.keys(newAssignments).some(k => k.startsWith(`${date}_`) && newAssignments[k] === g);
      });

      for (const group of neededGroups) {
        let candidates = groupMap[group].filter(u =>
          isAvailable(u, date) && !hasAdjacentShift(u, date, newAssignments)
        );

        if (candidates.length === 0) {
          problems.push(`${date} (${group.charAt(0).toUpperCase()}): Nikdo nemá volno (24h pravidlo nebo blokace).`);
          continue;
        }

        let viable = candidates.filter(u =>
          !workedInSameBlock(u, date, newAssignments) &&
          !hasAdjacentWeekendBlackout(u, date, newAssignments)
        );

        if (viable.length === 0) {
          viable = candidates.filter(u => !workedInSameBlock(u, date, newAssignments));
        }

        if (viable.length === 0) {
          viable = candidates;
          problems.push(`Upozornění: ${date} (${group.charAt(0).toUpperCase()}) musel porušit max 1 směnu za víkend.`);
        }

        viable.sort((a, b) => {
          const countA = Object.keys(newAssignments).filter(k => k.endsWith(`_${a.uid}`)).length;
          const countB = Object.keys(newAssignments).filter(k => k.endsWith(`_${b.uid}`)).length;
          return countA - countB;
        });

        const chosen = viable[0];
        const key = `${date}_${chosen.uid}`;
        newAssignments[key] = group;
        changes++;
      }
    }

    setAssignments(newAssignments);

    if (problems.length > 0) {
      window.notify?.(`Hotovo! Přiřazeno ${changes} služeb.\nProblémy/Ústupky:\n${problems.join('\n')}`, 'warning');
    } else {
      window.notify?.(`Hotovo! Přiřazeno ${changes} víkendových služeb bez porušení pravidel.`, 'success');
    }
  }, [assignments, days, users, userPreferences, weekendBlocks, isFixed, targetQuarter, targetYear]);

  const saveToMemory = (slot) => {
    const savedAssignments = {};
    exportDays.forEach(date => {
      visibleUsers.forEach(u => {
        const key = `${date}_${u.uid}`;
        if (assignments[key]) savedAssignments[key] = assignments[key];
      });
    });

    setMemories(prev => ({
      ...prev,
      [slot]: Object.keys(savedAssignments).length > 0 ? savedAssignments : null,
    }));

    window.notify?.(`💾 Uloženo do ${slot} (${exportDays.length} dní)`, 'success');
  };

  const loadFromMemory = (slot) => {
    if (isFixed) {
      window.notify?.(`Q${targetQuarter}/${targetYear} je zafixováno (🔒). Memory Load by přepsal data — nejdřív odfixovat.`, 'warning');
      return;
    }
    const saved = memories[slot];
    if (!saved) {
      window.notify?.(`Žádné data v ${slot}`, 'warning');
      return;
    }

    setAssignments(prev => {
      const newAssign = { ...prev };
      exportDays.forEach(date => {
        visibleUsers.forEach(u => {
          const key = `${date}_${u.uid}`;
          if (saved[key]) newAssign[key] = saved[key];
          else delete newAssign[key];
        });
      });
      return newAssign;
    });

    window.notify?.(`📂 Načteno z ${slot}`, 'success');
  };

  // ==================== RENDER ====================
  return (
    <div className="flex flex-col h-full bg-gray-50">
      <div className="flex flex-1 overflow-auto gap-6 p-6">
        <ScheduleGrid
          visibleUsers={visibleUsers}
          displayedDays={displayedDays}
          days={days}
          assignments={assignments}
          userPreferences={userPreferences}
          quarterNotes={quarterNotes}
          groupLabel={groupLabel}
          targetYear={targetYear}
          targetQuarter={targetQuarter}
          onCellClick={handleCellClick}
          onCellContextMenu={handleContextMenu}
          onDoctorClick={onDoctorClick}
          userOverrideStatus={u => (u._overrideKeys?.length ?? 0)}
        />

        {/* PRAVÝ PANEL */}
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
          <div className="flex items-center gap-3 mb-3">
            <button
              onClick={handlePrev}
              className="px-5 py-2 bg-gray-100 rounded-lg hover:bg-gray-200 font-medium transition"
            >
              ← Pre
            </button>
            <div className="flex-1 text-center">
              <div className={cn(
                "text-xl font-bold",
                isFixed ? "text-amber-700" : "text-blue-700"
              )}>
                {isFixed && '🔒 '}Q{targetQuarter} {targetYear}
              </div>
            </div>
            <button
              onClick={handleNext}
              className="px-5 py-2 bg-gray-100 rounded-lg hover:bg-gray-200 font-medium transition"
            >
              Nx →
            </button>
          </div>

          {/* Fixation toggle */}
          <div className="mb-6">
            <button
              type="button"
              onClick={toggleFixation}
              className={cn(
                "w-full py-2 rounded-lg font-semibold transition shadow-sm text-sm",
                isFixed
                  ? "bg-amber-100 text-amber-900 border border-amber-400 hover:bg-amber-200"
                  : "bg-gray-100 text-gray-700 border border-gray-300 hover:bg-gray-200"
              )}
              title={isFixed
                ? `Zafixováno ${fixation?.fixedAt ? new Date(fixation.fixedAt).toLocaleString('cs-CZ') : ''}. Klikni pro odfixování.`
                : 'Zamkne kvartál proti všem úpravám (klik / Vymazat / Auto / Optimalizátor).'}
            >
              {isFixed
                ? `🔒 Zafixováno ${fixation?.fixedAt ? '· ' + new Date(fixation.fixedAt).toLocaleDateString('cs-CZ') : ''} · klikni pro odfixování`
                : '🔓 Zafixovat kvartál'}
            </button>
            {isFixed && (
              <p className="text-[11px] text-amber-700 mt-1 text-center">
                Edity zablokovány. Optimalizátor → Aplikovat odmítne zápis.
              </p>
            )}
          </div>

          <StatsPanel
            groupOrder={groupOrder}
            users={users}
            visibleUsers={visibleUsers}
            collapsed={collapsed}
            assignments={assignments}
            days={days}
            qStartMonth={qStartMonth}
            targetQuarter={targetQuarter}
            selectedMonth={selectedMonth}
            setSelectedMonth={setSelectedMonth}
          />

          {/* Memory slots */}
          <div className="mb-6 mt-6">
            <h4 className="text-sm font-semibold text-gray-600 mb-2">Dočasná paměť (M1 / M2)</h4>
            <div className="flex gap-3">
              {['M1', 'M2'].map(slot => {
                const isOccupied = !!memories[slot];
                return (
                  <div key={slot} className="flex-1">
                    <div className={cn(
                      "text-xs font-bold px-3 py-1 rounded-t-lg text-center transition-colors",
                      isOccupied ? "bg-green-600 text-white" : "bg-gray-200 text-gray-600"
                    )}>
                      {slot} {isOccupied && '✓'}
                    </div>
                    <div className="flex gap-px bg-gray-200 p-px rounded-b-lg">
                      <button
                        onClick={() => saveToMemory(slot)}
                        className="flex-1 py-2 bg-white hover:bg-green-50 text-green-700 font-medium text-sm rounded-bl-lg transition"
                      >
                        Save
                      </button>
                      <button
                        onClick={() => loadFromMemory(slot)}
                        disabled={isFixed}
                        title={isFixed ? 'Kvartál je zafixovaný — Load by přepsal data.' : ''}
                        className={cn(
                          "flex-1 py-2 font-medium text-sm rounded-br-lg transition",
                          isFixed
                            ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                            : "bg-white hover:bg-blue-50 text-blue-700"
                        )}
                      >
                        Load
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="text-[10px] text-gray-500 mt-1 text-center">
              Dočasné • zmizí po zavření prohlížeče
            </p>
          </div>

          {/* Auto Weekends + exports */}
          <div className="flex gap-3 mt-8">
            <button
              onClick={autoAssignWeekends}
              disabled={isFixed}
              title={isFixed ? 'Kvartál je zafixovaný.' : ''}
              className={cn(
                "flex-1 py-3 rounded-lg font-semibold transition shadow-md text-sm text-white",
                isFixed
                  ? "bg-gray-300 cursor-not-allowed"
                  : "bg-orange-600 hover:bg-orange-700"
              )}
            >
              Auto Weekends
            </button>
            <button
              onClick={() => exportPreferencesToTSV()}
              className="flex-1 py-3 bg-purple-600 text-white rounded-lg font-semibold hover:bg-purple-700 transition shadow-md text-sm"
            >
              Exp Pož
            </button>
            <button
              onClick={exportToTSV}
              className="flex-1 py-3 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700 transition shadow-md text-sm"
            >
              Exp Sol
            </button>
            <button
              onClick={() => exportToBIT()}
              className="flex-1 py-3 bg-indigo-600 text-white rounded-lg font-semibold hover:bg-indigo-700 transition shadow-md text-sm"
            >
              Exp BIT
            </button>
          </div>

          {/* Clear / Restore */}
          <div className="flex gap-3 mt-3">
            <button
              onClick={clearAssignments}
              disabled={isFixed}
              className={cn(
                "flex-1 py-3 rounded-lg font-semibold transition shadow-md text-sm text-white",
                isFixed
                  ? "bg-gray-300 cursor-not-allowed"
                  : "bg-red-600 hover:bg-red-700"
              )}
              title={isFixed
                ? 'Kvartál je zafixovaný — pro mazání nejdřív odfixovat.'
                : 'Vymaže služby pro rozbalené skupiny v aktuálním kvartálu. Sbalené skupiny zůstanou. Záloha umožní jeden krok zpět.'}
            >
              Vymazat služby
            </button>
            {lastClearBackup && (
              <button
                onClick={restoreLastClear}
                disabled={isFixed}
                className={cn(
                  "flex-1 py-3 rounded-lg font-semibold transition shadow-md text-sm text-white",
                  isFixed
                    ? "bg-gray-300 cursor-not-allowed"
                    : "bg-amber-500 hover:bg-amber-600"
                )}
                title={isFixed
                  ? 'Kvartál je zafixovaný.'
                  : `Obnoví ${lastClearBackup.count} buněk smazaných ${new Date(lastClearBackup.clearedAt).toLocaleString('cs-CZ')}`}
              >
                ↶ Obnovit ({lastClearBackup.count})
              </button>
            )}
          </div>
        </div>
      </div>

      <NoteModal
        users={users}
        editingNoteUid={editingNoteUid}
        editingNoteText={editingNoteText}
        setEditingNoteUid={setEditingNoteUid}
        setEditingNoteText={setEditingNoteText}
        saveQuarterNote={saveQuarterNote}
        targetYear={targetYear}
        targetQuarter={targetQuarter}
      />
    </div>
  );
}

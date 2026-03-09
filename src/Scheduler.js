import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { db } from './firebase';
import {
  collection,
  getDocs,
  doc,
  getDoc,
  setDoc,
} from 'firebase/firestore';
import { generateHolidays } from './utils';
import './Scheduler.css';
import { clsx } from 'clsx';

const cn = (...inputs) => clsx(inputs);

const doctorOrder = [
  'Hro', 'Hv', 'ValM', 'Bee', 'Chre', 'Šk', 'Šd', 'Bia', 'Ble', 'Har',
  'Koc', 'Brz', 'Dvo', 'Sib', 'Sal', 'Žd', 'ValJ', 'MarB', 'Pli',
  'Mud', 'Kul', 'Hru', 'Pro', 'Kep', 'Švr', 'Mrk',
];

export default function Scheduler() {
  const [currentQOffset, setCurrentQOffset] = useState(1);
  const [users, setUsers] = useState({});
  const [collapsed, setCollapsed] = useState({});
  const [assignments, setAssignments] = useState({});
  const [days, setDays] = useState([]);
  const [userPreferences, setUserPreferences] = useState({});
  const [selectedMonth, setSelectedMonth] = useState(0);

  const groupOrder = useMemo(() => ['staří', 'střední', 'mladí'], []);
  const groupLabel = useMemo(() => ({ staří: 'S', střední: 'M', mladí: 'J' }), []);

  // ==================== COMPOSITE STATUS HELPERS (NO DB CHANGE) ====================
  const getBaseStatus = useCallback((status) => {
    if (!status) return null;
    return status.replace(/_(blocked|unblocked)$/, '');
  }, []);

  const getEffectiveStatus = useCallback((status) => {
    if (!status) return null;
    if (status.endsWith('_unblocked')) return 'unblocked';
    if (status.endsWith('_blocked')) return 'blocked';
    return status;
  }, []);

  // ==================== ORIGINAL ASSIGNMENT HELPERS (still needed) ====================
  const getBaseGroup = useCallback((val) => val ? val.replace(/_u$/, '') : null, []);
  const isUnblockedAssignment = useCallback((val) => val?.endsWith('_u') || false, []);

  const getDisplayLabel = useCallback((assigned) => {
    if (!assigned) return '';
    const base = getBaseGroup(assigned);
    const label = groupLabel[base] || base;
    return isUnblockedAssignment(assigned) ? label + 'U' : label;
  }, [groupLabel, getBaseGroup, isUnblockedAssignment]);

  const today = new Date();
  const currentQuarter = Math.floor(today.getMonth() / 3) + 1;
  const targetQuarter = ((currentQuarter + currentQOffset - 1) % 4) + 1;
  const targetYear = currentQuarter + currentQOffset > 4 ? today.getFullYear() + 1 : today.getFullYear();
  const qStartMonth = (targetQuarter - 1) * 3;

  const quarterMonths = useMemo(() => {
    return [qStartMonth + 1, qStartMonth + 2, qStartMonth + 3];
  }, [qStartMonth]);

  // ==================== NAČTENÍ DAT ====================
  useEffect(() => {
    const fetchData = async () => {
      const snapshot = await getDocs(collection(db, 'settings'));
      const allUsers = snapshot.docs.map(d => ({ uid: d.id, ...d.data() }));

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
    };

    fetchData();
  }, [currentQOffset, groupOrder, qStartMonth, targetQuarter, targetYear]);

  // uložení změn
  useEffect(() => {
    if (Object.keys(assignments).length === 0) return;
    setDoc(doc(db, 'assignments', `${targetYear}_Q${targetQuarter}`), assignments);
  }, [assignments, targetQuarter, targetYear]);

  const handlePrev = () => setCurrentQOffset(o => o - 1);
  const handleNext = () => setCurrentQOffset(o => o + 1);

  const toggleGroup = useCallback((group) => {
    setCollapsed(prev => ({ ...prev, [group]: !prev[group] }));
  }, []);

  const handleCellClick = useCallback((date, user) => {
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
      window.notify?.(`${user.shortcut} → ${getDisplayLabel(next)}`, 'success');
    }
  }, [assignments, userPreferences, getBaseGroup, getDisplayLabel, getEffectiveStatus]);

  const exportToTSV = () => {
        let tsv = 'Datum\t';
        visibleUsers.forEach(u => tsv += `${u.shortcut}\t`);
        tsv = tsv.trim() + '\n';

        days.forEach(date => {
            tsv += date + '\t';
            visibleUsers.forEach(u => {
            const key = `${date}_${u.uid}`;
            tsv += (assignments[key] ? groupLabel[assignments[key]] : '') + '\t';
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

  const isWeekendOrHoliday = useCallback((date) => {
    const d = new Date(date);
    return d.getDay() === 0 || d.getDay() === 6 || generateHolidays().some(h => h.date === date);
  }, []);

  const visibleUsers = useMemo(() => {
    const seen = new Set();
    const list = [];

    groupOrder.forEach(group => {
      if (!collapsed[group] && users[group]) {
        users[group].forEach(u => {
          if (!seen.has(u.uid)) {
            seen.add(u.uid);
            list.push(u);
          }
        });
      }
    });

    list.sort((a, b) => {
      const aPos = doctorOrder.indexOf(a.shortcut);
      const bPos = doctorOrder.indexOf(b.shortcut);
      return (aPos === -1 ? Infinity : aPos) - (bPos === -1 ? Infinity : bPos);
    });

    return list;
  }, [users, collapsed, groupOrder]);

  const getCellClasses = useCallback((date, user) => {
    const key = `${date}_${user.uid}`;
    const assigned = !!assignments[key];
    const fullStatus = userPreferences[user.uid]?.[date];
    const effective = getEffectiveStatus(fullStatus);

    if (effective === 'not available') return { className: 'bg-gray-500 text-white line-through cursor-not-allowed', hasIntervalViolation: false };
    if (effective === 'preferred') return { className: 'bg-green-600 text-white font-bold', hasIntervalViolation: false };

    if (effective === 'unblocked') {
      return {
        className: assigned 
          ? 'bg-amber-600 text-white font-bold border-2 border-yellow-300' 
          : 'bg-amber-100 border-2 border-amber-400 text-amber-700 font-medium',
        hasIntervalViolation: false
      };
    }

    if (effective === 'blocked') return {className: 'bg-gray-800 text-gray-200 line-through cursor-not-allowed select-none',hasIntervalViolation: false}; 

    const d = new Date(date);
    const dayOfWeek = d.getDay();
    const isWeekendDay = dayOfWeek === 5 || dayOfWeek === 6 || dayOfWeek === 0;

    if (!isWeekendDay) {
      return {
        className: assigned ? 'bg-blue-600 text-white' : 'hover:bg-gray-100',
        hasIntervalViolation: false
      };
    }

    // === Víkendová logika (pátek–neděle) ===
    const currentFriday = new Date(d);
    if (dayOfWeek === 5) currentFriday.setDate(currentFriday.getDate());
    else if (dayOfWeek === 6) currentFriday.setDate(currentFriday.getDate() - 1);
    else currentFriday.setDate(currentFriday.getDate() - 2);

    const nearbyDates = [];
    for (let week of [-7, 0, 7]) {
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
      hasIntervalViolation: false
    };
  }, [assignments, userPreferences, days, getEffectiveStatus]);

const exportPreferencesToTSV = () => {
    let tsv = 'Datum\tDoktor\tZkratka\tPreference\n';

    // Projdeme všechny viditelné doktory
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

  const getMonthlyStats = (user) => {
    const stats = {
      1: { weekday: 0, fridays: 0, weekend: 0, total: 0 },
      2: { weekday: 0, fridays: 0, weekend: 0, total: 0 },
      3: { weekday: 0, fridays: 0, weekend: 0, total: 0 }
    };

    days.forEach(date => {
      const key = `${date}_${user.uid}`;
      if (!assignments[key]) return;

      const d = new Date(date);
      const realMonth = d.getMonth() + 1;

      const mIndex = quarterMonths.indexOf(realMonth) + 1;
      if (mIndex === 0) return;

      const dow = d.getDay();

      if (dow === 5) stats[mIndex].fridays++;
      else if (dow === 6 || dow === 0) stats[mIndex].weekend++;
      else stats[mIndex].weekday++;

      stats[mIndex].total++;
    });

    return stats;
  };

  const getStatsForView = (user) => {
    const mStats = getMonthlyStats(user); // Předpokládáme, že máš tuto funkci z předchozího
    if (selectedMonth === 0) { // Celkem: součet všech měsíců
      return {
        weekday: mStats[1].weekday + mStats[2].weekday + mStats[3].weekday,
        fridays: mStats[1].fridays + mStats[2].fridays + mStats[3].fridays,
        weekend: mStats[1].weekend + mStats[2].weekend + mStats[3].weekend,
        total: mStats[1].total + mStats[2].total + mStats[3].total,
      };
    } else { // Konkrétní měsíc
      return mStats[selectedMonth];
    }
  };

  // ==================== WEEKEND SOLVER ====================
  const weekendBlocks = useMemo(() => {
    const blocks = [];
    let current = [];
    days.forEach(date => {
      const d = new Date(date);
      const dow = d.getDay();
      if (dow === 5 || dow === 6 || dow === 0) { // Fri/Sat/Sun
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
    if (!window.confirm('Spustit Auto Weekends?\n\nPřiřadí víkendy dle priorit: 24h buffer (striktní) -> max 1 směna za víkend -> střídání víkendů.')) return;

    let newAssignments = { ...assignments };
    let changes = 0;
    let problems = [];

    const groupMap = {
      staří: users['staří'] || [],
      střední: users['střední'] || [],
      mladí: users['mladí'] || []
    };

    // --- HELPER FUNCTIONS ---

    // 1. Hard Constraint: 24h Buffer (no shifts on Day n-1 or Day n+1)
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

    // 2. Soft Constraint: Already working in this specific Fri-Sat-Sun block?
    const workedInSameBlock = (user, dateStr, currentAssigns) => {
      const block = weekendBlocks.find(b => b.includes(dateStr));
      if (!block) return false;
      return block.some(d => d !== dateStr && currentAssigns[`${d}_${user.uid}`]);
    };

    // 3. Soft Constraint: Worked the previous or next weekend block?
    const hasAdjacentWeekendBlackout = (user, dateStr, currentAssigns) => {
      const bIdx = weekendBlocks.findIndex(b => b.includes(dateStr));
      if (bIdx === -1) return false;

      let blackout = false;
      if (bIdx > 0) {
        blackout = blackout || weekendBlocks[bIdx - 1].some(d => currentAssigns[`${d}_${user.uid}`]);
      }
      if (bIdx < weekendBlocks.length - 1) {
        // Technically only looks forward if we have pre-assignments, but good to have
        blackout = blackout || weekendBlocks[bIdx + 1].some(d => currentAssigns[`${d}_${user.uid}`]);
      }
      return blackout;
    };

    // 4. Base Availability: Respect user preferences
    const isAvailable = (user, dateStr) => {
      const fullStatus = userPreferences[user.uid]?.[dateStr];
      const effective = getEffectiveStatus(fullStatus);
      return effective !== 'blocked' && effective !== 'not available';
    };

    // Get all weekend dates
    const weekendDates = days.filter(d => {
      const dow = new Date(d).getDay();
      return dow === 5 || dow === 6 || dow === 0;
    });

    // --- MAIN LOOP ---
    for (const date of weekendDates) {
      // Find which groups are missing on this date
      const neededGroups = ['staří', 'střední', 'mladí'].filter(g => {
        return !Object.keys(newAssignments).some(k => k.startsWith(`${date}_`) && newAssignments[k] === g);
      });

      for (const group of neededGroups) {
        // Filter 1: Base availability and Hard Constraints (24h Buffer)
        let candidates = groupMap[group].filter(u => 
          isAvailable(u, date) && !hasAdjacentShift(u, date, newAssignments)
        );

        if (candidates.length === 0) {
          problems.push(`${date} (${group.charAt(0).toUpperCase()}): Nikdo nemá volno (24h pravidlo nebo blokace).`);
          continue;
        }

        // Filter 2: Apply Soft Constraints via Tiered Fallback
        // Tier A (Ideal): No shift this weekend block AND no shift adjacent weekend
        let viable = candidates.filter(u => 
          !workedInSameBlock(u, date, newAssignments) && 
          !hasAdjacentWeekendBlackout(u, date, newAssignments)
        );

        // Tier B (Relaxed): Allow adjacent weekend, but STRICTLY max 1 shift this block
        if (viable.length === 0) {
          viable = candidates.filter(u => !workedInSameBlock(u, date, newAssignments));
        }

        // Tier C (Desperate): Allow >1 shift this block (e.g. Fri + Sun), but STILL respects 24h buffer
        if (viable.length === 0) {
          viable = candidates; 
          problems.push(`Upozornění: ${date} (${group.charAt(0).toUpperCase()}) musel porušit max 1 směnu za víkend.`);
        }

        // Filter 3: Fairness (Balance total assigned shifts)
        viable.sort((a, b) => {
          // Count total shifts assigned to this doctor in the current dataset
          const countA = Object.keys(newAssignments).filter(k => k.endsWith(`_${a.uid}`)).length;
          const countB = Object.keys(newAssignments).filter(k => k.endsWith(`_${b.uid}`)).length;
          return countA - countB;
        });

        // Assign the best candidate
        const chosen = viable[0];
        const key = `${date}_${chosen.uid}`;
        newAssignments[key] = group;
        changes++;
        
        // Optional console log to trace assignment tiers
        // console.log(`${date}: Assigned ${chosen.shortcut} to ${group}`);
      }
    }

    setAssignments(newAssignments);

    if (problems.length > 0) {
      window.notify?.(`Hotovo! Přiřazeno ${changes} služeb.\nProblémy/Ústupky:\n${problems.join('\n')}`, 'warning');
    } else {
      window.notify?.(`Hotovo! Přiřazeno ${changes} víkendových služeb bez porušení pravidel.`, 'success');
    }
  }, [assignments, days, users, userPreferences, weekendBlocks, getEffectiveStatus]);

  const exportToBIT = () => {
    let tsv = '';

    days.forEach(date => {
      const sDoc = visibleUsers.find(u => assignments[`${date}_${u.uid}`] === 'staří')?.shortcut || '';
      const mDoc = visibleUsers.find(u => assignments[`${date}_${u.uid}`] === 'střední')?.shortcut || '';
      const jDoc = visibleUsers.find(u => assignments[`${date}_${u.uid}`] === 'mladí')?.shortcut || '';
      tsv += `${sDoc}\t${mDoc}\t${jDoc}\n`;
    });

    const blob = new Blob([tsv], { type: 'text/tab-separated-values' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bit_Q${targetQuarter}_${targetYear}.tsv`;
    a.click();
  };

  // ==================== UPDATED handleContextMenu (composite) ====================
const handleContextMenu = useCallback(async (date, user) => {
    const currentStatus = userPreferences[user.uid]?.[date] || null;
    const baseStatus = getBaseStatus(currentStatus);
    const effective = getEffectiveStatus(currentStatus);

    let newStatus = null;
    let notifyMsg = '';
    let notifyType = 'info';

    if (effective === 'blocked') {
      // Blocked → Unblocked (preserve original demand)
      newStatus = (baseStatus === 'preferred' || baseStatus === 'not available')
        ? `${baseStatus}_unblocked`
        : 'unblocked';
      notifyMsg = `✅ Unblocked: ${user.shortcut} – ${date}`;
      notifyType = 'success';
    } else if (effective === 'unblocked') {
      // Unblocked → Restore original demand (or clear)
      newStatus = (baseStatus === 'preferred' || baseStatus === 'not available')
        ? baseStatus
        : null;
      notifyMsg = newStatus
        ? `Original demand restored (${newStatus}): ${user.shortcut} – ${date}`
        : `Unblock removed: ${user.shortcut} – ${date}`;
      notifyType = newStatus ? 'success' : 'info';
    } else {
      // Normal/preference day → Block WHILE preserving original demand
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
  }, [userPreferences, getBaseStatus, getEffectiveStatus]);

  // ==================== RENDER ====================
  return (
    <div className="flex flex-col h-full bg-gray-50">
      <div className="flex flex-1 overflow-auto gap-6 p-6">
        {/* TABULKA */}
        <div className="flex-1 overflow-auto bg-white rounded-2xl shadow-xl">
          <table className="w-full table-fixed border-collapse text-sm">
            <thead className="sticky top-0 bg-blue-700 text-white z-20">
              <tr>
                  <th className="text-left pl-3 py- py-0 h-6 w-20 sticky left-0 bg-blue-700 z-30 text-xs font-semibold text-white">Datum</th>
                  {visibleUsers.map(u => (
                  <th key={u.uid} className="py-0 h-6 text-xs font-semibold">{u.shortcut}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {days.map(date => {
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
                  count.S === 1 &&
                  count.M === 1 &&
                  count.J === 1;

                const error =
                  count.S > 1 ||
                  count.M > 1 ||
                  count.J > 1;

                const warning =
                  !error &&
                  !perfect &&
                  allAssignmentsForDate.length > 0;

                let bgClass = "bg-white text-gray-800";

                // víkend
                if (isWeekendOrHoliday(date)) {
                  bgClass = "bg-blue-100 text-gray-800";
                }

                // error
                if (error) {
                  bgClass = "bg-red-500 text-white font-bold";
                }

                // warning
                else if (warning) {
                  bgClass = "bg-amber-500 text-white font-bold";
                }

                // perfect
                else if (perfect) {
                  bgClass = "bg-green-500 text-white font-bold";
                }

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
                        const key = `${date}_${u.uid}`;
                        const assignedGroup = assignments[key];
                        const fullStatus = userPreferences[u.uid]?.[date];
                        const effective = getEffectiveStatus(fullStatus);

                        let displayContent = '';
                        if (assignedGroup) {
                          displayContent = getDisplayLabel(assignedGroup);
                        } else if (effective === 'unblocked') {
                          displayContent = 'U';
                        } else if (effective === 'blocked') {
                          displayContent = 'BLOCK';
                        }

                        return (
                          <td
                            key={u.uid}
                            onClick={() => handleCellClick(date, u)}
                            onContextMenu={(e) => { e.preventDefault(); handleContextMenu(date, u); }}
                            className={cn(
                              "px-0.5 py-0 text-center cursor-pointer select-none font-bold text-[10px] leading-3 border border-gray-300 transition-all h-6",
                              cellInfo.className
                            )}
                          >
                            {displayContent && (
                              <>
                                {displayContent}
                                {cellInfo.hasIntervalViolation && u.shiftInterval && (
                                  <span className="text-[8px] align-super opacity-80 ml-0.5">({u.shiftInterval})</span>
                                )}
                              </>
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

        {/* PRAVÝ PANEL – kompaktní, přehledný, vše na očích */}
        <div className="flex-shrink-0 w-full lg:w-auto lg:min-w-[380px] bg-white rounded-2xl shadow-xl p-6 overflow-y-auto border border-gray-200">
          {/* === Tlačítka skupin – na jeden řádek, malá, elegantní === */}
          <div className="mb-6">
            <h3 className="text-sm font-semibold text-gray-600 mb-3">Skupiny lékařů</h3>
            <div className="flex flex-wrap gap-3 gap-2">
              {groupOrder.map(group => {
                const count = users[group]?.length || 0;
                const isCollapsed = collapsed[group];
                return (
                  <button
                    key={group}
                    onClick={() => toggleGroup(group)}
                    className={cn(
                      "px-4 py-1.5 rounded-lg text-sm font-medium transition-all",
                      isCollapsed
                        ? "bg-gray-200 text-gray-600 hover:bg-gray-300"
                        : "bg-blue-600 text-white hover:bg-blue-700 shadow-sm"
                    )}
                  >
                    {group.charAt(0).toUpperCase() + group.slice(1)} ({count})
                  </button>
                );
              })}
            </div>
          </div>

          {/* === Navigace kvartálu === */}
          <div className="flex items-center gap-3 mb-8">
            <button
              onClick={handlePrev}
              className="px-5 py-2 bg-gray-100 rounded-lg hover:bg-gray-200 font-medium transition"
            >
              ← Pre
            </button>
            <div className="flex-1 text-center">
              <div className="text-xl font-bold text-blue-700">
                Q{targetQuarter} {targetYear}
              </div>
            </div>
            <button
              onClick={handleNext}
              className="px-5 py-2 bg-gray-100 rounded-lg hover:bg-gray-200 font-medium transition"
            >
              Nx →
            </button>
          </div>

          {/* === STATISTIKY – vrácené a vylepšené! === */}
          <div className="space-y-6">
            <h3 className="text-lg font-semibold text-gray-800">Statistiky služeb</h3>
            
            {/* Nová tlačítka pro měsíce – čitelná jména */}
            <div className="flex flex-wrap gap-2 mb-4">
              <button
                onClick={() => setSelectedMonth(0)}
                className={cn(
                  "px-3 py-1.5 rounded-lg text-sm font-medium transition-all",
                  selectedMonth === 0 ? "bg-blue-600 text-white hover:bg-blue-700" : "bg-gray-200 text-gray-600 hover:bg-gray-300"
                )}
              >
                Q{targetQuarter} (celkem)
              </button>
              {[1, 2, 3].map(m => {
                const realMonthNum = qStartMonth + m; // 4,5,6 pro Q2 atd.
                const monthName = ['','Leden','Únor','Březen','Duben','Květen','Červen',
                                  'Červenec','Srpen','Září','Říjen','Listopad','Prosinec'][realMonthNum];
                return (
                  <button
                    key={m}
                    onClick={() => setSelectedMonth(m)}
                    className={cn(
                      "px-3 py-1.5 rounded-lg text-sm font-medium transition-all",
                      selectedMonth === m ? "bg-blue-600 text-white hover:bg-blue-700" : "bg-gray-200 text-gray-600 hover:bg-gray-300"
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
                        <td className="py-1.5 font-medium text-gray-600">Po–Čt</td>
                        {groupVisibleUsers.map(u => (
                          <td key={u.uid} className="text-center py-1.5">
                            {getStatsForView(u).weekday}
                          </td>
                        ))}
                      </tr>
                      <tr>
                        <td className="py-1.5 font-medium text-gray-600">Pátek</td>
                        {groupVisibleUsers.map(u => (
                          <td key={u.uid} className="text-center py-1.5 text-sky-600 font-medium">
                            {getStatsForView(u).fridays}
                          </td>
                        ))}
                      </tr>
                      <tr>
                        <td className="py-1.5 font-medium text-gray-600">Víkend</td>
                        {groupVisibleUsers.map(u => (
                          <td key={u.uid} className="text-center py-1.5 text-orange-600 font-medium">
                            {getStatsForView(u).weekend}
                          </td>
                        ))}
                      </tr>
                      <tr className="font-bold bg-blue-50">
                        <td className="py-2 text-gray-800">Celkem</td>
                        {groupVisibleUsers.map(u => (
                          <td key={u.uid} className="text-center py-2 text-gray-900 font-bold">
                            {getStatsForView(u).total}
                          </td>
                        ))}
                      </tr>
                    </tbody>
                  </table>
                </div>
              );
            })}
          </div>

          {/* === Exporty – teď tři tlačítka na jednom řádku === */}
          <div className="flex gap-3 mt-8">
            {/* Auto Weekends solver */}
              <button
                onClick={autoAssignWeekends}
                className="flex-1 py-3 bg-orange-600 text-white rounded-lg font-semibold hover:bg-orange-700 transition shadow-md text-sm"
              >
                Auto Weekends
              </button>
            {/* 1. Export požadavků lékařů */}
            <button
              onClick={() => exportPreferencesToTSV()}
              className="flex-1 py-3 bg-purple-600 text-white rounded-lg font-semibold hover:bg-purple-700 transition shadow-md text-sm"
            >
              Exp Pož
            </button>

            {/* 2. Export aktuálního řešení */}
            <button
              onClick={exportToTSV}
              className="flex-1 py-3 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700 transition shadow-md text-sm"
            >
              Exp Sol
            </button>

            {/* 3. Nový: Export BIT – jen zkratky S \t M \t J pro každý den */}
            <button
              onClick={() => exportToBIT()}
              className="flex-1 py-3 bg-indigo-600 text-white rounded-lg font-semibold hover:bg-indigo-700 transition shadow-md text-sm"
            >
              Exp BIT
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
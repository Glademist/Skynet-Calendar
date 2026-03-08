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

  // groupLabel je konstanta → useMemo, aby useCallback nebyl závislý na novém objektu
  const groupLabel = useMemo(() => ({ staří: 'S', střední: 'M', mladí: 'J' }), []);

  const today = new Date();
  const currentQuarter = Math.floor(today.getMonth() / 3) + 1;
  const targetQuarter = ((currentQuarter + currentQOffset - 1) % 4) + 1;
  const targetYear = currentQuarter + currentQOffset > 4 ? today.getFullYear() + 1 : today.getFullYear();
  const qStartMonth = (targetQuarter - 1) * 3;

  // ==================== NAČTENÍ DAT ====================
  useEffect(() => {
    const fetchData = async () => {
      // uživatelé
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

      // preference
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

      // dny kvartálu
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

      // assignments
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

  // tlačítka Pre / Nex – teď už se používají
  const handlePrev = () => setCurrentQOffset(o => o - 1);
  const handleNext = () => setCurrentQOffset(o => o + 1);

  const toggleGroup = useCallback((group) => {
    setCollapsed(prev => ({ ...prev, [group]: !prev[group] }));
  }, []);

  const handleCellClick = useCallback((date, user) => {
    const key = `${date}_${user.uid}`;
    const current = assignments[key];
    const userGroups = user.groups || [];
    const cycle = ['staří', 'střední', 'mladí'];

    let next = null;
    if (!current) next = userGroups.find(g => cycle.includes(g));
    else {
      const idx = cycle.indexOf(current);
      next = cycle.slice(idx + 1).find(g => userGroups.includes(g));
    }

    setAssignments(prev => {
      if (next) {
        window.notify?.(`${user.shortcut} → ${groupLabel[next]}`, 'success');
        return { ...prev, [key]: next };
      }
      window.notify?.(`${user.shortcut} odebrán`, 'info');
      const { [key]: _, ...rest } = prev;
      return rest;
    });
  }, [assignments, groupLabel]);

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
    const pref = userPreferences[user.uid]?.[date];

    // Preference mají absolutní prioritu
    if (pref === 'not available') return { className: 'bg-gray-500 text-white line-through cursor-not-allowed', hasIntervalViolation: false };
    if (pref === 'preferred') return { className: 'bg-green-600 text-white font-bold', hasIntervalViolation: false };
    if (pref === 'blocked') return {className: 'bg-gray-800 text-gray-200 line-through cursor-not-allowed select-none',hasIntervalViolation: false};
  
    const d = new Date(date);
    const dayOfWeek = d.getDay();
    const isWeekendDay = dayOfWeek === 5 || dayOfWeek === 6 || dayOfWeek === 0;

    // Všední dny – modré
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

    // === Interval check (používáme správně shiftInterval z nastavení) ===
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

    // === Finální priorita barev ===
    if (hasWeekendConflict) {
      return {
        className: assigned ? 'bg-red-600 text-white font-black' : 'bg-red-100',
        hasIntervalViolation: false
      };
    }

    if (hasIntervalViolation) {
      return {
        className: assigned ? 'bg-purple-600 text-white font-bold' : 'bg-purple-100',
        hasIntervalViolation: true   // ← důležité pro zobrazení (7)
      };
    }

    if (nearbyShifts.length > 0) {
      return {
        className: assigned ? 'bg-orange-600 text-white font-bold' : 'bg-orange-100',
        hasIntervalViolation: false
      };
    }

    const isFriday = dayOfWeek === 5;
    return {
      className: assigned
        ? (isFriday ? 'bg-blue-500 text-white' : 'bg-blue-600 text-white')
        : (isFriday ? 'bg-blue-100' : 'bg-blue-100'),
      hasIntervalViolation: false
    };
  }, [assignments, userPreferences, days]);

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
    const stats = { 1: { weekday: 0, fridays: 0, weekend: 0, total: 0 },
                    2: { weekday: 0, fridays: 0, weekend: 0, total: 0 },
                    3: { weekday: 0, fridays: 0, weekend: 0, total: 0 } };

    days.forEach(date => {
      const key = `${date}_${user.uid}`;
      if (assignments[key]) {
        const d = new Date(date);
        const month = d.getMonth() + 1; // 1=leden, 2=únor, 3=březen (pro Q1 2026)
        
        if (!quarterMonths.includes(month)) return;

        const dow = d.getDay();
        if (dow === 5) stats[month].fridays++;
        else if (dow === 6 || dow === 0) stats[month].weekend++;
        else stats[month].weekday++;
        stats[month].total++;
      }
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

  const handleContextMenu = useCallback(async (date, user) => {
    const currentPref = userPreferences[user.uid]?.[date];

    if (currentPref === 'blocked') {
      if (!window.confirm(`Odebrat blokaci pro ${user.shortcut} na ${date}?`)) return;

      // remove 'blocked'
      const ref = doc(db, 'dayStyles', user.uid);
      const snap = await getDoc(ref);
      if (!snap.exists()) return;

      const styles = (snap.data().styles || []).filter(s => !(s.date === date && s.status === 'blocked'));

      await setDoc(ref, { styles }, { merge: true });
      window.notify?.(`Blokace odebrána: ${user.shortcut} – ${date}`, 'success');
    } else {
      if (!window.confirm(`Blokovat ${user.shortcut} na ${date}? (nebude mu přiřazena služba)`)) return;

      const ref = doc(db, 'dayStyles', user.uid);
      const snap = await getDoc(ref);
      let styles = snap.exists() ? snap.data().styles || [] : [];

      // remove any old entry for this date
      styles = styles.filter(s => s.date !== date);

      // add blocked
      styles.push({ date, status: 'blocked' });

      await setDoc(ref, { styles }, { merge: true });
      window.notify?.(`Zablokováno: ${user.shortcut} – ${date}`, 'info');
    }

    // Force refresh of preferences (simplest way)
    setUserPreferences(prev => {
      const newPrefs = { ...prev };
      if (!newPrefs[user.uid]) newPrefs[user.uid] = {};
      if (currentPref === 'blocked') {
        delete newPrefs[user.uid][date];
      } else {
        newPrefs[user.uid][date] = 'blocked';
      }
      return newPrefs;
    });
  }, [userPreferences]);

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
                /* const dayAssignments = visibleUsers
                    .map(u => assignments[`${date}_${u.uid}`])
                    .filter(Boolean); */
                const allAssignmentsForDate = Object.keys(assignments)
                    .filter(k => k.startsWith(date + "_"))
                    .map(k => assignments[k]);
                /*const totalAssignmentsForDate = Object.keys(assignments)
                    .filter(k => k.startsWith(date + "_"))
                    .length;*/

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
                        return (
                          <td
                            key={u.uid}
                            onClick={() => handleCellClick(date, u)}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              handleContextMenu(date, u);
                            }}
                            className={cn(
                              "px-0.5 py-0 text-center cursor-pointer select-none font-bold text-[10px] leading-3 border border-gray-300 transition-all h-6",
                              cellInfo.className
                            )}
                          >
                            {assignedGroup ? (
                              <>
                                {groupLabel[assignedGroup]}
                                {cellInfo.hasIntervalViolation && u.shiftInterval && (
                                  <span className="text-[8px] align-super opacity-80 ml-0.5">
                                    ({u.shiftInterval})
                                  </span>
                                )}
                              </>
                            ) : pref === 'blocked' ? (
                              <span className="text-[9px] opacity-90">BLOCK</span>
                            ) : ''}
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
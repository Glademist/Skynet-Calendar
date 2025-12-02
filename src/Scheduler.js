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

    const getStats = (user) => {
        let weekday = 0, fridays = 0, weekend = 0;
        days.forEach(date => {
            const key = `${date}_${user.uid}`;
            if (assignments[key]) {
            const d = new Date(date);
            const dow = d.getDay();
            if (dow === 5) fridays++;
            else if (dow === 6 || dow === 0) weekend++;
            else weekday++;
            }
        });
        return { weekday, fridays, weekend, total: weekday + fridays + weekend };
    };

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

        // 1. Preference lékaře – absolutní priorita
        if (pref === 'not available') return 'bg-gray-400 text-gray-700 line-through cursor-not-allowed';
        if (pref === 'preferred') return 'bg-emerald-600 text-white font-bold';

        const d = new Date(date);
        const dayOfWeek = d.getDay(); // 5 = Pátek, 6 = Sobota, 0 = Neděle
        const isFriday = dayOfWeek === 5;
        const isWeekendDay = dayOfWeek === 5 || dayOfWeek === 6 || dayOfWeek === 0;

        // Pokud to není víkendový den → normální barva
        if (!isWeekendDay) {
            return assigned ? 'bg-blue-600 text-white' : 'hover:bg-gray-100';
        }

        // Najdeme pátek aktuálního víkendu
        const currentFriday = new Date(d);
        if (dayOfWeek === 5) currentFriday.setDate(currentFriday.getDate());
        else if (dayOfWeek === 6) currentFriday.setDate(currentFriday.getDate() - 1);
        else currentFriday.setDate(currentFriday.getDate() - 2);

        // Prohledáme jen ±1 týden (předchozí a následující víkend)
        const nearbyDates = [];
        for (let week of [-7, 0, 7]) {
            for (let i = 0; i < 3; i++) {
            const dt = new Date(currentFriday);
            dt.setDate(dt.getDate() + week + i);
            nearbyDates.push(dt.toLocaleDateString('en-CA'));
            }
        }

        // Kolik víkendových služeb má tento lékař v ±1 týdnu?
        const nearbyShifts = nearbyDates.filter(dt => assignments[`${dt}_${user.uid}`]);

        const hasConflict = nearbyShifts.length > 1;

        // Je aktuální den v okolí nějaké služby? (pro světlé pozadí)
        const isNearShift = nearbyShifts.some(shiftDate => {
            const diff = Math.abs((new Date(shiftDate) - d) / (1000 * 60 * 60 * 24));
            return diff <= 9; // max 9 dní = sousední víkend
        });

        // FINÁLNÍ BARVY – přesně podle tvé vize:

        if (hasConflict) {
            // Má dvě služby v sousedních víkendech → červená chyba
            if (assigned) {
            return 'bg-red-600 text-white font-black';
            }
            if (isNearShift) {
            return 'bg-red-100';
            }
        }

        // Žádný konflikt, ale má víkend v okolí → oranžová
        if (nearbyShifts.length > 0) {
            if (assigned) {
            return 'bg-orange-600 text-white font-bold';
            }
            if (isNearShift) {
            return 'bg-orange-100';
            }
        }

        // Žádný konflikt, žádná služba v okolí → normální víkendové barvy
        if (isFriday) {
            return assigned ? 'bg-sky-500 text-white' : 'bg-sky-50';  // světlejší modrá pro pátky
        } else {
            return assigned ? 'bg-sky-600 text-white' : 'bg-sky-100'; // tmavší pro So + Ne
        }
    }, [assignments, userPreferences]);

  // ==================== RENDER ====================
  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <div className="flex flex-1 overflow-hidden gap-6 p-6">
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
                const dayAssignments = visibleUsers
                    .map(u => assignments[`${date}_${u.uid}`])
                    .filter(Boolean);

                const count = { S: 0, M: 0, J: 0 };
                dayAssignments.forEach(g => {                    // ← opraveno z "day" na "dayAssignments"
                    if (g === 'staří') count.S++;
                    if (g === 'střední') count.M++;
                    if (g === 'mladí') count.J++;
                });

                const perfect = count.S === 1 && count.M === 1 && count.J === 1;
                const error = count.S > 1 || count.M > 1 || count.J > 1;
                const warning = dayAssignments.length > 0 && dayAssignments.length < 3; // ← opraveno

                return (
                  <tr key={date} className="hover:bg-gray-50">
                  <td className={cn(
                      "sticky left-0 z-10 text-left pl-2 pr-3 py-0 font-medium text-[11px] leading-3 bg-gray-100 border-r-4 border-gray-300 whitespace-nowrap",
                      "h-6", // ← stejná výška jako ostatní buňky
                      isWeekendOrHoliday(date) && "bg-sky-50",
                      perfect && "bg-green-500 text-white font-bold",
                      error && "bg-red-500 text-white font-bold",
                      warning && "bg-amber-500 text-white font-bold"
                    )}>
                      {date.slice(8, 10) + '.' + date.slice(5, 7) + '.'}
                    </td>

                    {visibleUsers.map(u => {
                        const key = `${date}_${u.uid}`;
                        return (
                          <td
                            key={u.uid}
                            onClick={() => handleCellClick(date, u)}
                            className={cn(
                              "px-0.5 py-0 text-center cursor-pointer select-none font-bold text-[10px] leading-3 border border-gray-300 transition-all",
                              "h-6", // ← přesně 24 px celkem (6×4px Tailwind jednotka)
                              getCellClasses(date, u)
                            )}
                          >
                            {assignments[key] ? groupLabel[assignments[key]] : ''}
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
        <div className="w-96 max-w-full bg-white rounded-2xl shadow-xl p-6 overflow-y-auto">
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
                      {/* === STATISTIKY – podle aktuálního pořadí v tabulce (visibleUsers) === */}
                        {/* === STATISTIKY – rozdělené podle skupin, ale seřazené jako vlevo === */}
            <div className="space-y-6">
              <h3 className="text-lg font-semibold text-gray-800">Statistiky služeb</h3>

              {groupOrder.map(group => {
                // Vezeme jen lékaře z této skupiny, kteří jsou aktuálně vidět
                const groupVisibleUsers = visibleUsers.filter(u => u.groups?.includes(group));

                // Pokud je skupina schovaná nebo prázdná → nic nezobrazujeme
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
                              {getStats(u).weekday}
                            </td>
                          ))}
                        </tr>
                        <tr>
                          <td className="py-1.5 font-medium text-gray-600">Pátek</td>
                          {groupVisibleUsers.map(u => (
                            <td key={u.uid} className="text-center py-1.5 text-sky-600 font-medium">
                              {getStats(u).fridays}
                            </td>
                          ))}
                        </tr>
                        <tr>
                          <td className="py-1.5 font-medium text-gray-600">Víkend</td>
                          {groupVisibleUsers.map(u => (
                            <td key={u.uid} className="text-center py-1.5 text-orange-600 font-medium">
                              {getStats(u).weekend}
                            </td>
                          ))}
                        </tr>
                        <tr className="font-bold bg-blue-50">
                          <td className="py-2 text-gray-800">Celkem</td>
                          {groupVisibleUsers.map(u => (
                            <td key={u.uid} className="text-center py-2 text-gray-900 font-bold">
                              {getStats(u).total}
                            </td>
                          ))}
                        </tr>
                      </tbody>
                    </table>
                  </div>
                );
              })}
            </div>

          {/* === Export === */}
          <button
            onClick={exportToTSV}
            className="w-full mt-8 py-3 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700 transition shadow-md"
          >
            Exportovat do TSV
          </button>
        </div>
      </div>
    </div>
  );
}
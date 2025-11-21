// src/Scheduler.js
import React, { useState, useEffect, useMemo } from 'react';
import { db } from './firebase';
import { collection, getDocs, doc, getDoc, setDoc } from 'firebase/firestore';
import { generateHolidays } from './utils';

// ← NOVÉ: Pořadí lékařů
const doctorOrder = [
  'Hro', 'Hv', 'ValM', 'Bee', 'Chre', 'Šk', 'Šd', 'Bia', 'Ble', 'Har',
  'Koc', 'Brz', 'Dvo', 'Sib', 'Sal', 'Žd', 'ValJ', 'MarB', 'Pli',
  'Mud', 'Kul', 'Hru', 'Pro', 'Kep', 'Švr', 'Mrk'
];

export default function Scheduler() {
  const [currentQOffset, setCurrentQOffset] = useState(1);
  const [users, setUsers] = useState({});
  const [collapsed, setCollapsed] = useState({});
  const [assignments, setAssignments] = useState({});
  const [days, setDays] = useState([]);
  const [userPreferences, setUserPreferences] = useState({});

  const groupOrder = useMemo(() => ['staří', 'střední', 'mladí'], []);
  const groupLabel = { 'staří': 'S', 'střední': 'M', 'mladí': 'J' };

  const today = new Date();
  const currentQuarter = Math.floor(today.getMonth() / 3) + 1;
  const targetQuarter = ((currentQuarter + currentQOffset - 1) % 4) + 1;
  const targetYear = currentQuarter + currentQOffset > 4 ? today.getFullYear() + 1 : today.getFullYear();
  const qStartMonth = (targetQuarter - 1) * 3;

  // Načítání uživatelů + assignments + preference všech
  useEffect(() => {
    const fetchData = async () => {
      // Uživatelé
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

      // Preference všech uživatelů
      const prefs = {};
      for (const group of Object.values(sortedGroups)) {
        for (const u of group) {
          const prefRef = doc(db, 'dayStyles', u.uid);
          const prefSnap = await getDoc(prefRef);
          if (prefSnap.exists()) {
            const styles = prefSnap.data().styles || [];
            prefs[u.uid] = Object.fromEntries(styles.map(s => [s.date, s.status]));
          } else {
            prefs[u.uid] = {};
          }
        }
      }
      setUserPreferences(prefs);

      // Dny kvartálu
      const qDays = [];
      const qStart = new Date(targetYear, qStartMonth, 1);
      const prevFriday = new Date(qStart);
      const dayOfWeek = qStart.getDay();
      const daysToFriday = dayOfWeek === 0 ? 2 : (dayOfWeek + 2) % 7;
      prevFriday.setDate(prevFriday.getDate() - daysToFriday);

      for (let d = new Date(prevFriday); d < qStart; d.setDate(d.getDate() + 1)) {
        qDays.push(d.toLocaleDateString('en-CA'));
      }
      for (let m = qStartMonth; m < qStartMonth + 3; m++) {
        const lastDay = new Date(targetYear, m + 1, 0).getDate();
        for (let i = 1; i <= lastDay; i++) {
          qDays.push(new Date(targetYear, m, i).toLocaleDateString('en-CA'));
        }
      }
      setDays(qDays);

      // Assignments
      const assignRef = doc(db, 'assignments', `${targetYear}_Q${targetQuarter}`);
      const assignSnap = await getDoc(assignRef);
      if (assignSnap.exists()) {
        setAssignments(assignSnap.data());
      } else {
        setAssignments({});
      }
    };

    fetchData();
  }, [currentQOffset, groupOrder, qStartMonth, targetQuarter, targetYear]); // eslint-disable-next-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (Object.keys(assignments).length === 0) return;
    const assignRef = doc(db, 'assignments', `${targetYear}_Q${targetQuarter}`);
    setDoc(assignRef, assignments);
  }, [assignments, targetQuarter, targetYear]);

  const toggleGroup = (group) => setCollapsed(prev => ({ ...prev, [group]: !prev[group] }));

  const handleCellClick = (date, user) => {
    const key = `${date}_${user.uid}`;
    setAssignments(prev => {
      if (prev[key]) {
        const { [key]: _, ...rest } = prev;
        window.notify(`${user.shortcut} odebráno`, 'info');
        return rest;
      } else {
        window.notify(`${user.shortcut} přiřazeno`, 'success');
        return { ...prev, [key]: user.groups[0] };
      }
    });
  };

  const isWeekendOrHoliday = (date) => {
    const d = new Date(date);
    return d.getDay() === 0 || d.getDay() === 6 || generateHolidays().some(h => h.date === date);
  };

  const getCellClass = (date, user) => {
    const pref = userPreferences[user.uid]?.[date];
    if (pref === 'not available') return 'pref-not-available';
    if (pref === 'preferred') return 'pref-preferred';
    return '';
  };

  // ← NOVÉ: Unikátní seznam viditelných uživatelů (bez duplicit + správné pořadí)
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

    // Seřadíme podle doctorOrder
    list.sort((a, b) => {
      const aPos = doctorOrder.indexOf(a.shortcut);
      const bPos = doctorOrder.indexOf(b.shortcut);
      if (aPos === -1 && bPos === -1) return a.shortcut.localeCompare(b.shortcut);
      if (aPos === -1) return 1;
      if (bPos === -1) return -1;
      return aPos - bPos;
    });

    return list;
}, [users, collapsed, groupOrder]);

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

  const getStats = (user) => ({ weekday: 0, fridays: 0, weekend: 0, holiday: 0, total: 0, totalFridays: 0, avgFridays: 0 });

  return (
    <div className="scheduler-layout">
      <div className="left-column">
        <table className="schedule-table">
          <thead className="fixed-header">
            <tr>
              <th>Datum</th>
              {visibleUsers.map(u => (
                <th key={u.uid}>{u.shortcut}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {days.map(date => (
              <tr key={date} className={isWeekendOrHoliday(date) ? 'special-day' : ''}>
                <td>{date}</td>
                {visibleUsers.map(u => (
                  <td
                    key={u.uid}
                    className={getCellClass(date, u)}
                    onClick={() => handleCellClick(date, u)}
                  >
                    {assignments[`${date}_${u.uid}`]
                      ? groupLabel[assignments[`${date}_${u.uid}`]]
                      : ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="right-column">
        <div className="group-buttons">
          {groupOrder.map(group => (
            <button
              key={group}
              className={`group-btn ${!collapsed[group] ? 'active' : ''}`}
              onClick={() => toggleGroup(group)}
            >
              {group.charAt(0).toUpperCase() + group.slice(1)} ({users[group]?.length || 0})
            </button>
          ))}
        </div>

        <div className="q-nav">
          <button onClick={() => setCurrentQOffset(prev => prev - 1)}>Předchozí Q</button>
          <span>Q{targetQuarter} {targetYear}</span>
          <button onClick={() => setCurrentQOffset(prev => prev + 1)}>Následující Q</button>
          <button onClick={exportToTSV}>Export TSV</button>
        </div>

        <h3>Statistiky</h3>
        {groupOrder.map(group => (
          users[group] && !collapsed[group] && (
            <div key={group} className="stats-table-block">
              <table className="stats-compact-table">
                <thead>
                  <tr>
                    <th></th>
                    {users[group].map(u => (
                      <th key={u.uid}>{u.shortcut}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr><td className="row-label">V</td>{users[group].map(u => <td key={u.uid}>{getStats(u).weekday}</td>)}</tr>
                  <tr><td className="row-label">P</td>{users[group].map(u => <td key={u.uid}>{getStats(u).fridays}</td>)}</tr>
                  <tr><td className="row-label">W</td>{users[group].map(u => <td key={u.uid}>{getStats(u).weekend}</td>)}</tr>
                  <tr><td className="row-label">S</td>{users[group].map(u => <td key={u.uid}>{getStats(u).holiday}</td>)}</tr>
                  <tr><td className="row-label">C</td>{users[group].map(u => <td key={u.uid}>{getStats(u).total}</td>)}</tr>
                  <tr><td className="row-label">PC</td>{users[group].map(u => <td key={u.uid}>{getStats(u).totalFridays}</td>)}</tr>
                  <tr><td className="row-label">PA</td>{users[group].map(u => <td key={u.uid}>{getStats(u).avgFridays}</td>)}</tr>
                </tbody>
              </table>
            </div>
          )
        ))}
      </div>
    </div>
  );
}
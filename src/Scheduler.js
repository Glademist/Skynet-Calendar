import React, { useState, useEffect, useMemo } from 'react';
import { db } from './firebase';
import { collection, getDocs, doc, getDoc, setDoc } from 'firebase/firestore';
import { generateHolidays } from './utils';

export default function Scheduler() {
  const [currentQOffset, setCurrentQOffset] = useState(1);
  const [users, setUsers] = useState({});
  const [collapsed, setCollapsed] = useState({});
  const [assignments, setAssignments] = useState({});
  const [days, setDays] = useState([]);

  const groupOrder = useMemo(() => ['staří', 'střední', 'mladí'], []);
  const groupLabel = { 'staří': 'S', 'střední': 'M', 'mladí': 'J' };

  const today = new Date();
  const currentQuarter = Math.floor(today.getMonth() / 3) + 1;
  const targetQuarter = ((currentQuarter + currentQOffset - 1) % 4) + 1;
  const targetYear = currentQuarter + currentQOffset > 4 ? today.getFullYear() + 1 : today.getFullYear();
  const qStartMonth = (targetQuarter - 1) * 3;

  // Načítání uživatelů + assignments
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

  // Ukládání assignments
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
    const pref = user.dayStyles?.find(p => p.date === date)?.status || 'available';
    return pref === 'not available' ? 'not-available' : pref === 'preferred' ? 'preferred' : '';
  };

  // === STATISTIKY PRO JEDNOTLIVÉ UŽIVATELE ===
  const getStats = (user) => {
    let weekday = 0;
    let fridays = 0;
    let weekend = 0;
    let holiday = 0;

    days.forEach(date => {
      const key = `${date}_${user.uid}`;
      if (assignments[key]) {
        const d = new Date(date);
        const dayOfWeek = d.getDay();
        const isFriday = dayOfWeek === 5;
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
        const isHoliday = generateHolidays().some(h => h.date === date);

        if (isFriday) fridays++;
        if (isWeekend) weekend++;
        if (isHoliday) holiday++;
        if (!isWeekend && !isHoliday) weekday++;
      }
    });

    const total = weekday + fridays + weekend + holiday;
    const totalFridays = fridays;
    const avgFridays = days.filter(d => new Date(d).getDay() === 5).length > 0
      ? (fridays / days.filter(d => new Date(d).getDay() === 5).length * 100).toFixed(1)
      : '0';

    return { weekday, fridays, weekend, holiday, total, totalFridays, avgFridays };
  };

  // Export TSV – zpět!
  const exportToTSV = () => {
    let tsv = 'Datum\t';
    groupOrder.forEach(g => {
      users[g]?.forEach(u => { tsv += `${u.shortcut}\t`; });
    });
    tsv = tsv.trim() + '\n';

    days.forEach(date => {
      tsv += date + '\t';
      groupOrder.forEach(g => {
        users[g]?.forEach(u => {
          const key = `${date}_${u.uid}`;
          tsv += (assignments[key] ? groupLabel[assignments[key]] : '') + '\t';
        });
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

  return (
    <div className="scheduler-layout">
      <div className="left-column">
        <table className="schedule-table">
          <thead className="fixed-header">
            <tr>
              <th>Datum</th>
              {groupOrder.map(group => (
                users[group] && !collapsed[group] && users[group].map(u => (
                  <th key={u.uid}>{u.shortcut}</th>
                ))
              ))}
            </tr>
          </thead>
          <tbody>
            {days.map(date => (
              <tr key={date} className={isWeekendOrHoliday(date) ? 'special-day' : ''}>
                <td>{date}</td>
                {groupOrder.map(group => (
                  users[group] && !collapsed[group] && users[group].map(u => (
                    <td
                      key={u.uid}
                      className={getCellClass(date, u)}
                      onClick={() => handleCellClick(date, u)}
                    >
                      {assignments[`${date}_${u.uid}`] ? groupLabel[assignments[`${date}_${u.uid}`]] : ''}
                    </td>
                  ))
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
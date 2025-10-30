// src/Scheduler.js
import React, { useState, useEffect } from 'react';
import { generateHolidays } from './utils';

export default function Scheduler() {
  const [currentQOffset, setCurrentQOffset] = useState(1); // ← Příští Q
  const [users, setUsers] = useState({});
  const [collapsed, setCollapsed] = useState({});
  const [assignments, setAssignments] = useState({});
  const [days, setDays] = useState([]);

  const groupOrder = ['staří', 'střední', 'mladí'];
  const groupLabel = { 'staří': 'S', 'střední': 'M', 'mladí': 'J' };

  const today = new Date();
  const currentQuarter = Math.floor(today.getMonth() / 3) + 1;
  const targetQuarter = ((currentQuarter + currentQOffset - 1) % 4) + 1;
  const targetYear = currentQuarter + currentQOffset > 4 ? today.getFullYear() + 1 : today.getFullYear();
  const qStartMonth = (targetQuarter - 1) * 3;

  useEffect(() => {
    const allUsers = [];
    Object.keys(localStorage).forEach(key => {
      if (key.startsWith('settings_')) {
        const uid = key.split('_')[1];
        const settings = JSON.parse(localStorage.getItem(key));
        const userData = JSON.parse(localStorage.getItem('user') || '{}');
        if (userData.uid === uid || key.includes('dummy')) {
          allUsers.push({ ...settings, uid, email: userData.email || settings.email });
        }
      }
    });

    const grouped = {};
    allUsers.forEach(u => {
      u.groups.forEach(g => {
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

    // --- Dny: poslední pátek před Q + 3 měsíce ---
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

    const key = `schedule_${targetYear}_Q${targetQuarter}`;
    const saved = localStorage.getItem(key);
    if (saved) setAssignments(JSON.parse(saved));
    else setAssignments({});
  }, [currentQOffset]);

  useEffect(() => {
    const key = `schedule_${targetYear}_Q${targetQuarter}`;
    localStorage.setItem(key, JSON.stringify(assignments));
  }, [assignments, targetYear, targetQuarter]);

  const toggleGroup = (group) => {
    setCollapsed(prev => ({ ...prev, [group]: !prev[group] }));
  };

  const handleCellClick = (date, user) => {
    const key = `${date}_${user.uid}`;
    const current = assignments[key];
    if (current) {
      const { [key]: _, ...rest } = assignments;
      setAssignments(rest);
      window.notify(`${user.shortcut} odebráno`, 'info');
    } else if (user.groups.length > 0) {
      setAssignments(prev => ({ ...prev, [key]: user.groups[0] }));
      window.notify(`${user.shortcut} přiřazeno`, 'success');
    }
  };

  const isWeekendOrHoliday = (date) => {
    const d = new Date(date);
    const day = d.getDay();
    const holidays = generateHolidays();
    return day === 0 || day === 6 || holidays.some(h => h.date === date);
  };

  const getCellClass = (date, user) => {
    const pref = JSON.parse(localStorage.getItem(`dayStyles_${user.uid}`) || '[]')
      .find(p => p.date === date)?.status;
    if (pref === 'not available') return 'not-available';
    if (pref === 'preferred') return 'preferred';
    return '';
  };

  // === STATISTIKY S PÁTKY + PRŮMĚREM ===
  const getStats = (user) => {
    const userShifts = Object.keys(assignments)
      .filter(k => k.endsWith(user.uid))
      .map(k => k.split('_')[0]);

    const weekday = userShifts.filter(date => {
      const d = new Date(date);
      const day = d.getDay();
      return day >= 1 && day <= 5;
    }).length;

    const fridays = userShifts.filter(date => {
      const d = new Date(date);
      return d.getDay() === 5;
    }).length;

    const weekend = userShifts.filter(date => {
      const d = new Date(date);
      const day = d.getDay();
      return day === 0 || day === 6;
    }).length;

    const holiday = userShifts.filter(date => {
      const holidays = generateHolidays();
      return holidays.some(h => h.date === date);
    }).length;

    const total = userShifts.length;

    // --- Dlouhodobý průměr pátků ---
    const statsKey = `fridayStats_${user.uid}`;
    const yearlyStats = JSON.parse(localStorage.getItem(statsKey) || '{}');
    const yearKey = targetYear.toString();
    yearlyStats[yearKey] = (yearlyStats[yearKey] || 0) + fridays;
    localStorage.setItem(statsKey, JSON.stringify(yearlyStats));

    const totalFridays = Object.values(yearlyStats).reduce((a, b) => a + b, 0);
    const avgFridays = Object.keys(yearlyStats).length > 0 
      ? (totalFridays / Object.keys(yearlyStats).length).toFixed(1) 
      : '—';

    return { weekday, fridays, weekend, holiday, total, totalFridays, avgFridays };
  };

  const exportToTSV = () => {
    let tsv = 'Datum\t' + groupOrder.flatMap(g => users[g]?.map(u => u.shortcut) || []).join('\t') + '\n';
    days.forEach(date => {
      tsv += date + '\t';
      groupOrder.forEach(g => {
        users[g]?.forEach(u => {
          tsv += (assignments[`${date}_${u.uid}`] ? groupLabel[assignments[`${date}_${u.uid}`]] : '') + '\t';
        });
      });
      tsv = tsv.trim() + '\n';
    });
    const blob = new Blob([tsv], { type: 'text/tab-separated-values' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `plan_Q${targetQuarter}_${targetYear}.tsv`;
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
                  <th key={`${u.uid}-${group}`}>{u.shortcut}</th>
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
                      key={`${u.uid}-${group}`}
                      className={getCellClass(date, u)}
                      onClick={() => handleCellClick(date, u)}
                    >
                      {assignments[`${date}_${u.uid}`]
                        ? groupLabel[assignments[`${date}_${u.uid}`]] || ''
                        : ''}
                    </td>
                  ))
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="right-column">
        {/* TLAČÍTKA SKUPIN */}
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

        {/* NAVIGACE Q + EXPORT */}
        <div className="q-nav">
          <button onClick={() => setCurrentQOffset(prev => prev - 1)}>Předchozí Q</button>
          <span>Q{targetQuarter} {targetYear}</span>
          <button onClick={() => setCurrentQOffset(prev => prev + 1)}>Následující Q</button>
          <button onClick={exportToTSV}>Export TSV</button>
        </div>

        {/* STATISTIKY – ČISTÁ TABULKA */}
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
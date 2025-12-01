import React, { useState, useEffect, useMemo } from 'react';
import { db } from './firebase';
import { collection, getDocs, doc, getDoc, setDoc } from 'firebase/firestore';
import { generateHolidays } from './utils';
import './Scheduler.css'

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
    const current = assignments[key]; // co tam teď je
    const userGroups = user.groups || []; // skupiny uživatele
    
    // Pořadí pro cyklení: staří → střední → mladí
    const groupCycleOrder = ['staří', 'střední', 'mladí'];
    
    let nextGroup = null;
    
    if (!current) {
      // 1. klik: první skupina uživatele
      nextGroup = userGroups.find(g => groupCycleOrder.includes(g));
    } else {
      // Najdi aktuální pozici a vezmi další
      const currentIndex = groupCycleOrder.indexOf(current);
      const possibleNext = groupCycleOrder.slice(currentIndex + 1);
      
      // Hledej další skupinu, kterou uživatel má
      nextGroup = possibleNext.find(g => userGroups.includes(g));
      
      // Pokud žádnou další nemá → konec cyklu = nic
    }

    setAssignments(prev => {
      if (nextGroup) {
        window.notify(`${user.shortcut} → ${groupLabel[nextGroup]}`, 'success');
        return { ...prev, [key]: nextGroup };
      } else {
        window.notify(`${user.shortcut} odebrán`, 'info');
        const { [key]: _, ...rest } = prev;
        return rest;
      }
    });
  };

  const isWeekendOrHoliday = (date) => {
    const d = new Date(date);
    return d.getDay() === 0 || d.getDay() === 6 || generateHolidays().some(h => h.date === date);
  };

  const getCellClass = (date, user) => {
    // ✅ PRIORITY 1: PREFERENCE LÉKAŘE
    const pref = userPreferences[user.uid]?.[date];
    if (pref === 'not available') return 'pref-not-available';
    if (pref === 'preferred') return 'pref-preferred';
    
    // ✅ PRIORITY 2: VÍKEND/SVÁTEK - VŽDY (i když obsazené)
    if (isWeekendOrHoliday(date)) {
      if (assignments[`${date}_${user.uid}`]) {
        return 'sch-weekend-assigned';  // Obsazené víkendy
      }
      return 'sch-weekend-empty';       // Prázdné víkendy
    }
    
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

  const getStats = (user) => {
    let weekday = 0;
    let fridays = 0;
    let weekend = 0;
    let holiday = 0;

    days.forEach(date => {
      const key = `${date}_${user.uid}`;
      const assignment = assignments[key];
      
      if (assignment) {
        const dateObj = new Date(date);
        const dayOfWeek = dateObj.getDay();
        
        if (dayOfWeek === 0 || dayOfWeek === 6) {
          weekend++;  // Sobota/Neděle
        } else if (dayOfWeek === 5) {
          fridays++;  // Pátek
        } else {
          weekday++;  // Pondělí-Čtvrtek
        }
        
        // Svátek (překrývá víkend)
        if (generateHolidays().some(h => h.date === date)) {
          holiday++;
        }
      }
    });

    const total = weekday + fridays + weekend + holiday;
    const totalFridays = fridays;
    const avgFridays = days.filter(d => new Date(d).getDay() === 5).length > 0 
      ? (fridays / days.filter(d => new Date(d).getDay() === 5).length * 100).toFixed(1) + '%'
      : '0%';

    return { 
      weekday, 
      fridays, 
      weekend, 
      holiday, 
      total, 
      totalFridays, 
      avgFridays 
    };
  };

return (
  <div className="sch-scheduler">
    {/* HLAVNÍ OBSAH */}
    <div className="sch-mainContent">
      {/* LEVÁ Tabulka */}
      <div className="sch-leftColumn">
        <table className="sch-scheduleTable">
          <thead>
            <tr>
              <th>Datum</th>
              {visibleUsers.map(u => (
                <th key={u.uid}>{u.shortcut}</th>
              ))}
            </tr>
          </thead>
          <tbody>
          {days.map(date => {
            // VALIDACE - POČÍTÁNÍ SKUPIN
            const assignmentsInDay = visibleUsers
              .map(u => assignments[`${date}_${u.uid}`])
              .filter(Boolean);
            
            const groupCount = { S: 0, M: 0, J: 0 };
            assignmentsInDay.forEach(group => {
              if (group === 'staří') groupCount.S++;
              if (group === 'střední') groupCount.M++;
              if (group === 'mladí') groupCount.J++;
            });
            
            // VALIDACE TŘÍDA
            let dateClass = '';
            if (groupCount.S === 1 && groupCount.M === 1 && groupCount.J === 1) {
              dateClass = 'sch-date-perfect';  // 🟢 ZELENÁ
            } else if (groupCount.S > 1 || groupCount.M > 1 || groupCount.J > 1) {
              dateClass = 'sch-date-error';    // 🔴 ČERVENÁ
            } else if (assignmentsInDay.length > 0 && assignmentsInDay.length < 3) {
              dateClass = 'sch-date-warning';  // 🟡 ŽLUTÁ
            }
            
            // VÍKENDY A SVÁTKY + VALIDACE
            const weekendClass = isWeekendOrHoliday(date) ? 'sch-specialDay' : '';
            
            return (
              <tr key={date}>
                <td className={`sch-date-cell ${dateClass} ${weekendClass}`}>
                  {date}
                </td>
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
            );
          })}
          </tbody>
        </table>
      </div>

      {/* PRAVÁ - STATISTIKY */}
      <div className="sch-rightColumn">
        <div className="sch-groupButtons">
          {groupOrder.map(group => (
            <button
              key={group}
              className={`sch-groupBtn ${!collapsed[group] ? "sch-active" : ''}`}
              onClick={() => toggleGroup(group)}
            >
              {group.charAt(0).toUpperCase() + group.slice(1)} ({users[group]?.length || 0})
            </button>
          ))}
        </div>

        <div className="sch-qNav">
          <button onClick={() => setCurrentQOffset(prev => prev - 1)}>Pre</button>
          <span>Q{targetQuarter} {targetYear}</span>
          <button onClick={() => setCurrentQOffset(prev => prev + 1)}>Nex</button>
          <button onClick={exportToTSV}>Exp</button>
        </div>

        <h3>Statistiky</h3>
        {groupOrder.map(group => (
          users[group] && !collapsed[group] && (
            <div key={group} className="sch-statsTableBlock">
              <table className="sch-statsCompactTable">
                <thead>
                  <tr>
                    <th></th>
                    {users[group].map(u => (
                      <th key={u.uid}>{u.shortcut}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr><td className="sch-rowLabel">V</td>{users[group].map(u => <td key={u.uid}>{getStats(u).weekday}</td>)}</tr>
                  <tr><td className="sch-rowLabel">P</td>{users[group].map(u => <td key={u.uid}>{getStats(u).fridays}</td>)}</tr>
                  <tr><td className="sch-rowLabel">W</td>{users[group].map(u => <td key={u.uid}>{getStats(u).weekend}</td>)}</tr>
                  <tr><td className="sch-rowLabel">S</td>{users[group].map(u => <td key={u.uid}>{getStats(u).holiday}</td>)}</tr>
                  <tr><td className="sch-rowLabel">C</td>{users[group].map(u => <td key={u.uid}>{getStats(u).total}</td>)}</tr>
                  <tr><td className="sch-rowLabel">PC</td>{users[group].map(u => <td key={u.uid}>{getStats(u).totalFridays}</td>)}</tr>
                  <tr><td className="sch-rowLabel">PA</td>{users[group].map(u => <td key={u.uid}>{getStats(u).avgFridays}</td>)}</tr>
                </tbody>
              </table>
            </div>
          )
        ))}
      </div>
    </div>
  </div>
)}
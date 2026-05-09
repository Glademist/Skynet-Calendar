// src/AdminPanel.js
import React, { useState, useEffect, useMemo } from 'react';
import { db } from './firebase';
import { collection, getDocs, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import './AdminPanel.css'

const exportAllData = async () => {
  const snapshot = await getDocs(collection(db, 'settings'));
  const users = snapshot.docs.map(d => ({ uid: d.id, ...d.data() }));
  const data = { users, assignments: {}, preferences: {} };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `backup_${new Date().toISOString().split('T')[0]}.json`;
  a.click();
};

const OVERRIDE_FIELDS = ['weekdayShifts', 'weekendShifts', 'shiftInterval'];

// Display order in the table: doctors are bucketed by seniority so the
// admin can scan straight down through staří → staří+střední → střední →
// střední+mladí → mladí. Within a bucket, alphabetical by shortcut. The
// sort runs once on load — mutating groups in the table does not re-sort
// until reload.
const GROUP_RANK = { 'staří': 1, 'střední': 2, 'mladí': 3 };
function getGroupSortKey(u) {
  const ranks = (u.groups || [])
    .map(g => GROUP_RANK[g])
    .filter(Boolean)
    .sort((a, b) => a - b);
  if (ranks.length === 0) return [99, 99];
  return [ranks[0], ranks[ranks.length - 1]];
}
function compareUsersByGroup(a, b) {
  const [aHi, aLo] = getGroupSortKey(a);
  const [bHi, bLo] = getGroupSortKey(b);
  if (aHi !== bHi) return aHi - bHi;
  if (aLo !== bLo) return aLo - bLo;
  return (a.shortcut || '').localeCompare(b.shortcut || '', 'cs');
}

function defaultQuarter() {
  const today = new Date();
  return {
    year: today.getFullYear(),
    quarter: Math.floor(today.getMonth() / 3) + 1,
  };
}

export default function AdminPanel() {
  const [users, setUsers] = useState([]);

  // Quarter selector for per-quarter shift overrides. The override scope is
  // a single (year, quarter) pair; all 🔒-marked inputs in the table read /
  // write that one Firestore doc. Switching the quarter loads a different
  // override set without touching globals.
  const initial = defaultQuarter();
  const [year, setYear] = useState(initial.year);
  const [quarter, setQuarter] = useState(initial.quarter);

  // Raw override doc for the selected quarter:
  //   { [uid]: { weekdayShifts?, weekendShifts?, shiftInterval? } }
  const [overrides, setOverrides] = useState({});

  // Per-input lock state: locks[uid][field] === true means the input is in
  // override mode (controlled, writes to quarterShiftOverrides). Default
  // false means global mode (uncontrolled, writes to settings/{uid}).
  // Derived from overrides on every (year, quarter) load.
  const [locks, setLocks] = useState({});

  useEffect(() => {
    const fetch = async () => {
      try {
        const snap = await getDocs(collection(db, 'settings'));
        const list = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
        list.sort(compareUsersByGroup);
        setUsers(list);
      } catch (error) {
        console.error('Chyba při načítání uživatelů:', error);
      }
    };
    fetch();
  }, []);

  // Load overrides + derive initial locks whenever (year, quarter) changes.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const snap = await getDoc(doc(db, 'quarterShiftOverrides', `${year}_Q${quarter}`));
        if (cancelled) return;
        const data = snap.exists() ? snap.data() : {};
        setOverrides(data);
        // Derive locks: any field present (and non-empty) in overrides → 🔒.
        const nextLocks = {};
        for (const [uid, fields] of Object.entries(data)) {
          const flags = {};
          for (const k of OVERRIDE_FIELDS) {
            if (fields?.[k] !== undefined && fields[k] !== '') flags[k] = true;
          }
          if (Object.keys(flags).length > 0) nextLocks[uid] = flags;
        }
        setLocks(nextLocks);
      } catch (e) {
        console.error('Override load failed:', e);
        if (!cancelled) {
          setOverrides({});
          setLocks({});
        }
      }
    };
    load();
    return () => { cancelled = true; };
  }, [year, quarter]);

  const approve = async (uid) => {
    try {
      await updateDoc(doc(db, 'settings', uid), { approved: true });
      setUsers(prev => prev.map(u => u.uid === uid ? { ...u, approved: true } : u));
    } catch (error) {
      console.error('Chyba při schvalování:', error);
    }
  };

  const changeShortcut = async (uid, val) => {
    if (!val.trim()) return;
    try {
      await updateDoc(doc(db, 'settings', uid), { shortcut: val.trim() });
      setUsers(prev => prev.map(u => u.uid === uid ? { ...u, shortcut: val.trim() } : u));
    } catch (error) {
      console.error('Chyba při změně zkratky:', error);
    }
  };

  const updateGroups = async (uid, newGroups) => {
    try {
      await updateDoc(doc(db, 'settings', uid), { groups: newGroups });
      setUsers(prev => prev.map(u =>
        u.uid === uid ? { ...u, groups: newGroups } : u
      ));
    } catch (err) {
      console.error('Chyba při ukládání skupin:', err);
    }
  };

  // Global limit edit (🔓 mode). Settings.js stores weekdayShifts and
  // weekendShifts as STRINGS (Firestore has both ints and the special 'X'
  // flexible marker), so we keep the value as-typed without coercion.
  const updateGlobal = async (uid, field, raw) => {
    const value = (raw ?? '').toString().trim();
    try {
      await updateDoc(doc(db, 'settings', uid), { [field]: value });
      setUsers(prev => prev.map(u =>
        u.uid === uid ? { ...u, [field]: value } : u
      ));
    } catch (err) {
      console.error(`Chyba při ukládání ${field}:`, err);
    }
  };

  // Per-quarter override write (🔒 mode). Stores at
  // quarterShiftOverrides/{year}_Q{quarter} with the same string shape. We
  // write whatever the user typed — including 'X' or empty (empty deletes
  // the field, since '' is treated as "no override" in applyShiftOverrides).
  const updateOverride = async (uid, field, raw) => {
    const value = (raw ?? '').toString().trim();
    const ref = doc(db, 'quarterShiftOverrides', `${year}_Q${quarter}`);
    setOverrides(prev => {
      const next = { ...prev };
      const userOverrides = { ...(next[uid] || {}) };
      if (value === '') delete userOverrides[field];
      else userOverrides[field] = value;
      if (Object.keys(userOverrides).length === 0) delete next[uid];
      else next[uid] = userOverrides;
      // Fire and forget — no await inside setState updater.
      setDoc(ref, next).catch(e => console.error(`Override save ${field} failed:`, e));
      return next;
    });
  };

  // Toggle 🔓/🔒 for a single (uid, field). Going 🔓→🔒 prefills the override
  // with the global value (so the visible number doesn't jump when the input
  // becomes controlled). Going 🔒→🔓 deletes the override key for that field.
  const toggleLock = (uid, field, currentGlobalValue) => {
    setLocks(prev => {
      const userLocks = { ...(prev[uid] || {}) };
      const wasLocked = !!userLocks[field];
      const next = { ...prev };
      if (wasLocked) {
        delete userLocks[field];
        if (Object.keys(userLocks).length === 0) delete next[uid];
        else next[uid] = userLocks;
        // Removing a 🔒 → drop that key from the override doc.
        const ref = doc(db, 'quarterShiftOverrides', `${year}_Q${quarter}`);
        setOverrides(prevOv => {
          const nextOv = { ...prevOv };
          if (nextOv[uid]) {
            const userOv = { ...nextOv[uid] };
            delete userOv[field];
            if (Object.keys(userOv).length === 0) delete nextOv[uid];
            else nextOv[uid] = userOv;
          }
          setDoc(ref, nextOv).catch(e => console.error(`Override unlock ${field} failed:`, e));
          return nextOv;
        });
      } else {
        userLocks[field] = true;
        next[uid] = userLocks;
        // Prefill override with global value so the controlled input shows
        // something sensible immediately.
        const seed = (currentGlobalValue ?? '').toString();
        if (seed !== '') {
          const ref = doc(db, 'quarterShiftOverrides', `${year}_Q${quarter}`);
          setOverrides(prevOv => {
            const nextOv = { ...prevOv };
            const userOv = { ...(nextOv[uid] || {}) };
            userOv[field] = seed;
            nextOv[uid] = userOv;
            setDoc(ref, nextOv).catch(e => console.error(`Override seed ${field} failed:`, e));
            return nextOv;
          });
        }
      }
      return next;
    });
  };

  const yearOptions = useMemo(() => {
    const y = new Date().getFullYear();
    return [y - 1, y, y + 1, y + 2];
  }, []);

  const renderLimitInput = (u, field, useNumberType = false) => {
    const isLocked = !!locks[u.uid]?.[field];
    const overrideVal = overrides[u.uid]?.[field] ?? '';
    const lockKey = `${u.uid}-${field}-${isLocked ? 'L' : 'U'}-${year}-${quarter}`;
    const commonProps = {
      style: { width: 50, textAlign: 'center' },
      title: useNumberType ? 'Minimální dny mezi službami' : 'Číslo nebo X = flexibilní',
      ...(useNumberType ? { type: 'number', min: '1' } : {}),
    };
    return (
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <button
          type="button"
          onClick={() => toggleLock(u.uid, field, u[field])}
          title={isLocked
            ? `Override pro Q${quarter}/${year} (klik = zpět na globál)`
            : `Přepsat hodnotu jen pro Q${quarter}/${year}`}
          style={{
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            padding: 0,
            fontSize: 14,
            lineHeight: 1,
            opacity: isLocked ? 1 : 0.55,
          }}
        >
          {isLocked ? '🔒' : '🔓'}
        </button>
        {isLocked ? (
          <input
            key={lockKey}
            value={overrideVal}
            onChange={e => setOverrides(prev => ({
              ...prev,
              [u.uid]: { ...(prev[u.uid] || {}), [field]: e.target.value }
            }))}
            onBlur={e => updateOverride(u.uid, field, e.target.value)}
            {...commonProps}
            style={{ ...commonProps.style, background: '#fff7d6', borderColor: '#e5a000' }}
          />
        ) : (
          <input
            key={lockKey}
            defaultValue={u[field] ?? ''}
            onBlur={e => updateGlobal(u.uid, field, e.target.value)}
            {...commonProps}
          />
        )}
      </div>
    );
  };

  return (
    <div className="adm-adminpanel">
      {/* ✅ EXPORT TLAČÍTKO NAHORĚ */}
      <div className="adm-header">
        <button onClick={exportAllData} className="adm-exportButton">
          📤 Exportovat vše (JSON)
        </button>
      </div>

      {/* Per-quarter override scope. All 🔒-marked inputs in the table below
          read/write `quarterShiftOverrides/{year}_Q${quarter}`. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '8px 16px', borderBottom: '1px solid #e5e7eb', background: '#f9fafb',
        fontSize: 13,
      }}>
        <strong style={{ color: '#374151' }}>Override kvartál:</strong>
        <select value={year} onChange={e => setYear(Number(e.target.value))}>
          {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <select value={quarter} onChange={e => setQuarter(Number(e.target.value))}>
          {[1, 2, 3, 4].map(q => <option key={q} value={q}>Q{q}</option>)}
        </select>
        <span style={{ color: '#6b7280', marginLeft: 8 }}>
          🔒 = přepis pro tento kvartál · 🔓 = globální (settings/{`{uid}`})
        </span>
      </div>

      {/* ✅ SCROLL TABULKA */}
      <div className="adm-tableContainer">
        <table className="adm-adminTable">
          <thead>
            <tr>
              <th>Zkratka</th>
              <th>Jméno</th>
              <th>Email</th>
              <th>Skupiny</th>
              <th title="Měsíční limit všedních dní (číslo, nebo X = flexibilní)">WD/měs</th>
              <th title="Měsíční limit víkendových dní (číslo, nebo X = flexibilní)">WK/měs</th>
              <th title="Minimální interval mezi službami (dní)">Interval</th>
              <th>Schváleno</th>
              <th>Akce</th>
            </tr>
          </thead>
          <tbody>
            {users.map(u => (
              <tr key={u.uid}>
                <td>
                  <input
                    className="adm-shortcutInput"
                    value={u.shortcut || ''}
                    onChange={e => changeShortcut(u.uid, e.target.value)}
                    style={{width: '60px'}}
                  />
                </td>
                <td>{u.firstName} {u.lastName}</td>
                <td>
                  {u.email || '—'}
                  {u.displayName && !u.email && <small> (z Google)</small>}
                </td>
                <td>
                  {['staří', 'střední', 'mladí'].map(g => (
                    <label key={g} className="adm-checkboxLabel">
                      <input
                        type="checkbox"
                        checked={u.groups?.includes(g) || false}
                        onChange={(e) => {
                          const newGroups = e.target.checked
                            ? [...(u.groups || []).filter(x => x !== g), g]
                            : (u.groups || []).filter(x => x !== g);
                          updateGroups(u.uid, newGroups);
                        }}
                      />
                      <span>{g}</span>
                    </label>
                  ))}
                </td>
                <td>{renderLimitInput(u, 'weekdayShifts')}</td>
                <td>{renderLimitInput(u, 'weekendShifts')}</td>
                <td>{renderLimitInput(u, 'shiftInterval', true)}</td>
                <td className={u.approved ? "adm-statusApproved" : "adm-statusPending"}>
                  {u.approved ? '✓' : '⏳'}
                </td>
                <td className="adm-actionButtons">
                  {!u.approved && (
                    <button onClick={() => approve(u.uid)} className="adm-approveBtn">
                      Schválit
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

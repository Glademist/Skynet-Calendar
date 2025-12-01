// src/AdminPanel.js
import React, { useState, useEffect } from 'react';
import { db } from './firebase';
import { collection, getDocs, doc, updateDoc } from 'firebase/firestore';
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

export default function AdminPanel() {
  const [users, setUsers] = useState([]);

  useEffect(() => {
    const fetch = async () => {
      try {
        const snap = await getDocs(collection(db, 'settings'));
        setUsers(snap.docs.map(d => ({ uid: d.id, ...d.data() })));
      } catch (error) {
        console.error('Chyba při načítání uživatelů:', error);
      }
    };
    fetch();
  }, []);

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

  return (
    <div className="adm-adminpanel">
      {/* ✅ EXPORT TLAČÍTKO NAHORĚ */}
      <div className="adm-header">
        <button onClick={exportAllData} className="adm-exportButton">
          📤 Exportovat vše (JSON)
        </button>
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
                <td>{u.email}</td>
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
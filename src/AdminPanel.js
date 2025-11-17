// src/AdminPanel.js
import React, { useState, useEffect } from 'react';
import { db } from './firebase';
import { collection, getDocs, doc, updateDoc } from 'firebase/firestore';

const exportAllData = async () => {
  const snapshot = await getDocs(collection(db, 'settings'));
  const users = snapshot.docs.map(d => ({ uid: d.id, ...d.data() }));
  const data = { users, assignments: {}, preferences: {} }; // assignments můžeš doplnit
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
      const snap = await getDocs(collection(db, 'settings'));
      setUsers(snap.docs.map(d => ({ uid: d.id, ...d.data() })));
    };
    fetch();
  }, []);

  const approve = async (uid) => {
    await updateDoc(doc(db, 'settings', uid), { approved: true });
    setUsers(prev => prev.map(u => u.uid === uid ? { ...u, approved: true } : u));
  };

  const changeShortcut = async (uid, val) => {
    if (!val) return;
    await updateDoc(doc(db, 'settings', uid), { shortcut: val });
    setUsers(prev => prev.map(u => u.uid === uid ? { ...u, shortcut: val } : u));
  };

  return (
    <div className="admin-panel">
      <h2>Admin přehled</h2>
      <table className="admin-table">
        <thead>
          <tr><th>Zkratka</th><th>Jméno</th><th>Email</th><th>Skupiny</th><th>Schváleno</th><th>Akce</th></tr>
        </thead>
        <tbody>
          {users.map(u => (
            <tr key={u.uid}>
              <td><input value={u.shortcut || ''} onChange={e => changeShortcut(u.uid, e.target.value)} style={{width:60}} /></td>
              <td>{u.firstName} {u.lastName}</td>
              <td>{u.email}</td>
              <td>{u.groups?.join(', ')}</td>
              <td>{u.approved ? '✓' : '✗'}</td>
              <td>{!u.approved && <button onClick={() => approve(u.uid)}>Schválit</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button onClick={exportAllData}>Exportovat vše (JSON)</button>
    </div>
  );
}
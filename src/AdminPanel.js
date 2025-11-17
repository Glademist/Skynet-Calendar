// src/AdminPanel.js
import React, { useState, useEffect } from 'react';

const exportAllData = () => {
  const data = {
    users: {},
    assignments: {},
    preferences: {}
  };

  Object.keys(localStorage).forEach(key => {
    if (key.startsWith('settings_')) {
      const uid = key.split('_')[1];
      data.users[uid] = JSON.parse(localStorage.getItem(key));
    }
    if (key.startsWith('schedule_')) {
      data.assignments[key] = JSON.parse(localStorage.getItem(key));
    }
    if (key.startsWith('dayStyles_')) {
      const uid = key.split('_')[1];
      data.preferences[uid] = JSON.parse(localStorage.getItem(key));
    }
  });

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `backup_${new Date().toISOString().split('T')[0]}.json`;
  a.click();
};

const approveUser = (uid, setUsers) => {
  const settings = JSON.parse(localStorage.getItem(`settings_${uid}`));
  settings.approved = true;
  localStorage.setItem(`settings_${uid}`, JSON.stringify(settings));
  window.notify(`Uživatel ${settings.shortcut} schválen`, 'success');

  // Aktualizuj stav
  setUsers(prev => prev.map(u => u.uid === uid ? { ...u, approved: true } : u));
};

export default function AdminPanel() {
  const [users, setUsers] = useState([]);

  useEffect(() => {
    const allKeys = Object.keys(localStorage);
    const userKeys = allKeys.filter(k => k.startsWith('settings_'));
    const userData = userKeys.map(key => {
      const uid = key.split('_')[1];
      const settings = JSON.parse(localStorage.getItem(key));
      const userStr = localStorage.getItem('user');
      let email = '', name = '';
      if (userStr) {
        const u = JSON.parse(userStr);
        if (u.uid === uid) {
          email = u.email;
          name = u.name;
        }
      }
      return { ...settings, email, name, uid, approved: settings.approved || false };
    });
    setUsers(userData);
  }, []);

  return (
    <div className="admin-panel">
      <h2>Admin přehled uživatelů</h2>
      <table className="admin-table">
        <thead>
          <tr>
            <th>Zkratka</th>
            <th>Jméno</th>
            <th>Příjmení</th>
            <th>Email</th>
            <th>Skupiny</th>
            <th>Všední</th>
            <th>Víkendy</th>
            <th>Interval</th>
          </tr>
        </thead>
        <tbody>
          {users.map(u => (
            <tr key={u.uid}>
              <td>{u.shortcut}</td>
              <td>{u.firstName}</td>
              <td>{u.lastName}</td>
              <td>{u.email}</td>
              <td>{u.groups?.join(', ') || ''}</td>
              <td>{u.weekdayShifts}</td>
              <td>{u.weekendShifts}</td>
              <td>{u.shiftInterval}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Uživatelé ke schválení</h3>
      <table className="users-table">
        <thead>
          <tr>
            <th>Jméno</th>
            <th>Zkratka</th>
            <th>Email</th>
            <th>Schváleno</th>
            <th>Akce</th>
          </tr>
        </thead>
        <tbody>
          {users.map(u => (
            <tr key={u.uid}>
              <td>{u.firstName} {u.lastName}</td>
              <td>{u.shortcut}</td>
              <td>{u.email}</td>
              <td>{u.approved ? '✓' : '✗'}</td>
              <td>
                {!u.approved && (
                  <button onClick={() => approveUser(u.uid, setUsers)}>Schválit</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <button onClick={exportAllData} className="export-btn">
        Exportovat vše (JSON)
      </button>
    </div>
  );
}
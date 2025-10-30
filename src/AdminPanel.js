// src/AdminPanel.js
import React, { useState, useEffect } from 'react';

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
      return { ...settings, email, name, uid };
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
              <td>{u.groups.join(', ')}</td>
              <td>{u.weekdayShifts}</td>
              <td>{u.weekendShifts}</td>
              <td>{u.shiftInterval}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
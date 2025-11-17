// src/Settings.js
import React, { useState, useEffect } from 'react';
import { SHORTCUTS } from './constants';

const allGroups = ['staří', 'střední', 'mladí'];

export default function Settings({ user, onSave }) {
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    shortcut: '',
    weekdayShifts: 0,
    weekendShifts: 0,
    shiftInterval: 0,
    groups: [] // ← pole místo stringu
  });

  useEffect(() => {
    const saved = localStorage.getItem(`settings_${user.uid}`);
    if (saved) {
      setForm(JSON.parse(saved));
    } else {
      const firstName = user.given_name || '';
      const lastName = user.family_name || '';
      const shortcut = (firstName.charAt(0) + lastName.charAt(0)).toUpperCase().slice(0, 3);
      setForm(prev => ({ ...prev, firstName, lastName, shortcut }));
    }
  }, [user]);

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    if (type === 'checkbox') {
      setForm(prev => ({
        ...prev,
        groups: checked
          ? [...prev.groups, value]
          : prev.groups.filter(g => g !== value)
      }));
    } else {
      setForm(prev => ({ ...prev, [name]: value }));
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!form.firstName || !form.lastName || !form.shortcut) {
      window.notify('Vyplňte všechna povinná pole', 'error');
      return;
    }
    localStorage.setItem(`settings_${user.uid}`, JSON.stringify(form));
    window.notify('Nastavení uloženo', 'success'); // ← TADY
    onSave();
  };

  return (
    <div className="settings-page">
      <h2>Nastavení – {user.email}</h2>
      <form onSubmit={handleSubmit} className="settings-form">
        <div className="form-row">
          <label>Jméno:</label>
          <input name="firstName" value={form.firstName} onChange={handleChange} required />
        </div>
        <div className="form-row">
          <label>Příjmení:</label>
          <input name="lastName" value={form.lastName} onChange={handleChange} required />
        </div>
        <div className="form-row">
          <label>Zkratka:</label>
          <select
            value={form.shortcut}
            onChange={(e) => setForm({ ...form, shortcut: e.target.value })}
            required
          >
            <option value="">-- Vyberte zkratku --</option>
            {SHORTCUTS.map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label>Počet všedních služeb:</label>
          <input type="number" name="weekdayShifts" value={form.weekdayShifts} onChange={handleChange} min="0" />
        </div>
        <div className="form-row">
          <label>Počet víkendových služeb:</label>
          <input type="number" name="weekendShifts" value={form.weekendShifts} onChange={handleChange} min="0" />
        </div>
        <div className="form-row">
          <label>Interval mezi službami (dní):</label>
          <input type="number" name="shiftInterval" value={form.shiftInterval} onChange={handleChange} min="0" />
        </div>
        <div className="form-row">
          <label>Skupiny:</label>
          <div className="checkbox-group">
            {allGroups.map(g => (
              <label key={g} className="checkbox-label">
                <input
                  type="checkbox"
                  value={g}
                  checked={form.groups.includes(g)}
                  onChange={handleChange}
                />
                {g}
              </label>
            ))}
          </div>
        </div>
        <button type="submit" className="save-btn">Uložit</button>
      </form>
    </div>
  );
}
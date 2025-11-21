import React, { useState, useEffect } from 'react';
import { SHORTCUTS } from './constants';
import { db } from './firebase';
import { doc, setDoc, getDoc } from 'firebase/firestore';   // ← přidej getDoc

const allGroups = ['staří', 'střední', 'mladí'];

export default function Settings({ user, onSave }) {
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    shortcut: '',
    weekdayShifts: 5,
    weekendShifts: 2,
    shiftInterval: 7,
    groups: []
  });

  // Načítání z Firestore (nejdřív), pak fallback na localStorage (pro stará data)
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const docRef = doc(db, 'settings', user.uid);
        const docSnap = await getDoc(docRef);

        if (docSnap.exists()) {
          setForm(docSnap.data());
        } else {
          // Fallback na localStorage (pro stará data)
          const saved = localStorage.getItem(`settings_${user.uid}`);
          if (saved) {
            setForm(JSON.parse(saved));
          } else {
            // Výchozí hodnoty z Google účtu
            const firstName = user.given_name || '';
            const lastName = user.family_name || '';
            const shortcut = (firstName.charAt(0) + lastName.charAt(0)).toUpperCase();
            setForm(prev => ({ ...prev, firstName, lastName, shortcut }));
          }
        }
      } catch (err) {
        console.error('Chyba při načítání nastavení:', err);
      }
    };

    loadSettings();
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

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.shortcut) {
      window.notify('Vyberte zkratku!', 'error');
      return;
    }

    try {
      await setDoc(doc(db, 'settings', user.uid), {
        ...form,
        email: user.email,
        approved: false
      });

      window.notify('Nastavení uloženo', 'success');
      onSave?.();
      // Skryj hlášku, že nastavení chybí
      if (window.showSettingsWarning) {
        window.showSettingsWarning = false;
        // vynutíme refresh hlášky v App.js
        window.dispatchEvent(new Event('settingsSaved'));
      }
    } catch (err) {
      window.notify('Chyba: ' + err.message, 'error');
    }
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
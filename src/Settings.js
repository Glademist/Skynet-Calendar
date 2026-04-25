// src/components/Settings.js
import React, { useState, useEffect } from 'react';
import { SHORTCUTS } from './constants';
import { db } from './firebase';
import { doc, setDoc, getDoc } from 'firebase/firestore';
import './Settings.css';

const allGroups = ['staří', 'střední', 'mladí'];

export default function Settings({ user, onSave, adminEditMode }) {
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    shortcut: '',
    weekdayShifts: 5,
    weekendShifts: 2,
    shiftInterval: 7,
    groups: []
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const targetUid = adminEditMode?.uid || user.uid;

  useEffect(() => {
    const load = async () => {
      const ref = doc(db, 'settings', targetUid);
      const snap = await getDoc(ref);
      if (snap.exists()) {
        setForm(snap.data());
      } else {
        setForm(prev => ({
          ...prev,
          firstName: user.given_name || '',
          lastName: user.family_name || '',
          shortcut: (user.given_name?.[0] + user.family_name?.[0])?.toUpperCase() || ''
        }));
      }
    };
    load();
  }, [targetUid, user]);

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    if (type === 'checkbox') {
      setForm(prev => ({
        ...prev,
        groups: checked
          ? [...prev.groups, name]
          : prev.groups.filter(g => g !== name)
      }));
    } else {
      setForm(prev => ({ ...prev, [name]: value }));
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await setDoc(doc(db, 'settings', targetUid), form, { merge: true });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      onSave?.();
      window.dispatchEvent(new Event('settingsSaved'));
    } catch (err) {
      alert('Chyba při ukládání: ' + err.message);
    }
    setSaving(false);
  };

  return (
    <div className="set-settingsContainer">
      <h2 className="set-title">
        {adminEditMode ? `Nastavení za: ${adminEditMode.email}` : 'Moje nastavení'}
      </h2>

      {saved && <div className="set-success">Nastavení uloženo!</div>}

      <form onSubmit={handleSubmit} className="set-form">
        <div className="set-formRow">
          <label>Jméno</label>
          <input
            name="firstName"
            value={form.firstName}
            onChange={handleChange}
            required
          />
        </div>

        <div className="set-formRow">
          <label>Příjmení</label>
          <input
            name="lastName"
            value={form.lastName}
            onChange={handleChange}
            required
          />
        </div>

        <div className="set-formRow">
          <label>Zkratka</label>
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

        <div className="set-formRow">
          <label>Počet všedních služeb</label>
          <input
            type="number"
            name="weekdayShifts"
            value={form.weekdayShifts}
            onChange={handleChange}
            min="0"
          />
        </div>

        <div className="set-formRow">
          <label>Počet víkendových služeb</label>
          <input
            type="number"
            name="weekendShifts"
            value={form.weekendShifts}
            onChange={handleChange}
            min="0"
          />
        </div>

        <div className="set-formRow">
          <label>Interval mezi službami (dní)</label>
          <input
            type="number"
            name="shiftInterval"
            value={form.shiftInterval}
            onChange={handleChange}
            min="1"
          />
        </div>

        <div className="set-formRow skupiny">
          <label>Skupiny</label>
          <div className="set-checkboxGroup">
            {allGroups.map(g => (
              <label key={g} className="set-checkboxLabel">
                <input
                  type="checkbox"
                  name={g}
                  checked={form.groups.includes(g)}
                  onChange={handleChange}
                />
                {g}
              </label>
            ))}
          </div>
        </div>

        <button
          type="submit"
          className="set-saveBtn"
          disabled={saving}
        >
          {saving ? 'Ukládám...' : 'Uložit nastavení'}
        </button>
      </form>
    </div>
  );
}
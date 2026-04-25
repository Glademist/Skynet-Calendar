// src/components/Settings.js
import React, { useState, useEffect } from 'react';
import { SHORTCUTS } from './constants';
import { db } from './firebase';
import { doc, setDoc, getDoc } from 'firebase/firestore';
import './Settings.css';

const allGroups = ['staří', 'střední', 'mladí'];

// Fields that the client must NEVER write back to Firestore via the form.
// These are either security-relevant (approved) or server-managed metadata.
// Round-tripping `approved` through the form was a real bug class — a stale
// load could re-write an approved user back to approved:false.
const PROTECTED_FIELDS = ['approved', 'createdAt', 'email', 'displayName'];

const stripProtected = (data) => {
  const out = { ...data };
  PROTECTED_FIELDS.forEach(f => delete out[f]);
  return out;
};

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

  // ============================================================
  // CRITICAL: loaded gates writes.
  // - false on mount and on targetUid change
  // - only true after a successful read from Firestore
  // - the Save button is disabled while this is false
  // - submit refuses to write while this is false
  //
  // Without this, a failed initial load leaves `form` at the
  // hardcoded defaults (5/2/7, empty groups). The user clicks Save
  // thinking they're saving their settings, and instead overwrites
  // their actual stored values with defaults.
  // ============================================================
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const targetUid = adminEditMode?.uid || user.uid;

  useEffect(() => {
    // Reset gate on every targetUid change. We have not yet confirmed
    // a successful read for this user.
    setLoaded(false);
    setLoadError(false);

    let cancelled = false;
    const load = async () => {
      try {
        const ref = doc(db, 'settings', targetUid);
        const snap = await getDoc(ref);
        if (cancelled) return;

        if (snap.exists()) {
          // Strip protected fields from the loaded data so they can't
          // be round-tripped back via the form on save.
          setForm(stripProtected(snap.data()));
        } else {
          setForm(prev => ({
            ...prev,
            firstName: user.given_name || '',
            lastName: user.family_name || '',
            shortcut: (user.given_name?.[0] + user.family_name?.[0])?.toUpperCase() || ''
          }));
        }
        setLoaded(true);
      } catch (err) {
        if (cancelled) return;
        console.error('Settings load failed:', err);
        setLoadError(true);
        // Critical: do NOT set loaded = true. Keep the Save button blocked.
        window.notify?.(
          'Nepodařilo se načíst nastavení. Obnovte stránku před uložením!',
          'error'
        );
      }
    };
    load();
    return () => { cancelled = true; };
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

    // Hard gate: refuse to save until we've successfully loaded.
    // Without this guard, submitting the form right after a failed load
    // would write the hardcoded defaults over the real stored values.
    if (!loaded) {
      window.notify?.(
        'Data se nenačetla správně. Obnovte stránku před uložením.',
        'error'
      );
      return;
    }

    setSaving(true);
    try {
      // Defense-in-depth: strip protected fields again right before save.
      // The load path already strips them, but this guards against any
      // path that could inject them into form state in the future.
      const safeForm = stripProtected(form);
      await setDoc(doc(db, 'settings', targetUid), safeForm, { merge: true });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      onSave?.();
      window.dispatchEvent(new Event('settingsSaved'));
    } catch (err) {
      console.error('Settings save failed:', err);
      window.notify?.('Chyba při ukládání: ' + err.message, 'error');
    }
    setSaving(false);
  };

  return (
    <div className="set-settingsContainer">
      <h2 className="set-title">
        {adminEditMode ? `Nastavení za: ${adminEditMode.email}` : 'Moje nastavení'}
      </h2>

      {saved && <div className="set-success">Nastavení uloženo!</div>}

      {/* Visible warning when the load failed. The form is still rendered
          so the user can see what's there, but Save is blocked. */}
      {loadError && (
        <div style={{
          background: '#f8d7da',
          color: '#721c24',
          padding: '12px 16px',
          borderLeft: '4px solid #dc3545',
          marginBottom: '16px',
          borderRadius: '4px',
          fontSize: '0.95em'
        }}>
          ⚠️ Nepodařilo se načíst vaše nastavení. <strong>Neukládejte</strong> – přepsali byste svá data výchozími hodnotami.
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              marginLeft: '15px',
              background: '#dc3545',
              color: 'white',
              padding: '6px 14px',
              border: 'none',
              borderRadius: '4px',
              fontWeight: 'bold',
              cursor: 'pointer'
            }}
          >
            Obnovit stránku
          </button>
        </div>
      )}

      {/* Subtle indicator while still loading (no error yet) */}
      {!loaded && !loadError && (
        <div style={{
          color: '#666',
          fontStyle: 'italic',
          marginBottom: '12px',
          fontSize: '0.9em'
        }}>
          Načítám nastavení...
        </div>
      )}

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
          disabled={saving || !loaded}
          title={!loaded ? 'Počkejte na načtení dat' : ''}
        >
          {saving ? 'Ukládám...' : !loaded ? 'Načítám...' : 'Uložit nastavení'}
        </button>
      </form>
    </div>
  );
}
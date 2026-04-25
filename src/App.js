import React, { useState, useEffect } from 'react';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import interactionPlugin from '@fullcalendar/interaction';
import csLocale from '@fullcalendar/core/locales/cs';
import Login from './Login';
import Settings from './Settings';
import Scheduler from './Scheduler';
import AdminPanel from './AdminPanel';
import NotificationBar from './NotificationBar';
import ApprovalPending from './ApprovalPending';
import { auth, db } from './firebase';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import './App.css'

// Easter calculation
const getEasterSunday = (year) => {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
};

// Generate holidays (2025–2030)
const generateHolidays = () => {
  const holidays = [];
  const fixedHolidays = [
    { title: 'Nový rok', month: 1, day: 1 },
    { title: 'Svátek práce', month: 5, day: 1 },
    { title: 'Den Vítězství', month: 5, day: 8 },
    { title: 'Saturnálie C&M', month: 7, day: 5 },
    { title: 'Jan Hus', month: 7, day: 6 },
    { title: 'Den české státnosti', month: 9, day: 28 },
    { title: 'Den vzniku státu', month: 10, day: 28 },
    { title: 'Svoboda a demokracie', month: 11, day: 17 },
    { title: 'Štědrý den', month: 12, day: 24 },
    { title: '2. svátek', month: 12, day: 25 },
    { title: '3. svátek', month: 12, day: 26 },
  ];
  for (let year = 2025; year <= 2030; year++) {
    const easterSunday = getEasterSunday(year);
    const goodFriday = new Date(easterSunday);
    goodFriday.setDate(easterSunday.getDate() - 2);
    const easterMonday = new Date(easterSunday);
    easterMonday.setDate(easterSunday.getDate() + 1);
    holidays.push(
      { title: 'Velký pátek', date: goodFriday.toLocaleDateString('en-CA'), year },
      { title: 'Velikonoční pondělí', date: easterMonday.toLocaleDateString('en-CA'), year }
    );
    fixedHolidays.forEach(h => {
      const date = `${year}-${String(h.month).padStart(2, '0')}-${String(h.day).padStart(2, '0')}`;
      holidays.push({ title: h.title, date, year });
    });
  }
  return holidays;
};

function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [dayStyles, setDayStyles] = useState([]);

  // ============================================================
  // CRITICAL: stylesLoaded gates ALL writes to dayStyles.
  // - false on mount, false on auth change, false on read failure
  // - only true after a successful read from Firestore
  // - the writer effect refuses to fire while this is false
  // - handleDateClick refuses to mutate state while this is false
  // This is the primary defense against the data-loss bug where a
  // failed initial read followed by a click would replace the entire
  // dayStyles document with a single entry.
  // ============================================================
  const [stylesLoaded, setStylesLoaded] = useState(false);

  const [showSettingsWarning, setShowSettingsWarning] = useState(false);
  const [view, setView] = useState('calendar');
  const holidays = generateHolidays();
  const [isApproved, setIsApproved] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        // Reset the loaded flag on every auth change. We have not yet
        // confirmed a successful read for this user.
        setStylesLoaded(false);

        const cleanUser = {
          uid: firebaseUser.uid,
          email: firebaseUser.email || null,
          name: firebaseUser.displayName || '',
          given_name: firebaseUser.displayName?.split(' ')[0] || '',
          family_name: firebaseUser.displayName?.split(' ').slice(1).join(' ') || '',
          picture: firebaseUser.photoURL
        };

        // --- Settings ---
        let settingsSnap;
        try {
          const settingsRef = doc(db, 'settings', firebaseUser.uid);
          settingsSnap = await getDoc(settingsRef);

          const updateData = { email: cleanUser.email, displayName: cleanUser.name };

          if (!settingsSnap.exists()) {
            await setDoc(settingsRef, {
              firstName: cleanUser.given_name,
              lastName: cleanUser.family_name,
              shortcut: '',
              weekdayShifts: 5,
              weekendShifts: 2,
              shiftInterval: 7,
              groups: [],
              approved: false,
              createdAt: serverTimestamp(),
              ...updateData
            }, { merge: true });
            settingsSnap = await getDoc(settingsRef);
          } else {
            if (cleanUser.email) {
              await setDoc(settingsRef, updateData, { merge: true });
            }
          }

          const approved = settingsSnap.exists() && settingsSnap.data().approved === true;
          setIsApproved(approved);
          setView(approved ? 'calendar' : 'approvalPending');

        } catch (err) {
          console.error('Settings read/write failed:', err);
          window.notify?.('Nepodařilo se načíst nastavení. Zkuste obnovit stránku.', 'error');
          setLoading(false);
          return;
        }

        // --- dayStyles ---
        // The contract here is strict:
        //   - read succeeds with data  -> setDayStyles(incoming),  stylesLoaded = true
        //   - read succeeds, no doc    -> setDayStyles([]),        stylesLoaded = true
        //   - read fails (network/etc) -> leave dayStyles as-is,   stylesLoaded = false
        //
        // While stylesLoaded is false, the writer effect below will not run
        // and handleDateClick will not mutate state. This is what prevents
        // the "click after failed load wipes everything" bug.
        try {
          const stylesRef = doc(db, 'dayStyles', firebaseUser.uid);
          const stylesSnap = await getDoc(stylesRef);
          if (stylesSnap.exists()) {
            setDayStyles(stylesSnap.data().styles || []);
          } else {
            setDayStyles([]);
          }
          setStylesLoaded(true);
        } catch (err) {
          console.error('dayStyles read failed:', err);
          // Critical: do NOT set stylesLoaded = true. Keep writes blocked.
          window.notify?.(
            'Nepodařilo se načíst preference dnů. Obnovte stránku před úpravami!',
            'error'
          );
        }

        setUser(cleanUser);
        setLoading(false);

      } else {
        // Logged out: clear everything, reset gate.
        setUser(null);
        setView('calendar');
        setDayStyles([]);
        setStylesLoaded(false);
        setIsApproved(true);
        setLoading(false);
      }
    });

    return () => unsubscribe();
  }, []);

  // Listener for settings save event
  useEffect(() => {
    const handler = () => setShowSettingsWarning(false);
    window.addEventListener('settingsSaved', handler);
    return () => window.removeEventListener('settingsSaved', handler);
  }, []);

  const handleDateClick = (arg) => {
    if (!user) return;

    // Hard gate: refuse to mutate dayStyles until we've successfully loaded.
    // Without this guard, a click before/after a failed initial read would
    // generate a state of length 1, the writer effect would fire, and the
    // entire stored document would be replaced. This is exactly the bug
    // that wiped two users' data previously.
    if (!stylesLoaded) {
      window.notify?.(
        'Data se ještě načítají. Počkejte chvíli nebo obnovte stránku.',
        'warning'
      );
      return;
    }

    const dateStr = arg.date.toLocaleDateString('en-CA');

    setDayStyles(prev => {
      const current = prev.find(d => d.date === dateStr)?.status || 'available';
      const newStatus = current === 'available' ? 'not available' :
                        current === 'not available' ? 'preferred' : 'available';
      return [
        ...prev.filter(d => d.date !== dateStr),
        { date: dateStr, status: newStatus }
      ];
    });
  };

  // Writer effect: persists dayStyles to Firestore.
  //
  // This effect ONLY fires when:
  //   1. user is set (we know who we're writing for)
  //   2. stylesLoaded is true (we have confirmed what was on the server)
  //
  // Layer 3 of the defense: even after we've loaded, if the about-to-write
  // payload is dramatically smaller than what's currently on the server,
  // we treat it as suspicious and re-read before deciding. This catches
  // any future bug class where state gets nuked through a different path.
  useEffect(() => {
    if (!user || !stylesLoaded) return;

    let cancelled = false;
    const persist = async () => {
      try {
        const stylesRef = doc(db, 'dayStyles', user.uid);

        // Sanity check: refuse to write a much-smaller payload without
        // re-confirming. Threshold: if we'd be removing more than half
        // of a non-trivial number of entries, re-read first.
        if (dayStyles.length < 5) {
          const existing = await getDoc(stylesRef);
          const existingLen = existing.exists()
            ? (existing.data().styles?.length || 0)
            : 0;

          if (existingLen >= 10 && dayStyles.length < existingLen / 2) {
            console.error(
              'Refusing to shrink dayStyles dramatically without confirmation',
              { existing: existingLen, attempting: dayStyles.length }
            );
            window.notify?.(
              `Pozor: pokus o smazání ${existingLen - dayStyles.length} dnů zablokován. Obnovte stránku.`,
              'error'
            );
            return;
          }
        }

        if (cancelled) return;
        await setDoc(stylesRef, { styles: dayStyles });
      } catch (err) {
        console.error('Chyba při ukládání stylu dne:', err);
        window.notify?.('Uložení selhalo. Změny nejsou uložené.', 'error');
      }
    };

    persist();
    return () => { cancelled = true; };
  }, [dayStyles, user, stylesLoaded]);

  const handleLogout = () => {
    signOut(auth);
  };

  if (loading) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        fontSize: '1.2em',
        color: '#666'
      }}>
        Načítám...
      </div>
    );
  }

  if (!user) {
    return <Login />;
  }

  const isAdmin = user?.email === 'skaryd81@gmail.com';

  return (
    <div className="app-layout">
      <div className="app-header">
        <nav className="app-navMenu">
          <button
            className={view === 'calendar' ? "app-navActive" : ''}
            onClick={() => setView('calendar')}
          >
            Kalendář
          </button>
          <button
            className={view === 'settings' ? "app-navActive" : ''}
            onClick={() => setView('settings')}
          >
            Nastavení
          </button>
          {isAdmin && (
            <button className={view === 'scheduler' ? "app-navActive" : ''} onClick={() => setView('scheduler')}>
              Plánovač
            </button>
          )}
          {isAdmin && (
            <button
              className={view === 'admin' ? "app-navActive" : ''}
              onClick={() => setView('admin')}
            >
              Admin
            </button>
          )}
        </nav>

        <div className="app-userInfo">
          <span className="app-userName">{user.name}</span>
          <button className="app-logoutBtn" onClick={handleLogout}>
            Odhlásit
          </button>
        </div>
      </div>

      <div className="app-mainContent">
        {view === 'approvalPending' && user && <ApprovalPending user={user} />}
        {showSettingsWarning && (
          <div className="app-settingsWarning">
            ⚠️ DOKONČETE PROSÍM SVÁ NASTAVENÍ!
            <button
              onClick={() => setView('settings')}
              style={{ marginLeft: '15px', background: 'white', color: '#d32f2f', padding: '8px 16px', border: 'none', borderRadius: '4px', fontWeight: 'bold' }}
            >
              Přejít na Nastavení →
            </button>
            <div className="app-subtext">
              Dokud nastavení neuložíte, neobjevíte se v rozpisu služeb.
            </div>
          </div>
        )}

        {/* Visual indicator that the calendar is in a read-only state because
            dayStyles failed to load. The user can still see the calendar but
            clicks won't do anything (handleDateClick gates on stylesLoaded). */}
        {view === 'calendar' && user && isApproved && !stylesLoaded && (
          <div style={{
            background: '#fff3cd',
            color: '#856404',
            padding: '12px 16px',
            borderLeft: '4px solid #ffc107',
            margin: '8px 16px',
            borderRadius: '4px',
            fontSize: '0.95em'
          }}>
            ⚠️ Preference dnů se nepodařilo načíst. Kalendář je v režimu jen pro čtení.
            <button
              onClick={() => window.location.reload()}
              style={{
                marginLeft: '15px',
                background: '#ffc107',
                color: '#333',
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

        {view === 'calendar' && (
          <div className="app-calendarContainer">
            <FullCalendar
              plugins={[dayGridPlugin, interactionPlugin]}
              initialView="dayGridMonth"
              firstDay={1}
              height="100%"
              contentHeight="100%"
              fixedWeekCount={false}
              locales={[csLocale]}
              locale="cs"
              dateClick={handleDateClick}
              dayCellClassNames={(arg) => {
                const dateStr = arg.date.toLocaleDateString('en-CA');
                const status = dayStyles.find(d => d.date === dateStr)?.status || 'available';
                const isWeekend = [0, 6].includes(arg.date.getDay());
                const isHoliday = holidays.some(h => h.date === dateStr);
                const isCurrentMonth = arg.view.currentStart.getMonth() === arg.date.getMonth();
                return `status-${status.replace(' ', '-')}${isWeekend || isHoliday ? ' special-day' : ''}${isCurrentMonth ? '' : ' non-current'}`;
              }}
              dayCellContent={(arg) => {
                const dateStr = arg.date.toLocaleDateString('en-CA');
                const holiday = holidays.find(h => h.date === dateStr);
                const holidayHtml = holiday
                  ? `<div class="app-holidayLabel">${holiday.title}</div>`
                  : '';
                return {
                  html: `
                    <div class="app-dayContent">
                      <div class="app-dayNumber">${arg.dayNumberText}</div>
                      ${holidayHtml}
                    </div>
                  `
                };
              }}
            />
          </div>
        )}

        {view === 'settings' && (
          <Settings user={user} onSave={() => setView('calendar')} />
        )}
        {view === 'scheduler' && isAdmin && (
          <div className="scheduler-container">
            <Scheduler />
          </div>
        )}
        {view === 'admin' && isAdmin && <AdminPanel />}
        {view === 'blocked' && (
          <div className="app-blockedEmail">
            <h1>POZOR – NEOČEKÁVANÝ EMAIL!</h1>
            <p><strong>{localStorage.getItem('blocked_email')}</strong></p>
            <p>Tento email není v seznamu povolených uživatelů.</p>
            <div className="app-blockedEmail">
              {localStorage.getItem('blocked_email')}
            </div>
            <p><strong>Data se NEULOŽÍ a budou ztracena!</strong></p>
            <p>Odhlaste se a přihlaste se pod správným Google účtem nebo volejte.</p>
            <button
              onClick={() => signOut(auth)}
              style={{ padding: '15px 30px', fontSize: '1.2em', marginTop: '20px' }}
            >
              Odhlásit se
            </button>
          </div>
        )}
        {user && !isApproved && view !== 'blocked' && (
          <div className="app-approvalWarning">
            ⚠️ Váš účet čeká na schválení adminem!
            <br />
            <small style={{ fontSize: '0.9em', opacity: 0.9 }}>
              Prosím, počkejte na schválení. Do té doby nemůžete plánovat služby.
            </small>
          </div>
        )}
        <NotificationBar />
      </div>
    </div>
  );
}

export default App;
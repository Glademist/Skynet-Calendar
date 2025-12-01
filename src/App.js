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
import { auth, db } from './firebase';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { getRedirectResult } from 'firebase/auth';
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
      //{ title: 'Velký pátek', date: goodFriday.toISOString().split('T')[0], year },
      //{ title: 'Velikonoční pondělí', date: easterMonday.toISOString().split('T')[0], year }
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

// Load user & choices
const allowedEmails = [
  "skaryd81@gmail.com", "david.kulisiak@gmail.com", "valenta.jiri.92@gmail.com",
  "fidusmax@gmail.com", "palo.dotore@gmail.com", "verybery331@gmail.com",
  "gaalka@me.com", "rgaalova@gmail.com", "jiri.graphy@gmail.com",
  "krejm6ar@gmail.com", "pandvorak87@gmail.com", "tomasprochazka96@gmail.com",
  "kl.pliskova@gmail.com", "inovec.ph@gmail.com", "surrogatereplacement@gmail.com",
  "lidakoyuda@gmail.com", "martina.kepicova@gmail.com", "dave8srpen@gmail.com",
  "vasek.salavec@gmail.com", "veronika.kavalkova@gmail.com", "zdenekhavlik9@gmail.com",
  "zdenek.havlik@nemlib.cz", "jansibera88@gmail.com", "nmarkovicka@gmail.com",
  "mudrakdominik@gmail.com", "durnovalida@gmail.com", "maresobarb@gmail.com",
  "jiri.skach@gmail.com", "vojtech.hruby.jc@gmail.com", "pepazdepa.324@gmail.com",
  "dr.zdarska@gmail.com", "kocmanova.ka@gmail.com", "brzulova.lucie@gmail.com",
  "chirurggg@gmail.com"
].map(e => e.toLowerCase());

function App() {
  const [user, setUser] = useState(null);
  const [dayStyles, setDayStyles] = useState([]);
  const [showSettingsWarning, setShowSettingsWarning] = useState(false);
  const [view, setView] = useState('calendar'); // 'calendar' or 'settings'
  const holidays = generateHolidays();
  const [isApproved, setIsApproved] = useState(true); // výchozí true, aby se nezobrazil hned

// Opravený useEffect s auth (přidej allowedEmails do dependency)
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        const cleanUser = {
          uid: firebaseUser.uid,
          email: firebaseUser.email,
          given_name: firebaseUser.displayName?.split(' ')[0] || '',
          family_name: firebaseUser.displayName?.split(' ').slice(1).join(' ') || '',
          name: firebaseUser.displayName || '',
          picture: firebaseUser.photoURL
        };
        setUser(cleanUser);
        const docRef = doc(db, 'settings', firebaseUser.uid);
        const docSnap = await getDoc(docRef);

        const email = firebaseUser.email.toLowerCase();
        if (!allowedEmails.includes(email)) {
          setUser(null);
          setView('blocked');
          localStorage.setItem('blocked_email', firebaseUser.email);
          return;
        }
        const settingsSnap = await getDoc(docRef); // už máš docRef
        setIsApproved(settingsSnap.data()?.approved || false);

        if (!docSnap.exists()) {
          setView('settings');
        } else {
          setView('calendar');
        }

        // Načti dayStyles
        const stylesRef = doc(db, 'dayStyles', firebaseUser.uid);
        const stylesSnap = await getDoc(stylesRef);
        setDayStyles(stylesSnap.exists() ? stylesSnap.data().styles : []);
      } else {
        setUser(null);
        setView('calendar');
        setDayStyles([]);
      }
    });

    return () => unsubscribe();
  }, []);

  // Načítání dayStyles z Firestore
  useEffect(() => {
    if (user) {
      const loadDayStyles = async () => {
        const stylesRef = doc(db, 'dayStyles', user.uid);
        const snap = await getDoc(stylesRef);
        if (snap.exists() && snap.data().styles) {
          setDayStyles(snap.data().styles);
        } else {
          setDayStyles([]);
        }
      };
      loadDayStyles();
    }
  }, [user]);

  useEffect(() => {
    // Po redirectu z Google – vynutíme refresh stavu
    const checkRedirect = async () => {
      const result = await getRedirectResult(auth);
      if (result?.user) {
        // Uživatel je přihlášený – vynutíme přepnutí
        window.location.reload();
      }
    };
    checkRedirect();
  }, []);

  // Listener na uložení nastavení (zůstává)
  useEffect(() => {
    const handler = () => setShowSettingsWarning(false);
    window.addEventListener('settingsSaved', handler);
    return () => window.removeEventListener('settingsSaved', handler);
  }, []);

  // Save styles per user
  useEffect(() => {
    if (user && dayStyles.length > 0) {
      localStorage.setItem(`dayStyles_${user.uid}`, JSON.stringify(dayStyles));
    }
  }, [dayStyles, user]);

    const handleDateClick = async (arg) => {
    if (!user) return;

    const dateStr = arg.date.toLocaleDateString('en-CA');
    const current = dayStyles.find(d => d.date === dateStr)?.status || 'available';

    // NOVÉ POŘADÍ – přesně jak chceš
    const newStatus = current === 'available'      ? 'not available'      :
                      current === 'not available'      ? 'preferred' :  
                                                      'available';    

    const newStyles = [
      ...dayStyles.filter(d => d.date !== dateStr),
      { date: dateStr, status: newStatus }
    ];

    setDayStyles(newStyles);

    // Uložení do Firestore
    try {
      await setDoc(doc(db, 'dayStyles', user.uid), { styles: newStyles });
    } catch (err) {
      console.error('Chyba při ukládání stylu dne:', err);
    }
  };

  const handleLogout = () => {
    signOut(auth);
  };  

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
        {view === 'calendar' && (
          <div className="app-calendarContainer">  {/* ← NOVÝ WRAPPER */}
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
              const dateStr = arg.date.toLocaleDateString('en-CA'); // ← stejné jako v holidays
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
          <div className="scheduler-container">  {/* ← NOVÝ WRAPPER */}
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
            style={{padding: '15px 30px', fontSize: '1.2em', marginTop: '20px'}}
          >
            Odhlásit se
          </button>
        </div>
        )}
        {user && !isApproved && view !== 'blocked' && (
          <div className="app-approvalWarning">
            ⚠️ Váš účet čeká na schválení adminem!
            <br/>
            <small style={{fontSize: '0.9em', opacity: 0.9}}>
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
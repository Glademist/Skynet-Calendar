// src/utils.js
export const getEasterSunday = (year) => {
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

export const generateHolidays = () => {
  const holidays = [];
  const fixedHolidays = [
    { title: 'Nový rok', month: 1, day: 1 },
    { title: 'Svátek práce', month: 5, day: 1 },
    { title: 'Vítězství 8. května', month: 5, day: 8 },
    { title: 'Saints Cyril and Methodius Day', month: 7, day: 5 },
    { title: 'Jan Hus Day', month: 7, day: 6 },
    { title: 'Den české státnosti', month: 9, day: 28 },
    { title: 'Den vzniku samostatného československého státu', month: 10, day: 28 },
    { title: 'Den boje za svobodu a demokracii', month: 11, day: 17 },
    { title: 'Vánoce 1. svátek', month: 12, day: 24 },
    { title: 'Vánoce 2. svátek', month: 12, day: 25 },
    { title: 'Vánoce 3. svátek', month: 12, day: 26 },
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
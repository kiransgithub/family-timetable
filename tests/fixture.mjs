// A made-up family (names, birthdays, places and times are all invented)
// with the same shape as a real db, so the public repo's tests carry no
// personal data.

export function fixtureDb() {
  return {
    version: 1,
    meta: { title: 'Test Family', timezone: 'America/Phoenix' },
    members: [
      { id: 'ava', name: 'Ava', role: 'kid', dob: '2017-03-09', color: '#7C3AED', school: { place: 'school', calendar: 'school-cal' } },
      { id: 'leo', name: 'Leo', role: 'kid', dob: '2022-05-20', color: '#EA580C', school: { place: 'preschool', calendar: 'pre-cal' } },
      { id: 'pat', name: 'Pat', role: 'parent' },
    ],
    places: [
      { id: 'home', name: 'Home', address: '1 Test St, Springfield', lat: 39.7, lng: -104.95, bufferMin: 0 },
      { id: 'school', name: 'Test Primary', short: 'Primary', address: '100 School Rd, Springfield', lat: 39.68, lng: -104.92, bufferMin: 3 },
      { id: 'preschool', name: 'Acorn Preschool', short: 'Acorn', address: '200 Garden Ln, Springfield', lat: 39.72, lng: -104.97, bufferMin: 5 },
      { id: 'music', name: 'Music Studio', address: '210 Garden Ln, Springfield', lat: 39.7202, lng: -104.9702, bufferMin: 5 },
      { id: 'gym', name: 'Flip Gym', address: '300 Tumble Way, Springfield', lat: 39.69, lng: -104.9, bufferMin: 5 },
      { id: 'pool', name: 'Splash Pool', address: '400 Swim Rd, Springfield', lat: 39.75, lng: -105.0, bufferMin: 10 },
    ],
    calendars: [
      {
        id: 'school-cal', name: 'Test Primary 2026–27', short: 'Primary', firstDay: '2026-08-12', lastDay: '2027-05-21',
        days: [
          { type: 'no_school', label: 'Thanksgiving Break', start: '2026-11-25', end: '2026-11-30' },
          { type: 'early_release', label: 'Winter Break early release', start: '2026-12-18' },
          { type: 'no_school', label: 'Winter Break', start: '2026-12-21', end: '2027-01-01' },
        ],
      },
      {
        id: 'pre-cal', name: 'Acorn 2026–27', short: 'Acorn', firstDay: '2026-08-12', lastDay: '2027-05-21', verify: true,
        days: [{ type: 'no_school', label: 'Thanksgiving recess', start: '2026-11-25', end: '2026-11-27' }],
      },
    ],
    schedules: [
      { id: 'school-drop', title: 'School drop-off', kind: 'school', who: ['ava'], place: 'school', days: ['MO', 'TU', 'WE', 'TH', 'FR'], start: '07:45', end: '08:10', arrive: '07:55', calendar: 'school-cal', calendarMode: 'school_days', alarms: 'leave' },
      { id: 'school-pickup', title: 'School pickup', kind: 'school', who: ['ava'], place: 'school', days: ['MO', 'TU', 'WE', 'TH', 'FR'], start: '15:00', end: '15:15', arrive: '15:00', calendar: 'school-cal', calendarMode: 'school_days', earlyRelease: 'pickup', alarms: 'leave' },
      { id: 'pre-drop', title: 'Preschool drop-off', kind: 'school', who: ['leo'], place: 'preschool', days: ['MO', 'TU', 'WE', 'TH', 'FR'], start: '08:30', end: '08:45', arrive: '08:35', calendar: 'pre-cal', calendarMode: 'school_days', alarms: 'leave' },
      { id: 'pre-pickup', title: 'Preschool pickup', kind: 'school', who: ['leo'], place: 'preschool', days: ['MO', 'TU', 'WE', 'TH', 'FR'], start: '14:15', end: '14:30', arrive: '14:15', calendar: 'pre-cal', calendarMode: 'school_days', alarms: 'leave' },
      { id: 'music', title: 'Violin, choir', emoji: '🎻', kind: 'activity', who: ['ava'], place: 'music', days: ['MO'], start: '16:15', durationMin: 45, arriveEarlyMin: 5, alarms: 'both' },
      { id: 'gym', title: 'Gymnastics', kind: 'activity', who: ['ava'], place: 'gym', days: ['WE'], start: '16:30', durationMin: 75, arriveEarlyMin: 5, alarms: 'both' },
      { id: 'swim', title: 'Swim', kind: 'activity', who: ['ava', 'leo'], place: 'pool', days: ['SU'], start: '09:30', durationMin: 30, arriveEarlyMin: 10, alarms: 'both', variants: [{ id: 'makeup', label: 'Makeup class (1 hr)', durationMin: 60 }] },
      { id: 'hoops', title: 'Basketball', kind: 'activity', who: ['ava'], place: null, days: ['TU'], start: null, durationMin: 60, from: '2027-01-05', tbd: true, alarms: 'both' },
    ],
    events: [
      { id: 'party', title: 'Class party', who: ['leo'], place: 'preschool', date: '2026-11-24', start: '10:00', end: '11:00', travel: false, alarms: 'none' },
    ],
    exceptions: [],
    holidays: [
      { date: '2026-11-30', name: 'Founders Day' },
      { date: '2026-12-25', name: 'Christmas Day' },
    ],
    settings: {},
    routes: { cache: {}, overrides: {} },
  };
}

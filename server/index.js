import crypto from 'crypto';
import fs from 'fs';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import XLSX from 'xlsx';
import Database from 'better-sqlite3';
import { Server } from 'socket.io';

dotenv.config();

const app = express();
const server = http.createServer(app);

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const clientOrigin = process.env.CLIENT_ORIGIN || true;
const secret = process.env.JWT_SECRET || 'development-only-change-me';
const deviceApiKey = process.env.DEVICE_API_KEY || '';

let configuredDevices = [];
try {
  configuredDevices = JSON.parse(process.env.DEVICE_REGISTRY_JSON || '[]');
} catch {
  console.warn('DEVICE_REGISTRY_JSON is not valid JSON.');
}

const io = new Server(server, { cors: { origin: clientOrigin } });

app.use(cors({ origin: clientOrigin }));
app.use(express.json({ limit: '20kb' }));

/* =========================
   SMALL HELPERS
========================= */

const slug = value =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

// Header/sheet-name normaliser: "BUS NO." -> "busno", "SOURCE / CONFIDENCE" -> "sourceconfidence".
const normKey = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const cleanText = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const toFinite = value => (value === '' || value === null || value === undefined ? NaN : Number(value));
// "pompwell" -> "Pompwell"; names that already have mixed case are left alone.
const prettyName = name => (name === name.toLowerCase() ? name.replace(/\b[a-z]/g, c => c.toUpperCase()) : name);
const clean = value => String(value ?? '').trim().slice(0, 100);
const cleanOrNull = value => clean(value) || null;
const round1 = value => (Number.isFinite(value) ? Number(value.toFixed(1)) : null);
const kmFrom = meters => (Number.isFinite(meters) ? Number((meters / 1000).toFixed(3)) : null);
const validCoords = point => point && Number.isFinite(point.lat) && Number.isFinite(point.lng) && Math.abs(point.lat) <= 90 && Math.abs(point.lng) <= 180;

/* =========================
   TIMETABLE / SERVICE WINDOW
========================= */

const serviceTimeZone = process.env.SERVICE_TIMEZONE || 'Asia/Kolkata';
/*
  The workbook schedule is a DRAFT. When ENFORCE_SERVICE_WINDOW=true, buses are only listed
  while the current time is inside their draft service window (per the ETA_Logic sheet).
  It is off by default so a bus that is physically transmitting GPS is never hidden.
*/
const enforceServiceWindow = process.env.ENFORCE_SERVICE_WINDOW === 'true';
// "Last departure" is when the last trip leaves the terminus; the bus is still on the road afterwards.
const SERVICE_GRACE_MINUTES = 120;

function parseClock(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.getHours() * 60 + value.getMinutes();
  }
  if (typeof value === 'number') {
    // Excel stores times as a fraction of a day.
    if (!Number.isFinite(value) || value < 0) return null;
    return Math.round((value % 1) * 1440) % 1440;
  }
  const match = String(value).trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?$/i);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const meridiem = match[3]?.toLowerCase();
  if (meridiem === 'pm' && hours < 12) hours += 12;
  if (meridiem === 'am' && hours === 12) hours = 0;
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

const formatClock = minutes =>
  Number.isFinite(minutes) ? `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}` : null;

function minutesNow(date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: serviceTimeZone, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date);
    const hours = Number(parts.find(part => part.type === 'hour')?.value) % 24;
    const minutes = Number(parts.find(part => part.type === 'minute')?.value);
    if (Number.isFinite(hours) && Number.isFinite(minutes)) return hours * 60 + minutes;
  } catch {
    // Unknown time zone: fall back to the server clock below.
  }
  return date.getHours() * 60 + date.getMinutes();
}

function isInServiceWindow(schedule, date = new Date()) {
  if (!schedule || !Number.isFinite(schedule.firstDepartureMin) || !Number.isFinite(schedule.lastDepartureMin)) return true;
  const now = minutesNow(date);
  const start = schedule.firstDepartureMin;
  const end = schedule.lastDepartureMin + SERVICE_GRACE_MINUTES;
  if (end < 1440) return now >= start && now <= end;
  // Window runs past midnight.
  return now >= start || now <= end - 1440;
}

/* =========================
   WORKBOOK (Navigo.xlsx)
   Sheets used: Route_Master, Stop_Master, Bus_Schedule
========================= */

const emptyTransit = () => ({
  loaded: false,
  stops: [],
  stopsById: new Map(),
  routes: [],
  routesById: new Map(),
  buses: [],
  rows: []
});

function workbookCandidates() {
  return [
    process.env.DATA_WORKBOOK_PATH,
    path.resolve(projectRoot, 'Navigo.xlsx'),
    path.resolve(projectRoot, '..', 'Navigo.xlsx'),
    path.resolve(projectRoot, 'data', 'Navigo.xlsx')
  ].filter(Boolean);
}

const findSheet = (book, wanted) => {
  const name = book.SheetNames.find(item => normKey(item) === wanted);
  return name ? book.Sheets[name] : null;
};

const sheetRows = sheet => (sheet ? XLSX.utils.sheet_to_json(sheet, { defval: '', raw: true }) : []);

function field(row, ...names) {
  for (const [key, value] of Object.entries(row)) {
    if (names.includes(normKey(key))) return value;
  }
  return '';
}

// Two Stop_Master rows with the same name closer together than this are the same physical stop.
const SAME_STOP_METERS = 30;

function loadWorkbook() {
  const workbookPath = workbookCandidates().find(candidate => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });

  if (!workbookPath) {
    console.warn('Workbook not loaded: Navigo.xlsx was not found. Set DATA_WORKBOOK_PATH.');
    return emptyTransit();
  }

  try {
    const book = XLSX.readFile(workbookPath);

    const routeSheet = findSheet(book, 'routemaster');
    const stopSheet = findSheet(book, 'stopmaster');
    const scheduleSheet = findSheet(book, 'busschedule');

    if (!routeSheet) throw new Error('Route_Master sheet is missing');
    if (!stopSheet) throw new Error('Stop_Master sheet is missing');

    /*
      ---- Stops: id, name and coordinates come only from Stop_Master ----
      The same stop name can appear on several rows with different coordinates (for example
      "Kankanady" ST006 and ST054). Rows that are within SAME_STOP_METERS of an earlier row with
      the same name are merged; genuinely different rows become variants ("kankanady",
      "kankanady-2"). Each route later picks the variant that fits its own neighbouring stops.
    */
    const stops = [];
    const stopsById = new Map();
    const stopsByName = new Map();

    for (const row of sheetRows(stopSheet)) {
      const name = cleanText(field(row, 'stopname', 'stop', 'name'));
      const base = slug(name);
      if (!base) continue;

      const lat = toFinite(field(row, 'latitude', 'lat'));
      const lng = toFinite(field(row, 'longitude', 'lng', 'lon'));
      if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) {
        console.warn(`Stop "${name}" skipped: latitude/longitude are missing or invalid.`);
        continue;
      }

      const variants = stopsByName.get(base) || [];
      if (variants.some(existing => haversineMeters(existing.lat, existing.lng, lat, lng) <= SAME_STOP_METERS)) continue;

      const stop = {
        id: variants.length ? `${base}-${variants.length + 1}` : base,
        code: cleanText(field(row, 'stopid')) || null,
        name: prettyName(name),
        lat,
        lng,
        confidence: cleanText(field(row, 'sourceconfidence')) || null
      };
      variants.push(stop);
      stopsByName.set(base, variants);
      stops.push(stop);
      stopsById.set(stop.id, stop);
    }

    /*
      ---- Bus_Schedule: the ONLY source of BUS IDs ----
      Every usable row needs a "BUS ID." (B001, B011, ...). IDs are never generated from row order.
      Each Route_Master row is then matched to exactly one Bus_Schedule row (see the matching passes below).
    */
    const timetableRows = [];
    const scheduleEntries = [];
    const seenBusIds = new Set();

    // "Moodushedde -> Statebank (via Kulshekar)" -> ['moodushedde', 'statebank'] (first and last point only).
    const routeEnds = text => {
      const parts = String(text ?? '')
        .replace(/\(.*?\)/g, ' ')
        .split(/\s*(?:→|->)\s*/)
        .map(part => slug(part))
        .filter(Boolean);
      return parts.length >= 2 ? [parts[0], parts[parts.length - 1]] : null;
    };
    // "kulshekar" and "kulshekar-chowki" are the same terminus.
    const sameName = (a, b) => !!a && !!b && (a === b || a.startsWith(`${b}-`) || b.startsWith(`${a}-`));
    const sameEnds = (a, b) => !!a && !!b && ((sameName(a[0], b[0]) && sameName(a[1], b[1])) || (sameName(a[0], b[1]) && sameName(a[1], b[0])));

    for (const row of sheetRows(scheduleSheet)) {
      const busId = cleanText(field(row, 'busid')).toUpperCase();
      const busNo = cleanText(field(row, 'busno'));
      const operator = cleanText(field(row, 'bus'));
      const routeText = cleanText(field(row, 'route'));
      if (!busId && !operator && !busNo && !routeText) continue;

      const firstDepartureMin = parseClock(field(row, 'draftfirstdeparture', 'firstdeparture'));
      const lastDepartureMin = parseClock(field(row, 'draftlastdeparture', 'lastdeparture'));
      const headway = toFinite(field(row, 'headwaymin', 'headway'));

      const schedule = {
        busId: busId || null,
        direction: cleanText(field(row, 'direction')) || null,
        firstDeparture: formatClock(firstDepartureMin),
        lastDeparture: formatClock(lastDepartureMin),
        firstDepartureMin,
        lastDepartureMin,
        headwayMin: Number.isFinite(headway) && headway > 0 ? headway : null,
        status: cleanText(field(row, 'schedulestatus')) || null,
        note: cleanText(field(row, 'note')) || null
      };

      timetableRows.push({
        Route: routeText,
        route: routeText,
        busId: busId || null,
        busNo: busNo || null,
        operator,
        ...schedule
      });

      if (!busId) {
        console.warn(`Bus_Schedule row "${cleanText(`${busNo} ${operator} ${routeText}`)}" has no BUS ID and cannot be used for tracking.`);
        continue;
      }
      if (seenBusIds.has(busId)) {
        console.warn(`Bus_Schedule lists BUS ID ${busId} more than once; only the first row is used.`);
        continue;
      }
      seenBusIds.add(busId);

      scheduleEntries.push({ busId, busNo, operator, routeText, ends: routeEnds(routeText), schedule, claimed: false });
    }

    /* ---- Route_Master rows (one row = one bus on one route), matched to Bus_Schedule rows ---- */
    const routeInfos = sheetRows(routeSheet).map(row => {
      const point1 = cleanText(field(row, 'point1'));
      const point2 = cleanText(field(row, 'point2'));
      return {
        row,
        number: cleanText(field(row, 'busno')),
        operator: cleanText(field(row, 'bus')),
        ends: point1 && point2 ? [slug(point1), slug(point2)] : null,
        entry: null
      };
    });

    /*
      Matching passes, strongest first; each Bus_Schedule row can be claimed once:
        1. BUS NO. + BUS (operator) both equal
        2. BUS (operator) + route end points equal (covers blank BUS NO., e.g. Mahesh / Celina to Puttur)
        3. BUS NO. alone, when exactly one unclaimed Bus_Schedule row carries it (operator names may differ)
    */
    const sameNumber = (a, b) => !!a.number && !!b.busNo && slug(a.number) === slug(b.busNo);
    const sameOperator = (a, b) => !!a.operator && slug(a.operator) === slug(b.operator);
    const passes = [
      (info, entry) => sameNumber(info, entry) && sameOperator(info, entry),
      (info, entry) => sameOperator(info, entry) && sameEnds(info.ends, entry.ends) && (!info.number || !entry.busNo || sameNumber(info, entry)),
      (info, entry) => sameNumber(info, entry)
    ];
    passes.forEach((matches, passIndex) => {
      for (const info of routeInfos) {
        if (info.entry) continue;
        const candidates = scheduleEntries.filter(entry => !entry.claimed && matches(info, entry));
        if (passIndex === 2 ? candidates.length !== 1 : !candidates.length) continue;
        info.entry = candidates[0];
        info.entry.claimed = true;
      }
    });
    for (const entry of scheduleEntries) {
      if (!entry.claimed) console.warn(`Bus_Schedule BUS ID ${entry.busId} (${entry.busNo || 'no number'} ${entry.operator}) matches no Route_Master row.`);
    }

    /* ---- Routes + buses ---- */
    const routes = [];
    const routesById = new Map();
    const busList = [];

    routeInfos.forEach(info => {
      const { row, number, operator, entry } = info;

      const stopColumns = Object.keys(row)
        .filter(key => /^stop\d+$/.test(normKey(key)))
        .sort((a, b) => Number(normKey(a).slice(4)) - Number(normKey(b).slice(4)));

      const missing = [];
      const options = [];
      for (const column of stopColumns) {
        const name = cleanText(row[column]);
        if (!name) continue;
        const list = stopsByName.get(slug(name)) || [];
        if (!list.length) {
          missing.push(name);
          continue;
        }
        options.push(list);
      }

      // Unambiguous stops first; then each ambiguous name takes the variant with the smallest detour
      // between its previous and next resolved neighbours on this route.
      const resolved = options.map(list => (list.length === 1 ? list[0] : null));
      options.forEach((list, i) => {
        if (list.length < 2) return;
        let previous = null;
        for (let j = i - 1; j >= 0 && !previous; j -= 1) previous = resolved[j];
        let next = null;
        for (let j = i + 1; j < resolved.length && !next; j += 1) next = resolved[j];
        const cost = candidate => (previous ? haversineMeters(previous.lat, previous.lng, candidate.lat, candidate.lng) : 0) + (next ? haversineMeters(candidate.lat, candidate.lng, next.lat, next.lng) : 0);
        resolved[i] = list.reduce((best, candidate) => (cost(candidate) < cost(best) ? candidate : best), list[0]);
      });

      const stopIds = [];
      for (const stop of resolved) {
        if (stopIds[stopIds.length - 1] === stop.id) continue;
        stopIds.push(stop.id);
      }

      const label = `${number || 'unnumbered'} ${operator}`.trim();
      if (missing.length) {
        console.warn(`Route ${label}: ignoring stops with no valid coordinates in Stop_Master: ${missing.join(', ')}.`);
      }
      if (stopIds.length < 2) {
        console.warn(`Route ${label} skipped: fewer than two usable stops.`);
        return;
      }
      if (!entry) {
        console.warn(`Route ${label} skipped: no matching BUS ID in Bus_Schedule.`);
        return;
      }

      const firstStop = stopsById.get(stopIds[0]);
      const lastStop = stopsById.get(stopIds[stopIds.length - 1]);
      let point1 = cleanText(field(row, 'point1')) || firstStop.name;
      let point2 = cleanText(field(row, 'point2')) || lastStop.name;

      /*
        Direction: Route_Master lists stops in one direction only. When Bus_Schedule's ROUTE runs the other way
        (e.g. B011 "Moodushedde -> Statebank" while Route_Master lists Statebank first), the stop order is reversed
        so "stops after the boarding stop" really are the stops this bus will reach next.
      */
      const scheduleStart = entry.ends?.[0];
      const scheduleEnd = entry.ends?.[1];
      const reversed = !!scheduleStart && sameName(scheduleStart, slug(lastStop.name)) && sameName(scheduleEnd, slug(firstStop.name)) && !sameName(scheduleStart, scheduleEnd);
      if (reversed) {
        stopIds.reverse();
        [point1, point2] = [point2, point1];
      }

      const routeNumber = number || entry.busNo || point2.toUpperCase();

      let routeId = `${slug(routeNumber)}-${slug(operator) || 'bus'}`;
      for (let suffix = 2; routesById.has(routeId); suffix += 1) {
        routeId = `${slug(routeNumber)}-${slug(operator) || 'bus'}-${suffix}`;
      }

      const schedule = entry.schedule;

      const route = {
        id: routeId,
        busId: entry.busId,
        number: routeNumber,
        name: `${prettyName(point1)} → ${prettyName(point2)}`,
        operator,
        stops: stopIds,
        fare: null,
        schedule
      };
      routes.push(route);
      routesById.set(route.id, route);

      busList.push({
        id: entry.busId, // BUS ID. column of Bus_Schedule
        routeId: route.id,
        number: route.number,
        routeName: route.name,
        operator,
        occupancy: 'Tracking unavailable',
        lat: null,
        lng: null,
        updatedAt: null,
        speedKmh: null,
        source: null,
        schedule
      });
    });

    if (!routes.length) throw new Error('Route_Master has no usable routes');

    return { loaded: true, stops, stopsById, routes, routesById, buses: busList, rows: timetableRows };
  } catch (error) {
    console.warn(`Workbook not loaded: ${error.message}`);
    return emptyTransit();
  }
}

const transit = loadWorkbook();

/* =========================
   DATABASE
========================= */

const usersDbPath = process.env.USERS_DB_PATH || path.resolve(projectRoot, 'data', 'users.db');

fs.mkdirSync(path.dirname(usersDbPath), { recursive: true });

const usersDb = new Database(usersDbPath);

usersDb.pragma('journal_mode = WAL');

usersDb.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    bus_id TEXT,
    session_version TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`);

const selectUserByEmailStatement = usersDb.prepare('SELECT * FROM users WHERE email = ?');

const upsertUserStatement = usersDb.prepare(`
  INSERT INTO users (
    id,
    email,
    password_hash,
    role,
    bus_id,
    session_version,
    created_at
  )
  VALUES (
    @id,
    @email,
    @password,
    @role,
    @busId,
    @sessionVersion,
    @createdAt
  )
  ON CONFLICT(email) DO UPDATE SET
    password_hash = excluded.password_hash,
    role = excluded.role,
    bus_id = excluded.bus_id,
    session_version = excluded.session_version
`);

const rowToUser = row =>
  row && {
    id: row.id,
    email: row.email,
    password: row.password_hash,
    role: row.role,
    busId: row.bus_id,
    sessionVersion: row.session_version
  };

const getUserByEmail = email => rowToUser(selectUserByEmailStatement.get(email));

const saveUser = user => {
  upsertUserStatement.run({ ...user, createdAt: Date.now() });
  return user;
};

/* =========================
   AUTH / BREVO
========================= */

const pendingCodes = new Map();

const buses = new Map(transit.buses.map(bus => [bus.id, bus]));

const deviceRegistry = new Map(
  configuredDevices
    .filter(item => item?.deviceId && item?.busId)
    .map(item => [
      String(item.deviceId),
      {
        busId: String(item.busId),
        ip: item.ip ? String(item.ip) : null
      }
    ])
);

if (transit.loaded) {
  for (const [deviceId, device] of deviceRegistry) {
    if (!buses.has(device.busId)) console.warn(`Device ${deviceId} is assigned to ${device.busId}, which is not a BUS ID in Bus_Schedule.`);
  }
}

/*
  Brevo email service.

  Render Environment Variables:

  BREVO_API_KEY
  BREVO_SENDER_EMAIL
  BREVO_SENDER_NAME
*/

const brevoApiKey = process.env.BREVO_API_KEY || '';
const brevoSenderEmail = process.env.BREVO_SENDER_EMAIL || '';
const brevoSenderName = process.env.BREVO_SENDER_NAME || 'NAVIGO';

const publicUser = user => ({
  id: user.id,
  email: user.email,
  role: user.role,
  busId: user.busId || null
});

const tokenFor = user =>
  jwt.sign(
    {
      ...publicUser(user),
      sessionVersion: user.sessionVersion
    },
    secret,
    { expiresIn: '12h' }
  );

const auth = roles => (req, res, next) => {
  try {
    const user = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), secret);

    const currentUser = getUserByEmail(user.email);

    if (!currentUser || currentUser.sessionVersion !== user.sessionVersion) {
      throw new Error('Session is no longer valid');
    }

    if (roles && !roles.includes(user.role)) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    req.user = user;
    next();
  } catch {
    res.status(401).json({ message: 'Sign in required' });
  }
};

/* =========================
   CONSTANTS
========================= */

/*
  A bus is "arrived" once it is this close to the stop, measured with GPS/Haversine distance
  (not Google's road distance) against the exact, unrounded distance in meters. This is the
  single arrival threshold used for both pickup-stop arrival and destination arrival.
*/
const ARRIVAL_THRESHOLD_METERS = 20;

/*
  Boarding detection: the passenger is treated as riding a bus only after the passenger's GPS
  stays within BOARDING_MATCH_METERS of the bus for BOARDING_CONSECUTIVE_UPDATES consecutive
  location updates, AND both of them have actually travelled together (so a bus dwelling at a
  stop next to a waiting passenger is not mistaken for boarding). A single outlying fix farther
  than BOARDING_RESET_METERS resets the streak; fixes in between are ignored as GPS jitter.
*/
const BOARDING_MATCH_METERS = 25;
const BOARDING_RESET_METERS = 40;
const BOARDING_CONSECUTIVE_UPDATES = 3;
const BOARDING_MIN_TRAVEL_METERS = 50;
const BOARDING_MIN_POLL_GAP_MS = 5000;
const BOARDING_MAX_FIX_AGE_MS = 60_000;
const BOARDING_MAX_ACCURACY_METERS = 50;
const BOARDING_SUPPRESS_MS = 10 * 60 * 1000;

/*
  GPS speed is only used as a last-resort ETA fallback (road distance / speed) when Google does
  not return a usable duration. It is never combined with straight-line distance.
*/
const MIN_RELIABLE_SPEED_KMH = 1;

/*
  After boarding, the ETA/route is the boarding stop -> destination stop leg (the same road route
  as the dark-blue line). Set JOURNEY_ETA_FROM_BUS=true to instead count down live from the bus's
  current position to the destination.
*/
const JOURNEY_ETA_FROM_BUS = process.env.JOURNEY_ETA_FROM_BUS === 'true';

/*
  Any computed speed above this is treated as GPS noise/a position jump rather than real bus
  movement, and is rejected (stored as null for that update).
*/
const MAX_REALISTIC_SPEED_KMH = 100;

const BUS_FRESHNESS_MS = 5 * 60 * 1000;
const COMPLETED_RETENTION_MS = 2 * 60 * 1000;
const TRACKER_TTL_MS = 10 * 60 * 1000;
/*
  A journey is dropped when its passenger has not polled for this long (closed tab, lost connection, restarted
  session), so an old journey can never reappear as "Journey in progress". It is also cleared on every sign-in.
*/
const JOURNEY_IDLE_MS = 10 * 60 * 1000;

/*
  Pickup-stop selection. The nearest few stops (by straight line, used only to shortlist) are
  ranked by REAL road distance from Google Routes. The passenger travels this leg on foot, so
  it uses the WALK travel mode; set USER_TRAVEL_MODE to 'DRIVE' to rank by driving distance.
  The previously chosen stop is kept unless another stop is clearly closer, so the pickup does
  not flip back and forth while the passenger stands between two stops.
*/
const USER_TRAVEL_MODE = process.env.USER_TRAVEL_MODE === 'DRIVE' ? 'DRIVE' : 'WALK';
const PICKUP_CANDIDATES = 4;
const PICKUP_PREVIOUS_RANK_LIMIT = 6;
const PICKUP_SWITCH_RATIO = 1.15;
const PICKUP_SWITCH_METERS = 30;
const PICKUP_TTL_MS = 30 * 60 * 1000;

const GOOGLE_ROUTES_URL = process.env.GOOGLE_ROUTES_URL || 'https://routes.googleapis.com/directions/v2:computeRoutes';

/* =========================
   ROUTING
========================= */

function findOptions(from, to) {
  return transit.routes.flatMap(route => {
    const start = route.stops.indexOf(from);
    const end = route.stops.indexOf(to);

    return start >= 0 && end > start
      ? [
          {
            type: 'direct',
            route,
            bus: [...buses.values()].find(bus => bus.routeId === route.id),
            durationMin: (end - start) * 7
          }
        ]
      : [];
  });
}

function activeBuses() {
  const now = Date.now();

  return [...buses.values()].filter(
    bus =>
      Number.isFinite(bus.updatedAt) &&
      validCoords(bus) &&
      now - bus.updatedAt < BUS_FRESHNESS_MS &&
      (!enforceServiceWindow || isInServiceWindow(bus.schedule))
  );
}

const routeOf = bus => (bus ? transit.routesById.get(bus.routeId) || null : null);
const routeStopObjects = route => (route ? route.stops.map(id => transit.stopsById.get(id)).filter(Boolean) : []);
const stopView = stop => (stop ? { id: stop.id, name: stop.name, lat: stop.lat, lng: stop.lng } : null);

/* =========================
   GEO / SPEED
========================= */

function haversineMeters(lat1, lng1, lat2, lng2) {
  // Number.isFinite rejects null/undefined/NaN, which would otherwise silently become 0.
  if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) return Number.NaN;

  const earthRadiusMeters = 6371000;
  const toRad = degrees => (degrees * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;

  return 2 * earthRadiusMeters * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Straight-line GPS distance between two {lat,lng} points, or null when either is unusable.
// Used for arrival/boarding detection and as a shortlist/fallback for nearest-stop selection only,
// never for a displayed ETA or distance.
function gpsDistance(a, b) {
  const meters = haversineMeters(a?.lat, a?.lng, b?.lat, b?.lng);
  return Number.isFinite(meters) ? meters : null;
}

function nearestStop(stops, point) {
  let best = null;
  for (const stop of stops) {
    const meters = gpsDistance(stop, point);
    if (meters !== null && (!best || meters < best.distanceMeters)) {
      best = { stop, distanceMeters: meters };
    }
  }
  return best;
}

/*
  Computes a bus's current speed (km/h) from its previous reported position/timestamp vs. its
  new one. Returns null — never NaN, Infinity, or negative — whenever the speed cannot be
  trusted: no previous position, missing/invalid timestamps, zero or negative elapsed time, or a
  speed above MAX_REALISTIC_SPEED_KMH (GPS noise / position jump). A real elapsed time with 0
  distance correctly returns 0 (a stationary bus) rather than null.
*/
function computeSpeedKmh(previous, next) {
  if (!previous || !Number.isFinite(previous.lat) || !Number.isFinite(previous.lng) || !Number.isFinite(previous.updatedAt)) {
    return null;
  }

  if (!Number.isFinite(next.lat) || !Number.isFinite(next.lng) || !Number.isFinite(next.updatedAt)) {
    return null;
  }

  const elapsedMs = next.updatedAt - previous.updatedAt;

  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return null;
  }

  const distanceMeters = haversineMeters(previous.lat, previous.lng, next.lat, next.lng);

  if (!Number.isFinite(distanceMeters) || distanceMeters < 0) {
    return null;
  }

  const speedKmh = distanceMeters / 1000 / (elapsedMs / 3600000);

  if (!Number.isFinite(speedKmh) || speedKmh < 0 || speedKmh > MAX_REALISTIC_SPEED_KMH) {
    return null;
  }

  return speedKmh;
}

/* =========================
   GOOGLE ROUTES / ETA
========================= */

let warnedMissingRoutesKey = false;

async function requestRoute(apiKey, origin, destination, waypoints, mode = 'DRIVE') {
  const latLng = point => ({ latLng: { latitude: point.lat, longitude: point.lng } });

  const body = {
    origin: { location: latLng(origin) },
    destination: { location: latLng(destination) },
    travelMode: mode
  };

  /*
    DRIVE allows road-based routing and TRAFFIC_AWARE makes Google's returned duration account for
    current traffic. routingPreference is only valid for DRIVE/TWO_WHEELER, so it is omitted for WALK.
  */
  if (mode === 'DRIVE') body.routingPreference = 'TRAFFIC_AWARE';

  if (waypoints.length) {
    // via:true keeps intermediate bus stops as pass-through points rather than stopovers.
    body.intermediates = waypoints.map(point => ({ via: true, location: latLng(point) }));
  }

  const response = await fetch(GOOGLE_ROUTES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      // Request only the fields needed for ETA, distance and map route.
      'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000)
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Google Routes API returned ${response.status}${errorText ? `: ${errorText.slice(0, 300)}` : ''}`);
  }

  const data = await response.json();
  const route = data.routes?.[0];

  if (!route) return null;

  // Google returns duration as a string such as "123s".
  const durationMatch = String(route.duration || '').match(/^([\d.]+)s$/);
  const durationSeconds = durationMatch ? Number(durationMatch[1]) : Number.NaN;
  // Google omits distanceMeters (protobuf default) when it is 0, e.g. when the origin is already at the destination.
  const distanceMeters = Number(route.distanceMeters ?? 0);

  const durationValid = Number.isFinite(durationSeconds) && durationSeconds >= 0;
  const distanceValid = Number.isFinite(distanceMeters) && distanceMeters >= 0;

  if (!durationValid) {
    console.warn('Google returned an invalid route duration.');
  }

  if (!durationValid && !distanceValid) return null;

  return {
    durationSeconds: durationValid ? durationSeconds : null,
    distanceMeters: distanceValid ? distanceMeters : null,
    encodedPolyline: route.polyline?.encodedPolyline || null
  };
}

/*
  Real road distance and duration between two points, optionally passing through ordered
  intermediate points (the bus route's own stops). `mode` is 'DRIVE' (traffic-aware, for buses)
  or 'WALK' (for the passenger). Returns { durationSeconds, distanceMeters, encodedPolyline } or
  null; throws when Google returns an error so callers can report it.
*/
async function routeToLocation(origin, destination, intermediates = [], mode = 'DRIVE') {
  const apiKey = process.env.GOOGLE_ROUTES_API_KEY;

  if (!apiKey) {
    if (!warnedMissingRoutesKey) {
      console.warn('GOOGLE_ROUTES_API_KEY is not configured.');
      warnedMissingRoutesKey = true;
    }
    return null;
  }

  const from = { lat: Number(origin?.lat), lng: Number(origin?.lng) };
  const to = { lat: Number(destination?.lat), lng: Number(destination?.lng) };

  if (!validCoords(from) || !validCoords(to)) {
    console.warn('Invalid coordinates supplied to Google Routes.');
    return null;
  }

  const waypoints = intermediates
    .map(point => ({ lat: Number(point?.lat), lng: Number(point?.lng) }))
    .filter(validCoords)
    .slice(0, 25);

  try {
    return await requestRoute(apiKey, from, to, waypoints, mode);
  } catch (error) {
    if (!waypoints.length) throw error;
    console.warn(`Route via bus stops failed (${error.message}); retrying direct.`);
    return requestRoute(apiKey, from, to, [], mode);
  }
}

// ETA minutes from a road route: Google's traffic-aware duration first, then road distance / GPS speed.
function etaMinutesFromRoute(route, speedKmh) {
  if (!route) return null;

  if (Number.isFinite(route.durationSeconds) && route.durationSeconds >= 0) {
    return Math.max(1, Math.ceil(route.durationSeconds / 60));
  }

  if (
    Number.isFinite(route.distanceMeters) &&
    route.distanceMeters >= 0 &&
    Number.isFinite(speedKmh) &&
    speedKmh >= MIN_RELIABLE_SPEED_KMH
  ) {
    const minutes = (route.distanceMeters / 1000 / speedKmh) * 60;
    return Number.isFinite(minutes) && minutes >= 0 ? Math.max(1, Math.ceil(minutes)) : null;
  }

  return null;
}

/*
  Short-lived cache (also de-duplicates concurrent identical lookups) so many passengers polling
  every ~12s do not each trigger their own Google Routes request for the same bus/stop pair.
*/
const routeCache = new Map();

function cachedRoute(key, fingerprint, ttlMs, loader) {
  const now = Date.now();
  const hit = routeCache.get(key);

  if (hit && hit.fingerprint === fingerprint && now - hit.at < ttlMs) {
    return hit.promise;
  }

  const entry = { fingerprint, at: now, promise: Promise.resolve().then(loader) };
  routeCache.set(key, entry);

  entry.promise.catch(() => {
    if (routeCache.get(key) === entry) routeCache.delete(key);
  });

  if (routeCache.size > 500) {
    let drop = routeCache.size - 400;
    for (const oldKey of routeCache.keys()) {
      if (drop-- <= 0) break;
      routeCache.delete(oldKey);
    }
  }

  return entry.promise;
}

const positionFingerprint = point => `${Number(point.lat).toFixed(4)},${Number(point.lng).toFixed(4)}`;
const ROUTE_TTL_MS = 25_000;
const STATIC_ROUTE_TTL_MS = 30 * 60 * 1000;

/* =========================
   DEVICE AUTH
========================= */

function assertDevice(req, res, next) {
  if (!deviceApiKey) {
    return res.status(503).json({
      message: 'Hardware ingestion is not configured. Set DEVICE_API_KEY.'
    });
  }

  if (req.get('X-Device-Key') !== deviceApiKey) {
    return res.status(401).json({ message: 'Invalid device key.' });
  }

  next();
}

/* =========================
   BASIC API
========================= */

app.get('/api/health', (req, res) =>
  res.json({
    ok: true,
    workbookLoaded: transit.loaded
  })
);

app.get('/api/public/config', (req, res) =>
  res.json({
    googleMapsKey: process.env.GOOGLE_MAPS_API_KEY || '',
    routeCount: transit.routes.length,
    tripCount: transit.rows.length
  })
);

app.get('/api/stops', (req, res) => res.json(transit.stops));

app.get('/api/routes', (req, res) => res.json(transit.routes));

app.get('/api/buses', (req, res) => res.json([...buses.values()]));

app.get('/api/timetable', (req, res) => {
  const wanted = slug(req.query.route);

  res.json(
    transit.rows
      .filter(row => {
        if (!wanted) return true;
        const matchingRoutes = transit.routes.filter(route => route.busId && route.busId === row.busId);
        return slug(row.route) === wanted || slug(row.busNo) === wanted || slug(row.busId) === wanted || matchingRoutes.some(route => route.id === wanted);
      })
      .slice(0, 12)
  );
});

app.get('/api/driver/bus', auth(['driver']), (req, res) =>
  res.json(
    buses.get(req.user.busId) || {
      id: req.user.busId,
      routeId: 'route',
      occupancy: 'Not reported',
      updatedAt: null
    }
  )
);

/* =========================
   REQUEST OTP
========================= */

app.post('/api/auth/request-code', async (req, res) => {
  const { password, role = 'passenger', busId } = req.body;

  const email = String(req.body.email || '').trim().toLowerCase();

  const isDriver = role === 'driver';

  if (!/^\S+@\S+\.\S+$/.test(email) || String(password).length < 8) {
    return res.status(400).json({
      message: 'Use a valid email and an 8+ character password.'
    });
  }

  if (isDriver && (!busId || !buses.has(String(busId).trim()))) {
    return res.status(400).json({
      message: 'Enter a valid assigned bus ID to create a driver account.'
    });
  }

  if (pendingCodes.get(email)?.sentAt > Date.now() - 60_000) {
    return res.status(429).json({
      message: 'Please wait a minute before requesting another code.'
    });
  }

  if (!brevoApiKey || !brevoSenderEmail) {
    console.error('BREVO_API_KEY or BREVO_SENDER_EMAIL is missing.');

    return res.status(503).json({
      message: 'Email verification is not configured.'
    });
  }

  const code = crypto.randomInt(100000, 1000000).toString();

  pendingCodes.set(email, {
    code,
    password: await bcrypt.hash(password, 12),
    role: isDriver ? 'driver' : 'passenger',
    busId: isDriver ? String(busId).trim() : null,
    sentAt: Date.now(),
    expiresAt: Date.now() + 600000,
    attempts: 0
  });

  try {
    console.log(`Attempting to send verification email to ${email}`);

    const brevoResponse = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',

      headers: {
        accept: 'application/json',
        'api-key': brevoApiKey,
        'content-type': 'application/json'
      },

      body: JSON.stringify({
        sender: {
          email: brevoSenderEmail,
          name: brevoSenderName
        },

        to: [{ email }],

        subject: 'Your NAVIGO verification code',

        htmlContent: `
          <div style="font-family: Arial, sans-serif; line-height: 1.6;">
            <h2>NAVIGO Email Verification</h2>

            <p>Your NAVIGO verification code is:</p>

            <h1 style="letter-spacing: 5px;">
              ${code}
            </h1>

            <p>
              This code expires in 10 minutes.
            </p>

            <p>
              If you did not request this code,
              you can safely ignore this email.
            </p>
          </div>
        `
      })
    });

    const brevoResult = await brevoResponse.json().catch(() => ({}));

    if (!brevoResponse.ok) {
      console.error('BREVO EMAIL ERROR:', {
        statusCode: brevoResponse.status,
        ...brevoResult
      });

      pendingCodes.delete(email);

      return res.status(502).json({
        message: 'We could not send the verification email.',
        provider: 'Brevo'
      });
    }

    console.log('Verification email sent successfully:', brevoResult);

    return res.status(202).json({
      message: getUserByEmail(email)
        ? 'Verification code sent. Verifying it will replace your old password and sign out previous sessions.'
        : 'Verification code sent.'
    });
  } catch (error) {
    pendingCodes.delete(email);

    console.error('BREVO SEND FAILED:', error);

    return res.status(502).json({
      message: 'We could not send the verification email.',
      provider: 'Brevo',
      error: error?.message || String(error)
    });
  }
});

/* =========================
   VERIFY OTP
========================= */

app.post('/api/auth/verify-code', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();

  const pending = pendingCodes.get(email);

  if (!pending || pending.expiresAt < Date.now()) {
    pendingCodes.delete(email);

    return res.status(400).json({
      message: 'This code has expired. Request a new one.'
    });
  }

  if (++pending.attempts > 5) {
    pendingCodes.delete(email);

    return res.status(429).json({
      message: 'Too many attempts. Request a new code.'
    });
  }

  if (String(req.body.code).trim() !== pending.code) {
    return res.status(400).json({
      message: 'That verification code is incorrect.'
    });
  }

  const oldUser = getUserByEmail(email);

  const user = {
    id: oldUser?.id || crypto.randomUUID(),
    email,
    role: pending.role,
    busId: pending.busId,
    password: pending.password,
    sessionVersion: crypto.randomUUID()
  };

  saveUser(user);
  resetPassengerState(user.id);

  pendingCodes.delete(user.email);

  res.status(201).json({
    token: tokenFor(user),
    user: publicUser(user)
  });
});

/* =========================
   LOGIN
========================= */

app.post('/api/auth/login', async (req, res) => {
  const user = getUserByEmail(String(req.body.email || '').trim().toLowerCase());

  if (!user || !(await bcrypt.compare(req.body.password || '', user.password))) {
    return res.status(401).json({
      message: 'Incorrect email or password.'
    });
  }

  if (user.role === 'driver' && String(req.body.busId || '').trim() !== user.busId) {
    return res.status(403).json({
      message: 'Enter the bus ID assigned to this driver account.'
    });
  }

  resetPassengerState(user.id);

  res.json({
    token: tokenFor(user),
    user: publicUser(user)
  });
});

/* =========================
   JOURNEY SEARCH
========================= */

app.post('/api/journeys/search', auth(['passenger']), (req, res) => {
  const origin = transit.stops.find(stop => stop.id === req.body.from);
  const destination = transit.stops.find(stop => stop.id === req.body.to);

  if (!origin || !destination || origin.id === destination.id) {
    return res.status(400).json({
      message: 'Choose two different valid stops.'
    });
  }

  res.json({
    from: origin,
    to: destination,
    options: findOptions(origin.id, destination.id),
    roadRoute: null,
    routingWarning: 'Timetable routes are loaded from Navigo.xlsx.'
  });
});

/* =========================
   PICKUP STOP (nearest stop by ROAD distance)

   pickups  userId -> { stopId, at }   the stop last chosen for this passenger (for hysteresis)
========================= */

const pickups = new Map();

// Stops the passenger may be picked up at: the selected bus's route, otherwise every stop that any route serves.
function eligibleStopPool(selection) {
  const selectedRoute = routeOf(selection.busId ? buses.get(selection.busId) : null);
  if (selectedRoute) return routeStopObjects(selectedRoute);

  const ids = new Set();
  for (const route of transit.routes) for (const id of route.stops) ids.add(id);
  return [...ids].map(id => transit.stopsById.get(id)).filter(Boolean);
}

// Road route passenger -> stop, cached per passenger/stop and refreshed when the passenger moves.
const walkRoute = (userId, stop, location) =>
  cachedRoute(`walk:${userId}:${stop.id}`, positionFingerprint(location), ROUTE_TTL_MS, () => routeToLocation(location, stop, [], USER_TRAVEL_MODE));

function pickupView(stop, auto, route, source) {
  const durationMin = route && Number.isFinite(route.durationSeconds) ? Math.max(1, Math.ceil(route.durationSeconds / 60)) : null;
  const distanceMeters = route && Number.isFinite(route.distanceMeters) ? route.distanceMeters : null;

  return {
    stop: stopView(stop),
    auto,
    locked: false,
    source, // 'google-road' | 'gps-fallback' | 'unavailable' | 'journey'
    travelMode: USER_TRAVEL_MODE,
    distanceMeters,
    distanceKm: kmFrom(distanceMeters),
    durationMin,
    roadRoute: route?.encodedPolyline ? { encodedPolyline: route.encodedPolyline } : null
  };
}

// Once boarding is detected the pickup stays on the stop the passenger boarded at.
function lockedPickup(journey) {
  const stop = journey ? transit.stopsById.get(journey.currentStopId) : null;
  if (!stop) return null;
  return { ...pickupView(stop, false, null, 'journey'), locked: true };
}

async function resolvePickup(userId, location, selection) {
  const now = Date.now();

  // 1) The passenger picked a stop: use exactly that stop (any stop a route serves) and draw the road route to it.
  //    It is never swapped for a different "nearest" stop, so the bus ETA stays bus -> the selected stop.
  const chosen = selection.stopId ? eligibleStopPool({}).find(stop => stop.id === selection.stopId) : null;
  if (chosen) {
    let route = null;
    try {
      route = await walkRoute(userId, chosen, location);
    } catch (error) {
      console.error(`Road route to selected stop ${chosen.id} failed:`, error?.message || error);
    }
    pickups.set(userId, { stopId: chosen.id, at: now });
    return pickupView(chosen, false, route, route ? 'google-road' : 'unavailable');
  }

  // 2) Automatic: shortlist by straight line, then rank the shortlist by Google road distance.
  const pool = eligibleStopPool(selection);
  if (!pool.length) return null;

  const ranked = pool
    .map(stop => ({ stop, meters: gpsDistance(stop, location) }))
    .filter(item => item.meters !== null)
    .sort((a, b) => a.meters - b.meters);
  if (!ranked.length) return null;

  const candidates = ranked.slice(0, PICKUP_CANDIDATES).map(item => item.stop);
  const previousId = pickups.get(userId)?.stopId;
  const previous = previousId ? ranked.slice(0, PICKUP_PREVIOUS_RANK_LIMIT).find(item => item.stop.id === previousId)?.stop : null;
  if (previous && !candidates.some(stop => stop.id === previous.id)) candidates.push(previous);

  const settled = await Promise.allSettled(candidates.map(stop => walkRoute(userId, stop, location)));

  const scored = [];
  let firstFailure = null;
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled' && result.value && Number.isFinite(result.value.distanceMeters)) {
      scored.push({ stop: candidates[index], route: result.value });
    } else if (result.status === 'rejected' && !firstFailure) {
      firstFailure = result.reason?.message || String(result.reason);
    }
  });

  // Google failed for every candidate (or is not configured): Haversine picks the stop, no distance is displayed.
  if (!scored.length) {
    if (firstFailure) console.error('Nearest-stop road routing failed; using straight-line fallback:', firstFailure);
    const fallback = ranked[0].stop;
    pickups.set(userId, { stopId: fallback.id, at: now });
    return pickupView(fallback, true, null, 'gps-fallback');
  }

  scored.sort((a, b) => a.route.distanceMeters - b.route.distanceMeters);
  let best = scored[0];
  const keep = previous ? scored.find(item => item.stop.id === previous.id) : null;
  if (keep && keep.route.distanceMeters <= best.route.distanceMeters * PICKUP_SWITCH_RATIO + PICKUP_SWITCH_METERS) best = keep;

  pickups.set(userId, { stopId: best.stop.id, at: now });
  return pickupView(best.stop, true, best.route, 'google-road');
}

/* =========================
   BOARDING DETECTION + JOURNEY STATE

   Per passenger (in memory):
     boardingTrackers  "userId|busId" -> consecutive-match streak
     boardingSuppressed "userId|busId" -> don't re-detect this bus until the time passes
     journeys          userId -> { phase: 'boarded' | 'in_journey' | 'completed', ... }
========================= */

const boardingTrackers = new Map();
const boardingSuppressed = new Map();
const journeys = new Map();

function resetTracker(tracker) {
  tracker.count = 0;
  tracker.firstBus = null;
  tracker.firstUser = null;
  tracker.firstStopId = null;
  tracker.confirmed = false;
}

function updateTracker(userId, bus, location, accuracy, now, pickupStopId) {
  const key = `${userId}|${bus.id}`;
  let tracker = boardingTrackers.get(key);

  if (!tracker) {
    tracker = { count: 0, lastCountedAt: 0, firstBus: null, firstUser: null, firstStopId: null, confirmed: false, touchedAt: now };
    boardingTrackers.set(key, tracker);
  }

  tracker.touchedAt = now;

  const distance = gpsDistance(bus, location);
  const fixAge = now - bus.updatedAt;

  // Missing/invalid GPS or a stale bus fix can never count as a match.
  if (distance === null || !Number.isFinite(fixAge) || fixAge > BOARDING_MAX_FIX_AGE_MS) {
    resetTracker(tracker);
    return tracker;
  }

  // A low-accuracy passenger fix proves nothing either way: ignore it.
  if (accuracy !== null && accuracy > BOARDING_MAX_ACCURACY_METERS) return tracker;

  // Rapid manual refreshes must not inflate the "consecutive updates" count.
  if (now - tracker.lastCountedAt < BOARDING_MIN_POLL_GAP_MS) return tracker;
  tracker.lastCountedAt = now;

  if (distance <= BOARDING_MATCH_METERS) {
    if (tracker.count === 0) {
      tracker.firstBus = { lat: bus.lat, lng: bus.lng };
      tracker.firstUser = { lat: location.lat, lng: location.lng };
      // The pickup stop the passenger was waiting at when the bus first came alongside.
      tracker.firstStopId = pickupStopId || null;
    }
    tracker.count = Math.min(tracker.count + 1, 30);
  } else if (distance > BOARDING_RESET_METERS) {
    resetTracker(tracker);
  }

  if (tracker.count >= BOARDING_CONSECUTIVE_UPDATES && tracker.firstBus && tracker.firstUser) {
    const busTravel = gpsDistance(tracker.firstBus, bus);
    const userTravel = gpsDistance(tracker.firstUser, location);
    tracker.confirmed =
      busTravel !== null && userTravel !== null && busTravel >= BOARDING_MIN_TRAVEL_METERS && userTravel >= BOARDING_MIN_TRAVEL_METERS;
  } else {
    tracker.confirmed = false;
  }

  return tracker;
}

function detectBoarding(userId, live, location, accuracy, pickupStopId) {
  const now = Date.now();
  const trackers = new Map();
  let best = null;

  for (const bus of live) {
    const suppressedUntil = boardingSuppressed.get(`${userId}|${bus.id}`);
    if (suppressedUntil && suppressedUntil > now) continue;

    const tracker = updateTracker(userId, bus, location, accuracy, now, pickupStopId);
    trackers.set(bus.id, tracker);

    if (tracker.confirmed) {
      const distance = gpsDistance(bus, location);
      if (distance !== null && (!best || distance < best.distance)) {
        best = { busId: bus.id, distance };
      }
    }
  }

  return { boardedBusId: best?.busId || null, trackers };
}

function cleanupJourneyState() {
  const now = Date.now();

  for (const [key, tracker] of boardingTrackers) {
    if (now - tracker.touchedAt > TRACKER_TTL_MS) boardingTrackers.delete(key);
  }

  for (const [key, until] of boardingSuppressed) {
    if (until <= now) boardingSuppressed.delete(key);
  }

  for (const [key, journey] of journeys) {
    if (now - journey.lastSeenAt > JOURNEY_IDLE_MS) journeys.delete(key);
  }

  for (const [key, pickup] of pickups) {
    if (now - pickup.at > PICKUP_TTL_MS) pickups.delete(key);
  }
}

function clearTrackersFor(userId) {
  for (const key of boardingTrackers.keys()) {
    if (key.startsWith(`${userId}|`)) boardingTrackers.delete(key);
  }
}

// A new sign-in / verified registration starts a fresh passenger session: no journey, pickup or boarding streak carries over.
function resetPassengerState(userId) {
  journeys.delete(userId);
  pickups.delete(userId);
  clearTrackersFor(userId);
}

/*
  Validates a boarding stop + destination pair against the bus's ordered route.
  The destination must come AFTER the boarding stop in the STOP 1 -> STOP N sequence.
*/
function resolveJourneyStops(bus, currentStopId, destinationStopId) {
  const route = routeOf(bus);
  if (!route) return { error: 'This bus has no route data.' };

  const from = route.stops.indexOf(currentStopId);
  const to = route.stops.indexOf(destinationStopId);

  if (from < 0) return { error: "Your boarding stop is not on this bus's route." };
  if (to < 0) return { error: "That destination is not on this bus's route." };
  if (to <= from) return { error: "Choose a destination that comes after your boarding stop on this bus's route." };

  return { route, stops: routeStopObjects(route), from, to };
}

/*
  The stop the passenger boarded at: the pickup stop they were waiting at when the bus first came
  alongside (if it is on this bus's route), else the stop they selected, else the route stop nearest
  to where they were standing (Haversine is only a last-resort fallback here).
*/
function pickBoardingStop(bus, location, selection, tracker) {
  const stops = routeStopObjects(routeOf(bus));
  if (!stops.length) return null;

  const hinted = tracker?.firstStopId ? stops.find(stop => stop.id === tracker.firstStopId) : null;
  if (hinted) return hinted;

  const selectionApplies = !selection.busId || selection.busId === bus.id;
  const chosen = selectionApplies && selection.stopId ? stops.find(stop => stop.id === selection.stopId) : null;
  if (chosen) return chosen;

  return nearestStop(stops, tracker?.firstUser || location)?.stop || null;
}

/* Synchronous state transitions; Google lookups happen afterwards in buildJourneyView. */
function advanceJourney(userId, detection, selection, location) {
  const now = Date.now();
  let journey = journeys.get(userId) || null;

  if (journey) {
    journey.lastSeenAt = now;
    journey.warning = null;
  }

  if (journey?.phase === 'completed' && now - journey.completedAt > COMPLETED_RETENTION_MS) {
    journeys.delete(userId);
    journey = null;
  }

  if (journey?.phase === 'completed') return journey;

  if (journey?.phase === 'in_journey') {
    const bus = buses.get(journey.busId);

    // The passenger may change destination mid-journey (must still be ahead on the route).
    if (selection.destinationStopId && selection.destinationStopId !== journey.destinationStopId) {
      const check = resolveJourneyStops(bus, journey.currentStopId, selection.destinationStopId);
      if (check.error) journey.warning = check.error;
      else journey.destinationStopId = selection.destinationStopId;
    }

    const destination = transit.stopsById.get(journey.destinationStopId);
    const distance = gpsDistance(bus, destination);
    const fresh = bus && Number.isFinite(bus.updatedAt) && now - bus.updatedAt < BUS_FRESHNESS_MS;

    if (fresh && distance !== null && distance <= ARRIVAL_THRESHOLD_METERS) {
      journey.phase = 'completed';
      journey.completedAt = now;
    }
    return journey;
  }

  // Boarded earlier, but the bus and passenger no longer travel together: it was a false alarm.
  if (journey?.phase === 'boarded') {
    const tracker = detection.trackers.get(journey.busId);
    if (!tracker || tracker.count === 0) {
      journeys.delete(userId);
      journey = null;
    }
  }

  if (!journey && detection.boardedBusId) {
    const bus = buses.get(detection.boardedBusId);
    const tracker = detection.trackers.get(detection.boardedBusId);
    const currentStop = pickBoardingStop(bus, location, selection, tracker);

    journey = {
      userId,
      phase: 'boarded',
      busId: detection.boardedBusId,
      detectedAt: now,
      lastSeenAt: now,
      currentStopId: currentStop?.id || null,
      destinationStopId: null,
      startedBy: null,
      startedAt: null,
      completedAt: null,
      warning: null
    };
    journeys.set(userId, journey);
  }

  // Boarding is confirmed: start automatically as soon as a valid destination is known.
  if (journey?.phase === 'boarded' && selection.destinationStopId) {
    const check = resolveJourneyStops(buses.get(journey.busId), journey.currentStopId, selection.destinationStopId);
    if (check.error) {
      journey.warning = check.error;
    } else {
      journey.phase = 'in_journey';
      journey.startedBy = 'auto';
      journey.startedAt = now;
      journey.destinationStopId = selection.destinationStopId;
    }
  }

  return journey;
}

/* Passenger-facing journey object (includes the DARK BLUE road route and the ROAD ETA for boarding stop -> destination stop). */
async function buildJourneyView(journey) {
  if (!journey) return null;

  const now = Date.now();
  const bus = buses.get(journey.busId) || null;
  const route = routeOf(bus);
  const stops = routeStopObjects(route);
  const currentStop = transit.stopsById.get(journey.currentStopId) || null;
  const destination = transit.stopsById.get(journey.destinationStopId) || null;

  const view = {
    phase: journey.phase,
    busId: journey.busId,
    startedBy: journey.startedBy,
    startedAt: journey.startedAt,
    boardingDetected: true,
    needsDestination: journey.phase === 'boarded',
    currentStop: stopView(currentStop),
    destination: stopView(destination),
    etaMinutes: null,
    etaStatus: journey.phase === 'boarded' ? 'awaiting-destination' : 'unavailable',
    hasArrived: false,
    distanceMeters: null,
    distanceKm: null,
    roadRoute: null,
    busOffline: false,
    warning: journey.warning || null
  };

  if (journey.phase === 'boarded') return view;

  if (journey.phase === 'completed') {
    return { ...view, etaMinutes: 0, etaStatus: 'arrived', hasArrived: true, distanceMeters: 0, distanceKm: 0 };
  }

  const fresh = bus && validCoords(bus) && Number.isFinite(bus.updatedAt) && now - bus.updatedAt < BUS_FRESHNESS_MS;
  view.busOffline = !fresh;
  if (!fresh) view.etaStatus = 'no-live-data';

  if (!route || !currentStop || !destination) return view;

  const from = route.stops.indexOf(currentStop.id);
  const to = route.stops.indexOf(destination.id);
  if (from < 0 || to <= from) return view;

  // DARK BLUE route: boarding stop -> destination stop, following the bus's ordered stops.
  let staticRoute = null;
  try {
    const between = stops.slice(from + 1, to);
    staticRoute = await cachedRoute(
      `journey:${route.id}:${currentStop.id}>${destination.id}`,
      between.map(stop => stop.id).join(','),
      STATIC_ROUTE_TTL_MS,
      () => routeToLocation(currentStop, destination, between)
    );
  } catch (error) {
    console.error(`Journey route failed for bus ${journey.busId}:`, error?.message || error);
  }

  // ETA after boarding = boarding stop -> destination stop (the same road route as the dark-blue line).
  // With JOURNEY_ETA_FROM_BUS=true it is instead the live road ETA from the bus's current position to the destination.
  let etaRoute = staticRoute;
  if (JOURNEY_ETA_FROM_BUS && fresh) {
    try {
      // Skip the stop the bus is at/just passed; pass through the remaining stops before the destination.
      let progress = from;
      let nearestMeters = Infinity;
      for (let i = from; i <= to; i += 1) {
        const meters = gpsDistance(stops[i], bus);
        if (meters !== null && meters < nearestMeters) {
          nearestMeters = meters;
          progress = i;
        }
      }
      const remaining = stops.slice(progress + 1, to);

      etaRoute =
        (await cachedRoute(
          `eta:${bus.id}>${destination.id}`,
          `${positionFingerprint(bus)}|${remaining.map(stop => stop.id).join(',')}`,
          ROUTE_TTL_MS,
          () => routeToLocation(bus, destination, remaining)
        )) || staticRoute;
    } catch (error) {
      console.error(`Destination ETA failed for bus ${journey.busId}:`, error?.message || error);
    }
  }

  const roadDistance = etaRoute && Number.isFinite(etaRoute.distanceMeters) ? etaRoute.distanceMeters : null;
  const etaMinutes = etaMinutesFromRoute(etaRoute, bus?.speedKmh);

  return {
    ...view,
    etaMinutes,
    etaStatus: etaMinutes !== null ? 'ok' : fresh ? 'unavailable' : 'no-live-data',
    distanceMeters: roadDistance,
    distanceKm: kmFrom(roadDistance),
    roadRoute: staticRoute || etaRoute
  };
}

/* =========================
   ARRIVALS / LIVE ETA
========================= */

/*
  Arrival card for one live bus heading to the passenger's pickup stop. Arrival detection uses the
  GPS/Haversine distance (<= ARRIVAL_THRESHOLD_METERS); every DISPLAYED distance/ETA comes from the
  Google road route bus -> stop. When Google gives nothing, etaMinutes stays null and etaStatus says why.
*/
async function buildArrival(bus, pickupStop, trackers) {
  const route = routeOf(bus);
  const stops = routeStopObjects(route);
  const stopIndex = stops.findIndex(stop => stop.id === pickupStop.id);

  const gpsDistanceMeters = gpsDistance(bus, pickupStop);
  const hasArrived = gpsDistanceMeters !== null && gpsDistanceMeters <= ARRIVAL_THRESHOLD_METERS;

  // Live road route from the bus to the pickup stop (skipped once arrived).
  let road = null;
  if (!hasArrived) {
    try {
      road = await cachedRoute(`arrival:${bus.id}>${pickupStop.id}`, positionFingerprint(bus), ROUTE_TTL_MS, () => routeToLocation(bus, pickupStop));
    } catch (error) {
      console.error(`ETA calculation failed for bus ${bus.id}:`, error?.message || error);
    }
  }

  const speedKmh = Number.isFinite(bus.speedKmh) ? bus.speedKmh : null;
  const roadDistanceMeters = road && Number.isFinite(road.distanceMeters) ? road.distanceMeters : null;
  const etaMinutes = hasArrived ? 0 : etaMinutesFromRoute(road, speedKmh);

  let etaSource = null;
  let etaStatus = 'unavailable';
  if (hasArrived) {
    etaSource = 'gps-arrival';
    etaStatus = 'arrived';
  } else if (etaMinutes !== null) {
    etaSource = Number.isFinite(road?.durationSeconds) ? 'google-road' : 'road-distance-speed';
    etaStatus = 'ok';
  }

  const targetStop = stopView(pickupStop);

  return {
    ...bus,
    routeName: route?.name || bus.routeName || null,
    etaMinutes,
    etaSource,
    etaStatus,
    // Road distance only; once arrived there is nothing left to show.
    distanceMeters: hasArrived ? null : roadDistanceMeters,
    distanceKm: hasArrived ? null : kmFrom(roadDistanceMeters),
    gpsDistanceMeters: round1(gpsDistanceMeters),
    hasArrived,
    boardingStop: targetStop,
    targetStop,
    boardingStopIndex: stopIndex,
    boardingStopAuto: true,
    stopDistanceMeters: null,
    routeStops: stops.map(stopView),
    roadRoute: road,
    speedKmh,
    inService: isInServiceWindow(bus.schedule),
    boardingProgress: {
      matches: trackers.get(bus.id)?.count || 0,
      required: BOARDING_CONSECUTIVE_UPDATES
    }
  };
}

// Keeps a bus visible when its ETA could not be calculated at all.
function fallbackArrival(bus, pickupStop) {
  const stops = routeStopObjects(routeOf(bus));
  const targetStop = stopView(pickupStop);
  return {
    ...bus,
    etaMinutes: null,
    etaSource: null,
    etaStatus: 'unavailable',
    distanceMeters: null,
    distanceKm: null,
    gpsDistanceMeters: null,
    hasArrived: false,
    boardingStop: targetStop,
    targetStop,
    boardingStopIndex: stops.findIndex(stop => stop.id === pickupStop.id),
    boardingStopAuto: true,
    stopDistanceMeters: null,
    routeStops: stops.map(stopView),
    roadRoute: null,
    speedKmh: Number.isFinite(bus?.speedKmh) ? bus.speedKmh : null,
    inService: true,
    boardingProgress: { matches: 0, required: BOARDING_CONSECUTIVE_UPDATES }
  };
}

// While a journey is active the list shows only the passenger's bus, with the ETA for their boarding -> destination leg.
function journeyArrival(bus, view) {
  const stops = routeStopObjects(routeOf(bus));
  const targetStop = view.destination || view.currentStop || null;
  return {
    ...bus,
    routeName: routeOf(bus)?.name || bus.routeName || null,
    etaMinutes: view.etaMinutes,
    etaSource: view.hasArrived ? 'gps-arrival' : Number.isFinite(view.etaMinutes) ? 'google-road' : null,
    etaStatus: view.etaStatus,
    distanceMeters: view.distanceMeters,
    distanceKm: view.distanceKm,
    gpsDistanceMeters: null,
    hasArrived: view.hasArrived,
    boardingStop: view.currentStop,
    targetStop,
    boardingStopIndex: stops.findIndex(stop => stop.id === view.currentStop?.id),
    boardingStopAuto: false,
    stopDistanceMeters: null,
    routeStops: stops.map(stopView),
    roadRoute: null,
    speedKmh: Number.isFinite(bus?.speedKmh) ? bus.speedKmh : null,
    inService: true,
    boardingProgress: { matches: BOARDING_CONSECUTIVE_UPDATES, required: BOARDING_CONSECUTIVE_UPDATES }
  };
}

const sortArrivals = list =>
  list.sort((a, b) => {
    if (a.hasArrived !== b.hasArrived) return a.hasArrived ? -1 : 1;
    return (a.etaMinutes ?? Infinity) - (b.etaMinutes ?? Infinity);
  });

app.post('/api/arrivals', auth(['passenger']), async (req, res) => {
  // Passenger's current GPS position.
  const lat = Number(req.body.lat);
  const lng = Number(req.body.lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return res.status(400).json({
      message: 'A valid customer location is required.'
    });
  }

  const location = { lat, lng };

  const reportedAccuracy = req.body.accuracy === null || req.body.accuracy === undefined ? Number.NaN : Number(req.body.accuracy);
  const accuracy = Number.isFinite(reportedAccuracy) && reportedAccuracy >= 0 ? reportedAccuracy : null;

  /*
    Optional passenger selections. A missing stop means "nearest stop (by road) on the eligible
    route(s)"; the destination is only needed once the passenger is on board.
  */
  const selection = {
    busId: cleanOrNull(req.body.busId),
    stopId: cleanOrNull(req.body.stopId),
    destinationStopId: cleanOrNull(req.body.destinationStopId)
  };

  const userId = req.user.id;
  cleanupJourneyState();

  // Only buses with a recent, valid GPS update are considered live. Positions are never invented.
  const live = activeBuses();

  // 1) Pickup stop. After boarding it stays locked to the boarding stop.
  const prior = journeys.get(userId);
  const priorActive = !!prior && (prior.phase !== 'completed' || Date.now() - prior.completedAt <= COMPLETED_RETENTION_MS);

  let pickup = null;
  try {
    pickup = priorActive ? lockedPickup(prior) : await resolvePickup(userId, location, selection);
  } catch (error) {
    console.error('Pickup stop selection failed:', error?.message || error);
  }

  // 2) Boarding detection + journey state.
  const detection = detectBoarding(userId, live, location, accuracy, pickup?.stop?.id || null);
  const journeyState = advanceJourney(userId, detection, selection, location);

  let journey = null;
  try {
    journey = await buildJourneyView(journeyState);
  } catch (error) {
    console.error('Journey update failed:', error?.message || error);
  }

  const journeyActive = !!journey && ['boarded', 'in_journey', 'completed'].includes(journey.phase);
  if (journeyActive && !pickup?.locked) pickup = lockedPickup(journeyState) || pickup;

  // 3) Arrivals.
  let arrivals = [];
  let message = null;

  if (journeyActive) {
    const journeyBus = buses.get(journey.busId);
    arrivals = journeyBus ? [journeyArrival(journeyBus, journey)] : [];
  } else if (pickup) {
    const pickupStop = transit.stopsById.get(pickup.stop.id);

    // Only live buses whose assigned route actually contains the pickup stop.
    const serving = live.filter(bus => routeOf(bus)?.stops.includes(pickupStop.id));

    // Promise.allSettled means one failed lookup does not break all buses.
    const results = await Promise.allSettled(serving.map(bus => buildArrival(bus, pickupStop, detection.trackers)));

    arrivals = sortArrivals(
      results.map((result, index) => {
        if (result.status === 'fulfilled') return result.value;
        console.error(`Arrival calculation failed for bus ${serving[index]?.id}:`, result.reason?.message || result.reason);
        return fallbackArrival(serving[index], pickupStop);
      })
    );

    if (!live.length) message = 'No live bus data';
    else if (!serving.length) message = `No live bus data for buses serving ${pickup.stop.name}`;
  } else {
    message = live.length ? 'No bus stop could be found near you.' : 'No live bus data';
  }

  const routingConfigured = Boolean(process.env.GOOGLE_ROUTES_API_KEY);

  res.json({
    location,
    pickup,
    arrivals,
    journey,
    liveBusCount: live.length,
    noLiveBus: !journeyActive && arrivals.length === 0,
    message,
    routingWarning: routingConfigured ? null : 'Road routing is unavailable: GOOGLE_ROUTES_API_KEY is not configured on the server.',
    provider: routingConfigured ? 'Google Routes API' : 'unavailable',
    updatedAt: Date.now()
  });
});

/* =========================
   JOURNEY CONTROLS
========================= */

// Manual start: the passenger taps their bus after boarding.
app.post('/api/journey/start', auth(['passenger']), (req, res) => {
  const bus = buses.get(clean(req.body.busId));
  if (!bus) return res.status(404).json({ message: 'That bus is not available.' });

  const destinationStopId = cleanOrNull(req.body.destinationStopId);
  if (!destinationStopId) return res.status(400).json({ message: 'Choose a destination stop first.' });

  const stops = routeStopObjects(routeOf(bus));
  let currentStop = stops.find(stop => stop.id === cleanOrNull(req.body.stopId)) || null;

  // The pickup stop the passenger was last given, if this bus serves it.
  if (!currentStop) {
    const pickedId = pickups.get(req.user.id)?.stopId;
    currentStop = pickedId ? stops.find(stop => stop.id === pickedId) || null : null;
  }

  if (!currentStop) {
    const location = { lat: Number(req.body.lat), lng: Number(req.body.lng) };
    if (!validCoords(location)) {
      return res.status(400).json({ message: 'Share your location first so we can find your current stop.' });
    }
    currentStop = nearestStop(stops, location)?.stop || null;
  }

  const check = resolveJourneyStops(bus, currentStop?.id, destinationStopId);
  if (check.error) return res.status(400).json({ message: check.error });

  const now = Date.now();
  const journey = {
    userId: req.user.id,
    phase: 'in_journey',
    busId: bus.id,
    detectedAt: null,
    lastSeenAt: now,
    currentStopId: currentStop.id,
    destinationStopId,
    startedBy: 'manual',
    startedAt: now,
    completedAt: null,
    warning: null
  };

  journeys.set(req.user.id, journey);

  res.status(201).json({
    journey: {
      phase: journey.phase,
      busId: journey.busId,
      startedBy: journey.startedBy,
      startedAt: journey.startedAt,
      currentStop: stopView(currentStop),
      destination: stopView(transit.stopsById.get(destinationStopId))
    }
  });
});

app.post('/api/journey/end', auth(['passenger']), (req, res) => {
  const journey = journeys.get(req.user.id);

  if (journey?.busId) {
    // Don't immediately re-detect boarding on the same bus the passenger just ended a trip on.
    boardingSuppressed.set(`${req.user.id}|${journey.busId}`, Date.now() + BOARDING_SUPPRESS_MS);
  }

  journeys.delete(req.user.id);
  pickups.delete(req.user.id);
  clearTrackersFor(req.user.id);

  res.status(204).end();
});

/* =========================
   HARDWARE GPS
========================= */

app.post('/api/device/coordinates', assertDevice, (req, res) => {
  const { deviceId, lat, lng, occupancy = 'Unknown', accuracy, sentAt } = req.body;

  const device = deviceRegistry.get(String(deviceId || ''));

  if (!device) {
    return res.status(403).json({
      message: 'This device is not assigned to a bus in the backend registry.'
    });
  }

  if (transit.loaded && !buses.has(device.busId)) {
    return res.status(403).json({
      message: `Device bus ${device.busId} is not a BUS ID in the Bus_Schedule sheet.`
    });
  }

  if (device.ip && req.ip !== device.ip) {
    return res.status(403).json({
      message: 'The device IP does not match its backend assignment.'
    });
  }

  const latitude = Number(lat);
  const longitude = Number(lng);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    return res.status(400).json({
      message: 'Valid latitude and longitude are required.'
    });
  }

  const existing = buses.get(device.busId) || {};

  const parsedSentAt = sentAt ? new Date(sentAt).getTime() : Date.now();

  const updatedAt = Number.isFinite(parsedSentAt) ? parsedSentAt : Date.now();

  /*
    Speed is derived from this bus's own previous reported position/timestamp vs. this new one.
    computeSpeedKmh rejects first updates, invalid timestamps, non-positive elapsed time, and
    unrealistic GPS jumps by returning null.
  */
  const speedKmh = computeSpeedKmh(
    {
      lat: existing.lat,
      lng: existing.lng,
      updatedAt: existing.updatedAt
    },
    {
      lat: latitude,
      lng: longitude,
      updatedAt
    }
  );

  const position = {
    ...existing,
    id: device.busId,
    deviceId,
    routeId: existing.routeId || 'route',
    lat: latitude,
    lng: longitude,
    occupancy,
    accuracy: Number.isFinite(Number(accuracy)) && accuracy !== null && accuracy !== '' ? Number(accuracy) : null,
    updatedAt,
    speedKmh,
    source: 'hardware'
  };

  buses.set(device.busId, position);

  io.emit('bus:position', position);

  res.status(202).json({
    accepted: true,
    busId: device.busId,
    receivedAt: Date.now()
  });
});

/* =========================
   DRIVER LOCATION
========================= */

app.post('/api/driver/location', auth(['driver']), (req, res) => {
  const { lat, lng, occupancy = 'Moderate' } = req.body;

  const latitude = Number(lat);
  const longitude = Number(lng);

  const existing = buses.get(req.user.busId) || {};

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    return res.status(400).json({
      message: 'Invalid location update.'
    });
  }

  const updatedAt = Date.now();

  /*
    Same speed derivation as the hardware endpoint, so ETA stays reliable while a driver's
    device is the active location source.
  */
  const speedKmh = computeSpeedKmh(
    {
      lat: existing.lat,
      lng: existing.lng,
      updatedAt: existing.updatedAt
    },
    {
      lat: latitude,
      lng: longitude,
      updatedAt
    }
  );

  const position = {
    ...existing,
    id: req.user.busId,
    routeId: existing.routeId || 'route',
    lat: latitude,
    lng: longitude,
    occupancy,
    updatedAt,
    speedKmh,
    source: 'driver'
  };

  buses.set(req.user.busId, position);

  io.emit('bus:position', position);

  res.status(204).end();
});

/* =========================
   SOCKET.IO
========================= */

io.on('connection', socket => socket.emit('buses:initial', [...buses.values()]));

/* =========================
   PRODUCTION FRONTEND
========================= */

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(projectRoot, 'dist')));

  app.get('*', (req, res) => res.sendFile(path.join(projectRoot, 'dist', 'index.html')));
}

/* =========================
   START SERVER
========================= */

server.listen(process.env.PORT || 3001, () =>
  console.log(
    `NAVIGO server ready. Workbook data: ${transit.loaded ? `loaded (${transit.stops.length} stops, ${transit.routes.length} routes)` : 'demo mode'}.`
  )
);
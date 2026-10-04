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

    /* ---- Stops: id, name and coordinates come only from Stop_Master ---- */
    const stops = [];
    const stopsById = new Map();

    for (const row of sheetRows(stopSheet)) {
      const name = cleanText(field(row, 'stopname', 'stop', 'name'));
      const id = slug(name);
      if (!id || stopsById.has(id)) continue;

      const lat = toFinite(field(row, 'latitude', 'lat'));
      const lng = toFinite(field(row, 'longitude', 'lng', 'lon'));
      if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) {
        console.warn(`Stop "${name}" skipped: latitude/longitude are missing or invalid.`);
        continue;
      }

      const stop = {
        id,
        code: cleanText(field(row, 'stopid')) || null,
        name: prettyName(name),
        lat,
        lng,
        confidence: cleanText(field(row, 'sourceconfidence')) || null
      };
      stops.push(stop);
      stopsById.set(id, stop);
    }

    /* ---- Schedules from Bus_Schedule, matched to buses by "BUS NO.|BUS" ---- */
    const scheduleByKey = new Map();
    const timetableRows = [];

    for (const row of sheetRows(scheduleSheet)) {
      const busNo = cleanText(field(row, 'busno'));
      const operator = cleanText(field(row, 'bus'));
      const routeText = cleanText(field(row, 'route'));
      if (!operator && !busNo && !routeText) continue;

      const firstDepartureMin = parseClock(field(row, 'draftfirstdeparture', 'firstdeparture'));
      const lastDepartureMin = parseClock(field(row, 'draftlastdeparture', 'lastdeparture'));
      const headway = toFinite(field(row, 'headwaymin', 'headway'));

      const schedule = {
        direction: cleanText(field(row, 'direction')) || null,
        firstDeparture: formatClock(firstDepartureMin),
        lastDeparture: formatClock(lastDepartureMin),
        firstDepartureMin,
        lastDepartureMin,
        headwayMin: Number.isFinite(headway) && headway > 0 ? headway : null,
        status: cleanText(field(row, 'schedulestatus')) || null,
        note: cleanText(field(row, 'note')) || null
      };

      const key = `${slug(busNo)}|${slug(operator)}`;
      if (!scheduleByKey.has(key)) scheduleByKey.set(key, schedule);

      timetableRows.push({
        Route: routeText,
        route: routeText,
        busNo: busNo || null,
        operator,
        ...schedule
      });
    }

    /* ---- Routes + buses from Route_Master (one row = one bus on one route) ---- */
    const routes = [];
    const routesById = new Map();
    const busList = [];

    sheetRows(routeSheet).forEach((row, index) => {
      const number = cleanText(field(row, 'busno'));
      const operator = cleanText(field(row, 'bus'));

      const stopColumns = Object.keys(row)
        .filter(key => /^stop\d+$/.test(normKey(key)))
        .sort((a, b) => Number(normKey(a).slice(4)) - Number(normKey(b).slice(4)));

      const stopIds = [];
      const missing = [];
      for (const column of stopColumns) {
        const name = cleanText(row[column]);
        if (!name) continue;
        const id = slug(name);
        if (!stopsById.has(id)) {
          missing.push(name);
          continue;
        }
        if (stopIds[stopIds.length - 1] === id) continue;
        stopIds.push(id);
      }

      const label = `${number || 'unnumbered'} ${operator}`.trim();
      if (missing.length) {
        console.warn(`Route ${label}: ignoring stops with no valid coordinates in Stop_Master: ${missing.join(', ')}.`);
      }
      if (stopIds.length < 2) {
        console.warn(`Route ${label} skipped: fewer than two usable stops.`);
        return;
      }

      const firstStop = stopsById.get(stopIds[0]);
      const lastStop = stopsById.get(stopIds[stopIds.length - 1]);
      const point1 = cleanText(field(row, 'point1')) || firstStop.name;
      const point2 = cleanText(field(row, 'point2')) || lastStop.name;
      const routeNumber = number || point2.toUpperCase();

      let routeId = `${slug(routeNumber)}-${slug(operator) || 'bus'}`;
      for (let suffix = 2; routesById.has(routeId); suffix += 1) {
        routeId = `${slug(routeNumber)}-${slug(operator) || 'bus'}-${suffix}`;
      }

      const schedule = scheduleByKey.get(`${slug(number)}|${slug(operator)}`) || null;

      const route = {
        id: routeId,
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
        id: `B${String(index + 1).padStart(3, '0')}`,
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
  (not Google's road distance) against the exact, unrounded distance in meters.
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
  Any computed speed above this is treated as GPS noise/a position jump rather than real bus
  movement, and is rejected (stored as null for that update).
*/
const MAX_REALISTIC_SPEED_KMH = 100;

const BUS_FRESHNESS_MS = 5 * 60 * 1000;
const COMPLETED_RETENTION_MS = 2 * 60 * 1000;
const TRACKER_TTL_MS = 10 * 60 * 1000;
const JOURNEY_TTL_MS = 6 * 60 * 60 * 1000;

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
      Number.isFinite(bus.lat) &&
      Number.isFinite(bus.lng) &&
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

async function requestRoute(apiKey, origin, destination, waypoints) {
  const latLng = point => ({ latLng: { latitude: point.lat, longitude: point.lng } });

  const body = {
    origin: { location: latLng(origin) },
    destination: { location: latLng(destination) },
    /*
      DRIVE allows road-based routing. TRAFFIC_AWARE makes Google's returned duration account
      for current traffic conditions.
    */
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_AWARE'
  };

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
  const distanceMeters = Number(route.distanceMeters);

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
  Real road distance and traffic-aware travel duration between two points, optionally passing
  through ordered intermediate points (the bus route's own stops). Returns
  { durationSeconds, distanceMeters, encodedPolyline } or null.
*/
async function routeToLocation(origin, destination, intermediates = []) {
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
    return await requestRoute(apiKey, from, to, waypoints);
  } catch (error) {
    if (!waypoints.length) throw error;
    console.warn(`Route via bus stops failed (${error.message}); retrying direct.`);
    return requestRoute(apiKey, from, to, []);
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
        const matchingRoutes = transit.routes.filter(route => slug(route.number) === slug(row.busNo) && slug(route.operator) === slug(row.operator));
        return slug(row.route) === wanted || slug(row.busNo) === wanted || matchingRoutes.some(route => route.id === wanted);
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
  tracker.confirmed = false;
}

function updateTracker(userId, bus, location, accuracy, now) {
  const key = `${userId}|${bus.id}`;
  let tracker = boardingTrackers.get(key);

  if (!tracker) {
    tracker = { count: 0, lastCountedAt: 0, firstBus: null, firstUser: null, confirmed: false, touchedAt: now };
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

function detectBoarding(userId, live, location, accuracy) {
  const now = Date.now();
  const trackers = new Map();
  let best = null;

  for (const bus of live) {
    const suppressedUntil = boardingSuppressed.get(`${userId}|${bus.id}`);
    if (suppressedUntil && suppressedUntil > now) continue;

    const tracker = updateTracker(userId, bus, location, accuracy, now);
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
    if (now - journey.lastSeenAt > JOURNEY_TTL_MS) journeys.delete(key);
  }
}

function clearTrackersFor(userId) {
  for (const key of boardingTrackers.keys()) {
    if (key.startsWith(`${userId}|`)) boardingTrackers.delete(key);
  }
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

// The passenger's boarding stop for a bus: the selected stop if it is on the route, else the nearest route stop.
function pickBoardingStop(bus, location, selection) {
  const stops = routeStopObjects(routeOf(bus));
  if (!stops.length) return null;

  const selectionApplies = !selection.busId || selection.busId === bus.id;
  const chosen = selectionApplies && selection.stopId ? stops.find(stop => stop.id === selection.stopId) : null;
  if (chosen) return chosen;

  return nearestStop(stops, location)?.stop || null;
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
    const currentStop = pickBoardingStop(bus, location, selection);

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

/* Passenger-facing journey object (includes the DARK BLUE road route and the ETA to the destination). */
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
    hasArrived: false,
    distanceMeters: null,
    distanceKm: null,
    roadRoute: null,
    busOffline: false,
    warning: journey.warning || null
  };

  if (journey.phase === 'boarded') return view;

  if (journey.phase === 'completed') {
    return { ...view, etaMinutes: 0, hasArrived: true, distanceMeters: 0, distanceKm: 0 };
  }

  const fresh = bus && validCoords(bus) && Number.isFinite(bus.updatedAt) && now - bus.updatedAt < BUS_FRESHNESS_MS;
  view.busOffline = !fresh;

  if (!route || !currentStop || !destination) return view;

  const from = route.stops.indexOf(currentStop.id);
  const to = route.stops.indexOf(destination.id);
  if (from < 0 || to <= from) return view;

  // DARK BLUE route: current bus stop -> destination stop, following the bus's ordered stops.
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

  // Live ETA: road distance/duration from the bus's CURRENT position to the destination stop.
  let etaRoute = null;
  if (fresh) {
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

      etaRoute = await cachedRoute(
        `eta:${bus.id}>${destination.id}`,
        `${positionFingerprint(bus)}|${remaining.map(stop => stop.id).join(',')}`,
        ROUTE_TTL_MS,
        () => routeToLocation(bus, destination, remaining)
      );
    } catch (error) {
      console.error(`Destination ETA failed for bus ${journey.busId}:`, error?.message || error);
    }
  }

  const roadDistance = etaRoute && Number.isFinite(etaRoute.distanceMeters) ? etaRoute.distanceMeters : null;

  return {
    ...view,
    etaMinutes: etaMinutesFromRoute(etaRoute, bus?.speedKmh),
    distanceMeters: roadDistance,
    distanceKm: kmFrom(roadDistance),
    roadRoute: staticRoute || etaRoute
  };
}

/* =========================
   ARRIVALS / LIVE ETA
========================= */

async function buildArrival(bus, location, selection, trackers) {
  const route = routeOf(bus);
  const stops = routeStopObjects(route);
  const selectionApplies = !selection.busId || selection.busId === bus.id;
  const chosen = selectionApplies && selection.stopId ? stops.find(stop => stop.id === selection.stopId) : null;

  // Stop selected by the passenger, otherwise the nearest stop on THIS bus's own route.
  const boardingStop = chosen || nearestStop(stops, location)?.stop || null;
  const boardingStopIndex = boardingStop ? stops.indexOf(boardingStop) : -1;

  // Routes without usable stops fall back to the passenger's own position as the target.
  const target = boardingStop || location;

  /*
    Arrival detection uses GPS/Haversine distance between the bus's last reported position and
    the stop — NOT Google's road distance — and does not depend on the Google call below.
  */
  const gpsDistanceMeters = gpsDistance(bus, target);
  const hasArrived = gpsDistanceMeters !== null && gpsDistanceMeters <= ARRIVAL_THRESHOLD_METERS;

  // LIGHT BLUE route: live road route from the bus to the boarding stop (skipped once arrived).
  let road = null;
  if (!hasArrived) {
    try {
      road = await cachedRoute(`arrival:${bus.id}>${boardingStop?.id || `user:${positionFingerprint(location)}`}`, positionFingerprint(bus), ROUTE_TTL_MS, () =>
        routeToLocation(bus, target)
      );
    } catch (error) {
      console.error(`ETA calculation failed for bus ${bus.id}:`, error?.message || error);
    }
  }

  const speedKmh = Number.isFinite(bus.speedKmh) ? bus.speedKmh : null;
  const roadDistanceMeters = road && Number.isFinite(road.distanceMeters) ? road.distanceMeters : null;
  const etaMinutes = hasArrived ? 0 : etaMinutesFromRoute(road, speedKmh);

  // Display distance is the road distance; once arrived the exact GPS distance is shown instead.
  const distanceMeters = hasArrived ? gpsDistanceMeters : roadDistanceMeters;

  let etaSource = null;
  if (hasArrived) etaSource = 'gps-arrival';
  else if (etaMinutes !== null) etaSource = Number.isFinite(road?.durationSeconds) ? 'google-road' : 'road-distance-speed';

  return {
    ...bus,
    routeName: route?.name || bus.routeName || null,
    etaMinutes,
    etaSource,
    distanceMeters,
    distanceKm: kmFrom(distanceMeters),
    gpsDistanceMeters: round1(gpsDistanceMeters),
    hasArrived,
    boardingStop: stopView(boardingStop),
    boardingStopIndex,
    boardingStopAuto: !chosen,
    stopDistanceMeters: round1(boardingStop ? gpsDistance(boardingStop, location) : null),
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
    Optional passenger selections. A missing stop means "nearest stop on that bus's route";
    the destination is only needed once the passenger is on board.
  */
  const selection = {
    busId: cleanOrNull(req.body.busId),
    stopId: cleanOrNull(req.body.stopId),
    destinationStopId: cleanOrNull(req.body.destinationStopId)
  };

  cleanupJourneyState();

  // Only buses with a recent GPS update are considered live.
  const live = activeBuses();

  const detection = detectBoarding(req.user.id, live, location, accuracy);
  const journeyState = advanceJourney(req.user.id, detection, selection, location);

  // Promise.allSettled means one failed lookup does not break all buses.
  const results = await Promise.allSettled(live.map(bus => buildArrival(bus, location, selection, detection.trackers)));

  const arrivals = results.map((result, index) => {
    if (result.status === 'fulfilled') return result.value;

    const bus = live[index];
    console.error(`Arrival calculation failed for bus ${bus?.id}:`, result.reason?.message || result.reason);

    // Keep the bus visible even when its ETA cannot be calculated.
    return {
      ...bus,
      etaMinutes: null,
      etaSource: null,
      distanceMeters: null,
      distanceKm: null,
      gpsDistanceMeters: null,
      hasArrived: false,
      boardingStop: null,
      boardingStopIndex: -1,
      boardingStopAuto: true,
      stopDistanceMeters: null,
      routeStops: [],
      roadRoute: null,
      speedKmh: Number.isFinite(bus?.speedKmh) ? bus.speedKmh : null,
      inService: true,
      boardingProgress: { matches: 0, required: BOARDING_CONSECUTIVE_UPDATES }
    };
  });

  // Arrived buses sort before all others, then by ETA. Buses without an ETA go to the bottom.
  arrivals.sort((a, b) => {
    if (a.hasArrived !== b.hasArrived) return a.hasArrived ? -1 : 1;
    return (a.etaMinutes ?? Infinity) - (b.etaMinutes ?? Infinity);
  });

  let journey = null;
  try {
    journey = await buildJourneyView(journeyState);
  } catch (error) {
    console.error('Journey update failed:', error?.message || error);
  }

  res.json({
    location,
    arrivals,
    journey,
    provider: process.env.GOOGLE_ROUTES_API_KEY ? 'Google Routes API' : 'unavailable',
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
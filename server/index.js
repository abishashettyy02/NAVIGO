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

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);

const clientOrigin =
  process.env.CLIENT_ORIGIN || true;

const secret =
  process.env.JWT_SECRET ||
  'development-only-change-me';

const deviceApiKey =
  process.env.DEVICE_API_KEY || '';

let configuredDevices = [];

try {
  configuredDevices = JSON.parse(
    process.env.DEVICE_REGISTRY_JSON || '[]'
  );
} catch {
  console.warn(
    'DEVICE_REGISTRY_JSON is not valid JSON.'
  );
}

const io = new Server(server, {
  cors: {
    origin: clientOrigin
  }
});

app.use(cors({ origin: clientOrigin }));
app.use(express.json({ limit: '20kb' }));

/* =========================
   FALLBACK DATA
========================= */

const fallbackStops = [
  [
    'central',
    'Mangaluru Central',
    12.8698,
    74.842
  ],
  [
    'hampankatta',
    'Hampankatta',
    12.8667,
    74.8426
  ],
  [
    'kadri',
    'Kadri',
    12.886,
    74.8561
  ],
  [
    'bejai',
    'Bejai',
    12.8916,
    74.8497
  ],
  [
    'surathkal',
    'Surathkal',
    13.0091,
    74.7943
  ],
  [
    'konaje',
    'Konaje',
    12.7986,
    74.8854
  ],
  [
    'statebank',
    'State Bank',
    12.866,
    74.8427
  ]
].map(([id, name, lat, lng]) => ({
  id,
  name,
  lat,
  lng
}));

const fallbackRoutes = [
  {
    id: '42',
    number: '42',
    name: 'Central - Surathkal',
    stops: [
      'central',
      'hampankatta',
      'bejai',
      'surathkal'
    ],
    fare: 22
  },
  {
    id: '12',
    number: '12',
    name: 'State Bank - Konaje',
    stops: [
      'statebank',
      'hampankatta',
      'kadri',
      'konaje'
    ],
    fare: 20
  }
];

const slug = value =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

const numberFrom = value =>
  String(value || '').match(/^\s*(\S+)/)?.[1] ||
  'route';

/* =========================
   WORKBOOK
========================= */

function loadWorkbook() {
  const workbookPath =
    process.env.DATA_WORKBOOK_PATH ||
    path.resolve(projectRoot, '..', 'Navigo.xlsx');

  try {
    const book = XLSX.readFile(workbookPath);

    const timetableSheet =
      book.Sheets.Sheet2;

    if (!timetableSheet) {
      throw new Error('Sheet2 is missing');
    }

    const rows =
      XLSX.utils.sheet_to_json(
        timetableSheet,
        { defval: '' }
      );

    const headers =
      XLSX.utils
        .sheet_to_json(
          timetableSheet,
          { header: 1 }
        )[0]
        .slice(2)
        .filter(Boolean);

    const known = new Map(
      fallbackStops.map(stop => [
        slug(stop.name),
        stop
      ])
    );

    const stops = headers.map(
      (name, index) =>
        known.get(slug(name)) || {
          id: slug(name),
          name: String(name).trim(),
          lat:
            12.86 +
            (index % 7) * 0.008,
          lng:
            74.81 +
            Math.floor(index / 7) * 0.008
        }
    );

    for (const stop of fallbackStops) {
      if (
        !stops.some(
          item => item.id === stop.id
        )
      ) {
        stops.push(stop);
      }
    }

    const byName = new Map();

    for (const row of rows) {
      const name = String(
        row.Route || ''
      ).trim();

      if (!name || byName.has(name)) {
        continue;
      }

      byName.set(name, {
        id: slug(name),
        number: numberFrom(name),
        name,
        stops: headers
          .filter(header => row[header])
          .map(slug),
        fare: 20
      });
    }

    const routes = [...byName.values()];

    const inventory =
      XLSX.utils.sheet_to_json(
        book.Sheets.Sheet3,
        { defval: '' }
      );

    const buses = inventory.map(
      (row, index) => ({
        id: String(
          row['Bus ID'] ||
            `BUS-${index + 1}`
        ),

        routeId:
          routes.find(
            route =>
              route.number ===
              String(
                row['BUS NO.'] || ''
              ).trim()
          )?.id || 'route',

        operator: String(
          row.BUS || ''
        ).trim(),

        occupancy:
          'Tracking unavailable',

        lat: 12.87,
        lng: 74.84,

        updatedAt: null
      })
    );

    return {
      stops,

      routes:
        routes.length
          ? routes
          : fallbackRoutes,

      buses,

      rows
    };
  } catch (error) {
    console.warn(
      `Workbook not loaded: ${error.message}`
    );

    return {
      stops: fallbackStops,
      routes: fallbackRoutes,
      buses: [],
      rows: []
    };
  }
}

const transit = loadWorkbook();

/* =========================
   DATABASE
========================= */

const usersDbPath =
  process.env.USERS_DB_PATH ||
  path.resolve(
    projectRoot,
    'data',
    'users.db'
  );

fs.mkdirSync(
  path.dirname(usersDbPath),
  { recursive: true }
);

const usersDb =
  new Database(usersDbPath);

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

const selectUserByEmailStatement =
  usersDb.prepare(
    'SELECT * FROM users WHERE email = ?'
  );

const upsertUserStatement =
  usersDb.prepare(`
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
    sessionVersion:
      row.session_version
  };

const getUserByEmail = email =>
  rowToUser(
    selectUserByEmailStatement.get(email)
  );

const saveUser = user => {
  upsertUserStatement.run({
    ...user,
    createdAt: Date.now()
  });

  return user;
};

/* =========================
   AUTH / BREVO
========================= */

const pendingCodes = new Map();

const buses = new Map(
  transit.buses.map(bus => [
    bus.id,
    bus
  ])
);

const deviceRegistry = new Map(
  configuredDevices
    .filter(
      item =>
        item?.deviceId &&
        item?.busId
    )
    .map(item => [
      String(item.deviceId),
      {
        busId: String(item.busId),
        ip: item.ip
          ? String(item.ip)
          : null
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

const brevoApiKey =
  process.env.BREVO_API_KEY || '';

const brevoSenderEmail =
  process.env.BREVO_SENDER_EMAIL || '';

const brevoSenderName =
  process.env.BREVO_SENDER_NAME ||
  'NAVIGO';

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
      sessionVersion:
        user.sessionVersion
    },
    secret,
    {
      expiresIn: '12h'
    }
  );

const auth = roles => (
  req,
  res,
  next
) => {
  try {
    const user = jwt.verify(
      (
        req.headers.authorization || ''
      ).replace(
        'Bearer ',
        ''
      ),
      secret
    );

    const currentUser =
      getUserByEmail(user.email);

    if (
      !currentUser ||
      currentUser.sessionVersion !==
        user.sessionVersion
    ) {
      throw new Error(
        'Session is no longer valid'
      );
    }

    if (
      roles &&
      !roles.includes(user.role)
    ) {
      return res
        .status(403)
        .json({
          message: 'Forbidden'
        });
    }

    req.user = user;
    next();
  } catch {
    res
      .status(401)
      .json({
        message:
          'Sign in required'
      });
  }
};

/* =========================
   ROUTING
========================= */

function findOptions(
  from,
  to
) {
  return transit.routes.flatMap(
    route => {
      const start =
        route.stops.indexOf(from);

      const end =
        route.stops.indexOf(to);

      return start >= 0 &&
        end > start
        ? [
            {
              type: 'direct',
              route,

              bus: [
                ...buses.values()
              ].find(
                bus =>
                  bus.routeId ===
                  route.id
              ),

              durationMin:
                (end - start) * 7
            }
          ]
        : [];
    }
  );
}

function activeBuses() {
  const freshnessMs =
    5 * 60 * 1000;

  return [
    ...buses.values()
  ].filter(
    bus =>
      bus.updatedAt &&
      Date.now() -
        bus.updatedAt <
        freshnessMs
  );
}

/* =========================
   GOOGLE ROUTES / ETA
========================= */

/*
  Calculates the real road distance and
  traffic-aware travel duration from a
  live bus position to a passenger position.

  Google Routes API:

  - DRIVE
  - TRAFFIC_AWARE

  duration is returned by Google in
  seconds and is converted into minutes
  by /api/arrivals.
*/

async function routeToLocation(
  origin,
  destination
) {
  const apiKey =
    process.env.GOOGLE_ROUTES_API_KEY;

  if (!apiKey) {
    console.warn(
      'GOOGLE_ROUTES_API_KEY is not configured.'
    );

    return null;
  }

  const originLat =
    Number(origin?.lat);

  const originLng =
    Number(origin?.lng);

  const destinationLat =
    Number(destination?.lat);

  const destinationLng =
    Number(destination?.lng);

  if (
    !Number.isFinite(originLat) ||
    !Number.isFinite(originLng) ||
    !Number.isFinite(destinationLat) ||
    !Number.isFinite(destinationLng)
  ) {
    console.warn(
      'Invalid coordinates supplied to Google Routes.'
    );

    return null;
  }

  const response = await fetch(
    'https://routes.googleapis.com/directions/v2:computeRoutes',
    {
      method: 'POST',

      headers: {
        'Content-Type':
          'application/json',

        'X-Goog-Api-Key':
          apiKey,

        /*
          Request only the fields needed
          for ETA, distance and map route.
        */
        'X-Goog-FieldMask':
          'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline'
      },

      body: JSON.stringify({
        origin: {
          location: {
            latLng: {
              latitude: originLat,
              longitude: originLng
            }
          }
        },

        destination: {
          location: {
            latLng: {
              latitude: destinationLat,
              longitude: destinationLng
            }
          }
        },

        /*
          DRIVE allows road-based routing.

          TRAFFIC_AWARE makes Google's
          returned duration account for
          current traffic conditions.
        */
        travelMode: 'DRIVE',

        routingPreference:
          'TRAFFIC_AWARE'
      })
    }
  );

  if (!response.ok) {
    const errorText =
      await response.text().catch(
        () => ''
      );

    throw new Error(
      `Google Routes API returned ${response.status}${
        errorText
          ? `: ${errorText.slice(0, 300)}`
          : ''
      }`
    );
  }

  const data =
    await response.json();

  const route =
    data.routes?.[0];

  if (!route) {
    return null;
  }

  /*
    Google returns duration in a string
    such as "123s".
  */
  const durationMatch =
    String(
      route.duration || ''
    ).match(/^([\d.]+)s$/);

  const durationSeconds =
    durationMatch
      ? Number(durationMatch[1])
      : Number.NaN;

  const distanceMeters =
    Number(route.distanceMeters);

  if (
    !Number.isFinite(
      durationSeconds
    ) ||
    durationSeconds < 0
  ) {
    console.warn(
      'Google returned an invalid route duration.'
    );

    return null;
  }

  return {
    durationSeconds,

    distanceMeters:
      Number.isFinite(
        distanceMeters
      )
        ? distanceMeters
        : null,

    encodedPolyline:
      route.polyline
        ?.encodedPolyline ||
      null
  };
}

/* =========================
   DEVICE AUTH
========================= */

function assertDevice(
  req,
  res,
  next
) {
  if (!deviceApiKey) {
    return res
      .status(503)
      .json({
        message:
          'Hardware ingestion is not configured. Set DEVICE_API_KEY.'
      });
  }

  if (
    req.get('X-Device-Key') !==
    deviceApiKey
  ) {
    return res
      .status(401)
      .json({
        message:
          'Invalid device key.'
      });
  }

  next();
}

/* =========================
   BASIC API
========================= */

app.get(
  '/api/health',
  (req, res) =>
    res.json({
      ok: true,
      workbookLoaded:
        transit.rows.length > 0
    })
);

app.get(
  '/api/public/config',
  (req, res) =>
    res.json({
      googleMapsKey:
        process.env
          .GOOGLE_MAPS_API_KEY ||
        '',

      routeCount:
        transit.routes.length,

      tripCount:
        transit.rows.length
    })
);

app.get(
  '/api/stops',
  (req, res) =>
    res.json(transit.stops)
);

app.get(
  '/api/routes',
  (req, res) =>
    res.json(transit.routes)
);

app.get(
  '/api/buses',
  (req, res) =>
    res.json([
      ...buses.values()
    ])
);

app.get(
  '/api/timetable',
  (req, res) =>
    res.json(
      transit.rows
        .filter(
          row =>
            !req.query.route ||
            slug(row.Route) ===
              req.query.route
        )
        .slice(0, 12)
    )
);

app.get(
  '/api/driver/bus',
  auth(['driver']),
  (req, res) =>
    res.json(
      buses.get(req.user.busId) || {
        id: req.user.busId,
        routeId: 'route',
        occupancy:
          'Not reported',
        updatedAt: null
      }
    )
);

/* =========================
   REQUEST OTP
========================= */

app.post(
  '/api/auth/request-code',
  async (req, res) => {
    const {
      password,
      role = 'passenger',
      busId
    } = req.body;

    const email = String(
      req.body.email || ''
    )
      .trim()
      .toLowerCase();

    const isDriver =
      role === 'driver';

    if (
      !/^\S+@\S+\.\S+$/.test(
        email
      ) ||
      String(password).length < 8
    ) {
      return res
        .status(400)
        .json({
          message:
            'Use a valid email and an 8+ character password.'
        });
    }

    if (
      isDriver &&
      (
        !busId ||
        !buses.has(
          String(busId).trim()
        )
      )
    ) {
      return res
        .status(400)
        .json({
          message:
            'Enter a valid assigned bus ID to create a driver account.'
        });
    }

    if (
      pendingCodes.get(email)
        ?.sentAt >
      Date.now() - 60_000
    ) {
      return res
        .status(429)
        .json({
          message:
            'Please wait a minute before requesting another code.'
        });
    }

    if (
      !brevoApiKey ||
      !brevoSenderEmail
    ) {
      console.error(
        'BREVO_API_KEY or BREVO_SENDER_EMAIL is missing.'
      );

      return res
        .status(503)
        .json({
          message:
            'Email verification is not configured.'
        });
    }

    const code =
      crypto.randomInt(
        100000,
        1000000
      ).toString();

    pendingCodes.set(
      email,
      {
        code,

        password:
          await bcrypt.hash(
            password,
            12
          ),

        role:
          isDriver
            ? 'driver'
            : 'passenger',

        busId:
          isDriver
            ? String(
                busId
              ).trim()
            : null,

        sentAt:
          Date.now(),

        expiresAt:
          Date.now() +
          600000,

        attempts: 0
      }
    );

    try {
      console.log(
        `Attempting to send verification email to ${email}`
      );

      const brevoResponse =
        await fetch(
          'https://api.brevo.com/v3/smtp/email',
          {
            method: 'POST',

            headers: {
              accept:
                'application/json',

              'api-key':
                brevoApiKey,

              'content-type':
                'application/json'
            },

            body:
              JSON.stringify({
                sender: {
                  email:
                    brevoSenderEmail,

                  name:
                    brevoSenderName
                },

                to: [
                  {
                    email
                  }
                ],

                subject:
                  'Your NAVIGO verification code',

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
          }
        );

      const brevoResult =
        await brevoResponse
          .json()
          .catch(() => ({}));

      if (!brevoResponse.ok) {
        console.error(
          'BREVO EMAIL ERROR:',
          {
            statusCode:
              brevoResponse.status,
            ...brevoResult
          }
        );

        pendingCodes.delete(
          email
        );

        return res
          .status(502)
          .json({
            message:
              'We could not send the verification email.',
            provider:
              'Brevo'
          });
      }

      console.log(
        'Verification email sent successfully:',
        brevoResult
      );

      return res
        .status(202)
        .json({
          message:
            getUserByEmail(email)
              ? 'Verification code sent. Verifying it will replace your old password and sign out previous sessions.'
              : 'Verification code sent.'
        });
    } catch (error) {
      pendingCodes.delete(
        email
      );

      console.error(
        'BREVO SEND FAILED:',
        error
      );

      return res
        .status(502)
        .json({
          message:
            'We could not send the verification email.',
          provider:
            'Brevo',
          error:
            error?.message ||
            String(error)
        });
    }
  }
);

/* =========================
   VERIFY OTP
========================= */

app.post(
  '/api/auth/verify-code',
  (req, res) => {
    const email = String(
      req.body.email || ''
    )
      .trim()
      .toLowerCase();

    const pending =
      pendingCodes.get(email);

    if (
      !pending ||
      pending.expiresAt <
        Date.now()
    ) {
      pendingCodes.delete(
        email
      );

      return res
        .status(400)
        .json({
          message:
            'This code has expired. Request a new one.'
        });
    }

    if (
      ++pending.attempts >
      5
    ) {
      pendingCodes.delete(
        email
      );

      return res
        .status(429)
        .json({
          message:
            'Too many attempts. Request a new code.'
        });
    }

    if (
      String(
        req.body.code
      ).trim() !==
      pending.code
    ) {
      return res
        .status(400)
        .json({
          message:
            'That verification code is incorrect.'
        });
    }

    const oldUser =
      getUserByEmail(email);

    const user = {
      id:
        oldUser?.id ||
        crypto.randomUUID(),

      email,

      role:
        pending.role,

      busId:
        pending.busId,

      password:
        pending.password,

      sessionVersion:
        crypto.randomUUID()
    };

    saveUser(user);

    pendingCodes.delete(
      user.email
    );

    res
      .status(201)
      .json({
        token:
          tokenFor(user),

        user:
          publicUser(user)
      });
  }
);

/* =========================
   LOGIN
========================= */

app.post(
  '/api/auth/login',
  async (req, res) => {
    const user =
      getUserByEmail(
        String(
          req.body.email || ''
        )
          .trim()
          .toLowerCase()
      );

    if (
      !user ||
      !await bcrypt.compare(
        req.body.password || '',
        user.password
      )
    ) {
      return res
        .status(401)
        .json({
          message:
            'Incorrect email or password.'
        });
    }

    if (
      user.role === 'driver' &&
      String(
        req.body.busId || ''
      ).trim() !==
        user.busId
    ) {
      return res
        .status(403)
        .json({
          message:
            'Enter the bus ID assigned to this driver account.'
        });
    }

    res.json({
      token:
        tokenFor(user),

      user:
        publicUser(user)
    });
  }
);

/* =========================
   JOURNEY SEARCH
========================= */

app.post(
  '/api/journeys/search',
  auth(['passenger']),
  (req, res) => {
    const origin =
      transit.stops.find(
        stop =>
          stop.id ===
          req.body.from
      );

    const destination =
      transit.stops.find(
        stop =>
          stop.id ===
          req.body.to
      );

    if (
      !origin ||
      !destination ||
      origin.id ===
        destination.id
    ) {
      return res
        .status(400)
        .json({
          message:
            'Choose two different valid stops.'
        });
    }

    res.json({
      from: origin,

      to: destination,

      options:
        findOptions(
          origin.id,
          destination.id
        ),

      roadRoute: null,

      routingWarning:
        'Timetable routes are loaded from Navigo.xlsx.'
    });
  }
);

/* =========================
   ARRIVALS / LIVE ETA
========================= */

app.post(
  '/api/arrivals',
  auth(['passenger']),
  async (req, res) => {
    /*
      Passenger's current GPS position.
    */
    const lat =
      Number(req.body.lat);

    const lng =
      Number(req.body.lng);

    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      Math.abs(lat) > 90 ||
      Math.abs(lng) > 180
    ) {
      return res
        .status(400)
        .json({
          message:
            'A valid customer location is required.'
        });
    }

    const location = {
      lat,
      lng
    };

    /*
      Only buses with a recent GPS update
      are considered live.
    */
    const live =
      activeBuses();

    /*
      Calculate ETA and road distance for
      every live bus.

      Promise.allSettled means one failed
      Google route does not break all buses.
    */
    const results =
      await Promise.allSettled(
        live.map(
          async bus => {
            const route =
              await routeToLocation(
                bus,
                location
              );

            /*
              Calculate ETA from Google's
              traffic-aware duration.
            */
            const etaMinutes =
              route &&
              Number.isFinite(
                route.durationSeconds
              )
                ? Math.max(
                    1,
                    Math.ceil(
                      route.durationSeconds /
                        60
                    )
                  )
                : null;

            /*
              Keep the exact road distance
              in meters.

              DO NOT round this before
              checking the arrival threshold.
            */
            const distanceMeters =
              route &&
              Number.isFinite(
                route.distanceMeters
              )
                ? route.distanceMeters
                : null;

            /*
              Bus is considered ARRIVED when
              it is 5 meters or less from
              the passenger.
            */
            const hasArrived =
              distanceMeters !== null &&
              distanceMeters <= 5;

            /*
              Distance in kilometers is still
              returned for the existing frontend.
            */
            const distanceKm =
              distanceMeters !== null
                ? Number(
                    (
                      distanceMeters /
                      1000
                    ).toFixed(3)
                  )
                : null;

            return {
              ...bus,

              /*
                Final passenger-facing ETA.
              */
              etaMinutes,

              /*
                Exact Google road distance.
              */
              distanceMeters,

              /*
                Road distance in kilometers.
              */
              distanceKm,

              /*
                TRUE when the bus is within
                5 meters of the passenger.
              */
              hasArrived,

              /*
                Route information used by
                the frontend map.
              */
              roadRoute:
                route
            };
          }
        )
      );

    const arrivals =
      results.map(
        (result, index) => {
          if (
            result.status ===
            'fulfilled'
          ) {
            return result.value;
          }

          const bus =
            live[index];

          console.error(
            `ETA calculation failed for bus ${bus?.id}:`,
            result.reason?.message ||
              result.reason
          );

          /*
            Keep the bus visible even when
            Google cannot calculate its ETA.
          */
          return {
            ...bus,

            etaMinutes: null,

            distanceMeters: null,

            distanceKm: null,

            hasArrived: false,

            roadRoute: null
          };
        }
      );

    /*
      Sort buses by ETA.

      Buses without an ETA go to the bottom.
    */
    arrivals.sort(
      (a, b) =>
        (a.etaMinutes ??
          Infinity) -
        (b.etaMinutes ??
          Infinity)
    );

    res.json({
      location,

      arrivals,

      provider:
        process.env
          .GOOGLE_ROUTES_API_KEY
          ? 'Google Routes API'
          : 'unavailable',

      updatedAt:
        Date.now()
    });
  }
);

/* =========================
   HARDWARE GPS
========================= */

app.post(
  '/api/device/coordinates',
  assertDevice,
  (req, res) => {
    const {
      deviceId,
      lat,
      lng,
      occupancy = 'Unknown',
      accuracy,
      sentAt
    } = req.body;

    const device =
      deviceRegistry.get(
        String(
          deviceId || ''
        )
      );

    if (!device) {
      return res
        .status(403)
        .json({
          message:
            'This device is not assigned to a bus in the backend registry.'
        });
    }

    if (
      device.ip &&
      req.ip !== device.ip
    ) {
      return res
        .status(403)
        .json({
          message:
            'The device IP does not match its backend assignment.'
        });
    }

    const latitude =
      Number(lat);

    const longitude =
      Number(lng);

    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 ||
      Math.abs(longitude) > 180
    ) {
      return res
        .status(400)
        .json({
          message:
            'Valid latitude and longitude are required.'
        });
    }

    const existing =
      buses.get(
        device.busId
      ) || {};

    const parsedSentAt =
      sentAt
        ? new Date(
            sentAt
          ).getTime()
        : Date.now();

    const position = {
      ...existing,

      id:
        device.busId,

      deviceId,

      routeId:
        existing.routeId ||
        'route',

      lat:
        latitude,

      lng:
        longitude,

      occupancy,

      accuracy:
        Number.isFinite(
          Number(accuracy)
        )
          ? Number(accuracy)
          : null,

      updatedAt:
        Number.isFinite(
          parsedSentAt
        )
          ? parsedSentAt
          : Date.now(),

      source:
        'hardware'
    };

    buses.set(
      device.busId,
      position
    );

    io.emit(
      'bus:position',
      position
    );

    res
      .status(202)
      .json({
        accepted: true,

        busId:
          device.busId,

        receivedAt:
          Date.now()
      });
  }
);

/* =========================
   DRIVER LOCATION
========================= */

app.post(
  '/api/driver/location',
  auth(['driver']),
  (req, res) => {
    const {
      lat,
      lng,
      occupancy = 'Moderate'
    } = req.body;

    const latitude =
      Number(lat);

    const longitude =
      Number(lng);

    const existing =
      buses.get(
        req.user.busId
      ) || {};

    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 ||
      Math.abs(longitude) > 180
    ) {
      return res
        .status(400)
        .json({
          message:
            'Invalid location update.'
        });
    }

    const position = {
      ...existing,

      id:
        req.user.busId,

      routeId:
        existing.routeId ||
        'route',

      lat:
        latitude,

      lng:
        longitude,

      occupancy,

      updatedAt:
        Date.now(),

      source:
        'driver'
    };

    buses.set(
      req.user.busId,
      position
    );

    io.emit(
      'bus:position',
      position
    );

    res
      .status(204)
      .end();
  }
);

/* =========================
   SOCKET.IO
========================= */

io.on(
  'connection',
  socket =>
    socket.emit(
      'buses:initial',
      [...buses.values()]
    )
);

/* =========================
   PRODUCTION FRONTEND
========================= */

if (
  process.env.NODE_ENV ===
  'production'
) {
  app.use(
    express.static(
      path.join(
        projectRoot,
        'dist'
      )
    )
  );

  app.get(
    '*',
    (req, res) =>
      res.sendFile(
        path.join(
          projectRoot,
          'dist',
          'index.html'
        )
      )
  );
}

/* =========================
   START SERVER
========================= */

server.listen(
  process.env.PORT || 3001,
  () =>
    console.log(
      `NAVIGO server ready. Workbook data: ${
        transit.rows.length
          ? 'loaded'
          : 'demo mode'
      }.`
    )
);
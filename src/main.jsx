import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { io } from 'socket.io-client';
import './styles.css';

const API = import.meta.env.VITE_API_URL || '/api';
// A bus counts as live only with a recent update AND a usable GPS position (never a made-up one).
const fresh = bus => bus.updatedAt && Number.isFinite(bus.lat) && Number.isFinite(bus.lng) && Date.now() - bus.updatedAt < 300000;
const HARDWARE_STALE_MS = 60000; // no update from the bus GPS device in the last minute counts as offline

function loadMaps(key) { if (window.google?.maps) return Promise.resolve(window.google.maps); if (window.navigoMapsPromise) return window.navigoMapsPromise; window.navigoMapsPromise = new Promise((resolve, reject) => { const s = document.createElement('script'); s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&libraries=geometry&loading=async`; s.async = true; s.onload = () => resolve(window.google.maps); s.onerror = reject; document.head.append(s); }); return window.navigoMapsPromise; }
function LiveMap({ buses, customer, routePolyline, routeColor, stops, onBusClick }) {
  const host = useRef(null), map = useRef(null), markers = useRef(new Map()), stopMarkers = useRef(new Map()), line = useRef(null), clickRef = useRef(onBusClick), centered = useRef(false), fitted = useRef(''); const [key, setKey] = useState(null);
  clickRef.current = onBusClick;
  useEffect(() => { fetch(`${API}/public/config`).then(r => r.json()).then(c => setKey(c.googleMapsKey || '')).catch(() => setKey('')); }, []);
  useEffect(() => { if (!key || !host.current) return; let dead = false; loadMaps(key).then(maps => { if (dead) return; const instance = map.current ||= new maps.Map(host.current, { center: customer || { lat: 12.9141, lng: 74.856 }, zoom: customer ? 14 : 12, mapTypeControl: false, streetViewControl: false, fullscreenControl: false }); const points = [...buses.filter(fresh).map(b => ({ ...b, label: 'BUS' })), ...(customer ? [{ id: 'customer', ...customer, label: 'YOU' }] : [])]; const ids = new Set(points.map(p => p.id)); for (const [id, marker] of markers.current) if (!ids.has(id)) { marker.setMap(null); markers.current.delete(id); } points.forEach(p => { let marker = markers.current.get(p.id); if (!marker) { marker = new maps.Marker({ map: instance, label: p.label, title: p.id, icon: p.id === 'customer' ? undefined : { path: maps.SymbolPath.FORWARD_CLOSED_ARROW, scale: 6, fillColor: '#086ee8', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 } }); if (p.id !== 'customer') marker.addListener('click', () => clickRef.current?.(p.id)); markers.current.set(p.id, marker); } marker.setPosition({ lat: p.lat, lng: p.lng }); });
    // Stop markers: the pickup stop (light blue) and, once the journey starts, boarding + destination stops (dark blue).
    const stopList = (stops || []).filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lng)); const stopKeys = new Set(stopList.map(s => s.key)); for (const [id, marker] of stopMarkers.current) if (!stopKeys.has(id)) { marker.setMap(null); stopMarkers.current.delete(id); } stopList.forEach(s => { let marker = stopMarkers.current.get(s.key); if (!marker) { marker = new maps.Marker({ map: instance, zIndex: 5 }); stopMarkers.current.set(s.key, marker); } marker.setPosition({ lat: s.lat, lng: s.lng }); marker.setTitle(s.title || ''); marker.setLabel({ text: s.label, color: '#fff', fontSize: '11px', fontWeight: '700' }); marker.setIcon({ path: maps.SymbolPath.CIRCLE, scale: 11, fillColor: s.color, fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 }); });
    // Centre on the passenger once, then leave panning to the user; frame passenger + stops whenever the highlighted stops change.
    if (customer && !centered.current) { instance.setCenter(customer); centered.current = true; }
    const fitKey = stopList.length ? stopList.map(s => `${s.key}:${s.lat},${s.lng}`).join('|') : '';
    if (!fitKey) fitted.current = '';
    else if (customer && fitKey !== fitted.current) { const bounds = new maps.LatLngBounds(); bounds.extend(customer); stopList.forEach(s => bounds.extend({ lat: s.lat, lng: s.lng })); instance.fitBounds(bounds, 70); fitted.current = fitKey; }
    if (line.current) { line.current.setMap(null); line.current = null; } if (routePolyline && maps.geometry?.encoding) line.current = new maps.Polyline({ path: maps.geometry.encoding.decodePath(routePolyline), strokeColor: routeColor || '#086ee8', strokeOpacity: .85, strokeWeight: 5, map: instance }); }).catch(() => {}); return () => { dead = true; }; }, [key, buses, customer, routePolyline, routeColor, stops]);
  return <div ref={host} className="live-map">{key === '' && <div className="map-fallback">Add your Google Maps API key to show the live map.</div>}</div>;
}
function useBuses() { const [buses, setBuses] = useState([]); useEffect(() => { fetch(`${API}/buses`).then(r => r.json()).then(setBuses).catch(() => {}); const socket = io({ path: '/socket.io' }); socket.on('buses:initial', setBuses); socket.on('bus:position', bus => setBuses(current => [...current.filter(b => b.id !== bus.id), bus])); return () => socket.close(); }, []); return buses; }
function Auth({ done }) { const [role, setRole] = useState('passenger'); const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); async function submit(e) { e.preventDefault(); setBusy(true); setError(''); try { const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) }); const data = await r.json(); if (!r.ok) throw new Error(data.message); if (data.user.role !== role) throw new Error(`This is a ${data.user.role} account. Choose the ${data.user.role} sign-in tab.`); localStorage.setItem('navigo_session', JSON.stringify(data)); done(data); } catch (err) { setError(err.message); } finally { setBusy(false); } } const copy = role === 'driver' ? ['Driver sign in', 'Access your assigned bus and device status.', 'Open driver console'] : ['Customer sign in', 'Find live buses and arrivals near you.', 'View live arrivals']; return <main className="auth-page"><section className="brand"><div className="logo">N</div><p className="eyebrow">NAVIGO · MANGALURU</p><h1>Travel with the <em>right information.</em></h1><p>Live buses for passengers. Simple operational visibility for drivers.</p><div className="feature-row"><span>Current bus location</span><span>Traffic-aware arrival times</span><span>Secure device connection</span></div></section><form onSubmit={submit} className="auth-card"><div className="role-tabs"><button type="button" className={role === 'passenger' ? 'active' : ''} onClick={() => { setRole('passenger'); setError(''); }}><b>Customer</b><small>Track my bus</small></button><button type="button" className={role === 'driver' ? 'active' : ''} onClick={() => { setRole('driver'); setError(''); }}><b>Driver</b><small>My bus console</small></button></div><h2>{copy[0]}</h2><p>{copy[1]}</p><label>Email address<input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" required /></label><label>Password<input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Your password" required /></label>{error && <p className="error">{error}</p>}<button className="primary" disabled={busy}>{busy ? 'Signing in...' : copy[2]}</button></form></main>; }
function AuthV2({ done }) {
  const [role, setRole] = useState('passenger');
  const [view, setView] = useState('login'); // 'login' | 'register' | 'verify'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busId, setBusId] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const driver = role === 'driver';
  const title = view === 'verify' ? 'Check your email' : view === 'register' ? `Create ${driver ? 'driver' : 'customer'} account` : `${driver ? 'Driver' : 'Customer'} sign in`;
  async function call(path, body) {
    const r = await fetch(`${API}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.message || 'Something went wrong.');
    return data;
  }
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (view === 'login') {
        const data = await call('/auth/login', { email, password, busId: driver ? busId.trim() : undefined });
        if (data.user.role !== role) throw new Error(`This is a ${data.user.role} account. Choose the other tab.`);
        localStorage.setItem('navigo_session', JSON.stringify(data));
        done(data);
      } else if (view === 'register') {
        // Step 1: request the verification code, then switch to the code-entry step.
        const data = await call('/auth/request-code', { email, password, role, busId: driver ? busId.trim() : undefined });
        setNote(data.message || `We sent a verification code to ${email}.`);
        setCode('');
        setView('verify');
      } else {
        // Step 2: send the entered code to the existing verification/signup endpoint.
        const data = await call('/auth/verify-code', { email, code: code.trim() });
        localStorage.setItem('navigo_session', JSON.stringify(data));
        done(data);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  function changeRole(next) { setRole(next); setError(''); setNote(''); setCode(''); setView('login'); setBusId(''); }
  const verifying = view === 'verify';
  const subtitle = verifying ? `Enter the code sent to ${email}.` : driver ? 'Use the bus ID assigned to you.' : 'Find live buses near your location.';
  const buttonLabel = busy ? 'Please wait...' : verifying ? 'Verify & Create Account' : view === 'register' ? 'Send verification code' : driver ? 'Open driver console' : 'View live arrivals';
  return <main className="auth-page">
    <section className="brand"><div className="logo">N</div><p className="eyebrow">NAVIGO · MANGALURU</p><h1>Travel with the <em>right information.</em></h1><p>Live bus arrivals for customers and a secure bus console for drivers.</p><div className="feature-row"><span>Current bus location</span><span>Traffic-aware arrival times</span><span>Secure device connection</span></div></section>
    <form onSubmit={submit} className="auth-card">
      <div className="role-tabs"><button type="button" className={!driver ? 'active' : ''} onClick={() => changeRole('passenger')}><b>Customer</b><small>Track my bus</small></button><button type="button" className={driver ? 'active' : ''} onClick={() => changeRole('driver')}><b>Driver</b><small>My bus console</small></button></div>
      <div className="auth-title"><h2>{title}</h2><p>{subtitle}</p></div>
      {!verifying && <>
        <label>Email address<input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" required /></label>
        <label>Password<input type="password" value={password} onChange={e => setPassword(e.target.value)} minLength="8" placeholder="At least 8 characters" required /></label>
        {driver && <label>Assigned bus ID<input value={busId} onChange={e => setBusId(e.target.value.toUpperCase())} placeholder="Example: B001" required /></label>}
      </>}
      {verifying && <label>Verification Code<input className="code-input" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength="6" value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} placeholder="123456" autoFocus required /></label>}
      {note && <p className="success">{note}</p>}
      {error && <p className="error">{error}</p>}
      <button className="primary" type="submit" disabled={busy}>{buttonLabel}</button>
      {!verifying
        ? <button type="button" className="text-button auth-switch" onClick={() => { setView(view === 'login' ? 'register' : 'login'); setError(''); setNote(''); }}>{view === 'login' ? 'Create a new account' : 'Already have an account? Sign in'}</button>
        : <button type="button" className="text-button auth-switch" onClick={() => { setView('register'); setError(''); setNote(''); setCode(''); }}>Use a different email</button>}
    </form>
  </main>;
}
// etaMinutes === 0 (or hasArrived) always reads "Arrived". Number.isFinite (not truthiness) keeps an ETA of 0
// from being mistaken for "no ETA". "Calculating..." is only the state before the server has answered at all
// (status undefined); once it has answered, a missing ETA reads as a definite state, never an endless spinner.
const etaText = (etaMinutes, hasArrived, status) => {
  if (hasArrived || etaMinutes === 0 || status === 'arrived') return 'Arrived';
  if (Number.isFinite(etaMinutes)) return `${etaMinutes} min`;
  if (status === 'no-live-data') return 'No live bus data';
  if (status === 'awaiting-destination') return 'Choose destination';
  if (status === 'unavailable') return 'ETA unavailable';
  return 'Calculating...';
};
function Arrival({ item, selected, select }) {
  const route = item.routeId?.split('-')[0]?.toUpperCase() || 'LIVE';
  const arrived = item.hasArrived || item.etaMinutes === 0;
  const etaLabel = etaText(item.etaMinutes, item.hasArrived, item.etaStatus);
  const distanceLabel = arrived ? 'At stop' : Number.isFinite(item.distanceKm) ? `${item.distanceKm} km` : '—';
  const target = item.targetStop || item.boardingStop;
  return <button className={`arrival-card ${selected ? 'selected' : ''} ${arrived ? 'arrived' : ''}`} onClick={select}><div className="route-chip">{route}</div><div className="arrival-main"><strong>{etaLabel}</strong><span>{item.id} · {item.operator || 'Live bus'}{target ? ` · to ${target.name}` : ''}</span></div><div className="distance">{distanceLabel}<small>{item.source === 'hardware' ? 'GPS device' : 'Shared location'}</small></div></button>;
}
// Local-guide chatbot: pure client-side, curated Mangaluru/Tulunadu content keyed to stops
// that actually appear on NAVIGO's routes. No AI backend or API key required — it's a
// lightweight FAQ-style assistant, not a live LLM. Facts and Tulu/Konkani phrases below
// are checked against temple/church records and language references, not guessed.
const LOCAL_PLACES = {
  kadri: {
    name: 'Kadri',
    aliases: ['kadri hills', 'kadri temple'],
    specialty: 'Kadri is Mangaluru’s temple hill — a leafy, spring-fed quarter built up around one of the coast’s oldest shrines, Kadri Manjunatha Temple.',
    folklore: 'Kadri takes its name from "Kadarika Vihara," once a Buddhist monastery site later absorbed into the Nath Panthi yogi tradition. Every 12 years the resident Jogi ascetics elect a new head (Raja) of the math in a ceremony linked to Nashik.',
    legend: 'See the temple’s bronze Lokeshvara image — inscribed 968 CE (some readings give 1068 CE) as a gift of the Alupa king Kundavarma, and among the oldest bronze idols in South India — plus the nine sacred spring-fed ponds behind the shrine.',
    slang: '"Bombat" — coastal slang, used in both Tulu and Kannada here, for "awesome / superb." Heard constantly around Kadri.'
  },
  milagres: {
    name: 'Milagres',
    aliases: ['milagres church'],
    specialty: 'Milagres is one of Mangaluru’s oldest Catholic neighbourhoods, built up around Milagres Church, which still anchors the area.',
    folklore: 'Milagres Church was founded in 1680 by Bishop Thomas de Castro on land granted by the Hindu queen Chennamma of Keladi. It was one of 27 regional churches destroyed during Tipu Sultan’s 1784 campaign against Mangalorean Catholics, and was rebuilt afterward — the present building dates to 1911.',
    legend: 'The Milagres Fest each September is one of the oldest continuously held church feasts on this coast and draws crowds from across the city.',
    slang: '"Dev Borem Korum" — Mangalorean Konkani for "God bless you," used by the local Catholic community both as a blessing and a thank-you.'
  },
  hampankatta: {
    name: 'Hampankatta',
    aliases: ['central', 'mangaluru central', 'town hall', 'statebank', 'state bank'],
    specialty: 'Hampankatta is Mangaluru’s old commercial core — narrow lanes of jewellers, tailors, and decades-old eateries around the Town Hall circle.',
    folklore: 'Older residents still navigate by pre-independence shop and landmark names rather than current street names — ask for directions the old way and you’ll get a very different route.',
    legend: 'The Hampankatta–State Bank stretch is where most of the city’s heritage commercial buildings cluster — worth a slow walk if you have time between buses.',
    slang: '"Malla" — a common, friendly way coastal Karnataka youth address a friend or mate.'
  },
  surathkal: {
    name: 'Surathkal',
    aliases: ['surathkal beach', 'nitk'],
    specialty: 'Surathkal is a coastal stretch known for hosting NITK (National Institute of Technology Karnataka) right on the beach, alongside a working fishing harbour.',
    folklore: 'Local fisherfolk still read the rocky shoreline and sky around Surathkal for informal weather cues before heading out to sea.',
    legend: 'Walk out to the Surathkal lighthouse and beach next to the NITK campus — one of the most photographed coastlines on this route.',
    slang: '"Chill maadi" — Kannada-English hybrid for "relax / take it easy," used everywhere on campus and off it.'
  },
  kankanady: {
    name: 'Kankanady',
    aliases: ['kudroli'],
    specialty: 'Kankanady sits right next to Kudroli, one of Mangaluru’s most-visited temple neighbourhoods.',
    folklore: 'The nearby Kudroli Gokarnanatheshwara Temple was built in 1912 by social reformer Sri Narayana Guru specifically to be open to all castes — a deliberate break from the temple-entry restrictions of the time.',
    legend: 'Its annual Dasara procession, with the temple’s own decorated float, is one of the city’s biggest festival events — worth timing a visit around if you can.',
    slang: '"Barpe" — Tulu for "I’m coming" (also "I’ll be right back"), said constantly while people are getting ready to leave.'
  },
  ullala: {
    name: 'Ullal',
    aliases: ['ullala', 'ullal beach'],
    specialty: 'Ullal is a coastal town just south of the city, known for its beach and for one of coastal Karnataka’s most celebrated historical figures.',
    folklore: 'Ullal is remembered as the seat of Rani Abbakka Chowta, a 16th-century Tuluva queen who repeatedly fought off Portuguese naval attacks — still honoured locally as one of India’s earliest recorded women freedom fighters.',
    legend: 'Look for her memorial, and the annual Veera Rani Abbakka Utsava festival held in her honour in Ullal.',
    slang: '"Solmelu" — Tulu for "thank you."'
  },
  puttur: {
    name: 'Puttur',
    aliases: [],
    specialty: 'Puttur is an inland market town known for its areca nut trade and the Sri Mahalingeshwara Temple at its centre.',
    folklore: 'Puttur hosts one of the region’s well-known Kambala (traditional buffalo race) events each season, drawing crowds from across Tulunadu.',
    legend: 'Sri Mahalingeshwara Temple, right in the town centre, is the traditional starting point most visitors use to explore the town.',
    slang: '"Bejar aapundu" — Tulu for "I feel low / fed up," often dropped into an otherwise Kannada or English sentence.'
  }
};
const GENERIC_PLACE = {
  name: 'Mangaluru',
  specialty: 'Mangaluru is a port city known for its beaches, its cashew and seafood trade, and a food scene built on coconut and fresh catch — think neer dosa, kori rotti, and the original Gadbad ice cream sundae.',
  folklore: 'Across the wider Tulunadu region, village life still centres on Bhootha Kola — night-long ritual performances where mediums are believed to be possessed by guardian spirits — and Yakshagana, the coastal dance-drama that retells epics till dawn.',
  legend: 'No specific entry for that stop yet — start with Kadri Manjunatha Temple or the Kudroli Gokarnanatheshwara Temple, both short rides from most routes and central to local lore.',
  slang: '"Bombat" — awesome/superb. "Barpe" — Tulu for "I’m coming." "Solmelu" — Tulu for "thank you."'
};
function findLocalPlace(query) {
  const normalized = String(query || '').trim().toLowerCase();
  if (!normalized) return null;
  for (const place of Object.values(LOCAL_PLACES)) {
    const names = [place.name.toLowerCase(), ...place.aliases];
    if (names.some(name => normalized.includes(name) || name.includes(normalized))) return place;
  }
  return null;
}
function GuideCard({ place }) {
  return <div className="guide-card">
    <h4>{place.name}</h4>
    <p><strong>Specialty</strong>{place.specialty}</p>
    <p><strong>Folklore</strong>{place.folklore}</p>
    <p><strong>Local legend to visit</strong>{place.legend}</p>
    <p><strong>Local slang</strong>{place.slang}</p>
  </div>;
}
function LocalGuideWidget() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState([{ id: 0, from: 'bot', kind: 'text', text: 'Namaskara! I’m your Mangaluru local guide. Pick a stop below, or type its name — I’ll share its specialty, folklore, a local legend worth visiting, and some local slang.' }]);
  const bodyRef = useRef(null);
  useEffect(() => { bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: 'smooth' }); }, [messages, open]);
  function ask(query) {
    const text = String(query || '').trim();
    if (!text) return;
    const place = findLocalPlace(text) || { ...GENERIC_PLACE, name: text };
    setMessages(current => [...current, { id: current.length, from: 'user', kind: 'text', text }, { id: current.length + 1, from: 'bot', kind: 'card', place }]);
  }
  function surprise() { const keys = Object.keys(LOCAL_PLACES); ask(LOCAL_PLACES[keys[Math.floor(Math.random() * keys.length)]].name); }
  function submit(e) { e.preventDefault(); ask(input); setInput(''); }
  return <>
    <button type="button" className="guide-fab" onClick={() => setOpen(o => !o)} aria-label={open ? 'Close local guide chat' : 'Open local guide chat'}>{open ? '×' : '💬'}</button>
    {open && <div className="guide-panel">
      <div className="guide-header"><div><strong>ಕುಡ್ಲ Local Guide</strong><span>SPECIALTIES · FOLKLORE · LEGENDS · SLANG</span></div><button type="button" className="text-button" onClick={() => setOpen(false)}>Close</button></div>
      <div className="guide-body" ref={bodyRef}>
        {!messages.length && <div className="guide-msg bot guide-welcome">Barpe! Pick a stop below or ask about one to get the real specialty, folklore, a legend to visit, and local slang — all fact-checked, no guesswork.</div>}
        {messages.map(m => m.kind === 'card' ? <div key={m.id} className="guide-msg bot"><GuideCard place={m.place} /></div> : <div key={m.id} className={`guide-msg ${m.from}`}>{m.text}</div>)}
      </div>
      <div className="guide-chip-row">{Object.values(LOCAL_PLACES).map(p => <button type="button" key={p.name} className="guide-chip" onClick={() => ask(p.name)}>{p.name}</button>)}<button type="button" className="guide-chip surprise" onClick={surprise}>Surprise me</button></div>
      <form className="guide-input-row" onSubmit={submit}><input value={input} onChange={e => setInput(e.target.value)} placeholder="Ask about a stop, e.g. Kadri" /><button className="primary" type="submit">Send</button></form>
    </div>}
  </>;
}
const LIGHT_BLUE = '#4fc3f7'; // passenger -> pickup stop (before boarding)
const DARK_BLUE = '#0b2f8a'; // boarding stop -> destination (after boarding)
const REFRESH_MS = 12000; // live ETA/route refresh (within the 10-15s range)
function metersBetween(a, b) {
  const rad = d => d * Math.PI / 180, dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}
const TRIP_CSS = `
.trip-card{margin-top:18px;padding:16px;border-radius:16px;border:1px solid rgba(8,110,232,.22);background:rgba(8,110,232,.05)}
.trip-card .eyebrow{margin:0 0 10px}
.trip-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
.trip-grid label{display:flex;flex-direction:column;gap:6px;font-size:13px;font-weight:600}
.trip-grid select{width:100%;padding:10px 12px;border-radius:10px;border:1px solid rgba(0,0,0,.18);font:inherit;font-weight:400;background:#fff;color:#111}
.trip-grid select:disabled{opacity:.6}
.trip-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:12px}
.trip-hint{margin:10px 0 0;font-size:13px;opacity:.75}
.trip-status{display:flex;flex-direction:column;gap:2px;margin-bottom:12px;padding:12px 14px;border-radius:12px;background:#fff;border-left:5px solid ${LIGHT_BLUE}}
.trip-status.live{border-left-color:${DARK_BLUE}}
.trip-status b{font-size:20px}
.trip-status small{opacity:.75}
.pickup-card .trip-status{margin-bottom:0}
.pickup-card .trip-status strong{font-size:18px}
.legend-line{display:inline-block;width:18px;height:5px;border-radius:3px;margin:0 6px 1px 12px;vertical-align:middle}
.legend-line.light{background:${LIGHT_BLUE}}
.legend-line.dark{background:${DARK_BLUE}}
`;
// Nearest (or selected) pickup stop, with the road distance from the passenger. Shown even when no bus is live.
function PickupCard({ pickup }) {
  if (!pickup?.stop) return null;
  const distance = Number.isFinite(pickup.distanceKm) ? `${pickup.distanceKm} km by road${Number.isFinite(pickup.durationMin) ? ` · about ${pickup.durationMin} min ${pickup.travelMode === 'DRIVE' ? 'drive' : 'walk'}` : ''}` : null;
  return <div className="trip-card pickup-card">
    <p className="eyebrow">{pickup.locked ? 'BOARDING STOP' : 'YOUR PICKUP STOP'}</p>
    <div className="trip-status">
      <strong>{pickup.stop.name}</strong>
      {!pickup.locked && <small>{distance || 'Road distance unavailable right now.'}</small>}
      <small>{pickup.locked ? 'Stop where you boarded' : pickup.auto ? 'Nearest stop to you (automatic)' : 'Stop you selected'}</small>
      {pickup.source === 'gps-fallback' && <small>Road routing is unavailable, so the nearest stop was picked by straight-line distance and no distance is shown.</small>}
    </div>
  </div>;
}
function TripPlanner({ selected, stopId, destinationId, journey, busy, onStop, onDestination, onStart, onEnd }) {
  const stops = selected?.routeStops || [];
  if (!stops.length) return null;
  const boardingId = selected.boardingStop?.id;
  const boardingIndex = stops.findIndex(s => s.id === boardingId);
  const destOptions = boardingIndex >= 0 ? stops.slice(boardingIndex + 1) : stops;
  const destValue = destOptions.some(s => s.id === destinationId) ? destinationId : '';
  const phase = journey?.phase || null;
  const started = phase === 'in_journey', completed = phase === 'completed', boarded = phase === 'boarded';
  const destName = journey?.destination?.name;
  return <div className="trip-card">
    <p className="eyebrow">YOUR TRIP · BUS {selected.id}</p>
    {started && <div className="trip-status live"><strong>Journey in progress · Bus {journey.busId}{destName ? ` → ${destName}` : ''}</strong><b>{etaText(journey.etaMinutes, journey.hasArrived, journey.etaStatus)}</b>{journey.busOffline && <small>Bus location is not updating right now.</small>}{journey.warning && <small>{journey.warning}</small>}</div>}
    {completed && <div className="trip-status live"><strong>You have arrived{destName ? ` at ${destName}` : ''}.</strong></div>}
    {boarded && <div className="trip-status"><strong>Boarding detected on bus {journey.busId}.</strong><small>{journey.warning || 'Choose your destination stop to start the journey.'}</small></div>}
    <div className="trip-grid">
      <label>Boarding stop<select value={stopId} onChange={e => onStop(e.target.value)} disabled={started || completed || boarded}><option value="">{`Auto · nearest stop${selected.boardingStopAuto && selected.boardingStop ? ` (${selected.boardingStop.name})` : ''}`}</option>{stops.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label>Destination stop<select value={destValue} onChange={e => onDestination(e.target.value)} disabled={completed}><option value="">Choose destination</option>{destOptions.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
    </div>
    <div className="trip-actions">
      {!started && !completed && <button type="button" className="primary" disabled={!destValue || busy} onClick={onStart}>Start journey</button>}
      {(started || completed || boarded) && <button type="button" className="text-button" onClick={onEnd}>{completed ? 'Done' : 'End journey'}</button>}
    </div>
    {!started && !completed && <p className="trip-hint">Pick a destination, then tap your bus on the map (or “Start journey”) once you’re on board. We also start automatically after detecting you riding with the bus.</p>}
  </div>;
}
function Dashboard({ session, logout }) {
  const buses = useBuses();
  const [customer, setCustomer] = useState(null);
  const [arrivals, setArrivals] = useState([]);
  const [selected, setSelected] = useState(null);
  const [journey, setJourney] = useState(null);
  const [pickup, setPickup] = useState(null);
  const [noBusMessage, setNoBusMessage] = useState('');
  const [stopId, setStopId] = useState('');
  const [destinationId, setDestinationId] = useState('');
  const [status, setStatus] = useState('Share your location to find buses approaching you.');
  const [busy, setBusy] = useState(false);
  // Latest GPS fix (kept fresh by watchPosition) and latest selections, read by the polling loop
  // so it never works from a stale closure.
  const positionRef = useRef(null), watchRef = useRef(null), requestSeq = useRef(0), selection = useRef({});
  selection.current = { busId: selected?.id || null, stopId: stopId || null, destinationStopId: destinationId || null };
  const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` };
  async function calculate(override = {}) {
    const position = positionRef.current;
    if (!position) return;
    const seq = ++requestSeq.current;
    setBusy(true);
    setStatus('Finding your nearest stop and live arrival estimates...');
    try {
      const body = { lat: position.lat, lng: position.lng, accuracy: position.accuracy ?? undefined, ...selection.current, ...override };
      const r = await fetch(`${API}/arrivals`, { method: 'POST', headers: authHeaders, body: JSON.stringify(body) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.message || 'Could not refresh arrivals.');
      if (seq !== requestSeq.current) return; // a newer refresh already superseded this one
      const list = data.arrivals || [];
      const nextJourney = data.journey || null;
      setArrivals(list);
      setJourney(nextJourney);
      setPickup(data.pickup || null);
      setNoBusMessage(list.length ? '' : data.message || 'No live bus data');
      if (nextJourney?.destination?.id) setDestinationId(nextJourney.destination.id);
      // Keep the previously selected bus selected across a refresh (matched by id) instead of
      // always resetting to the first result, so an arriving bus doesn't jump out from under the user.
      // Once boarding is detected / a journey runs, the journey's bus takes over the selection.
      setSelected(current => {
        const journeyBusId = nextJourney && ['boarded', 'in_journey', 'completed'].includes(nextJourney.phase) ? nextJourney.busId : null;
        return (journeyBusId && list.find(item => item.id === journeyBusId)) || (current && list.find(item => item.id === current.id)) || list[0] || null;
      });
      if (list.length) setStatus(data.provider === 'unavailable' ? data.routingWarning || 'Road routing is unavailable.' : `Updated just now using ${data.provider}.`);
      else setStatus(data.routingWarning ? `${data.message || 'No live bus data'}. ${data.routingWarning}` : data.message || 'No live bus data');
    } catch (err) {
      if (seq === requestSeq.current) setStatus(err.message);
    } finally {
      if (seq === requestSeq.current) setBusy(false);
    }
  }
  function applyPosition(p) {
    const next = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Number.isFinite(p.coords.accuracy) ? p.coords.accuracy : null };
    if (!Number.isFinite(next.lat) || !Number.isFinite(next.lng)) return; // ignore an invalid GPS fix
    positionRef.current = next;
    // Only move the map marker for real movement, so GPS jitter doesn't constantly redraw the map.
    setCustomer(current => current && metersBetween(current, next) < 10 ? current : { lat: next.lat, lng: next.lng });
  }
  function locate() {
    if (!navigator.geolocation) return setStatus('This browser does not support location sharing.');
    setStatus('Requesting your location...');
    navigator.geolocation.getCurrentPosition(p => {
      applyPosition(p);
      // Keep following the passenger so boarding detection compares fresh positions to the bus.
      if (watchRef.current === null) watchRef.current = navigator.geolocation.watchPosition(applyPosition, () => {}, { enableHighAccuracy: true, timeout: 20000, maximumAge: 5000 });
      calculate();
    }, () => setStatus('Location permission was not granted. Try again when ready.'), { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
  }
  useEffect(() => () => { if (watchRef.current !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchRef.current); }, []);
  // Live ETA/route state refreshes every 12 seconds once a location is set, with proper cleanup
  // so the interval never outlives this component.
  const hasLocation = !!customer;
  useEffect(() => {
    if (!hasLocation) return;
    const id = setInterval(() => calculate(), REFRESH_MS);
    return () => clearInterval(id);
  }, [hasLocation]);
  function chooseBus(item) {
    setSelected(item);
    setStopId('');
    const onRoute = (item.routeStops || []).some(s => s.id === destinationId);
    if (!onRoute) setDestinationId('');
    calculate({ busId: item.id, stopId: null, destinationStopId: onRoute ? destinationId : null });
  }
  function changeStop(value) {
    setStopId(value);
    const stops = selected?.routeStops || [];
    const stopIndex = stops.findIndex(s => s.id === value), destIndex = stops.findIndex(s => s.id === destinationId);
    const keepDestination = !value || stopIndex < 0 || destIndex > stopIndex;
    if (!keepDestination) setDestinationId('');
    calculate({ stopId: value || null, destinationStopId: keepDestination ? destinationId || null : null });
  }
  function changeDestination(value) {
    setDestinationId(value);
    calculate({ destinationStopId: value || null });
  }
  async function startJourney(item = selected) {
    if (!item) return;
    if (!destinationId) return setStatus('Choose a destination stop first.');
    const position = positionRef.current;
    const boardingStopId = (item.id === selected?.id && stopId) || item.boardingStop?.id || null;
    try {
      const r = await fetch(`${API}/journey/start`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ busId: item.id, destinationStopId: destinationId, stopId: boardingStopId, lat: position?.lat, lng: position?.lng }) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.message || 'Could not start the journey.');
      setSelected(item);
      setStatus(`Journey started on bus ${item.id}.`);
      calculate({ busId: item.id, destinationStopId: destinationId });
    } catch (err) {
      setStatus(err.message);
    }
  }
  async function endJourney() {
    try {
      await fetch(`${API}/journey/end`, { method: 'POST', headers: authHeaders, body: '{}' });
    } catch { /* the next refresh reports the real state */ }
    setJourney(null);
    setStopId('');
    setDestinationId('');
    calculate({ stopId: null, destinationStopId: null });
  }
  // Tapping a bus on the map starts the journey manually once a destination is chosen.
  function handleBusClick(id) {
    const item = arrivals.find(a => a.id === id);
    if (!item) return setStatus(`Bus ${id} does not serve your pickup stop${pickup?.stop ? ` (${pickup.stop.name})` : ''}.`);
    if (journey && journey.phase !== 'boarded') return setSelected(item);
    if (destinationId && (item.routeStops || []).some(s => s.id === destinationId)) return startJourney(item);
    chooseBus(item);
    setStatus(`Bus ${item.id} selected. Choose a destination stop, then tap the bus again (or “Start journey”) once you’re on board.`);
  }
  const live = buses.filter(fresh).length;
  const inJourney = !!journey && (journey.phase === 'in_journey' || journey.phase === 'completed');
  const journeyActive = !!journey && ['boarded', 'in_journey', 'completed'].includes(journey.phase);
  const selectedArrived = selected?.hasArrived || selected?.etaMinutes === 0;
  // LIGHT BLUE passenger -> pickup stop line before boarding; DARK BLUE boarding stop -> destination line only after the journey starts.
  const routePolyline = inJourney ? journey.roadRoute?.encodedPolyline || null : journeyActive ? null : pickup?.roadRoute?.encodedPolyline || null;
  const routeColor = inJourney ? DARK_BLUE : LIGHT_BLUE;
  const stopMarkers = [];
  if (inJourney) {
    if (journey.currentStop) stopMarkers.push({ key: 'current', ...journey.currentStop, label: 'S', color: DARK_BLUE, title: `Boarding stop: ${journey.currentStop.name}` });
    if (journey.destination) stopMarkers.push({ key: 'destination', ...journey.destination, label: 'D', color: DARK_BLUE, title: `Destination: ${journey.destination.name}` });
  } else if (!journeyActive && pickup?.stop) {
    stopMarkers.push({ key: 'pickup', ...pickup.stop, label: 'S', color: LIGHT_BLUE, title: `Pickup stop: ${pickup.stop.name}` });
  }
  const stopMarkersKey = JSON.stringify(stopMarkers);
  const mapStops = useMemo(() => stopMarkers, [stopMarkersKey]);
  const emptyTitle = hasLocation ? (noBusMessage || 'No live bus data') : 'No arrivals to show yet';
  const emptyText = hasLocation ? (pickup?.stop ? `Your pickup stop is ${pickup.stop.name}. Buses appear here as soon as one serving it shares a live location.` : 'Buses appear here as soon as one shares a live location.') : 'Choose “Use my location” once your bus starts sharing its live location.';
  return <main className="dashboard"><style>{TRIP_CSS}</style><header><div className="wordmark"><span>N</span> NAVIGO <small>LIVE</small></div><div className="account"><span>{session.user.email}</span><button className="text-button" onClick={logout}>Sign out</button></div></header><section className="dashboard-hero"><div><p className="eyebrow">LIVE ARRIVALS</p><h1>When is my bus coming?</h1><p>See the latest location and expected arrival time for buses near you.</p><button className="primary location-button" onClick={locate} disabled={busy}>{busy ? 'Updating arrivals...' : customer ? 'Refresh arrivals' : 'Use my location'}</button></div><div className="live-orb"><strong>{live}</strong><span>buses<br />live now</span></div></section><section className="map-shell"><LiveMap buses={buses} customer={customer} routePolyline={routePolyline} routeColor={routeColor} stops={mapStops} onBusClick={handleBusClick} /><div className="map-legend"><span className="legend-dot customer" /> Your location <span className="legend-dot bus" /> Bus{routePolyline && <><span className={`legend-line ${inJourney ? 'dark' : 'light'}`} />{inJourney ? 'Your route to destination' : 'You to pickup stop'}</>}</div>{inJourney ? <div className="eta-bubble"><span>{journey.hasArrived ? 'Status' : 'Arrival at destination'}</span><strong>{journey.hasArrived ? 'You Have Arrived' : etaText(journey.etaMinutes, journey.hasArrived, journey.etaStatus)}</strong></div> : !journeyActive && selected && <div className="eta-bubble"><span>{selectedArrived ? 'Status' : 'Estimated arrival'}</span><strong>{selectedArrived ? 'Bus Arrived' : etaText(selected.etaMinutes, selected.hasArrived, selected.etaStatus)}</strong></div>}</section><section className="arrivals-panel"><div className="section-heading"><div><p className="eyebrow">ARRIVALS</p><h2>Nearby buses</h2></div><span className="status-pill"><i /> {live ? 'Live tracking' : 'No active tracking'}</span></div><p className="notice">{status}</p><div className="arrival-list">{arrivals.map(item => <Arrival key={item.id} item={item} selected={selected?.id === item.id} select={() => chooseBus(item)} />)}{!arrivals.length && <div className="empty-state"><strong>{emptyTitle}</strong><span>{emptyText}</span></div>}</div><PickupCard pickup={pickup} /><TripPlanner selected={selected} stopId={stopId} destinationId={destinationId} journey={journey} busy={busy} onStop={changeStop} onDestination={changeDestination} onStart={() => startJourney()} onEnd={endJourney} /></section><section className="how-it-works"><span>Live GPS updates</span><span>Traffic-aware travel time</span><span>Arrival updates every 12 seconds</span></section><LocalGuideWidget /></main>;
}
function DriverConsole({ session, logout }) { const buses = useBuses(); const bus = buses.find(item => item.id === session.user.busId); const online = bus && fresh(bus); return <main className="dashboard driver-console"><header><div className="wordmark"><span>N</span> NAVIGO <small>DRIVER</small></div><div className="account"><span>{session.user.email}</span><button className="text-button" onClick={logout}>Sign out</button></div></header><section className="driver-header"><div><p className="eyebrow">DRIVER CONSOLE</p><h1>Today’s bus status</h1><p>This account is assigned to bus <strong>{session.user.busId}</strong>. Keep its GPS unit powered so customers can see live arrival times.</p></div><span className={`connection ${online ? 'online' : ''}`}><i /> {online ? 'Device connected' : 'Waiting for device'}</span></section><section className="driver-grid"><article className="driver-card"><p className="field-label">ASSIGNED BUS</p><div className="bus-status"><span className="route-chip">{bus?.routeId?.split('-')[0]?.toUpperCase() || '—'}</span><div><strong>{session.user.busId}</strong><span>{bus?.operator || 'Bus assignment verified'}</span></div></div><dl><div><dt>GPS update</dt><dd>{online ? 'Receiving live location' : 'No recent update'}</dd></div><div><dt>Passenger visibility</dt><dd>{online ? 'Visible in customer app' : 'Not visible yet'}</dd></div><div><dt>Occupancy</dt><dd>{bus?.occupancy || 'Not reported'}</dd></div></dl></article><article className="driver-card help-card"><p className="eyebrow">DEVICE CHECK</p><h2>Before leaving</h2><ol><li>Connect the GPS device to power.</li><li>Make sure its mobile data is on.</li><li>Wait for “Device connected” above.</li></ol><p className="notice">The device sends the location automatically. There is nothing to update while driving.</p></article></section><section className="map-shell driver-map"><LiveMap buses={bus ? [bus] : []} /><div className="map-legend"><span className="legend-dot bus" /> Assigned bus location</div></section></main>; }
function DriverConsoleV2({ session, logout }) {
  // Live bus state comes from the same socket-backed hook the passenger dashboard uses, so
  // this console reacts instantly to both hardware GPS pings and driver-shared updates.
  const buses = useBuses();
  const bus = buses.find(item => item.id === session.user.busId);

  const [loaded, setLoaded] = useState(false);
  const [hardwareLastSeen, setHardwareLastSeen] = useState(null);
  const [, tick] = useState(0);
  const [sharing, setSharing] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [promptDismissed, setPromptDismissed] = useState(false);
  const [status, setStatus] = useState('Bus GPS device is the primary source for this bus.');

  useEffect(() => { if (buses.length) setLoaded(true); }, [buses.length]);
  // Track the most recent moment the hardware device itself reported in, independent of
  // whichever source last overwrote the bus record — this is what "GPS device offline" means.
  useEffect(() => { if (bus?.source === 'hardware' && bus.updatedAt) setHardwareLastSeen(current => Math.max(current || 0, bus.updatedAt)); }, [bus?.source, bus?.updatedAt]);
  useEffect(() => { const id = setInterval(() => tick(t => t + 1), 15000); return () => clearInterval(id); }, []);

  const hardwareOnline = !!hardwareLastSeen && Date.now() - hardwareLastSeen < HARDWARE_STALE_MS;
  // Once the device comes back, forget the earlier dismissal so a future outage prompts again.
  useEffect(() => { if (hardwareOnline) setPromptDismissed(false); }, [hardwareOnline]);
  const showPrompt = loaded && !sharing && !hardwareOnline && !promptDismissed;
  const activeSource = sharing ? 'driver' : hardwareOnline ? 'hardware' : 'none';
  const online = activeSource !== 'none';
  const sourceLabel = activeSource === 'driver' ? 'Driver Device Location' : activeSource === 'hardware' ? 'Bus GPS Device' : 'No live location';

  function startSharing() {
    setPromptDismissed(true);
    if (!navigator.geolocation) { setStatus('This browser does not support live location sharing.'); return; }
    setStatus('Requesting device location permission...');
    navigator.geolocation.getCurrentPosition(
      () => { setPermissionDenied(false); setSharing(true); },
      error => { setSharing(false); setPermissionDenied(error.code === error.PERMISSION_DENIED); setStatus(error.code === error.PERMISSION_DENIED ? 'Location permission was denied. Tap "Try again" once you enable it.' : 'Could not get your device location. Try again.'); },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
  }
  function stopSharing() { setSharing(false); setStatus(hardwareOnline ? 'Stopped sharing your device location. Back to the bus GPS device.' : 'Stopped sharing your device location.'); }

  useEffect(() => {
    if (!sharing) return;
    if (!navigator.geolocation) { setStatus('This browser does not support live location sharing.'); setSharing(false); return; }
    const watch = navigator.geolocation.watchPosition(async position => {
      try {
        const r = await fetch(`${API}/driver/location`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` }, body: JSON.stringify({ lat: position.coords.latitude, lng: position.coords.longitude, occupancy: bus?.occupancy || 'Moderate' }) });
        if (!r.ok) throw new Error('Location update was rejected.');
        setStatus(`Sharing your device location · updated ${new Date().toLocaleTimeString()}`);
      } catch (error) { setStatus(error.message); }
    }, () => { setStatus('Location permission was denied.'); setPermissionDenied(true); setSharing(false); }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
    return () => navigator.geolocation.clearWatch(watch);
  }, [sharing, session.token, bus?.occupancy]);

  return <main className="dashboard driver-console">
    <header><div className="wordmark"><span>N</span> NAVIGO <small>DRIVER</small></div><div className="account"><span>{session.user.email}</span><button className="text-button" onClick={logout}>Sign out</button></div></header>
    <section className="driver-header">
      <div><p className="eyebrow">DRIVER CONSOLE</p><h1>Your assigned bus</h1><p>Bus ID <strong>{session.user.busId}</strong> is locked to this account. Your GPS device connects to it in the backend.</p></div>
      <span className={`connection ${online ? 'online' : ''}`}><i /> {online ? `Tracking active · ${sourceLabel}` : 'No recent tracking'}</span>
    </section>
    {showPrompt && <div className="gps-alert">
      <div><strong>Bus GPS device is unavailable.</strong><p>Use your device location as the bus location?</p></div>
      <div className="gps-alert-actions"><button className="primary" onClick={startSharing}>Yes, use my location</button><button type="button" className="text-button" onClick={() => setPromptDismissed(true)}>Not now</button></div>
    </div>}
    <section className="driver-grid">
      <article className="driver-card">
        <p className="field-label">ASSIGNED BUS</p>
        <div className="bus-status"><span className="route-chip">{bus?.routeId?.split('-')[0]?.toUpperCase() || '—'}</span><div><strong>{session.user.busId}</strong><span>{bus?.operator || 'Bus assignment verified'}</span></div></div>
        <dl><div><dt>Active source</dt><dd>{sourceLabel}</dd></div><div><dt>Last update</dt><dd>{bus?.updatedAt ? new Date(bus.updatedAt).toLocaleTimeString() : '—'}</dd></div><div><dt>Customers</dt><dd>{online ? 'Can see your bus' : 'Waiting for location'}</dd></div></dl>
      </article>
      <article className="driver-card help-card">
        <p className="eyebrow">DRIVER DEVICE LOCATION</p>
        <h2>{sharing ? 'Currently sharing your location' : 'GPS device not working?'}</h2>
        <p>Use your phone, tablet, or laptop only as a temporary backup for this bus. Turn it off and the console switches back to the bus GPS device as soon as it's reporting again.</p>
        <div className="source-control">
          <button type="button" role="switch" aria-checked={sharing} className={`source-toggle ${sharing ? 'on' : ''}`} onClick={() => (sharing ? stopSharing() : startSharing())}><span className="source-toggle-knob" /></button>
          <div className="source-control-copy"><strong>Driver device location</strong><span>{sharing ? 'ON — sharing your live location' : permissionDenied ? 'OFF — permission denied, tap to try again' : 'OFF — tap to share your location'}</span></div>
        </div>
        <p className="notice">{status}</p>
      </article>
    </section>
    <section className="map-shell driver-map"><LiveMap buses={bus ? [bus] : []} /><div className="map-legend"><span className="legend-dot bus" /> Assigned bus location</div></section>
  </main>;
}
function App() { const [session, setSession] = useState(null); useEffect(() => { localStorage.removeItem('navigo_session'); }, []); const logout = () => { localStorage.removeItem('navigo_session'); setSession(null); }; if (!session) return <AuthV2 done={setSession} />; return session.user.role === 'driver' ? <DriverConsoleV2 session={session} logout={logout} /> : <Dashboard session={session} logout={logout} />; }
createRoot(document.getElementById('root')).render(<App />);
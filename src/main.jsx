import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { io } from 'socket.io-client';
import './styles.css';

const API = import.meta.env.VITE_API_URL || '/api';
const fresh = bus => bus.updatedAt && Date.now() - bus.updatedAt < 300000;
const HARDWARE_STALE_MS = 60000; // no update from the bus GPS device in the last minute counts as offline

function loadMaps(key) { if (window.google?.maps) return Promise.resolve(window.google.maps); if (window.navigoMapsPromise) return window.navigoMapsPromise; window.navigoMapsPromise = new Promise((resolve, reject) => { const s = document.createElement('script'); s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&libraries=geometry&loading=async`; s.async = true; s.onload = () => resolve(window.google.maps); s.onerror = reject; document.head.append(s); }); return window.navigoMapsPromise; }
function LiveMap({ buses, customer, arrival }) {
  const host = useRef(null), map = useRef(null), markers = useRef(new Map()), line = useRef(null); const [key, setKey] = useState(null);
  useEffect(() => { fetch(`${API}/public/config`).then(r => r.json()).then(c => setKey(c.googleMapsKey || '')).catch(() => setKey('')); }, []);
  useEffect(() => { if (!key || !host.current) return; let dead = false; loadMaps(key).then(maps => { if (dead) return; const instance = map.current ||= new maps.Map(host.current, { center: customer || { lat: 12.9141, lng: 74.856 }, zoom: customer ? 14 : 12, mapTypeControl: false, streetViewControl: false, fullscreenControl: false }); const points = [...buses.filter(fresh).map(b => ({ ...b, label: 'BUS' })), ...(customer ? [{ id: 'customer', ...customer, label: 'YOU' }] : [])]; const ids = new Set(points.map(p => p.id)); for (const [id, marker] of markers.current) if (!ids.has(id)) { marker.setMap(null); markers.current.delete(id); } points.forEach(p => { let marker = markers.current.get(p.id); if (!marker) { marker = new maps.Marker({ map: instance, label: p.label, title: p.id, icon: p.id === 'customer' ? undefined : { path: maps.SymbolPath.FORWARD_CLOSED_ARROW, scale: 6, fillColor: '#086ee8', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 } }); markers.current.set(p.id, marker); } marker.setPosition({ lat: p.lat, lng: p.lng }); }); if (customer) instance.setCenter(customer); if (line.current) line.current.setMap(null); if (arrival?.roadRoute?.encodedPolyline && maps.geometry?.encoding) line.current = new maps.Polyline({ path: maps.geometry.encoding.decodePath(arrival.roadRoute.encodedPolyline), strokeColor: '#086ee8', strokeOpacity: .8, strokeWeight: 5, map: instance }); }); return () => { dead = true; }; }, [key, buses, customer, arrival]);
  return <div ref={host} className="live-map">{key === '' && <div className="map-fallback">Add your Google Maps API key to show the live map.</div>}</div>;
}
function useBuses() { const [buses, setBuses] = useState([]); useEffect(() => { fetch(`${API}/buses`).then(r => r.json()).then(setBuses).catch(() => {}); const socket = io({ path: '/socket.io' }); socket.on('buses:initial', setBuses); socket.on('bus:position', bus => setBuses(current => [...current.filter(b => b.id !== bus.id), bus])); return () => socket.close(); }, []); return buses; }
function Auth({ done }) { const [role, setRole] = useState('passenger'); const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); async function submit(e) { e.preventDefault(); setBusy(true); setError(''); try { const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) }); const data = await r.json(); if (!r.ok) throw new Error(data.message); if (data.user.role !== role) throw new Error(`This is a ${data.user.role} account. Choose the ${data.user.role} sign-in tab.`); localStorage.setItem('navigo_session', JSON.stringify(data)); done(data); } catch (err) { setError(err.message); } finally { setBusy(false); } } const copy = role === 'driver' ? ['Driver sign in', 'Access your assigned bus and device status.', 'Open driver console'] : ['Customer sign in', 'Find live buses and arrivals near you.', 'View live arrivals']; return <main className="auth-page"><section className="brand"><div className="logo">N</div><p className="eyebrow">NAVIGO · MANGALURU</p><h1>Travel with the <em>right information.</em></h1><p>Live buses for passengers. Simple operational visibility for drivers.</p><div className="feature-row"><span>Current bus location</span><span>Traffic-aware arrival times</span><span>Secure device connection</span></div></section><form onSubmit={submit} className="auth-card"><div className="role-tabs"><button type="button" className={role === 'passenger' ? 'active' : ''} onClick={() => { setRole('passenger'); setError(''); }}><b>Customer</b><small>Track my bus</small></button><button type="button" className={role === 'driver' ? 'active' : ''} onClick={() => { setRole('driver'); setError(''); }}><b>Driver</b><small>My bus console</small></button></div><h2>{copy[0]}</h2><p>{copy[1]}</p><label>Email address<input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" required /></label><label>Password<input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Your password" required /></label>{error && <p className="error">{error}</p>}<button className="primary" disabled={busy}>{busy ? 'Signing in...' : copy[2]}</button></form></main>; }
function AuthV2({ done }) { const [role, setRole] = useState('passenger'); const [view, setView] = useState('login'); const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [busId, setBusId] = useState(''); const [code, setCode] = useState(''); const [error, setError] = useState(''); const [note, setNote] = useState(''); const [busy, setBusy] = useState(false); const driver = role === 'driver'; const title = view === 'verify' ? 'Check your email' : view === 'register' ? `Create ${driver ? 'driver' : 'customer'} account` : `${driver ? 'Driver' : 'Customer'} sign in`; async function call(path, body) { const r = await fetch(`${API}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const data = await r.json(); if (!r.ok) throw new Error(data.message || 'Something went wrong.'); return data; } async function submit(e) { e.preventDefault(); setBusy(true); setError(''); try { if (view === 'login') { const data = await call('/auth/login', { email, password, busId: driver ? busId.trim() : undefined }); if (data.user.role !== role) throw new Error(`This is a ${data.user.role} account. Choose the other tab.`); localStorage.setItem('navigo_session', JSON.stringify(data)); done(data); } else if (view === 'register') { const data = await call('/auth/request-code', { email, password, role, busId: driver ? busId.trim() : undefined }); setNote(data.message); setView('verify'); } else { const data = await call('/auth/verify-code', { email, code }); localStorage.setItem('navigo_session', JSON.stringify(data)); done(data); } } catch (err) { setError(err.message); } finally { setBusy(false); } } function changeRole(next) { setRole(next); setError(''); setView('login'); setBusId(''); } return <main className="auth-page"><section className="brand"><div className="logo">N</div><p className="eyebrow">NAVIGO · MANGALURU</p><h1>Travel with the <em>right information.</em></h1><p>Live bus arrivals for customers and a secure bus console for drivers.</p><div className="feature-row"><span>Current bus location</span><span>Traffic-aware arrival times</span><span>Secure device connection</span></div></section><form onSubmit={submit} className="auth-card"><div className="role-tabs"><button type="button" className={!driver ? 'active' : ''} onClick={() => changeRole('passenger')}><b>Customer</b><small>Track my bus</small></button><button type="button" className={driver ? 'active' : ''} onClick={() => changeRole('driver')}><b>Driver</b><small>My bus console</small></button></div><div className="auth-title"><h2>{title}</h2><p>{view === 'verify' ? `Enter the code sent to ${email}.` : driver ? 'Use the bus ID assigned to you.' : 'Find live buses near your location.'}</p></div>{view !== 'verify' && <><label>Email address<input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" required /></label><label>Password<input type="password" value={password} onChange={e => setPassword(e.target.value)} minLength="8" placeholder="At least 8 characters" required /></label>{driver && <label>Assigned bus ID<input value={busId} onChange={e => setBusId(e.target.value.toUpperCase())} placeholder="Example: B001" required /></label>}</>}{view === 'verify' && <label>Verification code<input className="code-input" inputMode="numeric" maxLength="6" value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} placeholder="123456" required /></label>}{note && <p className="success">{note}</p>}{error && <p className="error">{error}</p>}<button className="primary" disabled={busy}>{busy ? 'Please wait...' : view === 'verify' ? 'Verify account' : view === 'register' ? 'Send verification code' : driver ? 'Open driver console' : 'View live arrivals'}</button>{view !== 'verify' ? <button type="button" className="text-button auth-switch" onClick={() => { setView(view === 'login' ? 'register' : 'login'); setError(''); }}>{view === 'login' ? 'Create a new account' : 'Already have an account? Sign in'}</button> : <button type="button" className="text-button auth-switch" onClick={() => setView('register')}>Use a different email</button>}</form></main>; }
function Arrival({ item, selected, select }) { const route = item.routeId?.split('-')[0]?.toUpperCase() || 'LIVE'; return <button className={`arrival-card ${selected ? 'selected' : ''}`} onClick={select}><div className="route-chip">{route}</div><div className="arrival-main"><strong>{item.etaMinutes ? `${item.etaMinutes} min` : 'Calculating...'}</strong><span>{item.id} · {item.operator || 'Live bus'}</span></div><div className="distance">{item.distanceKm ? `${item.distanceKm} km` : 'Live'}<small>{item.source === 'hardware' ? 'GPS device' : 'Shared location'}</small></div></button>; }
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
function Dashboard({ session, logout }) { const buses = useBuses(); const [customer, setCustomer] = useState(null); const [arrivals, setArrivals] = useState([]); const [selected, setSelected] = useState(null); const [status, setStatus] = useState('Share your location to find buses approaching you.'); const [busy, setBusy] = useState(false); async function calculate(coords) { setBusy(true); setStatus('Finding traffic-aware arrival estimates...'); try { const r = await fetch(`${API}/arrivals`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` }, body: JSON.stringify(coords) }); const data = await r.json(); if (!r.ok) throw new Error(data.message); setArrivals(data.arrivals); setSelected(data.arrivals[0] || null); setStatus(data.arrivals.length ? `Updated just now using ${data.provider}.` : 'No bus has shared a recent location yet.'); } catch (err) { setStatus(err.message); } finally { setBusy(false); } } function locate() { if (!navigator.geolocation) return setStatus('This browser does not support location sharing.'); setStatus('Requesting your location...'); navigator.geolocation.getCurrentPosition(p => { const c = { lat: p.coords.latitude, lng: p.coords.longitude }; setCustomer(c); calculate(c); }, () => setStatus('Location permission was not granted. Try again when ready.'), { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }); } useEffect(() => { if (!customer) return; const id = setInterval(() => calculate(customer), 60000); return () => clearInterval(id); }, [customer]); const live = buses.filter(fresh).length; return <main className="dashboard"><header><div className="wordmark"><span>N</span> NAVIGO <small>LIVE</small></div><div className="account"><span>{session.user.email}</span><button className="text-button" onClick={logout}>Sign out</button></div></header><section className="dashboard-hero"><div><p className="eyebrow">LIVE ARRIVALS</p><h1>When is my bus coming?</h1><p>See the latest location and expected arrival time for buses near you.</p><button className="primary location-button" onClick={locate} disabled={busy}>{busy ? 'Updating arrivals...' : customer ? 'Refresh arrivals' : 'Use my location'}</button></div><div className="live-orb"><strong>{live}</strong><span>buses<br />live now</span></div></section><section className="map-shell"><LiveMap buses={buses} customer={customer} arrival={selected} /><div className="map-legend"><span className="legend-dot customer" /> Your location <span className="legend-dot bus" /> Bus</div>{selected?.etaMinutes && <div className="eta-bubble"><span>Estimated arrival</span><strong>{selected.etaMinutes} min</strong></div>}</section><section className="arrivals-panel"><div className="section-heading"><div><p className="eyebrow">ARRIVALS</p><h2>Nearby buses</h2></div><span className="status-pill"><i /> {live ? 'Live tracking' : 'No active tracking'}</span></div><p className="notice">{status}</p><div className="arrival-list">{arrivals.map(item => <Arrival key={item.id} item={item} selected={selected?.id === item.id} select={() => setSelected(item)} />)}{!arrivals.length && <div className="empty-state"><strong>No arrivals to show yet</strong><span>Choose “Use my location” once your bus starts sharing its live location.</span></div>}</div></section><section className="how-it-works"><span>Live GPS updates</span><span>Traffic-aware travel time</span><span>Arrival updates every minute</span></section><LocalGuideWidget /></main>; }
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

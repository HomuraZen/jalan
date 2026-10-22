'use strict';
/* Jalan — personal offline navigator (PWA)
   Online: search (Nominatim) + road routing (OSRM).
   Offline: saved routes with cached map tiles, GPS turn-by-turn + voice,
            off-route guidance, straight-line direction mode, personal hazard reports. */

const VERSION = '1.0.0';
const DEFAULT_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSRM = 'https://router.project-osrm.org/route/v1/driving/';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const TILE_CACHE = 'jalan-tiles';
const MAX_TILES = 6000;

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- storage: IndexedDB key/value ---------------- */
const DB = (() => {
  let dbp;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('jalan', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  return {
    async get(k, def) {
      try {
        const db = await open();
        return await new Promise(res => {
          const q = db.transaction('kv').objectStore('kv').get(k);
          q.onsuccess = () => res(q.result === undefined ? def : q.result);
          q.onerror = () => res(def);
        });
      } catch { return def; }
    },
    async set(k, v) {
      const db = await open();
      return new Promise((res, rej) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(v, k);
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
    }
  };
})();

/* ---------------- state ---------------- */
const S = {
  settings: { voice: true, lang: 'en', theme: 'auto', maxZoomCache: 16, speedWarn: 0, tileUrl: DEFAULT_TILES },
  places: [], routes: [], reports: [],
  pos: null, dest: null, preview: null, nav: null,
  follow: true, muted: false, alerted: {}, dlCancel: false, wl: null,
};

/* ---------------- geo helpers ---------------- */
const RE = 6371000, toRad = d => d * Math.PI / 180, toDeg = r => r * 180 / Math.PI;
function hav(a, b) {
  const dLat = toRad(b[0] - a[0]), dLng = toRad(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * RE * Math.asin(Math.min(1, Math.sqrt(s)));
}
function bearing(a, b) {
  const y = Math.sin(toRad(b[1] - a[1])) * Math.cos(toRad(b[0]));
  const x = Math.cos(toRad(a[0])) * Math.sin(toRad(b[0])) - Math.sin(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.cos(toRad(b[1] - a[1]));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}
function projSeg(p, a, b) { // distance from p to segment ab, metres (local flat approx)
  const kx = Math.cos(toRad(p[0])) * 111320, ky = 110540;
  const ax = (a[1] - p[1]) * kx, ay = (a[0] - p[0]) * ky, bx = (b[1] - p[1]) * kx, by = (b[0] - p[0]) * ky;
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  let t = L ? -(ax * dx + ay * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return { t, d: Math.hypot(ax + t * dx, ay + t * dy) };
}
function locate(g, p, lo, hi) {
  let best = { i: lo, t: 0, d: Infinity };
  for (let i = lo; i < hi; i++) {
    const r = projSeg(p, g[i], g[i + 1]);
    if (r.d < best.d) best = { i, t: r.t, d: r.d };
  }
  return best;
}
const angDiff = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

/* ---------------- formatting & language ---------------- */
const ms = () => S.settings.lang === 'ms';
function fmtDist(m, voice) {
  if (m >= 1000) {
    const km = m >= 10000 ? Math.round(m / 1000) : Math.round(m / 100) / 10;
    return voice ? (ms() ? `${km} kilometer` : `${km} kilometres`) : `${km} km`;
  }
  const r = m > 300 ? Math.round(m / 100) * 100 : m > 100 ? Math.round(m / 50) * 50 : Math.max(10, Math.round(m / 10) * 10);
  return voice ? (ms() ? `${r} meter` : `${r} metres`) : `${r} m`;
}
function fmtDur(sec) {
  const m = Math.max(1, Math.round(sec / 60));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
const fmtClock = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}
const ord = n => ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'][n] || `${n}th`;
const lc = s => s.charAt(0).toLowerCase() + s.slice(1);

function modText(mod) {
  const en = { right: 'right', left: 'left', 'slight right': 'slightly right', 'slight left': 'slightly left', 'sharp right': 'sharp right', 'sharp left': 'sharp left', straight: 'straight', uturn: 'around' };
  const my = { right: 'kanan', left: 'kiri', 'slight right': 'sedikit ke kanan', 'slight left': 'sedikit ke kiri', 'sharp right': 'tajam ke kanan', 'sharp left': 'tajam ke kiri', straight: 'lurus', uturn: 'balik' };
  return (ms() ? my : en)[mod] || '';
}
function instr(s) {
  const M = ms(), m = modText(s.mod);
  const onto = s.name ? (M ? ` ke ${s.name}` : ` onto ${s.name}`) : '';
  const on = s.name ? (M ? ` di ${s.name}` : ` on ${s.name}`) : '';
  let t;
  switch (s.type) {
    case 'depart': t = M ? `Mulakan perjalanan${on}` : `Head out${on}`; break;
    case 'arrive': t = M ? 'Tiba di destinasi' : 'Arrive at your destination'; break;
    case 'roundabout': case 'rotary': case 'roundabout turn':
      t = s.exit ? (M ? `Di bulatan, ambil susur keluar ke-${s.exit}${onto}` : `At the roundabout, take the ${ord(s.exit)} exit${onto}`)
                 : (M ? `Masuk bulatan${onto}` : `Enter the roundabout${onto}`); break;
    case 'exit roundabout': case 'exit rotary': t = M ? `Keluar bulatan${onto}` : `Exit the roundabout${onto}`; break;
    case 'on ramp': t = M ? `Ambil susur masuk ${m}${onto}` : `Take the ramp ${m}${onto}`; break;
    case 'off ramp': t = M ? `Ambil susur keluar ${m}${onto}` : `Take the exit ${m}${onto}`; break;
    case 'fork': t = M ? `Kekal ${m} di simpang${onto}` : `Keep ${m} at the fork${onto}`; break;
    case 'merge': t = M ? `Masuk ${m}${onto}` : `Merge ${m}${onto}`; break;
    case 'continue': case 'new name': case 'notification': case 'use lane':
      if (s.mod === 'uturn') t = M ? 'Buat pusingan U' : 'Make a U-turn';
      else if (s.mod && s.mod !== 'straight') t = M ? `Ikut ${m}${onto}` : `Bear ${m}${onto}`;
      else t = M ? `Terus${on}` : `Continue${on}`;
      break;
    default: // turn, end of road
      if (s.mod === 'uturn') t = M ? 'Buat pusingan U' : 'Make a U-turn';
      else if (s.mod === 'straight') t = M ? `Terus lurus${on}` : `Go straight${on}`;
      else t = M ? `Belok ${m}${onto}` : `Turn ${m}${onto}`;
  }
  return t.replace(/\s+/g, ' ').trim();
}
const L10N = {
  en: { start: n => `Starting route to ${n}`, inX: d => `In ${d}, `, contFor: d => `Continue for ${d}`, off: 'Off route', offH: 'Return to the route', rerouting: 'Rerouting…', newRoute: 'Route updated', arrived: 'You have arrived at your destination', ahead: (t, d) => `${t} reported ahead, ${d}`, direct: n => `Straight-line direction to ${n}. No road route available offline.`, speed: 'Watch your speed' },
  ms: { start: n => `Memulakan perjalanan ke ${n}`, inX: d => `Dalam ${d}, `, contFor: d => `Teruskan sejauh ${d}`, off: 'Terkeluar laluan', offH: 'Kembali ke laluan', rerouting: 'Mengira semula…', newRoute: 'Laluan dikemas kini', arrived: 'Anda telah tiba di destinasi', ahead: (t, d) => `${t} dilaporkan di hadapan, ${d}`, direct: n => `Arah garis lurus ke ${n}. Tiada laluan jalan raya semasa luar talian.`, speed: 'Perhatikan kelajuan anda' },
};
const tx = () => L10N[S.settings.lang] || L10N.en;

/* ---------------- maneuver arrows ---------------- */
const MOD_ANG = { straight: 0, 'slight right': 45, right: 90, 'sharp right': 135, uturn: 180, 'sharp left': -135, left: -90, 'slight left': -45 };
const ARROW = ang => `<svg viewBox="0 0 48 48"><g transform="rotate(${ang} 24 24)"><path d="M24 4 L38 20 H29 V44 H19 V20 H10 Z" fill="currentColor"/></g></svg>`;
function stepIcon(s) {
  if (s.type === 'arrive') return '<svg viewBox="0 0 48 48"><path d="M12 44V6h24l-5 8 5 8H16v22z" fill="currentColor"/></svg>';
  if (/roundabout|rotary/.test(s.type) && s.type !== 'exit roundabout') return '<svg viewBox="0 0 48 48"><circle cx="24" cy="28" r="9" fill="none" stroke="currentColor" stroke-width="5"/><path d="M24 19V4M17 10l7-7 7 7" fill="none" stroke="currentColor" stroke-width="5"/></svg>';
  if (s.mod === 'uturn') return '<svg viewBox="0 0 48 48"><path d="M32 44V18a8 8 0 0 0-16 0v14" fill="none" stroke="currentColor" stroke-width="6"/><path d="M8 28l8 10 8-10z" fill="currentColor"/></svg>';
  return ARROW(MOD_ANG[s.mod] ?? 0);
}

/* ---------------- map ---------------- */
const map = L.map('map', { zoomControl: false, attributionControl: true, worldCopyJump: true }).setView([3.139, 101.6869], 12);
let tiles = L.tileLayer(S.settings.tileUrl, {
  maxZoom: 19, crossOrigin: true, attribution: '© OpenStreetMap contributors',
  errorTileUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
}).addTo(map);

const meIcon = L.divIcon({ className: 'me', iconSize: [36, 36], iconAnchor: [18, 18],
  html: '<svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="16" fill="#1fd1a5" fill-opacity=".22"/><path d="M18 5 L27 28 L18 23 L9 28 Z" fill="#1fd1a5" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>' });
let meMarker = null, accCircle = null, routeLayer = null, destMarker = null, directLine = null;
const reportLayer = L.layerGroup().addTo(map);

function drawRoute(r, fit) {
  if (routeLayer) map.removeLayer(routeLayer);
  routeLayer = L.layerGroup([
    L.polyline(r.geometry, { color: '#063f33', weight: 11, opacity: .85, interactive: false }),
    L.polyline(r.geometry, { color: '#1fd1a5', weight: 6, interactive: false }),
  ]).addTo(map);
  if (fit) fitRoute(r.geometry);
}
function fitRoute(pts) {
  const h = $('#sheet').offsetHeight;
  map.fitBounds(L.latLngBounds(pts), { paddingTopLeft: [30, 90], paddingBottomRight: [30, h + 30] });
}
function clearRoute() {
  [routeLayer, destMarker, directLine].forEach(l => l && map.removeLayer(l));
  routeLayer = destMarker = directLine = null;
}
function setDestMarker(d) {
  if (destMarker) map.removeLayer(destMarker);
  destMarker = L.marker([d.lat, d.lng], { icon: L.divIcon({ className: '', html: '<div class="dmark"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }) }).addTo(map);
}

/* ---------------- UI helpers ---------------- */
let toastT;
function toast(msg, ms = 3200) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms);
}
let alertT;
function bigAlert(msg) {
  const t = $('#alertToast'); t.textContent = msg; t.hidden = false;
  clearTimeout(alertT); alertT = setTimeout(() => (t.hidden = true), 6000);
}
function layout() { document.documentElement.style.setProperty('--sheet-h', $('#sheet').offsetHeight + 'px'); }
function showSheet(name) {
  $('#sheetIdle').hidden = name !== 'idle';
  $('#sheetPreview').hidden = name !== 'preview';
  $('#sheetNav').hidden = name !== 'nav';
  $('#top').hidden = name === 'nav';
  $('#banner').hidden = name !== 'nav';
  $('#results').hidden = true;
  requestAnimationFrame(layout);
}
function setNet() {
  const on = navigator.onLine, p = $('#net');
  p.textContent = on ? 'Online' : 'Offline';
  p.className = 'pill ' + (on ? 'on' : 'off');
}
function applyTheme() {
  const h = new Date().getHours(), t = S.settings.theme;
  document.body.classList.toggle('night', t === 'night' || (t === 'auto' && (h >= 19 || h < 7)));
}

/* ---------------- voice ---------------- */
let voices = [];
function loadVoices() { voices = 'speechSynthesis' in window ? speechSynthesis.getVoices() : []; }
function say(text) {
  if (!S.settings.voice || S.muted || !('speechSynthesis' in window) || !text) return;
  const lang = ms() ? 'ms' : 'en';
  const pool = voices.filter(v => v.lang.toLowerCase().startsWith(lang));
  const v = pool.find(v => v.localService) || pool[0];
  const u = new SpeechSynthesisUtterance(text);
  u.lang = v ? v.lang : (ms() ? 'ms-MY' : 'en-GB');
  if (v) u.voice = v;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

/* ---------------- persistence ---------------- */
function stripRoute(r) {
  return { id: r.id, name: r.name, created: r.created, from: r.from, to: r.to, geometry: r.geometry,
    steps: r.steps.map(({ _at, ...s }) => s), distance: r.distance, duration: r.duration, tiles: r.tiles, tilesOk: r.tilesOk };
}
function prepRoute(r) {
  const g = r.geometry, cum = new Array(g.length).fill(0);
  for (let i = 1; i < g.length; i++) cum[i] = cum[i - 1] + hav(g[i - 1], g[i]);
  r._cum = cum; r._len = cum[g.length - 1] || 0;
  let gi = 0;
  for (const s of r.steps) {
    let best = gi, bd = Infinity;
    for (let i = gi; i < g.length; i++) {
      const d = hav(g[i], s.loc);
      if (d < bd) { bd = d; best = i; }
      if (bd < 5) break;
    }
    s._at = cum[best]; gi = best;
  }
  return r;
}
async function persist(key) {
  try { await DB.set(key, key === 'routes' ? S.routes.map(stripRoute) : S[key]); }
  catch (e) { toast('Could not save on this device: ' + e.message); }
}

/* ---------------- network ---------------- */
function fetchT(url, ms, opts = {}) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  return fetch(url, { ...opts, signal: c.signal }).finally(() => clearTimeout(t));
}
async function fetchRoute(from, to) {
  const url = `${OSRM}${from[1].toFixed(6)},${from[0].toFixed(6)};${to[1].toFixed(6)},${to[0].toFixed(6)}?overview=full&geometries=geojson&steps=true`;
  const res = await fetchT(url, 15000);
  if (!res.ok) throw new Error('Routing server error ' + res.status);
  const j = await res.json();
  if (j.code !== 'Ok' || !j.routes || !j.routes.length) throw new Error('No road route found');
  const rt = j.routes[0], steps = [];
  for (const leg of rt.legs) for (const s of leg.steps) steps.push({
    type: s.maneuver.type, mod: s.maneuver.modifier || '', exit: s.maneuver.exit || 0,
    name: s.name || s.ref || '', loc: [s.maneuver.location[1], s.maneuver.location[0]], dist: s.distance, dur: s.duration,
  });
  return prepRoute({ geometry: rt.geometry.coordinates.map(c => [c[1], c[0]]), steps, distance: rt.distance, duration: rt.duration, from, to });
}

/* ---------------- GPS ---------------- */
function startGPS() {
  if (!navigator.geolocation) return toast('This device has no GPS access');
  navigator.geolocation.watchPosition(onPos, e => {
    if (e.code === 1) toast('Allow location access so Jalan can navigate', 6000);
    else if (!S.pos) toast('Waiting for GPS signal…');
  }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
}
let lastPosSave = 0, firstFix = true;
function onPos(p) {
  const c = p.coords, ll = [c.latitude, c.longitude];
  let speed = c.speed, heading = c.heading;
  if (S.pos) {
    const dt = (p.timestamp - S.pos.t) / 1000, d = hav(S.pos.ll, ll);
    if ((speed == null || isNaN(speed)) && dt > 0) speed = d / dt;
    if ((heading == null || isNaN(heading)) && d > 4) heading = bearing(S.pos.ll, ll);
    if (heading == null || isNaN(heading)) heading = S.pos.heading;
  }
  S.pos = { ll, acc: c.accuracy || 30, speed: Math.max(0, speed || 0), heading: heading || 0, t: p.timestamp };
  updateMe();
  if (firstFix && !S.dest) { map.setView(ll, 16); firstFix = false; }
  if (S.nav) navTick(); else if (S.follow && !S.dest) map.panTo(ll, { animate: true });
  if (S.nav || S.pos.speed > 4) reportsTick();
  if (Date.now() - lastPosSave > 30000) { lastPosSave = Date.now(); DB.set('lastPos', ll); }
}
function updateMe() {
  const { ll, acc, heading } = S.pos;
  if (!meMarker) {
    accCircle = L.circle(ll, { radius: acc, color: '#1fd1a5', weight: 1, fillOpacity: .08, interactive: false }).addTo(map);
    meMarker = L.marker(ll, { icon: meIcon, interactive: false, zIndexOffset: 1000 }).addTo(map);
  } else { meMarker.setLatLng(ll); accCircle.setLatLng(ll).setRadius(acc); }
  const svg = meMarker.getElement() && meMarker.getElement().querySelector('svg');
  if (svg) svg.style.transform = `rotate(${heading}deg)`;
}
function waitForPos(ms) {
  return new Promise(res => {
    if (S.pos) return res(S.pos);
    const t0 = Date.now(), iv = setInterval(() => {
      if (S.pos || Date.now() - t0 > ms) { clearInterval(iv); res(S.pos); }
    }, 300);
  });
}
function followCam() {
  if (!S.follow || !S.pos) return;
  if (S.nav) {
    const v = S.pos.speed * 3.6, z = v > 80 ? 15 : v > 40 ? 16 : 17;
    map.setView(S.pos.ll, z, { animate: true });
  } else map.setView(S.pos.ll, Math.max(map.getZoom(), 16), { animate: true });
}

/* ---------------- search ---------------- */
async function search(q) {
  q = q.trim(); if (!q) return;
  const ul = $('#results');
  ul.hidden = false; ul.innerHTML = '<li class="empty">Searching…</li>';
  const coord = q.match(/(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/);
  const items = [];
  if (coord) items.push({ name: `Pin ${(+coord[1]).toFixed(5)}, ${(+coord[2]).toFixed(5)}`, lat: +coord[1], lng: +coord[2], tag: 'coords' });
  const ql = q.toLowerCase();
  S.places.filter(p => p.name.toLowerCase().includes(ql)).forEach(p => items.push({ ...p, tag: 'saved' }));
  S.routes.filter(r => r.name.toLowerCase().includes(ql)).forEach(r => items.push({ name: r.name, lat: r.to[0], lng: r.to[1], tag: 'offline route', routeId: r.id }));
  let netErr = false;
  if (!coord) {
    try {
      const u = new URL(NOMINATIM);
      const params = { q, format: 'jsonv2', countrycodes: 'my', limit: '8', 'accept-language': 'en,ms' };
      if (S.pos) { const [la, ln] = S.pos.ll; params.viewbox = `${ln - 0.6},${la + 0.6},${ln + 0.6},${la - 0.6}`; }
      u.search = new URLSearchParams(params);
      const r = await fetchT(u, 10000);
      if (!r.ok) throw new Error(r.status);
      (await r.json()).forEach(x => items.push({ name: x.name || x.display_name.split(',')[0], addr: x.display_name, lat: +x.lat, lng: +x.lon }));
    } catch { netErr = true; }
  }
  if (!items.length) {
    ul.innerHTML = `<li class="empty">${netErr ? 'No signal — only saved places and offline routes are searchable. You can also paste coordinates (e.g. 3.1365, 101.6215).' : 'Nothing found.'}</li>`;
    return;
  }
  ul.innerHTML = items.map((it, i) => `<li><button data-i="${i}"><span><b>${esc(it.name)}</b>${it.tag ? `<span class="tag">${esc(it.tag)}</span>` : ''}</span><small>${S.pos ? fmtDist(hav(S.pos.ll, [it.lat, it.lng])) + ' · ' : ''}${esc(it.addr || '')}</small></button></li>`).join('')
    + (netErr ? '<li class="empty">Offline — showing saved results only.</li>' : '');
  ul.onclick = e => {
    const b = e.target.closest('button[data-i]'); if (!b) return;
    const it = items[+b.dataset.i];
    ul.hidden = true; $('#q').blur();
    if (it.routeId) previewSaved(S.routes.find(r => r.id === it.routeId));
    else setDest({ name: it.name, addr: it.addr, lat: it.lat, lng: it.lng });
  };
}

/* ---------------- destination & preview ---------------- */
async function setDest(d) {
  if (S.nav) return;
  S.dest = d; S.preview = null; S.follow = false;
  clearRoute(); setDestMarker(d);
  showSheet('preview');
  $('#pvName').textContent = d.name;
  $('#pvMeta').textContent = 'Calculating route…';
  $('#btnGo').disabled = $('#btnSaveRoute').disabled = true;
  $('#btnSaveRoute').textContent = '⬇ Offline';
  $('#btnGo').textContent = 'Start';
  map.setView([d.lat, d.lng], Math.max(map.getZoom(), 14));
  const pos = await waitForPos(12000);
  if (S.dest !== d) return; // user moved on
  if (!pos) { $('#pvMeta').textContent = 'No GPS fix yet. Turn on location and try again.'; return; }
  try {
    const r = await fetchRoute(pos.ll, [d.lat, d.lng]);
    if (S.dest !== d) return;
    r.name = d.name; S.preview = r;
    drawRoute(r, true);
    $('#pvMeta').textContent = `${fmtDur(r.duration)} · ${fmtDist(r.distance)} · ETA ${fmtClock(Date.now() + r.duration * 1000)}`;
    $('#btnGo').disabled = $('#btnSaveRoute').disabled = false;
    return;
  } catch (e) { console.warn('route failed', e); }
  if (S.dest !== d) return;
  const saved = S.routes.find(r => hav(r.to, [d.lat, d.lng]) < 200);
  if (saved) return previewSaved(saved);
  $('#pvMeta').textContent = 'No signal — can\'t calculate a road route. You can still go by straight-line direction.';
  $('#btnGo').textContent = 'Direction mode';
  $('#btnGo').disabled = false;
  directLine = L.polyline([pos.ll, [d.lat, d.lng]], { color: '#ff5a5f', weight: 4, dashArray: '8 10', interactive: false }).addTo(map);
  fitRoute([pos.ll, [d.lat, d.lng]]);
}
function previewSaved(r) {
  S.dest = { name: r.name, lat: r.to[0], lng: r.to[1] };
  S.preview = r; S.follow = false;
  clearRoute(); setDestMarker(S.dest); drawRoute(r, true);
  showSheet('preview');
  $('#pvName').textContent = r.name;
  const near = S.pos ? hav(S.pos.ll, r.from) : null;
  $('#pvMeta').textContent = `Offline route · ${fmtDur(r.duration)} · ${fmtDist(r.distance)}` + (near != null && near > 300 ? ` · starts ${fmtDist(near)} from you` : '');
  $('#btnGo').textContent = 'Start'; $('#btnGo').disabled = false;
  $('#btnSaveRoute').textContent = 'Saved ✓'; $('#btnSaveRoute').disabled = true;
}
function cancelPreview() {
  S.dlCancel = true; S.dest = null; S.preview = null;
  clearRoute(); showSheet('idle'); $('#dlProgress').hidden = true;
}

/* ---------------- offline tiles ---------------- */
const lon2x = (lng, z) => Math.floor((lng + 180) / 360 * 2 ** z);
const lat2y = (lat, z) => { const r = toRad(lat); return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z); };
function corridorTiles(geom, zmax) {
  const set = new Set();
  let a = 90, b = -90, c = 180, d = -180;
  geom.forEach(([la, ln]) => { a = Math.min(a, la); b = Math.max(b, la); c = Math.min(c, ln); d = Math.max(d, ln); });
  for (let z = 6; z <= 10; z++) {
    for (let x = lon2x(c, z) - 1; x <= lon2x(d, z) + 1; x++)
      for (let y = lat2y(b, z) - 1; y <= lat2y(a, z) + 1; y++) set.add(`${z}/${x}/${y}`);
  }
  for (let z = 11; z <= zmax; z++) {
    const tileM = 40075016 * Math.cos(toRad((a + b) / 2)) / 2 ** z, step = tileM / 3;
    const add = (la, ln) => {
      const x = lon2x(ln, z), y = lat2y(la, z);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) set.add(`${z}/${x + dx}/${y + dy}`);
    };
    for (let i = 0; i < geom.length - 1; i++) {
      const p = geom[i], q = geom[i + 1], n = Math.max(1, Math.ceil(hav(p, q) / step));
      for (let k = 0; k < n; k++) add(p[0] + (q[0] - p[0]) * k / n, p[1] + (q[1] - p[1]) * k / n);
    }
    add(...geom[geom.length - 1]);
  }
  return [...set].map(k => k.split('/').map(Number));
}
const tileUrl = (z, x, y) => S.settings.tileUrl.replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{s}', 'a').replace('{r}', '');
async function downloadTiles(list, onProg) {
  if (!('caches' in window)) throw new Error('This browser cannot store offline maps');
  const cache = await caches.open(TILE_CACHE);
  let i = 0, done = 0, ok = 0;
  S.dlCancel = false;
  async function worker() {
    while (i < list.length && !S.dlCancel) {
      const [z, x, y] = list[i++], u = tileUrl(z, x, y);
      try {
        if (await cache.match(u, { ignoreVary: true })) ok++;
        else {
          const r = await fetchT(u, 15000, { mode: 'cors' });
          if (r.ok) { await cache.put(u, r); ok++; }
        }
      } catch { /* skip tile */ }
      onProg(++done, list.length);
    }
  }
  await Promise.all([worker(), worker()]); // 2 connections: polite to the free tile server
  return ok;
}
async function saveRouteOffline() {
  const r = S.preview; if (!r) return;
  const name = prompt('Name this offline route', r.name || 'My route');
  if (name === null) return;
  r.name = name.trim() || r.name; r.id = r.id || 'r' + Date.now(); r.created = Date.now();
  let zmax = +S.settings.maxZoomCache, list = corridorTiles(r.geometry, zmax);
  while (list.length > MAX_TILES && zmax > 13) list = corridorTiles(r.geometry, --zmax);
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  const box = $('#dlProgress'), bar = box.querySelector('i'), lab = box.querySelector('span');
  box.hidden = false; layout();
  $('#btnSaveRoute').disabled = true; $('#btnSaveRoute').textContent = 'Saving…';
  let ok = 0;
  try {
    ok = await downloadTiles(list, (d, n) => { bar.style.width = (100 * d / n) + '%'; lab.textContent = `${d}/${n} map tiles`; });
  } catch (e) { toast(e.message); }
  r.tiles = list.length; r.tilesOk = ok;
  S.routes = S.routes.filter(x => x.id !== r.id).concat(r);
  await persist('routes');
  box.hidden = true; layout();
  $('#btnSaveRoute').textContent = 'Saved ✓';
  const pct = list.length ? Math.round(100 * ok / list.length) : 0;
  toast(S.dlCancel ? `Route saved, map download stopped at ${pct}%` : pct >= 95 ? `"${r.name}" ready offline` : `Route saved — only ${pct}% of the map downloaded. Retry on better signal.`, 4500);
}

/* ---------------- navigation ---------------- */
function startNav() {
  const d = S.dest; if (!d) return;
  const r = S.preview;
  S.nav = { route: r, direct: !r, dest: d, s: 0, idx: 0, k: 1, offCount: 0, offRoute: false, lastReroute: 0, rerouting: false, spoken: {}, lastK: -1, speedWarned: 0 };
  S.follow = true; $('#btnLocate').classList.remove('off');
  showSheet('nav'); wake(true);
  say(r ? tx().start(d.name) : tx().direct(d.name));
  if (S.pos) { navTick(); followCam(); } else toast('Waiting for GPS…');
}
function endNav(silent) {
  S.nav = null; wake(false);
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  $('#banner').classList.remove('off');
  cancelPreview();
  if (!silent) toast('Navigation ended');
  if (S.pos) { S.follow = true; followCam(); }
}
function navTick() {
  const n = S.nav, p = S.pos; if (!n || !p) return;
  const st = tx();
  updateStatsSpeed();
  if (n.direct) return directTick();
  const r = n.route, g = r.geometry;
  if (g.length < 2) return;
  let best = locate(g, p.ll, Math.max(0, n.idx - 15), Math.min(g.length - 1, n.idx + 400));
  if (best.d > 60) { const full = locate(g, p.ll, 0, g.length - 1); if (full.d < best.d - 10) best = full; }
  n.idx = best.i;
  const s = r._cum[best.i] + best.t * (r._cum[best.i + 1] - r._cum[best.i]);
  n.s = s;
  const thr = 45 + Math.min(p.acc || 0, 60);
  n.offCount = best.d > thr ? n.offCount + 1 : 0;
  if (n.offCount >= 3) handleOffRoute(best);
  else if (n.offRoute && best.d <= thr) { n.offRoute = false; $('#banner').classList.remove('off'); }

  const steps = r.steps, remain = Math.max(0, r._len - s);
  let k = 1;
  while (k < steps.length - 1 && steps[k]._at <= s + 5) k++;
  const step = steps[k] || steps[steps.length - 1];
  const dNext = Math.max(0, step._at - s);

  // stats
  const tLeft = r._len ? r.duration * (remain / r._len) : 0;
  $('#nvEta').textContent = fmtClock(Date.now() + tLeft * 1000);
  $('#nvTime').textContent = Math.max(0, Math.round(tLeft / 60));
  $('#nvDist').textContent = (remain / 1000).toFixed(remain < 10000 ? 1 : 0);

  if (remain < 30 || (step.type === 'arrive' && dNext < 30)) return arrive();

  if (n.offRoute) {
    const target = g[Math.min(best.i + 1, g.length - 1)];
    const rel = bearing(p.ll, target) - p.heading;
    $('#bArrow').innerHTML = ARROW(rel);
    $('#bDist').textContent = fmtDist(best.d);
    $('#bInstr').textContent = n.rerouting ? st.rerouting : `${st.off} — ${lc(st.offH)}`;
  } else {
    $('#bArrow').innerHTML = stepIcon(step);
    $('#bDist').textContent = fmtDist(dNext);
    $('#bInstr').textContent = instr(step);
    voiceFor(k, step, dNext, steps);
  }
  followCam();
}
function voiceFor(k, step, dNext, steps) {
  const n = S.nav, v = S.pos.speed, st = tx();
  const quiet = ['new name', 'continue', 'notification', 'use lane'].includes(step.type) && (!step.mod || step.mod === 'straight');
  if (k !== n.lastK) { // just passed a maneuver
    if (n.lastK !== -1 && dNext > 2500) say(st.contFor(fmtDist(dNext, true)));
    n.lastK = k;
  }
  if (quiet) return;
  const far = v > 22 ? 1500 : v > 14 ? 800 : 400, mid = v > 14 ? 400 : 200, near = Math.max(35, v * 4);
  const sp = n.spoken[k] || (n.spoken[k] = {});
  const text = instr(step);
  const next = steps[k + 1];
  const thenTxt = next && next.type !== 'arrive' && next._at - step._at < 80 ? (ms() ? `, kemudian ${lc(instr(next))}` : `, then ${lc(instr(next))}`) : '';
  if (!sp.far && dNext <= far && dNext > mid + 150) { sp.far = 1; say(st.inX(fmtDist(dNext, true)) + lc(text)); }
  else if (!sp.mid && dNext <= mid && dNext > near + 40) { sp.mid = sp.far = 1; say(st.inX(fmtDist(dNext, true)) + lc(text)); }
  else if (!sp.near && dNext <= near) { sp.near = sp.mid = sp.far = 1; say(text + thenTxt); }
}
async function handleOffRoute(best) {
  const n = S.nav, st = tx();
  if (!n.offRoute) { n.offRoute = true; $('#banner').classList.add('off'); }
  if (n.rerouting || Date.now() - n.lastReroute < 15000) return;
  n.lastReroute = Date.now(); n.rerouting = true;
  try {
    const r = await fetchRoute(S.pos.ll, [n.dest.lat, n.dest.lng]);
    if (S.nav !== n) return;
    r.name = n.route.name;
    Object.assign(n, { route: r, idx: 0, offCount: 0, offRoute: false, spoken: {}, lastK: -1, rpos: {} });
    $('#banner').classList.remove('off');
    drawRoute(r, false);
    say(st.newRoute); toast(st.newRoute);
  } catch {
    if (!n.offWarned || Date.now() - n.offWarned > 60000) { n.offWarned = Date.now(); say(`${st.off}. ${st.offH}`); }
  } finally { n.rerouting = false; }
}
function directTick() {
  const n = S.nav, p = S.pos, dest = [n.dest.lat, n.dest.lng];
  const d = hav(p.ll, dest), rel = bearing(p.ll, dest) - p.heading;
  $('#bArrow').innerHTML = ARROW(rel);
  $('#bDist').textContent = fmtDist(d);
  $('#bInstr').textContent = ms() ? `Garis lurus ke ${n.dest.name}` : `Straight line to ${n.dest.name}`;
  $('#nvDist').textContent = (d / 1000).toFixed(d < 10000 ? 1 : 0);
  $('#nvTime').textContent = '--'; $('#nvEta').textContent = '--:--';
  if (directLine) directLine.setLatLngs([p.ll, dest]);
  else directLine = L.polyline([p.ll, dest], { color: '#ff5a5f', weight: 4, dashArray: '8 10', interactive: false }).addTo(map);
  if (d < 40) return arrive();
  // try upgrading to a real road route when signal returns
  if (navigator.onLine && !n.rerouting && Date.now() - n.lastReroute > 30000) {
    n.lastReroute = Date.now(); n.rerouting = true;
    fetchRoute(p.ll, dest).then(r => {
      if (S.nav !== n) return;
      r.name = n.dest.name; n.route = r; n.direct = false; n.lastK = -1; n.rpos = {};
      if (directLine) { map.removeLayer(directLine); directLine = null; }
      drawRoute(r, false); say(tx().newRoute);
    }).catch(() => {}).finally(() => (n.rerouting = false));
  }
  followCam();
}
function updateStatsSpeed() {
  const kmh = Math.round(S.pos.speed * 3.6), el = $('#nvSpeed'), lim = +S.settings.speedWarn;
  el.textContent = kmh;
  const over = lim > 0 && kmh > lim;
  el.classList.toggle('over', over);
  if (over && Date.now() - S.nav.speedWarned > 60000) { S.nav.speedWarned = Date.now(); say(tx().speed); }
}
function arrive() {
  say(tx().arrived);
  bigAlert('🏁 ' + tx().arrived);
  endNav(true);
}
async function wake(on) {
  try {
    if (on && 'wakeLock' in navigator) S.wl = await navigator.wakeLock.request('screen');
    else if (!on && S.wl) { await S.wl.release(); S.wl = null; }
  } catch { /* not supported */ }
}

/* ---------------- reports (personal Waze-style alerts) ---------------- */
const RTYPES = {
  police:   { e: '🚓', en: 'Police', ms: 'Polis', ttl: 6 },
  camera:   { e: '📷', en: 'Speed camera', ms: 'Kamera laju', ttl: 0 },
  accident: { e: '💥', en: 'Accident', ms: 'Kemalangan', ttl: 4 },
  jam:      { e: '🚗', en: 'Traffic jam', ms: 'Kesesakan', ttl: 2 },
  hazard:   { e: '⚠️', en: 'Hazard', ms: 'Bahaya', ttl: 24 },
  flood:    { e: '🌊', en: 'Flood', ms: 'Banjir', ttl: 12 },
  roadwork: { e: '🚧', en: 'Road works', ms: 'Kerja jalan', ttl: 0 },
  pothole:  { e: '🕳️', en: 'Pothole', ms: 'Lubang jalan', ttl: 0 },
};
const rLabel = t => (RTYPES[t] || RTYPES.hazard)[ms() ? 'ms' : 'en'];
const activeReport = r => { const ttl = (RTYPES[r.type] || {}).ttl; return !ttl || Date.now() - r.t < ttl * 3600e3; };
function renderReports() {
  reportLayer.clearLayers();
  S.reports.filter(activeReport).forEach(r => {
    L.marker([r.lat, r.lng], { icon: L.divIcon({ className: '', html: `<div class="rmark">${RTYPES[r.type]?.e || '⚠️'}</div>`, iconSize: [34, 34], iconAnchor: [17, 17] }) })
      .bindPopup(`<b>${esc(rLabel(r.type))}</b><br>${ago(r.t)}`).addTo(reportLayer);
  });
}
async function addReport(type) {
  const ll = S.pos ? S.pos.ll : [map.getCenter().lat, map.getCenter().lng];
  const id = 'p' + Date.now();
  S.reports.push({ id, type, lat: ll[0], lng: ll[1], t: Date.now(), heading: S.pos ? S.pos.heading : null });
  S.alerted[id] = true; // don't alert about the thing you just reported
  await persist('reports'); renderReports();
  closePanel();
  toast(`${RTYPES[type].e} ${rLabel(type)} saved${S.pos ? '' : ' at map centre (no GPS)'}`);
}
function reportsTick() {
  const p = S.pos, n = S.nav, r = n && !n.direct && n.route;
  const look = Math.min(800, Math.max(400, p.speed * 30)); // ~30 s warning, 400–800 m
  for (const rep of S.reports) {
    if (!activeReport(rep)) continue;
    const rl = [rep.lat, rep.lng], d = hav(p.ll, rl);
    if (d > 1500) { delete S.alerted[rep.id]; continue; }
    if (S.alerted[rep.id] || d > look) continue;
    let ahead, dist = d;
    if (r) { // on a route: only warn for things on the road ahead of you
      n.rpos = n.rpos || {};
      if (!(rep.id in n.rpos)) {
        const b = locate(r.geometry, rl, 0, r.geometry.length - 1);
        n.rpos[rep.id] = b.d < 60 ? r._cum[b.i] + b.t * (r._cum[b.i + 1] - r._cum[b.i]) : null;
      }
      const at = n.rpos[rep.id];
      if (at != null) { dist = at - n.s; ahead = dist > 0 && dist <= look; }
      else ahead = d < 250 && angDiff(bearing(p.ll, rl), p.heading) < 35;
    } else ahead = p.speed >= 2 && angDiff(bearing(p.ll, rl), p.heading) < 35;
    if (!ahead) continue;
    S.alerted[rep.id] = true;
    bigAlert(`${RTYPES[rep.type]?.e || '⚠️'} ${rLabel(rep.type)} · ${fmtDist(dist)}`);
    say(tx().ahead(rLabel(rep.type), fmtDist(dist, true)));
  }
}

/* ---------------- panels ---------------- */
function openPanel(title, html) {
  $('#panelTitle').textContent = title;
  $('#panelBody').innerHTML = html;
  $('#panel').hidden = false;
}
function closePanel() { $('#panel').hidden = true; }

function panelPlaces() {
  const li = S.places.map((p, i) => `<li><button class="li-main" data-act="goplace" data-i="${i}"><b>${esc(p.name)}</b><small>${S.pos ? fmtDist(hav(S.pos.ll, [p.lat, p.lng])) + ' away' : ''} ${esc(p.addr || '')}</small></button><button class="li-x" data-act="delplace" data-i="${i}" aria-label="Delete">✕</button></li>`).join('');
  openPanel('Saved places', `<button class="wide" data-act="savehere">＋ Save my current location</button>
    <p class="muted small">Tip: search or long-press the map, then tap ★ to save any spot. Saved places are searchable offline.</p>
    <ul class="list">${li || '<li class="empty">No saved places yet.</li>'}</ul>`);
}
function panelRoutes() {
  const li = S.routes.slice().sort((a, b) => b.created - a.created).map(r => {
    const pct = r.tiles ? Math.round(100 * (r.tilesOk || 0) / r.tiles) : 0;
    return `<li><button class="li-main" data-act="goroute" data-id="${r.id}"><b>${esc(r.name)}</b><small>${fmtDist(r.distance)} · ${fmtDur(r.duration)} · map ${pct}% offline · saved ${ago(r.created)}</small></button><button class="li-x" data-act="recache" data-id="${r.id}" aria-label="Re-download map">⟳</button><button class="li-x" data-act="delroute" data-id="${r.id}" aria-label="Delete">✕</button></li>`;
  }).join('');
  openPanel('Offline routes', `<p class="muted small">Save a route while you have signal: Jalan stores the turn-by-turn directions and downloads the map along it. You can then drive it with no signal at all.</p>
    <ul class="list">${li || '<li class="empty">No offline routes yet. Search a destination, then tap “Save offline”.</li>'}</ul>`);
}
function panelReports() {
  const act = S.reports.filter(activeReport).sort((a, b) => b.t - a.t);
  const li = act.map(r => {
    const ttl = RTYPES[r.type]?.ttl;
    const exp = ttl ? ` · clears in ${Math.max(1, Math.round((r.t + ttl * 3600e3 - Date.now()) / 3600e3))} h` : ' · permanent';
    return `<li><button class="li-main" data-act="showreport" data-id="${r.id}"><b>${RTYPES[r.type]?.e || ''} ${esc(rLabel(r.type))}</b><small>${ago(r.t)}${exp}${S.pos ? ' · ' + fmtDist(hav(S.pos.ll, [r.lat, r.lng])) + ' away' : ''}</small></button><button class="li-x" data-act="delreport" data-id="${r.id}" aria-label="Delete">✕</button></li>`;
  }).join('');
  const expired = S.reports.length - act.length;
  openPanel('My reports', `<button class="wide" data-act="newreport">＋ Report something here</button>
    <p class="muted small">You get a voice alert when driving towards a report. Police, jams and accidents clear automatically; cameras, road works and potholes stay until you delete them. Share them with family via Settings → Export backup.</p>
    ${expired ? `<button class="wide" data-act="purge">Remove ${expired} expired</button>` : ''}
    <ul class="list">${li || '<li class="empty">No active reports.</li>'}</ul>`);
}
function panelReportPicker() {
  const k = ms() ? 'ms' : 'en';
  openPanel('Report', `<p class="muted small">Marks your current location.</p><div class="rgrid">${Object.entries(RTYPES).map(([t, v]) => `<button data-act="report" data-type="${t}"><span class="e">${v.e}</span>${v[k]}</button>`).join('')}</div>`);
}
function panelSettings() {
  const s = S.settings, sel = (v, o) => String(v) === String(o) ? 'selected' : '';
  openPanel('Settings', `
    <label class="set"><span>Voice guidance</span><input type="checkbox" data-set="voice" ${s.voice ? 'checked' : ''}></label>
    <label class="set"><span>Language</span><select data-set="lang"><option value="en" ${sel(s.lang, 'en')}>English</option><option value="ms" ${sel(s.lang, 'ms')}>Bahasa Melayu</option></select></label>
    <label class="set"><span>Map theme</span><select data-set="theme"><option value="auto" ${sel(s.theme, 'auto')}>Auto (night 7pm–7am)</option><option value="day" ${sel(s.theme, 'day')}>Day</option><option value="night" ${sel(s.theme, 'night')}>Night</option></select></label>
    <label class="set"><span>Speed warning</span><select data-set="speedWarn"><option value="0" ${sel(s.speedWarn, 0)}>Off</option><option value="90" ${sel(s.speedWarn, 90)}>Above 90 km/h</option><option value="110" ${sel(s.speedWarn, 110)}>Above 110 km/h</option><option value="120" ${sel(s.speedWarn, 120)}>Above 120 km/h</option></select></label>
    <label class="set"><span>Offline map detail</span><select data-set="maxZoomCache"><option value="15" ${sel(s.maxZoomCache, 15)}>Standard (smaller)</option><option value="16" ${sel(s.maxZoomCache, 16)}>Detailed</option></select></label>
    <div class="set"><span>Storage used</span><span id="stor" class="muted">…</span></div>
    <p></p>
    <button class="wide" data-act="testvoice">Test voice</button>
    <button class="wide" data-act="export">Export backup (places, routes, reports)</button>
    <label class="btnlike">Import backup<input type="file" accept="application/json,.json" data-file="import" hidden></label>
    <button class="wide" data-act="cleartiles">Clear downloaded maps</button>
    <details><summary>Advanced</summary>
      <label class="set col"><span>Map tile server URL</span><input type="url" data-set="tileUrl" value="${esc(s.tileUrl)}"></label>
      <p class="muted small">Default uses free OpenStreetMap tiles, which must be used lightly (no bulk area downloads). For heavy use, get a free key from a tile provider and paste its {z}/{x}/{y} URL here.</p>
    </details>
    <p class="muted small">Jalan v${VERSION} · Map data © OpenStreetMap contributors · Routing: OSRM · Search: Nominatim. Routing and search need signal; saved routes, places, reports and voice guidance work offline.</p>`);
  if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then(({ usage, quota }) => {
    const e = $('#stor'); if (e) e.textContent = `${(usage / 1048576).toFixed(1)} MB of ${(quota / 1073741824).toFixed(1)} GB`;
  });
}

const ACTIONS = {
  async savehere() {
    if (!S.pos) return toast('No GPS fix yet');
    const name = prompt('Name this place', 'Home'); if (!name) return;
    S.places.push({ id: 'pl' + Date.now(), name: name.trim(), lat: S.pos.ll[0], lng: S.pos.ll[1] });
    await persist('places'); panelPlaces(); toast('Place saved');
  },
  goplace(ds) { closePanel(); setDest(S.places[+ds.i]); },
  async delplace(ds) {
    const p = S.places[+ds.i]; if (!p || !confirm(`Delete "${p.name}"?`)) return;
    S.places.splice(+ds.i, 1); await persist('places'); panelPlaces();
  },
  goroute(ds) { closePanel(); previewSaved(S.routes.find(r => r.id === ds.id)); },
  async delroute(ds) {
    const r = S.routes.find(x => x.id === ds.id); if (!r || !confirm(`Delete offline route "${r.name}"?`)) return;
    S.routes = S.routes.filter(x => x.id !== ds.id); await persist('routes'); panelRoutes();
  },
  async recache(ds) {
    const r = S.routes.find(x => x.id === ds.id); if (!r) return;
    if (!navigator.onLine) return toast('Needs signal to download the map');
    let zmax = +S.settings.maxZoomCache, list = corridorTiles(r.geometry, zmax);
    while (list.length > MAX_TILES && zmax > 13) list = corridorTiles(r.geometry, --zmax);
    toast('Downloading map…', 60000);
    const ok = await downloadTiles(list, (d, n) => { if (d % 50 === 0 || d === n) toast(`Downloading map… ${d}/${n}`, 60000); });
    r.tiles = list.length; r.tilesOk = ok; await persist('routes');
    toast(`Map ${Math.round(100 * ok / list.length)}% offline`); panelRoutes();
  },
  newreport() { panelReportPicker(); },
  report(ds) { addReport(ds.type); },
  showreport(ds) { const r = S.reports.find(x => x.id === ds.id); if (r) { closePanel(); S.follow = false; map.setView([r.lat, r.lng], 17); } },
  async delreport(ds) { S.reports = S.reports.filter(x => x.id !== ds.id); await persist('reports'); renderReports(); panelReports(); },
  async purge() { S.reports = S.reports.filter(activeReport); await persist('reports'); renderReports(); panelReports(); },
  testvoice() {
    const st = tx();
    say(st.inX(fmtDist(400, true)) + lc(instr({ type: 'turn', mod: 'right', name: 'Jalan SS 21/37' })));
  },
  async export() {
    const data = JSON.stringify({ app: 'jalan', v: 1, exported: new Date().toISOString(), places: S.places, routes: S.routes.map(stripRoute), reports: S.reports, settings: S.settings });
    const file = new File([data], `jalan-backup-${new Date().toISOString().slice(0, 10)}.json`, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Jalan backup' }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  },
  async cleartiles() {
    if (!confirm('Delete all downloaded maps? Saved routes keep their directions but will show a blank map offline until re-downloaded.')) return;
    await caches.delete(TILE_CACHE);
    S.routes.forEach(r => (r.tilesOk = 0)); await persist('routes');
    toast('Downloaded maps cleared'); panelSettings();
  },
};
async function importBackup(file) {
  try {
    const j = JSON.parse(await file.text());
    if (j.app !== 'jalan') throw new Error('Not a Jalan backup file');
    const merge = (cur, inc, key) => { const ids = new Set(cur.map(x => x[key])); return cur.concat((inc || []).filter(x => x && !ids.has(x[key]))); };
    const before = [S.places.length, S.routes.length, S.reports.length];
    S.places = merge(S.places, j.places, 'id');
    S.routes = merge(S.routes, (j.routes || []).map(r => prepRoute({ ...r, tilesOk: 0 })), 'id');
    S.reports = merge(S.reports, j.reports, 'id');
    await Promise.all(['places', 'routes', 'reports'].map(persist));
    renderReports();
    toast(`Imported ${S.places.length - before[0]} places, ${S.routes.length - before[1]} routes, ${S.reports.length - before[2]} reports. Re-download maps for imported routes (⟳).`, 6000);
    panelSettings();
  } catch (e) { toast('Import failed: ' + e.message); }
}

/* ---------------- wiring ---------------- */
function wire() {
  $('#searchForm').addEventListener('submit', e => { e.preventDefault(); search($('#q').value); });
  $('#q').addEventListener('input', () => { if (!$('#q').value) $('#results').hidden = true; });
  map.on('click', () => { $('#results').hidden = true; });
  map.on('dragstart', () => { if (S.pos) { S.follow = false; $('#btnLocate').classList.add('off'); } });
  map.on('contextmenu', e => { if (!S.nav) setDest({ name: 'Dropped pin', lat: e.latlng.lat, lng: e.latlng.lng }); });

  $('#btnLocate').onclick = () => {
    if (!S.pos) return toast('Waiting for GPS…');
    S.follow = true; $('#btnLocate').classList.remove('off'); followCam();
  };
  $('#btnReport').onclick = panelReportPicker;
  document.querySelectorAll('[data-open]').forEach(b => b.onclick = () => ({ places: panelPlaces, routes: panelRoutes, reports: panelReports, settings: panelSettings })[b.dataset.open]());
  $('#panelClose').onclick = closePanel;
  $('#panelBody').addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if (b && ACTIONS[b.dataset.act]) ACTIONS[b.dataset.act](b.dataset, b);
  });
  $('#panelBody').addEventListener('change', async e => {
    const el = e.target;
    if (el.dataset.file === 'import' && el.files[0]) return importBackup(el.files[0]);
    const k = el.dataset.set; if (!k) return;
    S.settings[k] = el.type === 'checkbox' ? el.checked : (['maxZoomCache', 'speedWarn'].includes(k) ? +el.value : el.value);
    if (k === 'theme') applyTheme();
    if (k === 'tileUrl') { S.settings.tileUrl = el.value.trim() || DEFAULT_TILES; tiles.setUrl(S.settings.tileUrl); }
    if (k === 'lang') renderReports();
    await persist('settings');
  });

  $('#btnGo').onclick = startNav;
  $('#btnSaveRoute').onclick = saveRouteOffline;
  $('#btnCancel').onclick = cancelPreview;
  $('#btnSavePlace').onclick = async () => {
    const d = S.dest; if (!d) return;
    const name = prompt('Save this place as', d.name === 'Dropped pin' ? '' : d.name); if (!name) return;
    S.places.push({ id: 'pl' + Date.now(), name: name.trim(), addr: d.addr, lat: d.lat, lng: d.lng });
    await persist('places'); toast('★ Place saved');
  };
  $('#btnEnd').onclick = () => endNav();
  $('#btnMute').onclick = () => { S.muted = !S.muted; $('#btnMute').textContent = S.muted ? '🔇' : '🔊'; if (S.muted && 'speechSynthesis' in window) speechSynthesis.cancel(); };
  $('#btnOverview').onclick = () => {
    const n = S.nav; if (!n) return;
    S.follow = false; $('#btnLocate').classList.add('off');
    fitRoute(n.route ? n.route.geometry.slice(n.idx) : [S.pos.ll, [n.dest.lat, n.dest.lng]]);
  };

  addEventListener('online', setNet); addEventListener('offline', setNet);
  addEventListener('resize', layout);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.nav) wake(true); });
  if ('speechSynthesis' in window) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }
}

async function init() {
  wire(); setNet(); showSheet('idle');
  const [settings, places, routes, reports, lastPos] = await Promise.all([
    DB.get('settings', null), DB.get('places', []), DB.get('routes', []), DB.get('reports', []), DB.get('lastPos', null)]);
  if (settings) Object.assign(S.settings, settings);
  S.places = places; S.reports = reports;
  S.routes = routes.map(r => { try { return prepRoute(r); } catch { return null; } }).filter(Boolean);
  if (S.settings.tileUrl !== DEFAULT_TILES) tiles.setUrl(S.settings.tileUrl);
  if (lastPos) map.setView(lastPos, 15);
  applyTheme(); setInterval(applyTheme, 5 * 60000);
  renderReports();
  startGPS();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW', e));
}
init();

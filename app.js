/* Neonida — game-style neon GPS. Plain JS, no build step. */
(() => {
  'use strict';

  // ---------- config ----------
  const API = {
    tiles: 'https://tiles.openfreemap.org/planet',
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    route: 'https://router.project-osrm.org/route/v1/driving/',
    nearest: 'https://router.project-osrm.org/nearest/v1/driving/',
    search: 'https://photon.komoot.io/api/',
    reverse: 'https://photon.komoot.io/reverse',
  };
  const DEMO = {
    start: [-80.1340, 25.7905], // Lincoln Road, Miami Beach
    end: [-80.1867, 25.7784], // Bayside, downtown Miami
    endName: 'Bayside Marketplace',
    // Rough fallback path (MacArthur Causeway) if the route service can't be reached.
    fallback: [[-80.1340, 25.7905], [-80.1395, 25.7905], [-80.1410, 25.7860], [-80.1440, 25.7800], [-80.1500, 25.7740], [-80.1600, 25.7790], [-80.1700, 25.7840], [-80.1800, 25.7850], [-80.1867, 25.7784]],
  };
  const C = {
    night: '#140b2e', water: '#07344a', waterway: '#0b4a66', park: '#0f2d30', building: '#25184f', buildingLine: '#3b2a7c',
    motorway: '#ff3ea5', primary: '#ff9a62', tertiary: '#a68bff', minor: '#5a4bb8', rail: '#3a2f6e',
    route: '#3ff8ff', label: '#efe7ff',
  };

  // ---------- helpers ----------
  const $ = (s) => document.querySelector(s);
  const store = {
    get(k, d) { try { const v = localStorage.getItem('neonida.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('neonida.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };
  const R = 6371008.8;
  const rad = (d) => (d * Math.PI) / 180;
  const deg = (r) => (r * 180) / Math.PI;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function dist(a, b) {
    const dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0]);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  function bearing(a, b) {
    const y = Math.sin(rad(b[0] - a[0])) * Math.cos(rad(b[1]));
    const x = Math.cos(rad(a[1])) * Math.sin(rad(b[1])) - Math.sin(rad(a[1])) * Math.cos(rad(b[1])) * Math.cos(rad(b[0] - a[0]));
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }
  function projectOnSeg(p, a, b) {
    const kx = Math.cos(rad(p[1])) * R * Math.PI / 180, ky = R * Math.PI / 180;
    const ax = (a[0] - p[0]) * kx, ay = (a[1] - p[1]) * ky, bx = (b[0] - p[0]) * kx, by = (b[1] - p[1]) * ky;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const t = L2 ? clamp(-(ax * dx + ay * dy) / L2, 0, 1) : 0;
    return { t, d: Math.hypot(ax + t * dx, ay + t * dy) };
  }
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  function cumulative(coords) {
    const cum = [0];
    for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + dist(coords[i - 1], coords[i]));
    return cum;
  }
  function pointAt(coords, cum, along) {
    if (along <= 0) return coords[0];
    for (let i = 1; i < coords.length; i++) {
      if (cum[i] >= along) {
        const seg = cum[i] - cum[i - 1];
        return lerp(coords[i - 1], coords[i], seg ? (along - cum[i - 1]) / seg : 0);
      }
    }
    return coords[coords.length - 1];
  }
  async function getJSON(url, ms = 12000) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally { clearTimeout(timer); }
  }

  // ---------- units ----------
  let units = store.get('units', 'imperial');
  const speedOut = (ms) => Math.round(units === 'imperial' ? ms * 2.23694 : ms * 3.6);
  function distOut(m) {
    if (units === 'imperial') {
      const ft = m * 3.28084;
      if (ft < 1000) return `${Math.max(0, Math.round(ft / 50) * 50)} ft`;
      const mi = m / 1609.344;
      return `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;
    }
    if (m < 1000) return `${Math.max(0, Math.round(m / 10) * 10)} m`;
    const km = m / 1000;
    return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
  }
  function renderUnits() {
    $('#btnUnits').textContent = units === 'imperial' ? 'MPH' : 'KM/H';
    $('#spdUnit').textContent = units === 'imperial' ? 'MPH' : 'KM/H';
  }

  // ---------- map style ----------
  const W = (pairs) => ['interpolate', ['exponential', 1.6], ['zoom'], ...pairs];
  const cls = (list) => ['match', ['get', 'class'], list, true, false];
  function makeStyle() {
    const src = 'omt';
    const road = (id, classes, color, widths, extra = {}) => ({
      id, type: 'line', source: src, 'source-layer': 'transportation', filter: cls(classes),
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': color, 'line-width': W(widths), ...extra },
      ...(extra.minzoom ? { minzoom: extra.minzoom } : {}),
    });
    const style = {
      version: 8,
      name: 'Neonida Night',
      glyphs: API.glyphs,
      sources: {
        omt: { type: 'vector', url: API.tiles, attribution: '© OpenStreetMap contributors · OpenMapTiles · OpenFreeMap' },
        route: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': C.night } },
        { id: 'park', type: 'fill', source: src, 'source-layer': 'park', paint: { 'fill-color': C.park, 'fill-opacity': 0.9 } },
        { id: 'water', type: 'fill', source: src, 'source-layer': 'water', paint: { 'fill-color': C.water } },
        { id: 'waterway', type: 'line', source: src, 'source-layer': 'waterway', paint: { 'line-color': C.waterway, 'line-width': 1.2 } },
        { id: 'building', type: 'fill', source: src, 'source-layer': 'building', minzoom: 14, paint: { 'fill-color': C.building, 'fill-outline-color': C.buildingLine, 'fill-opacity': 0.85 } },
        { id: 'rail', type: 'line', source: src, 'source-layer': 'transportation', filter: cls(['rail', 'transit']), paint: { 'line-color': C.rail, 'line-width': 1, 'line-dasharray': [3, 3] } },
        road('minor', ['minor', 'service'], C.minor, [13, 0.6, 18, 7]),
        road('tertiary', ['tertiary'], C.tertiary, [12, 0.8, 18, 10]),
        road('primary', ['primary', 'secondary'], C.primary, [11, 1, 18, 12]),
        road('motorway-glow', ['motorway', 'trunk'], C.motorway, [10, 3, 18, 30], { 'line-blur': 6, 'line-opacity': 0.35 }),
        road('motorway', ['motorway', 'trunk'], C.motorway, [10, 1.4, 18, 14]),
        { id: 'route-glow', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': C.route, 'line-width': W([10, 8, 18, 34]), 'line-blur': 8, 'line-opacity': 0.55 } },
        { id: 'route', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': C.route, 'line-width': W([10, 3, 18, 14]) } },
        { id: 'route-core', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': W([10, 1, 18, 4]), 'line-opacity': 0.85 } },
        {
          id: 'road-names', type: 'symbol', source: src, 'source-layer': 'transportation_name', minzoom: 15,
          layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Bold'], 'text-size': 11, 'text-letter-spacing': 0.05, 'text-transform': 'uppercase' },
          paint: { 'text-color': C.label, 'text-halo-color': C.night, 'text-halo-width': 1.6 },
        },
      ],
    };
    return style;
  }

  // ---------- state ----------
  const S = {
    mode: 'idle', // 'gps' | 'demo'
    pos: null, lastTs: 0, heading: 0, speed: 0, zoom: 16.5,
    dest: null, // { lon, lat, name }
    route: null, // { coords, cum, total, duration, steps }
    along: 0, idx: 0, offCount: 0, lastReroute: 0, routing: false,
    tripStart: 0, tripDist: 0,
    lastNearest: { at: 0, pos: null },
  };
  let map, destMarker, watchId = null, demoTimer = null, wakeLock = null;

  // ---------- map ----------
  function initMap() {
    map = new maplibregl.Map({
      container: 'map',
      style: makeStyle(),
      center: DEMO.start,
      zoom: S.zoom,
      bearing: 0,
      interactive: false,
      attributionControl: false,
      fadeDuration: 0,
    });
    map.on('error', (e) => { if (!initMap.warned) { initMap.warned = true; console.warn('Map error', e && e.error); } });
    map.on('move', placeBlips);
    sizeRadar();
    window.addEventListener('resize', sizeRadar);
    $('#radar').addEventListener('click', onRadarTap);
  }
  function sizeRadar() {
    if (!map) return;
    map.resize();
    const h = $('#radar').clientHeight;
    map.setPadding({ top: h * 0.32, bottom: 0, left: 0, right: 0 });
    buildRim();
    placeBlips();
  }
  function buildRim() {
    const svg = $('#rim');
    if (svg.childElementCount) return;
    const ns = 'http://www.w3.org/2000/svg';
    let html = '<circle class="ring2" cx="100" cy="100" r="99"/><circle class="ring" cx="100" cy="100" r="96"/>';
    for (let i = 0; i < 72; i++) {
      const a = rad(i * 5), major = i % 6 === 0;
      const r1 = 96, r2 = major ? 89 : 92.5;
      html += `<line class="tick${major ? ' major' : ''}" x1="${100 + r1 * Math.sin(a)}" y1="${100 - r1 * Math.cos(a)}" x2="${100 + r2 * Math.sin(a)}" y2="${100 - r2 * Math.cos(a)}"/>`;
    }
    svg.setAttribute('xmlns', ns);
    svg.innerHTML = html;
  }
  function placeBlips() {
    if (!map) return;
    const el = $('#radar');
    const w = el.clientWidth, c = w / 2, r = c - 4;
    // North marker sits on the rim, opposite to the map's rotation.
    const a = rad(-map.getBearing());
    const nb = $('#northBlip');
    nb.style.left = `${c + r * Math.sin(a)}px`;
    nb.style.top = `${c - r * Math.cos(a)}px`;
    // Destination: on the radar it's the map marker; off the radar it clamps to the rim.
    const db = $('#destBlip');
    if (!S.dest) { db.hidden = true; return; }
    const p = map.project([S.dest.lon, S.dest.lat]);
    const vx = p.x - c, vy = p.y - c, len = Math.hypot(vx, vy);
    const edge = r - 10;
    if (len > edge) {
      db.hidden = false;
      db.style.left = `${c + (vx / len) * edge}px`;
      db.style.top = `${c + (vy / len) * edge}px`;
    } else db.hidden = true;
  }
  function zoomForSpeed(ms) {
    const mph = ms * 2.23694;
    return 17 - clamp((mph - 12) / 48, 0, 1) * 2.2;
  }
  function updateCamera(duration) {
    if (!map || !S.pos) return;
    S.zoom += (zoomForSpeed(S.speed) - S.zoom) * 0.2;
    map.easeTo({ center: S.pos, bearing: S.heading, zoom: S.zoom, duration, easing: (t) => t });
  }
  function onRadarTap(e) {
    if (!map) return;
    const rect = $('#radar').getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const c = rect.width / 2;
    if (Math.hypot(x - c, y - c) > c) return;
    const ll = map.unproject([x, y]);
    setDestination({ lon: ll.lng, lat: ll.lat, name: 'Waypoint' });
    getJSON(`${API.reverse}?lon=${ll.lng}&lat=${ll.lat}`, 6000).then((j) => {
      const f = j.features && j.features[0];
      if (f && S.dest && S.dest.name === 'Waypoint') { S.dest.name = labelFor(f.properties).name; renderNav(); }
    }).catch(() => {});
  }

  // ---------- destination & routing ----------
  function setDestination(d) {
    S.dest = d;
    if (S.mode === 'idle') startGps();
    if (!destMarker) {
      const el = document.createElement('div');
      el.className = 'dest-marker';
      destMarker = new maplibregl.Marker({ element: el, rotationAlignment: 'viewport' });
    }
    destMarker.setLngLat([d.lon, d.lat]).addTo(map);
    S.tripStart = Date.now(); S.tripDist = 0;
    $('#btnEnd').hidden = false;
    placeBlips();
    if (S.pos) requestRoute(true);
    else { toast('Destination set. Waiting for your location…'); renderNav(); }
  }
  async function requestRoute(announce) {
    if (!S.pos || !S.dest || S.routing) return;
    S.routing = true; S.lastReroute = Date.now();
    try {
      const url = `${API.route}${S.pos[0]},${S.pos[1]};${S.dest.lon},${S.dest.lat}?overview=full&geometries=geojson&steps=true`;
      const j = await getJSON(url);
      if (!j.routes || !j.routes.length) throw new Error('No route');
      if (!S.dest) return;
      loadRoute(j.routes[0]);
      if (announce) toast(`Route set · ${distOut(S.route.total)}`);
    } catch (err) {
      console.warn(err);
      toast('Couldn’t reach the route service. Check your signal and try again.');
    } finally { S.routing = false; }
  }
  function loadRoute(r) {
    const coords = r.geometry.coordinates;
    const cum = cumulative(coords);
    let from = 0;
    const steps = r.legs.flatMap((l) => l.steps).map((s) => {
      const loc = s.maneuver.location;
      let best = from, bd = Infinity;
      for (let i = from; i < coords.length; i++) {
        const d = dist(loc, coords[i]);
        if (d < bd) { bd = d; best = i; }
        if (d > bd + 500) break; // passed it
      }
      from = best;
      return { along: cum[best], type: s.maneuver.type, modifier: s.maneuver.modifier || '', exit: s.maneuver.exit, name: s.name || s.ref || '', ref: s.ref || '' };
    });
    S.route = { coords, cum, total: cum[cum.length - 1], duration: r.duration, steps };
    S.along = 0; S.idx = 0; S.offCount = 0;
    drawRoute();
    renderNav();
  }
  function clearRoute() {
    S.dest = null; S.route = null;
    if (destMarker) destMarker.remove();
    drawRoute();
    $('#btnEnd').hidden = true;
    placeBlips();
    renderNav();
  }
  function drawRoute() {
    const src = map && map.getSource('route');
    if (!src) return;
    if (!S.route) { src.setData({ type: 'FeatureCollection', features: [] }); return; }
    const { coords, cum } = S.route;
    const i = S.idx;
    const segLen = cum[i + 1] - cum[i];
    const head = segLen ? lerp(coords[i], coords[i + 1] || coords[i], (S.along - cum[i]) / segLen) : coords[i];
    const rest = [head, ...coords.slice(i + 1)];
    src.setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: rest.length > 1 ? rest : [head, head] } });
  }
  // Snap the current position onto the route. Returns distance off-route in meters.
  function locateOnRoute(p) {
    const { coords, cum } = S.route;
    let best = { d: Infinity, i: 0, t: 0 };
    const scan = (a, b) => {
      for (let i = a; i < b; i++) {
        const pr = projectOnSeg(p, coords[i], coords[i + 1]);
        if (pr.d < best.d) best = { d: pr.d, i, t: pr.t };
      }
    };
    scan(Math.max(0, S.idx - 3), Math.min(coords.length - 1, S.idx + 150));
    if (best.d > 60) scan(0, coords.length - 1);
    S.idx = best.i;
    S.along = cum[best.i] + best.t * (cum[best.i + 1] - cum[best.i]);
    return best.d;
  }

  // ---------- turn instructions ----------
  const MOD_ANGLE = { uturn: 180, 'sharp right': 135, right: 90, 'slight right': 45, straight: 0, 'slight left': -45, left: -90, 'sharp left': -135 };
  function instruction(s) {
    const road = s.name || 'the road';
    const m = s.modifier;
    switch (s.type) {
      case 'depart': return `Head out on ${road}`;
      case 'arrive': return `Arrive at ${S.dest ? S.dest.name : 'destination'}`;
      case 'merge': return `Merge onto ${road}`;
      case 'on ramp': return `Take the ramp onto ${road}`;
      case 'off ramp': return `Take the exit toward ${road}`;
      case 'fork': return `Keep ${m.replace('slight ', '') || 'ahead'} onto ${road}`;
      case 'roundabout': case 'rotary': case 'roundabout turn':
        return s.exit ? `At the roundabout, take exit ${s.exit} onto ${road}` : `Enter the roundabout onto ${road}`;
      case 'continue': case 'new name': return m && m !== 'straight' ? `Bear ${m.replace('slight ', '')} onto ${road}` : `Continue onto ${road}`;
      default:
        if (m === 'uturn') return `Make a U-turn onto ${road}`;
        if (m === 'straight') return `Go straight onto ${road}`;
        return `Turn ${m || 'ahead'} onto ${road}`;
    }
  }
  function nextStep() {
    if (!S.route) return null;
    return S.route.steps.find((s) => s.type !== 'depart' && s.along > S.along + 3) || S.route.steps[S.route.steps.length - 1];
  }
  function currentRoad() {
    if (!S.route) return null;
    let cur = null;
    for (const s of S.route.steps) { if (s.along <= S.along + 3) cur = s; else break; }
    return cur && cur.type !== 'arrive' ? (cur.name || cur.ref) : null;
  }

  // ---------- fixes (GPS or demo) ----------
  function onFix({ lon, lat, heading, speed, ts }) {
    const p = [lon, lat];
    if (S.pos) {
      const d = dist(S.pos, p), dt = (ts - S.lastTs) / 1000;
      if ((speed == null || Number.isNaN(speed)) && dt > 0) speed = d / dt;
      if ((heading == null || Number.isNaN(heading)) && d > 4) heading = bearing(S.pos, p);
      if (S.route) S.tripDist += d;
    }
    S.speed = speed && speed > 0 ? speed : 0;
    if (heading != null && !Number.isNaN(heading) && S.speed > 0.8) S.heading = heading;
    const first = !S.pos;
    S.pos = p; S.lastTs = ts;
    if (first && S.dest && !S.route) requestRoute(true);

    if (S.route) {
      const off = locateOnRoute(p);
      if ((S.route.total - S.along < 25 || (S.dest && dist(p, [S.dest.lon, S.dest.lat]) < 25))) return arrive();
      if (S.mode === 'gps' && off > 45) {
        S.offCount++;
        if (S.offCount >= 3 && Date.now() - S.lastReroute > 8000) { toast('Recalculating…'); S.offCount = 0; requestRoute(false); }
      } else S.offCount = 0;
      drawRoute();
    } else if (S.mode === 'gps') maybeNearestName(p);

    updateCamera(S.mode === 'demo' ? 260 : 1000);
    renderNav();
  }
  function maybeNearestName(p) {
    const ln = S.lastNearest;
    if (Date.now() - ln.at < 8000 && ln.pos && dist(ln.pos, p) < 60) return;
    ln.at = Date.now(); ln.pos = p;
    getJSON(`${API.nearest}${p[0]},${p[1]}?number=1`, 6000).then((j) => {
      const n = j.waypoints && j.waypoints[0] && j.waypoints[0].name;
      if (n) { ln.name = n; renderNav(); }
    }).catch(() => {});
  }
  function arrive() {
    const mins = Math.max(1, Math.round((Date.now() - S.tripStart) / 60000));
    const name = S.dest ? S.dest.name : 'Destination';
    $('#bannerSub').textContent = `${name} · ${mins} min · ${distOut(S.tripDist)}`;
    $('#banner').hidden = false;
    setTimeout(() => { $('#banner').hidden = true; }, 6000);
    clearRoute();
    if (S.mode === 'demo') stopDemo();
  }

  // ---------- HUD ----------
  function renderNav() {
    $('#spd').textContent = speedOut(S.speed);
    const card = $('#turnCard');
    const arrow = $('#turnArrow');
    const street = currentRoad() || (S.mode === 'gps' && S.lastNearest.name) || (S.pos ? 'Unnamed road' : (S.mode === 'gps' ? 'Waiting for GPS…' : 'Ready'));
    $('#street').textContent = street;

    if (S.route) {
      const st = nextStep();
      const toGo = Math.max(0, st.along - S.along);
      card.classList.remove('idle');
      $('#turnDist').textContent = distOut(toGo);
      $('#turnText').textContent = instruction(st);
      const ang = st.type === 'arrive' ? 0 : (MOD_ANGLE[st.modifier] ?? 0);
      arrow.style.transform = `rotate(${ang}deg)`;
      const remain = Math.max(0, S.route.total - S.along);
      const secs = S.route.duration * (remain / (S.route.total || 1));
      const eta = new Date(Date.now() + secs * 1000);
      $('#eta').textContent = `${Math.max(1, Math.round(secs / 60))} min · ${distOut(remain)} · ETA ${eta.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    } else {
      card.classList.add('idle');
      arrow.style.transform = 'none';
      $('#turnDist').textContent = S.dest ? 'Routing…' : 'No route';
      $('#turnText').textContent = S.dest ? `Heading to ${S.dest.name}` : 'Search a place or tap the radar to drop a waypoint.';
      $('#eta').textContent = S.mode === 'demo' ? 'Demo drive' : 'Cruise mode';
    }
  }
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
  }

  // ---------- GPS ----------
  function startGps() {
    stopDemo();
    S.mode = 'gps';
    renderNav();
    if (!('geolocation' in navigator)) { toast('This browser can’t share your location. Try the demo drive.'); return; }
    if (watchId != null) return;
    watchId = navigator.geolocation.watchPosition(
      (p) => {
        if (S.mode !== 'gps') return;
        onFix({ lon: p.coords.longitude, lat: p.coords.latitude, heading: p.coords.heading, speed: p.coords.speed, ts: p.timestamp || Date.now() });
      },
      (err) => {
        toast(err.code === 1
          ? 'Location is blocked. Allow it in your browser settings, or try the demo drive.'
          : 'Searching for GPS signal…');
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 },
    );
    keepAwake();
  }
  function stopGps() {
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }

  // ---------- demo drive ----------
  async function startDemo() {
    stopGps();
    stopDemo();
    S.mode = 'demo';
    $('#btnDemo').textContent = 'Stop demo';
    S.pos = null; S.speed = 0; S.heading = 0;
    clearRoute();
    // Seed a position so the route request starts from the demo start.
    onFix({ lon: DEMO.start[0], lat: DEMO.start[1], heading: 270, speed: 0, ts: Date.now() });
    map.jumpTo({ center: DEMO.start, zoom: S.zoom, bearing: 270 });
    S.heading = 270;
    setDestination({ lon: DEMO.end[0], lat: DEMO.end[1], name: DEMO.endName });
    // Wait for the route (or fall back to a rough path).
    for (let i = 0; i < 60 && !S.route && S.mode === 'demo'; i++) await new Promise((r) => setTimeout(r, 100));
    if (S.mode !== 'demo') return;
    let path, pathCum, simAlong = 0, v = 0, lastRoute = null;
    const tick = 0.25;
    demoTimer = setInterval(() => {
      const route = S.route;
      if (route !== lastRoute) { // new or rerouted route: follow it from its start
        lastRoute = route;
        path = route ? route.coords : DEMO.fallback;
        pathCum = route ? route.cum : cumulative(DEMO.fallback);
        simAlong = 0;
      }
      const total = pathCum[pathCum.length - 1];
      const st = route ? nextStep() : null;
      const toTurn = st ? st.along - S.along : Infinity;
      const target = toTurn < 45 ? 7 : toTurn < 120 ? 11 : 17 + 3 * Math.sin(Date.now() / 7000);
      v += clamp(target - v, -3 * tick, 2.2 * tick);
      simAlong = Math.min(total, simAlong + v * tick);
      const p = pointAt(path, pathCum, simAlong);
      const ahead = pointAt(path, pathCum, Math.min(total, simAlong + 12));
      const hd = dist(p, ahead) > 1 ? bearing(p, ahead) : S.heading;
      onFix({ lon: p[0], lat: p[1], heading: hd, speed: v, ts: Date.now() });
      if (!route && simAlong >= total) { stopDemo(); toast('Demo finished.'); }
    }, tick * 1000);
    keepAwake();
  }
  function stopDemo() {
    if (demoTimer) clearInterval(demoTimer);
    demoTimer = null;
    $('#btnDemo').textContent = 'Demo drive';
    if (S.mode === 'demo') { S.mode = 'idle'; S.speed = 0; renderNav(); }
  }

  // ---------- search ----------
  function labelFor(pr) {
    const street = [pr.housenumber, pr.street].filter(Boolean).join(' ');
    const name = pr.name || street || pr.city || 'Pinned place';
    const sub = [pr.name ? street : '', pr.city || pr.county, pr.state].filter(Boolean).join(', ');
    return { name, sub };
  }
  let searchTimer, searchSeq = 0;
  function openSearch() {
    $('#sheet').hidden = false;
    setTimeout(() => $('#q').focus(), 50);
  }
  function closeSearch() { $('#sheet').hidden = true; $('#q').blur(); }
  function onSearchInput() {
    clearTimeout(searchTimer);
    const q = $('#q').value.trim();
    if (q.length < 3) { $('#results').innerHTML = ''; return; }
    searchTimer = setTimeout(async () => {
      const seq = ++searchSeq;
      const near = S.pos || DEMO.start;
      try {
        const j = await getJSON(`${API.search}?q=${encodeURIComponent(q)}&limit=7&lat=${near[1]}&lon=${near[0]}`, 8000);
        if (seq !== searchSeq) return;
        renderResults(j.features || []);
      } catch {
        if (seq === searchSeq) $('#results').innerHTML = '<li class="empty">Search is unreachable right now. Check your signal.</li>';
      }
    }, 350);
  }
  function renderResults(features) {
    const ul = $('#results');
    ul.textContent = '';
    if (!features.length) { ul.innerHTML = '<li class="empty">No places found.</li>'; return; }
    for (const f of features) {
      const { name, sub } = labelFor(f.properties || {});
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      const n = document.createElement('span'); n.className = 'r-name'; n.textContent = name;
      const s = document.createElement('span'); s.className = 'r-sub'; s.textContent = sub;
      b.append(n, s);
      b.addEventListener('click', () => {
        const [lon, lat] = f.geometry.coordinates;
        closeSearch();
        setDestination({ lon, lat, name });
      });
      li.append(b);
      ul.append(li);
    }
  }

  // ---------- misc ----------
  async function keepAwake() {
    try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch { /* not allowed here */ }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.mode !== 'idle') keepAwake(); });

  // ---------- wire up ----------
  function boot() {
    renderUnits();
    initMap();
    renderNav();
    $('#btnUnits').addEventListener('click', () => { units = units === 'imperial' ? 'metric' : 'imperial'; store.set('units', units); renderUnits(); renderNav(); });
    $('#btnSearch').addEventListener('click', openSearch);
    $('#btnClose').addEventListener('click', closeSearch);
    $('#q').addEventListener('input', onSearchInput);
    $('#btnEnd').addEventListener('click', () => { clearRoute(); if (S.mode === 'demo') stopDemo(); toast('Route ended.'); });
    $('#btnDemo').addEventListener('click', () => { if (S.mode === 'demo') { stopDemo(); clearRoute(); startGps(); } else startDemo(); });
    $('#btnGo').addEventListener('click', () => { $('#intro').hidden = true; startGps(); });
    $('#btnGoDemo').addEventListener('click', () => { $('#intro').hidden = true; startDemo(); });
  }
  boot();

  // Exposed for automated tests only.
  window.__neonida = { S, onFix, instruction, distOut, get map() { return map; } };
})();

// Collector: polls Metro-North's GTFS-realtime feed, logs every track posted at Grand Central,
// and writes the files the website reads (site/data/departures.json, site/data/model.json).
//
// Runs on GitHub Actions every ~10 minutes (see .github/workflows/collect.yml), polling every
// 30 s for most of each run, so nearly every posted track gets caught.
//
//   node collector/collect.js                 one poll
//   DURATION=540 node collector/collect.js    keep polling for 9 minutes
//   DEMO=1 node collector/collect.js          synthetic data, no network

const fs = require('fs');
const path = require('path');
const { parseFeed } = require('../site/lib/gtfsrt');
const { buildModel } = require('../site/lib/predict');
const { loadStatic } = require('./gtfs-static');

const ROOT = path.join(__dirname, '..');
const HIST_DIR = path.join(ROOT, 'data', 'history');
const OUT_DIR = path.join(ROOT, 'site', 'data');
const DEMO = process.env.DEMO === '1';
const DURATION = Number(process.env.DURATION || 0) * 1000;
const POLL_MS = Number(process.env.POLL_SECONDS || 30) * 1000;
const RT_URL = process.env.RT_URL || 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/mnr%2Fgtfs-mnr';
const STATIC_URL = process.env.STATIC_URL || 'https://rrgtfsfeeds.s3.amazonaws.com/gtfsmnr.zip';
const MODEL_DAYS = 180;
const TZ = 'America/New_York';

// ---------- NY time helpers ----------
const fmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
function ny(ms) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute), dt: p.weekday === 'Sat' || p.weekday === 'Sun' ? 'we' : 'wk' };
}

// ---------- history (monthly CSV files, easy to read and diff) ----------
const COLS = ['date', 'daytype', 'train', 'line', 'destination', 'scheduled', 'track', 'posted_min_before'];
const hhmm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

function loadHistory() {
  fs.mkdirSync(HIST_DIR, { recursive: true });
  const { parseCSV } = require('./gtfs-static');
  const recs = [];
  for (const f of fs.readdirSync(HIST_DIR).filter((f) => f.endsWith('.csv')).sort()) {
    for (const r of parseCSV(fs.readFileSync(path.join(HIST_DIR, f), 'utf8'))) {
      const [h, m] = r.scheduled.split(':').map(Number);
      recs.push({ d: r.date, dt: r.daytype, train: r.train, route: r.line, dest: r.destination, dep: h * 60 + m, track: r.track, lead: Number(r.posted_min_before) });
    }
  }
  return recs;
}

function saveHistory(recs, months) {
  for (const month of months) {
    const rows = recs.filter((r) => r.d.startsWith(month)).sort((a, b) => a.d.localeCompare(b.d) || a.dep - b.dep);
    const text = [COLS.join(','), ...rows.map((r) => [r.d, r.dt, r.train, r.route, r.dest, hhmm(r.dep), r.track, r.lead].map(csvCell).join(','))].join('\n') + '\n';
    fs.writeFileSync(path.join(HIST_DIR, `${month}.csv`), text);
  }
}

// ---------- network ----------
async function get(url) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'gct-track-predictor (github actions)' }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) { last = e; await new Promise((r) => setTimeout(r, 2000 * (i + 1))); }
  }
  throw last;
}

async function main() {
  const demo = DEMO ? require('./demo') : null;
  let history = loadHistory();
  if (DEMO && !history.length) history = demo.seedHistory(Date.now());
  const index = new Map(history.map((r, i) => [`${r.d}|${r.train}`, i]));
  const touched = new Set(DEMO ? history.map((r) => r.d.slice(0, 7)) : []);

  // Schedule data (names, colors, train numbers). Cached in the repo in case the download fails.
  const cacheFile = path.join(ROOT, 'data', 'static-cache.json');
  let st;
  try {
    st = loadStatic(DEMO ? demo.staticZip() : Buffer.from(await get(STATIC_URL)));
    if (!DEMO) {
      const json = JSON.stringify(st);
      if (!fs.existsSync(cacheFile) || fs.readFileSync(cacheFile, 'utf8') !== json) fs.writeFileSync(cacheFile, json);
    }
  } catch (e) {
    console.error('Schedule download failed, using cached copy:', e.message);
    st = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : { stops: {}, routes: {}, trips: {}, gctId: '1', schedTrack: {} };
  }
  console.log(`Static GTFS: ${Object.keys(st.trips).length} trips, GCT stop_id=${st.gctId}, scheduled tracks: ${Object.keys(st.schedTrack).length}`);

  let board = [], feedInfo = { ok: false, error: null }, polls = 0, newTracks = 0;
  const end = Date.now() + DURATION;
  do {
    const started = Date.now();
    try {
      const feed = parseFeed(DEMO ? demo.feed(Date.now()) : await get(RT_URL));
      polls++;
      const now = Date.now();
      board = [];
      for (const t of feed.trips) {
        const first = t.stops[0];
        if (!first || first.stopId !== st.gctId) continue; // only trains that start at Grand Central
        const ev = first.departure || first.arrival;
        if (!ev || !ev.time) continue;
        const est = ev.time * 1000, sched = est - (ev.delay || 0) * 1000;
        const s = st.trips[t.tripId] || {};
        const train = s.train || t.vehicleLabel || t.tripId;
        const routeId = t.routeId || s.routeId;
        const route = st.routes[routeId] || { name: routeId || 'Metro-North', color: null };
        const last = t.stops[t.stops.length - 1];
        const dest = s.headsign || st.stops[last.stopId] || last.stopId;
        const when = ny(sched);
        const date = t.startDate ? `${t.startDate.slice(0, 4)}-${t.startDate.slice(4, 6)}-${t.startDate.slice(6, 8)}` : when.date;
        const cancelled = t.scheduleRelationship === 3 || first.scheduleRelationship === 1;

        if (first.track && !cancelled) {
          const key = `${date}|${train}`;
          if (index.has(key)) {
            const r = history[index.get(key)];
            if (r.track !== first.track) { r.track = first.track; touched.add(date.slice(0, 7)); }
          } else {
            index.set(key, history.length);
            history.push({ d: date, dt: when.dt, train, route: route.name, dest, dep: when.min, track: first.track, lead: Math.round((est - now) / 60000) });
            touched.add(date.slice(0, 7));
            newTracks++;
          }
        }
        if (est < now - 5 * 60000 || est > now + 4 * 3600000) continue;
        board.push({
          tripId: t.tripId, train, route: route.name, color: route.color, dest,
          scheduled: sched, estimated: est, delayMin: Math.round((ev.delay || 0) / 60),
          status: cancelled ? 'Cancelled' : first.trainStatus || null, track: first.track || null,
          dep: when.min, dt: when.dt, scheduledTrack: st.schedTrack[t.tripId] || null,
        });
      }
      board.sort((a, b) => a.scheduled - b.scheduled);
      feedInfo = { ok: true, error: null, feedTime: feed.timestamp ? feed.timestamp * 1000 : null };
    } catch (e) {
      feedInfo = { ok: false, error: e.message };
      console.error('Poll failed:', e.message);
    }
    const wait = POLL_MS - (Date.now() - started);
    if (Date.now() + wait < end) await new Promise((r) => setTimeout(r, wait)); else break;
  } while (true);

  // ---------- write outputs ----------
  saveHistory(history, touched);
  const today = ny(Date.now()).date;
  const cutoff = new Date(Date.parse(today) - MODEL_DAYS * 86400000).toISOString().slice(0, 10);
  const model = buildModel(history.filter((r) => r.d >= cutoff && r.d !== today), today);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'model.json'), JSON.stringify(model));
  fs.writeFileSync(path.join(OUT_DIR, 'departures.json'), JSON.stringify({ generated: Date.now(), demo: DEMO, feed: feedInfo, gctId: st.gctId, departures: board }));
  console.log(`Polls: ${polls}, new tracks logged: ${newTracks}, total records: ${history.length}, upcoming departures: ${board.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

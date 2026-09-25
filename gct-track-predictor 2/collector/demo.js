// DEMO mode: synthetic static GTFS + GTFS-RT feed (real protobuf encoding) so the app can be
// tried offline. Also exercises the decoders end to end. Nothing here is real Metro-North data.

// ---- protobuf encoder ----
function varint(n) {
  n = BigInt(n); if (n < 0n) n = BigInt.asUintN(64, n);
  const out = [];
  do { let b = Number(n & 0x7fn); n >>= 7n; if (n) b |= 0x80; out.push(b); } while (n);
  return Buffer.from(out);
}
const fVar = (f, v) => Buffer.concat([varint((f << 3) | 0), varint(v)]);
const fBytes = (f, b) => { b = Buffer.isBuffer(b) ? b : Buffer.from(String(b)); return Buffer.concat([varint((f << 3) | 2), varint(b.length), b]); };
const msg = (...parts) => Buffer.concat(parts.filter(Boolean));

// ---- stored (uncompressed) zip writer ----
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) { c = (crc ^ buf[i]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(files) {
  const locals = [], centrals = []; let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text), nm = Buffer.from(name), crc = crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nm, data); centrals.push(ch, nm); off += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(centrals.length / 2, 8); end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ---- synthetic network ----
const ROUTES = [
  { id: '1', name: 'Hudson', color: '009B3A', dests: [['Croton-Harmon', 'CH'], ['Poughkeepsie', 'PO'], ['Tarrytown', 'TT']], tracks: ['23', '24', '25', '26', '27', '28', '29', '30'] },
  { id: '2', name: 'Harlem', color: '0039A6', dests: [['North White Plains', 'NW'], ['Southeast', 'SE'], ['Brewster', 'BR'], ['Wassaic', 'WA']], tracks: ['17', '18', '19', '20', '21', '22', '103', '104'] },
  { id: '3', name: 'New Haven', color: 'EE0034', dests: [['Stamford', 'SM'], ['New Haven', 'NH'], ['New Haven-State St', 'NS'], ['South Norwalk', 'SN']], tracks: ['32', '33', '34', '35', '36', '37', '38', '108', '109', '110'] },
  { id: '4', name: 'New Canaan', color: 'EE0034', dests: [['New Canaan', 'NC']], tracks: ['39', '40'] },
  { id: '5', name: 'Danbury', color: 'EE0034', dests: [['Danbury', 'DB']], tracks: ['41', '42'] },
];

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

// A day's schedule: trains every few minutes from 05:30 to 01:00
function schedule() {
  const r = rng(42), out = [];
  let m = 330, n = 500;
  while (m < 1500) {
    const route = ROUTES[Math.floor(r() * (r() < 0.2 ? 5 : 3))];
    const dest = route.dests[Math.floor(r() * route.dests.length)];
    const home = route.tracks[Math.floor(r() * route.tracks.length)];
    const alt = route.tracks[Math.floor(r() * route.tracks.length)];
    const loyalty = 0.45 + r() * 0.5;
    n += 1 + Math.floor(r() * 2);
    out.push({ train: String(n), route, dest, dep: m, home, alt, loyalty });
    m += 3 + Math.floor(r() * 9);
  }
  return out;
}
const SCHED = schedule();

function pickTrack(t, seed) {
  const r = rng(seed)();
  if (r < t.loyalty) return t.home;
  if (r < t.loyalty + (1 - t.loyalty) * 0.6) return t.alt;
  return t.route.tracks[Math.floor(rng(seed + 7)() * t.route.tracks.length)];
}

function staticZip() {
  const stops = ['stop_id,stop_name', '1,Grand Central', ...ROUTES.flatMap((r) => r.dests.map(([n, id]) => `${id},${n}`))];
  const routes = ['route_id,route_long_name,route_color', ...ROUTES.map((r) => `${r.id},${r.name},${r.color}`)];
  const trips = ['trip_id,route_id,service_id,trip_headsign,trip_short_name', ...SCHED.map((t) => `T${t.train},${t.route.id},WK,${t.dest[0]},${t.train}`)];
  return zip({ 'stops.txt': stops.join('\n'), 'routes.txt': routes.join('\n'), 'trips.txt': trips.join('\n') });
}

const nyDate = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ms));
function nyMidnight(ms) {
  const d = nyDate(ms);
  for (const off of [4, 5]) { const t = Date.parse(`${d}T00:00:00Z`) + off * 3600000; if (nyDate(t) === d && nyDate(t - 1) !== d) return t; }
  return Date.parse(`${d}T04:00:00Z`);
}

function feed(now) {
  const mid = nyMidnight(now), today = nyDate(now).replace(/-/g, '');
  const ents = [];
  for (const t of SCHED) {
    const sched = mid + t.dep * 60000;
    if (sched < now - 10 * 60000 || sched > now + 3 * 3600000) continue;
    const seed = Number(today) * 1000 + Number(t.train);
    const delay = rng(seed + 3)() < 0.15 ? 60 * Math.floor(rng(seed + 5)() * 8) : 0;
    const posted = (sched - now) / 60000 < 12 + (Number(t.train) % 6);
    const track = posted ? pickTrack(t, seed) : null;
    const ext = track ? msg(fBytes(1, track), fBytes(2, delay ? 'Late' : 'On Time')) : null;
    const gct = msg(fVar(1, 1), fBytes(3, msg(fVar(1, delay), fVar(2, Math.round((sched + delay * 1000) / 1000)))), fBytes(4, '1'), ext && fBytes(1005, ext));
    const end = msg(fVar(1, 20), fBytes(2, msg(fVar(2, Math.round(sched / 1000) + 3600))), fBytes(4, t.dest[1]));
    const trip = msg(fBytes(1, `T${t.train}`), fBytes(3, today), fBytes(5, t.route.id));
    const tu = msg(fBytes(1, trip), fBytes(2, gct), fBytes(2, end), fBytes(3, msg(fBytes(2, t.train))));
    ents.push(fBytes(2, msg(fBytes(1, t.train), fBytes(3, tu))));
  }
  return msg(fBytes(1, msg(fBytes(1, '2.0'), fVar(3, Math.round(now / 1000)))), ...ents);
}

function seedHistory(now) {
  const out = [];
  for (let back = 45; back >= 1; back--) {
    const ms = now - back * 86400000, d = nyDate(ms);
    const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
    const dt = wd === 0 || wd === 6 ? 'we' : 'wk';
    for (const t of SCHED) {
      const seed = Number(d.replace(/-/g, '')) * 1000 + Number(t.train);
      if (rng(seed + 11)() < 0.1) continue; // some days not logged
      out.push({ d, dt, train: t.train, route: t.route.name, dest: t.dest[0], dep: t.dep % 1440, track: pickTrack(t, seed), lead: 8 + Math.floor(rng(seed + 2)() * 10) });
    }
  }
  return out;
}

module.exports = { staticZip, feed, seedHistory };

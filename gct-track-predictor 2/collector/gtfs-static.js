// Tiny ZIP + CSV reader for the static Metro-North GTFS (stop names, routes, train numbers).
const zlib = require('zlib');

function unzip(buf) {
  // Find End Of Central Directory record
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(start, start + compSize);
    files[name.split('/').pop()] = method === 0 ? data : method === 8 ? zlib.inflateRawSync(data) : null;
  }
  return files;
}

function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift().map((h) => h.trim());
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
}

function loadStatic(zipBuf) {
  const files = unzip(zipBuf);
  const read = (n) => (files[n] ? parseCSV(files[n].toString('utf8')) : []);
  const stops = {}, routes = {}, trips = {};
  for (const s of read('stops.txt')) stops[s.stop_id] = s.stop_name;
  for (const r of read('routes.txt')) {
    routes[r.route_id] = {
      name: (r.route_long_name || r.route_short_name || r.route_id).replace(/\s+Line$/i, ''),
      color: r.route_color ? '#' + r.route_color : null,
    };
  }
  for (const t of read('trips.txt')) {
    trips[t.trip_id] = { train: t.trip_short_name, headsign: t.trip_headsign, routeId: t.route_id };
  }
  const gctId = Object.keys(stops).find((id) => /grand central/i.test(stops[id])) || '1';
  // If the schedule publishes a planned track at Grand Central, keep it as a hint for new trains.
  const schedTrack = {};
  const stHead = files['stop_times.txt'] ? files['stop_times.txt'].subarray(0, 300).toString('utf8').split(/\r?\n/)[0] : '';
  if (/(^|,)track(,|$)/.test(stHead)) {
    for (const s of read('stop_times.txt')) if (s.stop_id === gctId && s.track) schedTrack[s.trip_id] = s.track;
  }
  return { stops, routes, trips, gctId, schedTrack };
}

module.exports = { loadStatic, unzip, parseCSV };

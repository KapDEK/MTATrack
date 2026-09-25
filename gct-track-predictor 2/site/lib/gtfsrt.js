// Dependency-free GTFS-realtime decoder with the MTA Railroad extension (field 1005: track, trainStatus).
// Works in Node and in the browser (Uint8Array in, plain objects out).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GTFSRT = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const td = new TextDecoder();

  function readVarint(buf, pos) {
    let result = 0n, shift = 0n, b;
    do {
      if (pos >= buf.length) throw new Error('Truncated varint');
      b = buf[pos++];
      result |= BigInt(b & 0x7f) << shift;
      shift += 7n;
    } while (b & 0x80);
    return [result, pos];
  }

  // Map<fieldNumber, Array<BigInt | Uint8Array>>
  function decodeMessage(buf) {
    const fields = new Map();
    let pos = 0;
    while (pos < buf.length) {
      let key;
      [key, pos] = readVarint(buf, pos);
      const field = Number(key >> 3n), wire = Number(key & 7n);
      let val;
      if (wire === 0) [val, pos] = readVarint(buf, pos);
      else if (wire === 1) { val = new DataView(buf.buffer, buf.byteOffset + pos, 8).getBigUint64(0, true); pos += 8; }
      else if (wire === 2) {
        let len; [len, pos] = readVarint(buf, pos); len = Number(len);
        val = buf.subarray(pos, pos + len); pos += len;
      } else if (wire === 5) { val = BigInt(new DataView(buf.buffer, buf.byteOffset + pos, 4).getUint32(0, true)); pos += 4; }
      else throw new Error('Unsupported wire type ' + wire);
      if (!fields.has(field)) fields.set(field, []);
      fields.get(field).push(val);
    }
    return fields;
  }

  const one = (f, n) => (f.has(n) ? f.get(n)[0] : undefined);
  const all = (f, n) => f.get(n) || [];
  const str = (v) => (v === undefined ? undefined : td.decode(v));
  const num = (v) => (v === undefined ? undefined : Number(BigInt.asIntN(64, v)));
  const sub = (v) => (v === undefined ? undefined : decodeMessage(v));
  const ste = (v) => { const f = sub(v); return f ? { delay: num(one(f, 1)), time: num(one(f, 2)) } : undefined; };

  function parseFeed(input) {
    const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
    const feed = decodeMessage(buf);
    const header = sub(one(feed, 1));
    const out = { timestamp: header ? num(one(header, 3)) : undefined, trips: [] };
    for (const e of all(feed, 2)) {
      const ent = decodeMessage(e);
      const tuRaw = one(ent, 3);
      if (!tuRaw) continue;
      const tu = decodeMessage(tuRaw);
      const tdsc = sub(one(tu, 1)) || new Map();
      const vd = sub(one(tu, 3)) || new Map();
      const trip = {
        tripId: str(one(tdsc, 1)), startTime: str(one(tdsc, 2)), startDate: str(one(tdsc, 3)),
        scheduleRelationship: num(one(tdsc, 4)) || 0, routeId: str(one(tdsc, 5)), directionId: num(one(tdsc, 6)),
        vehicleId: str(one(vd, 1)), vehicleLabel: str(one(vd, 2)), stops: [],
      };
      for (const s of all(tu, 2)) {
        const st = decodeMessage(s);
        const ext = sub(one(st, 1005));
        trip.stops.push({
          stopSequence: num(one(st, 1)), arrival: ste(one(st, 2)), departure: ste(one(st, 3)),
          stopId: str(one(st, 4)), scheduleRelationship: num(one(st, 5)) || 0,
          track: ext ? str(one(ext, 1)) : undefined, trainStatus: ext ? str(one(ext, 2)) : undefined,
        });
      }
      out.trips.push(trip);
    }
    return out;
  }

  return { decodeMessage, parseFeed };
});

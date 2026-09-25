// Track prediction. The collector compresses logged history into a small "model" (weighted track
// counts per train, per 30-minute slot on each line, and per line); this turns it into odds.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Predict = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const isUpper = (t) => { const n = parseInt(t, 10); return Number.isFinite(n) && n < 100; }; // upper 11–42, lower 100–117
  const slotOf = (depMin) => Math.floor(depMin / 30);

  function add(acc, bucket, mul) {
    if (!bucket) return 0;
    for (const [t, w] of Object.entries(bucket.t)) acc[t] = (acc[t] || 0) + w * mul;
    return bucket.n;
  }

  // Build the model from history records { d, dt, train, route, dep, track, lead }
  function buildModel(records, today, extra = {}) {
    const m = { generated: today, train: {}, slot: {}, line: {}, recent: {}, ...extra };
    const bump = (obj, key, track, w) => {
      const b = (obj[key] ||= { t: {}, n: 0 });
      b.t[track] = Math.round(((b.t[track] || 0) + w) * 1000) / 1000;
      b.n++;
    };
    const days = new Set();
    const leads = [];
    for (const r of records) {
      const age = Math.max(0, (Date.parse(today) - Date.parse(r.d)) / 86400000);
      const w = Math.pow(0.97, age);
      days.add(r.d);
      if (r.lead > 0 && r.lead < 60) leads.push(r.lead);
      bump(m.train, `${r.dt}|${r.train}`, r.track, w);
      bump(m.slot, `${r.dt}|${r.route}|${slotOf(r.dep)}`, r.track, w);
      bump(m.line, r.route, r.track, w);
      (m.recent[r.train] ||= []).push([r.d, r.track]);
    }
    for (const k in m.recent) m.recent[k] = m.recent[k].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 14);
    leads.sort((a, b) => a - b);
    m.stats = { records: records.length, days: days.size, trains: Object.keys(m.recent).length, medianLead: leads.length ? leads[leads.length >> 1] : null };
    return m;
  }

  function predict(model, { train, route, dep, dt, scheduledTrack }) {
    if (!model) return null;
    let acc = {}, basis, samples;
    const own = model.train[`${dt}|${train}`];
    if (own && own.n >= 3) {
      basis = 'train'; samples = add(acc, own, 1);
    } else {
      samples = add(acc, own, 4);
      const s = slotOf(dep);
      let sim = 0;
      for (const k of [s - 1, s, s + 1]) sim += add(acc, model.slot[`${dt}|${route}|${k}`], k === s ? 1 : 0.5);
      samples += sim;
      basis = own ? 'train+similar' : 'similar';
      if (samples < 3) { acc = {}; samples = add(acc, model.line[route], 1); basis = 'line'; }
    }
    if (scheduledTrack && basis !== 'train') { acc[scheduledTrack] = (acc[scheduledTrack] || 0) + 3; if (!samples) basis = 'schedule'; }
    const total = Object.values(acc).reduce((a, b) => a + b, 0);
    if (!total) return { basis: 'none', samples: 0, tracks: [], upper: null, confidence: 'low' };
    const tracks = Object.entries(acc).map(([track, w]) => ({ track, pct: Math.round((w / total) * 100) })).sort((a, b) => b.pct - a.pct);
    const upper = Math.round((Object.entries(acc).filter(([t]) => isUpper(t)).reduce((a, [, w]) => a + w, 0) / total) * 100);
    const top = tracks[0].pct;
    const confidence = samples < 3 ? 'low' : top >= 70 && basis === 'train' ? 'high' : top >= 45 ? 'medium' : 'low';
    return { basis, samples, tracks: tracks.slice(0, 5), upper, confidence };
  }

  return { buildModel, predict, isUpper, slotOf };
});

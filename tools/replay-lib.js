// Replay a posture recording (see docs/RECORDING.md) through
// core.createPostureMonitor, the same code the page runs.
const C = require('../js/core.js');

function toLandmarks(arr) {
    return arr && arr.map(([x, y, z, visibility]) => ({ x, y, z, visibility }));
}

// Label of each frame from the marks list.
function labelAt(marks, t) {
    let label = marks[0].label;
    for (const m of marks) if (m.t <= t) label = m.label;
    return label;
}

// Baseline like the page: medians over the first calibrationMs of 'upright'.
function baselineFrom(rec, calibrationMs = 3000) {
    const mon = C.createPostureMonitor();
    const sh = [], hr = [];
    let start = null, last = null;
    for (const f of rec.frames) {
        if (labelAt(rec.marks, f.t) !== 'upright') { if (start !== null) break; continue; }
        if (start === null) start = f.t;
        if (f.t - start > calibrationMs) break;
        const r = mon.step(toLandmarks(f.lm), rec.width, rec.height, last === null ? 33 : f.t - last);
        last = f.t;
        if (r.raw.shoulderAngle !== null) sh.push(r.raw.shoulderAngle);
        if (r.raw.headRatio !== null) hr.push(r.raw.headRatio);
    }
    if (!hr.length) return null;
    return { headRatio: C.median(hr), shoulderAngle: C.median(sh) };
}

// Per-label summary: share of frames over/alert per metric, mean values.
function replay(rec, cfg = C.DEFAULT_MONITOR) {
    const baseline = baselineFrom(rec);
    if (!baseline) throw new Error('no upright frames with head and shoulders visible');
    const mon = C.createPostureMonitor(cfg);
    mon.setBaseline(baseline);
    const by = {};
    let last = null;
    for (const f of rec.frames) {
        const dt = last === null ? 33 : Math.min(1000, f.t - last);
        last = f.t;
        const r = mon.step(toLandmarks(f.lm), rec.width, rec.height, dt);
        const label = labelAt(rec.marks, f.t);
        const s = by[label] || (by[label] = { frames: 0, seen: 0, shoulderOver: 0, forwardOver: 0, alerts: 0, sumRatio: 0, sumShoulder: 0, ms: 0 });
        s.frames++; s.ms += dt;
        if (r.shoulder.visible && r.forward.visible) {
            s.seen++;
            s.sumRatio += r.forward.ratio;
            s.sumShoulder += Math.abs(r.shoulder.value);
        }
        if (r.shoulder.state !== 'ok') s.shoulderOver++;
        if (r.forward.state !== 'ok') s.forwardOver++;
        if (r.shoulder.fired || r.forward.fired) s.alerts++;
    }
    const summary = {};
    for (const [label, s] of Object.entries(by)) {
        summary[label] = {
            seconds: Math.round(s.ms / 1000),
            visiblePct: Math.round(100 * s.seen / s.frames),
            forwardOverPct: Math.round(100 * s.forwardOver / s.frames),
            shoulderOverPct: Math.round(100 * s.shoulderOver / s.frames),
            meanForwardPct: s.seen ? Math.round(100 * (s.sumRatio / s.seen - 1) * 10) / 10 : null,
            meanShoulderDeg: s.seen ? Math.round(s.sumShoulder / s.seen * 10) / 10 : null,
            alerts: s.alerts
        };
    }
    return { baseline, summary };
}

module.exports = { toLandmarks, labelAt, baselineFrom, replay };

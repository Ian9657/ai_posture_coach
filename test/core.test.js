const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/core.js');

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const pt = (x, y) => ({ x, y });

test('ema moves a fraction alpha toward the new value', () => {
    close(C.ema(0, 10, 0.15), 1.5);
    close(C.ema(10, 10, 0.15), 10);
    // repeated steps converge on a constant input
    let v = 0;
    for (let i = 0; i < 200; i++) v = C.ema(v, 4, 0.1);
    close(v, 4, 1e-6);
});

test('median: upper median of a copy, 0 when empty', () => {
    assert.equal(C.median([3, 1, 2]), 2);
    assert.equal(C.median([4, 1, 3, 2]), 3);
    assert.equal(C.median([]), 0);
    const arr = [3, 1, 2];
    C.median(arr);
    assert.deepEqual(arr, [3, 1, 2]);
});

test('shoulderAngle: level line is 0°, tilt follows atan2 in pixels', () => {
    // MediaPipe left shoulder sits at larger x in the unmirrored frame
    close(Math.abs(C.shoulderAngle(pt(0.6, 0.5), pt(0.4, 0.5), 640, 480)), 0, 1e-9);
    const a = C.shoulderAngle(pt(0.6, 0.52), pt(0.4, 0.5), 640, 480);
    close(a, Math.atan2(0.02 * 480, 0.2 * 640) * 180 / Math.PI);
    // frame aspect matters: same normalised points, wider frame, smaller angle
    assert.ok(C.shoulderAngle(pt(0.6, 0.52), pt(0.4, 0.5), 1280, 480) < a);
});

test('faceRotation: 0 when nose is centred, sign shows direction', () => {
    close(C.faceRotation(pt(0.5, 0.4), pt(0.6, 0.4), pt(0.4, 0.4)), 0);
    assert.ok(C.faceRotation(pt(0.45, 0.4), pt(0.6, 0.4), pt(0.4, 0.4)) > 0);
    assert.ok(C.faceRotation(pt(0.55, 0.4), pt(0.6, 0.4), pt(0.4, 0.4)) < 0);
    close(C.faceRotation(pt(0.4, 0.4), pt(0.6, 0.4), pt(0.4, 0.4)), 1);
});

test('headRatio grows when the head gets bigger relative to the shoulders', () => {
    const ls = pt(0.7, 0.7), rs = pt(0.3, 0.7);
    const upright = C.headRatio(pt(0.55, 0.4), pt(0.45, 0.4), ls, rs);
    close(upright, 0.25);
    const forward = C.headRatio(pt(0.56, 0.4), pt(0.44, 0.4), ls, rs);
    assert.ok(forward / upright > 1.15);
    // whole body closer to the camera: both spans scale, ratio unchanged
    close(C.headRatio(pt(0.6, 0.4), pt(0.4, 0.4), pt(0.9, 0.7), pt(0.1, 0.7)), upright);
});

test('lipDistance is the lip gap as a fraction of face height', () => {
    close(C.lipDistance(pt(0.5, 0.60), pt(0.5, 0.62), pt(0.5, 0.3), pt(0.5, 0.7)), 0.05);
});

test('mouthHysteresis: opens above 1.14, closes below 1.06, holds between', () => {
    assert.equal(C.mouthHysteresis(false, 1.10), false);
    assert.equal(C.mouthHysteresis(false, 1.15), true);
    assert.equal(C.mouthHysteresis(true, 1.10), true);
    assert.equal(C.mouthHysteresis(true, 1.05), false);
});

test('countTransitions counts state changes', () => {
    assert.equal(C.countTransitions([]), 0);
    assert.equal(C.countTransitions([false, false, true, true, false]), 2);
});

test('scoreTick: 1 s penalty per alert second, 0.5 s recovery, capped at rampSec', () => {
    const W = { shoulder: 0.25, rotation: 0.25, forward: 0.3, mouth: 0.2 };
    const none = { shoulder: false, rotation: false, forward: false, mouth: false };
    const cons = { shoulder: 0, rotation: 0, forward: 0, mouth: 0 };
    assert.equal(C.scoreTick(cons, none, W, 30), 100);

    const fwd = { ...none, forward: true };
    for (let i = 0; i < 15; i++) C.scoreTick(cons, fwd, W, 30);
    assert.equal(cons.forward, 15);
    assert.equal(C.scoreTick(cons, fwd, W, 30), Math.round(100 * (1 - 0.3 * 16 / 30)));
    for (let i = 0; i < 100; i++) C.scoreTick(cons, fwd, W, 30);
    assert.equal(cons.forward, 30);
    assert.equal(C.scoreTick(cons, fwd, W, 30), 70);

    C.scoreTick(cons, none, W, 30);
    assert.equal(cons.forward, 29.5);

    const all = { shoulder: true, rotation: true, forward: true, mouth: true };
    const c2 = { shoulder: 30, rotation: 30, forward: 30, mouth: 30 };
    assert.equal(C.scoreTick(c2, all, W, 30), 0);
});

test('analyzeSegment averages magnitudes and alert percentages', () => {
    assert.equal(C.analyzeSegment([]), null);
    const seg = C.analyzeSegment([
        { score: 100, shoulder: -2, rotation: 0.1, forwardAlert: false, mouthAlert: false },
        { score: 50, shoulder: 4, rotation: -0.3, forwardAlert: true, mouthAlert: false }
    ]);
    close(seg.avgShoulder, 3);
    close(seg.avgRotation, 0.2);
    assert.equal(seg.fwdPct, 50);
    assert.equal(seg.mouthPct, 0);
    assert.equal(seg.avgScore, 75);
});

test('freshCounters has a zero for every metric', () => {
    assert.deepEqual(C.freshCounters(), { shoulder: 0, rotation: 0, forward: 0, mouth: 0 });
});

test('scoreTick never returns NaN when a counter is missing (#13)', () => {
    const W = { shoulder: 0.25, rotation: 0.25, forward: 0.3, mouth: 0.2 };
    const alerts = { shoulder: false, rotation: false, forward: true, mouth: false };
    // the old chart-window reset left out `forward`
    const cons = { shoulder: 0, rotation: 0, mouth: 0 };
    const score = C.scoreTick(cons, alerts, W, 30);
    assert.ok(Number.isFinite(score));
    assert.equal(cons.forward, 1);
    assert.equal(score, Math.round(100 * (1 - 0.3 / 30)));
});

test('alphaFor matches the v2.6.0 per-frame alphas at 30 fps (#14)', () => {
    // CONFIG.SMOOTH_TAU_MS = 205 and SHOULDER_TAU_MS = 316 in js/app.js
    assert.equal(Math.round(C.tauFromFrameAlpha(0.15, 30)), 205);
    assert.equal(Math.round(C.tauFromFrameAlpha(0.10, 30)), 316);
    close(C.alphaFor(1000 / 30, 205), 0.15, 0.001);
    close(C.alphaFor(1000 / 30, 316), 0.10, 0.001);
});

test('time-based EMA settles at the same time whatever the frame rate (#14)', () => {
    const settle = fps => {
        let v = 0, t = 0;
        const dt = 1000 / fps;
        while (v < 0.95) { v = C.ema(v, 1, C.alphaFor(dt, 205)); t += dt; }
        return t;
    };
    const t30 = settle(30), t3 = settle(3);
    assert.ok(Math.abs(t30 - 614) < 40, `30 fps: ${t30}`);   // ~3 tau
    assert.ok(t3 < 1000, `3 fps: ${t3}`);                    // per-frame 0.15 would take ~6 s
});

// Drive a tracker for durationMs at fps; f(t) gives [ratio, smoothedOpen].
function runMouth(fps, durationMs, f, tracker = C.createMouthTracker()) {
    const dt = 1000 / fps;
    let out, t = 0;
    for (; t < durationMs; t += dt) { const [r, o] = f(t); out = tracker.step(t, dt, r, o); }
    return out;
}

test('mouth alert fires after ~5 s open at 30 fps and at 10 fps (#14)', () => {
    for (const fps of [30, 10]) {
        assert.equal(runMouth(fps, 4800, () => [1.3, true]).alert, false, `${fps} fps at 4.8 s`);
        const r = runMouth(fps, 5300, () => [1.3, true]);
        assert.equal(r.alert, true, `${fps} fps at 5.3 s`);
        assert.equal(r.state, 'OPEN');
    }
});

test('closed time drains the open timer 5x faster', () => {
    const tr = C.createMouthTracker();
    runMouth(30, 4000, () => [1.3, true], tr);
    // 0.5 s closed removes 2.5 s; only one hysteresis change, so not talking
    const dt = 1000 / 30;
    let r;
    for (let t = 4000; t < 4500; t += dt) r = tr.step(t, dt, 1.0, false);
    assert.equal(r.state, 'CLOSED');
    assert.ok(Math.abs(r.openMs - 1500) < 200, `${r.openMs}`); // ±1 frame of float drift
});

test('fast open/close flicker reads as TALKING and never alerts', () => {
    for (const fps of [30, 10]) {
        // mouth toggles every 200 ms for 8 s
        const r = runMouth(fps, 8000, t => Math.floor(t / 200) % 2 ? [1.3, true] : [1.0, false]);
        assert.equal(r.state, 'TALKING', `${fps} fps`);
        assert.equal(r.alert, false);
    }
});

test('reset clears the tracker', () => {
    const tr = C.createMouthTracker();
    runMouth(30, 6000, () => [1.3, true], tr);
    tr.reset();
    const r = tr.step(0, 33, 1.0, false);
    assert.equal(r.openMs, 0);
    assert.equal(r.state, 'CLOSED');
});

test('baseline round-trips through serialize/parse (#5)', () => {
    const b = { lipDist: 0.012, headRatio: 0.41, shoulderAngle: -1.7, faceRotation: 0.03 };
    const got = C.parseBaseline(C.serializeBaseline(b, 1762200000000));
    assert.deepEqual(got, { baseline: b, savedAt: 1762200000000 });
});

test('parseBaseline rejects missing, malformed or foreign data', () => {
    const ok = { v: 1, savedAt: 1, lipDist: 0.01, headRatio: 0.4, shoulderAngle: 0, faceRotation: 0 };
    assert.equal(C.parseBaseline(null), null);
    assert.equal(C.parseBaseline('not json'), null);
    assert.equal(C.parseBaseline('null'), null);
    assert.equal(C.parseBaseline(JSON.stringify({ ...ok, v: 2 })), null);
    assert.equal(C.parseBaseline(JSON.stringify({ ...ok, headRatio: 'x' })), null);
    assert.equal(C.parseBaseline(JSON.stringify({ ...ok, lipDist: -1 })), null);
    const { faceRotation, ...missing } = ok;
    assert.equal(C.parseBaseline(JSON.stringify(missing)), null);
    assert.notEqual(C.parseBaseline(JSON.stringify(ok)), null);
});

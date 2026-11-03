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

test('baseline round-trips through serialize/parse (#5)', () => {
    const b = { headRatio: 0.41, shoulderAngle: -1.7 };
    const got = C.parseBaseline(C.serializeBaseline(b, 1762200000000));
    assert.deepEqual(got, { baseline: b, savedAt: 1762200000000 });
});

test('parseBaseline reads a v2.6-era save that still has mouth/rotation keys', () => {
    const old = { v: 1, savedAt: 5, lipDist: 0.01, headRatio: 0.4, shoulderAngle: 1, faceRotation: 0 };
    assert.deepEqual(C.parseBaseline(JSON.stringify(old)), { baseline: { headRatio: 0.4, shoulderAngle: 1 }, savedAt: 5 });
});

test('parseBaseline rejects missing, malformed or foreign data', () => {
    const ok = { v: 1, savedAt: 1, headRatio: 0.4, shoulderAngle: 0 };
    assert.equal(C.parseBaseline(null), null);
    assert.equal(C.parseBaseline('not json'), null);
    assert.equal(C.parseBaseline('null'), null);
    assert.equal(C.parseBaseline(JSON.stringify({ ...ok, v: 2 })), null);
    assert.equal(C.parseBaseline(JSON.stringify({ ...ok, headRatio: 'x' })), null);
    assert.equal(C.parseBaseline(JSON.stringify({ ...ok, headRatio: -1 })), null);
    const { shoulderAngle, ...missing } = ok;
    assert.equal(C.parseBaseline(JSON.stringify(missing)), null);
    assert.notEqual(C.parseBaseline(JSON.stringify(ok)), null);
});

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

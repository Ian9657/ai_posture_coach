// Replays recordings in test/recordings/*.json through the posture monitor.
// Recordings are optional; without any, only the synthetic check runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { replay, labelAt } = require('../tools/replay-lib.js');

// Expectations for the labels where the algorithm is supposed to work.
// look-down, turn and lean-back are known blind spots: reported, not asserted.
const EXPECT = {
    upright:  s => { assert.ok(s.forwardOverPct <= 10, `upright: forward over ${s.forwardOverPct}%`);
                     assert.ok(s.shoulderOverPct <= 10, `upright: shoulders over ${s.shoulderOverPct}%`); },
    forward:  s => assert.ok(s.forwardOverPct >= 50, `forward: only ${s.forwardOverPct}% over`),
    tilt:     s => assert.ok(s.shoulderOverPct >= 50, `tilt: only ${s.shoulderOverPct}% over`)
};

// Synthetic recording: 5 s upright, 5 s with ears 12% wider, 5 s tilted 7 deg.
function synthetic() {
    const frames = [];
    const lm = (span, tilt) => {
        const p = Array.from({ length: 33 }, () => [0.5, 0.5, 0, 1]);
        p[0] = [0.5, 0.42, 0, 1]; p[7] = [0.5 + span / 2, 0.4, 0, 1]; p[8] = [0.5 - span / 2, 0.4, 0, 1];
        const dy = Math.tan(tilt * Math.PI / 180) * 0.4 * 640 / 480 / 2;
        p[11] = [0.7, 0.7 + dy, 0, 1]; p[12] = [0.3, 0.7 - dy, 0, 1];
        return p;
    };
    for (let t = 0; t < 15000; t += 66) frames.push({ t, lm: t < 5000 ? lm(0.1, 0) : t < 10000 ? lm(0.112, 0) : lm(0.1, 7) });
    return { format: 'posture-recording', version: 1, model: 'synthetic', width: 640, height: 480,
             frames, marks: [{ t: 0, label: 'upright' }, { t: 5000, label: 'forward' }, { t: 10000, label: 'tilt' }] };
}

test('labelAt follows the marks', () => {
    const marks = [{ t: 0, label: 'a' }, { t: 100, label: 'b' }];
    assert.equal(labelAt(marks, 50), 'a');
    assert.equal(labelAt(marks, 100), 'b');
});

test('replay of a synthetic recording meets the expectations', () => {
    const { summary } = replay(synthetic());
    for (const [label, check] of Object.entries(EXPECT)) check(summary[label]);
    assert.ok(Math.abs(summary.forward.meanForwardPct - 11) < 2, `${summary.forward.meanForwardPct}`);
});

const dir = path.join(__dirname, 'recordings');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')) : [];
for (const f of files) {
    test(`recording ${f}`, () => {
        const { summary } = replay(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
        for (const [label, check] of Object.entries(EXPECT)) if (summary[label]) check(summary[label]);
    });
}

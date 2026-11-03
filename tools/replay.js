#!/usr/bin/env node
// Usage: node tools/replay.js recording.json [more.json ...]
// Prints, per labelled segment, how often each metric was over threshold.
const fs = require('node:fs');
const { replay } = require('./replay-lib.js');

for (const file of process.argv.slice(2)) {
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    const { baseline, summary } = replay(rec);
    console.log(`\n${file}  (${rec.frames.length} frames, ${rec.width}x${rec.height}, ${rec.model})`);
    console.log(`baseline: head ratio ${baseline.headRatio.toFixed(4)}, shoulders ${baseline.shoulderAngle.toFixed(2)}°`);
    console.table(summary);
}
if (process.argv.length < 3) console.log('usage: node tools/replay.js recording.json [...]');

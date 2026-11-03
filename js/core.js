// Pure posture maths: no DOM, no camera, no MediaPipe.
// Loaded as a classic script in the browser (exposes window.PostureCore)
// and with require() in Node tests.
(function (root) {
    const METRICS = ['shoulder', 'rotation', 'forward', 'mouth'];

    // Exponential moving average step.
    function ema(prev, value, alpha) {
        return value * alpha + prev * (1 - alpha);
    }

    // EMA weight for a step of dtMs with time constant tauMs. Makes smoothing
    // independent of frame rate: at 30 fps it equals the per-frame alpha
    // the time constant was derived from (see tauFromFrameAlpha).
    function alphaFor(dtMs, tauMs) {
        return 1 - Math.exp(-dtMs / tauMs);
    }

    // Time constant (ms) of a per-frame EMA alpha at a given frame rate.
    function tauFromFrameAlpha(alpha, fps) {
        return (1000 / fps) / -Math.log(1 - alpha);
    }

    // Upper median (index floor(n/2) of the sorted copy); 0 for an empty list.
    function median(arr) {
        const s = [...arr].sort((a, b) => a - b);
        return s.length > 0 ? s[Math.floor(s.length / 2)] : 0;
    }

    // Shoulder line angle in degrees. Landmarks are normalised (0..1), so the
    // frame size is needed to keep the angle true on non-square video.
    function shoulderAngle(leftS, rightS, W, H) {
        const dy = (leftS.y - rightS.y) * H;
        const dx = (leftS.x - rightS.x) * W;
        return Math.atan2(dy, dx) * (180 / Math.PI);
    }

    // Head yaw proxy in -1..1. Not shown as a metric any more (#16); kept for
    // correcting the ear span when the head is turned. from horizontal nose-to-ear distances.
    function faceRotation(nose, leftEar, rightEar) {
        const distL = Math.abs(nose.x - leftEar.x);
        const distR = Math.abs(nose.x - rightEar.x);
        return (distL - distR) / (distL + distR);
    }

    // Ear span / shoulder span. Rises when the head moves toward the camera
    // relative to the shoulders (forward head).
    function headRatio(leftEar, rightEar, leftS, rightS) {
        return Math.hypot(leftEar.x - rightEar.x, leftEar.y - rightEar.y) /
               Math.hypot(leftS.x - rightS.x, leftS.y - rightS.y);
    }

    // Hysteresis + hold time for one metric, where a larger value is worse.
    // ok -> over when value > on; over/alert -> ok when value < off.
    // over -> alert after holdMs continuously over; `fired` is true on that
    // one step only, so callers can raise a single notification.
    function createSustain({ on, off, holdMs }) {
        let state = 'ok', overMs = 0;
        return {
            reset() { state = 'ok'; overMs = 0; },
            step(value, dtMs) {
                let fired = false;
                if (state === 'ok') {
                    if (value > on) { state = 'over'; overMs = 0; }
                } else if (value < off) {
                    state = 'ok'; overMs = 0;
                }
                if (state !== 'ok') {
                    overMs += dtMs;
                    if (state === 'over' && overMs >= holdMs) { state = 'alert'; fired = true; }
                }
                return { state, overMs, fired };
            }
        };
    }

    const DEFAULT_MONITOR = {
        visThresh: 0.85,
        smoothTauMs: 205,
        shoulderTauMs: 316,
        shoulder: { on: 4.5, off: 3.0 },    // degrees from baseline
        forward: { on: 1.08, off: 1.05 },   // head ratio / baseline
        holdMs: 60000                       // sustained this long -> alert
    };

    // Turns pose landmarks into the two posture metrics. Pure: no DOM, so
    // the live page and recorded-landmark replays run the same code.
    function createPostureMonitor(cfg = DEFAULT_MONITOR) {
        let base = { headRatio: 0, shoulderAngle: 0 };
        let smShoulder = 0, smHead = 0;
        const sShoulder = createSustain({ ...cfg.shoulder, holdMs: cfg.holdMs });
        const sForward = createSustain({ ...cfg.forward, holdMs: cfg.holdMs });
        const vis = p => p && p.visibility > cfg.visThresh;

        return {
            setBaseline(b) {
                base = { headRatio: b.headRatio, shoulderAngle: b.shoulderAngle };
                smShoulder = 0; smHead = base.headRatio;
                sShoulder.reset(); sForward.reset();
            },
            get baseline() { return { ...base }; },
            // lm: 33 pose landmarks (or null); W, H: frame size in pixels.
            step(lm, W, H, dtMs) {
                const out = {
                    raw: { shoulderAngle: null, headRatio: null },
                    shoulder: { visible: false, value: 0, state: 'ok', overMs: 0, fired: false },
                    forward: { visible: false, calibrated: base.headRatio > 0, ratio: 1, state: 'ok', overMs: 0, fired: false }
                };
                const nose = lm && lm[0], lEar = lm && lm[7], rEar = lm && lm[8], lS = lm && lm[11], rS = lm && lm[12];
                const shouldersSeen = vis(lS) && vis(rS);
                const headSeen = vis(nose) && vis(lEar) && vis(rEar);

                if (shouldersSeen) {
                    const raw = shoulderAngle(lS, rS, W, H);
                    out.raw.shoulderAngle = raw;
                    smShoulder = ema(smShoulder, raw - base.shoulderAngle, alphaFor(dtMs, cfg.shoulderTauMs));
                    out.shoulder = { visible: true, value: smShoulder, ...sShoulder.step(Math.abs(smShoulder), dtMs) };
                } else sShoulder.reset();

                if (shouldersSeen && headSeen) {
                    const raw = headRatio(lEar, rEar, lS, rS);
                    out.raw.headRatio = raw;
                    out.forward.visible = true;
                    if (base.headRatio > 0) {
                        smHead = ema(smHead, raw, alphaFor(dtMs, cfg.smoothTauMs));
                        const ratio = smHead / base.headRatio;
                        Object.assign(out.forward, { ratio }, sForward.step(ratio, dtMs));
                    }
                } else sForward.reset();
                return out;
            }
        };
    }

    const BASELINE_KEYS = ['headRatio', 'shoulderAngle'];
    const BASELINE_VERSION = 1;

    // Calibration baseline <-> JSON string for localStorage.
    function serializeBaseline(b, savedAt) {
        const out = { v: BASELINE_VERSION, savedAt };
        for (const k of BASELINE_KEYS) out[k] = b[k];
        return JSON.stringify(out);
    }

    // Returns { baseline, savedAt } or null for anything missing, malformed
    // or from another format version.
    function parseBaseline(text) {
        let d;
        try { d = JSON.parse(text); } catch (e) { return null; }
        if (!d || d.v !== BASELINE_VERSION || !Number.isFinite(d.savedAt)) return null;
        const baseline = {};
        for (const k of BASELINE_KEYS) {
            if (!Number.isFinite(d[k])) return null;
            baseline[k] = d[k];
        }
        if (baseline.headRatio < 0) return null;
        return { baseline, savedAt: d.savedAt };
    }

    const PostureCore = {
        BASELINE_KEYS, DEFAULT_MONITOR, createSustain, createPostureMonitor, ema, alphaFor, tauFromFrameAlpha, median, shoulderAngle,
        faceRotation, headRatio, serializeBaseline, parseBaseline
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = PostureCore;
    else root.PostureCore = PostureCore;
})(this);

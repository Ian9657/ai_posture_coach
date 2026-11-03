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
        BASELINE_KEYS, ema, alphaFor, tauFromFrameAlpha, median, shoulderAngle,
        faceRotation, headRatio, serializeBaseline, parseBaseline
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = PostureCore;
    else root.PostureCore = PostureCore;
})(this);

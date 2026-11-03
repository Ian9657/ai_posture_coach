// Pure posture maths: no DOM, no camera, no MediaPipe.
// Loaded as a classic script in the browser (exposes window.PostureCore)
// and with require() in Node tests.
(function (root) {
    const METRICS = ['shoulder', 'rotation', 'forward', 'mouth'];

    // Exponential moving average step.
    function ema(prev, value, alpha) {
        return value * alpha + prev * (1 - alpha);
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

    // Head yaw proxy in -1..1 from horizontal nose-to-ear distances.
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

    // Lip gap normalised by face height (forehead to chin).
    function lipDistance(upperLip, lowerLip, forehead, chin) {
        return Math.abs(lowerLip.y - upperLip.y) / Math.abs(chin.y - forehead.y);
    }

    // Mouth open/closed with hysteresis: open above 1.14x baseline,
    // closed again below 1.06x.
    function mouthHysteresis(lastState, ratio) {
        if (lastState && ratio < 1.06) return false;
        if (!lastState && ratio > 1.14) return true;
        return lastState;
    }

    function countTransitions(states) {
        let n = 0;
        for (let i = 1; i < states.length; i++) if (states[i] !== states[i - 1]) n++;
        return n;
    }

    // Zeroed alert counters, one per metric.
    function freshCounters() {
        const c = {};
        for (const key of METRICS) c[key] = 0;
        return c;
    }

    // One scoring tick (called once per second). Mutates `consecutive`:
    // +1 per second in alert (capped at rampSec), -0.5 per second otherwise.
    // Returns 0..100.
    function scoreTick(consecutive, alerts, weights, rampSec) {
        for (const key of METRICS) {
            const prev = consecutive[key] || 0; // a missing counter counts as 0, never NaN
            if (alerts[key]) consecutive[key] = Math.min(rampSec, prev + 1);
            else consecutive[key] = Math.max(0, prev - 0.5);
        }
        let totalPenalty = 0;
        for (const key of METRICS) totalPenalty += weights[key] * (consecutive[key] / rampSec);
        return Math.round(100 * (1 - totalPenalty));
    }

    function analyzeSegment(data) {
        if (!data.length) return null;
        let sumShoulder = 0, sumRotation = 0, sumScore = 0, fwdCount = 0, mouthCount = 0;
        for (const d of data) {
            sumShoulder += Math.abs(d.shoulder);
            sumRotation += Math.abs(d.rotation);
            sumScore += d.score;
            if (d.forwardAlert) fwdCount++;
            if (d.mouthAlert) mouthCount++;
        }
        const len = data.length;
        return {
            avgShoulder: sumShoulder / len,
            avgRotation: sumRotation / len,
            fwdPct: Math.round((fwdCount / len) * 100),
            mouthPct: Math.round((mouthCount / len) * 100),
            avgScore: Math.round(sumScore / len)
        };
    }

    const PostureCore = {
        METRICS, freshCounters, ema, median, shoulderAngle, faceRotation, headRatio,
        lipDistance, mouthHysteresis, countTransitions, scoreTick, analyzeSegment
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = PostureCore;
    else root.PostureCore = PostureCore;
})(this);

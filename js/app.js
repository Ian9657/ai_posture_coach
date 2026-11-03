const CONFIG = {
    VIS_THRESH: 0.85,
    // Smoothing time constants. v2.6.0 used per-frame alphas 0.15 / 0.10 at
    // 30 fps; these are the same smoothing expressed in milliseconds.
    SMOOTH_TAU_MS: 205,
    SHOULDER_TAU_MS: 316,
    THRESHOLDS: {
        shoulder: 4.5,
        forward: 1.08   // owner: +9% already feels like bad posture (2026-11-03)
    },
    CALIBRATION_MS: 3000,
    HEAT_WINDOW_MS: 5000,
    MAX_FRAME_DT_MS: 1000   // cap one frame's step after a stall or a hidden tab
};

const { ema, median, shoulderAngle, headRatio, alphaFor,
        serializeBaseline, parseBaseline } = PostureCore;

const CALIBRATION_STORE_KEY = 'posture-core.calibration';

// Status colours come from css/style.css (:root) so page and canvas match.
const rootStyle = getComputedStyle(document.documentElement);
const cssVar = (name, fallback) => rootStyle.getPropertyValue(name).trim() || fallback;
const GREEN_RGB = cssVar('--green-rgb', '16, 185, 129');
const ACCENT_RGB = cssVar('--accent-rgb', '249, 115, 22');
const GREEN = `rgb(${GREEN_RGB})`, ACCENT = `rgb(${ACCENT_RGB})`;
const green = a => `rgba(${GREEN_RGB}, ${a})`;
const accent = a => `rgba(${ACCENT_RGB}, ${a})`;

const videoElement = document.getElementById('input_video');
const canvasElement = document.getElementById('output_canvas');
const canvasCtx = canvasElement.getContext('2d');

let baselineHeadRatio = 0, lastHeadRatio = 0, smoothHeadRatio = 0;
let baselineShoulderAngle = 0, smoothShoulderAngle = 0;
let frameNow = 0, frameDt = 1000 / 30, lastFrameAt = 0;
let isCalibrating = false, calibrationStartedAt = 0;
let calibrationData = { headRatio: [], shoulderAngle: [] };
let isZenMode = false;
const alertStates = { shoulder: false, forward: false };

const domCache = {};
const canvasCache = { bgGrad: null, gridGrad: null, gridPath: null };

function showToast(msg, duration = 3000) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerText = msg;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(120%)';
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

function toggleZen() {
    isZenMode = !isZenMode;
    const b = document.getElementById('zen-btn');
    b.style.background = isZenMode ? green(0.15) : '';
    b.style.color = isZenMode ? 'var(--neon-green)' : '';
    b.style.borderColor = isZenMode ? green(0.3) : '';
    b.innerText = isZenMode ? 'Zen: ON' : 'Zen Mode';
}

let pipVideo = null;
async function togglePiP() {
    if (/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
        showToast('PiP only supported on PC.');
        return;
    }
    if (!document.pictureInPictureEnabled) {
        showToast('Browser does not support PiP.');
        return;
    }

    if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
    } else {
        if (!pipVideo) {
            pipVideo = document.createElement('video');
            pipVideo.muted = true;
            pipVideo.autoplay = true;
            pipVideo.playsInline = true;
            pipVideo.style.position = 'fixed';
            pipVideo.style.opacity = '0';
            pipVideo.style.pointerEvents = 'none';
            pipVideo.style.width = '1px';
            pipVideo.style.height = '1px';
            document.body.appendChild(pipVideo);

            pipVideo.srcObject = canvasElement.captureStream(30);

            pipVideo.addEventListener('enterpictureinpicture', () => {
                const btn = document.getElementById('pip-btn');
                btn.innerText = 'CLOSE PIP';
                btn.style.color = 'var(--neon-green)';
                btn.style.borderColor = green(0.3);
                btn.style.background = green(0.15);
            });
            pipVideo.addEventListener('leavepictureinpicture', () => {
                const btn = document.getElementById('pip-btn');
                btn.innerText = 'PIP';
                btn.style.color = '';
                btn.style.borderColor = '';
                btn.style.background = '';
            });
        }
        try {
            await pipVideo.play();
            await pipVideo.requestPictureInPicture();
        } catch (error) {
            showToast('PiP failed: ' + error.message);
        }
    }
}

// --- Audio ---
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
let lastBeepTime = 0;

// Browsers keep an AudioContext suspended until the page gets a user
// gesture, and resume() outside a gesture is ignored. Resume on the first
// click/tap/key (calibrating with C or the button counts) so later alert
// beeps can actually play.
function unlockAudio() {
    if (audioCtx.state !== 'suspended') return;
    audioCtx.resume().then(() => {
        if (audioCtx.state === 'running') {
            ['pointerdown', 'keydown'].forEach(t => document.removeEventListener(t, unlockAudio, true));
        }
    }).catch(() => {});
}
['pointerdown', 'keydown'].forEach(t => document.addEventListener(t, unlockAudio, true));

function playAlertSound() {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    if (Date.now() - lastBeepTime < 5000) return;
    lastBeepTime = Date.now();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(300, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(600, audioCtx.currentTime + 0.1);
    gain.gain.setValueAtTime(0, audioCtx.currentTime);
    gain.gain.linearRampToValueAtTime(0.1, audioCtx.currentTime + 0.05);
    gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.3);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.3);
}

// --- Drawing ---
function setupCanvas(width, height) {
    if (canvasElement.width !== width || canvasElement.height !== height) {
        canvasElement.width = width;
        canvasElement.height = height;
        canvasCache.bgGrad = null;
    }
    const W = width, H = height;
    canvasCtx.save();
    canvasCtx.clearRect(0, 0, W, H);
    canvasCtx.translate(W, 0);
    canvasCtx.scale(-1, 1);
    return { W, H };
}

function drawBackground(image, W, H) {
    if (!isZenMode) {
        canvasCtx.drawImage(image, 0, 0, W, H);
        return;
    }
    if (!canvasCache.bgGrad) {
        canvasCache.bgGrad = canvasCtx.createRadialGradient(W/2, H/2, 0, W/2, H/2, W);
        canvasCache.bgGrad.addColorStop(0, '#18181b');
        canvasCache.bgGrad.addColorStop(1, '#050505');

        canvasCache.gridGrad = canvasCtx.createRadialGradient(W/2, H/2, 0, W/2, H/2, W/1.5);
        canvasCache.gridGrad.addColorStop(0, 'rgba(255,255,255,0.04)');
        canvasCache.gridGrad.addColorStop(1, 'rgba(255,255,255,0)');

        canvasCache.gridPath = new Path2D();
        for (let i = 0; i < W; i += 40) { canvasCache.gridPath.moveTo(i, 0); canvasCache.gridPath.lineTo(i, H); }
        for (let i = 0; i < H; i += 40) { canvasCache.gridPath.moveTo(0, i); canvasCache.gridPath.lineTo(W, i); }
    }
    canvasCtx.fillStyle = canvasCache.bgGrad;
    canvasCtx.fillRect(0, 0, W, H);
    canvasCtx.strokeStyle = canvasCache.gridGrad;
    canvasCtx.lineWidth = 1;
    canvasCtx.stroke(canvasCache.gridPath);
}

// --- Posture ---
function processPosture(lm, W, H) {
    const nose = lm[0], leftEar = lm[7], rightEar = lm[8], leftS = lm[11], rightS = lm[12];

    // visibility threshold filters hallucinations
    const shoulderVisible = leftS.visibility > CONFIG.VIS_THRESH && rightS.visibility > CONFIG.VIS_THRESH;
    const headVisible = nose.visibility > CONFIG.VIS_THRESH && leftEar.visibility > CONFIG.VIS_THRESH && rightEar.visibility > CONFIG.VIS_THRESH;

    if (shoulderVisible) {
        const rawAngle = shoulderAngle(leftS, rightS, W, H);
        if (calibrationCollecting()) calibrationData.shoulderAngle.push(rawAngle);

        const corrected = rawAngle - baselineShoulderAngle;
        smoothShoulderAngle = ema(smoothShoulderAngle, corrected, alphaFor(frameDt, CONFIG.SHOULDER_TAU_MS));
        alertStates.shoulder = Math.abs(smoothShoulderAngle) > CONFIG.THRESHOLDS.shoulder;
        updateMetric('m-shoulder', smoothShoulderAngle.toFixed(2) + "°", alertStates.shoulder, Math.abs(smoothShoulderAngle) / 8 * 100);
    } else {
        alertStates.shoulder = false;
        updateMetric('m-shoulder', "BLOCKED", false, 0);
    }

    let fwdExtra = 0;
    if (headVisible && shoulderVisible) {
        lastHeadRatio = headRatio(leftEar, rightEar, leftS, rightS);
        if (calibrationCollecting()) calibrationData.headRatio.push(lastHeadRatio);
        if (baselineHeadRatio > 0) {
            smoothHeadRatio = ema(smoothHeadRatio, lastHeadRatio, alphaFor(frameDt, CONFIG.SMOOTH_TAU_MS));
            const forwardRatio = smoothHeadRatio / baselineHeadRatio;
            alertStates.forward = forwardRatio > CONFIG.THRESHOLDS.forward;
            fwdExtra = Math.round((forwardRatio - 1) * 100);
            updateMetric('m-forward', alertStates.forward ? "+" + fwdExtra + "%" : "NORMAL", alertStates.forward, Math.max(0, forwardRatio - 1) / 0.30 * 100);
        } else updateMetric('m-forward', "NO CALIB", false, 0);
    } else {
        alertStates.forward = false;
        updateMetric('m-forward', "BLOCKED", false, 0);
    }

    drawHUDOverlays(W, H, leftS, rightS, nose, fwdExtra, shoulderVisible, headVisible);
}

function clearPosture() {
    alertStates.shoulder = alertStates.forward = false;
    updateMetric('m-shoulder', "BLOCKED", false, 0);
    updateMetric('m-forward', "BLOCKED", false, 0);
}

function drawHUDOverlays(W, H, leftS, rightS, nose, fwdExtra, shoulderVisible, headVisible) {
    if (shoulderVisible) {
        canvasCtx.beginPath();
        canvasCtx.moveTo(leftS.x * W, leftS.y * H);
        canvasCtx.lineTo(rightS.x * W, rightS.y * H);
        canvasCtx.lineWidth = 4;
        canvasCtx.strokeStyle = alertStates.shoulder ? accent(0.9) : green(0.4);
        canvasCtx.stroke();
    }

    const drawHUD = (text, x, y, isAlert) => {
        canvasCtx.save();
        canvasCtx.translate(x, y);
        canvasCtx.scale(-1, 1);
        canvasCtx.fillStyle = 'rgba(0,0,0,0.6)';
        canvasCtx.beginPath();
        canvasCtx.roundRect(-24, -14, 48, 20, 6);
        canvasCtx.fill();
        canvasCtx.fillStyle = isAlert ? ACCENT : GREEN;
        canvasCtx.font = 'bold 10px JetBrains Mono';
        canvasCtx.textAlign = 'center';
        canvasCtx.fillText(text, 0, 0);
        canvasCtx.restore();
    };

    if (shoulderVisible) drawHUD("S:" + Math.abs(smoothShoulderAngle).toFixed(0) + "°", leftS.x * W + 20, leftS.y * H - 15, alertStates.shoulder);
    if (headVisible && baselineHeadRatio > 0 && fwdExtra > 0) drawHUD("F:+" + fwdExtra + "%", nose.x * W, nose.y * H + 30, alertStates.forward);
}

// --- Calibration ---
function applyBaseline(b) {
    baselineHeadRatio = b.headRatio;
    smoothHeadRatio = baselineHeadRatio;
    baselineShoulderAngle = b.shoulderAngle;
    smoothShoulderAngle = 0;
}

// Storage can be unavailable (private window, blocked site data); the app
// then simply asks for calibration each time, as before.
function saveBaseline(b) {
    try { localStorage.setItem(CALIBRATION_STORE_KEY, serializeBaseline(b, Date.now())); } catch (e) {}
}

function restoreBaseline() {
    let text = null;
    try { text = localStorage.getItem(CALIBRATION_STORE_KEY); } catch (e) {}
    const saved = text && parseBaseline(text);
    if (!saved) return null;
    applyBaseline(saved.baseline);
    return saved.savedAt;
}

function calibrationCollecting() {
    return isCalibrating && frameNow - calibrationStartedAt < CONFIG.CALIBRATION_MS;
}

function handleCalibration(W, H) {
    if (!isCalibrating) return;
    if (calibrationCollecting()) {
        const timeLeft = Math.max(1, Math.ceil((CONFIG.CALIBRATION_MS - (frameNow - calibrationStartedAt)) / 1000));
        const btn = document.getElementById('calibrate-btn');
        if (btn) btn.innerText = `CALIBRATING (${timeLeft}s)...`;

        canvasCtx.save();
        canvasCtx.translate(W/2, H/2);
        canvasCtx.fillStyle = 'rgba(0,0,0,0.6)';
        canvasCtx.fillRect(-W/2, -H/2, W, H);
        canvasCtx.scale(-1, 1);
        canvasCtx.fillStyle = ACCENT;
        canvasCtx.font = 'bold 24px Inter';
        canvasCtx.textAlign = 'center';
        canvasCtx.fillText(`Calibrating... Keep still (${timeLeft}s)`, 0, 0);
        canvasCtx.restore();

        alertStates.shoulder = alertStates.forward = false;
    } else {
        isCalibrating = false;
        const baseline = {
            headRatio: median(calibrationData.headRatio),
            shoulderAngle: median(calibrationData.shoulderAngle)
        };
        applyBaseline(baseline);
        // Only keep a baseline that saw head and shoulders together;
        // otherwise forward-head has nothing to compare against.
        if (calibrationData.headRatio.length > 0) saveBaseline(baseline);
        else showToast('Head or shoulders not visible during calibration. Not saved.', 5000);

        const btn = document.getElementById('calibrate-btn');
        const sidebar = document.getElementById('sidebar');
        if (sidebar) sidebar.style.background = green(0.1);
        if (btn) {
            btn.innerText = "CALIBRATED ✓";
            btn.style.color = 'var(--neon-green)';
            btn.style.borderColor = 'var(--neon-green)';
            setTimeout(() => {
                if (sidebar) sidebar.style.background = '';
                btn.innerText = "Calibration (C)";
                btn.style.color = ''; btn.style.borderColor = '';
            }, 1000);
        }
    }
}

function calibrate() {
    if (isCalibrating) return;
    isCalibrating = true;
    calibrationStartedAt = performance.now();
    calibrationData = { headRatio: [], shoulderAngle: [] };

    const btn = document.getElementById('calibrate-btn');
    if (btn) {
        btn.innerText = "CALIBRATING (3s)...";
        btn.style.color = ACCENT;
        btn.style.borderColor = ACCENT;
    }
}

// --- Zen trail ---
const heatHistory = [];

function updateHeatmap(nose, leftS, rightS) {
    if (!nose || !leftS || !rightS) return;
    heatHistory.push({
        nose: { x: nose.x, y: nose.y },
        leftS: { x: leftS.x, y: leftS.y },
        rightS: { x: rightS.x, y: rightS.y },
        time: Date.now()
    });
    const cutoff = Date.now() - CONFIG.HEAT_WINDOW_MS;
    while (heatHistory.length && heatHistory[0].time < cutoff) heatHistory.shift();
}

function drawHeatmap(W, H) {
    if (!isZenMode || heatHistory.length < 5) return;

    const hasAlert = alertStates.shoulder || alertStates.forward;
    const color = hasAlert ? ACCENT_RGB : GREEN_RGB;

    canvasCtx.save();
    canvasCtx.globalCompositeOperation = 'screen';

    // Head range cloud: soft aura sized by how far the nose wandered
    let avgX = 0, avgY = 0;
    heatHistory.forEach(h => { avgX += h.nose.x; avgY += h.nose.y; });
    avgX /= heatHistory.length;
    avgY /= heatHistory.length;

    let maxDist = 0;
    heatHistory.forEach(h => {
        const d = Math.hypot(h.nose.x - avgX, h.nose.y - avgY);
        if (d > maxDist) maxDist = d;
    });

    const auraRadius = Math.max(20, maxDist * W * 1.5);
    const grad = canvasCtx.createRadialGradient(avgX * W, avgY * H, 0, avgX * W, avgY * H, auraRadius);
    grad.addColorStop(0, `rgba(${color}, 0.15)`);
    grad.addColorStop(0.5, `rgba(${color}, 0.05)`);
    grad.addColorStop(1, `rgba(${color}, 0)`);
    canvasCtx.fillStyle = grad;
    canvasCtx.fillRect(0, 0, W, H);

    // Shoulder movement range (soft ghosting)
    canvasCtx.lineWidth = 2;
    for (let i = 0; i < heatHistory.length; i += 5) {
        const pL = heatHistory[i].leftS;
        const pR = heatHistory[i].rightS;
        canvasCtx.strokeStyle = `rgba(${color}, ${(i / heatHistory.length) * 0.08})`;
        canvasCtx.beginPath();
        canvasCtx.moveTo(pL.x * W, pL.y * H);
        canvasCtx.lineTo(pR.x * W, pR.y * H);
        canvasCtx.stroke();
    }
    canvasCtx.restore();
}

function updateMetric(id, val, isAlert, pct) {
    if (!domCache[id]) {
        const el = document.getElementById(id);
        if (!el) return;
        domCache[id] = {
            el,
            valueEl: el.querySelector('.value'),
            gaugeEl: el.querySelector('.gauge-fill'),
            lastVal: null, lastAlert: null, lastPct: null
        };
    }
    const cache = domCache[id];

    if (cache.lastVal !== val) {
        cache.valueEl.innerText = val;
        cache.lastVal = val;
    }
    if (cache.lastAlert !== isAlert) {
        cache.el.classList.toggle('alert', isAlert);
        cache.lastAlert = isAlert;
    }
    if (cache.gaugeEl && pct !== undefined) {
        const newPct = Math.min(100, Math.max(0, pct)) + '%';
        if (cache.lastPct !== newPct) {
            cache.gaugeEl.style.width = newPct;
            cache.lastPct = newPct;
        }
    }

    const hasAnyAlert = alertStates.shoulder || alertStates.forward;
    if (document.body.classList.contains('alert-active') !== hasAnyAlert) {
        document.body.classList.toggle('alert-active', hasAnyAlert);
    }
}

// --- Frame ---
function onResults(results) {
    frameNow = performance.now();
    frameDt = lastFrameAt ? Math.min(CONFIG.MAX_FRAME_DT_MS, frameNow - lastFrameAt) : 1000 / 30;
    lastFrameAt = frameNow;
    const { W, H } = setupCanvas(results.width, results.height);
    drawBackground(results.image, W, H);

    const lm = results.poseLandmarks;
    if (lm) {
        updateHeatmap(lm[0], lm[11], lm[12]);
        drawHeatmap(W, H);
        processPosture(lm, W, H);
    } else {
        clearPosture();
    }
    handleCalibration(W, H);
    canvasCtx.restore();
}

// --- Model and camera ---
// MediaPipe Tasks Vision, pose only. Versions are pinned; the model path
// carries its own version (/float16/1/).
const TASKS_VERSION = '1.1.1';
const TASKS_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VERSION}`;
const POSE_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
let poseLandmarker = null;
let lastVideoTime = -1, lastDetectTs = 0;

async function loadModel() {
    const { FilesetResolver, PoseLandmarker } = await import(`${TASKS_BASE}/vision_bundle.mjs`);
    const fileset = await FilesetResolver.forVisionTasks(`${TASKS_BASE}/wasm`);
    // CPU: ~20 ms a frame for the lite model, and no GPU context to lose
    // when the tab is in the background.
    poseLandmarker = await PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate: 'CPU' },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5
    });
}

async function startCamera() {
    const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false
    });
    videoElement.srcObject = stream;
    await videoElement.play();
}

// Run the model on the current video frame, if there is a new one.
function detectFrame() {
    if (!poseLandmarker || videoElement.readyState < 2) return;
    if (videoElement.currentTime === lastVideoTime) return;
    lastVideoTime = videoElement.currentTime;
    const ts = Math.max(performance.now(), lastDetectTs + 1);  // VIDEO mode needs increasing timestamps
    lastDetectTs = ts;
    let result;
    try {
        result = poseLandmarker.detectForVideo(videoElement, ts);
    } catch (e) {
        console.error("Frame processing error:", e);
        return;
    }
    onResults({
        image: videoElement,
        width: videoElement.videoWidth,
        height: videoElement.videoHeight,
        poseLandmarks: result.landmarks[0] || null
    });
}

function frameLoop() {
    detectFrame();
    requestAnimationFrame(frameLoop);
}

async function startSystem() {
    const overlay = document.getElementById('loading-overlay');
    const loadingText = overlay.querySelector('.loading-text');

    try {
        loadingText.innerText = "Loading pose model...";
        await loadModel();

        loadingText.innerText = "Starting camera...";
        await startCamera().catch(err => {
            throw new Error("Camera access denied or failed: " + err.message);
        });
        frameLoop();

        overlay.classList.add('hidden');
        const savedAt = restoreBaseline();
        if (savedAt) {
            const when = new Date(savedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
            showToast(`Calibration from ${when} loaded. Press C if the camera moved.`, 5000);
        } else {
            showToast('Sit upright and press C to calibrate.', 5000);
        }
    } catch (err) {
        console.error("Initialization failed:", err);
        loadingText.innerHTML = `
            <div style="color: var(--accent); margin-bottom: 10px;">INITIALIZATION FAILED</div>
            <div style="font-size: 0.65rem; text-transform: none; margin-bottom: 20px; color: #a1a1aa; max-width: 250px;">${err.message}</div>
            <button class="btn" onclick="location.reload()" style="padding: 10px 20px;">RETRY</button>
        `;
    }
}

startSystem();

document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'c') calibrate();
});

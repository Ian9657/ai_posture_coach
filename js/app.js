const CONFIG = {
    VIS_THRESH: 0.85,
    // Smoothing time constants. v2.6.0 used per-frame alphas 0.15 / 0.10 at
    // 30 fps; these are the same smoothing expressed in milliseconds.
    SMOOTH_TAU_MS: 205,
    SHOULDER_TAU_MS: 316,
    THRESHOLDS: {
        shoulder: 4.5,
        rotation: 0.20,
        forward: 1.15,
        mouth: 1.12
    },
    RAMP_SEC: 30,
    CALIBRATION_MS: 3000,
    HEAT_WINDOW_MS: 5000,
    MAX_FRAME_DT_MS: 1000   // cap one frame's step after a stall or a hidden tab
};

const { ema, median, shoulderAngle, faceRotation, headRatio, lipDistance,
        freshCounters, scoreTick, analyzeSegment, alphaFor, createMouthTracker } = PostureCore;

const videoElement = document.getElementById('input_video');
const canvasElement = document.getElementById('output_canvas');
const canvasCtx = canvasElement.getContext('2d');

let baselineLipDist = 0, lastLipDist = 0;
let baselineHeadRatio = 0, lastHeadRatio = 0, smoothHeadRatio = 0;
let smoothShoulderAngle = 0, smoothFaceRotation = 0, smoothLipDist = 0;
const mouthTracker = createMouthTracker();
let frameNow = 0, frameDt = 1000 / 30, lastFrameAt = 0;
let calibrationStartedAt = 0;
let isCalibrating = false;
let calibrationData = { lipDist: [], headRatio: [], shoulderAngle: [], faceRotation: [] };
let baselineShoulderAngle = 0;
let baselineFaceRotation = 0;
let isZenMode = false;

const domCache = {};
const canvasCache = {
    width: 0, height: 0,
    bgGrad: null, gridGrad: null, gridPath: null
};

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
    b.style.background = isZenMode ? 'rgba(34, 197, 94, 0.15)' : '';
    b.style.color = isZenMode ? 'var(--neon-green)' : '';
    b.style.borderColor = isZenMode ? 'rgba(34, 197, 94, 0.3)' : '';
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
                btn.style.borderColor = 'rgba(34, 197, 94, 0.3)';
                btn.style.background = 'rgba(34, 197, 94, 0.15)';
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


// --- Cumulative Scoring ---
const WEIGHTS = { shoulder: 0.25, rotation: 0.25, forward: 0.3, mouth: 0.2 };
let consecutiveAlert = freshCounters();
let alertStates = { shoulder: false, rotation: false, forward: false, mouth: false };

// History stores raw values for segment analysis
const scoreHistory = [];
let chartWindowMin = 0;
let currentScore = 100;
let lastSampleTime = 0;

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
let lastBeepTime = 0;
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

function computeScore() {
    return scoreTick(consecutiveAlert, alertStates, WEIGHTS, CONFIG.RAMP_SEC);
}

// --- onResults Helpers ---
function setupCanvas(results) {
    if (canvasElement.width !== results.image.width || canvasElement.height !== results.image.height) {
        canvasElement.width = results.image.width;
        canvasElement.height = results.image.height;
        // Invalidate cache on resize
        canvasCache.bgGrad = null;
        canvasCache.width = canvasElement.width;
        canvasCache.height = canvasElement.height;
    }
    const W = canvasElement.width, H = canvasElement.height;
    canvasCtx.save();
    canvasCtx.clearRect(0, 0, W, H);
    canvasCtx.translate(W, 0);
    canvasCtx.scale(-1, 1);
    return { W, H };
}

function handleZenMode(results, W, H) {
    if (!isZenMode) {
        canvasCtx.drawImage(results.image, 0, 0, W, H);
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
        for(let i=0; i<W; i+=40) { canvasCache.gridPath.moveTo(i,0); canvasCache.gridPath.lineTo(i,H); }
        for(let i=0; i<H; i+=40) { canvasCache.gridPath.moveTo(0,i); canvasCache.gridPath.lineTo(W,i); }
    }

    canvasCtx.fillStyle = canvasCache.bgGrad;
    canvasCtx.fillRect(0, 0, W, H);
    canvasCtx.strokeStyle = canvasCache.gridGrad;
    canvasCtx.lineWidth = 1;
    canvasCtx.stroke(canvasCache.gridPath);
    
    // Note: Aura/Heatmap is now handled by drawHeatmap for better range visualization
}

function processPosture(results, W, H) {
    if (!results.poseLandmarks) return { mouthVisible: false };
    const lm = results.poseLandmarks;
    const nose = lm[0], leftEar = lm[7], rightEar = lm[8], leftS = lm[11], rightS = lm[12];
    const mouthL = lm[9], mouthR = lm[10];
    
    // visibility threshold filters hallucinations
    const shoulderVisible = leftS.visibility > CONFIG.VIS_THRESH && rightS.visibility > CONFIG.VIS_THRESH;
    const faceVisible = !!results.faceLandmarks && nose.visibility > CONFIG.VIS_THRESH && leftEar.visibility > CONFIG.VIS_THRESH && rightEar.visibility > CONFIG.VIS_THRESH;
    const poseMouthUnoccluded = mouthL.visibility > CONFIG.VIS_THRESH && mouthR.visibility > CONFIG.VIS_THRESH;
    
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
    
    if (faceVisible) {
        let rawRotation = faceRotation(nose, leftEar, rightEar);
        if (calibrationCollecting()) calibrationData.faceRotation.push(rawRotation);
        
        rawRotation -= baselineFaceRotation;
        smoothFaceRotation = ema(smoothFaceRotation, rawRotation, alphaFor(frameDt, CONFIG.SMOOTH_TAU_MS));
        alertStates.rotation = Math.abs(smoothFaceRotation) > CONFIG.THRESHOLDS.rotation;
        updateMetric('m-rotation', (smoothFaceRotation > 0 ? "R " : "L ") + Math.abs(smoothFaceRotation).toFixed(2), alertStates.rotation, Math.abs(smoothFaceRotation) / 0.4 * 100);
    } else {
        alertStates.rotation = false;
        updateMetric('m-rotation', "BLOCKED", false, 0);
    }

    let fwdExtra = 0;
    if (faceVisible && shoulderVisible) {
        lastHeadRatio = headRatio(leftEar, rightEar, leftS, rightS);
        if (baselineHeadRatio > 0) {
            smoothHeadRatio = ema(smoothHeadRatio, lastHeadRatio, alphaFor(frameDt, CONFIG.SMOOTH_TAU_MS));
            const forwardRatio = smoothHeadRatio / baselineHeadRatio;
            alertStates.forward = forwardRatio > CONFIG.THRESHOLDS.forward;
            fwdExtra = Math.round((forwardRatio-1)*100);
            updateMetric('m-forward', alertStates.forward ? "+" + fwdExtra + "%" : "NORMAL", alertStates.forward, Math.max(0, forwardRatio - 1) / 0.30 * 100);
        } else updateMetric('m-forward', "NO CALIB", false, 0);
    } else {
        alertStates.forward = false;
        updateMetric('m-forward', "BLOCKED", false, 0);
    }

    drawHUDOverlays(W, H, leftS, rightS, nose, leftEar, rightEar, fwdExtra, shoulderVisible, faceVisible);
    return { mouthVisible: poseMouthUnoccluded };
}

function drawHUDOverlays(W, H, leftS, rightS, nose, leftEar, rightEar, fwdExtra, shoulderVisible, faceVisible) {
    if (shoulderVisible) {
        canvasCtx.beginPath();
        canvasCtx.moveTo(leftS.x * W, leftS.y * H);
        canvasCtx.lineTo(rightS.x * W, rightS.y * H);
        canvasCtx.lineWidth = 4;
        canvasCtx.strokeStyle = alertStates.shoulder ? 'rgba(249, 115, 22, 0.9)' : 'rgba(34, 197, 94, 0.4)';
        canvasCtx.stroke();
    }

    let faceCenterX = 0, faceCenterY = 0;
    if (faceVisible) {
        faceCenterX = (leftEar.x + rightEar.x) / 2 * W;
        faceCenterY = (leftEar.y + rightEar.y) / 2 * H;
        canvasCtx.beginPath();
        canvasCtx.moveTo(nose.x * W, nose.y * H);
        canvasCtx.lineTo(faceCenterX, faceCenterY);
        canvasCtx.lineWidth = 3;
        canvasCtx.strokeStyle = alertStates.rotation ? 'rgba(249, 115, 22, 0.9)' : 'rgba(34, 197, 94, 0.4)';
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
        canvasCtx.fillStyle = isAlert ? '#f97316' : '#22c55e';
        canvasCtx.font = 'bold 10px JetBrains Mono';
        canvasCtx.textAlign = 'center';
        canvasCtx.fillText(text, 0, 0);
        canvasCtx.restore();
    };

    if (shoulderVisible) drawHUD("S:" + Math.abs(smoothShoulderAngle).toFixed(0) + "°", leftS.x * W + 20, leftS.y * H - 15, alertStates.shoulder);
    if (faceVisible) {
        const rotDir = smoothFaceRotation > 0 ? "R:" : "L:";
        drawHUD(rotDir + Math.abs(smoothFaceRotation).toFixed(2), faceCenterX, faceCenterY - 30, alertStates.rotation);
        if (baselineHeadRatio > 0 && fwdExtra > 0) drawHUD("F:+" + fwdExtra + "%", nose.x * W, nose.y * H + 30, alertStates.forward);
    }
}

function processMouth(results, W, H, poseMouthUnoccluded) {
    if (!results.faceLandmarks) {
        mouthTracker.reset();
        alertStates.mouth = false; updateMetric('m-jaw', "NO FACE", false);
        return;
    }
    const face = results.faceLandmarks;
    const upperLip = face[13], lowerLip = face[14], forehead = face[10], chin = face[152];
    lastLipDist = lipDistance(upperLip, lowerLip, forehead, chin);
    const isVisible = upperLip.x >= 0 && upperLip.x <= 1 && upperLip.y >= 0 && upperLip.y <= 1 && poseMouthUnoccluded;

    if (baselineLipDist > 0 && isVisible) {
        const ratio = lastLipDist / baselineLipDist;
        smoothLipDist = ema(smoothLipDist, lastLipDist, alphaFor(frameDt, CONFIG.SMOOTH_TAU_MS));
        const smoothedMouthOpen = (smoothLipDist / baselineLipDist) > CONFIG.THRESHOLDS.mouth;
        const mouth = mouthTracker.step(frameNow, frameDt, ratio, smoothedMouthOpen);

        alertStates.mouth = mouth.alert;
        if (mouth.state === "TALKING") updateMetric('m-jaw', "TALKING", false);
        else if (mouth.state === "OPEN") updateMetric('m-jaw', "OPEN " + Math.floor(mouth.openMs / 1000) + "s", alertStates.mouth);
        else updateMetric('m-jaw', "CLOSED", false);
    } else {
        mouthTracker.reset();
        updateMetric('m-jaw', isVisible ? "NO CALIB" : "BLOCKED", false);
    }
    
    canvasCtx.fillStyle = '#f97316';
    [face[13], face[14]].forEach(p => {
        canvasCtx.beginPath();
        canvasCtx.arc(p.x * W, p.y * H, 3, 0, 2 * Math.PI);
        canvasCtx.fill();
    });
}

function calibrationCollecting() {
    return isCalibrating && frameNow - calibrationStartedAt < CONFIG.CALIBRATION_MS;
}

function handleCalibration(results, W, H) {
    if (!isCalibrating) return;
    if (calibrationCollecting()) {
        if (lastLipDist > 0) calibrationData.lipDist.push(lastLipDist);
        if (lastHeadRatio > 0) calibrationData.headRatio.push(lastHeadRatio);

        const timeLeft = Math.max(1, Math.ceil((CONFIG.CALIBRATION_MS - (frameNow - calibrationStartedAt)) / 1000));
        const btn = document.getElementById('calibrate-btn');
        if (btn) btn.innerText = `CALIBRATING (${timeLeft}s)...`;
        
        canvasCtx.save();
        canvasCtx.translate(W/2, H/2);
        canvasCtx.fillStyle = 'rgba(0,0,0,0.6)';
        canvasCtx.fillRect(-W/2, -H/2, W, H);
        canvasCtx.scale(-1, 1);
        canvasCtx.fillStyle = '#f97316';
        canvasCtx.font = 'bold 24px Inter';
        canvasCtx.textAlign = 'center';
        canvasCtx.fillText(`Calibrating... Keep still (${timeLeft}s)`, 0, 0);
        canvasCtx.restore();
        
        alertStates.shoulder = alertStates.rotation = alertStates.forward = alertStates.mouth = false;
    } else {
        isCalibrating = false;
        baselineLipDist = median(calibrationData.lipDist);
        smoothLipDist = baselineLipDist;
        baselineHeadRatio = median(calibrationData.headRatio);
        smoothHeadRatio = baselineHeadRatio;
        baselineShoulderAngle = median(calibrationData.shoulderAngle);
        smoothShoulderAngle = 0;
        baselineFaceRotation = median(calibrationData.faceRotation);
        smoothFaceRotation = 0;
        
        mouthTracker.reset();
        consecutiveAlert = freshCounters();
        scoreHistory.length = 0;
        lastSampleTime = Date.now();
        
        const btn = document.getElementById('calibrate-btn');
        const sidebar = document.getElementById('sidebar');
        if (sidebar) sidebar.style.background = 'rgba(34, 197, 94, 0.1)';
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

function updateAppScore() {
    if (isCalibrating) return;
    const now = Date.now();
    if (chartWindowMin > 0 && now - lastSampleTime >= 1000) {
        lastSampleTime = now;
        currentScore = computeScore();
        scoreHistory.push({
            t: now, score: currentScore,
            shoulder: smoothShoulderAngle,
            rotation: smoothFaceRotation,
            forwardAlert: alertStates.forward,
            mouthAlert: alertStates.mouth
        });
        const cutoff = now - chartWindowMin * 60 * 1000;
        while (scoreHistory.length > 0 && scoreHistory[0].t < cutoff) scoreHistory.shift();
        
        const el = document.getElementById('current-score');
        el.innerText = currentScore;
        el.style.color = currentScore >= 70 ? '#22c55e' : currentScore >= 40 ? '#f97316' : '#ef4444';
        if (currentScore < 40) playAlertSound();
        drawChart();
    }
}

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
    
    const hasAlert = alertStates.shoulder || alertStates.rotation || alertStates.forward || alertStates.mouth;
    const color = hasAlert ? '249, 115, 22' : '16, 185, 129';
    
    canvasCtx.save();
    canvasCtx.globalCompositeOperation = 'screen';

    // Head Range Cloud
    // Calculate center and variance for a soft aura
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

    // Shoulder Movement Range (Soft Ghosting)
    canvasCtx.lineWidth = 2;
    for (let i = 0; i < heatHistory.length; i += 5) {
        const pL = heatHistory[i].leftS;
        const pR = heatHistory[i].rightS;
        const alpha = (i / heatHistory.length) * 0.08;
        canvasCtx.strokeStyle = `rgba(${color}, ${alpha})`;
        canvasCtx.beginPath();
        canvasCtx.moveTo(pL.x * W, pL.y * H);
        canvasCtx.lineTo(pR.x * W, pR.y * H);
        canvasCtx.stroke();
    }
    canvasCtx.restore();
}

function onResults(results) {
    frameNow = performance.now();
    frameDt = lastFrameAt ? Math.min(CONFIG.MAX_FRAME_DT_MS, frameNow - lastFrameAt) : 1000 / 30;
    lastFrameAt = frameNow;
    const { W, H } = setupCanvas(results);
    handleZenMode(results, W, H);
    
    const lm = results.poseLandmarks;
    if (lm) {
        updateHeatmap(lm[0], lm[11], lm[12]);
        if (isZenMode) drawHeatmap(W, H);
    }

    const { mouthVisible } = processPosture(results, W, H);
    processMouth(results, W, H, mouthVisible);
    handleCalibration(results, W, H);
    canvasCtx.restore();
    updateAppScore();
}

// --- Chart ---
const chartCanvas = document.getElementById('chart_canvas');
const chartCtx = chartCanvas.getContext('2d');

function setChartWindow(min, btn) {
    if (chartWindowMin === min) return;
    chartWindowMin = min;
    document.querySelectorAll('.time-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    
    // Restart assessment
    scoreHistory.length = 0;
    consecutiveAlert = freshCounters();
    document.getElementById('current-score').innerText = min === 0 ? '--' : '100';
    document.getElementById('current-score').style.color = '#22c55e';
    
    drawChart();
}

function drawChart() {
    const dpr = window.devicePixelRatio || 1;
    const rect = chartCanvas.getBoundingClientRect();
    chartCanvas.width = rect.width * dpr;
    chartCanvas.height = rect.height * dpr;
    chartCtx.scale(dpr, dpr);
    const W = rect.width, H = rect.height;
    const chartTop = 0, chartH = H - 28; // reserve bottom for segment labels

    chartCtx.clearRect(0, 0, W, H);

    if (chartWindowMin === 0) {
        chartCtx.fillStyle = '#333';
        chartCtx.font = '10px JetBrains Mono';
        chartCtx.fillText('Assessment OFF', W / 2 - 40, H / 2);
        return;
    }

    const now = Date.now();
    const windowMs = chartWindowMin * 60 * 1000;
    const windowStart = now - windowMs;
    const data = scoreHistory.filter(d => d.t >= windowStart);

    if (data.length < 2) {
        chartCtx.fillStyle = '#333';
        chartCtx.font = '10px JetBrains Mono';
        chartCtx.fillText('Collecting data...', W / 2 - 45, H / 2);
        return;
    }

    // Grid
    chartCtx.strokeStyle = '#1a1a1a';
    chartCtx.lineWidth = 1;
    for (let y = 0; y <= 100; y += 25) {
        const py = chartTop + chartH - (y / 100) * chartH;
        chartCtx.beginPath();
        chartCtx.moveTo(0, py);
        chartCtx.lineTo(W, py);
        chartCtx.stroke();
    }

    // 70-line
    chartCtx.strokeStyle = '#333';
    chartCtx.setLineDash([3, 3]);
    const threshY = chartTop + chartH - (70 / 100) * chartH;
    chartCtx.beginPath();
    chartCtx.moveTo(0, threshY);
    chartCtx.lineTo(W, threshY);
    chartCtx.stroke();
    chartCtx.setLineDash([]);

    // Alert zones
    for (let i = 1; i < data.length; i++) {
        if (data[i].score < 70) {
            const x = ((data[i].t - windowStart) / windowMs) * W;
            const prevX = ((data[i - 1].t - windowStart) / windowMs) * W;
            chartCtx.fillStyle = 'rgba(249, 115, 22, 0.06)';
            chartCtx.fillRect(prevX, chartTop, x - prevX, chartH);
        }
    }

    // Score line
    chartCtx.beginPath();
    for (let i = 0; i < data.length; i++) {
        const x = ((data[i].t - windowStart) / windowMs) * W;
        const y = chartTop + chartH - (data[i].score / 100) * chartH;
        if (i === 0) chartCtx.moveTo(x, y);
        else chartCtx.lineTo(x, y);
    }
    chartCtx.strokeStyle = '#22c55e';
    chartCtx.lineWidth = 1.5;
    chartCtx.stroke();

    // Gradient fill
    const grad = chartCtx.createLinearGradient(0, chartTop, 0, chartTop + chartH);
    grad.addColorStop(0, 'rgba(34, 197, 94, 0.12)');
    grad.addColorStop(1, 'rgba(34, 197, 94, 0)');
    chartCtx.lineTo(((data[data.length - 1].t - windowStart) / windowMs) * W, chartTop + chartH);
    chartCtx.lineTo(((data[0].t - windowStart) / windowMs) * W, chartTop + chartH);
    chartCtx.closePath();
    chartCtx.fillStyle = grad;
    chartCtx.fill();

    // --- 1/5 Segment Analysis ---
    const segments = [];
    for (let i = 0; i < 5; i++) {
        const segStart = windowStart + (windowMs * i) / 5;
        const segEnd = windowStart + (windowMs * (i + 1)) / 5;
        segments.push(data.filter(d => d.t >= segStart && d.t < segEnd));
    }

    // Draw vertical dividers
    for (let i = 1; i <= 4; i++) {
        const x = (i / 5) * W;
        chartCtx.strokeStyle = '#2a2a2a';
        chartCtx.setLineDash([2, 2]);
        chartCtx.beginPath();
        chartCtx.moveTo(x, chartTop);
        chartCtx.lineTo(x, chartTop + chartH);
        chartCtx.stroke();
        chartCtx.setLineDash([]);
    }

    // Draw segment labels at bottom
    chartCtx.font = '6.5px JetBrains Mono';
    for (let i = 0; i < 5; i++) {
        const seg = analyzeSegment(segments[i]);
        if (!seg || segments[i].length < 2) continue;
        const xStart = (i / 5) * W + 2;
        const y = chartTop + chartH + 10;
        const color = seg.avgScore >= 70 ? '#22c55e' : seg.avgScore >= 40 ? '#f97316' : '#ef4444';
        chartCtx.fillStyle = '#444';
        chartCtx.fillText('S' + seg.avgShoulder.toFixed(0) + '° R' + seg.avgRotation.toFixed(2), xStart, y);
        chartCtx.fillStyle = color;
        chartCtx.fillText('F' + seg.fwdPct + '% M' + seg.mouthPct + '% ⌀' + seg.avgScore, xStart, y + 10);
    }
}

function updateMetric(id, val, isAlert, pct) {
    if (!domCache[id]) {
        const el = document.getElementById(id);
        if (!el) return;
        domCache[id] = {
            el,
            valueEl: el.querySelector('.value'),
            gaugeEl: el.querySelector('.gauge-fill'),
            lastVal: null,
            lastAlert: null,
            lastPct: null
        };
    }
    
    const cache = domCache[id];
    
    if (cache.lastVal !== val) {
        cache.valueEl.innerText = val;
        cache.lastVal = val;
    }
    
    if (cache.lastAlert !== isAlert) {
        if (isAlert) {
            cache.el.classList.add('alert');
            cache.valueEl.style.color = '#f97316';
        } else {
            cache.el.classList.remove('alert');
            cache.valueEl.style.color = '#22c55e';
        }
        cache.lastAlert = isAlert;
    }
    
    if (cache.gaugeEl && pct !== undefined) {
        const newPct = Math.min(100, Math.max(0, pct)) + '%';
        if (cache.lastPct !== newPct) {
            cache.gaugeEl.style.width = newPct;
            cache.lastPct = newPct;
        }
    }
    
    const hasAnyAlert = alertStates.shoulder || alertStates.rotation || alertStates.forward || alertStates.mouth;
    if (document.body.classList.contains('alert-active') !== hasAnyAlert) {
        document.body.classList.toggle('alert-active', hasAnyAlert);
    }
}

function calibrate() {
    if (isCalibrating) return;
    isCalibrating = true;
    calibrationStartedAt = performance.now();
    calibrationData = { lipDist: [], headRatio: [], shoulderAngle: [], faceRotation: [] };
    
    const btn = document.getElementById('calibrate-btn');
    if (btn) {
        btn.innerText = "CALIBRATING (3s)...";
        btn.style.color = '#f97316';
        btn.style.borderColor = '#f97316';
    }
}

if (typeof Holistic === 'undefined') {
    alert("Script failed to load. Check network.");
}

// Must match the holistic.js version in index.html.
const HOLISTIC_VERSION = '0.5.1675471629';
const holistic = new Holistic({ locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/holistic@${HOLISTIC_VERSION}/${file}` });
holistic.setOptions({
    modelComplexity: 0,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
    refineFaceLandmarks: false
});
holistic.onResults(onResults);

async function startSystem() {
    const overlay = document.getElementById('loading-overlay');
    const loadingText = overlay.querySelector('.loading-text');
    
    try {
        // 1. 初始化 AI 模型
        loadingText.innerText = "Initializing AI Models...";
        await holistic.initialize();
        console.log("Holistic Initialized");
        
        // 2. 准备相机
        loadingText.innerText = "Starting Camera...";
        const camera = new Camera(videoElement, {
            onFrame: async () => { 
                try {
                    await holistic.send({image: videoElement}); 
                } catch(e) {
                    console.error("Frame processing error:", e);
                }
            },
            width: { ideal: 640 },
            height: { ideal: 480 },
            facingMode: 'user'
        });

        // 3. 启动相机
        await camera.start().catch(err => {
            throw new Error("Camera access denied or failed: " + err.message);
        });

        // 4. 全部准备好后再关闭 Loading
        overlay.classList.add('hidden');
        showToast('AI Systems Online');
        
    } catch (err) {
        console.error("Initialization failed:", err);
        loadingText.innerHTML = `
            <div style="color: #f97316; margin-bottom: 10px;">INITIALIZATION FAILED</div>
            <div style="font-size: 0.65rem; text-transform: none; margin-bottom: 20px; color: #a1a1aa; max-width: 250px;">${err.message}</div>
            <button class="btn" onclick="location.reload()" style="padding: 10px 20px;">RETRY</button>
        `;
    }
}

// 启动系统
startSystem();

document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'c') calibrate();
});

setTimeout(drawChart, 100);

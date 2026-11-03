# DECISIONS.md

Why the numbers are what they are. When a threshold, weight or feature changes, update this file in the same commit and add a line to the log at the bottom.

Status key: **inherited** = came from the original Antigravity build (v2.6.0) and has not been measured; **tested** = checked against recordings or unit tests; **decided** = owner's product choice.

---

## Pipeline

MediaPipe Tasks Vision `PoseLandmarker`, lite model, CPU delegate, VIDEO mode, confidences 0.5, on a 640×480 front camera. Holistic (v2.6) was replaced because only the face mesh needed it, it is no longer maintained, and on the same machine it took ~250 ms a frame against ~20 ms. Only pose landmarks are used: nose (0), ears (7, 8) and shoulders (11, 12).

A landmark only counts when its `visibility` exceeds **0.85** (`CONFIG.VIS_THRESH`, inherited). Below that the metric shows `BLOCKED` and does not alert, so a hand in front of the face cannot raise an alarm. With no pose at all both metrics read `BLOCKED`.

All metrics are relative to a **calibration baseline**: the median of each raw value over 3 s (`CALIBRATION_MS`) while the user sits upright. Median rather than mean, so a single bad frame does not shift the baseline.

The baseline is saved in `localStorage` (`posture-core.calibration`, format version 1) and restored on the next visit, so the app works without recalibrating (#5). It is saved only when face and shoulders were visible together during calibration; a missing, malformed or other-version entry is ignored. Press C again whenever the camera or chair moves.

## Model comparison (2026-11-03)

Measured in headless Chrome, fake camera fed with a still portrait (Google's `mediapipe-assets/portrait.jpg`) at 640×480, each model calibrated on the upright frame:

| Scene | Holistic (v2.6) | PoseLandmarker lite |
|---|---|---|
| upright again | head ratio −1.8% | +0.8% |
| whole body 15% smaller (sitting back) | **−9.2%** | −1.5% |
| image rotated 8° | shoulders −0.6° (missed) | −6.9° (alert) |
| head region enlarged 8% / 15% | +5.9% / +2.5% | 0% / −0.9% |

The last row says the paste-a-bigger-head trick is not a valid forward-lean stand-in for either model; real forward lean still has to be checked on camera (owner saw +9% with Holistic). On distance and tilt the new model is clearly better: with Holistic, sitting back could cancel most of the 8% forward-head threshold.

## Timing

Everything is driven by elapsed time, not frame counts (#14), so the behaviour is the same at 30 fps and at the lower rates planned for background use. Smoothing is an EMA with weight `1 − exp(−dt/τ)`; the time constants τ were derived from v2.6.0's per-frame alphas (0.15 → 205 ms, 0.10 → 316 ms at 30 fps), so at 30 fps nothing changes. A single frame step is capped at 1 s so a stall or hidden tab cannot jump the smoothed values.

## Metrics

| Metric | Raw value | Smoothing | Alert when | Gauge full at | Status |
|---|---|---|---|---|---|
| Shoulders | angle of the shoulder line in pixels, minus baseline | EMA τ 316 ms | \|angle\| > 4.5° | 8° | inherited |
| Forward head | (ear span / shoulder span) ÷ baseline | EMA τ 205 ms | ratio > 1.08 | 1.30 | decided |

Notes:

- **Shoulder angle** is computed in pixels, not normalised units, so a non-square frame does not distort it. Shoulders get a slower EMA because shoulder landmarks jitter more than face landmarks.
- **Forward head** works because the head is closer to the camera than the shoulders: leaning the head forward enlarges the ear span more than the shoulder span, while moving the whole body closer scales both and leaves the ratio unchanged (covered by `test/core.test.js`). Known blind spots, not yet measured: turning the head shrinks the ear span and can hide a forward lean; looking down at a phone changes the ear span very little.

## Scope (#16)

The tool is meant to run in the background and speak up when posture drifts, so it measures only what is a posture problem and can be trusted from a desk camera:

- **Kept**: forward head, shoulder tilt, calibration, Zen view, PiP.
- **Removed in v3**: mouth detection (a camera sees parted lips, not mouth breathing, and it was the only reason to run the face mesh, the most expensive part of Holistic); face rotation as a metric (looking at a second monitor is not bad posture; `faceRotation()` stays in core for correcting the ear span later); the weighted score, chart and segment table (two metrics need no weighted score, and nobody watches a chart while the page is in the background); decorative text (LIVE badge, startup toast, weights footer).

Everything removed is in tag `v2.6.0`.

---

## Log

- 2026-11-03: file created; all values recorded as inherited from v2.6.0.
- 2026-11-03: #13 fixed. In v2.6.0 every chart-window click reset the counters without `forward`, so the score read NaN until the next calibration.
- 2026-11-03: #14 fixed. Frame counts became milliseconds and per-frame alphas became time constants. Measured in headless Chrome at a low frame rate: v2.6.0's "3 s" calibration took 12.3 s, now 3.2 s.
- 2026-11-03: #5. Calibration persists across visits.
- 2026-11-03: forward-head threshold 1.15 → 1.08. Owner tested: 1.15 was too lenient; leaning to the point that already felt like bad posture read +9%. 1.15 needs roughly 8 cm of forward head at 60 cm from the camera.
- 2026-11-03: #16. Removed mouth, face rotation, score/chart and decorative text. Calibration saves only head ratio and shoulder angle; v1 saves from v2.6 still load (extra keys ignored).
- 2026-11-03: Holistic → PoseLandmarker lite (tasks-vision 1.1.1). camera_utils replaced by getUserMedia + own frame loop. See the comparison table.

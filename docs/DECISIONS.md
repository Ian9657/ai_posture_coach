# DECISIONS.md

Why the numbers are what they are. When a threshold, weight or feature changes, update this file in the same commit and add a line to the log at the bottom.

Status key: **inherited** = came from the original Antigravity build (v2.6.0) and has not been measured; **tested** = checked against recordings or unit tests; **decided** = owner's product choice.

---

## Pipeline

MediaPipe Holistic (`modelComplexity: 0`, detection/tracking confidence 0.5, no refined face landmarks) on a 640×480 front camera. Pose landmarks give shoulders, nose, ears and mouth corners; the face mesh is used only for the lips (13, 14), forehead (10) and chin (152).

A landmark only counts when its `visibility` exceeds **0.85** (`CONFIG.VIS_THRESH`, inherited). Below that the metric shows `BLOCKED` and does not alert, so a hand in front of the face cannot raise an alarm.

All metrics are relative to a **calibration baseline**: the median of each raw value over 3 s (`CALIBRATION_MS`) while the user sits upright. Median rather than mean, so a single bad frame does not shift the baseline.

The baseline is saved in `localStorage` (`posture-core.calibration`, format version 1) and restored on the next visit, so the app works without recalibrating (#5). It is saved only when face and shoulders were visible together during calibration; a missing, malformed or other-version entry is ignored. Press C again whenever the camera or chair moves.

## Timing

Everything is driven by elapsed time, not frame counts (#14), so the behaviour is the same at 30 fps and at the lower rates planned for background use. Smoothing is an EMA with weight `1 − exp(−dt/τ)`; the time constants τ were derived from v2.6.0's per-frame alphas (0.15 → 205 ms, 0.10 → 316 ms at 30 fps), so at 30 fps nothing changes. A single frame step is capped at 1 s so a stall or hidden tab cannot jump the smoothed values.

## Metrics

| Metric | Raw value | Smoothing | Alert when | Gauge full at | Status |
|---|---|---|---|---|---|
| Shoulders | angle of the shoulder line in pixels, minus baseline | EMA τ 316 ms | \|angle\| > 4.5° | 8° | inherited |
| Face rotation | (dL − dR)/(dL + dR), horizontal nose-to-ear distances, minus baseline | EMA τ 205 ms | \|value\| > 0.20 | 0.40 | inherited |
| Forward head | (ear span / shoulder span) ÷ baseline | EMA τ 205 ms | ratio > 1.08 | 1.30 | decided |
| Mouth | lip gap / face height ÷ baseline | EMA τ 205 ms | open for > 5 s | — | inherited |

Notes:

- **Shoulder angle** is computed in pixels, not normalised units, so a non-square frame does not distort it. Shoulders get a slower EMA because shoulder landmarks jitter more than face landmarks.
- **Forward head** works because the head is closer to the camera than the shoulders: leaning the head forward enlarges the ear span more than the shoulder span, while moving the whole body closer scales both and leaves the ratio unchanged (covered by `test/core.test.js`). Known blind spots, not yet measured: turning the head shrinks the ear span and can hide a forward lean; looking down at a phone changes the ear span very little.
- **Mouth** uses hysteresis on the raw ratio (opens above 1.14×, closes below 1.06×) to stop flicker. Three or more open/closed changes within the last 1 s is treated as talking and suppresses the alert for 1 s. Closed time drains the open timer 5× faster than open time fills it. The label "Mouth Breathing" overstates what a camera can see; see #16.

## Score

Updated once per second while the chart window is on. Each metric keeps a counter: +1 per second in alert, −0.5 per second out of alert (two seconds of good posture undo one bad second), capped at 30 (`RAMP_SEC`).

`score = round(100 × (1 − Σ weight × counter / 30))`

Weights (inherited): shoulders 0.25, rotation 0.25, forward head 0.30, mouth 0.20. Forward head has the largest weight because it is the main posture problem the tool targets. Colour bands: ≥ 70 green, ≥ 40 orange, below 40 red plus a beep (at most every 5 s).

---

## Log

- 2026-11-03: file created; all values recorded as inherited from v2.6.0.
- 2026-11-03: #13 fixed. In v2.6.0 every chart-window click reset the counters without `forward`, so the score read NaN until the next calibration.
- 2026-11-03: #14 fixed. Frame counts became milliseconds and per-frame alphas became time constants. Measured in headless Chrome at a low frame rate: v2.6.0's "3 s" calibration took 12.3 s, now 3.2 s.
- 2026-11-03: #5. Calibration persists across visits.
- 2026-11-03: forward-head threshold 1.15 → 1.08. Owner tested: 1.15 was too lenient; leaning to the point that already felt like bad posture read +9%. 1.15 needs roughly 8 cm of forward head at 60 cm from the camera.

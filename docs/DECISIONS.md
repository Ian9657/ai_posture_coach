# DECISIONS.md

Why the numbers are what they are. When a threshold, weight or feature changes, update this file in the same commit and add a line to the log at the bottom.

Status key: **inherited** = came from the original Antigravity build (v2.6.0) and has not been measured; **tested** = checked against recordings or unit tests; **decided** = owner's product choice.

---

## Pipeline

MediaPipe Holistic (`modelComplexity: 0`, detection/tracking confidence 0.5, no refined face landmarks) on a 640×480 front camera. Pose landmarks give shoulders, nose, ears and mouth corners; the face mesh is used only for the lips (13, 14), forehead (10) and chin (152).

A landmark only counts when its `visibility` exceeds **0.85** (`CONFIG.VIS_THRESH`, inherited). Below that the metric shows `BLOCKED` and does not alert, so a hand in front of the face cannot raise an alarm.

All metrics are relative to a **calibration baseline**: the median of each raw value over 90 frames (~3 s at 30 fps) while the user sits upright. Median rather than mean, so a single bad frame does not shift the baseline.

## Metrics

| Metric | Raw value | Smoothing | Alert when | Gauge full at | Status |
|---|---|---|---|---|---|
| Shoulders | angle of the shoulder line in pixels, minus baseline | EMA α 0.10 | \|angle\| > 4.5° | 8° | inherited |
| Face rotation | (dL − dR)/(dL + dR), horizontal nose-to-ear distances, minus baseline | EMA α 0.15 | \|value\| > 0.20 | 0.40 | inherited |
| Forward head | (ear span / shoulder span) ÷ baseline | EMA α 0.15 | ratio > 1.15 | 1.30 | inherited |
| Mouth | lip gap / face height ÷ baseline | EMA α 0.15 | open for > 150 frames (~5 s) | — | inherited |

Notes:

- **Shoulder angle** is computed in pixels, not normalised units, so a non-square frame does not distort it. Shoulders get a slower EMA (0.10) because shoulder landmarks jitter more than face landmarks.
- **Forward head** works because the head is closer to the camera than the shoulders: leaning the head forward enlarges the ear span more than the shoulder span, while moving the whole body closer scales both and leaves the ratio unchanged (covered by `test/core.test.js`). Known blind spots, not yet measured: turning the head shrinks the ear span and can hide a forward lean; looking down at a phone changes the ear span very little.
- **Mouth** uses hysteresis on the raw ratio (opens above 1.14×, closes below 1.06×) to stop flicker. Three or more open/closed changes within the last 30 frames is treated as talking and suppresses the alert for 30 frames. The label "Mouth Breathing" overstates what a camera can see; see #16.

## Score

Updated once per second while the chart window is on. Each metric keeps a counter: +1 per second in alert, −0.5 per second out of alert (two seconds of good posture undo one bad second), capped at 30 (`RAMP_SEC`).

`score = round(100 × (1 − Σ weight × counter / 30))`

Weights (inherited): shoulders 0.25, rotation 0.25, forward head 0.30, mouth 0.20. Forward head has the largest weight because it is the main posture problem the tool targets. Colour bands: ≥ 70 green, ≥ 40 orange, below 40 red plus a beep (at most every 5 s).

## Known issues behind these numbers

- Frame-count timings (90 calibration frames, 150 mouth frames, 30-frame talking window) assume 30 fps and stretch on slower machines: #14.

---

## Log

- 2026-11-03: file created; all values recorded as inherited from v2.6.0.
- 2026-11-03: #13 fixed. In v2.6.0 every chart-window click reset the counters without `forward`, so the score read NaN until the next calibration.

# Recording posture clips

Recordings let the detection be tested on real sitting postures instead of guesses. A recording holds **pose landmarks only** (33 points per frame: x, y, z, visibility, rounded to 4 decimals), never camera images. About 9 KB per second, so 5 minutes is roughly 3 MB.

## Record

1. Open the page, sit upright, press **C** to calibrate.
2. Press **R** to start. A red `● REC` badge shows the time and the current label.
3. Hold each pose for 30–60 s, pressing its key as you start it:

   | Key | Label | What to do |
   |---|---|---|
   | 1 | `upright` | your normal good posture (recording starts with this label) |
   | 2 | `forward` | push the head toward the screen, the "+9%" lean |
   | 3 | `look-down` | look down at a phone or laptop keyboard |
   | 4 | `turn` | look at a second monitor |
   | 5 | `tilt` | lean on one elbow so the shoulders tilt |
   | 6 | `lean-back` | sit back against the chair |

   Go back to `1` for a few seconds between poses.
4. Press **R** again. The browser downloads `posture-recording-YYYYMMDDHHMM.json`.

The first 3 s of `upright` are used as the baseline during replay, so start the recording sitting upright.

## Replay

```
node tools/replay.js posture-recording-*.json
```

prints, per label, how much of the time each metric was over threshold, the mean forward-head change and mean shoulder angle. Files placed in `test/recordings/` are also checked by `npm test`: `upright` must stay mostly ok, `forward` must be mostly over on forward head, `tilt` mostly over on shoulders. `look-down`, `turn` and `lean-back` are known blind spots (see DECISIONS.md) and are reported, not asserted.

## Format

```json
{ "format": "posture-recording", "version": 1,
  "model": "pose_landmarker_lite/float16/1", "tasksVersion": "1.1.1",
  "width": 640, "height": 480, "startedAt": 1793742096110,
  "marks":  [{ "t": 0, "label": "upright" }, { "t": 5392, "label": "forward" }],
  "frames": [{ "t": 0, "lm": [[0.5021, 0.3462, -0.8106, 0.9998], ...] }] }
```

`t` is milliseconds since the start; `lm` is `null` for frames with nobody detected. At most 10 frames per second are kept.

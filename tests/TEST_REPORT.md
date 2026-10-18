# HalalFrame v1.3 — Test Report

Date: 2026-10-18. Source: existing v1.2 editor; targeted updates only.

## Verification status

| Check | Result | Evidence / limitations |
|---|---|---|
| A: mask visible only within specified time range | **Passed with simulation** | Existing baseline `tracker.test.mjs` uses actual data-model functions. |
| B: keyframe box interpolates | **Passed with simulation** | Existing baseline midpoint interpolation assertion. |
| Clean astronaut Find All: one 0–10 s identity | **Passed with simulation** | Actual v1.3 tracker module, controlled detections matching source geometry, 301 samples. Owner independently verified the equivalent real-model case on v1.2. |
| Clean Tap + Track to end | **Passed with simulation** | 0 prompts in clean detector simulation; previous real-model v1.2 owner test passed. |
| 1-second person disappearance: one identity and no missing mask | **Passed with simulation** | `v13-safety.test.mjs`, 4.5–5.5 s detector dropout, zero-confidence mask points and re-acquisition. It does **not** prove true person visibility/coverage during occlusion. |
| 3-second disappearance: re-acquire same identity | **Passed with simulation** | Scan remains eligible after 1.5 s; same track detected after 6 s. |
| Permanent detector loss | **Passed with simulation** | Safety box continues to video end and grows gradually. Actual subject position is unknown during loss. |
| Default Blur and branded-fill safety | **Passed: static/source and data-model check** | `newConcealment` defaults to Blur; `renderFrame` requires explicit `wholeFrame` for full-frame brand fill. Actual rendered pixels not compared in browser. |
| Restore consent and Delete/Clear durability | **Passed with simulation** | `v13-release.test.mjs` runs actual IndexedDB wrapper with fake transaction scheduling, and asserts static restore controls. User-device UI not verified. |
| Versioned CSS, JS, manifest and module imports | **Passed: static/source check** | `APP_VERSION='1.3'` populates import map, entry import, CSS and manifest links. Cannot prove actual Chrome HTTP caching from static inspection. |
| SW network-first, claim, clean stale shell, preserve AI cache | **Passed with simulation** | `v13-worker.test.mjs` invokes actual SW handlers with mock CacheStorage and network. |
| Actual Android/PWA v1.2→v1.3 upgrade | **Not verified** | Test on GitHub Pages after deployment; old v1.2 SW may require opening `?v=1.3` once. |
| Real MediaPipe re-acquisition on disappearance clip | **Not verified** | No real on-device detector run available in this execution environment. |
| Exported MP4 video/audio, WhatsApp playback | **Not verified** | Export code is unchanged from v1.2; **source** MP4 AAC verification does not prove exported sound. |

## Test commands

```sh
node tests/regression/tracker.test.mjs
node tests/regression/v13-safety.test.mjs
node tests/regression/v13-release.test.mjs
node tests/regression/v13-worker.test.mjs
python tests/regression/verify_media.py
```

## Regression clip validation

- Normal clip: 300 frames, 1280×720, 30fps, 10s, H.264 + AAC, 440Hz audio.
- Disappearance clip: same geometry/codec and AAC. At t=4.3s astronaut visible, at t=5.0s grey background, at t=5.7s astronaut visible. Its corresponding detector-simulation gap is 4.5–5.5s.
- A genuine video export and a genuine MediaPipe session were **not** produced during this v1.3 execution.

## Required Android phone acceptance test

1. Deploy v1.3 on the existing GitHub Pages repository. Open `https://adhkarlyaus.github.io/halalframe/?v=1.3` once to bypass any v1.2 cache. Confirm **v1.3** in the footer, and JS requests containing `?v=1.3`.
2. Load normal astronaut MP4. **Find all people** should return exactly one person over 0–10s, with continuous concealment. Test Tap + Track for zero unexpected prompts.
3. Load disappearance MP4. Find All should still produce one 0–10s identity. Inspect t=4.49, 5.0, 5.5, 5.8, 8.0; the region must remain present across detection loss and then reacquire. Verify the masked output while the person is visible, not only the tracker dots.
4. Select a region, change effect to brand and verify it doesn't occupy the entire frame. Select **Intentionally cover entire frame** and verify that deliberate choice. New masks should default to Blur.
5. Delete a region and reopen the file: confirm the region stays deleted and a Restore/Start fresh prompt appears only when there are actual saved regions. Press Start fresh; reopen to confirm old regions do not return. Test Clear project.
6. Export the edited video and check the whole file in Android Gallery and WhatsApp, including the 440Hz AAC tone.
7. Later test a new deployment to ensure the update banner appears and old JS is not served; service-worker mock tests alone cannot establish mobile update reliability.

**Safety qualification:** a box that persists during a detection failure is not evidence the person remains fully covered if their position changes unexpectedly. No automatic AI model guarantees that every instance of awrah is concealed. The user must review full exports before sharing.

## Changed files (exact)

Modified: `index.html`, `css/styles.css`, `js/main.js`, `js/state.js`, `js/engine/tracker.js`, `js/engine/render.js`, `sw.js`, `README.md`, `tests/TEST_REPORT.md`.

Added: `tests/regression/astronaut-disappears-1s.mp4`, `tests/regression/v13-safety.test.mjs`, `tests/regression/v13-release.test.mjs`, `tests/regression/v13-worker.test.mjs`.

All other v1.2 files unchanged.

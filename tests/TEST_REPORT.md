# HalalFrame v1.2 — Regression & Verification Report

Date: 18 October 2026. This is an in-place v1.1 patch, **not** a new rewrite.

## Exact reproduction media

- `tests/regression/astronaut-motion-10s.mp4`
- Source: `skimage.data.astronaut()`, resized to a 380×380 image, placed over grey 1280×720 canvas at `x=t*92`, `y=200` with FFmpeg.
- 30 fps, 10 seconds, 300 frames, H.264 video, AAC 440 Hz mono audio.
- **Input media validation: PASSED.** OpenCV decoded all 300 frames; content moved along the expected path; FFprobe confirmed codecs and dimensions; FFT of decoded AAC audio measured 440.0 Hz.
- This validates the **original regression input**, **not** HalalFrame's actual export.

## Functional regressions

| Area | Status | Evidence / limitation |
|---|---|---|
| v1.0 Test A — time-bounded mask | **Passed — unit test of current state.js** | The actual v1.2 state module enforces 5–8 s visibility; canvas renderer itself is unchanged. |
| v1.0 Test B — interpolated keyframes | **Passed — unit test of current state.js** | The actual v1.2 `boxAt` interpolates x=0.1 at 2s and x=0.5 at 6s to x=0.3 at 4s. |
| v1.2 Find All → one person, 0–10 s | **Passed with simulation** | `node --experimental-default-type=module tests/regression/tracker.test.mjs`; clean 30fps synthetic detections produced one track, exactly 0 to 10 seconds, **301 points** and zero uncovered positions against source image rectangle geometry. **Real MediaPipe model output not verified**. |
| Scan with 1.1 s missing detections | **Passed with simulation** | Single track, missing positions interpolated at <0.08s intervals, zero uncovered rectangle positions. |
| Scan with 2.3 s detector dropout | **Passed with simulation** | One predicted-trajectory-merged track, marked as needing human review. |
| Tap at 2 s + Track to end | **Passed with simulation** | Ends at 10 s, **0 prompts** on the clean synthetic detector, tracked rectangle covers modeled source region every 1/30s. Actual MediaPipe tracking **not verified**. |
| Dropouts/shrinking detector box | **Passed with simulation** | Injected low-confidence partial detections and gaps; full-size region held conservatively; manual Keep going required only once for an introduced >0.5s loss. |
| End concealment here | **Passed with simulation** | A requested early stop remained at approximately 2.60 s; it did **not** get extended to 10 s. |
| Self-check hidden outside Debug | **Passed — static source inspection** | `#self-check-tools` hidden initially and is shown only by the Debug toggle. It was not evaluated on a live Android browser. |
| Tracking accuracy settings | **Passed — source + simulated 10/30 fps logic** | Best 30fps / Fast 10fps for this project; live GPU performance **not verified**. |
| MP4 export matches preview | **Not verified** | Export engine unchanged from v1.1, but no v1.2 WebCodecs file was produced in this environment. |
| Exported MP4 contains source AAC tone | **Not verified** | **Source** MP4 contains verified 440Hz AAC; this is not evidence that export preserves audio. |
| Exported MP4 plays in WhatsApp/Android Gallery | **Not verified** | Requires actual phone sharing/playback test. |
| PWA offline behavior after v1.2 upgrade | **Not verified** | Shell cache bumped; existing pinned AI asset cache key intentionally preserved to avoid another download. Requires Android validation. |

## Browser limitation

The available Chromium test runner blocked navigation to local HTTP, `file://`, and external URLs with `ERR_BLOCKED_BY_ADMINISTRATOR`. The real MediaPipe runtime could not be initialized against the user's live GitHub Pages site, so no genuine model-detection test was possible here. Node simulations directly imported the **actual revised tracker module** and fed the clip's exact known moving-person coordinates, including injected confidence drops and loss periods. Do not describe these tests as successful real-model verification.

## Device acceptance checklist

1. Deploy v1.2 and refresh twice in Android Chrome to update the offline service-worker shell. Check visible **v1.2** footer.
2. Select the bundled regression video. Confirm **Best · every frame** is preselected.
3. Press **Find all people**. Expected **one person**, `00:00.00–00:10.00`, roughly 300 track points. Inspect that the black region covers the astronaut for the full clip.
4. Open the same source again, pause at 2 seconds, tap the astronaut and press **Track →**. Expected the track to reach 10 seconds, with **no more than one** unexpected check prompt, and no visible exposed pixels at 1.6, 2.3, 5 and 9 seconds when tracking from the beginning (or 2.3, 5 and 9 seconds when starting at 2 seconds).
5. If the AI still loses the subject, capture the frame time and detection confidence from Debug, then fix the box; it is **not guaranteed** to be safe without manual review.
6. Tick the review acknowledgement, export at 720p, play the new MP4 in Android Gallery, confirm the 440 Hz sound, then share with WhatsApp and check playback there.
7. Try a Fast (10 fps) scan for comparison and confirm no false duplicates.
8. Confirm `AI ready offline ✓` stays visible after refresh, and test airplane mode. Do not clear site data first.

## Files changed from v1.1

- `js/engine/tracker.js` — predicted matching, One-Euro centre smoothing, conservative sizing, continuous gap interpolation, path merging, check cooldown, accuracy modes, end-time fixes.
- `js/engine/ai.js` — threshold lowered to 0.18; self-check message clarified.
- `js/main.js` — accuracy connected to tracking and scanning; default selected by clip duration; longer-gap review label; hide self-check details outside Debug.
- `js/state.js` — version v1.2 and 15% default region padding.
- `index.html` — version v1.2, accuracy control and Debug-only self-check panel.
- `sw.js` — shell cache revision v1.2, reuse existing v1.1 model cache.
- `README.md` — v1.2 behavior, launch notes and testing instructions.
- `tests/TEST_REPORT.md` — this report.
- **Added**: `tests/regression/astronaut-380.png`, `tests/regression/astronaut-motion-10s.mp4`, `tests/regression/tracker.test.mjs`, `tests/regression/verify_media.py`.

Unchanged: `css/styles.css`, `js/engine/render.js`, `js/engine/segmentation.js`, `js/engine/export.js`, `js/engine/ffmpeg-worker.js`, `js/ui/timeline.js`, `js/ui/canvas-input.js`, `manifest.json`, `assets/logo.png`, icons, and reference illustration.

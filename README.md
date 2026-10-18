# HalalFrame v1.7 — Precision, Music Check, and Onboarding Hotfix

HalalFrame is a **free**, installable, static browser photo/video concealment editor by Adhkarly Team. It processes user media on the device; no application backend, API key, account, or upload of the user's personal videos is used. On first use it **downloads AI model weights and JavaScript** from pinned CDN/model hosts; browsers/hosts can receive ordinary HTTP request metadata. **Neither awrah concealment nor AI music removal is guaranteed accurate**: review the entire edited video and listen to the exported audio. **No audio** is the only reliable way to remove every sound.

**IMPORTANT LIMITATION:** This release's new tracking and audio changes were checked with synthetic regressions, source checks and Chromium DOM UI tests. We could **not run MediaPipe PoseLandmarker / YAMNet / Demucs with actual remote model downloads**, nor complete Chrome-hosted MP4/WhatsApp tests in the sandbox. The user's v1.6 report is the real-device baseline; v1.7 behavior must be verified on Android before describing these problems as solved.

## Deploy for free (replace v1.6 in place)

1. Extract `HalalFrame_v1.7_Precision_Fixes.zip`.
2. Upload **all files inside the extracted directory** into the root of https://github.com/adhkarlyaus/halalframe, replacing matching files; commit to `main`.
3. GitHub Pages deploys on the existing URL. Open **https://adhkarlyaus.github.io/halalframe/?v=1.7** and apply the **Update ready — reload** action if shown.
4. Install from Android Chrome's Add to Home screen / Install app menu. MediaPipe and sound-model downloads require an internet connection at least once. The on-device PWA cache remains versioned and network-first for source files.

Opening `index.html` via `file://` can fail due to ES modules and service worker restrictions. Use the hosted HTTPS page or run `python3 -m http.server 8000` in the folder.

## Changes since v1.6

### A. Better selected-person precision and fewer mistaken prompts

- `js/engine/segmentation.js` freezes a **full-frame snapshot** at the requested time before awaiting the pose AI, so a seek during processing cannot associate someone else's pose mask with the target. For precision-critical concealments it uses a current-frame **individual pose instance**, subtracts competing pose probabilities, restricts the final mask to the current target box, and **never blends the previous frame's mask**. Those were two causes of cameraman coverage persisting after separation.
- `js/engine/tracker.js` and `js/engine/identity.js` re-rank candidates against the tracked **original appearance**, global association and current detections rather than accepting the drifting predicted box. When a trustworthy target reappears, it returns to the individual's own box rather than the prior large crossing/loss union. The long-loss safety mask remains active until the person is re-acquired or the user ends it. Low-quality partial torso-only boxes are handled conservatively.
- Existing **Don't cover this person**, manual reviews, Find all people, Pixelate/Blur and the existing 10fps/Best tracking modes remain. Exclusions and override controls remain accessible.

**Important tradeoff:** Computer vision can still mistake one person for another at crossings, and a padded safety fallback while tracking is lost can cover an unrelated person. The requirement to never reveal a selected person's awrah and never mask a bystander cannot both be guaranteed automatically in every frame. Review and correct uncertain regions before export.

### B. Music remover actually checks audio in the browser

- `js/audio/music-check.js` runs MediaPipe **AudioClassifier/YAMNet on the document/main thread**, NOT in the module audio worker. The worker now only produces separated audio and sends the cleaned PCM; after it terminates, `js/ui/audio-panel.js` runs the before/after music check and generates the green/grey/red **Music check strip**, with explicit **Unverified** state if classification fails. This avoids the v1.6 `importScripts() on module worker` error. The check is a probabilistic risk estimate, not religious certification or an absence-of-music guarantee.
- `js/audio/music-worker.js` streams a Studio/Demucs model download with **received byte counts / total MB**, 25-second initial-response timeout, 30-second stall timeout, 4-minute total deadline, HTTP/CORS errors and size/checksum checking. Studio failures trigger a **Best MDX-Net** fallback, without returning original audio as "cleaned." The user sees the fallback. Download URL: `https://huggingface.co/timcsy/demucs-web-onnx/resolve/92e33df/htdemucs_embedded.onnx` (pinned revision; expected 180,534,758 bytes; configured SHA in models.js). **The exact CORS behavior of this pinned host from GitHub Pages could not be verified** here; automatic fallback remains important.
- Quick = MDX-Net 9482 (~30 MB), Best = MDX-Net Voc FT (~67 MB), Studio = experimental HTDemucs v4 (~172 MiB / 181 MB). For **Maximum** only, an additional reference-based spectral suppression pass targets residual drums/bass/chords. This may degrade vocals and **does not make sound guaranteed music-free**. Original and No audio options are unchanged. Voice detection keeps the v1.6 224ms padding.
- Models and related rights: `onnxruntime-web@1.22.0` (MIT), `@mediapipe/tasks-audio@0.10.22-rc.20250304` (Apache-2.0 package), `demucs-web@1.0.2` (MIT library), Silero VAD (MIT), pinned MDX models and HTDemucs weights (separate model terms; **verify commercial rights before using in an ad-supported app**). The Demucs WASM/WebGPU path may fail on phones or shared hosts.

### C. Design

- Splash: at least **1,850 milliseconds**, bigger vertically/horizontally centered transparent HalalFrame wordmark, animated lime focus-frame corners, soft glow, App → AI models → Ready status and reduced-motion support.
- Onboarding page 1 vertically centred; page 2 custom illustrated Tap → Track → Export cards approximately **338×220** on a 390px phone, swipeable with subtle animations; page 3 adds a custom phone/shield/lock SVG and centred text. Page 4 disclaimer and the special thanks remain as approved.
- `APP_VERSION=1.7` in one place; same network-first shell update strategy, revision-stamped modules and protected model cache.

## Tests and real-device acceptance

```
node tests/regression/tracker.test.mjs
node tests/regression/v16-identity.test.mjs
node tests/regression/v16-precision.test.mjs
node tests/regression/v17-precision.test.mjs
node tests/regression/v17-audio.test.mjs
node tests/regression/v17-release.test.mjs
python3 tests/v17-ui.py
```

Test fixtures:
- `tests/regression/two-person-crossing-10s.mp4`: astronaut left→right and cameraman right→left over 10 seconds (1280×720 at 30fps) with crossing around 4–6 seconds.
- `tests/regression/realistic-speech-music-10s.mp4`: voiced synthetic speech mixed with bass, drums and chords; reference WAVs are included.

| Validation | Result |
|---|---|
| Existing time-limited masking / keyframe movement | Passed in regression tests |
| Simulated two-person separation, 300 frames | 0 changed cameraman-only mask pixels; 0 missed target frames (**simulation only**) |
| Real PoseLandmarker astronaut/cameraman at 7.5 sec | **Not verified; Android acceptance required** |
| Single person repeated lost prompts | Passed in prior synthetic tracking regression; real v1.7 result **not verified** |
| Maximum extra DSP with simulated speech + drums/bass/chords | Approx. **4.97 dB** extra synthetic residual reduction; **not real model output** |
| YAMNet before/after classification | Passed with mocked classifier; real model inference **not verified** |
| Studio streamed download + Best fallback | Code/static tests; CORS, real model runtime **not verified** |
| Splash timing, illustration sizing, disclaimer | Passed via embedded Chromium DOM harness |
| MP4 audio/Android gallery/WhatsApp | Unchanged architecture, **not re-verified here** |

### Acceptance instructions

1. Android Chrome: after v1.7 deploy, clear stale update banner. Check large centered splash is visible ~1.85 seconds and every onboarding page displays correctly.
2. Load `two-person-crossing-10s.mp4`; tap astronaut at 0s, Track →. Check 2, 4, 5.5, **7.5**, **8.9**, 9.3 seconds. Cameraman should be clean immediately after separation; check that any wrong candidate thumbnail and unnecessary lost prompts have been eliminated. Export and inspect the MP4 itself.
3. Load the realistic music clip in Audio. Check Quick/Maximum and Best give **distinct audible outputs** and that the Music check strip actually appears with music / speech statuses. Test Studio and verify byte progress and automatic Best fallback after a network/model failure. If any model fails, select No audio or manually review the output.
4. Check original/silent/cleaned AAC MP4 playback in Android Gallery and WhatsApp before sharing edited media publicly.

See `tests/TEST_REPORT.md` for granular tests, and `CHANGED_FILES_v1.7.md` for an exact list of additions/modifications compared to v1.6.

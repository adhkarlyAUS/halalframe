# HalalFrame v1.6 — Precision evaluation build

HalalFrame is a free, static, installable on-device photo/video editor by the Adhkarly Team. No account, app backend, server upload, or API keys. The first use of the optional AI features downloads pretrained models from pinned Google/Hugging Face addresses. Browsers and model hosts may process ordinary network metadata; the user's own media is never sent by our application.

**IMPORTANT:** The v1.5.1 user-confirmed functionality is preserved. v1.6's *new* instance tracking and advanced music checks have **not** been verified against real models or Android hardware in this execution environment. Do not describe the edited media as guaranteed awrah-free or music-free. Always review every frame and listen before sharing; **No audio** is the only reliable way to remove all audio.

## Quick start / free hosting

1. Download and unzip the **full** v1.6 package.
2. In https://github.com/adhkarlyaus/halalframe upload **the contents** of this folder to the repository root, replacing the existing files. Commit to `main`.
3. Existing GitHub Pages deployment updates automatically. Open `https://adhkarlyaus.github.io/halalframe/?v=1.6`, let the new service worker activate, then tap **Update ready — reload** if shown.
4. On Android Chrome, install as a PWA from the browser menu. On first use, remain online until required models are cached.
5. If opening `index.html` over `file://`, JavaScript modules may be restricted; use HTTPS or a local web server (`python3 -m http.server 8000`).

## What's new

### A. Person selection that doesn't spread to a bystander

* `js/engine/identity.js`: Hungarian global assignment across all detected people; constant-velocity Kalman centre prediction, torso HSV histograms, relative bounding/landmark body proportions. The existing One-Euro tracking and safe growing lost-person box are retained. An optional MediaPipe MobileNet V3 Small CNN embedding checks appearance at ambiguous crossings. Bad matches trigger **Is this the right person?** review, with both selected and proposed thumbnails.
* `js/engine/ai.js`: optional MediaPipe **PoseLandmarker Full**, 5 poses, `outputSegmentationMasks: true`, with GPU → CPU fallback. `ImageEmbedder` loads lazily. Models: Pose `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task`; ImageEmbedder `https://storage.googleapis.com/mediapipe-models/image_embedder/mobilenet_v3_small/float32/1/mobilenet_v3_small.tflite`. Pinned MediaPipe package: `@mediapipe/tasks-vision@0.10.22-rc.20250304`.
* `js/engine/segmentation.js`: selects the **target's own pose probability mask**, not the union of all people. On skin/hair modes, the class-specific mask is intersected with the target's instance. Fallback is bounded to the selected box and subtracts separately detected other people outside the selected person's own tracked region. When the pose/segmenter fails, the **padded box** remains a conservative fallback. A provisional preview clip is limited to the selected track box until inference completes. The current frame and tracked neighbor positions are used to avoid persistent masking on someone else.
* Editor: **Don't cover** mode, scanned-person Cover / Don't cover / Skip choices, and a **Conceal this person** on/off toggle. Exclusion tracks are saved with the project and respect time ranges.

**Safety tradeoff:** A growing fallback while a target is lost can still cover an unrelated person whose location becomes ambiguous. A real pose mask can also assign the wrong individual at a difficult crossing. No general-purpose CV model guarantees the selected person is fully covered *and* all bystanders are untouched. Export remains subject to full manual review.

### B. Music removal verification

* Original / No audio / Remove music remain, including the Quick (~30 MB) and Best (~67 MB) MDX-Net vocal-isolation models, the worker handshake, cancellable processing and A/B preview.
* **Experimental Studio / Demucs v4** option downloads a ~181 MB HTDemucs ONNX export and attempts to run through pinned `demucs-web@1.0.2`. Browser memory and GitHub Pages cross-origin-isolation restrictions may make Studio unavailable. It throws a clear error instead of silently substituting the original soundtrack. It is **not production-verified**. The MIT code licence is verified; the trained Demucs weight-use rights remain less certain for commercial advertising-supported use, so review rights before monetizing/distributing it.
* A pinned MediaPipe AudioClassifier/YAMNet checks the original and the processed audio using 0.975-second windows. Colour strip: **green** speech/low-confidence music, **grey** apparently removed music, **red** remaining music risk. High-risk non-speech intervals are muted; Strict also mutes high-risk intervals beneath speech; after muting, it checks again. **Unavailable or failed classification is shown as unverified**, not clean.
* Silero VAD now uses ≥224 ms pre/post speech padding. Maximum retains the v1.5.1 reference-based steady-tone suppression as a limited polish pass. A full DeepFilterNet3 3-network streaming pipeline is **not** included: shipping bare ONNX weights without its stateful DSP/decoders would misleadingly imply the feature works.
* Original audio is retained only when the user selects it. Edited PCM continues through the existing AAC MP4 export; **No audio** produces a video without an audio track.

Models / libraries and licences:

| Package/model | Pinned URL or revision | Licence / status |
|---|---|---|
| MediaPipe Pose + Embedder | official Google model URLs above, version path `/1/` | Google MediaPipe tasks package Apache-2.0 |
| MediaPipe AudioClassifier / YAMNet | `@mediapipe/tasks-audio@0.10.22-rc.20250304`, `https://storage.googleapis.com/mediapipe-models/audio_classifier/yamnet/float32/1/yamnet.tflite` | tasks package Apache-2.0; model downloaded on demand |
| Silero VAD | git revision `60b7ffa243625ebdc1070275a29f18c87843786a` (in `js/audio/models.js`) | MIT |
| MDX-Net Quick / Best | Politrees UVR resources git revision `8cc4418db60d96e501f42889370b8bf3eb6df2d2` (checksums in `models.js`) | hosted freely; confirm underlying weights rights for commercial use |
| HTDemucs v4 / demucs-web | npm `demucs-web@1.0.2`; `timcsy/demucs-web-onnx` model at revision `92e33df`, SHA256 in `models.js` | package MIT; **weight commercial-rights caveat**, not verified in target Chrome |
| Existing ONNX runtime | `onnxruntime-web@1.22.0` | MIT |

### C. Design

* Original approved HalalFrame wordmark extracted to transparent PNG at `assets/logo-transparent.png` (the old opaque `assets/logo.png` is retained for compatibility). Splash, onboarding and header use the transparent version on charcoal with the original purple Adhkarly badge.
* Larger centred splash, lime draw-on framing corners and real App → AI → Ready stage texts. Respects `prefers-reduced-motion`.
* Step 1 has no diamond. Step 2 has custom editable SVGs: tap, track, share. Step 3 privacy text centred. Step 4 preserves disclaimer and exact original special thanks, with smaller attribution.
* Everywhere the developer credit is now **Developed by Adhkarly Team**. The special thanks to Mustapha (Muzzy) is unchanged.
* Version is `APP_VERSION='1.6'`; app-shell JS/CSS cache-busting and network-first updates are retained. Large model weights are cached when fetched.

## Regression tests / candid limitations

Included fixtures:

* `tests/regression/two-person-crossing-10s.mp4` — 1280×720, 30 fps, 10s, grey background, a 360² astronaut moving right at 90 px/s (y=120), and a 360² cameraman moving left at 90 px/s (y=330), composited on top, with 440 Hz AAC audio.
* `tests/regression/realistic-speech-music-10s.mp4` — synthesized narration over drums, bass and changing triad chords, 10 s, AAC. Reference WAVs `realistic-*` enable energy measurements.
* `tests/regression/v16-identity.test.mjs` — a simulated RGB-composite crossing tests Hungarian association and torso colour signatures.
* `tests/regression/v16-precision.test.mjs` — 300 ground-truth pose-mask simulations test rejection of cameraman-only pixels.
* `tests/regression/v16-audio.test.mjs` — YAMNet score parsing, risk muting, ≥224 ms speech gate. **Does not execute the neural models**.
* Existing tests for time-limited masks, tracking, service worker, share-target, VAD/DSP and worker handshake still pass. Some previous release-specific tests expect exact historical versions 1.4/1.5 and are kept for audit, not counted as current-release tests.

**Actual result of deterministic simulations:** 300/300 pose-mask frames have a visible astronaut mask and zero mask pixels within cameraman-only regions; 0/300 synthetic identity swaps. **Actual Google models have not been run here** so neither result is an assertion of the real acceptance target. The synthetic audio mix has RMS ~0.0924 music-only (0–2.5s), ~0.0907 background music beneath speech (2.5–6.5s), ~0.0918 music-only (6.5–10s). Real Quick/Best/Studio post-separation energy and before/after YAMNet scores are **not measured**; do not invent numbers.

## Android acceptance checks

1. Upload `two-person-crossing-10s.mp4`, tap astronaut at 0 s, Track →. Scrub 0, 4, 5.5, 9 s and export. The selected astronaut should remain covered and the cameraman should return fully visible when not overlapping. Inspect both the **pre-encode rendered canvas** and exported MP4. Require zero changed cameraman-only pixels in the canvas; lossy H.264 re-encoding may cause small pixel differences even outside masks, so the MP4 comparison needs a compression tolerance. Report missed astronaut frames and any visible cameraman masking. Tap **Don't cover** on the cameraman as an additional safeguard.
2. Run Find All People; inspect both identities before applying Cover. If they are swapped, press the identity review dialog, correct and re-run.
3. For `realistic-speech-music-10s.mp4`, test Quick → Best → Studio (optional on powerful desktop). Compare A/B, open Music check strip, record remaining risk scores, and test No audio. Listen for chopped syllables and musical bleed; never assume the classifier is a guarantee.
4. Verify original v1.5.1 MP4 AAC playback/WhatsApp compatibility, PWA install, service-worker update, local-project restoration and export-review gate.

## Privacy / scope

Static files only; no app backend, tracking server, account or paid API. First-run model downloads must succeed. No external social-media downloader is provided. If a model cannot initialize, the user can still use manual box drawing and fully silent export.

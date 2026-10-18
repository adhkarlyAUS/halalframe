# HalalFrame v1.1 — Honest Test Report

**Build:** 2026-10-18, static ES-module site continuing directly from v1.0 Phase 1–2 files.

## Tested here

| Test | Status | Evidence and limitations |
|---|---|---|
| A — select at 5s displayed only 5–8s | **Passed** (canvas regression test) | Headless Chromium: original red at t=4, black inside region t=6, original red again t=9. |
| B — keyframe movement between 2s and 6s | **Passed** (mathematical/browser regression) | Midpoint x(t=4)=0.3 when x(2)=0.0 and x(6)=0.6. |
| C — detector follows person, pauses when lost | **Passed with simulation** (carried forward from v1.0) | Controlled simulated detector from v1.0; real Google model/real walking person was not exercised in v1.1. Fixed a pre-existing undefined-variable error in the manual Fix Box branch. |
| E — `skin` conceals class 2 only; empty mask fallback | **Passed with simulation** | Synthetic 256×256 MediaPipe-style category map: target skin pixels concealed (black), non-skin stayed original (red); empty category mask produced full padded black box. No real person/model in this test. |
| F — no flicker while scrubbing | **Passed with simulation** | Adjacent alternating category maps: temporal blend 0.6/0.4 reduced numeric transition from 510 to 306; cached per-frame outputs remain stable. Not proof of flicker-free real video. |
| D — MP4 matches preview with original audio, plays in WhatsApp/gallery | **Not verified** | Implemented WebCodecs H.264/mp4-muxer, local AAC/FFmpeg audio path and WebM fallback. Unable to import pinned remote libraries or play/share a real exported file on Android in this environment. Do not claim compatibility verified. |
| G — PWA installation and AI offline after first load | **Not verified** | Manifest JSON, service-worker JS, and asset references checked statically. Local browser harness denied navigation to local HTTP addresses, so installed PWA / CDN asset downloads / airplane-mode AI use were not tested. |

**Static validations:** All module and service-worker files pass `node --check`. Every literal `$('element-id')` in `main.js` exists in `index.html`. The preserved logo has not been regenerated. The website has no backend upload path.

## Manual Android test checklist (must complete before public launch)

1. Publish to HTTPS, open Android Chrome on a **real mid-range device**, clear app/site data.
2. Watch initial `Self-check` load; verify model loads and Debug reports `D:GPU/CPU`, then test an actual photo of a person. A synthetic illustration may give `0 persons` even with correct model.
3. Open a short 10-second video containing an actual person walking left → right and audible speech. At 2s tap person, `Track →`, confirm mask follows through to end and `Ask Me` appears when they leave frame or cross another person.
4. Switch to `Person outline`, `Exposed skin`, `Hair only`. Visually check class boundaries, skin/face toggle, safety margin, and box fallback on an empty result. Move scrubber back and forth and confirm same mask at same frame.
5. Repeat v1.0 time-range and keyframe tests A/B. Drag timeline start/end handles and use Undo/Redo.
6. Choose default 720p. Export MP4 and ensure progress and ETA update, Cancel works, screen stays awake where permitted. Open file in Android Gallery and WhatsApp, check concealments at every keyframe and **listen for original audio** with lips/voice in sync. Recheck with a video without sound, another with loud music, and 1080p.
7. Use Android `Share` with exported MP4. Test app reload, project restore (without source media), and `Install app` on home screen.
8. After first use, wait until `AI ready offline ✓`, switch to airplane mode, close/relaunch PWA, tap a person and test segmentation offline. Note browser may evict cached models and FFmpeg fallback may need internet.
9. Stress test 1080p ~60s on an ordinary phone. Measure crashes, memory exhaustion, dropped export frames, export size/time. Test model first download over mobile data and clear errors with no connection.

## Known limitations to address before production

- Static-site HTTPS hosting is required for PWA. `file://` shows guidance, not an operational AI app.
- Real EfficientDet person tracking can lose subjects or switch identities. The conservative export fallback masks padded boxes, but AI cannot guarantee every awrah region is found.
- Complex compression formats may fail to decode via `AudioContext`, `AudioEncoder`, or FFmpeg wasm; if the fallback returns a WebM, UI explains sound/WhatsApp compatibility cannot be guaranteed.
- The `Test E` segmentation example used a synthetic label map. `Skin` could hide non-awrah skin while missing covered awrah and is not a complete Islamic rule engine.
- Streaming repeated seeks and per-frame segmentation are expensive on mid-range Android. Export is offline/non-realtime, not guaranteed to finish quickly. We have not benchmarked 60-second 1080p clips on-device.
- PWA cache completion does not guarantee permanent offline operation because users/browsers may evict cached data. FFmpeg fallback is not pre-cached.

# HalalFrame v1.12.0 — Whole-person coverage, reliable detection, WebM export

Tested live in Chrome (desktop) on six real clips + photos with speech and music.
Reviewed in three rounds together with ChatGPT; every P0/P1 it raised is fixed
or documented below. No backend, accounts or paid APIs were added.

## What was wrong in v1.11.1 (all verified in Chrome)

1. **Close-ups were barely covered.** Absolute "20% of the frame" caps in
   `bytetrack.js` and `render.js` shrank any close-up/selfie subject to a face
   strip (eyes, hair, arms and body visible).
2. **Per-person outline masks never worked.** `PoseLandmarker.detectForVideo()`
   with a *callback* on the GPU delegate returns all-zero segmentation masks,
   so every person fell back to a rectangle.
3. **People were missed for seconds.** EfficientDet-Lite0 sees a squashed
   square input; clearly visible walkers scored 0.13–0.35, and tracks were only
   started from detections ≥ 0.50.
4. **Pose found only one of several people** (VIDEO mode only re-detects when
   its tracker is lost).
5. **WebM export broken.** The ffmpeg core URL pointed at `dist/umd`, which a
   module worker cannot import: cleaned audio failed, original audio produced a
   silent WebM. Realtime MediaRecorder export also let masks lag a moving video.
6. Last frame of a clip uncovered in the preview.

## What v1.12 does

* **Whole person covered:** the mask rectangle is the union of the track box,
  the person's own pose-mask extent (connected component seeded at their
  landmarks), a measured head cap and the legacy padded box. Hair, skin and
  clothes labels touching the body are added; other people's pose masks are
  never taken. People without a pose use their own multiclass labels.
* **Detection:** whole frame + overlapping native-aspect square tiles
  (~10–15 Hz), cross-pass merge only (two people from the same pass are never
  merged), tracks start from ≥ 0.30 detections, brief (≥ 0.2 s) appearances
  are selectable, 0.6 s pre-roll / 0.4 s post-roll swept along each person's
  motion, real keyframes at clip start/end.
* **Pose:** return-value API (real masks) in IMAGE mode (all people).
* **Export:** non-MP4 sources (WebM…) are rendered frame-by-frame through the
  same WebCodecs encoder and audio path; ffmpeg ESM core; one shared frame
  snapshot per frame (faster, less memory).
* **Optional "Cover women only (AI)"** (People found dialog): downloads the
  MIT-licensed Human face model *only when pressed*. A person is pre-set to Skip
  only after ≥ 3 clear, unambiguous, strongly-male faces; anyone unclear stays
  covered. Choices are only pre-selected; the user reviews and presses Apply.
  (Idea inspired by the HaramBlur extension; no HaramBlur code is used.)

## Tests

```bash
node --test tests/v1.12.test.mjs   # 11 pass
```

See `tests/TEST_REPORT.md` for the live Chrome results.

## Publish (GitHub Pages)

Upload the changed files over the repository root and commit to `main`, then
open `https://adhkarlyaus.github.io/halalframe/?v=1.12.0`.

---

# HalalFrame v1.11.1 — Gap Review & Re-acquisition Hotfix

This is a **targeted patch on the verified v1.11 codebase**. No backend or paid
API. The video and user corrections stay on the device. The v1.9 MP4Box decoder
hotfixes and the restored first-run/share/service-worker bootstrap are preserved.

## What's fixed

1. **Natural exits do not block export.** A Find All track that terminates with
   no subsequent confirmed observation is not a review gap. Only genuine
   *interior* detection gaps can block export. Duplicate overlapping gap reports
   are combined; restored projects with old gaps remain manually reviewable.
2. **Review gaps later.** Amber timeline stripes and a Review gaps panel display
   the actual uncertain time intervals. The export modal offers Review gaps,
   Mark as reviewed (with explicit confirmation), End cover here, Finish
   tracking and Back. In the review window, the user can Confirm OK, Draw box,
   Re-tap person, End cover here or Back.
3. **Proposed re-acquisition, never a silent identity switch.** The per-frame
   scanner continues looking for plausible *new* tracks after an occlusion.
   At 6.10 seconds in the supplied CCTV detections it proposes Person 8, with
   side-by-side thumbnails where available: Yes, cover / No, different person /
   Draw box. Only a user's Yes links the new track. The unseen interval
   remains amber until the user reviews or explicitly ends coverage.
4. **Test suite repaired.** Old release tests check enduring functionality,
   rather than requiring their original historical APP_VERSION. The old
   v1.10 scan fixture now correctly models visibility ending at 8s. Added a
   directory-compatible runner and three real-JSON regressions.

## Run all tests

```bash
node --test tests/regression/
# Child suite: 35 tests, 35 pass, 0 fail
```

`python tests/v1111-browser-harness.py` runs a Chromium DOM bootstrap and
persistent-gap modal-action test. It passed with zero JavaScript/page errors.
**Full localhost/file/HTTPS navigation was blocked by this container's browser
policy**; that is not a verified live-browser load, and actual MediaPipe inference
was not rerun here. See `tests/TEST_REPORT.md`.

## Publish free

Use `HalalFrame_v1.11.1_Deploy_Only.zip` for the quickest GitHub Pages update.
Upload its extracted **contents** into the root of the existing GitHub repository,
commit, then open `https://adhkarlyaus.github.io/halalframe/?v=1.11.1` after Pages
finishes deploying. Do not upload the outer ZIP as one file.

## Test on Android Chrome

1. Upload `street.mp4`; Find all people → Cover everyone. Natural exits must
   not cause blocking modals. A *real* internal gap, if flagged, must show an
   amber timeline stripe and five decision paths instead of a Back-only dialog.
2. Tap the dark-coat man at 0 seconds. After the crowded group, the app should
   **propose** a person around 6.1s, not automatically assign them. Confirm Yes
   only if the side-by-side comparison is right. Confirm the linked region
   reaches 19.97s, while the 2.47–6.10s unseen interval remains reviewable.
3. Verify all amber gaps manually before export. Confirm the downloaded MP4
   contains only the intended concealments and its audio plays normally.

---

# HalalFrame v1.11.1 — Real-footage Tracking

**Pure static, on-device HalalFrame editor**. This is a focused update to the corrected v1.10 source, not a rewrite of the established video/MP4 export, music separation, PWA, onboarding, or approved charcoal/lime-and-Adhkarly branding. Processing of your media takes place locally in Chrome; third-party AI and JavaScript assets download initially from pinned providers. No server, accounts, paid APIs, or API keys are required.

## Installation / free GitHub Pages update

1. Extract the complete `HalalFrame_v1.11_Real_Footage_Tracking.zip` file.
2. Upload **the contents** (not the parent folder) over your existing repository root at `https://github.com/adhkarlyaus/halalframe` and commit to `main`.
3. After Pages deploys, open `https://adhkarlyaus.github.io/halalframe/?v=1.11` and reload the installed app as prompted if a newer service worker is waiting.
4. On Android Chrome, test using `tests/regression/street.mp4` (20 seconds / 960×720 / 30fps). Point to the dark-coat man near x=824,y=350 at time zero, then try **Find all people**. Check the timeline for uncertainty / review gaps before exporting.

GitHub Pages provides HTTPS. Local testing requires HTTP (`python -m http.server 8000`) because browsers restrict ESM modules, service workers, and some WebCodecs on `file://`. No build step is required.

## Why v1.10 failed on real footage

The old track association let weak appearance and distant candidates overrule plausible local motion. With the supplied EfficientDet-Lite0 detections, it could jump at 1 second from the correct person around x=683 to a different person appearing on the far right around x=932. Combined with an unbounded fallback mask, this could blur a stationary or enormous area while leaving the selected person visible. Previous pasted-photo regression clips did not expose this behavior.

## New tracking architecture

- **`js/engine/bytetrack.js`**: independent, original ByteTrack-inspired pixel-space Kalman + Hungarian association. Motion is checked against each predicted box; high-confidence (>=0.50) detections match first, then candidates scoring 0.20–0.50 may continue existing tracks. Strong displacement and geometry gates exclude implausible jumps. Appearance signatures only veto re-acquisition after a gap; they do not override a valid local-motion match. Tracks can be re-acquired near their predicted position for ~1.5 seconds. A tentative detection needs six hits to enter Find All.
- **`js/engine/real-footage-tracker.js`**: one cached sequential scan of **every decoded frame**, with real per-frame EfficientDet detections, frame timestamps, current-frame predictions, and separate seed-anchored forward / backward traces for mid-video taps. There is at most one tracking review prompt during one continuous identity-loss period.
- **Safety**: for no more than one second after losing an object, hold its predicted position with at most 1.3× side growth, limited to 2× median observed box area and 20% of a frame. After that, show a review gap **instead of smearing a large static blur or silently switching people**. Unresolved review gaps block verified export. This is an unavoidable precision/safety tradeoff: do not imply that a detector can reliably identify an occluded person with zero information.
- **Renderer**: pixelate block size scales with person height (rather than the whole frame). AI-selected masks are capped even when padded; user-drawn regions remain under manual control. The existing per-person instance segmentation remains the preferred shape where available.
- **Debug**: shows the current frame's raw boxes and the selected person's current predicted box, rather than boxes from an earlier point on the timeline.

### Known limitations

The provided detections become ambiguous when the selected dark-coat man reaches the standing group at about 2.5–3 seconds. v1.11 correctly declines to change his identity silently: it marks the gap for review and needs a manual box/keyframe to resolve the concealed section. “Always conceal the correct target” cannot be guaranteed without a human decision when the person becomes indistinguishable or is occluded.

**VFR note:** detection coordinates are in video pixel space, and the sequential path retains decoded presentation times for timeline keyframes. Regression media here is CFR, so real VFR Chrome timing still merits device testing.

## Manual and media features preserved

All previously working v1.10 features are retained: Photo editing, Pixelate / Blur, Person Outline, Clear All + Undo, manual boxes and keyframes, Blackout / Reveal Window where enabled, audio Original / Silent / Quick / Best / Studio with optional music risk checking, export-review guard, one-tap tracking, MP4Box→WebCodecs sequential export with WhatsApp presets, the large save/share result sheet, PWA install, disclaimer, About/Credits and Adhkarly branding.

The user’s **both critical MP4Box hotfixes** are **byte-for-byte preserved** in `js/engine/sequential-decoder.js`:

```js
type: (sample.is_sync ?? sample.is_rap) ? 'key' : 'delta'
```

and the loop advancing by the numeric `mp4.appendBuffer(chunk)` next-offset, with fixed-step fallback. The restored v1.9 `firstRun`, share-target, service-worker and `warmAI()` bootstrap block is also preserved in `js/main.js`. v1.11 corrects the v1.10 source that lacked that block.

## Regression and startup tests

Run from the unpacked root:

```bash
node tests/regression/v111-street.test.mjs
node tests/regression/v111-integration.test.mjs
node tests/regression/v111-render.test.mjs
node tests/regression/v111-safety.test.mjs
python tests/v111-aspect.py
python tests/v111-browser-harness.py
```

See `tests/TEST_REPORT.md` for precise measured values and testing caveats. These tests use the **actual 600-frame MediaPipe detection JSON**, rather than synthetic detection trajectories. The `v111-integration` test injects the provided detections into the real application tracking functions. Real browser EfficientDet/PoseLandmarker execution on the deployed site, actual exported CCTV pixels, and Android Chrome performance still need user acceptance testing. The browser startup harness checks real ESM startup with CDN/network unavailable; it cannot substitute for running the deployed site over HTTPS.

The `tests/regression` directory contains your exact `street_real_detections.json` and `street.mp4`. Neither is used by or downloaded through the production interface.

## Privacy and responsibility

HalalFrame is software to assist with concealment, not a guarantee that all awrah or impermissible content is removed. Always preview and personally review the whole result before sharing. An unresolved loss requires manual confirmation. No private media should be collected for training without explicit consent.

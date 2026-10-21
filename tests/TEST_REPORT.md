# HalalFrame v1.12.0 — live Chrome test report

Environment: Chrome desktop (GPU delegate), live GitHub Pages origin, patched
modules loaded through an import-map harness. Test media: public sample footage
of real people (intel-iot-devkit/sample-videos), synthetic music, public-domain
speech (JFK). Every export was decoded in the browser and inspected frame by
frame; audio was measured as RMS in music-only and speech windows.

| Clip | v1.11.1 | v1.12.0 |
|---|---|---|
| Woman, close-up, tilting head (MP4, speech+music) | face partly visible when tilted; arms, shoulders, hair visible | whole person covered every frame, incl. last frame |
| Woman + man (MOV, music only) | woman's arms/body visible | woman fully covered, man untouched (Cover women only); music -21 dB → silent |
| Top-down walkers (WebM) | woman uncovered 1.5–4.2 s; 2nd person missed; tracks swapped; export = silent WebM | woman covered from entrance (pre-roll); both people covered; MP4 export with original audio |
| 4 men, classroom (1080p 30 fps) | covered (rectangles) | tight per-person silhouettes, no background columns |
| Vertical selfie reel (720×1280) | face strip only, eyes visible | hair crown, face, arms at frame edge and body covered; export 48 s → 19 s |
| Photo, woman + man | — | silhouettes only; background between people untouched |

Music removal (Quick model): music-only gaps -30 dB → -75 dB; speech level
within 1 dB; bass under speech reduced 23–28 dB.

Known limits: AI can still miss people (very small, heavily occluded, unusual
viewpoints); gender estimate is intentionally conservative and never a ruling.
Review every export before sharing.


---

# HalalFrame v1.11.1 — Verification Report

## Real MediaPipe dataset: 600 frames, 960×720, 30 fps

The test fixture is the **user-uploaded** `street_real_detections.json`. It was
captured from the real EfficientDet-Lite0 detector in Chrome. No fabricated
pedestrian detections are substituted. The offline suite verifies the tracker,
not an additional live model invocation.

| Check | Result |
|---|---|
| Confirmed Find All identities | **12** |
| Terminal exits that no longer block | Person 1, 2, 3, 4, and Person 6's final terminal loss |
| Distinct unresolved *internal* intervals after normalization | **1** (Person 6, about 9.17–10.60 s) |
| Blocking tracks before manual review | **1** (Person 6) |
| Blocking tracks after explicit review | **0** |
| Optional End cover here resolves the outstanding blocker | **Passed (unit test)** |
| Dark-coat man candidate re-acquisition | **Person 8 at 6.10 s** |
| Person 8 coverage after confirmed re-acquisition | **Through 19.967 s** |
| Unseen interval retained as amber review gap | **2.467–6.100 s** |
| Declining proposed identity | **No silent switch; unresolved gap remains** |

Original v1.11 real-detection metrics remain valid: 12 tracks, 23px maximum
consecutive position jump on the main target, approximately 5.84% average
padded person-box coverage, and 0.71px centre error at 1 second. The new
proposal at 6.10s is a **human-confirmed link**, not proof from appearance alone.

## Regression suite

```text
node --test tests/regression/
35 tests / 35 passing / 0 failing
```

The directory runner internally launches the 35 `*.test.mjs` cases with
`NODE_TEST_CONTEXT` unset; the parent test invocation reports one aggregate
subtest. All 35 individual cases executed (not a false empty-suite success).

## Browser startup and UI

- **Chromium DOM runtime harness: PASS**. Evaluated `main.js` initialization
  with module imports isolated by browser stubs, verified `firstRun`, review-gap
  handlers and clickable modal actions through confirmation; zero page errors.
- **Full HTTP/HTTPS browser navigation: NOT VERIFIED**. Playwright/Chromium
  returned `ERR_BLOCKED_BY_ADMINISTRATOR` for localhost, file:// and intercepted
  HTTPS navigation. This cannot be reported as a successful hosted-page load.
- **Actual Android Chrome, live MediaPipe and exported MP4:** NOT VERIFIED for
  v1.11.1. The owner must run the live-device acceptance checks.

## Safety limitations

A person hidden behind a group cannot be reliably re-identified from detector
boxes alone. The app proposes a plausible candidate and requires **Yes** before
re-linking. The 2.47–6.10s interval stays unrendered/amber until reviewed;
HalalFrame must not pixelate bystanders to hide its uncertainty. The end user
must inspect the result before sharing; neither complete coverage nor religious
compliance is guaranteed by AI.

## Preserved regression-sensitive code

- SHA-256 `js/engine/sequential-decoder.js` matches original hotfixed v1.11:
  `63fc5c4110b4c7ca34b6f9fe534fa3804596c95d8e660f34c22400f15dda0a66`.
- `js/main.js` retains `runModelSelfCheck`, `consumeIncomingShare`, `firstRun`,
  `swRegistration`, `swMessage`, `checkAIReady`, and `warmAI`.
- Original segmentation, music removal and export engines are unchanged.

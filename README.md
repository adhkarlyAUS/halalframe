# HalalFrame v1.8 — Full-head concealment & release polish

This is a **targeted update of the live-tested v1.7 codebase**, not a rebuild. HalalFrame is a static, free, on-device photo/video editor. No videos or photos are uploaded to the developer's server. MediaPipe and audio models download from external pinned hosts on first use, and the local PWA caches supported assets.

**Safety:** AI cannot prove that every pixel of awrah, a person, or music has been removed. Review **every frame and the actual exported file** before sharing. The audio **No audio** option is safest when no music or audio must remain. HalalFrame provides editing tools, not religious rulings.

## Free update of the existing GitHub Pages app

1. Extract `HalalFrame_v1.8_Full_Build.zip`.
2. Upload **the contents of the extracted folder** into the existing GitHub repository root: https://github.com/adhkarlyaus/halalframe. Replace matching files and commit to `main`.
3. Once GitHub Pages deploys, open https://adhkarlyaus.github.io/halalframe/?v=1.8 on Android Chrome. Reload once if necessary. Your old public deployment is not changed until you upload the files.
4. On desktop, you may also run `python3 -m http.server 8000` from the extracted folder. Opening `index.html` with `file://` is not sufficient for ES modules, service workers and AI.

## Changes from v1.7

### Precise full-head concealment

- For outline masks, **preview and export both use `concealmentRect()`**, which includes additional space above the pose detector's highest landmark. Without this, the cap could be cut off even if the mask included hair.
- `headBoundsFromPose()` uses nose, eyes, ears and shoulder landmarks to form a generous cap over the selected person's entire hair/face/head, extending above the eyes and sideways beyond ears. If landmarks are incomplete, it uses a selected-target-only conservative top cap. The body-mask coverage threshold is checked **before** adding the head cap, so a missing torso still triggers a full selected-box fallback.
- `unionHeadRegion()` applies that cap to the **selected person's mask**. The selfie multiclass `hair=1` label is also used on every third analysed frame **within the selected head neighbourhood only**, never as an all-person whole-frame mask.
- Cap, precise instance mask, safety margin and explicit exclusions are combined. v1.7's immediate release of other people when separated is retained, and precision-critical masks still do **not** blend stale previous-frame pixels.
- **Tradeoff:** The cap is conservative and may conceal a little background near the selected person's head, especially with partial/missing landmarks. Real-model hair coverage remains to be tested on Android. No computer-vision guarantee of zero exposed pixels is possible.

### Mobile onboarding

- At viewport widths **below 600px**, Step 2 shows all three Tap → Track → Export illustrations **stacked vertically** with each image about **124px wide** and its readable label. No horizontal swipe needed. Desktop layout is unchanged.
- `tap-person.svg` is redrawn using **one head-and-shoulders silhouette** and a touch **finger/hand with a ripple**, rather than a mouse cursor or extra limbs. Reduced-motion preferences still stop its animation.

### Update notice

- The **Update ready** banner is shown only when a **newer service worker really is waiting**. It is hidden on startup, controller takeover and reload; an already running latest release does not display a stale notification. The existing network-first shell and cache-first model assets continue unchanged. `APP_VERSION` is **1.8**; all module/stylesheet URLs inherit its cache-busting suffix.

### Stricter music check

- YAMNet now differentiates **red** likely music from **amber** weak/moderate music or instrument-like detections, especially **under speech**. Neither red nor amber can be called “Music check passed.” Green only means **no segments were flagged at the configured thresholds**, not music-free certification.
- The report explicitly names the **actual separation model used**: Quick MDX-Net 9482, Best MDX-Net Voc FT, or Studio HTDemucs v4. If Studio fell back to Best, the displayed model says Best. It also lists Gentle/Strong/Maximum strength.
- No music separation model, audio encoder, gate or DSP was changed in this version; the user's live-tested v1.7 Quick/Studio functionality is preserved.

## Tests

Run:

```sh
node tests/regression/v18-head.test.mjs
node tests/regression/v18-maskcache.test.mjs
node tests/regression/v18-music.test.mjs
node tests/regression/v18-update.test.mjs
node tests/regression/v18-release.test.mjs
node tests/regression/tracker.test.mjs
node tests/regression/v17-precision.test.mjs
python3 tests/v18-ui.py
```

The `v18-maskcache.test.mjs` check additionally exercises the actual `MaskCache.compute()` method with simulated MediaPipe outputs at 3, 6.5, 7.5 and 9 seconds, confirming every defined head ROI pixel is concealed and no separated cameraman-only pixel is masked.

The generated head test uses **synthetic pose landmarks** calibrated to the provided `astronaut-360.png` fixture, against the 300-frame two-person crossing geometry: the known image's **hair/forehead/eyes ROI** must be **100% masked**. It also checks zero altered mask pixels in the cameraman-only region after separation. **This is not real PoseLandmarker model inference or exported H.264 pixel analysis**. The audio check uses a **mock YAMNet classifier** to test amber/green logic and verifies the model-attribution code. The update test simulates waiting/active worker states. The mobile page test is run with embedded CSS and assets in Chromium because the test environment blocks navigation to a hosted origin.

Full outcomes and remaining device checks: `tests/TEST_REPORT.md`. Exact change inventory: `CHANGED_FILES_v1.8.md`.

## Live Android acceptance checklist

1. Test `tests/regression/two-person-crossing-10s.mp4`. Tap the **astronaut**, Track →, select Person outline + Pixelate; inspect **3, 6.5, 7.5 and 9 s**, paying particular attention to the hair, forehead and eyes. Check that the cameraman remains clean when separated. Inspect the **downloaded MP4**, not only the editor preview.
2. Open the first-run flow in a clean/incognito browser context. At **390px** width, confirm all three steps are visible at once, and the Tap art is a single human silhouette plus a hand/touch ripple. Avoid clearing site storage if you need to keep saved projects.
3. After deploying and reloading v1.8, confirm the **Update ready** banner does not persist. If a future version actually remains waiting, check that the banner is displayed only then.
4. Run Quick Maximum or Studio with the known music clip. Confirm the risk strip shows **amber** if residual instrument-like YAMNet detections are above the conservative threshold beneath speech, and that the report names the model actually used. Listen before sharing; choose No audio if uncertain.

No server, account, backend or API keys were added.

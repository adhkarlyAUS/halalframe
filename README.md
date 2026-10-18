# HalalFrame v1.3 — An Adhkarly Product

**Deployment:** Static browser files, no build command or paid services. HalalFrame processes selected media locally. Your approved charcoal/lime design and the original `assets/logo.png` are retained.

**Release intent:** Targeted fixes on top of v1.2, which the owner verified on Android Chrome using real MediaPipe: Find all returned one person and 301 positions, while Tap + Track returned 302 positions and no review prompts. This environment could test v1.3's tracking logic with simulated detections, but **did not rerun MediaPipe on Android or verify a real v1.3 export**. Read `tests/TEST_REPORT.md` before release.

## Changes in v1.3

### 1. Force old code to update

- **Single asset version source:** `const APP_VERSION='1.3'` in `index.html`. A startup import map maps internal ES-module paths to `?v=1.3`; the main entry module, CSS, and manifest also receive that suffix. The service worker gets its version from its registration URL `sw.js?v=1.3`.
- **Network-first app shell:** `sw.js` fetches index.html, JS, CSS, manifest and other local app assets using `cache:'no-store'`; if offline, the newest cached shell is used. Large pinned MediaPipe `.wasm` and `.tflite` files are cache-first. Existing `halalframe-ai-v1.1` cache remains intact.
- **Fast takeover:** `skipWaiting()`, `clients.claim()`, deletion of old shell caches at activation. A small "Update ready — tap to reload" banner appears when a new service worker takes control. If the editor has no project open, the app automatically reloads once. When a project is open, users control when to reload.
- **Open-tab check:** on foreground and roughly every 3 minutes, checks the deployed HTML for a new version without relying on HTTP cache.

**One-time migration from v1.2:** Earlier `sw.js` served its cached `index.html` first. If the installed v1.2 app continues to display old code immediately after GitHub upload, open `https://adhkarlyaus.github.io/halalframe/?v=1.3` once in Android Chrome, which uses an uncached query URL to request the new page. If it remains stuck, in Chrome Site settings clear the **site's** stored data and reload, but note this also removes locally saved drafts/AI cache. After v1.3 has taken control, network-first makes future updates easier. The current ZIP **has not been deployed** by this handoff.

### 2. Saved project consent, deletion, and reset

- On loading the same named/sized/resolution-matched video with stored edits, a modal asks **Restore previous edits for this video?** with `Restore` and `Start fresh`. Drafts are never automatically applied.
- `Delete region` immediately persists the deletion. `Clear project` removes all concealments and deletes the saved draft, with confirmation.
- IndexedDB writes and deletes are serialized; queued writes cannot silently resurrect older regions after a delete/clear. Modified time is also saved for improved file matching. This is a local draft, **not** a copy of the actual video.

### 3. Never simply stop when detection fails

- `conservativeGap` covers the last reliable box, increasing its dimensions by approximately 10% per second up to 2×, and unions that with the predicted movement area. This can be wider than 2× overall when required to retain the predicted trajectory.
- `Track → / ←` adds explicit zero-confidence safety points during a detection loss and continues until the chosen time boundary. The only normal way to end early is user action (`End concealment here` or dragging the timeline handle).
- `Find all people` keeps dormant identities eligible for re-acquisition throughout the video, rather than retiring them after 1.5 seconds. During losses it extends masks, and it flags long uncertain gaps for review.
- The re-acquisition routine searches predicted positions first, then searches all person detections in the frame, with size/ambiguity checks before accepting a match. **Identity can still be wrong with crowds, full exits, or unrelated similarly sized subjects.** Review the entire result.
- **Blur** is now the default for new regions. The optional branded effect remains confined to selected bounds; if a non-explicit selection covers almost the entire frame, rendering falls back to solid black. Full-frame branding requires explicit **Intentionally cover entire frame** selection.

## Test clips and repeatable checks

Files included:
- `tests/regression/astronaut-motion-10s.mp4` — 1280×720, 30 fps, 10 s; 380×380 astronaut moving right at 92px/sec on grey with a 440 Hz AAC tone.
- `tests/regression/astronaut-disappears-1s.mp4` — same geometry and tone, astronaut hidden between 4.5s and 5.5s.
- `tests/regression/tracker.test.mjs` — unchanged baseline simulated-tracking regression.
- `tests/regression/v13-safety.test.mjs` — 1s/3s missing-person tests, conservative masks, re-acquisition, Blur default.
- `tests/regression/v13-release.test.mjs` — static asset-version assertions and simulated IndexedDB save/delete race.
- `tests/regression/v13-worker.test.mjs` — simulated service-worker update/caching behavior.

From the project root, with Node 22+:

```sh
node tests/regression/tracker.test.mjs
node tests/regression/v13-safety.test.mjs
node tests/regression/v13-release.test.mjs
node tests/regression/v13-worker.test.mjs
python tests/regression/verify_media.py
```

These tests use controlled/simulated detections and a service-worker mock. They do not exercise real MediaPipe, real Android service-worker takeover or an Android WhatsApp-exported MP4. **No AI system can guarantee every unsafe frame is detected.** A box held after detection loss does not imply it still covers a moving person; review any uncertain sections manually.

## Deploy free on GitHub Pages

1. Unzip and upload **all files inside** `halalframe-v1.3/` into the root of `https://github.com/adhkarlyaus/halalframe`, replacing same-named files, then commit to `main`.
2. Existing repository: under **Settings → Pages**, verify branch `main`, folder `/(root)`.
3. Open `https://adhkarlyaus.github.io/halalframe/?v=1.3` on your Android phone the first time to bypass the previously cache-first page. Verify footer says `v1.3`. Subsequent visits can use the normal URL.
4. Open DevTools Network if possible, or use remote Android debugging, and check `main.js?v=1.3` and `tracker.js?v=1.3` are requested.
5. Load both test MP4s. Confirm one continuous person track and no gaps, Blur default, long-loss masking/re-acquisition, deletion persistence, restore prompt and Clear project. Export MP4 and verify audio/concealment in Android Gallery and WhatsApp. Test update banner with a subsequent release, rather than assuming the mock proves the actual PWA transition.

For local desktop, serve the extracted folder with `python3 -m http.server 8000` and visit `http://localhost:8000`. Opening the HTML directly via `file://` intentionally displays a friendly screen because module imports and service workers require a served origin.

## Core features preserved from v1.2

- MediaPipe EfficientDet-Lite0 person detection and tap selection (pinned `@mediapipe/tasks-vision@0.10.22-rc.20250304`; models pinned to Google v1 asset paths).
- Track forward/backward, Best/every-frame vs Fast/10fps, review dialog, predicted-trajectory association, one-Euro low-lag centre smoothing, conservative mask sizing.
- Timeline, start/end handles, keyframe interpolation, Undo/Redo, manual draw, photo export.
- Outline, Skin, Hair and Box segmentation with box fallback, temporal mask smoothing and caching.
- MP4 export implementation via WebCodecs/mp4-muxer, AAC/FFmpeg fallback, compressed 720p default, Web Share API. **WhatsApp compatibility must be checked on-device.**
- Installable PWA, optional downloaded AI offline cache, on-device processing, About Us and Islamic sharing reminder.

## Changes relative to v1.2

Modified: `index.html`, `css/styles.css`, `js/main.js`, `js/state.js`, `js/engine/tracker.js`, `js/engine/render.js`, `sw.js`, `README.md`, `tests/TEST_REPORT.md`.

Added: `tests/regression/astronaut-disappears-1s.mp4`, `tests/regression/v13-safety.test.mjs`, `tests/regression/v13-release.test.mjs`, `tests/regression/v13-worker.test.mjs`.

All other files remain byte-for-byte unchanged from v1.2.

# HalalFrame v1.4 — An Adhkarly Product

Static, **100% free**, privacy-first photo/video concealment PWA. No build step, login, backend, API keys, or paid APIs. The original `assets/logo.png` remains the approved HalalFrame/Adhkarly identity. All media processing runs locally in the browser; MediaPipe runtime/model files and pinned export libraries are downloaded from their providers as needed. User media is not uploaded to those providers.

**Release basis:** This is a targeted modification of **v1.3**. The owner verified v1.3 running real MediaPipe on Android Chrome: one person from 0–10 s, 301 Find All samples, successful restore/start-fresh, and working code updates. None of the tracking, segmentation, media-encoding, or timeline algorithms have been rewritten in v1.4. The **only render-engine modification** removes the unwanted black/brand effects. Independent Android v1.4 verification remains necessary.

## v1.4 changes

### 1. Credits and Adhkarly ownership

About Us, the final onboarding page, and the footer now attribute the app to **FD Abu Ishaq and Muzzy**, including this requested special thanks:

> Special thanks to my friend Mustapha (Muzzy) for inspiring this idea. I ask Allah that the reward for this goes to him and to all the muwahhideen who are trying to uphold the seriousness of forbidding munkar and encouraging goodness.

The original HalalFrame logo and lime/charcoal theme remain unchanged, as does Adhkarly's purple signature. The Discover Adhkarly links remain intentionally disabled until real links are configured.

### 2. Exactly two concealment effects

- **Pixelate** (default for Tap Person, Draw, Find All and Cover Everyone); strength `42` for strong initial concealment, adjustable `3–60`.
- **Blur** (user-selectable) with the original adjustable strength slider.
- **Black** and **HalalFrame-branded fill** have been removed from the effect menu **and the renderer**. No old effect branches remain in export rendering because preview/export share `renderFrame()`.
- On restoring an old saved draft (and on Undo/Redo), unsupported effects are converted to Pixelate without changing the track, time range, shape or frame coverage. Converted black/brand masks get at least 42 pixelation strength. The selected effect is then saved back to IndexedDB.
- Intentional **Whole Frame** and **Whole Video** editing controls remain available, but can now apply only Blur or Pixelate.

### 3. Splash + required first-run onboarding

At application startup the approved logo appears on a dark animated splash with a live AI-loading state and indeterminate progress. Model initialization is **actually started**; there is no fake percentage. The splash does not hold the user indefinitely on a slow or offline connection (6.5-second soft limit). The model can finish in the background while onboarding is displayed. Reduced-motion settings disable animations.

For new users, full-screen onboarding **blocks the app** until they complete:

1. Welcome
2. How it works — Tap → Track → Export
3. Privacy — media stays on the device
4. Disclaimer — AI can miss people/awrah/frames, full manual review is necessary, and the app does not issue religious rulings.

The last page includes the developer and special-thanks credits. **I accept & start** stays disabled until the checkbox is checked. Consent is saved in `localStorage` under `halalframe-disclaimer-accepted-v1` and is not repeated on ordinary visits. Users can reopen the disclaimer via the footer or About Us, where a review-only mode has a Close action.

**Every** photo or video export now first opens a separate *Have you reviewed the entire result?* modal. Its checkbox must be checked before export begins. The old inconspicuous checkbox was removed.

### 4. Android share-to-HalalFrame (no social downloader)

`manifest.json` declares a Web Share Target (`POST` + `multipart/form-data`) for images/video. When **the installed Android PWA** is selected from the Gallery or Files share sheet:

1. Chrome sends the shared media file to the PWA's **same-origin service worker** at `./share-target`.
2. The service worker intercepts the POST (without a GitHub Pages server) and temporarily saves the shared `File` in **local IndexedDB** (`halalframe-shared-media-v1`).
3. It returns `303 See Other` to `./?shared=<random token>`.
4. After any first-run disclaimer acceptance, the app reads the file, **deletes that local temporary copy**, and opens the existing editor with `openFile()`.

Large files are subject to browser and phone storage limits. If sharing is interrupted before the app imports the file, a local temporary copy may remain until the site data is cleared. Nothing is transmitted to an app backend.

**Platform limitation:** Web Share Target works only with supported browsers and an *installed* PWA, particularly Chrome on Android. Some social apps share a **URL instead of the underlying file**. HalalFrame does not download from YouTube, Instagram, Facebook or TikTok and shows a useful explanation when it receives a link without a media file. For an already-installed v1.3 PWA, Android may not register the new share target until Chrome updates the installed manifest; if it still does not appear, **remove just the HalalFrame home-screen installation and install it again from the updated v1.4 URL**. You do not need to delete the site's saved draft or AI cache for this step.

See [MDN Web Share Target](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/share_target).

### 5. Existing update reliability remains

`APP_VERSION='1.4'` in `index.html` drives CSS, all ES-module paths via import map, manifest and `sw.js?v=1.4`. The service worker remains **network-first for app files**, cache-first for large pinned AI model/wasm files, calls `skipWaiting()` and `clients.claim()`, and cleans old shell caches. An update banner appears if necessary. A shared file import will not be interrupted by automatic update reload.

## Run locally

From the folder with `index.html`:

```bash
python3 -m http.server 8000
```

Open `http://localhost:8000` in a Chrome/Edge browser. For normal Android testing, use the live **HTTPS** deployment. Opening `index.html` with `file://` displays a friendly warning because modules and service workers require a served origin.

## Deploy to GitHub Pages (existing site)

1. Download the v1.4 ZIP, unzip it, and **upload all its contents** (not an extra enclosing directory) to the root of <https://github.com/adhkarlyaus/halalframe>, replacing identical paths. Commit to `main`.
2. Check repository **Settings → Pages → Deploy from branch → main / (root)**; wait for completion.
3. Open <https://adhkarlyaus.github.io/halalframe/?v=1.4> in Android Chrome. The footer must say **v1.4**. Test in a private/incognito context or clear the acceptance key **only if you specifically want to repeat first-run onboarding**.
4. If not installed, choose Chrome's **Install app/Add to Home screen**. Then share a local photo/video **file** from Gallery/Files → Share → HalalFrame. If HalalFrame doesn't appear after updating an existing installation, reinstall the PWA *installation* (not the full origin data), as noted above.
5. Test a real Android export. Check video quality, audio, actual visibility of people/awrah and WhatsApp playback before distributing anything.

## Tests

From the project root, with Node 22+:

```bash
node tests/regression/tracker.test.mjs
node tests/regression/v13-safety.test.mjs
node tests/regression/v13-release.test.mjs
node tests/regression/v13-worker.test.mjs
node tests/regression/v14-release.test.mjs
node tests/regression/v14-share-target.test.mjs
python tests/regression/verify_media.py
```

Optional isolated Chromium UI test, requiring Python Playwright and a system Chromium binary:

```bash
python tests/v14-ui.test.py
```

The DOM UI tests mount the real v1.4 markup, CSS and first-run controller on an isolated Chromium document with a mocked localStorage and AI initializer. They are **not the same as testing the live Android app**. The share-target test executes the real service worker's POST handler against mock IndexedDB rather than a real Android share-sheet registration. Read `tests/TEST_REPORT.md`.

## Retained file structure

`index.html`, `css/styles.css`, `js/main.js`, `js/state.js`, `js/engine/{ai,render,tracker,segmentation,export,ffmpeg-worker}.js`, `js/ui/{canvas-input,timeline,first-run,share-target}.js`, `sw.js`, `manifest.json`, `assets/`, `tests/`, `README.md`.

The previously verified time-based concealment system, moving keyframes, model-assisted tracking, conservative lost-track fallback, local segmentation, offline model caching, photo export and MP4 export logic are preserved. **This software cannot guarantee detection of every impermissible frame. Always review the complete edited file before sharing.**

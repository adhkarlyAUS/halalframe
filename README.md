# HalalFrame v1.1 — An Adhkarly Product

A free, static, privacy-focused on-device photo/video concealment editor. No sign-in, backend, API key, paid API, or media upload. The approved `assets/logo.png` remains in the design (charcoal, lime, purple Adhkarly identity).

**Status:** Browser-interaction and simulated-mask regression checks passed. Real MediaPipe GPU/CPU detection and segmentation, complete MP4/audio export, and installation/offline behavior on Android have **not** been verified end-to-end. Do not publish it as guaranteed to detect all awrah. See `tests/TEST_REPORT.md`. Open `tests/qa-sim.html` over HTTPS to repeat synthetic A/B/E/F browser tests.

## Run / publish (no build step)

Run from a local web server for desktop testing:

```sh
python3 -m http.server 8000
```

Open `http://localhost:8000/`. Opening `index.html` via `file://` deliberately displays a friendly warning because module imports, models, and service workers require a served origin.

### GitHub Pages (free HTTPS)

1. Create a **public** repository at https://github.com/new (example: `halalframe`).
2. Extract the ZIP and upload **the files inside the ZIP** into the repository root (`index.html`, `js/`, `css/`, `assets/`, `manifest.json`, `sw.js`, etc.). Commit to `main`.
3. Repository **Settings → Pages → Build and deployment → Deploy from a branch → `main` → `/(root)` → Save**.
4. Wait for Pages to publish. Visit `https://YOUR-GITHUB-USERNAME.github.io/halalframe/` on Android Chrome.
5. On Android, use Chrome **⋮ → Add to Home screen → Install app**, if the browser recognizes the PWA.

Alternatively, drop the extracted project folder onto https://app.netlify.com/drop for a public HTTPS test deployment. **No URL has been deployed by this package.**

## Core workflow

1. Choose a video/photo from the phone. The file is retained locally in the browser. No upload is performed.
2. `Tap person` to initialize MediaPipe detection, or select `Draw new box` and drag on the canvas. New regions are visible for **three seconds** by default, not the whole video.
3. `Track →` / `← Track` steps through the video at 15 fps. It requests correction for uncertain or lost subjects. For manual regions, select `Add keyframe`, seek on the **separate** timeline slider, and redraw the new position.
4. Select **Box**, **Person outline**, **Exposed skin**, or **Hair only**, plus black/blur/pixelate/brand, padding, safety margin, feather, and optional face-skin inclusion. Skin classification segments pixels, **not Islamic legal rulings**. The model cannot determine male/female religious obligations or guarantee that all awrah was detected.
5. Preview masks in lime. When segmentation is missing/empty, the entire padded box is concealed. The cached masks are used by both editor and export.
6. Tick the manual-review acknowledgement. Export JPG/PNG photos or MP4 video. Default is **720p H.264** with **AAC audio where available**; audio is otherwise copied using offline FFmpeg where possible. When a compatible MP4 cannot be created, the browser may offer WebM **with an explicit warning that original audio is not guaranteed**.
7. Download or use Web Share API to share directly where supported. Check resulting playback and sound before sending.

## Video export & memory limits

- WebCodecs encodes H.264 frame by frame using the exact `renderFrame` routine that draws the preview. Selected `Original`, `1080p`, and `720p` limit the output resolution while preserving aspect ratio. Encoders do not guarantee lossless compression; file sizes are estimates.
- MP4 muxing uses **mp4-muxer 5.2.2**, loaded by a pinned jsDelivr URL. Source video is sought to every frame time offline rather than recording the editor in real time. For 24–60fps material, nearby masks are reused on intermediate frames (roughly 10fps segmentation at 30fps input) while the tracked box is updated on every frame, reducing model work without ever omitting the covering region. Frames are closed immediately after passing them to the encoder; the export has a Cancel button and Wake Lock request.
- Source audio is decoded locally, resampled and re-encoded as AAC when supported. If the built-in AAC encoder is unavailable, FFmpeg single-thread attempts to copy/mux the original compressed audio. This can consume RAM and has browser/codec limitations. Where WebCodecs is unavailable, a browser MediaRecorder/WebM intermediate is converted with FFmpeg if available. A WebM fallback is explicitly labeled and is **not** guaranteed WhatsApp-compatible.
- Do not attempt 1080p multi-minute projects on low-RAM devices. Video projects over 3 minutes display a warning. For best results start with a **10-second MP4 containing audible speech**.
- You must keep HalalFrame open during export; user can Cancel. Exports are generated as Blob objects in local RAM (large files may exceed mobile limits).

## PWA & offline AI

- PWA: `manifest.json`, `sw.js`, 192/512 icons cropped from the approved logo. Shell is cached at install. Service worker is registered only over an HTTPS/localhost origin.
- Version-pinned MediaPipe: `@mediapipe/tasks-vision@0.10.22-rc.20250304` on jsDelivr; pinned Google EfficientDet Lite0 float16/float32 v1 and SelfieMulticlass 256 v1 TFLite models. Initial internet is needed to download AI assets. Service worker then caches its vision bundle, **both SIMD/no-SIMD wasm variants**, and model files; only when every required entry is cached does UI show `AI ready offline ✓`.
- The bundled `assets/test-person.jpg` is a **synthetic illustration**; EfficientDet may not recognize it as a person. The self-check runs on initial load and reports the actual number of detections and GPU/CPU delegate. A zero-person test image does **not** prove the detector fails; test a real photo as well.
- The entire editing pipeline runs in the device's browser; photo/video bytes are not intentionally sent to any service. Google MediaPipe may transmit runtime/usage metrics under its own privacy notice; review it before broad release.
- Browser eviction policies can remove cached files. Test airplane mode and verify the offline badge rather than promising unconditional lifetime offline availability. **FFmpeg is not pre-cached offline**, so offline MP4 fallback may be unavailable; WebCodecs/AAC requires browser support.

## Libraries, licenses, and maintainability

| Dependency | Exact version | Delivery |
|---|---|---|
| MediaPipe tasks-vision | `0.10.22-rc.20250304` | jsDelivr dynamically imported |
| mp4-muxer | `5.2.2` | jsDelivr dynamically imported |
| @ffmpeg/ffmpeg | `0.12.15` | jsDelivr dynamic import (fallback) |
| @ffmpeg/core (single thread) | `0.12.10` | jsDelivr fallback wasm |
| @ffmpeg/util | `0.12.2` | jsDelivr fallback utilities |

`mp4-muxer` is deprecated upstream but intentionally pinned here to meet the requested architecture. FFmpeg components have GPL licensing requirements; review licensing and attribution before public distribution, particularly if ads are added.

## Files

```
index.html
css/styles.css
js/main.js
js/state.js
js/engine/{ai,segmentation,render,tracker,export,ffmpeg-worker}.js
js/ui/{timeline,canvas-input}.js
assets/{logo,icon-192,icon-512,test-person.jpg}
manifest.json
sw.js
tests/TEST_REPORT.md
```

The project stores concealment coordinates, time ranges and settings in IndexedDB (not original video/photo bytes). You will need to select the source file again when restoring a project.

### Safety

The app is a tool, **not a religious compliance guarantee**. Always review the entire output; masks may miss fast movement, near frame boundaries, or covered subjects. `Skin` is a visual pixel classifier and does not decide what is awrah. You remain responsible for checking the media before sharing.

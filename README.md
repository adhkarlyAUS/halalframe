# HalalFrame v1.2 — An Adhkarly Product

A free, static, privacy-focused on-device photo/video concealment editor. No sign-in, backend, API key, paid API, or media upload. The approved `assets/logo.png` remains in the design (charcoal, lime, purple Adhkarly identity).

**Status:** v1.2 patches the v1.1 tracking architecture in place. The original timeline, keyframes, canvas renderer, segmentation, WebCodecs/MP4 export, PWA, brand assets and static hosting layout are retained. The new tracker passed **synthetic detector tests using the exact generated regression clip's geometry**, not a real MediaPipe run. The MP4 *input clip* was verified (H.264 + 440 Hz AAC), but **the v1.2 browser exporter, exported-audio playback, actual MediaPipe model output and Android/WhatsApp compatibility were not verified in this execution environment**. See `tests/TEST_REPORT.md`.

## v1.2 — Tracker corrections

- **Find all people:** `Best` runs once per video frame (30 fps for the supplied regression, capped at 60); `Fast` runs at 10 fps. Best is the default for videos shorter than 30 seconds, Fast for longer clips. The score threshold is **0.18** inside the detector; new tracks require **0.35**. This allows low-confidence detections to continue an established person without inventing too many new people.
- **Association:** moving constant-velocity predicted boxes, prediction-based IoU, centre distance and size similarity. Candidate assignments are one-to-one. Short losses of up to **1.5 s** receive interpolated keyframes. Non-overlapping tracks whose motion and size align can be merged across longer gaps up to **3.5 s**, marked **Review bridged gap** for manual verification; this is not a guarantee of identical identity.
- **Tracking prompts:** a low-confidence match, loss or ambiguous overlap must persist **≥0.5 seconds**, with at least **2.5 seconds** between uncertainty prompts. Scheduled checks (off/2 s/5 s) still work. A clean simulated subject generated **0 prompts**; keeping going continues tracking rather than interrupting every 0.7 seconds.
- **Better coverage:** position smoothing uses a low-lag One-Euro centre filter, while width and height are held conservatively using recent sizes and a maximum-observed safety anchor. An automated region cannot shrink faster than ~10% per second and retains at least 95% of its observed full-body maximum size. Default padding is now **15%**. During uncertain matches, use the union of the predicted and measured region; during loss, cover both last and predicted regions.
- **End here fix:** selecting End concealment here now preserves that end time. Previously finishing the tracking loop could incorrectly reset it to the full video duration. Keep going extends a forward track to the full video end as requested.
- **Self-check:** the non-recognized bundled illustration warning is only displayed when **Debug** is enabled. The person-detection model still initializes normally.
- **Offline upgrade:** v1.2 installs a fresh shell cache while preserving the unchanged v1.1 MediaPipe model cache. A new model download is not required when the existing cached pinned files are still present.

### Reproduce and test the supplied clip

The archive includes `tests/regression/astronaut-motion-10s.mp4` and `astronaut-380.png`, generated using `skimage.data.astronaut()` and FFmpeg. It is exactly 1280×720, 30 fps, 10 seconds, with a 380×380 astronaut image at `x=t*92,y=200` on grey, plus a 440 Hz AAC tone.

To run the **simulated detector tracking regression** (no Node dependencies):

```sh
node --experimental-default-type=module tests/regression/tracker.test.mjs
```

To verify the **input media**, given `ffmpeg`, Python + OpenCV + NumPy:

```sh
python tests/regression/verify_media.py
```

For an **actual model run**: open this app on Android Chrome over HTTPS, import that MP4, choose Best, then use **Find all people** and **Tap person → Track →** at 2 seconds. Confirm exactly one 0–10 s track, no uncovered pixels, and at most one unexpected review prompt. If the AI still fragments, turn on Debug, note the frame times and IDs, and correct those sections before sharing. The included tests cannot prove real-model accuracy.

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
3. `Track →` / `← Track` steps through the video at the selected **Best (every frame)** or **Fast (10 fps)** rate. It requests correction for uncertain or lost subjects. For manual regions, select `Add keyframe`, seek on the **separate** timeline slider, and redraw the new position.
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
- The bundled `assets/test-person.jpg` is a **synthetic illustration**; EfficientDet may not recognize it as a person. Self-check runs in the background; its detailed result and GPU/CPU delegate are only shown when **Debug** is enabled. A zero-person illustration result does not prove detector failure; test an actual video or real photograph.
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
tests/regression/{astronaut-motion-10s.mp4,astronaut-380.png,tracker.test.mjs,verify_media.py}
```

The project stores concealment coordinates, time ranges and settings in IndexedDB (not original video/photo bytes). You will need to select the source file again when restoring a project.

### Safety

The app is a tool, **not a religious compliance guarantee**. Always review the entire output; masks may miss fast movement, near frame boundaries, or covered subjects. `Skin` is a visual pixel classifier and does not decide what is awrah. You remain responsible for checking the media before sharing.

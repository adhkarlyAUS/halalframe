# HalalFrame v1.5.1 — An Adhkarly Product

**Status:** Targeted audio hotfix of the live, user-tested v1.5 PWA. The user confirmed that **Quick ONNX actually runs on Chrome when the worker message is delayed**, along with measured music attenuation; these v1.5.1 startup and Maximum refinements were unit-tested locally, **not yet retested against the real models on Android**. End-to-end cleaned MP4 playback was not re-verified in this build. Do not describe a video as guaranteed free of awrah or music. **No account, backend, server media upload, paid API or API key.** Input photos, video and audio are processed on the user's device. Initial JavaScript/WASM/ONNX model downloads require internet access; only the weights and code, not user media, are fetched from third-party CDNs.

Keep the approved `assets/logo.png` and Adhkarly purple ownership signature. Credits: **Developed by FD Abu Ishaq and Muzzy.** Special thanks to Mustapha (Muzzy) are preserved from v1.4.

## v1.5.1 audio hotfix — targeted changes only

- **Worker startup handshake:** `js/audio/music-worker.js` registers `self.onmessage` synchronously and announces `{type:'ready',version:'1.5.1'}` immediately; `models.js` and `dsp.js` now load lazily after the first process request. `js/ui/audio-panel.js` waits for the ready event **before** transferring buffers, fixing the first-run lost-message race.
- **Never hang without feedback:** both worker startup and processing have a **30-second inactivity watchdog**, reset on worker progress and delegate notifications, with explicit failure messages, `worker.onerror`, `worker.onmessageerror`, and full cleanup on Cancel. The timer protects against hangs; on very slow hardware an otherwise valid model initialization without progress for 30 s may need a retry.
- **Maximum-only tonal cleanup:** after the existing MDX vocal separation and speech gate, an extra overlapping STFT pass learns persistent narrow instrumental frequencies from the **music-only** portions of the original recording, then attenuates matching peaks in the vocal stem during speech. Music-only segments stay muted. This can weaken speech frequencies where they overlap music; **always listen to the cleaned result**. Where the source has no reliable music-only reference, the separate vocal track is retained without pretending a stronger filter ran.
- **Best stays distinct:** Quick uses pinned `UVR_MDXNET_9482.onnx` (**29,704,436 bytes**); Best uses the pinned, larger `UVR-MDX-NET-Voc_FT.onnx` (**66,762,490 bytes**). The selected model name/size is reported to the worker progress display. Both checksums and the model URLs are **unchanged**; the existing `halalframe-audio-models-v1.5` browser cache is intentionally reused so users do not need another large download.
- Only the HTML release version/cache-busting has changed outside the audio code. **No changes to detection, video tracking, MP4 export, installed PWA branding, or saved projects.**

**User-reported real v1.5 Quick-model findings before the hotfix:** 40% speech detection, non-speech music intervals nearly silent, speech RMS 0.144 → 0.127, under-speech attenuation at 131 Hz: −17 dB; 262 Hz: −13 dB; 330 Hz: −5 dB; 392 Hz: −5.5 dB. The new Maximum refinement is not yet measured with this real model. Do not treat synthetic energy improvements as a prediction of results on arbitrary music.

**Hotfix tests (from the extracted ZIP):**

```bash
node tests/regression/v151-worker-handshake.test.mjs
node tests/regression/v151-audio-hotfix.test.mjs
node tests/regression/v15-audio.test.mjs
node tests/regression/v15-release.test.mjs
```

### Android acceptance for v1.5.1

1. Commit the replacement files to the GitHub Pages repository root; open `https://adhkarlyaus.github.io/halalframe/?v=1.5.1` and confirm the footer says **v1.5.1** (no worker hang).
2. Use the user's 10 s speech/music test with Quick + Strong. On first click, expect **worker ready → model download/cache → VAD → separate → cleaned preview** without needing to wait or retry the click. Cancellation and errors must produce visible feedback.
3. Retry **Quick + Maximum**. Listen for residual music under speech and compare intelligibility; the four-tone regression is included only as a **simulation**, not proof of real-world separation.
4. Choose **Best**, verify the UI says **Best · MDX-Net Voc FT** and the download/cache status describes the ~66.8 MB model. Run it on sufficient-memory hardware; test AAC export with the cleaned track, and verify the output in Android Gallery/WhatsApp.
5. Disconnect internet after models are cached and repeat processing to verify offline use. If the worker stalls without any progress for 30 seconds, it should report a recoverable error rather than leave a spinning Cancel button forever.

## How to run and publish free

1. Extract the ZIP. The folder contents must be served from a web root, with `index.html`, `css/`, `js/`, `assets/`, `manifest.json`, and `sw.js` together. Do **not** upload a containing folder one level deeper.
2. For desktop local testing: `python3 -m http.server 8080` inside the extracted folder, then visit `http://localhost:8080`. Direct `file://` opening displays a helpful message instead of running module scripts.
3. For a free public HTTPS app: create/use `https://github.com/adhkarlyaus/halalframe`, upload and overwrite all extracted files into the **repository root**, commit to `main`, then in **Settings → Pages → Deploy from branch → main / (root)**. Open `https://adhkarlyaus.github.io/halalframe/?v=1.5.1` after GitHub Pages finishes.
4. On Android Chrome use **Install app** in the footer / About, or Chrome's menu → **Install app**. Existing installed PWAs may need a fresh installation if Android delays refreshing their manifest/icons. On iPhone use Safari → Share → Add to Home Screen. On standalone launch the charcoal HalalFrame splash still displays.
5. Do a hard refresh if an older document is still open. Versioned imports and the network-first service worker are carried forward from v1.3/v1.4. Old shell caches are removed while downloaded MediaPipe weights remain available offline.

## v1.5 changes — carried forward unchanged from v1.4 tracking and segmentation engines

### Person outline by default

Every selection from **Tap Person**, **Find all people**, **Cover everyone**, and **Draw** uses shape `outline` with Pixelate as the effect. The outline uses MediaPipe's hair, skin and clothing classes within the tracked box; if masks fail/are empty/too small, the preview and MP4 export both use the **full padded box**, never an empty mask. Existing project selections retain their chosen shape. The v1.4 source detection, tracker, timeline, first-run gate, export review, and Adhkarly branding remain intact.

### CLEAR ALL CHANGES

A prominent `↺ CLEAR ALL CHANGES` button appears in the editor header. Its confirmation reads **“Remove all blurs and start again on this video?”**. Confirming clears masks and scan results and persisted drafts, keeping the loaded source. Press **Undo** immediately to restore the previous edits once; the restored project is then saved normally. Existing individual deletion and Start Fresh remain.

### Audio tab and preview

The editor has **Visual** and **Audio** tabs, *before* export:

- **Keep original audio:** Preserves original audio, using the existing WebCodecs AAC / ffmpeg.wasm fallback.
- **No audio:** Final MP4 contains **no audio stream**, not an encoded silent stream. If WebCodecs is unsupported, the FFmpeg fallback uses `-an`.
- **Remove music, keep speech:** Requires user-initiated on-device processing. A Worker loads a speech detector plus a voice-separation model, removes detected non-speech intervals, then hands the generated PCM to the **same existing MP4 video exporter** for local AAC encoding or clean-WAV FFmpeg muxing. If cleaning or muxing fails, export is blocked: the original music is **never silently substituted**.

Audio tab controls: **Quick / Best**, a 3-stop **Gentle / Strong / Maximum slider**, optional **Strict — mute suspect intervals even under speech** (may remove speech), visible model download sizes, backend (WebGPU/WASM), progress, Cancel, and **A/B original vs cleaned** five-second previews. The audio selection is shown on the MP4 export card. Export UI still enforces the user's existing explicit “I checked the result” confirmation.

**Limitations:** MDX models isolate *vocals*, not religiously classify music, and may retain instruments or remove speech. Silero VAD can miss quiet speech or treat singing as vocal content. The strict mode uses **non-voice residual energy**, NOT a separately trained music classifier; it can wrongly mute speech. **There is no scientifically justified 100% guarantee** that a cleaned track has no music. Listen to the complete processed audio before sharing. **No audio** remains the safest available option. Most Android devices will take significantly longer than real time to separate longer audio; 120 s maximum, Best reduced to 45 s on devices reporting ≤4 GB RAM. Short clips recommended.

### Exact pinned models, size, licence and sources

All models are fetched directly by the Worker only after the user presses **Download model & clean audio**; results are locally SHA-256 checked on first download and stored in CacheStorage `halalframe-audio-models-v1.5` for subsequent use offline. Model weights are **not packaged in the small ZIP**. Model metadata and immutable URLs are in `js/audio/models.js`.

| Model/engine | Use | Remote weight size | Reported licence | Immutable origin |
|---|---|---:|---|---|
| Silero VAD ONNX | Speech activity; 16 kHz, 512-sample steps + 64 context | ~2.33 MB | MIT | [snakers4/silero-vad, commit 60b7ffa](https://github.com/snakers4/silero-vad/tree/60b7ffa243625ebdc1070275a29f18c87843786a) |
| **Quick** UVR MDXNET 9482 ONNX | Vocals vs accompaniment | 29,704,436 bytes (~29.7 MB decimal) | MIT-licensed HF model repository | [Politrees/UVR_resources — MDXNet/UVR_MDXNET_9482.onnx](https://huggingface.co/Politrees/UVR_resources/blob/main/models/MDXNet/UVR_MDXNET_9482.onnx) at `8cc4418db60d96e501f42889370b8bf3eb6df2d2` |
| **Best** UVR MDX-NET Voc FT ONNX | Larger vocal separation model | 66,762,490 bytes (~66.8 MB decimal) | MIT-licensed HF model repository | [Politrees/UVR_resources — MDXNet/UVR-MDX-NET-Voc_FT.onnx](https://huggingface.co/Politrees/UVR_resources/blob/main/models/MDXNet/UVR-MDX-NET-Voc_FT.onnx) at same commit |
| ONNX Runtime Web | Local WebGPU, with WASM fallback | Browser engine + wasm (CDN) | MIT | `onnxruntime-web@1.22.0` via jsDelivr |

**Deliberate model choice:** Quick uses a **29.7 MB MDX-Net vocal separator**, not DeepFilterNet3. DeepFilterNet's complete native signal chain isn't supplied as a single directly usable browser ONNX model in this app. The Quick and Best models here are both *vocal-isolation* models, with verified Hugging Face file records, SHA-256s and pinned revision. **Verification of file existence and hashes is not equivalent to successful model execution on Android**. The licence noted above is the host repository's MIT declaration; verify all upstream weight provenance/licence obligations before wider commercial advertising distribution.

**Important hosting/CORS constraint:** GitHub Pages is a static host. Third-party model URLs must permit CORS and large cross-origin streaming requests. If a host blocks the browser, this release shows a failure, never a fake successful result. The engine can be reconfigured to vend weights as static files on GitHub Pages (no backend) if permitted by redistribution terms and repository limits.

### Audio pipeline detail

`js/audio/music-worker.js` (ES module worker) starts with a synchronous ready handshake, then loads `onnxruntime-web@1.22.0`, negotiates WebGPU→WASM, verifies and caches weights, resamples source audio to 16 kHz for Silero VAD, runs speech scoring, applies a padded/smoothed time gate, and resamples stereo to 44.1 kHz for MDX-Net STFT. Quick: `4096`-point FFT, `[1,4,2048,256]` input; Best: `6144`-point FFT, `[1,4,3072,256]` input. Outputs are inverse-STFT'd, crossfaded, filtered to detected speech, and handed back as transferable buffers. `js/audio/dsp.js` implements the STFT/iSTFT and resampling. Worker cancellation terminates model operations; no server execution.

The visual display is not coupled to cleaning progress, and the original photo/video remains on-device. Videos are not modified in their source file. In the optional cleaned export mode the AAC encoder uses **cleaned PCM**, not original audio. On unsupported AAC WebCodecs it may fall back to local FFmpeg with a **cleaned WAV** input; if that fails, it must error rather than leak original music.

### Installable app and artwork

All visual branding reuses the approved image. The app icon is an isolated **lime frame glyph on charcoal** from the approved logo, with safe padding. New PNGs: `assets/icon-{48,72,96,128,192,256,384,512}.png`, `assets/icon-maskable-512.png` (mark contained inside the centre maskable safe zone), `assets/apple-touch-icon.png` (180×180), `assets/favicon-32.png`, plus `assets/screenshot-{welcome,editor,audio}.png` at 390×844. `manifest.json` includes stable identity, standalone display, app category/description, icons, Android Share Target, and three narrow screenshots. `sw.js` caches app shell/version 1.5, optional ONNX assets after first use, and retains the pinned MediaPipe cache.

## Regression tests and how to verify on Android

Run from repo root:

```bash
node tests/regression/tracker.test.mjs
node tests/regression/v13-safety.test.mjs
node tests/regression/v13-worker.test.mjs
node tests/regression/v14-share-target.test.mjs
node tests/regression/v15-release.test.mjs
node tests/regression/v15-audio.test.mjs
ffprobe -v error -show_streams tests/regression/speech-music-regression-10s.mp4
```

A 10-second **speech plus synthetic musical loop** fixture is included at `tests/regression/speech-music-regression-10s.mp4`, and separate reference WAVs at `tests/regression/speech-reference.wav`, `music-reference.wav`, and `speech-music-mix.wav`. Run `python tests/regression/make_audio_regression.py` to recreate with system FFmpeg and `espeak`; see test report for simulated energy measurements. They do **not** measure the actual neural model output. For genuine validation, install on Android Chrome, open that video, choose Audio → Remove music → Quick → Process, compare voice against original, repeat with Best, and play the exported 720p MP4 locally and in WhatsApp. Also test **No audio** and verify the MP4 has no audio track using a media inspector or FFprobe on a desktop. For installation, check the home-screen icon, splash and Share-to-HalalFrame. Report CPU/memory and any console errors.

**GitHub Pages upgrade:** Upload everything, not only the modified files, over v1.4 and commit. The service worker uses `?v=1.5` and network-first shell fetch. After deployment, visit `https://adhkarlyaus.github.io/halalframe/?v=1.5`; if an installed app has old icons, reinstall its home-screen icon. No access to the GitHub account is assumed and this ZIP is not live until the user deploys it.

Read `tests/TEST_REPORT.md` for exact Pass/Simulation/Not Verified distinctions.


## Exact changed-file inventory versus v1.4

**Modified (11):**
`README.md`, `assets/icon-192.png`, `assets/icon-512.png`, `css/styles.css`, `index.html`, `js/engine/export.js`, `js/main.js`, `js/state.js`, `manifest.json`, `sw.js`, `tests/TEST_REPORT.md`.

**Added (24):**
`assets/apple-touch-icon.png`, `assets/favicon-32.png`, `assets/icon-128.png`, `assets/icon-256.png`, `assets/icon-384.png`, `assets/icon-48.png`, `assets/icon-72.png`, `assets/icon-96.png`, `assets/icon-maskable-512.png`, `assets/screenshot-audio.png`, `assets/screenshot-editor.png`, `assets/screenshot-welcome.png`, `js/audio/dsp.js`, `js/audio/models.js`, `js/audio/music-worker.js`, `js/ui/audio-panel.js`, `tests/regression/make_audio_regression.py`, `tests/regression/music-reference.wav`, `tests/regression/speech-music-mix.wav`, `tests/regression/speech-music-regression-10s.mp4`, `tests/regression/speech-reference.wav`, `tests/regression/speech-source.wav`, `tests/regression/v15-audio.test.mjs`, `tests/regression/v15-release.test.mjs`.

**Removed:** None. The original `assets/logo.png`, tracking, segmentation and timeline implementation were not modified.

# HalalFrame v1.9 — Sequential Export & Phone Video Compatibility

HalalFrame remains a **100% free**, **static**, **on-device** editor by Adhkarly. No accounts, no upload backend, no paid APIs, and no server processing of your media. The previously verified v1.8 on-device tracking, person outline segmentation, splash/onboarding, YAMNet verification, MDX/HTDemucs and Pixelate/Blur are preserved. This is a focused export/compatibility release.

**Safety:** AI is imperfect; no exported video can be certified to contain no visible awrah or music. Review the **entire exported file** before sharing. Use **No audio** to remove all sound. HalalFrame does not issue religious rulings.

## Publish on GitHub Pages

1. Download and extract `HalalFrame_v1.9_Sequential_Export.zip`.
2. Upload the **contents** of the folder to https://github.com/adhkarlyaus/halalframe (repository root); overwrite matching files, commit to `main`.
3. Once deployment finishes, open https://adhkarlyaus.github.io/halalframe/?v=1.9 . Versioned CSS, modules and service worker update automatically. The current live site will remain on the last deployed version until you do this.
4. To develop locally, run `python3 -m http.server 8000` from this folder and open `http://localhost:8000/` (not `file://`, which cannot load ES modules and service workers reliably).

## What changed

### Export — no per-frame seeking

- **New** `js/engine/media-probe.js` imports **mp4box@2.4.1** from a pinned jsDelivr URL and reads MP4/MOV metadata locally. Provides codec, approximate bit depth, audio codec, source dimensions, reported fps/duration and tkhd rotation. Tests `VideoDecoder.isConfigSupported` at import.
- **New** `js/engine/sequential-decoder.js` extracts compressed samples incrementally with MP4Box, then feeds them **in DTS order** to WebCodecs `VideoDecoder`, which outputs display frames. Compressed samples and decoded `VideoFrame`s are released. Frame PTS are carried to the export timestamps, keeping VFR timing (in Original fps mode). There is **no video.currentTime seek inside the primary export frame loop**. Progressive queue limits reduce memory use but **cannot guarantee** 3-minute mobile export without exhausting memory.
- `js/engine/export.js` uses the existing shared `renderFrame()` and `MaskCache` for every decoded frame, followed by WebCodecs video encoder and pinned **mp4-muxer@5.2.2** or **webm-muxer@5.1.4**. WhatsApp output uses MP4 fast-start with H.264 and AAC when supported. Output timestamps use source presentation timestamps; the fps setting may drop excess frames, not repeat source frame seeks. Hardware acceleration is requested but never presumed.
- **New** `js/engine/sequential-analysis.js` supplies the **same sequential stream** to Find All People and forward Track analysis. **Backward tracking and user scrub** still use the browser's native seek, with an 18–22s timeout/retry; neither is part of the main export loop.
- If browser WebCodecs is unavailable, the app attempts **realtime** video playback into `canvas.captureStream` + `MediaRecorder`, followed by `ffmpeg.wasm` conversion/remux to MP4. If that conversion fails, the UI will clearly identify WebM as a non-WhatsApp fallback. Recording at 1× speed cannot offer an accelerated export.

### Phone formats / conversion

At import, the app inspects MP4/MOV tracks and checks `VideoDecoder.isConfigSupported`. If unsupported, a card offers **Convert for editing** and **Copy diagnostic info**. Diagnostics include container, codec string, bit-depth estimate, dimensions, fps, duration, orientation, browser, WebCodecs availability, error code and cause.

- **New** `js/engine/conversion.js`: explicit local `ffmpeg.wasm` single-thread H.264, 8-bit, 30 fps conversion. For HDR it **tries** an FFmpeg zscale/tonemap filter, then a simple 8-bit fallback (which can change HDR colour). **Important:** the official FFmpeg.wasm core may lack HEVC, HDR tone-map filters or suitable encoders, or may exhaust phone RAM. Such files can therefore still fail. In those cases the app says to use a phone compatibility/H.264 export or desktop converter. This is **not** an unconditional browser HEVC compatibility guarantee.
- MP4Box handles `.mp4`, `.m4v`, and `.mov`; `.webm` and other containers use a separate realtime fallback, not the MP4 demuxer. MOV rotation and VFR behavior still require real-device testing.
- Some browser build combinations support HEVC, others cannot decode it. HEVC HDR/Dolby Vision tone mapping requires validation and may not preserve metadata/colours.

### Export controls

| Preset | Picture | FPS cap | Target video bitrate | Audio target | Guidance |
|---|---|---|---|---|---|
| WhatsApp (default) | 720p shorter side, keep orientation | 30 | 1.8 Mbps | AAC 96 kbps stereo | Widest compatibility, fast-start MP4 |
| Small | 540p | 30 | 900 kbps | AAC 64 kbps | Lower size |
| Tiny | 360p | 24 | 450 kbps | AAC 48 kbps mono | Strong compression |
| HD | 1080p | 30 | 5 Mbps | AAC 128 kbps | Higher quality |
| Original | Source dimensions | Source or selected | Adaptive | AAC 128 kbps | May be large |
| Fit under N MB | 720p | 30 | Calculated after reserving audio | AAC 96 kbps | Estimate, **not guaranteed limit** |

Codec advanced options: H.264 MP4 by default; optional H.265 MP4 (newer compatible phones), VP9 WebM, AV1 WebM (do **not** label these WhatsApp compatible). Frame rate: 24/30/original; audio bitrate, mono/stereo and quality/speed settings. Unsupported video encoders are disabled using `VideoEncoder.isConfigSupported`. Estimated file sizes are estimates only, not predictions of exact size.

### Audio controls

The Audio tab includes **Tips for best results**, **Mute all red/amber parts** from the YAMNet strip, and **Mute this section** with editable start/end time. Fades prevent clicks. Muted sections feed the exported **modified PCM**, so they are not merely a preview effect. Songs with singing can remain in the vocal stem: select **No audio** or manually mute those sections. If the audio cannot be encoded, the app must not substitute unmodified original music behind a “cleaned” label.

### Compatibility library pins

- `mp4box@2.4.1`, BSD-3-Clause: `https://cdn.jsdelivr.net/npm/mp4box@2.4.1/dist/mp4box.all.mjs`
- `mp4-muxer@5.2.2`: `https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.2/build/mp4-muxer.mjs`
- `webm-muxer@5.1.4`: `https://cdn.jsdelivr.net/npm/webm-muxer@5.1.4/build/webm-muxer.mjs`
- Existing pinned `@ffmpeg/ffmpeg@0.12.15`, `@ffmpeg/core@0.12.10` and `@ffmpeg/util@0.12.2` remain.
- The service worker loads versioned application files **network-first** and caches codec modules after first use. Large model/wasm files remain cache-first once downloaded.

## Reproduce the export test matrix

1. `bash tests/make_v19_fixtures.sh` generates all five synthetic input types (requires native FFmpeg including libx265).
2. `node tests/regression/v19-sequential.test.mjs` checks the app's sequential export/preset path, source orientation and import diagnostics.
3. `python3 tests/v19_matrix_cli.py` converts the sample fixtures via **native system FFmpeg** and writes `tests/v19-cli-benchmarks.json` + test MP4s. These results only show sample validity/compatibility when transcoded with native FFmpeg; they are **NOT** results of running the browser app or proof of WhatsApp compatibility.
4. On Chrome Android, upload each fixture, confirm VideoDecoder support/Convert handling, export WhatsApp preset, record actual elapsed time, compare masked preview to output and inspect audio; play it in Gallery and send through WhatsApp. Repeat 3-minute input on a midrange device while monitoring memory.

See `tests/TEST_REPORT.md` for the five-row status matrix and honest validation notes; `CHANGED_FILES_v1.9.md` lists the precise changes against v1.8. Historical release tests with explicit `APP_VERSION=1.8` expectations are preserved as historical and will not pass by design against v1.9; use the v1.9 regression check instead.

## Known limitations

- **Not yet verified end-to-end with real WebCodecs/MP4Box in Chrome Android**. The runtime executing this build blocked hosted-browser integration tests. Native FFmpeg benchmarks are a **different implementation**.
- **No guaranteed realtime-speed export**: per-frame seeking is removed but CPU masks, model segmentation, encoder support and GPU allocation may remain slower than source duration, especially on phones.
- HEVC Main10, Dolby Vision, portrait rotation, long GOP and VFR output require Android acceptance testing.
- `ffmpeg.wasm` is no-cost but slow and memory-heavy. Its codec/filter capabilities vary; conversion is best-effort, not assured.
- The audio decoder may not support particular MOV tracks, and AAC `AudioEncoder` support varies. The app can attempt a slower FFmpeg audio-copy fallback; inspect exported audio for your device.
- Cache-busting uses APP_VERSION **1.9**. Existing v1.8 user edits remain local; no media leaves the tab.

## Android acceptance checklist

- Open `https://adhkarlyaus.github.io/halalframe/?v=1.9` **only after publishing**; confirm version label **1.9**.
- Export 30 s long-GOP H.264 at WhatsApp quality: no “Seeking this video timed out”, inspect output frames/audio/latency.
- Test HEVC portrait and HDR and, if unsupported, the conversion warning. Do not assume that `ffmpeg.wasm` supports HEVC.
- Test rotated MOV/VFR with a clear visual orientation landmark; check source/output orientation and audio sync.
- Export the 3-minute video and monitor memory; report if Chrome tab reloads.
- Use the audio tab's red/amber mute tool and manual mute section, then confirm **the actual exported MP4** contains the edit.
- If anything fails, tap **Copy diagnostic info** and share the text/error code for a targeted hotfix.

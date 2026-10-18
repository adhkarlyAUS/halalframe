# HalalFrame v1.10 — guided one-tap editing and delivery

A static, fully on-device photo/video editor. **Free; no accounts, no app backend, no uploaded media or paid APIs.** Initial AI/audio weights and pinned JavaScript libraries download from their providers when needed. Maintains the approved charcoal/lime HalalFrame and purple Adhkarly branding.

## Install or deploy

1. Extract `HalalFrame_v1.10_Full_Build.zip`.
2. Open your existing GitHub repository `https://github.com/adhkarlyaus/halalframe`, upload **all extracted contents** to the root (not a containing subfolder), replace changed files and commit to `main`.
3. After GitHub Pages completes, visit `https://adhkarlyaus.github.io/halalframe/?v=1.10`. A fresh service worker should cache the versioned app shell. If still stale, close the installed app and reopen / update.
4. Locally, serve the extracted directory over HTTP/HTTPS (`python -m http.server 8000`) rather than opening `index.html` as `file://`; media APIs and service workers need a secure context. **No build step.**

## One-tap people tracking

Pause a video and tap a person. The same source person is followed immediately to the end **and backwards to the start**, with a clear progress overlay and Cancel button. No separate Track → action is required. Find All and Cover Everyone create whole-duration timeline bars from a full-video scan. Manual Draw areas are still time-limited by design.

On uncertainty, the app retains a conservative safety region and can request confirmation for ambiguous identity transitions. Simple disappearance and re-entry is handled automatically. If tracking cannot finish, an incomplete status is shown and Export presents an actionable Finish tracking / Back to editor modal. A user who **deliberately** sets an End Here point retains that manual override. No algorithm can guarantee it detects every instance of awrah; the entire preview and export must still be reviewed.

## Guided Export (three stages)

1. **Complete person tracking.** Any unfinished person selection must be completed (or explicitly ended manually). Export does not silently accept an accidentally three-second AI region.
2. **Prepare audio.** Original, No audio or Remove music, keep speech. For Cleaned Audio, Export itself launches the pinned worker (Silero + Quick/Best/Studio) and YAMNet check, showing progress. An amber/red or unverified result triggers a **persistent modal** offering Mute risky parts and export, No audio, Export anyway (explicit acceptance of risk), or Go back and review. If the model fails, select Retry, No audio or Back—never a silent substitute of the original soundtrack.
3. **Encode and deliver.** The existing hotfixed MP4Box → WebCodecs → canvas → H.264 encoder/muxer is retained. Output opens in a full-screen mobile-friendly result sheet with a playable preview, output size, Save to phone and Share to WhatsApp (via the native browser share sheet). The app requests **one automatic download** on Android/desktop, then leaves a manual Save button and a session-only Recent exports list.

### Browser download limitation

Web applications cannot inspect or guarantee the device's Downloads folder, and an automatic download may be rejected after asynchronous work. The UI therefore says "Download requested" rather than falsely claiming "Saved". On Android inspect Files → Downloads or Chrome Downloads. On iPhone use the system Share sheet → Save Video. For WhatsApp, select WhatsApp in the system sheet; automatic silent delivery to WhatsApp is not a supported web capability.

Filename pattern: `HalalFrame_<original_name>_<YYYY-MM-DD>.mp4`. WebM fallbacks are always labelled `.webm`, not disguised as MP4. Blob URLs remain in this tab for up to four recent exports or a bounded memory limit; save before closing the browser.

## Technical protection

This build was created from `HalalFrame_v1.9_Hotfixed_Baseline.zip`, **not** the original broken v1.9 archive. `js/engine/sequential-decoder.js` remains byte-identical, retaining `sample.is_sync ?? sample.is_rap` and the `mp4.appendBuffer()` next-offset loop. The existing instance masks, video export pipeline, on-device audio models and user privacy controls have not been rewritten.

## Testing

Run `node tests/regression/v110-coverage.test.mjs`, `node tests/regression/v110-auto-tap.test.mjs`, `node tests/regression/v110-reentry.test.mjs`, `node tests/regression/v110-audio-orchestration.test.mjs`, `node tests/regression/v110-export-ux.test.mjs`, and `python tests/v110-ui.test.py` (requires Playwright + Chromium).

See `tests/TEST_REPORT.md` for results, limitations and real-device checklist. See `CHANGED_FILES_v1.10.md` for exact files modified or added. **Real Google tracking, real ONNX music cleaning, MP4 audio playback and device Downloads are not claimed as verified in this container.**

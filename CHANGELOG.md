# Changelog

All notable changes to ZoomArc are documented here, newest first.

> **A note on completeness:** detailed notes exist for every version from 0.10.0 onward. Versions 0.1.0 through 0.9.4 were early, rapid iteration (several same-day releases) before this changelog existed — they're listed below with their real release dates for the record, but without invented feature lists. Please don't read anything into their brevity beyond "detailed notes weren't kept at the time."

## [0.12.0] — 2026-10-07

The precision-recording release: a new native recording engine, exact 1:1 cursor motion, and a redesigned recording screen.

### Added
- **Native 60fps recording engine (Windows).** Screens and windows are now recorded by the native capture module straight into a hardware-encoded H.264 MP4 — frames go GPU-to-GPU into the encoder and never pass through the app. Measured: a true **60 fps** capture (previously ~16–24 fps through the old path), held on 60, 120 and 144 Hz displays alike.
  - Captures on the GPU that actually drives the recorded monitor (hybrid Intel/NVIDIA laptops previously paid a cross-GPU copy per frame).
  - Lifts Windows' default capture-rate throttle where supported (Windows 11 24H2+).
- **Native cursor sampler.** The real system cursor is read **2,000 times a second** on its own high-priority thread, stamped on the same hardware clock as the video frames — so cursor and video line up exactly by construction, with no estimated offsets. Also records clicks, when Windows hides the cursor (it now hides in the replay too), and the recorded window's position if you move it during a window recording.
- **Exact 1:1 cursor replay.** The drawn cursor now reproduces your real movement exactly; verified pixel-accurate (~1 px) against on-screen content. The Cursor panel's Smoothing slider (now defaulting to 0%) still blends toward a smoothed glide if you want one.
- **New zoom & camera motion engine.** Zoom is interpolated in log space (an even push instead of one that accelerates), pan and zoom move as one motion, the camera can no longer slam into a screen edge, and the follow looks slightly ahead so it doesn't trail the cursor. Measured 20–30× smoother camera motion on real recordings, with zero edge-stops (previously hundreds per take).
- **Keyboard shortcuts** throughout the editor (44 in total): playback (Space/K, J/L, frame and second steps, jump between edit points, Home/End), editing (split, trim to playhead, nudge, copy/cut/paste/duplicate, delete, undo/redo), tools, timeline zoom, fullscreen and export.
- **Keyboard Shortcuts overlay** — press **?** or **Ctrl+/**, or use **Help → Keyboard Shortcuts**.
- **ZoomArc Help menu** replacing Electron's default one: Keyboard Shortcuts, ZoomArc on GitHub, What's New, Report an Issue, About ZoomArc.
- **Redesigned recording screen**: a dark card with a purple dial that counts recorded minutes (the tick ring turns with the seconds), live timer, REC/fps status, chips showing exactly what's being captured (source, mic, camera, frame rate), a gradient Stop button and the global stop hotkey. Matching countdown and saving states.
- **New logo and app icon** everywhere — title bar, favicon, window/taskbar icon, installer and app icons (`.ico`/`.icns`). `scripts/make-icons.cjs` regenerates them all from `logo/`.
- **Live previews for every monitor**, including ones the browser engine can't see.

### Fixed
- **Video falling behind the cursor in longer recordings** — frames could queue up without limit when the screen changed quickly; the video was measured 6+ seconds behind the cursor after 15 s of motion. Gone entirely with the native engine.
- **Cursor stutter during drags**, and cursor "teleporting" between clicks when mouse events were delivered late — fixed by native sampling (and, for the fallback path, by correcting late events using the OS's own timestamps).
- **Window recordings: cursor in the wrong place** — positions weren't offset by where the window sat on screen.
- **Editor preview drift** — the preview tolerated up to 150 ms of cursor-vs-video mismatch; it's now locked within ~10 ms.
- **Cursor drawn from the wrong moment after trimming, splitting or moving a clip** in the editor.
- **Exports showed the built-in arrow instead of your custom cursor** — the export never loaded the cursor image.
- **Cursor stuck at the screen edge** while the pointer was on another monitor — it now fades out instead.
- **Main display missing from the recorder** on hybrid-GPU laptops (the browser engine only listed one GPU's monitors); all monitors are now listed, main display first. Also fixed source cards collapsing when no preview was available.
- **Redo did nothing**, and edits could record duplicate undo steps (most visible in development builds).
- **Selection lost when a zoom merged into another**, which made Delete/Duplicate silently do nothing.

### Changed
- Native recordings are saved as `raw.mp4` (H.264, mic as AAC); older `raw.webm` takes still open and export as before.
- Mic and webcam recordings are aligned to the first video frame when a take is saved.
- Recordings made before 0.12.0 keep their original cursor timing (they get the new smoothing and sync improvements, but not native-clock precision).

## [0.11.1] — 2026-09-28

### Fixed
- The native Windows Graphics Capture module (the guaranteed cursor-exclusion fallback added in 0.10.0) silently failed to load in the **packaged app** — it worked fine in development, which is why this wasn't caught in 0.11.0. Anyone running the 0.11.0 installer or portable build would fall all the way through to the "can't exclude the cursor" error on every recording, even on a fully up-to-date system, since the fallback that's supposed to catch exactly that case wasn't actually available.
  - Root cause: `native/wgc-capture`'s own `package.json` (which marks that one folder as CommonJS, overriding the project's own `"type": "module"`) was never included in the packaged build — only its `index.js` and compiled `.node` binary were. Without it, Node fell back to the project-wide module type and refused to load the addon (`require() of ES Module ... not supported`).
  - Fix: added the missing `package.json` to the packaging file list. Verified directly against a freshly packaged build (not just in dev mode this time) — the native module now loads correctly and cursor exclusion works as intended.
- **If you installed 0.11.0, update to this version** — 0.11.0's packaged build cannot exclude the cursor from recordings on any machine, regardless of Windows version or graphics driver.

## [0.11.0] — 2026-09-20

Packaging/release bump — no functional changes from 0.10.0. Built and published as the first GitHub Release, with the native capture module included in the packaged build for the first time.

## [0.10.0] — 2026-09-19

The cursor-exclusion and reliability release.

### Added
- **Native Windows Graphics Capture module** (`native/wgc-capture`) — guarantees the OS cursor is excluded from a recording by talking to Windows Graphics Capture directly, used automatically whenever the browser's own capture backend doesn't honor a cursor-hidden request (verified against the stream's actual negotiated settings, never assumed)
- The same native module now also handles **single-window recording** — fixes recordings freezing on one frame partway through while real on-screen activity continued (traced to the browser's own window-capture backend silently re-serving a stale frame on failure instead of erroring)
- Absolute, free-form dragging and resizing for the webcam pill, plus an adjustable corner-radius option for a square pill shape
- Custom cursor image upload with a click-to-set hotspot marker, sized independent of the current zoom level (matches how most screen recorders keep a drawn cursor's on-screen size constant)
- **"Set as default cursor"** — save an uploaded cursor image (and its hotspot) as your standing preference, so new recordings start with it already applied instead of the built-in arrow
- 60fps capture target for smoother zoom and motion
- Independent, capture-time cursor and click tracking, fully decoupled from video frame rate

### Fixed
- Frame mode (the zoom-fills-the-canvas behavior) no longer stretches/squeezes the picture when the output aspect ratio doesn't match the recording's own — it now crops to match instead of distorting
- A black flash at the very start of every native-path recording (the canvas was captured before its first real frame had arrived)
- An intermittent crash right after stopping a recording, caused by a frame-delivery callback re-entering JS from inside the same handler that was already tearing it down
- The "Draw smoothed cursor" panel's Size slider visually overlapping the "Upload cursor image" button below it (a spacing regression, not a slider-specific bug)
- Every slider's drag handle rendering visibly off-center from its track

### Removed
- The legacy screen-capture path (`getUserMedia` with `chromeMediaSource`), which could never exclude the OS cursor under any configuration — recording with the cursor baked in is no longer a supported mode
- The now-meaningless "Smooth cursor" toggle from the capture screen

## [0.9.4] — 2026-09-03
## [0.9.3] — 2026-09-03
## [0.9.2] — 2026-09-03
## [0.9.1] — 2026-09-03
## [0.9.0] — 2026-09-03
## [0.8.2] — 2026-09-03
## [0.8.1] — 2026-09-03
## [0.8.0] — 2026-09-03
## [0.7.0] — 2026-09-03
## [0.6.5] — 2026-09-03
## [0.6.4] — 2026-09-03
## [0.6.3] — 2026-09-03
## [0.6.2] — 2026-09-03
## [0.6.1] — 2026-09-03
## [0.6.0] — 2026-09-03
## [0.5.0] — 2026-09-03
## [0.4.1] — 2026-09-03
## [0.4.0] — 2026-09-03
## [0.3.0] — 2026-09-03
## [0.2.0] — 2026-09-02
## [0.1.0] — 2026-09-02

Early development.

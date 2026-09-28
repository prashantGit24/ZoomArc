# Changelog

All notable changes to ZoomArc are documented here, newest first.

> **A note on completeness:** detailed notes exist for every version from 0.10.0 onward. Versions 0.1.0 through 0.9.4 were early, rapid iteration (several same-day releases) before this changelog existed — they're listed below with their real release dates for the record, but without invented feature lists. Please don't read anything into their brevity beyond "detailed notes weren't kept at the time."

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

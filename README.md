<p align="center">
  <img src="Recorder Logo.png" alt="ZoomArc" width="120" />
</p>

<h1 align="center">ZoomArc</h1>

<p align="center">
  A screen recorder that zooms in on your clicks automatically, with a full non-destructive editor to shape the result — no OS cursor baked into the recording, ever.
</p>

<p align="center">
  <img alt="version" src="https://img.shields.io/badge/version-0.11.1-7c5cff">
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows-0078D6">
  <img alt="built with" src="https://img.shields.io/badge/built%20with-Electron%20%2B%20React-61dafb">
  <a href="LICENSE.md"><img alt="license" src="https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue"></a>
</p>

<p align="center">
  <a href="https://github.com/prashantGit24/ZoomArc/releases/latest"><b>⬇ Download the latest release</b></a>
</p>

---

## What it does

Record your screen (or a single window), and ZoomArc auto-detects your clicks to push in on the action — the same "zoom on click" effect you see in every good product demo, without hand-animating a single keyframe. Then edit the result in a real timeline: trim, retime zooms, add text/shapes/callouts, style the frame, and export.

## Features

**Recording**
- Full-screen or single-window capture, 60fps target
- The OS cursor is *never* composited into the recording — capture-time exclusion via a native Windows Graphics Capture module, verified against the actual negotiated stream settings rather than assumed
- Independent cursor + click tracking, decoupled from video frame rate, so a synthetic cursor can be redrawn, restyled, or swapped after the fact
- Optional webcam + microphone, recorded as separate tracks so nothing has to be re-encoded later

**Editing**
- Non-destructive timeline: trim, split, and re-arrange without touching the source recording
- Auto-generated zoom segments from click clusters, fully hand-editable afterward
- "Frame" mode — a zoom bleeds past its padded frame to fill the canvas edge-to-edge, cropped (never stretched) to match whatever aspect ratio you've picked
- Freely draggable, resizable webcam pill (round or square, adjustable corner radius)
- Custom cursor image upload with a click-to-set hotspot, sizeable independent of zoom level, and settable as your standing default for future recordings
- Text, shapes, and image elements, background presets/gradients/images with per-clip transitions
- Frame styling: padding, corner radius, shadow — all animated smoothly through a zoom
- Full undo/redo history

**Export**
- What you scrub in the preview is exactly what gets rendered — the editor and the export pipeline share the same render code, not two implementations that can drift apart
- Multiple resolution/quality presets, plus 12 aspect-ratio options (16:9, 9:16, 1:1, 21:9, and more) independent of the source recording's own shape

## Download

Grab the latest Windows build from the [Releases page](https://github.com/prashantGit24/ZoomArc/releases/latest):

- **`ZoomArc Setup x.x.x.exe`** — installer (recommended)
- **`ZoomArc x.x.x.exe`** — portable, no installation needed

> macOS support is planned but not yet built — the native cursor-exclusion module is currently Windows-only (built on Windows Graphics Capture). See [CHANGELOG.md](CHANGELOG.md) for what's shipped so far.

## Development

```bash
git clone https://github.com/prashantGit24/ZoomArc.git
cd ZoomArc
npm install
npm run dev          # Vite + Electron, hot-reloading
```

### Building the native capture module (Windows only)

Guaranteed cursor exclusion is handled by a small native addon (`native/wgc-capture`) that talks to Windows Graphics Capture directly, used as the fallback whenever the browser's own capture backend doesn't honor a cursor-hidden request. Building it requires the Visual Studio Build Tools (C++ workload) and Python:

```bash
npm run build:native
```

The app runs fine without it — it just falls back to the plain browser capture path, with a clear in-app message if that path also can't exclude the cursor on your system.

### Packaging a release

```bash
npm run pack:win      # Windows installer + portable exe, output to release/
npm run pack:mac      # macOS — must be run on macOS, cross-compiling isn't possible
```

## Tech stack

- [Electron](https://www.electronjs.org/) + [React](https://react.dev/) + [Vite](https://vitejs.dev/)
- A native Windows Graphics Capture addon (C++/WinRT, via [node-addon-api](https://github.com/nodejs/node-addon-api))
- [FFmpeg](https://ffmpeg.org/) for export encoding

## Project structure

```
electron/           Main process — capture handling, IPC, export queue, mouse tracking
native/wgc-capture/  Native Windows Graphics Capture addon
src/
  views/             Recorder and Editor screens
  render/            The shared render pipeline (preview + export use the same code)
  components/        Small shared UI pieces
```

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for the version history.

## License

ZoomArc is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE.md).

Free to use, study, and modify for personal, educational, or other non-commercial purposes. You may **not** sell ZoomArc, offer it as a paid product or service, bundle it into a paid product, or otherwise use it commercially without a separate commercial license from the author. Any copy or modified version you distribute must keep the license and copyright notice, and must not be presented as an official release by the original author.

For commercial licensing, contact **prashantdasishaa@gmail.com**.

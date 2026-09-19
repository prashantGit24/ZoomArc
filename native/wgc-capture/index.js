// Thin JS wrapper around the compiled addon. Requiring this before running
// `npm run build:native` (node-gyp rebuild in this directory) throws — that's
// deliberate: main.cjs's require() is wrapped in try/catch specifically so a
// machine without the native build present just falls back to reporting
// nativeCapture as unsupported, rather than crashing the app.
module.exports = require('./build/Release/wgc_capture.node')

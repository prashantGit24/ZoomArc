const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  platformInfo: () => ipcRenderer.invoke('app:platform'),
  checkPermissions: () => ipcRenderer.invoke('permissions:check'),
  openPermissionSettings: (kind) => ipcRenderer.invoke('permissions:open', kind),
  listSources: () => ipcRenderer.invoke('sources:list'),
  armCapture: (sourceId) => ipcRenderer.invoke('capture:arm', sourceId),

  startRecording: (meta) => ipcRenderer.invoke('record:start', meta),
  cancelRecording: () => ipcRenderer.invoke('record:cancel'),
  finishRecording: (payload) => ipcRenderer.invoke('record:finish', payload),

  listTakes: () => ipcRenderer.invoke('takes:list'),
  loadTake: (dir) => ipcRenderer.invoke('takes:load', dir),
  renameTake: (dir, name) => ipcRenderer.invoke('takes:rename', dir, name),
  deleteTake: (dir) => ipcRenderer.invoke('takes:delete', dir),
  revealTakesFolder: () => ipcRenderer.invoke('takes:revealRoot'),
  readTakeVideo: (videoPath) => ipcRenderer.invoke('takes:read', videoPath),

  exportFormats: () => ipcRenderer.invoke('exports:formats'),
  exportQualities: () => ipcRenderer.invoke('exports:qualities'),
  enqueueExport: (job) => ipcRenderer.invoke('exports:enqueue', job),
  listExports: () => ipcRenderer.invoke('exports:list'),
  cancelExport: (id) => ipcRenderer.invoke('exports:cancel', id),
  clearFinishedExports: () => ipcRenderer.invoke('exports:clear'),
  onExportsChanged: (cb) => {
    const handler = (_e, list) => cb(list)
    ipcRenderer.on('exports:changed', handler)
    return () => ipcRenderer.off('exports:changed', handler)
  },

  reveal: (p) => ipcRenderer.invoke('shell:reveal', p),

  // Windows Graphics Capture fallback — only used when getDisplayMedia's
  // cursor:'never' constraint isn't honored by the system's capture backend.
  nativeCaptureSupported: () => ipcRenderer.invoke('nativeCapture:isSupported'),
  nativeCaptureListMonitors: () => ipcRenderer.invoke('nativeCapture:listMonitors'),
  nativeCaptureStart: (monitorHandle) => ipcRenderer.invoke('nativeCapture:start', monitorHandle),
  nativeCaptureStartWindow: (hwnd) => ipcRenderer.invoke('nativeCapture:startWindow', hwnd),
  nativeCaptureStop: () => ipcRenderer.invoke('nativeCapture:stop'),
  onNativeCaptureFrame: (cb) => {
    const handler = (_e, frame) => cb(frame)
    ipcRenderer.on('nativeCapture:frame', handler)
    return () => ipcRenderer.off('nativeCapture:frame', handler)
  },

  onStopHotkey: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('record:stop-hotkey', handler)
    return () => ipcRenderer.off('record:stop-hotkey', handler)
  },
})

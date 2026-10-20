// preload.js — narrow, typed bridge between the overlay UI and the main process
const { contextBridge, ipcRenderer } = require('electron');

function on(channel, fn) {
  const handler = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('veliance', {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: patch => ipcRenderer.invoke('settings:set', patch),
    setKey: (name, value) => ipcRenderer.invoke('settings:setKey', { name, value }),
    test: provider => ipcRenderer.invoke('settings:test', provider),
    models: () => ipcRenderer.invoke('models:list')
  },
  chat: {
    send: (id, messages) => ipcRenderer.invoke('chat:send', { id, messages }),
    abort: () => ipcRenderer.invoke('chat:abort'),
    onDelta: fn => on('chat:delta', fn),
    onDone: fn => on('chat:done', fn),
    onError: fn => on('chat:error', fn)
  },
  screenshot: () => ipcRenderer.invoke('screenshot:capture'),
  transcribe: (arrayBuffer, mime) => ipcRenderer.invoke('audio:transcribe', { buffer: new Uint8Array(arrayBuffer), mime }),
  window: {
    setIgnoreMouse: ignore => ipcRenderer.invoke('window:setIgnoreMouse', ignore),
    hide: () => ipcRenderer.invoke('window:hide'),
    quit: () => ipcRenderer.invoke('window:quit'),
    openExternal: url => ipcRenderer.invoke('window:openExternal', url),
    dragBy: (dx, dy) => ipcRenderer.invoke('window:dragBy', { dx, dy }),
    dragEnd: () => ipcRenderer.invoke('window:dragEnd'),
    onVisibility: fn => on('overlay:visibility', fn)
  },
  hotkeys: {
    list: () => ipcRenderer.invoke('hotkeys:list'),
    set: (id, accel) => ipcRenderer.invoke('hotkeys:set', { id, accel }),
    reset: () => ipcRenderer.invoke('hotkeys:reset'),
    suspend: () => ipcRenderer.invoke('hotkeys:suspend'),
    resume: () => ipcRenderer.invoke('hotkeys:resume'),
    on: fn => on('hotkey', fn)
  },
  perm: {
    status: () => ipcRenderer.invoke('perm:status'),
    askMic: () => ipcRenderer.invoke('perm:askMic')
  },
  update: {
    version: () => ipcRenderer.invoke('app:version'),
    check: () => ipcRenderer.invoke('update:check'),
    open: url => ipcRenderer.invoke('update:open', url)
  },
  platform: process.platform
});

// The only page that gets a bridge is the app's own connect page (connect.html), which sets the
// server address. Pages from the server get nothing.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('gungnir', {
    getServer: () => ipcRenderer.invoke('server:get'),
    setServer: (address) => ipcRenderer.invoke('server:set', address),
    retry: () => ipcRenderer.invoke('server:retry'),
  });
}

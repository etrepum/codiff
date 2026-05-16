const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codiff', {
  getPreferences: () => ipcRenderer.invoke('codiff:getPreferences'),
  getRepositoryHistory: (limit) => ipcRenderer.invoke('codiff:getRepositoryHistory', limit),
  getRepositoryState: (source) => ipcRenderer.invoke('codiff:getRepositoryState', source),
  onPreferencesChanged: (callback) => {
    const listener = (_event, preferences) => callback(preferences);
    ipcRenderer.on('codiff:preferencesChanged', listener);
    return () => ipcRenderer.removeListener('codiff:preferencesChanged', listener);
  },
  onRepositoryChanged: (callback) => {
    const listener = (_event, change) => callback(change);
    ipcRenderer.on('codiff:repositoryChanged', listener);
    return () => ipcRenderer.removeListener('codiff:repositoryChanged', listener);
  },
  showInFolder: (path) => ipcRenderer.invoke('codiff:showInFolder', path),
});

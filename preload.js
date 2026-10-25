const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('comics', {
  library: () => ipcRenderer.invoke('library:snapshot'),
  addFolder: () => ipcRenderer.invoke('library:addFolder'),
  addFiles: () => ipcRenderer.invoke('library:addFiles'),
  addPaths: (paths, folderId) => ipcRenderer.invoke('library:addPaths', paths, folderId),
  refresh: () => ipcRenderer.invoke('library:refresh'),
  createFolder: (name) => ipcRenderer.invoke('folder:create', name),
  renameFolder: (id, name) => ipcRenderer.invoke('folder:rename', { id, name }),
  deleteFolder: (id) => ipcRenderer.invoke('folder:delete', id),
  updateBook: (id, patch) => ipcRenderer.invoke('book:update', { id, patch }),
  setCover: (id, page) => ipcRenderer.invoke('book:setCover', { id, page }),
  pages: (id) => ipcRenderer.invoke('book:pages', id),
  contextMenu: (id) => ipcRenderer.invoke('book:contextMenu', id),
  reveal: (id) => ipcRenderer.invoke('book:reveal', id),
  markRead: (id) => ipcRenderer.invoke('book:markRead', id),
  setProgress: (bookId, page, total) => ipcRenderer.invoke('progress:set', { bookId, page, total }),
  clearProgress: (bookId) => ipcRenderer.invoke('progress:clear', bookId),
  clearAllProgress: () => ipcRenderer.invoke('progress:clearAll'),
  toggleBookmark: (bookId, page) => ipcRenderer.invoke('bookmark:toggle', { bookId, page }),
  removeBookmark: (id) => ipcRenderer.invoke('bookmark:remove', id),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  onWindowMaximized: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on('window:maximized', handler);
    return () => ipcRenderer.removeListener('window:maximized', handler);
  },
  windowControls: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
    close: () => ipcRenderer.invoke('window:close')
  }
});

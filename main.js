const { app, BrowserWindow, protocol, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;
const { Library } = require('./lib/library');
const { mimeFor } = require('./lib/media');

app.setName('OfflineComics');

// 允许通过环境变量指定数据目录，便于便携使用与调试
if (process.env.OC_DATA_DIR) {
  app.setPath('userData', path.resolve(process.env.OC_DATA_DIR));
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'oc',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true
    }
  }
]);

const library = new Library(app.getPath('userData'));
let mainWindow = null;

function notFound() {
  return new Response('Not found', { status: 404 });
}

async function handleOcProtocol(request) {
  try {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);

    if (url.hostname === 'cover') {
      const coverPath = library.getCoverPath(parts[0]);
      if (!coverPath) return notFound();
      const data = await fsp.readFile(coverPath);
      return new Response(data, {
        headers: {
          'content-type': 'image/jpeg',
          'cache-control': 'public, max-age=604800'
        }
      });
    }

    if (url.hostname === 'page') {
      const id = parts[0];
      const index = Number(parts[1]);
      if (!id || !Number.isInteger(index)) return notFound();
      const { data, name } = await library.getPageData(id, index);
      return new Response(data, {
        headers: {
          'content-type': mimeFor(name),
          'cache-control': 'no-cache'
        }
      });
    }

    return notFound();
  } catch {
    return notFound();
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 660,
    frame: false,
    backgroundColor: '#0c0e12',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.on('maximize', () => mainWindow.webContents.send('window:maximized', true));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window:maximized', false));
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

async function bookContextMenu(event, id) {
  const book = library.bookById(id);
  if (!book) return null;
  const progress = library.state.progress[id];
  let action = null;

  const moveItems = [
    {
      label: '未分组',
      type: 'radio',
      groupId: 'book-folder',
      checked: !book.folderId,
      click: () => { action = 'move:'; }
    },
    ...library.library.folders.map((folder) => ({
      label: folder.name,
      type: 'radio',
      groupId: 'book-folder',
      checked: book.folderId === folder.id,
      click: () => { action = `move:${folder.id}`; }
    }))
  ];

  const template = [
    { label: '开始阅读', click: () => { action = 'read'; } },
    { label: '从头开始', click: () => { action = 'restart'; } },
    { type: 'separator' },
    { label: '编辑名称与标签…', click: () => { action = 'edit-info'; } },
    { label: '修改封面…', click: () => { action = 'edit-cover'; } },
    { label: '移动到文件夹', submenu: moveItems },
    { type: 'separator' },
    { label: '在资源管理器中显示', click: () => { action = 'reveal'; } },
    {
      label: progress && progress.finished ? '标记为未读' : '标记为已读',
      click: () => { action = 'toggle-read'; }
    },
    { type: 'separator' },
    { label: '从书架移除', click: () => { action = 'remove'; } }
  ];

  await new Promise((resolve) => {
    Menu.buildFromTemplate(template).popup({
      window: BrowserWindow.fromWebContents(event.sender),
      callback: resolve
    });
  });

  if (action === 'reveal') shell.showItemInFolder(book.path);

  if (action === 'toggle-read') {
    if (progress && progress.finished) library.clearBookProgress(id);
    else library.markRead(id);
  }

  if (action === 'remove') {
    const result = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender), {
      type: 'warning',
      title: '从书架移除',
      message: `确定移除《${book.title}》？`,
      detail: '只会从书架移除，不会删除磁盘上的原文件。',
      buttons: ['移除', '取消'],
      defaultId: 1,
      cancelId: 1
    });
    if (result.response === 0) {
      library.removeBook(id);
    } else {
      action = null;
    }
  }

  return action;
}

function registerIpc() {
  ipcMain.handle('library:snapshot', () => library.snapshot());

  ipcMain.handle('library:addFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择漫画目录',
      buttonLabel: '添加到书架',
      properties: ['openDirectory', 'multiSelections']
    });
    if (result.canceled || !result.filePaths.length) return null;
    return library.addPaths(result.filePaths);
  });

  ipcMain.handle('library:addFiles', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择漫画压缩包',
      buttonLabel: '添加到书架',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '漫画压缩包', extensions: ['zip', 'cbz'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    });
    if (result.canceled || !result.filePaths.length) return null;
    return library.addPaths(result.filePaths);
  });

  ipcMain.handle('library:addPaths', (_event, paths, folderId) => library.addPaths(paths, folderId));
  ipcMain.handle('library:refresh', () => library.refresh());

  ipcMain.handle('folder:create', (_event, name) => library.createFolder(name));
  ipcMain.handle('folder:rename', (_event, payload) =>
    library.renameFolder(payload.id, payload.name));
  ipcMain.handle('folder:delete', (_event, id) => library.deleteFolder(id));

  ipcMain.handle('book:update', (_event, payload) =>
    library.updateBook(payload.id, payload.patch));
  ipcMain.handle('book:setCover', (_event, payload) =>
    library.setCoverPage(payload.id, payload.page));

  ipcMain.handle('book:pages', (_event, id) => library.getPages(id));
  ipcMain.handle('book:reveal', (_event, id) => library.revealBook(id));
  ipcMain.handle('book:contextMenu', (event, id) => bookContextMenu(event, id));
  ipcMain.handle('book:markRead', (_event, id) => library.markRead(id));

  ipcMain.handle('progress:set', (_event, payload) =>
    library.setProgress(payload.bookId, payload.page, payload.total));
  ipcMain.handle('progress:clear', (_event, id) => {
    library.clearBookProgress(id);
    return true;
  });
  ipcMain.handle('progress:clearAll', () => library.clearAllProgress());

  ipcMain.handle('bookmark:toggle', (_event, payload) =>
    library.toggleBookmark(payload.bookId, payload.page));
  ipcMain.handle('bookmark:remove', (_event, id) => library.removeBookmark(id));

  ipcMain.handle('settings:update', (_event, patch) => library.updateSettings(patch));

  ipcMain.handle('window:minimize', () => mainWindow && mainWindow.minimize());
  ipcMain.handle('window:toggleMaximize', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  ipcMain.handle('window:close', () => mainWindow && mainWindow.close());
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  await library.init();
  protocol.handle('oc', handleOcProtocol);
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  library.close();
  app.quit();
});

app.on('before-quit', () => library.close());

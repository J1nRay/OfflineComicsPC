// 书库核心：扫描导入、封面、页码、阅读进度、书签与设置持久化
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { scanRoot } = require('./scanner');
const { ZipSession } = require('./archive');
const { coverFromBuffer, coverFromFile, saveCover } = require('./cover');
const { naturalCompare, isImageFile, isArchiveFile, stripExt } = require('./media');

const DEFAULT_SETTINGS = {
  theme: 'dark',
  readingMode: 'flip',
  direction: 'rtl',
  fitMode: 'height',
  doublePage: false,
  pageGap: 8,
  background: 'ink',
  autoHideToolbar: true,
  animation: true,
  preloadPages: 2,
  brightness: 100,
  showPageNumber: true,
  librarySort: 'recent',
  cardSize: 'md'
};

const MAX_OPEN_ARCHIVES = 3;

function samePath(a, b) {
  const normalize = (value) => path.resolve(value).replace(/\\/g, '/').toLowerCase();
  return normalize(a) === normalize(b);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (error) {
    console.error('写入数据失败', file, error);
  }
}

function clamp(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

class Library {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.coverDir = path.join(dataDir, 'covers');
    this.libraryFile = path.join(dataDir, 'library.json');
    this.stateFile = path.join(dataDir, 'state.json');
    this.settingsFile = path.join(dataDir, 'settings.json');

    this.library = { folders: [], roots: [], files: [], books: [], ignored: [] };
    this.state = { progress: {}, bookmarks: [], recent: [] };
    this.settings = { ...DEFAULT_SETTINGS };

    this.sessions = new Map(); // 压缩包路径 -> ZipSession（LRU）
    this.folderPages = new Map(); // 书籍 id -> 文件夹内图片名（有序缓存）
    this.stateTimer = null;
  }

  init() {
    fs.mkdirSync(this.coverDir, { recursive: true });

    const library = readJson(this.libraryFile, this.library);
    const folders = Array.isArray(library.folders) ? library.folders : [];
    const folderIds = new Set(folders.map((folder) => folder.id));
    this.library = {
      folders,
      roots: Array.isArray(library.roots) ? library.roots : [],
      files: Array.isArray(library.files) ? library.files : [],
      books: (Array.isArray(library.books) ? library.books : []).map((book) => ({
        ...book,
        tags: Array.isArray(book.tags)
          ? book.tags.filter((tag) => typeof tag === 'string' && tag.trim()).slice(0, 20)
          : [],
        folderId: folderIds.has(book.folderId) ? book.folderId : null,
        coverPage: Number.isInteger(book.coverPage) ? book.coverPage : 0
      })),
      ignored: Array.isArray(library.ignored) ? library.ignored : []
    };

    const state = readJson(this.stateFile, this.state);
    this.state = {
      progress: state.progress && typeof state.progress === 'object' ? state.progress : {},
      bookmarks: Array.isArray(state.bookmarks) ? state.bookmarks : [],
      recent: Array.isArray(state.recent) ? state.recent : []
    };

    this.settings = { ...DEFAULT_SETTINGS, ...readJson(this.settingsFile, {}) };

    // 清理不存在的文件书库
    this.library.files = this.library.files.filter((file) => fs.existsSync(file));
    this.saveLibrary();
  }

  saveLibrary() {
    writeJsonAtomic(this.libraryFile, this.library);
  }

  saveSettings() {
    writeJsonAtomic(this.settingsFile, this.settings);
  }

  scheduleStateSave() {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      writeJsonAtomic(this.stateFile, this.state);
    }, 250);
  }

  close() {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }

  bookById(id) {
    return this.library.books.find((book) => book.id === id) || null;
  }

  snapshot() {
    return {
      books: this.library.books.map((book) => ({
        ...book,
        hasCover: Boolean(book.hasCover && fs.existsSync(this.coverPath(book.id)))
      })),
      roots: [...this.library.roots],
      folders: [...this.library.folders],
      progress: this.state.progress,
      bookmarks: this.state.bookmarks,
      recent: this.state.recent,
      settings: this.settings
    };
  }

  coverPath(id) {
    return path.join(this.coverDir, `${id}.jpg`);
  }

  getCoverPath(id) {
    const file = this.coverPath(id);
    return fs.existsSync(file) ? file : null;
  }

  // ---------------- 导入与刷新 ----------------

  async addPaths(inputPaths, folderId = null) {
    const before = new Set(this.library.books.map((book) => book.id));
    const skipped = [];

    for (const input of inputPaths || []) {
      if (!input) continue;
      let stat;
      try {
        stat = await fsp.stat(input);
      } catch {
        skipped.push(input);
        continue;
      }

      if (stat.isDirectory()) {
        if (!this.library.roots.some((root) => samePath(root, input))) {
          this.library.roots.push(input);
        }
        const result = await scanRoot(input);
        skipped.push(...result.skipped);
        for (const descriptor of result.books) {
          this.unignore(descriptor.path);
          await this.importDescriptor(descriptor, folderId);
        }
      } else if (isArchiveFile(input)) {
        if (!this.library.files.some((file) => samePath(file, input))) {
          this.library.files.push(input);
        }
        this.unignore(input);
        await this.importDescriptor({
          type: 'archive',
          path: input,
          title: stripExt(path.basename(input))
        }, folderId);
      } else {
        skipped.push(input);
      }
    }

    this.saveLibrary();
    const added = this.library.books.filter((book) => !before.has(book.id)).length;
    return { added, skipped: skipped.length };
  }

  async importDescriptor(descriptor, folderId = null) {
    let pageCount = 0;
    let coverSource = null;

    if (descriptor.type === 'folder') {
      pageCount = descriptor.pages.length;
      coverSource = { file: descriptor.pages[0] };
    } else {
      let session;
      try {
        session = await this.getSession(descriptor.path);
      } catch (error) {
        console.warn('无法读取压缩包', descriptor.path, error.message);
        return null;
      }
      pageCount = session.pageCount;
      if (pageCount === 0) return null;
      try {
        coverSource = { buffer: await session.read(0) };
      } catch {
        coverSource = null;
      }
    }

    let stat = null;
    try {
      stat = await fsp.stat(descriptor.path);
    } catch { /* ignore */ }

    const existing = this.library.books.find((book) => samePath(book.path, descriptor.path));
    const now = Date.now();

    if (existing) {
      existing.type = descriptor.type;
      if (!existing.customTitle) existing.title = descriptor.title || existing.title;
      existing.pageCount = pageCount;
      existing.sizeBytes = stat ? stat.size : existing.sizeBytes || 0;
      existing.mtimeMs = stat ? stat.mtimeMs : existing.mtimeMs || 0;
      if (existing.coverPage >= pageCount) {
        existing.coverPage = 0;
        existing.hasCover = false;
      }
      if (existing.type === 'folder') this.folderPages.delete(existing.id);
      this.ensureCover(existing, coverSource);
      return existing;
    }

    let id = crypto
      .createHash('sha1')
      .update(path.resolve(descriptor.path).toLowerCase())
      .digest('hex')
      .slice(0, 16);
    while (this.bookById(id)) id = `${id.slice(0, 14)}${Math.floor(Math.random() * 90 + 10)}`;

    const book = {
      id,
      type: descriptor.type,
      path: descriptor.path,
      title: descriptor.title || path.basename(descriptor.path),
      pageCount,
      sizeBytes: stat ? stat.size : 0,
      mtimeMs: stat ? stat.mtimeMs : 0,
      addedAt: now,
      lastReadAt: 0,
      hasCover: false,
      coverPage: 0,
      folderId: folderId || null,
      tags: []
    };
    this.library.books.push(book);
    this.ensureCover(book, coverSource);
    return book;
  }

  ensureCover(book, source) {
    const file = this.coverPath(book.id);
    if (book.hasCover && fs.existsSync(file)) return;
    if (!source) {
      book.hasCover = false;
      return;
    }
    const jpeg = source.buffer ? coverFromBuffer(source.buffer) : coverFromFile(source.file);
    const saved = saveCover(this.coverDir, book.id, jpeg);
    book.hasCover = saved;
  }

  async refresh() {
    const descriptors = [];
    const skipped = [];
    const before = new Set(this.library.books.map((book) => book.id));

    for (const root of [...this.library.roots]) {
      const result = await scanRoot(root);
      descriptors.push(...result.books);
      skipped.push(...result.skipped);
    }

    const aliveFiles = [];
    for (const file of this.library.files) {
      if (!fs.existsSync(file)) continue;
      aliveFiles.push(file);
      descriptors.push({ type: 'archive', path: file, title: stripExt(path.basename(file)) });
    }
    this.library.files = aliveFiles;

    const kept = descriptors.filter((descriptor) => !this.isIgnored(descriptor.path));
    for (const descriptor of kept) {
      await this.importDescriptor(descriptor);
    }
    descriptors.length = 0;
    descriptors.push(...kept);

    const validPaths = new Set(descriptors.map((descriptor) => path.resolve(descriptor.path).toLowerCase()));
    const removed = [];
    this.library.books = this.library.books.filter((book) => {
      const keep = validPaths.has(path.resolve(book.path).toLowerCase());
      if (!keep) removed.push(book.id);
      return keep;
    });

    for (const id of removed) this.forgetBook(id);
    this.sessions.clear();
    this.folderPages.clear();
    this.saveLibrary();

    const added = this.library.books.filter((book) => !before.has(book.id)).length;
    return { added, removed: removed.length, skipped: skipped.length };
  }

  isIgnored(target) {
    return this.library.ignored.some((item) => samePath(item, target));
  }

  unignore(target) {
    this.library.ignored = this.library.ignored.filter((item) => !samePath(item, target));
  }

  forgetBook(id) {
    const session = this.sessions.get(id);
    if (session) {
      session.close();
      this.sessions.delete(id);
    }
    this.folderPages.delete(id);
    try {
      fs.rmSync(this.coverPath(id), { force: true });
    } catch { /* ignore */ }
  }

  removeBook(id) {
    const book = this.bookById(id);
    if (!book) return false;
    this.library.books = this.library.books.filter((item) => item.id !== id);
    if (book.type === 'folder') {
      this.library.roots = this.library.roots.filter((root) => !samePath(root, book.path));
    } else {
      this.library.files = this.library.files.filter((file) => !samePath(file, book.path));
    }
    if (!this.isIgnored(book.path)) this.library.ignored.push(book.path);
    delete this.state.progress[id];
    this.state.bookmarks = this.state.bookmarks.filter((mark) => mark.bookId !== id);
    this.state.recent = this.state.recent.filter((recentId) => recentId !== id);
    this.folderPages.delete(id);
    this.forgetBook(id);
    this.saveLibrary();
    this.scheduleStateSave();
    return true;
  }

  // ---------------- 文件夹与书籍信息 ----------------

  createFolder(name) {
    const clean = String(name || '').trim().slice(0, 40);
    if (!clean) return null;
    const folder = {
      id: `f${crypto.randomUUID().slice(0, 8)}`,
      name: clean,
      createdAt: Date.now()
    };
    this.library.folders.push(folder);
    this.saveLibrary();
    return folder;
  }

  renameFolder(id, name) {
    const folder = this.library.folders.find((item) => item.id === id);
    const clean = String(name || '').trim().slice(0, 40);
    if (!folder || !clean) return null;
    folder.name = clean;
    this.saveLibrary();
    return folder;
  }

  deleteFolder(id) {
    const folder = this.library.folders.find((item) => item.id === id);
    if (!folder) return false;
    this.library.folders = this.library.folders.filter((item) => item.id !== id);
    for (const book of this.library.books) {
      if (book.folderId === id) book.folderId = null;
    }
    this.saveLibrary();
    return true;
  }

  updateBook(id, patch) {
    const book = this.bookById(id);
    if (!book || !patch || typeof patch !== 'object') return null;

    if (typeof patch.title === 'string') {
      const title = patch.title.trim().slice(0, 120);
      if (title) {
        book.title = title;
        book.customTitle = true;
      }
    }
    if (Array.isArray(patch.tags)) {
      const tags = [];
      for (const raw of patch.tags) {
        const tag = String(raw || '').trim().slice(0, 24);
        if (tag && !tags.includes(tag)) tags.push(tag);
        if (tags.length >= 20) break;
      }
      book.tags = tags;
    }
    if ('folderId' in patch) {
      const folderId = patch.folderId;
      book.folderId = folderId && this.library.folders.some((folder) => folder.id === folderId)
        ? folderId
        : null;
    }

    this.saveLibrary();
    return book;
  }

  async setCoverPage(id, pageIndex) {
    const book = this.bookById(id);
    if (!book) return null;
    const index = clamp(pageIndex, 0, Math.max(0, book.pageCount - 1), 0);
    let jpeg = null;
    try {
      const { data } = await this.getPageData(id, index);
      jpeg = coverFromBuffer(data);
    } catch {
      return null;
    }
    if (!jpeg || !saveCover(this.coverDir, book.id, jpeg)) return null;
    book.coverPage = index;
    book.hasCover = true;
    book.coverUpdatedAt = Date.now();
    this.saveLibrary();
    return book;
  }

  // ---------------- 页面数据 ----------------

  async getSession(filePath) {
    const key = path.resolve(filePath);
    let session = this.sessions.get(key);
    if (session && !session.closed) {
      // 触摸以维持 LRU 顺序
      this.sessions.delete(key);
      this.sessions.set(key, session);
      return session;
    }

    session = await ZipSession.open(filePath);
    this.sessions.set(key, session);
    while (this.sessions.size > MAX_OPEN_ARCHIVES) {
      const oldestKey = this.sessions.keys().next().value;
      const oldest = this.sessions.get(oldestKey);
      if (oldest) oldest.close();
      this.sessions.delete(oldestKey);
    }
    return session;
  }

  async folderPageNames(book) {
    const cached = this.folderPages.get(book.id);
    if (cached) return cached;
    const entries = await fsp.readdir(book.path, { withFileTypes: true });
    const names = entries
      .filter((entry) => entry.isFile() && isImageFile(entry.name))
      .map((entry) => entry.name)
      .sort(naturalCompare);
    this.folderPages.set(book.id, names);
    return names;
  }

  async getPages(id) {
    const book = this.bookById(id);
    if (!book) throw new Error('书籍不存在');

    if (book.type === 'folder') {
      const names = await this.folderPageNames(book);
      return {
        total: names.length,
        pages: names.map((name, index) => ({ index, name }))
      };
    }

    const session = await this.getSession(book.path);
    const pages = session.pageNames().map((name, index) => ({
      index,
      name: name.split('/').pop() || name
    }));
    return { total: pages.length, pages };
  }

  async getPageData(id, index) {
    const book = this.bookById(id);
    if (!book) throw new Error('书籍不存在');
    if (!Number.isInteger(index) || index < 0) throw new Error('页码无效');

    if (book.type === 'folder') {
      const names = await this.folderPageNames(book);
      const name = names[index];
      if (!name) throw new Error('页面不存在');
      return { data: await fsp.readFile(path.join(book.path, name)), name };
    }

    const session = await this.getSession(book.path);
    if (index >= session.pageCount) throw new Error('页面不存在');
    const name = session.pageNames()[index] || '';
    return { data: await session.read(index), name };
  }

  // ---------------- 阅读状态 ----------------

  setProgress(bookId, page, total) {
    const book = this.bookById(bookId);
    if (!book) return null;
    const pageTotal = clamp(total || book.pageCount, 1, 100000, Math.max(1, book.pageCount));
    const current = clamp(page, 0, pageTotal - 1, 0);

    this.state.progress[bookId] = {
      page: current,
      total: pageTotal,
      percent: pageTotal > 1 ? Math.round(((current + 1) / pageTotal) * 100) : 100,
      finished: current >= pageTotal - 1,
      updatedAt: Date.now()
    };
    book.lastReadAt = Date.now();
    this.state.recent = [bookId, ...this.state.recent.filter((id) => id !== bookId)].slice(0, 60);
    this.scheduleStateSave();
    return this.state.progress[bookId];
  }

  markRead(bookId) {
    const book = this.bookById(bookId);
    if (!book) return null;
    return this.setProgress(bookId, Math.max(0, book.pageCount - 1), book.pageCount);
  }

  clearBookProgress(bookId) {
    delete this.state.progress[bookId];
    this.state.recent = this.state.recent.filter((id) => id !== bookId);
    const book = this.bookById(bookId);
    if (book) book.lastReadAt = 0;
    this.scheduleStateSave();
  }

  clearAllProgress() {
    this.state.progress = {};
    this.state.recent = [];
    for (const book of this.library.books) book.lastReadAt = 0;
    this.scheduleStateSave();
    return true;
  }

  toggleBookmark(bookId, page) {
    const index = clamp(page, 0, 999999, 0);
    const existing = this.state.bookmarks.find(
      (mark) => mark.bookId === bookId && mark.page === index
    );
    if (existing) {
      this.state.bookmarks = this.state.bookmarks.filter((mark) => mark.id !== existing.id);
      this.scheduleStateSave();
      return { bookmarked: false };
    }
    this.state.bookmarks.push({
      id: crypto.randomUUID(),
      bookId,
      page: index,
      note: '',
      createdAt: Date.now()
    });
    this.scheduleStateSave();
    return { bookmarked: true };
  }

  removeBookmark(id) {
    this.state.bookmarks = this.state.bookmarks.filter((mark) => mark.id !== id);
    this.scheduleStateSave();
    return true;
  }

  updateSettings(patch) {
    if (!patch || typeof patch !== 'object') return this.settings;
    const next = { ...this.settings, ...patch };
    next.pageGap = clamp(next.pageGap, 0, 48, DEFAULT_SETTINGS.pageGap);
    next.brightness = clamp(next.brightness, 40, 160, DEFAULT_SETTINGS.brightness);
    next.preloadPages = clamp(next.preloadPages, 0, 6, DEFAULT_SETTINGS.preloadPages);
    this.settings = next;
    this.saveSettings();
    return this.settings;
  }

  async revealBook(id) {
    const book = this.bookById(id);
    return book ? book.path : null;
  }
}

module.exports = { Library, DEFAULT_SETTINGS };

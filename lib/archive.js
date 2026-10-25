// ZIP / CBZ 读取：只索引图片条目，按需读取单页
const yauzl = require('yauzl');
const { naturalCompare, isImageFile, isJunkName } = require('./media');

function isJunkEntry(fileName) {
  if (fileName.endsWith('/')) return true;
  if (fileName.startsWith('__MACOSX/')) return true;
  const base = fileName.split('/').pop() || '';
  return isJunkName(base) || !isImageFile(base);
}

class ZipSession {
  constructor(file, zipfile, entries) {
    this.file = file;
    this.zipfile = zipfile;
    this.entries = entries;
    this.names = entries.map((entry) => entry.fileName);
    this.closed = false;
    // yauzl 同一时刻只安全地服务一个读取流，这里用串行队列
    this.queue = Promise.resolve();
  }

  static open(file) {
    return new Promise((resolve, reject) => {
      yauzl.open(file, { lazyEntries: true, autoClose: false }, (err, zipfile) => {
        if (err) return reject(err);
        const entries = [];
        let settled = false;
        const fail = (error) => {
          if (settled) return;
          settled = true;
          try { zipfile.close(); } catch { /* ignore */ }
          reject(error);
        };

        zipfile.on('error', fail);
        zipfile.on('entry', (entry) => {
          if (!isJunkEntry(entry.fileName)) entries.push(entry);
          zipfile.readEntry();
        });
        zipfile.on('end', () => {
          if (settled) return;
          settled = true;
          entries.sort((a, b) => naturalCompare(a.fileName, b.fileName));
          resolve(new ZipSession(file, zipfile, entries));
        });
        zipfile.readEntry();
      });
    });
  }

  get pageCount() {
    return this.entries.length;
  }

  pageNames() {
    return this.names;
  }

  read(index) {
    const entry = this.entries[index];
    if (!entry) return Promise.reject(new Error('页面不存在'));
    if (this.closed) return Promise.reject(new Error('压缩包已关闭'));

    const task = this.queue.then(
      () => new Promise((resolve, reject) => {
        this.zipfile.openReadStream(entry, (err, stream) => {
          if (err) return reject(err);
          const chunks = [];
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('error', reject);
          stream.on('end', () => resolve(Buffer.concat(chunks)));
        });
      })
    );
    this.queue = task.catch(() => {});
    return task;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.zipfile.close(); } catch { /* ignore */ }
  }
}

module.exports = { ZipSession };

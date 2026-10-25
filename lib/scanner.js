// 扫描书库目录，输出"书籍描述"（文件夹漫画或压缩包）
const fsp = require('node:fs').promises;
const path = require('node:path');
const {
  JUNK_DIRS,
  naturalCompare,
  isJunkName,
  isImageFile,
  isArchiveFile,
  isUnsupportedArchive,
  stripExt
} = require('./media');

const MAX_DEPTH = 6;

function archiveDescriptor(filePath) {
  return {
    type: 'archive',
    path: filePath,
    title: stripExt(path.basename(filePath))
  };
}

// 递归扫描：含图片的目录算一本书，同时继续向下寻找子目录中的书
async function scanRoot(root) {
  const books = [];
  const skipped = [];

  async function walk(dir, depth) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const images = [];
    const subdirs = [];

    for (const entry of entries) {
      const name = entry.name;
      if (entry.isDirectory()) {
        if (!isJunkName(name) && !JUNK_DIRS.has(name.toLowerCase())) {
          subdirs.push(path.join(dir, name));
        }
        continue;
      }
      if (!entry.isFile() || isJunkName(name)) continue;

      if (isImageFile(name)) {
        images.push(name);
      } else if (isArchiveFile(name)) {
        books.push(archiveDescriptor(path.join(dir, name)));
      } else if (isUnsupportedArchive(name)) {
        skipped.push(path.join(dir, name));
      }
    }

    images.sort(naturalCompare);
    if (images.length > 0) {
      books.push({
        type: 'folder',
        path: dir,
        title: path.basename(dir),
        pages: images.map((name) => path.join(dir, name))
      });
    }

    if (depth < MAX_DEPTH) {
      for (const sub of subdirs) {
        await walk(sub, depth + 1);
      }
    }
  }

  let stat;
  try {
    stat = await fsp.stat(root);
  } catch {
    return { books, skipped };
  }

  if (stat.isDirectory()) {
    await walk(root, 0);
  } else if (isArchiveFile(root)) {
    books.push(archiveDescriptor(root));
  } else if (isUnsupportedArchive(root)) {
    skipped.push(root);
  }

  return { books, skipped };
}

module.exports = { scanRoot };

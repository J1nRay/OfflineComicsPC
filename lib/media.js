// 媒体格式与排序的基础工具，主进程各模块共用
const path = require('node:path');

// Chromium 能直接显示的图片格式
const IMAGE_EXTS = new Set([
  '.jpg', '.jpeg', '.jfif', '.png', '.webp', '.gif', '.bmp', '.avif'
]);

// 目前支持的压缩包格式（CBR/RAR 需要额外解压引擎，暂不纳入）
const ARCHIVE_EXTS = new Set(['.zip', '.cbz']);
const UNSUPPORTED_ARCHIVE_EXTS = new Set(['.rar', '.cbr', '.7z', '.cb7', '.tar']);

// 文件管理器、版本库等目录不参与扫描
const JUNK_DIRS = new Set([
  'node_modules', '.git', '__macosx', '$recycle.bin', 'system volume information'
]);

const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });

function naturalCompare(a, b) {
  return collator.compare(a, b);
}

function isJunkName(name) {
  return name.startsWith('.') || name.startsWith('._');
}

function isImageFile(name) {
  if (isJunkName(name)) return false;
  return IMAGE_EXTS.has(path.extname(name).toLowerCase());
}

function isArchiveFile(name) {
  if (isJunkName(name)) return false;
  return ARCHIVE_EXTS.has(path.extname(name).toLowerCase());
}

function isUnsupportedArchive(name) {
  if (isJunkName(name)) return false;
  return UNSUPPORTED_ARCHIVE_EXTS.has(path.extname(name).toLowerCase());
}

function mimeFor(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  switch (ext) {
    case '.png': return 'image/png';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    case '.bmp': return 'image/bmp';
    case '.avif': return 'image/avif';
    default: return 'image/jpeg';
  }
}

function stripExt(name) {
  return name.replace(/\.[^.]+$/, '');
}

module.exports = {
  IMAGE_EXTS,
  ARCHIVE_EXTS,
  JUNK_DIRS,
  naturalCompare,
  isJunkName,
  isImageFile,
  isArchiveFile,
  isUnsupportedArchive,
  mimeFor,
  stripExt
};

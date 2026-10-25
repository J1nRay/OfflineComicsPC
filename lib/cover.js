// 封面缩略图：用 Electron nativeImage 生成小尺寸 JPEG，加快书架加载
const fs = require('node:fs');
const path = require('node:path');

const COVER_WIDTH = 360;

// 延迟加载：纯 Node 环境（无 Electron）下跳过封面生成
function nativeImage() {
  if (!process.versions.electron) return null;
  try {
    return require('electron').nativeImage;
  } catch {
    return null;
  }
}

function coverFromBuffer(buffer) {
  const imageFactory = nativeImage();
  if (!imageFactory) return null;
  try {
    const image = imageFactory.createFromBuffer(buffer);
    if (image.isEmpty()) return null;
    const { width } = image.getSize();
    const resized = width > COVER_WIDTH ? image.resize({ width: COVER_WIDTH, quality: 'good' }) : image;
    return resized.toJPEG(82);
  } catch {
    return null;
  }
}

function coverFromFile(filePath) {
  const imageFactory = nativeImage();
  if (!imageFactory) return null;
  try {
    const image = imageFactory.createFromPath(filePath);
    if (image.isEmpty()) return null;
    const { width } = image.getSize();
    const resized = width > COVER_WIDTH ? image.resize({ width: COVER_WIDTH, quality: 'good' }) : image;
    return resized.toJPEG(82);
  } catch {
    return null;
  }
}

function saveCover(dir, bookId, jpeg) {
  if (!jpeg) return false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${bookId}.jpg`), jpeg);
    return true;
  } catch {
    return false;
  }
}

module.exports = { coverFromBuffer, coverFromFile, saveCover };

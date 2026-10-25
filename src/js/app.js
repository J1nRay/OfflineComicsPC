import { Reader } from './reader.js';
import { enhanceSelects, closeSelectMenu } from './select.js';

const api = window.comics;

const state = {
  books: [],
  roots: [],
  folders: [],
  progress: {},
  bookmarks: [],
  recent: [],
  settings: {},
  view: 'library',
  search: '',
  sort: 'recent',
  activeFolderId: null,
  activeTag: '',
  booted: false
};

let toastTimer = null;
let rangeTimer = null;
let reader = null;
let modal = null;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('is-error', isError);
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('is-visible'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('is-visible');
    setTimeout(() => { el.hidden = true; }, 220);
  }, 2800);
}

function timeAgo(timestamp) {
  if (!timestamp) return '';
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return formatDate(timestamp);
}

function formatDate(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

// ---------------- 数据 ----------------

async function reload() {
  const data = await api.library();
  state.books = data.books || [];
  state.roots = data.roots || [];
  state.folders = data.folders || [];
  state.progress = data.progress || {};
  state.bookmarks = data.bookmarks || [];
  state.recent = data.recent || [];
  state.settings = data.settings || {};
  state.sort = state.settings.librarySort || 'recent';
  if (state.activeFolderId && !state.folders.some((folder) => folder.id === state.activeFolderId)) {
    state.activeFolderId = null;
  }
}

function progressOf(bookId) {
  return state.progress[bookId] || null;
}

function bookMetaLine(book, context) {
  const progress = progressOf(book.id);
  if (context === 'recent' && progress) {
    return `上次读到第 ${progress.page + 1} 页 · ${timeAgo(progress.updatedAt)}`;
  }
  if (progress && progress.finished) return `已读完 · ${book.pageCount} 页`;
  if (progress && progress.page > 0) {
    return `读至 ${progress.percent}% · 第 ${progress.page + 1} / ${book.pageCount} 页`;
  }
  return `${book.pageCount} 页 · ${formatDate(book.addedAt)}`;
}

function sortedBooks(list) {
  const books = [...list];
  switch (state.sort) {
    case 'name':
      books.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN', { numeric: true }));
      break;
    case 'added':
      books.sort((a, b) => b.addedAt - a.addedAt);
      break;
    case 'pages':
      books.sort((a, b) => b.pageCount - a.pageCount);
      break;
    default:
      books.sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0) || b.addedAt - a.addedAt);
  }
  return books;
}

function filteredBooks(list = state.books) {
  const query = state.search.trim().toLowerCase();
  let books = list;
  if (state.view === 'library') {
    if (state.activeFolderId) books = books.filter((book) => book.folderId === state.activeFolderId);
    if (state.activeTag) books = books.filter((book) => (book.tags || []).includes(state.activeTag));
  }
  if (query) {
    books = books.filter((book) =>
      book.title.toLowerCase().includes(query)
      || (book.tags || []).some((tag) => tag.toLowerCase().includes(query)));
  }
  return sortedBooks(books);
}

function tagStats(books) {
  const map = new Map();
  for (const book of books) {
    for (const tag of book.tags || []) map.set(tag, (map.get(tag) || 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN'));
}

// ---------------- 外观 ----------------

function applyAppearance() {
  const preference = state.settings.theme || 'dark';
  const isDark = preference === 'system'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : preference === 'dark';
  document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
  document.documentElement.dataset.cardSize = state.settings.cardSize || 'md';
}

// ---------------- 渲染 ----------------

function render() {
  updateNavCounts();
  syncNav();
  renderFolderNav();
  renderView();
}

function updateNavCounts() {
  $('#navCountAll').textContent = String(state.books.length);
  $('#navCountBookmarks').textContent = String(state.bookmarks.length);
}

function syncNav() {
  const inFolder = state.view === 'library' && Boolean(state.activeFolderId);
  for (const item of $$('.nav-item[data-view]')) {
    const view = item.dataset.view;
    item.classList.toggle('is-active', view === 'library' ? state.view === 'library' && !inFolder : state.view === view);
  }
}

function renderFolderNav() {
  const list = $('#folderList');
  const empty = $('#folderEmpty');
  if (!list || !empty) return;

  empty.hidden = state.folders.length > 0;
  list.innerHTML = state.folders.map((folder) => {
    const count = state.books.filter((book) => book.folderId === folder.id).length;
    const active = state.view === 'library' && state.activeFolderId === folder.id;
    return `
      <button class="nav-item folder-item${active ? ' is-active' : ''}" data-folder="${folder.id}" title="${escapeHtml(folder.name)}（右键管理）">
        <svg class="icon"><use href="#i-folder-plain"/></svg>
        <span>${escapeHtml(folder.name)}</span>
        <em class="nav-count">${count}</em>
      </button>
    `;
  }).join('');
}

function renderView() {
  closeSelectMenu();
  const root = $('#viewRoot');
  if (state.view === 'settings') {
    root.innerHTML = settingsViewHtml();
    enhanceSelects(root);
    return;
  }
  if (state.view === 'bookmarks') {
    root.innerHTML = bookmarksViewHtml();
    enhanceSelects(root);
    return;
  }

  const isRecent = state.view === 'recent';
  const folder = state.activeFolderId
    ? state.folders.find((item) => item.id === state.activeFolderId)
    : null;
  const scopeBooks = folder ? state.books.filter((book) => book.folderId === folder.id) : state.books;
  const total = isRecent ? state.recent.filter((id) => state.books.some((b) => b.id === id)).length : scopeBooks.length;
  const title = isRecent ? '最近阅读' : folder ? folder.name : '书架';
  const subtitle = isRecent
    ? `${total} 本有阅读记录 · 继续上次的故事`
    : folder
      ? `${total} 本漫画 · 右键漫画可移动到其他文件夹`
      : `${state.books.length} 本漫画${state.roots.length ? ` · ${state.roots.length} 个书库目录` : ''}`;

  root.innerHTML = `
    <header class="view-head">
      <div class="view-title">
        ${folder ? '<button class="crumb-back" data-action="clear-folder">← 全部漫画</button>' : ''}
        <h1>${escapeHtml(title)}</h1>
        <p class="view-sub">${escapeHtml(subtitle)}</p>
      </div>
      <div class="head-actions">
        <div class="search-box">
          <svg class="icon"><use href="#i-search"/></svg>
          <input type="text" id="searchInput" placeholder="搜索书名或标签…" value="${escapeHtml(state.search)}">
        </div>
        ${sortSelectHtml()}
        <button class="btn btn-ghost btn-icon" data-action="refresh" title="重新扫描书库">
          <svg class="icon"><use href="#i-refresh"/></svg>
        </button>
        <div class="add-wrap">
          <button class="btn btn-primary" data-action="toggle-add">
            <svg class="icon"><use href="#i-plus"/></svg><span>添加漫画</span>
          </button>
          <div class="add-menu" id="addMenu">
            <button data-action="add-folder"><svg class="icon"><use href="#i-folder"/></svg>选择漫画文件夹</button>
            <button data-action="add-files"><svg class="icon"><use href="#i-archive"/></svg>选择 ZIP / CBZ 文件</button>
          </div>
        </div>
      </div>
    </header>
    ${tagBarHtml()}
    <div id="bookGrid" class="book-grid"></div>
  `;

  renderGrid();
  enhanceSelects(root);
}

function tagBarHtml() {
  if (state.view !== 'library') return '';
  const scope = state.activeFolderId
    ? state.books.filter((book) => book.folderId === state.activeFolderId)
    : state.books;
  const stats = tagStats(scope);
  if (!stats.length && !state.activeTag) return '';
  return `
    <div class="tag-bar">
      <span class="tag-bar-label">标签</span>
      ${stats.map(([tag, count]) => `
        <button class="tag-chip${state.activeTag === tag ? ' is-active' : ''}" data-action="filter-tag" data-tag="${escapeHtml(tag)}">
          ${escapeHtml(tag)}<em>${count}</em>
        </button>`).join('')}
      ${state.activeTag ? '<button class="tag-clear" data-action="clear-tag">清除筛选</button>' : ''}
    </div>
  `;
}

function sortSelectHtml() {
  const options = [
    ['recent', '最近阅读'],
    ['name', '书名'],
    ['added', '添加时间'],
    ['pages', '页数']
  ];
  return `<select id="sortSelect" title="排序方式">${options.map(([value, label]) =>
    `<option value="${value}"${state.sort === value ? ' selected' : ''}>${label}</option>`).join('')}</select>`;
}

function coverUrl(book) {
  const version = Math.round(book.coverUpdatedAt || book.mtimeMs || book.addedAt || 0);
  if (book.hasCover) return `oc://cover/${book.id}?v=${version}`;
  return `oc://page/${book.id}/${book.coverPage || 0}?v=${version}`;
}

function cardHtml(book, context) {
  const progress = progressOf(book.id);
  const percent = progress ? progress.percent : 0;
  const finished = progress && progress.finished;
  const metaClass = progress && progress.page > 0 && !finished ? 'is-reading' : '';
  const tags = (book.tags || []).slice(0, 3);
  return `
    <article class="book-card" data-action="open" data-id="${book.id}" tabindex="0" role="button" aria-label="${escapeHtml(book.title)}">
      <div class="cover">
        <div class="cover-fallback">${escapeHtml(book.title.slice(0, 1))}</div>
        <img src="${coverUrl(book)}" alt="" loading="lazy" draggable="false">
        ${finished ? '<span class="cover-badge is-finished">已读完</span>' : ''}
        <span class="cover-pages">${book.pageCount} 页</span>
        ${percent > 0 && !finished ? `<div class="cover-progress"><span style="width:${percent}%"></span></div>` : ''}
        <button class="card-menu" data-action="menu" data-id="${book.id}" title="更多操作">
          <svg class="icon"><use href="#i-more"/></svg>
        </button>
      </div>
      <div class="book-meta">
        <h3>${escapeHtml(book.title)}</h3>
        <p class="${metaClass}">${escapeHtml(bookMetaLine(book, context))}</p>
        ${tags.length ? `<div class="book-tags">${tags.map((tag) =>
          `<button class="book-tag" data-action="filter-tag" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`).join('')}${
          book.tags.length > tags.length ? `<span class="book-tag is-more">+${book.tags.length - tags.length}</span>` : ''}</div>` : ''}
      </div>
    </article>
  `;
}

function renderGrid() {
  const grid = $('#bookGrid');
  if (!grid) return;

  let books;
  if (state.view === 'recent') {
    const ids = state.recent;
    books = sortedBooks(ids.map((id) => state.books.find((book) => book.id === id)).filter(Boolean));
    const query = state.search.trim().toLowerCase();
    if (query) {
      books = books.filter((book) =>
        book.title.toLowerCase().includes(query)
        || (book.tags || []).some((tag) => tag.toLowerCase().includes(query)));
    }
  } else {
    books = filteredBooks();
  }

  const filtering = Boolean(state.search.trim() || state.activeTag);
  if (!books.length) {
    if (filtering) {
      grid.innerHTML = `
        <div class="empty" style="grid-column:1 / -1">
          <div class="empty-art"><svg class="icon"><use href="#i-search"/></svg></div>
          <h2>没有找到匹配的漫画</h2>
          <p>换个关键词或取消标签筛选，查看全部书籍。</p>
        </div>`;
      return;
    }
    if (state.view === 'library' && state.activeFolderId) {
      grid.innerHTML = folderEmptyHtml();
      return;
    }
    grid.innerHTML = state.view === 'recent' ? recentEmptyHtml() : libraryEmptyHtml();
    return;
  }

  grid.classList.toggle('is-filtering', filtering);
  grid.innerHTML = books.map((book) => cardHtml(book, state.view)).join('');
  for (const img of $$('#bookGrid .cover img')) {
    img.addEventListener('error', () => img.classList.add('is-broken'));
  }
}

function folderEmptyHtml() {
  return `
    <div class="empty" style="grid-column:1 / -1">
      <div class="empty-art"><svg class="icon"><use href="#i-folder-plain"/></svg></div>
      <h2>这个文件夹还没有漫画</h2>
      <p>在书架上右键任意漫画，选择「移动到文件夹」即可把它放进这里。</p>
      <button class="btn" data-action="clear-folder">查看全部漫画</button>
    </div>
  `;
}

function libraryEmptyHtml() {
  return `
    <div class="empty" style="grid-column:1 / -1">
      <div class="empty-art"><svg class="icon"><use href="#i-shelf"/></svg></div>
      <h2>书架还是空的</h2>
      <p>把漫画文件夹或 ZIP / CBZ 文件拖进窗口，也可以点击下方按钮选择目录。导入后完全离线阅读，不会上传任何文件。</p>
      <button class="btn btn-primary" data-action="add-folder">
        <svg class="icon"><use href="#i-folder"/></svg><span>选择漫画文件夹</span>
      </button>
    </div>
  `;
}

function recentEmptyHtml() {
  return `
    <div class="empty" style="grid-column:1 / -1">
      <div class="empty-art"><svg class="icon"><use href="#i-clock"/></svg></div>
      <h2>还没有阅读记录</h2>
      <p>打开任意一本漫画开始阅读，这里会自动记录进度，方便随时续读。</p>
    </div>
  `;
}

function bookmarksViewHtml() {
  const marks = [...state.bookmarks].sort((a, b) => b.createdAt - a.createdAt);
  if (!marks.length) {
    return `
      <header class="view-head">
        <div class="view-title"><h1>书签</h1><p class="view-sub">在阅读时按 B 或点击书签按钮即可记录</p></div>
      </header>
      <div class="empty">
        <div class="empty-art"><svg class="icon"><use href="#i-bookmark"/></svg></div>
        <h2>还没有书签</h2>
        <p>阅读时点击顶部工具栏的书签按钮，或按 <kbd>B</kbd> 键，即可把当前页加入书签。</p>
      </div>
    `;
  }

  const rows = marks.map((mark) => {
    const book = state.books.find((item) => item.id === mark.bookId);
    return `
      <div class="bookmark-row" data-action="open-bookmark" data-book="${mark.bookId}" data-page="${mark.page}">
        <div class="bookmark-page">${mark.page + 1}</div>
        <div class="bookmark-info">
          <h3>${escapeHtml(book ? book.title : '已移除的漫画')}</h3>
          <p>第 ${mark.page + 1} 页 · ${timeAgo(mark.createdAt)}</p>
        </div>
        <div class="bookmark-actions">
          <button class="icon-btn" data-action="remove-bookmark" data-id="${mark.id}" title="删除书签">
            <svg class="icon"><use href="#i-close"/></svg>
          </button>
        </div>
      </div>
    `;
  }).join('');

  return `
    <header class="view-head">
      <div class="view-title"><h1>书签</h1><p class="view-sub">${marks.length} 个书签 · 点击即可跳转到对应页</p></div>
    </header>
    <div class="bookmark-list">${rows}</div>
  `;
}

// ---------------- 设置页 ----------------

function rangeLabel(key, value) {
  if (key === 'pageGap') return `${value} px`;
  if (key === 'brightness') return `${value}%`;
  if (key === 'preloadPages') return `${value} 页`;
  return String(value);
}

function segmented(key, current, items) {
  return `<div class="segmented small">${items.map(([value, label]) =>
    `<button class="${current === value ? 'is-active' : ''}" data-action="set-option" data-key="${key}" data-value="${value}">${label}</button>`
  ).join('')}</div>`;
}

function settingsViewHtml() {
  const s = state.settings;
  return `
    <div class="settings-wrap">
      <header class="view-head">
        <div class="view-title">
          <h1>设置</h1>
          <p class="view-sub">设置会自动保存，所有数据仅保存在本机</p>
        </div>
      </header>

      <section class="setting-group">
        <h3>外观</h3>
        <div class="setting-row">
          <div class="setting-label"><span>主题</span><small>深色更适合夜间阅读</small></div>
          <select data-setting="theme">
            <option value="dark"${s.theme === 'dark' ? ' selected' : ''}>深色</option>
            <option value="light"${s.theme === 'light' ? ' selected' : ''}>浅色</option>
            <option value="system"${s.theme === 'system' ? ' selected' : ''}>跟随系统</option>
          </select>
        </div>
        <div class="setting-row">
          <div class="setting-label"><span>封面大小</span><small>调整书架每行显示的书本数量</small></div>
          ${segmented('cardSize', s.cardSize, [['sm', '小'], ['md', '中'], ['lg', '大']])}
        </div>
      </section>

      <section class="setting-group">
        <h3>阅读</h3>
        <div class="setting-row">
          <div class="setting-label"><span>默认阅读模式</span><small>打开漫画时使用的阅读方式</small></div>
          ${segmented('readingMode', s.readingMode, [['flip', '翻页'], ['scroll', '卷轴']])}
        </div>
        <div class="setting-row">
          <div class="setting-label"><span>翻页方向</span><small>日漫通常从右向左阅读</small></div>
          ${segmented('direction', s.direction, [['rtl', '右 → 左'], ['ltr', '左 → 右']])}
        </div>
        <div class="setting-row">
          <div class="setting-label"><span>页面适配</span><small>翻页模式下图片的显示方式</small></div>
          <select data-setting="fitMode">
            <option value="height"${s.fitMode === 'height' ? ' selected' : ''}>适应高度</option>
            <option value="page"${s.fitMode === 'page' ? ' selected' : ''}>整页显示</option>
            <option value="width"${s.fitMode === 'width' ? ' selected' : ''}>适应宽度</option>
            <option value="original"${s.fitMode === 'original' ? ' selected' : ''}>原始尺寸</option>
          </select>
        </div>
        <div class="setting-row">
          <div class="setting-label"><span>双页模式</span><small>宽屏时并排显示两页</small></div>
          <label class="switch"><input type="checkbox" data-setting="doublePage"${s.doublePage ? ' checked' : ''}><span></span></label>
        </div>
        <div class="setting-row">
          <div class="setting-label"><span>页间距</span><small>卷轴模式上下两页之间的留白</small></div>
          <div class="range-wrap"><input type="range" min="0" max="48" step="2" data-setting="pageGap" value="${s.pageGap}"><em>${rangeLabel('pageGap', s.pageGap)}</em></div>
        </div>
        <div class="setting-row">
          <div class="setting-label"><span>自动隐藏工具栏</span><small>鼠标静止后隐藏，移动时恢复</small></div>
          <label class="switch"><input type="checkbox" data-setting="autoHideToolbar"${s.autoHideToolbar ? ' checked' : ''}><span></span></label>
        </div>
        <div class="setting-row">
          <div class="setting-label"><span>翻页动画</span><small>切换页面时的过渡效果</small></div>
          <label class="switch"><input type="checkbox" data-setting="animation"${s.animation ? ' checked' : ''}><span></span></label>
        </div>
        <div class="setting-row">
          <div class="setting-label"><span>预加载页数</span><small>提前缓存前后页，翻页更流畅</small></div>
          <div class="range-wrap"><input type="range" min="0" max="5" step="1" data-setting="preloadPages" value="${s.preloadPages}"><em>${rangeLabel('preloadPages', s.preloadPages)}</em></div>
        </div>
        <div class="setting-row">
          <div class="setting-label"><span>阅读背景</span><small>适合不同画面的底色</small></div>
          <div class="swatches">
            ${['ink', 'graphite', 'sepia', 'white'].map((value) =>
              `<button class="${s.background === value ? 'is-active' : ''}" data-action="set-option" data-key="background" data-value="${value}" title="${{ ink: '墨黑', graphite: '深灰', sepia: '暖棕', white: '纯白' }[value]}"></button>`
            ).join('')}
          </div>
        </div>
        <div class="setting-row">
          <div class="setting-label"><span>画面亮度</span><small>调暗画面，减少夜间刺眼</small></div>
          <div class="range-wrap"><input type="range" min="40" max="160" step="5" data-setting="brightness" value="${s.brightness}"><em>${rangeLabel('brightness', s.brightness)}</em></div>
        </div>
        <div class="setting-row">
          <div class="setting-label"><span>显示页码</span><small>在画面角落显示当前页码</small></div>
          <label class="switch"><input type="checkbox" data-setting="showPageNumber"${s.showPageNumber ? ' checked' : ''}><span></span></label>
        </div>
      </section>

      <section class="setting-group">
        <h3>书架</h3>
        <div class="setting-row">
          <div class="setting-label"><span>默认排序</span><small>书架默认使用的排序方式</small></div>
          <select data-setting="librarySort">
            <option value="recent"${s.librarySort === 'recent' ? ' selected' : ''}>最近阅读</option>
            <option value="name"${s.librarySort === 'name' ? ' selected' : ''}>书名</option>
            <option value="added"${s.librarySort === 'added' ? ' selected' : ''}>添加时间</option>
            <option value="pages"${s.librarySort === 'pages' ? ' selected' : ''}>页数</option>
          </select>
        </div>
        <div class="setting-row">
          <div class="setting-label"><span>重新扫描书库</span><small>重新读取已添加的目录，识别新增或删除的文件</small></div>
          <button class="btn" data-action="refresh">立即扫描</button>
        </div>
      </section>

      <section class="setting-group">
        <h3>数据</h3>
        <div class="setting-row">
          <div class="setting-label"><span>清空阅读进度</span><small>清除全部进度与最近阅读记录，书签会保留</small></div>
          <button class="btn danger-btn" data-action="clear-progress">清空进度</button>
        </div>
      </section>

      <section class="setting-group">
        <h3>关于</h3>
        <div class="setting-row">
          <div class="setting-label"><span>OfflineComics</span></div>
          <span class="about-value">本地离线漫画阅读器</span>
        </div>
        <div class="setting-row about-stacked">
          <div class="setting-label"><span>应用简介</span></div>
          <p class="about-value">完全离线运行的本地漫画阅读器。支持导入文件夹与 ZIP/CBZ 压缩包，提供书架分组、封面与标签管理、翻页与卷轴两种阅读模式、阅读进度与书签记录；所有数据仅保存在本机，不联网、不上传。</p>
        </div>
        <div class="setting-row">
          <div class="setting-label"><span>作者</span></div>
          <span class="about-value">DeepSeek-V4.1-Flash &amp; J1nRay</span>
        </div>
      </section>

      <p class="settings-note">阅读时按 <kbd>?</kbd> 可查看快捷键；按 <kbd>F</kbd> 切换全屏。</p>
    </div>
  `;
}

// ---------------- 操作 ----------------

function navTo(view) {
  state.view = view;
  state.search = '';
  state.activeTag = '';
  state.activeFolderId = null;
  renderView();
  syncNav();
  renderFolderNav();
  $('#content').scrollTop = 0;
}

function openFolder(folderId) {
  state.view = 'library';
  state.search = '';
  state.activeTag = '';
  state.activeFolderId = folderId;
  renderView();
  syncNav();
  renderFolderNav();
  $('#content').scrollTop = 0;
}

// ---------------- 弹层 ----------------

function openModal(html, meta) {
  closeSelectMenu();
  modal = meta || null;
  $('#modalCard').innerHTML = html;
  $('#modalRoot').hidden = false;
  enhanceSelects($('#modalCard'));
  const focus = $('#modalCard input[type="text"]');
  if (focus) {
    focus.focus();
    focus.select?.();
  }
}

function closeModal() {
  const root = $('#modalRoot');
  if (!root || root.hidden) return;
  closeSelectMenu();
  root.hidden = true;
  $('#modalCard').innerHTML = '';
  modal = null;
}

function openFolderEditor(folder) {
  const assigning = folder || null;
  openModal(`
    <header class="modal-head">
      <h2>${assigning ? '管理文件夹' : '新建文件夹'}</h2>
      <button class="icon-btn" data-action="close-modal" title="关闭"><svg class="icon"><use href="#i-close"/></svg></button>
    </header>
    <div class="modal-body">
      <label class="field">
        <span>文件夹名称</span>
        <input type="text" id="folderName" maxlength="40" placeholder="例如：少年漫画" value="${assigning ? escapeHtml(assigning.name) : ''}">
      </label>
      ${assigning ? '<p class="modal-hint">删除文件夹不会移除其中的漫画，它们会回到未分组。</p>' : ''}
    </div>
    <footer class="modal-foot">
      ${assigning ? '<button class="btn danger-btn" data-action="delete-folder">删除文件夹</button>' : ''}
      <div class="modal-foot-right">
        <button class="btn" data-action="close-modal">取消</button>
        <button class="btn btn-primary" data-action="save-folder">保存</button>
      </div>
    </footer>
  `, { type: 'folder', folderId: assigning ? assigning.id : null });
}

function openBookEditor(id, options = {}) {
  const book = state.books.find((item) => item.id === id);
  if (!book) return;
  const coverIndex = Math.min(book.coverPage || 0, Math.max(0, book.pageCount - 1));
  const folderOptions = [
    '<option value="">未分组</option>',
    ...state.folders.map((folder) =>
      `<option value="${folder.id}"${book.folderId === folder.id ? ' selected' : ''}>${escapeHtml(folder.name)}</option>`)
  ].join('');

  openModal(`
    <header class="modal-head">
      <h2>编辑漫画</h2>
      <button class="icon-btn" data-action="close-modal" title="关闭"><svg class="icon"><use href="#i-close"/></svg></button>
    </header>
    <div class="modal-body">
      <div class="editor-grid">
        <div class="editor-cover">
          <img id="editorCover" src="oc://page/${book.id}/${coverIndex}?v=${Date.now()}" alt="">
        </div>
        <div class="editor-fields">
          <label class="field">
            <span>名称</span>
            <input type="text" id="editorTitle" maxlength="120" value="${escapeHtml(book.title)}">
          </label>
          <label class="field">
            <span>标签</span>
            <input type="text" id="editorTags" maxlength="200" placeholder="用逗号分隔，例如：热血, 校园" value="${escapeHtml((book.tags || []).join(', '))}">
          </label>
          <label class="field">
            <span>文件夹</span>
            <select id="editorFolder">${folderOptions}</select>
          </label>
        </div>
      </div>
      <section class="cover-picker" id="coverPicker">
        <div class="cover-picker-head">
          <span>封面页</span>
          <small>共 ${book.pageCount} 页，拖动滑杆或直接输入页数</small>
        </div>
        <div class="cover-picker-row">
          <input type="range" id="editorCoverRange" min="0" max="${Math.max(0, book.pageCount - 1)}" value="${coverIndex}">
          <label class="cover-page-input" title="输入页数直接跳转">
            <input type="number" id="editorCoverPage" min="1" max="${Math.max(1, book.pageCount)}" value="${coverIndex + 1}" inputmode="numeric" aria-label="封面页码">
            <span>/ ${book.pageCount}</span>
          </label>
        </div>
      </section>
    </div>
    <footer class="modal-foot">
      <div class="modal-foot-right">
        <button class="btn" data-action="close-modal">取消</button>
        <button class="btn btn-primary" data-action="save-book" data-id="${book.id}">保存</button>
      </div>
    </footer>
  `, { type: 'book', bookId: book.id, originalCover: book.coverPage || 0 });

  if (options.focusCover) {
    const picker = $('#coverPicker');
    if (picker) {
      picker.classList.add('is-focused');
      picker.scrollIntoView({ block: 'nearest' });
      setTimeout(() => $('#editorCoverRange')?.focus(), 60);
    }
  }
}

function setCoverPreview(page, options = {}) {
  const range = $('#editorCoverRange');
  if (!range || !modal?.bookId) return;
  const max = Math.max(0, Number(range.max) || 0);
  const value = Math.min(max, Math.max(0, Math.round(Number(page) || 0)));
  range.value = String(value);
  if (options.syncInput !== false) {
    const pageInput = $('#editorCoverPage');
    if (pageInput) pageInput.value = String(value + 1);
  }
  const img = $('#editorCover');
  if (img) img.src = `oc://page/${modal.bookId}/${value}?v=${Date.now()}`;
}

async function saveFolderEditor() {
  const input = $('#folderName');
  const name = input ? input.value.trim() : '';
  if (!name) {
    toast('请输入文件夹名称', true);
    input?.focus();
    return;
  }
  if (modal?.folderId) {
    await api.renameFolder(modal.folderId, name);
    toast('已重命名文件夹');
  } else {
    const folder = await api.createFolder(name);
    if (!folder) {
      toast('创建文件夹失败', true);
      return;
    }
    toast(`已创建文件夹「${folder.name}」`);
  }
  closeModal();
  await reload();
  render();
}

async function deleteFolder() {
  if (!modal?.folderId) return;
  const folder = state.folders.find((item) => item.id === modal.folderId);
  const confirmed = confirm(`删除文件夹「${folder ? folder.name : ''}」？其中的漫画会回到未分组。`);
  if (!confirmed) return;
  await api.deleteFolder(modal.folderId);
  if (state.activeFolderId === modal.folderId) state.activeFolderId = null;
  closeModal();
  await reload();
  render();
  toast('已删除文件夹');
}

async function saveBookEditor() {
  const id = modal?.bookId;
  const book = state.books.find((item) => item.id === id);
  if (!id || !book) return;
  const title = $('#editorTitle').value.trim();
  if (!title) {
    toast('名称不能为空', true);
    $('#editorTitle')?.focus();
    return;
  }
  const tags = $('#editorTags').value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
  const folderId = $('#editorFolder').value || null;
  const coverPage = Number($('#editorCoverRange').value);

  await api.updateBook(id, { title, tags, folderId });
  if (coverPage !== (book.coverPage || 0) || !book.hasCover) {
    const updated = await api.setCover(id, coverPage);
    if (!updated) toast('封面生成失败，请换一页试试', true);
    else book.coverUpdatedAt = Date.now();
  }
  closeModal();
  await reload();
  render();
  toast('已保存修改');
}

async function handleBookMenu(id) {
  const result = await api.contextMenu(id);
  const book = state.books.find((item) => item.id === id);
  if (!result) return;

  if (result === 'read') return openBook(id);
  if (result === 'restart') return openBook(id, { restart: true });
  if (result === 'edit-info') return openBookEditor(id);
  if (result === 'edit-cover') return openBookEditor(id, { focusCover: true });

  if (result.startsWith('move:')) {
    const folderId = result.slice(5) || null;
    await api.updateBook(id, { folderId });
    await reload();
    render();
    const folder = folderId ? state.folders.find((item) => item.id === folderId) : null;
    toast(folder ? `已移动到「${folder.name}」` : `已将《${book ? book.title : ''}》移出文件夹`);
    return;
  }

  await reload();
  render();
}

function openBook(id, options = {}) {
  const book = state.books.find((item) => item.id === id);
  if (!book) return;
  reader.open(book, {
    progress: progressOf(id),
    settings: state.settings,
    bookmarks: state.bookmarks.filter((mark) => mark.bookId === id),
    startPage: options.page ?? null,
    restart: Boolean(options.restart)
  });
}

async function importPaths(paths, folderId = null) {
  if (!paths.length) {
    toast('没有识别到可导入的文件', true);
    return;
  }
  toast('正在扫描并导入…');
  try {
    const result = await api.addPaths(paths, folderId);
    await reload();
    render();
    reportImport(result);
  } catch (error) {
    toast('导入失败，请检查路径是否可读', true);
  }
}

function reportImport(result) {
  if (!result) return;
  if (result.added > 0) {
    toast(`已添加 ${result.added} 本漫画${result.skipped ? `，跳过 ${result.skipped} 项` : ''}`);
  } else if (result.skipped > 0) {
    toast('没有发现新的漫画，已跳过不支持的文件', true);
  } else {
    toast('书架已经是最新的，没有新增内容');
  }
}

async function refreshLibrary() {
  if (!state.roots.length) {
    toast('还没有添加书库目录，先添加漫画吧');
    return;
  }
  toast('正在重新扫描书库…');
  try {
    const result = await api.refresh();
    await reload();
    render();
    const parts = [];
    if (result.added) parts.push(`新增 ${result.added} 本`);
    if (result.removed) parts.push(`移除 ${result.removed} 本`);
    toast(parts.length ? `扫描完成：${parts.join('，')}` : '扫描完成，书架没有变化');
  } catch {
    toast('扫描失败', true);
  }
}

function toggleAddMenu() {
  const menu = $('#addMenu');
  if (!menu) return;
  menu.classList.toggle('is-open');
}

async function handleAddFolder() {
  const result = await api.addFolder();
  if (!result) return;
  await reload();
  render();
  reportImport(result);
}

async function handleAddFiles() {
  const result = await api.addFiles();
  if (!result) return;
  await reload();
  render();
  reportImport(result);
}

async function updateSetting(key, value) {
  state.settings = await api.updateSettings({ [key]: value });
  applyAppearance();
  if (key === 'librarySort') {
    state.sort = value;
    renderGrid();
  }
}

function syncOptionButtons(key, value) {
  for (const button of $$(`#viewRoot [data-key="${key}"][data-value]`)) {
    button.classList.toggle('is-active', button.dataset.value === value);
  }
}

// ---------------- 事件 ----------------

function setupChrome() {
  $('.window-actions').addEventListener('click', (event) => {
    const button = event.target.closest('[data-win]');
    if (!button) return;
    const action = button.dataset.win;
    if (action === 'min') api.windowControls.minimize();
    if (action === 'max') api.windowControls.toggleMaximize();
    if (action === 'close') api.windowControls.close();
  });

  api.onWindowMaximized((maximized) => {
    const use = $('#winMaxIcon use');
    if (use) use.setAttribute('href', maximized ? '#i-restore' : '#i-max');
  });

  for (const item of $$('.nav-item[data-view]')) {
    item.addEventListener('click', () => navTo(item.dataset.view));
  }

  $('#sidebarAdd').addEventListener('click', handleAddFolder);
  $('#folderAdd').addEventListener('click', () => openFolderEditor(null));

  const folderList = $('#folderList');
  folderList.addEventListener('click', (event) => {
    const item = event.target.closest('[data-folder]');
    if (item) openFolder(item.dataset.folder);
  });
  folderList.addEventListener('contextmenu', (event) => {
    const item = event.target.closest('[data-folder]');
    if (!item) return;
    event.preventDefault();
    const folder = state.folders.find((entry) => entry.id === item.dataset.folder);
    if (folder) openFolderEditor(folder);
  });

  document.addEventListener('click', (event) => {
    if (!event.target.closest('.add-wrap')) {
      $('#addMenu')?.classList.remove('is-open');
    }
  });

  const media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', () => {
    if (state.settings.theme === 'system') applyAppearance();
  });
}

function setupViewEvents() {
  const root = $('#viewRoot');

  root.addEventListener('click', async (event) => {
    const actionEl = event.target.closest('[data-action]');
    if (!actionEl) return;
    const action = actionEl.dataset.action;

    if (action === 'open') {
      openBook(actionEl.dataset.id);
      return;
    }

    if (action === 'menu') {
      event.stopPropagation();
      await handleBookMenu(actionEl.dataset.id);
      return;
    }

    if (action === 'filter-tag') {
      state.view = 'library';
      state.activeTag = actionEl.dataset.tag || '';
      render();
      $('#content').scrollTop = 0;
      return;
    }

    if (action === 'clear-tag') {
      state.activeTag = '';
      renderView();
      return;
    }

    if (action === 'clear-folder') {
      state.activeFolderId = null;
      state.activeTag = '';
      render();
      $('#content').scrollTop = 0;
      return;
    }

    if (action === 'toggle-add') {
      toggleAddMenu();
      return;
    }

    if (action === 'add-folder') {
      $('#addMenu')?.classList.remove('is-open');
      handleAddFolder();
      return;
    }

    if (action === 'add-files') {
      $('#addMenu')?.classList.remove('is-open');
      handleAddFiles();
      return;
    }

    if (action === 'refresh') {
      refreshLibrary();
      return;
    }

    if (action === 'open-bookmark') {
      openBook(actionEl.dataset.book, { page: Number(actionEl.dataset.page) });
      return;
    }

    if (action === 'remove-bookmark') {
      event.stopPropagation();
      await api.removeBookmark(actionEl.dataset.id);
      await reload();
      render();
      toast('已删除书签');
      return;
    }

    if (action === 'set-option') {
      const key = actionEl.dataset.key;
      const value = actionEl.dataset.value;
      await updateSetting(key, value);
      syncOptionButtons(key, value);
      return;
    }

    if (action === 'clear-progress') {
      const confirmed = confirm('确定清空全部阅读进度和最近阅读记录吗？书签会保留。');
      if (!confirmed) return;
      await api.clearAllProgress();
      await reload();
      render();
      toast('已清空阅读进度');
    }
  });

  root.addEventListener('change', async (event) => {
    const control = event.target.closest('[data-setting]');
    if (!control) return;
    const key = control.dataset.setting;
    if (control.type === 'range') return;
    const value = control.type === 'checkbox' ? control.checked : control.value;
    await updateSetting(key, value);
  });

  root.addEventListener('input', (event) => {
    const control = event.target.closest('input[type="range"][data-setting]');
    if (!control) return;
    const key = control.dataset.setting;
    const value = Number(control.value);
    const em = control.closest('.range-wrap')?.querySelector('em');
    if (em) em.textContent = rangeLabel(key, value);
    clearTimeout(rangeTimer);
    rangeTimer = setTimeout(() => updateSetting(key, value), 200);
  });

  root.addEventListener('input', (event) => {
    if (event.target.id !== 'searchInput') return;
    state.search = event.target.value;
    renderGrid();
  });

  root.addEventListener('change', (event) => {
    if (event.target.id !== 'sortSelect') return;
    state.sort = event.target.value;
    api.updateSettings({ librarySort: state.sort }).then((settings) => {
      state.settings = settings;
    });
    renderGrid();
  });

  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const card = event.target.closest('.book-card');
    if (card) openBook(card.dataset.id);
  });

  root.addEventListener('contextmenu', (event) => {
    const card = event.target.closest('.book-card');
    if (!card) return;
    event.preventDefault();
    handleBookMenu(card.dataset.id);
  });
}

function setupModal() {
  const root = $('#modalRoot');

  root.addEventListener('click', (event) => {
    const actionEl = event.target.closest('[data-action]');
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    if (action === 'close-modal') closeModal();
    else if (action === 'save-folder') saveFolderEditor();
    else if (action === 'delete-folder') deleteFolder();
    else if (action === 'save-book') saveBookEditor();
  });

  root.addEventListener('input', (event) => {
    if (modal?.type !== 'book') return;
    if (event.target.id === 'editorCoverRange') {
      setCoverPreview(event.target.value);
      return;
    }
    if (event.target.id === 'editorCoverPage') {
      const raw = event.target.value.trim();
      if (!raw) return;
      const page = Number(raw) - 1;
      const max = Number($('#editorCoverRange')?.max) || 0;
      if (!Number.isFinite(page) || page < 0 || page > max) return;
      setCoverPreview(page, { syncInput: false });
    }
  });

  root.addEventListener('change', (event) => {
    if (event.target.id !== 'editorCoverPage' || modal?.type !== 'book') return;
    const range = $('#editorCoverRange');
    const current = Number(range?.value) || 0;
    const typed = Number(event.target.value) - 1;
    setCoverPreview(Number.isFinite(typed) && typed >= 0 ? typed : current);
  });

  root.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target.id === 'editorCoverPage') {
      event.preventDefault();
      event.target.blur();
      return;
    }
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeModal();
      return;
    }
    if (event.key === 'Enter' && event.target.tagName === 'INPUT') {
      if (modal?.type === 'folder') saveFolderEditor();
      else if (modal?.type === 'book') saveBookEditor();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || root.hidden) return;
    closeModal();
  });
}

function setupDropzone() {
  const overlay = $('#dropOverlay');
  let depth = 0;

  window.addEventListener('dragenter', (event) => {
    if (!event.dataTransfer || !event.dataTransfer.types.includes('Files')) return;
    depth += 1;
    overlay.hidden = false;
  });

  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) overlay.hidden = true;
  });

  window.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });

  window.addEventListener('drop', async (event) => {
    event.preventDefault();
    depth = 0;
    overlay.hidden = true;
    const files = [...(event.dataTransfer?.files || [])];
    const paths = files.map((file) => api.getPathForFile(file)).filter(Boolean);
    const folderId = state.view === 'library' ? state.activeFolderId : null;
    await importPaths(paths, folderId);
  });
}

// ---------------- 启动 ----------------

async function boot() {
  if (!api) {
    document.body.innerHTML = '<div style="padding:40px;font-family:sans-serif">请通过 Electron 启动本应用。</div>';
    return;
  }

  await reload();
  applyAppearance();
  reader = new Reader({
    api,
    toast,
    onClose: async () => {
      await reload();
      render();
    },
    onSettingsChange: (settings) => {
      state.settings = settings;
      applyAppearance();
    }
  });

  setupChrome();
  setupViewEvents();
  setupModal();
  setupDropzone();
  render();
  enhanceSelects(document);
  state.booted = true;
}

boot().catch((error) => {
  console.error(error);
  toast('应用初始化失败，请重启', true);
});

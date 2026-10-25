// 阅读器：翻页 / 卷轴、缩放平移、书签、进度与阅读设置
import { refreshSelects } from './select.js';

const BG_COLORS = {
  ink: '#08090b',
  graphite: '#15181d',
  sepia: '#241f19',
  white: '#f1efe9'
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export class Reader {
  constructor({ api, toast, onClose, onSettingsChange }) {
    this.api = api;
    this.toast = toast;
    this.onClose = onClose;
    this.onSettingsChange = onSettingsChange;

    this.book = null;
    this.pages = [];
    this.total = 0;
    this.page = 0;
    this.mode = 'flip';
    this.settings = null;
    this.bookmarks = new Set();

    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.visible = false;
    this.dragging = false;
    this.dragStart = null;
    this.dragDx = 0;
    this.dragDy = 0;
    this.suppressClick = false;
    this.tapTimer = null;
    this.saveTimer = null;
    this.settingsTimer = null;
    this.hideTimer = null;
    this.sliderTimer = null;
    this.observer = null;
    this.suppressScrollUntil = 0;
    this.alignTarget = null;
    this.alignFrame = 0;
    this.alignTimer = null;
    this.preloadCache = new Map();
    this.lastWheel = 0;
    this.onScrollTrack = () => {
      const now = performance.now();
      if (now - (this.lastScrollSync || 0) < 80) return;
      this.lastScrollSync = now;
      this.syncPageFromScroll();
    };

    this.el = {};
    this.collectElements();
    this.bindStatic();
  }

  collectElements() {
    const byId = (id) => document.getElementById(id);
    this.el.reader = byId('reader');
    this.el.stage = byId('readerStage');
    this.el.top = byId('readerTop');
    this.el.bottom = byId('readerBottom');
    this.el.title = byId('readerTitle');
    this.el.meta = byId('readerMeta');
    this.el.flipViewport = byId('flipViewport');
    this.el.flipFrame = byId('flipFrame');
    this.el.pageSpread = byId('pageSpread');
    this.el.slotA = byId('slotA');
    this.el.slotB = byId('slotB');
    this.el.imgA = byId('imgA');
    this.el.imgB = byId('imgB');
    this.el.loading = byId('pageLoading');
    this.el.pageBadge = byId('pageBadge');
    this.el.zoomBadge = byId('zoomBadge');
    this.el.scrollViewport = byId('scrollViewport');
    this.el.slider = byId('pageSlider');
    this.el.pageInput = byId('pageInput');
    this.el.pageTotal = byId('pageTotalText');
    this.el.settingsPanel = byId('readerSettings');
    this.el.scrim = byId('readerScrim');
    this.el.modeSwitch = byId('modeSwitch');
    this.el.bookmarkBtn = byId('btnBookmark');
  }

  bindStatic() {
    const $ = (id) => document.getElementById(id);

    $('readerBack').addEventListener('click', () => this.close());
    $('btnPrev').addEventListener('click', () => this.goPrev());
    $('btnNext').addEventListener('click', () => this.goNext());
    $('btnBookmark').addEventListener('click', () => this.toggleBookmark());
    $('btnReaderSettings').addEventListener('click', () => this.toggleSettingsPanel());
    $('btnFullscreen').addEventListener('click', () => this.toggleFullscreen());
    $('readerSettingsClose').addEventListener('click', () => this.closePanels());
    this.el.scrim.addEventListener('click', () => this.closePanels());

    this.el.modeSwitch.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-mode]');
      if (button) this.setMode(button.dataset.mode);
    });

    this.el.slider.addEventListener('input', () => {
      const value = Number(this.el.slider.value);
      this.el.pageBadge.textContent = `第 ${value + 1} / ${this.total} 页`;
      clearTimeout(this.sliderTimer);
      this.sliderTimer = setTimeout(() => this.jumpTo(value), 70);
    });

    this.el.pageInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      const value = Number(this.el.pageInput.value);
      if (Number.isFinite(value)) this.jumpTo(value - 1);
      this.el.pageInput.blur();
    });

    // 阅读设置面板
    this.el.settingsPanel.addEventListener('change', (event) => {
      const target = event.target.closest('[data-rsetting]');
      if (!target || target.tagName !== 'SELECT' && target.type !== 'checkbox') return;
      const value = target.type === 'checkbox' ? target.checked : target.value;
      this.updateSetting(target.dataset.rsetting, value);
    });

    this.el.settingsPanel.addEventListener('input', (event) => {
      const target = event.target;
      if (!target.matches('input[type="range"][data-rsetting]')) return;
      const value = Number(target.value);
      const em = target.closest('.range-wrap')?.querySelector('em');
      if (em) em.textContent = this.rangeLabel(target.dataset.rsetting, value);
      this.updateSetting(target.dataset.rsetting, value, false);
    });

    this.el.settingsPanel.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-value]');
      if (!button) return;
      const group = button.closest('[data-rsetting]');
      if (!group) return;
      this.updateSetting(group.dataset.rsetting, button.dataset.value, true);
    });

    this.el.imgA.addEventListener('load', () => this.checkLoading());
    this.el.imgB.addEventListener('load', () => this.checkLoading());
    this.el.imgA.addEventListener('error', () => this.showLoading(false));
    this.el.imgB.addEventListener('error', () => this.checkLoading());
  }

  async open(book, options) {
    this.book = book;
    this.settings = { ...options.settings };
    this.bookmarks = new Set((options.bookmarks || []).map((mark) => mark.page));

    let data;
    try {
      data = await this.api.pages(book.id);
    } catch (error) {
      this.toast('无法打开这本书：文件可能已被移动或损坏', true);
      this.book = null;
      return;
    }

    this.pages = data.pages;
    this.total = data.total;
    if (!this.total) {
      this.toast('这本书里没有可显示的图片', true);
      this.book = null;
      return;
    }

    const progress = options.progress || null;
    this.page = options.restart
      ? 0
      : clamp(options.startPage ?? progress?.page ?? 0, 0, this.total - 1);

    this.mode = this.settings.readingMode === 'scroll' ? 'scroll' : 'flip';
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;

    this.el.reader.hidden = false;
    this.el.reader.setAttribute('aria-hidden', 'false');
    document.body.classList.add('reading');
    this.visible = true;
    this.closePanels();

    this.el.title.textContent = book.title;
    this.el.meta.textContent = `${this.total} 页 · ${book.type === 'archive' ? '压缩包' : '文件夹'}`;
    this.el.slider.max = String(this.total - 1);
    this.el.pageTotal.textContent = String(this.total);

    this.applyReaderSettings();
    this.syncSettingsUI();
    this.updateModeButtons();
    this.renderMode();
    this.updateChrome();
    this.bindGlobal();
    this.showUI();
    this.saveProgress(true);
  }

  // ---------------- 渲染 ----------------

  pageUrl(index) {
    return `oc://page/${this.book.id}/${index}`;
  }

  renderMode() {
    const isFlip = this.mode === 'flip';
    this.el.flipViewport.hidden = !isFlip;
    this.el.scrollViewport.hidden = isFlip;
    this.updateModeButtons();

    if (isFlip) {
      this.destroyObserver();
      this.el.scrollViewport.innerHTML = '';
      this.renderFlip(false);
      this.applyZoom();
    } else {
      this.renderScroll();
    }
    this.updateChrome();
    this.previewPreload();
    this.saveProgress();
  }

  renderFlip(animate = true) {
    const fit = this.settings.fitMode || 'height';
    this.el.flipViewport.dataset.fit = fit;
    this.el.flipViewport.classList.toggle('can-scroll', fit === 'width' || fit === 'original');

    const double = Boolean(this.settings.doublePage) && this.total > 1;
    const rtl = this.settings.direction === 'rtl';
    const secondary = double && this.page + 1 < this.total ? this.page + 1 : null;

    let leftIndex = this.page;
    let rightIndex = null;
    if (secondary !== null) {
      leftIndex = rtl ? secondary : this.page;
      rightIndex = rtl ? this.page : secondary;
    }

    this.loadSlot(this.el.imgA, this.el.slotA, leftIndex);
    if (rightIndex !== null) {
      this.el.slotB.hidden = false;
      this.loadSlot(this.el.imgB, this.el.slotB, rightIndex);
    } else {
      this.el.slotB.hidden = true;
      this.el.imgB.removeAttribute('src');
    }

    this.showLoading(!(this.el.imgA.complete && this.el.imgA.naturalWidth > 0));

    if (animate && this.settings.animation) {
      const spread = this.el.pageSpread;
      spread.classList.remove('is-turning');
      void spread.offsetWidth;
      spread.classList.add('is-turning');
      clearTimeout(this._turnTimer);
      this._turnTimer = setTimeout(() => spread.classList.remove('is-turning'), 240);
    }

    this.el.pageBadge.textContent = `第 ${this.page + 1} / ${this.total} 页`;
    this.el.pageBadge.classList.toggle('is-off', !this.settings.showPageNumber);

    // 双页模式需要额外预载后两页
    this.preloadAround(secondary !== null ? 1 : 0);
  }

  loadSlot(img, slot, index) {
    slot.hidden = false;
    const url = this.pageUrl(index);
    if (img.dataset.url === url) return;
    img.dataset.url = url;
    img.dataset.index = String(index);
    img.src = url;
  }

  showLoading(visible) {
    this.el.loading.classList.toggle('is-visible', Boolean(visible));
  }

  checkLoading() {
    const ready = (img) => img.complete && img.naturalWidth > 0;
    const readyB = this.el.slotB.hidden ? true : ready(this.el.imgB);
    if (ready(this.el.imgA) && readyB) this.showLoading(false);
  }

  preloadAround(extra = 0) {
    const range = (this.settings.preloadPages || 0) + extra;
    if (!range) return;
    for (let distance = 1; distance <= range; distance += 1) {
      for (const index of [this.page + distance, this.page - distance]) {
        if (index < 0 || index >= this.total || this.preloadCache.has(index)) continue;
        const image = new Image();
        image.src = this.pageUrl(index);
        this.preloadCache.set(index, image);
      }
    }
    const limit = Math.max(6, range * 2 + 2);
    while (this.preloadCache.size > limit) {
      const firstKey = this.preloadCache.keys().next().value;
      this.preloadCache.delete(firstKey);
    }
  }

  previewPreload() {
    for (const [index, image] of this.preloadCache) {
      if (index < this.page - 4 || index > this.page + 6) {
        image.src = '';
        this.preloadCache.delete(index);
      }
    }
  }

  renderScroll() {
    const wide = this.settings.fitMode === 'width';
    this.el.scrollViewport.classList.toggle('is-wide', wide);
    this.el.reader.style.setProperty('--page-gap', `${this.settings.pageGap}px`);

    this.el.scrollViewport.innerHTML = this.pages.map((_, index) => (
      `<div class="scroll-page" data-index="${index}"><img src="${this.pageUrl(index)}" loading="lazy" alt=""></div>`
    )).join('');

    this.setupObserver();
    // 图片懒加载会不断改变页高，scrollToPage 会持续校正位置，避免切换模式后停在错误的页
    this.scrollToPage(this.page, false);
  }

  setupObserver() {
    this.destroyObserver();
    this.observer = new IntersectionObserver(() => this.syncPageFromScroll(), {
      root: this.el.scrollViewport,
      threshold: [0, 0.15, 0.3, 0.5, 0.75, 1]
    });
    for (const page of this.el.scrollViewport.querySelectorAll('.scroll-page')) {
      this.observer.observe(page);
    }
    // 滚动本身也是更可靠的触发源，避免快速滚动时页码滞后
    this.el.scrollViewport.addEventListener('scroll', this.onScrollTrack, { passive: true });
  }

  syncPageFromScroll() {
    const viewport = this.el.scrollViewport;
    if (!viewport || viewport.hidden) return;
    if (Date.now() < this.suppressScrollUntil) return;
    const rootRect = viewport.getBoundingClientRect();
    if (!rootRect.height) return;
    const mid = rootRect.top + rootRect.height / 2;
    let best = -1;
    let bestDist = Infinity;
    for (const page of viewport.querySelectorAll('.scroll-page')) {
      const rect = page.getBoundingClientRect();
      if (rect.bottom <= rootRect.top + 2 || rect.top >= rootRect.bottom - 2) continue;
      const dist = Math.abs(rect.top + rect.height / 2 - mid);
      if (dist < bestDist) {
        bestDist = dist;
        best = Number(page.dataset.index);
      }
    }
    if (best >= 0 && best !== this.page) {
      this.page = best;
      this.updateChrome();
      this.saveProgress();
    }
  }

  destroyObserver() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.onScrollTrack) this.el.scrollViewport.removeEventListener('scroll', this.onScrollTrack);
  }

  scrollByViewport(direction) {
    const viewport = this.el.scrollViewport;
    if (!viewport) return;
    this.stopScrollAlign();
    const step = Math.max(140, Math.round(viewport.clientHeight * 0.88));
    viewport.scrollBy({
      top: step * direction,
      behavior: this.settings.animation ? 'smooth' : 'auto'
    });
    this.showUI();
  }

  scrollToPage(index, smooth) {
    this.stopScrollAlign();
    const target = this.el.scrollViewport.querySelector(`.scroll-page[data-index="${index}"]`);
    if (!target) return;
    this.suppressScrollUntil = Date.now() + 650;
    this.el.scrollViewport.scrollTo({
      top: Math.max(0, target.offsetTop - 20),
      behavior: smooth ? 'smooth' : 'auto'
    });
    this.page = index;
    this.updateChrome();
    this.saveProgress();
    if (smooth) {
      clearTimeout(this.alignTimer);
      this.alignTimer = setTimeout(() => this.startScrollAlign(index), 420);
    } else {
      this.startScrollAlign(index);
    }
  }

  // 卷轴图片懒加载后高度会变化，短时间内在图片陆续加载完成时反复校正目标页位置
  startScrollAlign(index) {
    this.stopScrollAlign();
    const viewport = this.el.scrollViewport;
    if (!viewport) return;
    this.alignTarget = index;
    this.suppressScrollUntil = Date.now() + 2200;
    const until = performance.now() + 2200;
    const tick = () => {
      if (this.alignTarget !== index) return;
      const page = viewport.querySelector(`.scroll-page[data-index="${index}"]`);
      if (!page) {
        this.alignTarget = null;
        return;
      }
      const top = Math.max(0, page.offsetTop - 20);
      if (Math.abs(viewport.scrollTop - top) > 1) viewport.scrollTop = top;
      if (performance.now() < until) {
        this.alignFrame = requestAnimationFrame(tick);
      } else {
        this.alignTarget = null;
        this.alignFrame = 0;
        this.suppressScrollUntil = 0;
      }
    };
    tick();
  }

  stopScrollAlign() {
    clearTimeout(this.alignTimer);
    this.alignTimer = null;
    if (this.alignTarget === null && !this.alignFrame) return;
    this.alignTarget = null;
    if (this.alignFrame) cancelAnimationFrame(this.alignFrame);
    this.alignFrame = 0;
    this.suppressScrollUntil = 0;
  }

  // ---------------- 状态与导航 ----------------

  updateChrome() {
    this.el.slider.max = String(Math.max(0, this.total - 1));
    this.el.slider.value = String(this.page);
    this.el.pageTotal.textContent = String(this.total);
    if (document.activeElement !== this.el.pageInput) {
      this.el.pageInput.value = String(this.page + 1);
    }
    this.el.pageBadge.textContent = `第 ${this.page + 1} / ${this.total} 页`;
    this.el.pageBadge.classList.toggle('is-off', !this.settings.showPageNumber);
    this.el.bookmarkBtn.classList.toggle('is-on', this.bookmarks.has(this.page));
  }

  updateModeButtons() {
    for (const button of this.el.modeSwitch.querySelectorAll('button')) {
      button.classList.toggle('is-active', button.dataset.mode === this.mode);
    }
  }

  setPage(index, options = {}) {
    const next = clamp(index, 0, this.total - 1);
    if (next === this.page) {
      this.updateChrome();
      return;
    }
    if (this.zoom > 1) this.resetZoom();
    this.page = next;
    if (this.mode === 'flip') this.renderFlip(true);
    else if (!options.fromScroll) this.scrollToPage(next, true);
    this.updateChrome();
    this.saveProgress();
    this.showUI();
  }

  jumpTo(index) {
    this.setPage(index);
  }

  goNext(step = null) {
    const size = step ?? (this.settings.doublePage && this.total > 2 ? 2 : 1);
    this.setPage(this.page + size);
  }

  goPrev(step = null) {
    const size = step ?? (this.settings.doublePage && this.total > 2 ? 2 : 1);
    this.setPage(this.page - size);
  }

  setMode(mode) {
    if (!this.visible || mode === this.mode) return;
    this.mode = mode;
    this.resetZoom();
    this.stopScrollAlign();
    this.destroyObserver();
    this.renderMode();
    this.showUI();
  }

  saveProgress(immediate = false) {
    clearTimeout(this.saveTimer);
    const run = () => {
      if (!this.book) return;
      this.api.setProgress(this.book.id, this.page, this.total);
    };
    if (immediate) run();
    else this.saveTimer = setTimeout(run, 320);
  }

  // ---------------- 缩放 ----------------

  applyZoom() {
    const layer = this.el.pageSpread;
    layer.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
    layer.classList.toggle('is-zoomed', this.zoom > 1);
    this.el.stage.classList.toggle('is-pannable', this.zoom > 1);
    this.el.zoomBadge.textContent = `缩放 ${Math.round(this.zoom * 100)}%`;
    this.el.zoomBadge.classList.toggle('is-visible', this.zoom > 1);
  }

  setZoom(value) {
    if (this.mode !== 'flip') return;
    this.zoom = clamp(value, 1, 5);
    if (this.zoom === 1) {
      this.panX = 0;
      this.panY = 0;
    }
    this.applyZoom();
    this.showUI();
  }

  resetZoom() {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.applyZoom();
  }

  // ---------------- 书签与面板 ----------------

  async toggleBookmark() {
    if (!this.book) return;
    const result = await this.api.toggleBookmark(this.book.id, this.page);
    if (result.bookmarked) {
      this.bookmarks.add(this.page);
      this.toast(`已添加书签：第 ${this.page + 1} 页`);
    } else {
      this.bookmarks.delete(this.page);
      this.toast(`已移除第 ${this.page + 1} 页的书签`);
    }
    this.updateChrome();
  }

  toggleSettingsPanel() {
    const willOpen = this.el.settingsPanel.hidden;
    this.closePanels();
    if (willOpen) {
      this.syncSettingsUI();
      this.el.settingsPanel.hidden = false;
      this.el.scrim.hidden = false;
    }
    this.showUI();
  }

  closePanels() {
    this.el.settingsPanel.hidden = true;
    this.el.scrim.hidden = true;
  }

  samePanelOpen() {
    return !this.el.settingsPanel.hidden;
  }

  // ---------------- 设置 ----------------

  applyReaderSettings() {
    const s = this.settings;
    this.el.reader.style.setProperty('--reader-bg', BG_COLORS[s.background] || BG_COLORS.ink);
    this.el.reader.style.setProperty('--page-gap', `${s.pageGap}px`);
    this.el.reader.style.setProperty('--reader-brightness', String((s.brightness || 100) / 100));
    this.el.flipViewport.dataset.fit = s.fitMode || 'height';
    this.el.flipViewport.classList.toggle('can-scroll', s.fitMode === 'width' || s.fitMode === 'original');
    this.el.scrollViewport.classList.toggle('is-wide', s.fitMode === 'width');
    this.el.pageBadge.classList.toggle('is-off', !s.showPageNumber);
    this.el.zoomBadge.classList.toggle('is-visible', this.zoom > 1);
    if (!s.autoHideToolbar) {
      clearTimeout(this.hideTimer);
      this.el.reader.classList.remove('ui-hidden');
    }
  }

  syncSettingsUI() {
    const s = this.settings;
    const panel = this.el.settingsPanel;
    const setValue = (key, value) => {
      const target = panel.querySelector(`[data-rsetting="${key}"]`);
      if (!target) return;
      if (target.matches('input[type="checkbox"]')) target.checked = Boolean(value);
      else if (target.matches('input[type="range"]')) {
        target.value = value;
        const em = target.closest('.range-wrap')?.querySelector('em');
        if (em) em.textContent = this.rangeLabel(key, Number(value));
      } else if (target.matches('select')) target.value = value;
    };

    setValue('fitMode', s.fitMode);
    setValue('doublePage', s.doublePage);
    setValue('animation', s.animation);
    setValue('preloadPages', s.preloadPages);
    setValue('pageGap', s.pageGap);
    setValue('autoHideToolbar', s.autoHideToolbar);
    setValue('showPageNumber', s.showPageNumber);
    setValue('brightness', s.brightness);

    for (const button of panel.querySelectorAll('[data-rsetting="direction"] button')) {
      button.classList.toggle('is-active', button.dataset.value === s.direction);
    }
    for (const button of panel.querySelectorAll('[data-rsetting="background"] button')) {
      button.classList.toggle('is-active', button.dataset.value === s.background);
    }

    refreshSelects(panel);
  }

  rangeLabel(key, value) {
    if (key === 'pageGap') return `${value} px`;
    if (key === 'brightness') return `${value}%`;
    if (key === 'preloadPages') return `${value} 页`;
    return String(value);
  }

  updateSetting(key, value, syncButtons = false) {
    this.settings[key] = value;

    if ((key === 'direction' || key === 'doublePage') && this.mode === 'flip') {
      this.renderFlip(true);
    }
    if (key === 'fitMode') {
      this.el.scrollViewport.classList.toggle('is-wide', value === 'width');
      if (this.mode === 'flip') this.renderFlip(true);
    }
    if (key === 'pageGap') this.el.reader.style.setProperty('--page-gap', `${value}px`);
    if (key === 'brightness') {
      this.el.reader.style.setProperty('--reader-brightness', String(value / 100));
    }
    if (key === 'background') {
      this.el.reader.style.setProperty('--reader-bg', BG_COLORS[value] || BG_COLORS.ink);
    }
    if (key === 'showPageNumber') {
      this.el.pageBadge.classList.toggle('is-off', !value);
    }
    if (key === 'autoHideToolbar') {
      if (value) this.scheduleHide();
      else {
        clearTimeout(this.hideTimer);
        this.el.reader.classList.remove('ui-hidden');
      }
    }
    if (key === 'preloadPages') this.preloadAround();

    if (syncButtons) {
      const group = this.el.settingsPanel.querySelector(`[data-rsetting="${key}"]`);
      if (group) {
        for (const button of group.querySelectorAll('button')) {
          button.classList.toggle('is-active', button.dataset.value === value);
        }
      }
    }

    clearTimeout(this.settingsTimer);
    this.settingsTimer = setTimeout(async () => {
      const saved = await this.api.updateSettings(this.settings);
      if (this.onSettingsChange) this.onSettingsChange(saved);
    }, 260);
  }

  // ---------------- 自动隐藏 ----------------

  showUI() {
    this.el.reader.classList.remove('ui-hidden');
    this.scheduleHide();
  }

  scheduleHide() {
    clearTimeout(this.hideTimer);
    if (!this.settings || !this.settings.autoHideToolbar) return;
    this.hideTimer = setTimeout(() => {
      if (!this.visible || this.samePanelOpen()) return;
      if (this.el.top.matches(':hover') || this.el.bottom.matches(':hover')) {
        this.scheduleHide();
        return;
      }
      this.el.reader.classList.add('ui-hidden');
    }, 2600);
  }

  // ---------------- 事件绑定 ----------------

  bindGlobal() {
    if (this.globalBound) return;
    this.globalBound = true;

    this.onKeyDown = (event) => this.handleKeyDown(event);
    this.onMove = () => this.showUI();
    this.onWheel = (event) => this.handleWheel(event);
    this.onPointerDown = (event) => this.handlePointerDown(event);
    this.onPointerMove = (event) => this.handlePointerMove(event);
    this.onPointerUp = (event) => this.handlePointerUp(event);
    this.onClick = (event) => this.handleStageClick(event);
    this.onDblClick = (event) => this.handleDoubleClick(event);
    this.onFullscreen = () => document.body.classList.toggle('fullscreen', Boolean(document.fullscreenElement));

    document.addEventListener('keydown', this.onKeyDown);
    this.el.reader.addEventListener('mousemove', this.onMove);
    this.el.reader.addEventListener('wheel', this.onWheel, { passive: false });
    this.el.stage.addEventListener('pointerdown', this.onPointerDown);
    this.el.stage.addEventListener('pointermove', this.onPointerMove);
    this.el.stage.addEventListener('pointerup', this.onPointerUp);
    this.el.stage.addEventListener('click', this.onClick);
    this.el.stage.addEventListener('dblclick', this.onDblClick);
    document.addEventListener('fullscreenchange', this.onFullscreen);
  }

  unbindGlobal() {
    if (!this.globalBound) return;
    this.globalBound = false;
    document.removeEventListener('keydown', this.onKeyDown);
    this.el.reader.removeEventListener('mousemove', this.onMove);
    this.el.reader.removeEventListener('wheel', this.onWheel);
    this.el.stage.removeEventListener('pointerdown', this.onPointerDown);
    this.el.stage.removeEventListener('pointermove', this.onPointerMove);
    this.el.stage.removeEventListener('pointerup', this.onPointerUp);
    this.el.stage.removeEventListener('click', this.onClick);
    this.el.stage.removeEventListener('dblclick', this.onDblClick);
    document.removeEventListener('fullscreenchange', this.onFullscreen);
    clearTimeout(this.hideTimer);
    clearTimeout(this.tapTimer);
    clearTimeout(this._turnTimer);
    this.preloadCache.clear();
  }

  handleWheel(event) {
    if (this.mode === 'scroll') this.stopScrollAlign();
    if (this.mode !== 'flip') return;

    if (event.ctrlKey) {
      event.preventDefault();
      this.setZoom(this.zoom + (event.deltaY < 0 ? 0.2 : -0.2));
      return;
    }

    if (this.zoom > 1) {
      event.preventDefault();
      this.panY -= event.deltaY;
      this.panX -= event.deltaX;
      this.applyZoom();
      return;
    }

    event.preventDefault();
    const now = Date.now();
    if (now - this.lastWheel < 200) return;
    this.lastWheel = now;
    if (event.deltaY > 0) this.goNext();
    else this.goPrev();
  }

  handlePointerDown(event) {
    if (this.mode === 'scroll') this.stopScrollAlign();
    if (this.mode !== 'flip' || event.button !== 0) return;
    this.dragging = true;
    this.dragMove = false;
    this.dragStart = { x: event.clientX, y: event.clientY, panX: this.panX, panY: this.panY };
    this.dragDx = 0;
    this.dragDy = 0;
    try { this.el.stage.setPointerCapture(event.pointerId); } catch { /* ignore */ }
  }

  handlePointerMove(event) {
    if (!this.dragging) return;
    const dx = event.clientX - this.dragStart.x;
    const dy = event.clientY - this.dragStart.y;
    this.dragDx = dx;
    this.dragDy = dy;

    if (this.zoom > 1) {
      this.panX = this.dragStart.panX + dx;
      this.panY = this.dragStart.panY + dy;
      this.applyZoom();
      this.el.stage.classList.add('is-panning');
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) this.suppressClick = true;
    } else if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
      this.suppressClick = true;
    }
  }

  handlePointerUp() {
    if (!this.dragging) return;
    this.dragging = false;
    this.el.stage.classList.remove('is-panning');

    const dx = this.dragDx;
    const dy = this.dragDy;
    const moved = Math.abs(dx) > 6 || Math.abs(dy) > 6;

    if (this.zoom > 1) {
      this.suppressClick = moved;
      if (moved) setTimeout(() => { this.suppressClick = false; }, 80);
      return;
    }

    if (!moved) {
      this.suppressClick = false;
      return;
    }

    this.suppressClick = true;
    setTimeout(() => { this.suppressClick = false; }, 80);

    if (Math.abs(dx) > 72 && Math.abs(dy) < 60) {
      const rtl = this.settings.direction === 'rtl';
      if ((!rtl && dx < 0) || (rtl && dx > 0)) this.goNext();
      else this.goPrev();
    }
  }

  handleStageClick(event) {
    if (this.suppressClick) {
      this.suppressClick = false;
      return;
    }
    if (event.detail > 1) {
      clearTimeout(this.tapTimer);
      return;
    }
    const rect = this.el.stage.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    this.tapTimer = setTimeout(() => {
      if (this.mode !== 'flip') {
        this.el.reader.classList.toggle('ui-hidden');
        return;
      }
      if (ratio < 0.33) {
        const rtl = this.settings.direction === 'rtl';
        if (rtl) this.goNext();
        else this.goPrev();
      } else if (ratio > 0.67) {
        const rtl = this.settings.direction === 'rtl';
        if (rtl) this.goPrev();
        else this.goNext();
      } else {
        this.el.reader.classList.toggle('ui-hidden');
      }
    }, 200);
  }

  handleDoubleClick() {
    clearTimeout(this.tapTimer);
    if (this.mode !== 'flip') return;
    if (this.zoom > 1) this.resetZoom();
    else this.setZoom(2.2);
  }

  handleKeyDown(event) {
    if (!this.visible) return;
    const target = event.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) {
      if (event.key !== 'Escape') return;
    }

    const rtl = this.settings.direction === 'rtl';
    const key = event.key;
    const code = event.code;

    switch (key) {
      case 'Escape':
        if (document.fullscreenElement) {
          document.exitFullscreen().catch(() => {});
          return;
        }
        if (this.zoom > 1) {
          this.resetZoom();
          return;
        }
        if (this.samePanelOpen()) {
          this.closePanels();
          return;
        }
        this.close();
        return;
      case 'ArrowRight':
        event.preventDefault();
        if (rtl) this.goPrev();
        else this.goNext();
        return;
      case 'ArrowLeft':
        event.preventDefault();
        if (rtl) this.goNext();
        else this.goPrev();
        return;
      case 'ArrowDown':
        event.preventDefault();
        if (this.mode === 'scroll') this.scrollByViewport(1);
        else this.goNext();
        return;
      case 'ArrowUp':
        event.preventDefault();
        if (this.mode === 'scroll') this.scrollByViewport(-1);
        else this.goPrev();
        return;
      case 'PageDown':
        event.preventDefault();
        if (this.mode === 'scroll') this.scrollByViewport(1);
        else this.goNext();
        return;
      case 'PageUp':
        event.preventDefault();
        if (this.mode === 'scroll') this.scrollByViewport(-1);
        else this.goPrev();
        return;
      case 'Home':
        event.preventDefault();
        this.jumpTo(0);
        return;
      case 'End':
        event.preventDefault();
        this.jumpTo(this.total - 1);
        return;
      case ' ':
        event.preventDefault();
        if (this.mode === 'scroll') {
          this.scrollByViewport(event.shiftKey ? -1 : 1);
        } else if (event.shiftKey) {
          this.goPrev();
        } else {
          this.goNext();
        }
        return;
      default:
        break;
    }

    switch (code) {
      case 'KeyF':
        this.toggleFullscreen();
        break;
      case 'KeyM':
        this.setMode(this.mode === 'flip' ? 'scroll' : 'flip');
        break;
      case 'KeyB':
        this.toggleBookmark();
        break;
      case 'Minus':
      case 'NumpadSubtract':
        this.setZoom(this.zoom - 0.2);
        break;
      case 'Equal':
      case 'NumpadAdd':
        this.setZoom(this.zoom + 0.2);
        break;
      case 'Digit0':
      case 'Numpad0':
        this.resetZoom();
        break;
      case 'Slash':
        this.toggleSettingsPanel();
        break;
      default:
        break;
    }
  }

  async toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      this.toast('无法切换全屏', true);
    }
  }

  // ---------------- 关闭 ----------------

  async close() {
    if (!this.visible) return;
    this.visible = false;
    this.stopScrollAlign();
    this.saveProgress(true);
    this.unbindGlobal();
    this.destroyObserver();
    this.closePanels();
    this.el.slider.value = '0';
    this.el.pageInput.value = '1';
    this.el.reader.hidden = true;
    this.el.reader.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('reading');
    this.el.reader.classList.remove('ui-hidden');
    clearTimeout(this.saveTimer);
    clearTimeout(this.settingsTimer);
    if (document.fullscreenElement) {
      try { await document.exitFullscreen(); } catch { /* ignore */ }
    }
    document.body.classList.remove('fullscreen');
    this.book = null;
    this.pages = [];
    if (this.onClose) await this.onClose();
  }
}

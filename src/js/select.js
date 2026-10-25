// 自定义下拉框：原生 select 保留数据与事件，外观由按钮 + 浮动菜单接管
let openState = null;

function optionText(option) {
  return option.label || option.textContent.trim();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

function isReaderSelect(select) {
  return Boolean(select.closest('.reader-settings'));
}

function refreshSelect(wrapper) {
  const { select, trigger } = wrapper.ocSelect;
  const value = trigger.querySelector('.oc-select-value');
  const option = select.options[select.selectedIndex];
  value.textContent = option ? optionText(option) : '';
  trigger.disabled = select.disabled;
  wrapper.classList.toggle('is-disabled', select.disabled);
}

function setActive(index) {
  if (!openState) return;
  const items = openState.menu.querySelectorAll('.oc-select-option');
  if (!items.length) return;
  openState.index = Math.min(items.length - 1, Math.max(0, index));
  items.forEach((item, itemIndex) => item.classList.toggle('is-hover', itemIndex === openState.index));

  // 只滚动菜单内部，避免触发页面滚动导致菜单被关闭
  const item = items[openState.index];
  const menu = openState.menu;
  const top = item.offsetTop;
  const bottom = top + item.offsetHeight;
  if (top < menu.scrollTop) menu.scrollTop = Math.max(0, top - 4);
  else if (bottom > menu.scrollTop + menu.clientHeight) {
    menu.scrollTop = bottom - menu.clientHeight + 4;
  }
}

function choose(index) {
  if (!openState) return;
  const { select } = openState;
  const option = select.options[index];
  if (!option || option.disabled) return;
  const wrapper = openState.wrapper;
  select.value = option.value;
  refreshSelect(wrapper);
  closeSelectMenu();
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

export function closeSelectMenu() {
  if (!openState) return;
  openState.wrapper.classList.remove('is-open');
  openState.trigger.setAttribute('aria-expanded', 'false');
  openState.menu.remove();
  openState = null;
}

function openSelectMenu(wrapper, focusEdge) {
  closeSelectMenu();
  const { select, trigger } = wrapper.ocSelect;
  if (select.disabled) return;

  const menu = document.createElement('div');
  menu.className = 'oc-select-menu';
  if (isReaderSelect(select)) menu.classList.add('is-dark');
  menu.setAttribute('role', 'listbox');

  const options = Array.from(select.options);
  menu.innerHTML = options.map((option, index) => `
    <button type="button" role="option" class="oc-select-option${index === select.selectedIndex ? ' is-selected' : ''}"
      data-index="${index}" aria-selected="${index === select.selectedIndex}"${option.disabled ? ' disabled' : ''}>
      ${escapeHtml(optionText(option))}
    </button>
  `).join('');

  menu.addEventListener('click', (event) => {
    const item = event.target.closest('.oc-select-option');
    if (!item) return;
    event.stopPropagation();
    choose(Number(item.dataset.index));
  });

  menu.addEventListener('mouseover', (event) => {
    const item = event.target.closest('.oc-select-option');
    if (item) setActive(Number(item.dataset.index));
  });

  document.body.appendChild(menu);
  openState = {
    wrapper,
    select,
    trigger,
    menu,
    index: select.selectedIndex >= 0 ? select.selectedIndex : 0
  };
  wrapper.classList.add('is-open');
  trigger.setAttribute('aria-expanded', 'true');

  // 先隐藏测量，再根据可视区域定位
  menu.style.visibility = 'hidden';
  menu.style.width = `${Math.max(trigger.getBoundingClientRect().width, 132)}px`;
  const rect = trigger.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  let left = Math.min(rect.left, window.innerWidth - menuRect.width - 8);
  let top = rect.bottom + 6;
  if (top + menuRect.height > window.innerHeight - 8) {
    top = rect.top - menuRect.height - 6;
  }
  if (top < 8) top = Math.max(8, window.innerHeight - menuRect.height - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${top}px`;
  menu.style.visibility = 'visible';

  if (focusEdge === 'last') setActive(options.length - 1);
  else if (focusEdge === 'first') setActive(0);
  else setActive(openState.index);
}

export function enhanceSelects(root = document) {
  for (const select of root.querySelectorAll('select:not([data-oc-select])')) {
    if (select.closest('.oc-select') || !select.parentNode) continue;

    const wrapper = document.createElement('div');
    wrapper.className = 'oc-select';
    if (select.closest('.field')) wrapper.classList.add('is-block');

    select.parentNode.insertBefore(wrapper, select);
    wrapper.appendChild(select);
    select.dataset.ocSelect = '1';
    select.classList.add('oc-select-native');
    select.setAttribute('tabindex', '-1');

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = `oc-select-trigger${isReaderSelect(select) ? ' is-dark' : ''}`;
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.innerHTML = '<span class="oc-select-value"></span><span class="oc-select-chevron" aria-hidden="true"></span>';
    wrapper.appendChild(trigger);

    wrapper.ocSelect = { select, trigger };
    refreshSelect(wrapper);

    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (openState && openState.wrapper === wrapper) closeSelectMenu();
      else openSelectMenu(wrapper);
    });

    trigger.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      event.stopPropagation();
      if (openState && openState.wrapper === wrapper) {
        setActive(openState.index + (event.key === 'ArrowDown' ? 1 : -1));
      } else {
        openSelectMenu(wrapper, event.key === 'ArrowDown' ? 'first' : 'last');
      }
    });

    select.addEventListener('change', () => refreshSelect(wrapper));
  }
}

export function refreshSelects(root = document) {
  for (const wrapper of root.querySelectorAll('.oc-select')) {
    if (wrapper.ocSelect) refreshSelect(wrapper);
  }
}

document.addEventListener('click', (event) => {
  if (!openState) return;
  if (event.target.closest('.oc-select-menu') || event.target.closest('.oc-select-trigger')) return;
  closeSelectMenu();
});

document.addEventListener('scroll', (event) => {
  if (!openState) return;
  if (event.target.closest && event.target.closest('.oc-select-menu')) return;
  closeSelectMenu();
}, true);

window.addEventListener('resize', () => closeSelectMenu());

document.addEventListener('keydown', (event) => {
  if (!openState) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopImmediatePropagation();
    closeSelectMenu();
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    event.stopImmediatePropagation();
    setActive(openState.index + (event.key === 'ArrowDown' ? 1 : -1));
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    event.stopImmediatePropagation();
    choose(openState.index);
  } else if (event.key === 'Tab') {
    closeSelectMenu();
  }
});

require('./preload-base.js');

function installControlPolish() {
  const style = document.createElement('style');
  style.id = 'github-actions-monitor-control-polish';
  style.textContent = `
    .controls {
      align-items: center;
      gap: 8px !important;
    }

    .controls #refresh,
    .controls .runner-load-button,
    .controls .runner-toggle-button {
      width: 118px !important;
      min-width: 118px !important;
      height: 42px !important;
      min-height: 42px !important;
      padding: 0 12px !important;
      box-sizing: border-box;
      border-radius: 10px !important;
      display: inline-flex !important;
      align-items: center;
      justify-content: center;
      line-height: 1;
      font-size: 12px;
      font-weight: 850;
    }

    .controls .runner-status-chip {
      height: 42px;
      min-height: 42px;
      box-sizing: border-box;
      padding: 0 12px;
    }

    .controls #token {
      height: 42px;
      min-height: 42px;
      box-sizing: border-box;
      border-radius: 10px;
    }

    .repo-wrap {
      position: relative;
      overflow: visible !important;
    }

    #repoPicker {
      display: none !important;
    }

    .repo-custom-dropdown {
      position: relative;
      width: 278px;
      min-width: 278px;
      height: 42px;
      z-index: 40;
    }

    .repo-dropdown-trigger {
      width: 100%;
      height: 42px;
      padding: 0 12px;
      border: 1px solid #2e5c8c;
      border-radius: 11px;
      background: linear-gradient(180deg, #0f2742 0%, #0b1e34 100%);
      color: #eef6ff;
      display: flex;
      align-items: center;
      gap: 9px;
      box-sizing: border-box;
      cursor: pointer;
      font: inherit;
      box-shadow: inset 0 1px 0 rgba(255,255,255,.035), 0 5px 16px rgba(0,0,0,.14);
      transition: border-color .16s ease, box-shadow .16s ease, background .16s ease;
    }

    .repo-dropdown-trigger:hover,
    .repo-custom-dropdown.open .repo-dropdown-trigger {
      border-color: #4d9cff;
      background: linear-gradient(180deg, #123052 0%, #0d2541 100%);
      box-shadow: 0 0 0 3px rgba(77,156,255,.10), inset 0 1px 0 rgba(255,255,255,.04);
    }

    .repo-dropdown-icon {
      width: 20px;
      height: 20px;
      border-radius: 7px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
      color: #7bb8ff;
      background: rgba(77,156,255,.12);
      border: 1px solid rgba(77,156,255,.24);
      font-size: 11px;
      font-weight: 900;
    }

    .repo-dropdown-label {
      min-width: 0;
      flex: 1 1 auto;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      text-align: left;
      font-size: 12px;
      font-weight: 760;
    }

    .repo-dropdown-chevron {
      color: #88a6c8;
      font-size: 10px;
      transition: transform .16s ease;
    }

    .repo-custom-dropdown.open .repo-dropdown-chevron {
      transform: rotate(180deg);
    }

    .repo-dropdown-menu {
      position: absolute;
      top: calc(100% + 7px);
      left: 0;
      width: 100%;
      max-height: 340px;
      display: none;
      overflow: hidden;
      border: 1px solid #294c72;
      border-radius: 12px;
      background: #0a1829;
      box-shadow: 0 18px 42px rgba(0,0,0,.46), inset 0 1px 0 rgba(255,255,255,.035);
      z-index: 9999;
    }

    .repo-custom-dropdown.open .repo-dropdown-menu {
      display: block;
    }

    .repo-dropdown-search-wrap {
      padding: 8px;
      border-bottom: 1px solid #1e3651;
      background: #0b1b2e;
    }

    .repo-dropdown-search {
      width: 100%;
      height: 34px;
      padding: 0 10px;
      border: 1px solid #294c72;
      border-radius: 8px;
      outline: none;
      box-sizing: border-box;
      background: #071421;
      color: #eef6ff;
      font: inherit;
      font-size: 12px;
    }

    .repo-dropdown-search:focus {
      border-color: #4d9cff;
      box-shadow: 0 0 0 3px rgba(77,156,255,.10);
    }

    .repo-dropdown-list {
      max-height: 286px;
      overflow: auto;
      padding: 6px;
      scrollbar-width: thin;
      scrollbar-color: #31577f transparent;
    }

    .repo-dropdown-item {
      width: 100%;
      min-height: 38px;
      padding: 8px 10px;
      border: 0;
      border-radius: 8px;
      background: transparent;
      color: #cbd9ea;
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      text-align: left;
      font: inherit;
      font-size: 12px;
    }

    .repo-dropdown-item:hover {
      background: rgba(77,156,255,.10);
      color: #ffffff;
    }

    .repo-dropdown-item.selected {
      background: rgba(77,156,255,.16);
      color: #ffffff;
      box-shadow: inset 2px 0 0 #4d9cff;
    }

    .repo-dropdown-item:disabled {
      opacity: .45;
      cursor: not-allowed;
    }

    .repo-dropdown-item-mark {
      width: 16px;
      flex: 0 0 16px;
      color: #70b1ff;
      font-weight: 900;
    }

    .repo-dropdown-item-name {
      min-width: 0;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .runner-repo-count {
      display: none !important;
    }

    @media (max-width: 1180px) {
      .repo-custom-dropdown {
        width: 245px;
        min-width: 245px;
      }
      .controls #refresh,
      .controls .runner-load-button,
      .controls .runner-toggle-button {
        width: 108px !important;
        min-width: 108px !important;
      }
    }
  `;
  document.head.appendChild(style);

  const picker = document.getElementById('repoPicker');
  const repoWrap = picker?.parentElement;
  if (!picker || !repoWrap || document.getElementById('repoCustomDropdown')) return;

  const custom = document.createElement('div');
  custom.id = 'repoCustomDropdown';
  custom.className = 'repo-custom-dropdown';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'repo-dropdown-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');

  const icon = document.createElement('span');
  icon.className = 'repo-dropdown-icon';
  icon.textContent = '◎';

  const label = document.createElement('span');
  label.className = 'repo-dropdown-label';
  label.textContent = 'Chọn repository';

  const chevron = document.createElement('span');
  chevron.className = 'repo-dropdown-chevron';
  chevron.textContent = '▼';

  trigger.append(icon, label, chevron);

  const menu = document.createElement('div');
  menu.className = 'repo-dropdown-menu';

  const searchWrap = document.createElement('div');
  searchWrap.className = 'repo-dropdown-search-wrap';

  const search = document.createElement('input');
  search.className = 'repo-dropdown-search';
  search.type = 'text';
  search.placeholder = 'Tìm repository…';
  search.autocomplete = 'off';
  searchWrap.append(search);

  const list = document.createElement('div');
  list.className = 'repo-dropdown-list';
  list.setAttribute('role', 'listbox');

  menu.append(searchWrap, list);
  custom.append(trigger, menu);
  repoWrap.append(custom);

  function closeMenu() {
    custom.classList.remove('open');
    trigger.setAttribute('aria-expanded', 'false');
    search.value = '';
    rebuild();
  }

  function openMenu() {
    custom.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => search.focus());
  }

  function syncLabel() {
    const option = picker.selectedOptions?.[0];
    label.textContent = option?.textContent?.trim() || picker.value || 'Chọn repository';
    trigger.title = option?.textContent?.trim() || picker.value || '';
  }

  function rebuild() {
    const query = search.value.trim().toLowerCase();
    list.replaceChildren();

    for (const option of [...picker.options]) {
      const text = option.textContent?.trim() || option.value;
      if (query && !text.toLowerCase().includes(query)) continue;

      const item = document.createElement('button');
      item.type = 'button';
      item.className = `repo-dropdown-item${option.value === picker.value ? ' selected' : ''}`;
      item.disabled = option.disabled;
      item.dataset.value = option.value;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', option.value === picker.value ? 'true' : 'false');

      const mark = document.createElement('span');
      mark.className = 'repo-dropdown-item-mark';
      mark.textContent = option.value === picker.value ? '✓' : '○';

      const name = document.createElement('span');
      name.className = 'repo-dropdown-item-name';
      name.textContent = text;

      item.append(mark, name);
      item.addEventListener('click', () => {
        if (option.disabled) return;
        picker.value = option.value;
        picker.dispatchEvent(new Event('change', { bubbles: true }));
        syncLabel();
        closeMenu();
      });
      list.append(item);
    }

    if (!list.childElementCount) {
      const empty = document.createElement('div');
      empty.style.padding = '14px 12px';
      empty.style.color = '#8098b5';
      empty.style.fontSize = '12px';
      empty.textContent = 'Không tìm thấy repository';
      list.append(empty);
    }

    syncLabel();
  }

  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    if (custom.classList.contains('open')) closeMenu();
    else openMenu();
  });

  search.addEventListener('input', rebuild);
  search.addEventListener('click', (event) => event.stopPropagation());
  menu.addEventListener('click', (event) => event.stopPropagation());
  picker.addEventListener('change', () => {
    syncLabel();
    rebuild();
  });

  const observer = new MutationObserver(rebuild);
  observer.observe(picker, { childList: true, subtree: true, attributes: true });

  document.addEventListener('click', closeMenu);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenu();
  });

  rebuild();
}

window.addEventListener('DOMContentLoaded', () => {
  installControlPolish();
}, { once: true });

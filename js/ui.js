// ui.js - small Win32-flavoured UI toolkit: menu bar, popup menus, dialogs.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// "&File" -> <span>File</span> with underlined mnemonic
export function labelNode(label) {
  const span = h('span', { class: 'mn-label' });
  const i = label.indexOf('&');
  if (i >= 0 && i < label.length - 1 && label[i + 1] !== '&') {
    span.append(label.slice(0, i).replace(/&&/g, '&'), h('u', {}, label[i + 1]), label.slice(i + 2).replace(/&&/g, '&'));
  } else {
    span.append(label.replace(/&&/g, '&'));
  }
  return span;
}
export function mnemonic(label) {
  const m = /&([^&])/.exec(label);
  return m ? m[1].toLowerCase() : null;
}
const resolve = (v) => (typeof v === 'function' ? v() : v);

// ------------------------------------------------------------------ popup menus
let openPopups = [];

export function closeAllPopups() {
  for (const p of openPopups) p.el.remove();
  openPopups = [];
  document.removeEventListener('mousedown', outsideHandler, true);
  if (activeBar) activeBar.deactivate();
}
function outsideHandler(e) {
  if (openPopups.some((p) => p.el.contains(e.target))) return;
  if (activeBar && activeBar.el.contains(e.target)) return;
  closeAllPopups();
}
function closeFrom(level) {
  while (openPopups.length > level) openPopups.pop().el.remove();
  const top = openPopups[openPopups.length - 1];
  if (top) top.el.style.visibility = '';
}

let activeBar = null;

class Popup {
  constructor(items, level, onCommand) {
    this.items = resolve(items).filter(Boolean);
    this.level = level;
    this.onCommand = onCommand;
    this.sel = -1;
    this.el = h('div', { class: 'menu-popup', role: 'menu' });
    this.rows = [];
    this.items.forEach((it, i) => {
      if (it === '-') {
        this.el.append(h('div', { class: 'menu-sep' }));
        this.rows.push(null);
        return;
      }
      const enabled = it.enabled === undefined ? true : !!resolve(it.enabled);
      const checked = it.checked !== undefined && !!resolve(it.checked);
      const row = h('div', {
        class: 'menu-item' + (enabled ? '' : ' disabled') + (it.submenu ? ' has-sub' : ''),
        role: 'menuitem',
      },
      h('span', { class: 'menu-check' }, checked ? (it.radio ? '●' : '✓') : ''),
      h('span', { class: 'menu-text' }, labelNode(resolve(it.label))),
      h('span', { class: 'menu-key' }, it.key || ''),
      h('span', { class: 'menu-arrow' }, it.submenu ? '›' : ''));
      row.addEventListener('pointerenter', (e) => this.select(i, e.pointerType === 'mouse'));
      row.addEventListener('mousedown', (e) => e.preventDefault());
      row.addEventListener('click', (e) => { e.stopPropagation(); this.activate(i); });
      this.el.append(row);
      this.rows.push(row);
      it._enabled = enabled;
    });
  }
  showAt(x, y, alignRightOf) {
    document.body.append(this.el);
    const r = this.el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    if (alignRightOf) {
      x = alignRightOf.right - 2;
      y = alignRightOf.top - 3;
      if (x + r.width > vw) x = Math.max(0, alignRightOf.left - r.width + 2);
    } else if (x + r.width > vw) {
      x = Math.max(0, vw - r.width - 2);
    }
    if (y + r.height > vh) y = Math.max(0, vh - r.height - 2);
    if (x < 0) x = 0;
    this.el.style.left = x + 'px';
    this.el.style.top = y + 'px';
  }
  select(i, openSub) {
    if (this.sel >= 0 && this.rows[this.sel]) this.rows[this.sel].classList.remove('hot');
    this.sel = i;
    const row = this.rows[i];
    if (row) row.classList.add('hot');
    closeFrom(this.level + 1);
    const it = this.items[i];
    if (openSub && it && it.submenu && it._enabled) {
      clearTimeout(this.subTimer);
      this.subTimer = setTimeout(() => {
        if (this.sel === i && openPopups.length === this.level + 1) this.openSub(i, false);
      }, 180);
    }
  }
  openSub(i, selectFirst) {
    const it = this.items[i];
    closeFrom(this.level + 1);
    if (document.body.classList.contains('narrow')) {
      // Drill-down: the submenu replaces its parent, with a row to go back
      const parent = this;
      const back = { label: '‹  ' + resolve(it.label).replace(/&(?!&)/g, ''), action: () => {
        closeFrom(parent.level + 1);
        parent.el.style.visibility = '';
      }, keepOpen: true };
      const sub = () => [back, '-', ...resolve(it.submenu).filter(Boolean)];
      const p = new Popup(sub, this.level + 1, this.onCommand);
      p.el.classList.add('drill');
      p.rows[0] && p.rows[0].classList.add('menu-back');
      openPopups.push(p);
      const r = this.el.getBoundingClientRect();
      p.showAt(r.left, r.top);
      this.el.style.visibility = 'hidden';
      if (selectFirst) p.moveSel(1);
      return p;
    }
    const p = new Popup(it.submenu, this.level + 1, this.onCommand);
    openPopups.push(p);
    p.showAt(0, 0, this.rows[i].getBoundingClientRect());
    if (selectFirst) p.moveSel(1);
    return p;
  }
  activate(i) {
    const it = this.items[i];
    if (!it || it === '-' || !it._enabled) return;
    if (it.submenu) { this.openSub(i, true); return; }
    if (it.keepOpen) { it.action(); return; }
    closeAllPopups();
    if (it.action) it.action();
    else if (it.cmd && this.onCommand) this.onCommand(it.cmd);
  }
  moveSel(dir) {
    const n = this.items.length;
    let i = this.sel;
    for (let k = 0; k < n; k++) {
      i = (i + dir + n) % n;
      if (this.items[i] !== '-' && this.items[i]._enabled !== false) { this.select(i, false); return; }
    }
  }
}

export function showPopupMenu(items, x, y, onCommand) {
  closeAllPopups();
  const p = new Popup(items, 0, onCommand);
  openPopups.push(p);
  p.showAt(x, y);
  setTimeout(() => document.addEventListener('mousedown', outsideHandler, true), 0);
  return p;
}

// keyboard handling for open menus; returns true if consumed
export function menuKeyDown(e) {
  if (!openPopups.length && !(activeBar && activeBar.focusMode)) return false;
  const top = openPopups[openPopups.length - 1];
  switch (e.key) {
    case 'Escape':
      if (openPopups.length > 1) closeFrom(openPopups.length - 1);
      else closeAllPopups();
      return true;
    case 'ArrowDown':
      if (top) top.moveSel(1); else if (activeBar) activeBar.open(activeBar.index, true);
      return true;
    case 'ArrowUp':
      if (top) top.moveSel(-1);
      return true;
    case 'ArrowRight':
      if (top && top.items[top.sel] && top.items[top.sel].submenu) top.openSub(top.sel, true);
      else if (activeBar) activeBar.open((activeBar.index + 1) % activeBar.menus.length, true);
      return true;
    case 'ArrowLeft':
      if (openPopups.length > 1) closeFrom(openPopups.length - 1);
      else if (activeBar) activeBar.open((activeBar.index - 1 + activeBar.menus.length) % activeBar.menus.length, true);
      return true;
    case 'Enter':
    case ' ':
      if (top && top.sel >= 0) top.activate(top.sel);
      else if (activeBar && activeBar.focusMode) activeBar.open(activeBar.index, true);
      return true;
    default:
      if (top && e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
        const k = e.key.toLowerCase();
        const idx = top.items.findIndex((it) => it !== '-' && it._enabled && mnemonic(resolve(it.label)) === k);
        if (idx >= 0) { top.select(idx, false); top.activate(idx); return true; }
      } else if (!top && activeBar && activeBar.focusMode && e.key.length === 1) {
        if (activeBar.openByMnemonic(e.key.toLowerCase())) return true;
      }
      return !!top || !!(activeBar && activeBar.focusMode);
  }
}

// ------------------------------------------------------------------ menu bar
export class MenuBar {
  constructor(el, menus, onCommand, onClose) {
    this.el = el;
    this.menus = menus;
    this.onCommand = onCommand;
    this.onClose = onClose;
    this.index = -1;
    this.focusMode = false;
    this.buttons = menus.map((m, i) => {
      const b = h('div', { class: 'menubar-item', role: 'menuitem' }, labelNode(m.label));
      b.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (this.index === i && openPopups.length) closeAllPopups();
        else this.open(i, false);
      });
      b.addEventListener('mouseenter', () => {
        if (openPopups.length && this.index !== i && activeBar === this) this.open(i, false);
      });
      el.append(b);
      return b;
    });
  }
  open(i, selectFirst) {
    const wasFocus = this.focusMode;
    closeAllPopups();
    activeBar = this;
    this.focusMode = wasFocus;
    this.index = i;
    this.buttons.forEach((b, k) => b.classList.toggle('open', k === i));
    const r = this.buttons[i].getBoundingClientRect();
    const p = new Popup(this.menus[i].items, 0, this.onCommand);
    openPopups.push(p);
    p.showAt(r.left, r.bottom);
    if (selectFirst) p.moveSel(1);
    setTimeout(() => document.addEventListener('mousedown', outsideHandler, true), 0);
  }
  openByMnemonic(ch) {
    const i = this.menus.findIndex((m) => mnemonic(m.label) === ch);
    if (i < 0) return false;
    this.open(i, true);
    return true;
  }
  enterFocusMode() {
    activeBar = this;
    this.focusMode = true;
    this.index = 0;
    this.buttons.forEach((b, k) => b.classList.toggle('focus', k === 0));
  }
  deactivate() {
    this.buttons.forEach((b) => b.classList.remove('open', 'focus'));
    const was = this.focusMode || this.index >= 0;
    this.index = -1;
    this.focusMode = false;
    activeBar = null;
    if (was && this.onClose) this.onClose();
  }
}

// ------------------------------------------------------------------ dialogs
let zTop = 2000;
export class Dialog {
  constructor({ title, body, buttons = [], modal = false, className = '', onClose, width }) {
    this.modal = modal;
    this.onClose = onClose;
    this.el = h('div', { class: 'dlg ' + className, role: 'dialog', 'aria-label': title });
    if (width) this.el.style.width = width + 'px';
    this.titleEl = h('div', { class: 'dlg-title' }, h('span', {}, title), h('button', { class: 'dlg-x', title: 'Close', onclick: () => this.close() }, '✕'));
    this.body = h('div', { class: 'dlg-body' });
    if (body) this.body.append(body);
    this.el.append(this.titleEl, this.body);
    if (buttons.length) {
      this.footer = h('div', { class: 'dlg-buttons' });
      for (const b of buttons) {
        const btn = h('button', { class: 'btn' + (b.default ? ' default' : '') }, b.label);
        btn.addEventListener('click', () => b.action(this));
        if (b.default) this.defaultBtn = btn;
        if (b.cancel) this.cancelBtn = btn;
        this.footer.append(btn);
      }
      this.el.append(this.footer);
    }
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); (this.cancelBtn || { click: () => this.close() }).click(); }
      else if (e.key === 'Enter' && this.defaultBtn && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') {
        e.preventDefault(); e.stopPropagation(); this.defaultBtn.click();
      }
    });
    this.el.addEventListener('mousedown', () => this.raise());
    this._drag();
  }
  _drag() {
    let sx, sy, ox, oy;
    const move = (e) => {
      this.el.style.left = Math.max(0, Math.min(window.innerWidth - 60, ox + e.clientX - sx)) + 'px';
      this.el.style.top = Math.max(0, Math.min(window.innerHeight - 30, oy + e.clientY - sy)) + 'px';
    };
    const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); };
    this.titleEl.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.dlg-x') || document.body.classList.contains('narrow')) return;
      e.preventDefault();
      const r = this.el.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    });
  }
  raise() { this.el.style.zIndex = ++zTop; if (this.backdrop) this.backdrop.style.zIndex = zTop - 1; }
  show(pos) {
    if (this.modal) {
      this.backdrop = h('div', { class: 'dlg-backdrop' });
      document.body.append(this.backdrop);
    }
    document.body.append(this.el);
    this.raise();
    this.open = true;
    const r = this.el.getBoundingClientRect();
    const x = pos && pos.x !== undefined ? pos.x : (window.innerWidth - r.width) / 2;
    const y = pos && pos.y !== undefined ? pos.y : Math.max(40, (window.innerHeight - r.height) / 3);
    this.el.style.left = Math.max(0, Math.min(x, window.innerWidth - r.width - 4)) + 'px';
    this.el.style.top = Math.max(0, Math.min(y, window.innerHeight - r.height - 4)) + 'px';
    const f = this.el.querySelector('[autofocus]') || this.el.querySelector('input,select,textarea') || this.defaultBtn;
    if (f) setTimeout(() => { f.focus(); if (f.select) f.select(); }, 0);
    return this;
  }
  close() {
    if (!this.open) return;
    this.open = false;
    this.el.remove();
    if (this.backdrop) this.backdrop.remove();
    if (this.onClose) this.onClose();
  }
}

export function messageBox(title, text, buttons = ['OK'], icon = '') {
  return new Promise((resolveP) => {
    let result = null;
    const body = h('div', { class: 'msgbox' },
      icon ? h('div', { class: 'msgbox-icon ' + icon }) : null,
      h('div', { class: 'msgbox-text' }, ...String(text).split('\n').flatMap((l, i) => (i ? [h('br'), l] : [l]))));
    const d = new Dialog({
      title, body, modal: true, className: 'msgbox-dlg',
      buttons: buttons.map((b, i) => ({
        label: b, default: i === 0, cancel: b === 'Cancel' || (buttons.length === 1),
        action: (dlg) => { result = b; dlg.close(); },
      })),
      onClose: () => resolveP(result || (buttons.includes('Cancel') ? 'Cancel' : buttons[buttons.length - 1])),
    });
    d.show();
  });
}

export function promptBox(title, label, value = '', opts = {}) {
  return new Promise((resolveP) => {
    let result = null;
    const input = h('input', { type: opts.type || 'text', class: 'txt', value, autofocus: true });
    if (opts.min !== undefined) input.min = opts.min;
    if (opts.max !== undefined) input.max = opts.max;
    const body = h('div', { class: 'prompt' }, h('label', {}, label), input, opts.note ? h('div', { class: 'note' }, opts.note) : null);
    const d = new Dialog({
      title, body, modal: true, width: opts.width || 360,
      buttons: [
        { label: opts.okLabel || 'OK', default: true, action: (dlg) => { result = input.value; dlg.close(); } },
        { label: 'Cancel', cancel: true, action: (dlg) => dlg.close() },
      ],
      onClose: () => resolveP(result),
    });
    d.show();
  });
}

let toastTimer = null;
export function toast(text, ms = 2500) {
  let el = document.getElementById('toast');
  if (!el) { el = h('div', { id: 'toast' }); document.body.append(el); }
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

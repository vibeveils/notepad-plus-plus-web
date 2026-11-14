// mobile.js - phone and tablet support: device classes, on-screen keyboard
// handling, an accessory key bar and a selection action bar.

import { SC } from './sci-consts.js';
import { h, showPopupMenu, closeAllPopups } from './ui.js';

const coarseQuery = window.matchMedia('(pointer: coarse)');
const NARROW = 760;

export function isTouchDevice() {
  return coarseQuery.matches || (navigator.maxTouchPoints > 0 && !window.matchMedia('(pointer: fine)').matches);
}

// Calls fn(event) after a long press (touch or pen); returns nothing.
export function onLongPress(el, fn, ms = 500) {
  let timer = 0, sx = 0, sy = 0;
  const cancel = () => { clearTimeout(timer); timer = 0; };
  el.addEventListener('pointerdown', (e) => {
    delete el.dataset.longpressed;
    if (e.pointerType === 'mouse') return;
    sx = e.clientX; sy = e.clientY;
    cancel();
    timer = setTimeout(() => {
      timer = 0;
      el.dataset.longpressed = '1';
      if (navigator.vibrate) { try { navigator.vibrate(12); } catch (_) { /* ignore */ } }
      fn(e);
    }, ms);
  });
  el.addEventListener('pointermove', (e) => { if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) cancel(); });
  el.addEventListener('pointerup', cancel);
  // stop the emulated mouse events after a long press from closing the menu it opened
  el.addEventListener('touchend', (e) => { if (el.dataset.longpressed) e.preventDefault(); }, { passive: false });
  el.addEventListener('mousedown', (e) => { if (el.dataset.longpressed) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('contextmenu', (e) => { if (e.pointerType !== 'mouse' && el.dataset.longpressed) e.preventDefault(); });
  // swallow the click that follows a long press
  el.addEventListener('click', (e) => {
    if (el.dataset.longpressed) { delete el.dataset.longpressed; e.stopPropagation(); e.preventDefault(); }
  }, true);
}

export class MobileSupport {
  constructor(app) {
    this.app = app;
    this.shift = false;
    this.keyboardOpen = false;
    this.keybar = document.getElementById('keybar');
    this.touchbar = document.getElementById('touchbar');
    this.updateClasses();
    window.addEventListener('resize', () => this.updateClasses());
    coarseQuery.addEventListener('change', () => this.updateClasses());
    this.setupViewport();
    this.buildKeybar();
    this.buildTouchbar();
    this.bindView();
  }

  get touch() { return document.body.classList.contains('touch'); }
  get narrow() { return document.body.classList.contains('narrow'); }

  updateClasses() {
    const b = document.body.classList;
    const wasNarrow = b.contains('narrow');
    b.toggle('touch', isTouchDevice());
    b.toggle('narrow', window.innerWidth < NARROW);
    b.toggle('phone', Math.min(window.innerWidth, window.innerHeight) < 500);
    if (wasNarrow !== b.contains('narrow')) {
      closeAllPopups();
      this.app.layoutChanged();
    }
  }

  // Keep the app inside the visual viewport so the on-screen keyboard never
  // covers the editor (iOS overlays the keyboard instead of resizing).
  setupViewport() {
    const vv = window.visualViewport;
    if (!vv) return;
    const appEl = document.getElementById('app');
    const root = document.documentElement;
    let raf = 0;
    const fit = () => {
      raf = 0;
      const height = Math.round(vv.height);
      const top = Math.round(vv.offsetTop);
      const keyboard = Math.max(0, window.innerHeight - height - top);
      root.style.setProperty('--vvh', height + 'px');
      root.style.setProperty('--kb-inset', keyboard + 'px');
      // Only follow the visual viewport when it is not a pinch-zoom of the page
      if (vv.scale <= 1.01) {
        appEl.style.height = height + 'px';
        appEl.style.transform = top ? `translateY(${top}px)` : '';
      }
      const open = keyboard > 120 || (this.touch && height < window.screen.height * 0.6 && document.activeElement === this.app.view.input);
      if (open !== this.keyboardOpen) {
        this.keyboardOpen = open;
        document.body.classList.toggle('kb-open', open);
      }
      this.app.layoutChanged();
      if (this.app.view.hasFocus()) {
        this.app.send(SC.SCI_SCROLLCARET);
      }
      this.hideTouchbar();
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(fit); };
    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
    // iOS scrolls the window when an input is focused: undo it
    window.addEventListener('scroll', () => { if (window.scrollY || window.scrollX) window.scrollTo(0, 0); schedule(); });
    fit();
  }

  // ---------------------------------------------------------------- key bar
  buildKeybar() {
    const app = this.app;
    const v = () => app.view;
    const K = (code) => () => { v().key(code, this.shift ? 1 : 0); };
    const ins = (s) => () => v().insertText(s);
    const keys = [
      { label: 'Tab', title: 'Tab (Shift: unindent)', act: () => v().key(9, this.shift ? 1 : 0) },
      { label: 'Sel', title: 'Extend selection with the arrow keys', toggle: true, cls: 'kb-shift' },
      { label: '←', title: 'Left', act: K(302), repeat: true },
      { label: '↑', title: 'Up', act: K(301), repeat: true },
      { label: '↓', title: 'Down', act: K(300), repeat: true },
      { label: '→', title: 'Right', act: K(303), repeat: true },
      { label: 'Home', act: K(304) },
      { label: 'End', act: K(305) },
      { label: '↶', title: 'Undo', act: () => app.run('edit.undo') },
      { label: '↷', title: 'Redo', act: () => app.run('edit.redo') },
      { label: '⌕', title: 'Find', act: () => app.run('search.find') },
      ...['{', '}', '(', ')', '[', ']', '<', '>', ';', ':', '=', '"', "'", '`', '/', '\\', '|', '&', '*', '+', '-', '_', '#', '$', '%', '!', '?', '@', '^', '~']
        .map((c) => ({ label: c, act: ins(c), sym: true })),
      { label: 'Esc', act: () => v().key(7) },
      { label: '⌄', title: 'Hide keyboard', act: () => { v().input.blur(); }, cls: 'kb-hide' },
    ];
    const row = h('div', { class: 'keybar-row' });
    for (const k of keys) {
      const b = h('button', { class: 'kb-key' + (k.sym ? ' sym' : '') + (k.cls ? ' ' + k.cls : ''), title: k.title || k.label, 'aria-label': k.title || k.label }, k.label);
      let repeatTimer = 0, repeatDelay = 0;
      const stop = () => { clearTimeout(repeatDelay); clearInterval(repeatTimer); repeatDelay = repeatTimer = 0; };
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault(); // keep focus (and the keyboard) in the editor
        if (k.toggle) { this.shift = !this.shift; b.classList.toggle('on', this.shift); return; }
        k.act();
        if (k.repeat) {
          repeatDelay = setTimeout(() => { repeatTimer = setInterval(k.act, 60); }, 400);
        }
      });
      b.addEventListener('pointerup', stop);
      b.addEventListener('pointerleave', stop);
      b.addEventListener('pointercancel', stop);
      b.addEventListener('click', (e) => e.preventDefault());
      row.append(b);
    }
    this.keybar.append(row);
  }

  // ---------------------------------------------------------------- selection action bar
  buildTouchbar() {
    const app = this.app;
    const view = () => app.view;
    const hasSel = () => !app.send(SC.SCI_GETSELECTIONEMPTY);
    const items = [
      { label: 'Cut', show: () => hasSel() && !app.current.readOnly, act: () => { app.send(SC.SCI_CUT); } },
      { label: 'Copy', show: hasSel, act: () => { app.send(SC.SCI_COPY); } },
      { label: 'Paste', show: () => !app.current.readOnly, act: () => view().pasteFromClipboard() },
      { label: 'Select All', show: () => true, act: () => { app.send(SC.SCI_SELECTALL); this.showTouchbarAtSelection(); return true; } },
      { label: 'Line', title: 'Select line', show: () => true, act: () => { const l = app.send(SC.SCI_LINEFROMPOSITION, app.send(SC.SCI_GETCURRENTPOS)); app.send(SC.SCI_SETSEL, app.send(SC.SCI_POSITIONFROMLINE, l), app.send(SC.SCI_POSITIONFROMLINE, l + 1) || app.send(SC.SCI_GETLENGTH)); this.showTouchbarAtSelection(); return true; } },
      { label: '⋯', title: 'More', show: () => true, act: () => {
        const r = this.touchbar.getBoundingClientRect();
        showPopupMenu(app.editorContextMenu(), r.left, r.bottom + 4, (cmd) => app.run(cmd));
      } },
    ];
    this.touchItems = items.map((it) => {
      const b = h('button', { class: 'tbar-btn', title: it.title || it.label }, it.label);
      b.addEventListener('pointerdown', (e) => e.preventDefault());
      b.addEventListener('click', (e) => {
        e.preventDefault();
        const keep = it.act();
        if (!keep) this.hideTouchbar();
        app.updateToolbar();
      });
      this.touchbar.append(b);
      return { it, b };
    });
  }
  showTouchbar(x, y) {
    for (const { it, b } of this.touchItems) b.hidden = !it.show();
    const tb = this.touchbar;
    tb.hidden = false;
    const r = tb.getBoundingClientRect();
    const vw = window.innerWidth;
    let left = Math.max(6, Math.min(vw - r.width - 6, x - r.width / 2));
    let top = y - r.height - 18;
    const editorTop = document.getElementById('editor-area').getBoundingClientRect().top;
    if (top < editorTop + 4) top = y + 28;
    tb.style.left = left + 'px';
    tb.style.top = top + 'px';
  }
  showTouchbarAtSelection() {
    const v = this.app.view;
    const s = v.send(SC.SCI_GETSELECTIONSTART);
    const rect = v.scroller.getBoundingClientRect();
    const x = v.send(SC.SCI_POINTXFROMPOSITION, 0, s) + rect.left;
    const y = v.send(SC.SCI_POINTYFROMPOSITION, 0, s) + rect.top;
    this.showTouchbar(Math.max(rect.left + 40, Math.min(rect.right - 40, x)), Math.max(rect.top + 10, y));
  }
  hideTouchbar() {
    if (this.touchbar && !this.touchbar.hidden) this.touchbar.hidden = true;
  }

  bindView() {
    const v = this.app.view;
    v.on('touchmenu', (p) => this.showTouchbar(p.x, p.y));
    v.on('touchselect', () => this.hideTouchbar());
    v.on('tap', () => this.hideTouchbar());
    v.on('inputfocus', () => document.body.classList.add('editor-focus'));
    v.on('inputblur', () => {
      setTimeout(() => { if (!v.hasFocus()) document.body.classList.remove('editor-focus'); }, 150);
    });
    v.scroller.addEventListener('scroll', () => this.hideTouchbar(), { passive: true });
    v.input.addEventListener('keydown', () => this.hideTouchbar());
    // Turn the sticky Shift off after it has been used for a selection that is now gone
    v.on('notify', (n) => {
      if (n.code === SC.SCN_UPDATEUI && (n.updated & SC.SC_UPDATE_SELECTION) && v.send(SC.SCI_GETSELECTIONEMPTY)) {
        if (!this.touchbar.hidden && !v.touchSelecting) this.hideTouchbar();
      }
    });
  }

  // Top-level menus as one popup, for the hamburger button on narrow screens.
  showMainMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    const items = this.app.menus.map((m) => ({ label: m.label, submenu: m.items }));
    showPopupMenu(items, r.left, r.bottom + 2, (cmd) => this.app.run(cmd));
  }
}

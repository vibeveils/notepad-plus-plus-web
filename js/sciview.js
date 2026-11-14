// sciview.js - a Scintilla editor widget hosted on an HTML canvas.
// Wraps one ScintillaWeb instance from the wasm module and connects it to DOM
// input: mouse, keyboard, IME composition, clipboard, scrolling and resizing.

import { SC } from './sci-consts.js';

const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

// Scintilla key codes (ScintillaTypes.h: enum class Keys)
const KEYS = {
  ArrowDown: 300, ArrowUp: 301, ArrowLeft: 302, ArrowRight: 303, Home: 304, End: 305,
  PageUp: 306, PageDown: 307, Delete: 308, Insert: 309, Escape: 7, Backspace: 8,
  Tab: 9, Enter: 13, ContextMenu: 315,
};
const CODE_CHARS = {
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';',
  Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`', Space: ' ', IntlBackslash: '\\',
};
const NUMPAD = { NumpadAdd: 310, NumpadSubtract: 311, NumpadDivide: 312 };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8');

export class ScintillaView {
  constructor(M, host) {
    this.M = M;
    this.P = M.SciPlat;
    this.host = host;
    this.listeners = new Map();
    this.width = 0;
    this.height = 0;
    this.pxPerLine = 16;
    this.dirty = null;
    this.rafPending = false;
    this.captured = false;
    this.composing = false;
    this.lastCopy = null;

    host.classList.add('sci-host');
    this.scroller = document.createElement('div');
    this.scroller.className = 'sci-scroller';
    this.spacer = document.createElement('div');
    this.spacer.className = 'sci-spacer';
    this.scroller.appendChild(this.spacer);
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'sci-canvas';
    this.input = document.createElement('textarea');
    this.input.className = 'sci-input';
    this.input.setAttribute('autocomplete', 'off');
    this.input.setAttribute('autocorrect', 'off');
    this.input.setAttribute('autocapitalize', 'off');
    this.input.setAttribute('spellcheck', 'false');
    this.input.setAttribute('aria-label', 'Editor');
    this.input.setAttribute('tabindex', '0');
    host.append(this.scroller, this.canvas, this.input);

    this.wid = this.P.registerWindow({ kind: 'main', canvas: this.canvas, view: this });
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.sci = M._sci_create(this.wid);
    this.P.views.set(this.sci, this);

    this.send(SC.SCI_SETCODEPAGE, SC.SC_CP_UTF8);
    this.send(SC.SCI_SETBUFFEREDDRAW, 0);
    this.send(SC.SCI_USEPOPUP, SC.SC_POPUP_NEVER);
    this.send(SC.SCI_SETMOUSEDWELLTIME, 500);

    this._bindEvents();
    this._layout();
  }

  // ------------------------------------------------------------------ messages
  send(msg, wParam = 0, lParam = 0) {
    return this.M._sci_send(this.sci, msg, wParam, lParam);
  }
  _withStr(str, fn) {
    const bytes = textEncoder.encode(str);
    const p = this.M._malloc(bytes.length + 1);
    this.M.HEAPU8.set(bytes, p);
    this.M.HEAPU8[p + bytes.length] = 0;
    try { return fn(p, bytes.length); } finally { this.M._free(p); }
  }
  sendStr(msg, wParam, str) {
    return this._withStr(str, (p) => this.send(msg, wParam, p));
  }
  sendStrStr(msg, a, b) {
    return this._withStr(a, (pa) => this._withStr(b, (pb) => this.send(msg, pa, pb)));
  }
  sendGetStr(msg, wParam = 0) {
    const len = this.send(msg, wParam, 0);
    if (len <= 0) return '';
    const p = this.M._malloc(len + 1);
    try {
      this.M.HEAPU8.fill(0, p, p + len + 1);
      this.send(msg, wParam, p);
      let n = 0;
      while (n < len && this.M.HEAPU8[p + n] !== 0) n++;
      return textDecoder.decode(this.M.HEAPU8.subarray(p, p + n));
    } finally { this.M._free(p); }
  }
  setBytes(bytes) {
    const p = this.M._malloc(bytes.length + 1);
    this.M.HEAPU8.set(bytes, p);
    this.M.HEAPU8[p + bytes.length] = 0;
    try {
      this.send(SC.SCI_CLEARALL);
      this.send(SC.SCI_APPENDTEXT, bytes.length, p);
    } finally { this.M._free(p); }
  }
  setText(str) { this.setBytes(textEncoder.encode(str)); }
  getBytes(start = 0, end = -1) {
    const len = this.send(SC.SCI_GETLENGTH);
    if (end < 0 || end > len) end = len;
    if (end <= start) return new Uint8Array(0);
    const p = this.send(SC.SCI_GETRANGEPOINTER, start, end - start) >>> 0;
    return this.M.HEAPU8.slice(p, p + (end - start));
  }
  getText() { return textDecoder.decode(this.getBytes()); }
  getRange(start, end) { return textDecoder.decode(this.getBytes(start, end)); }
  getSelText() {
    const s = this.send(SC.SCI_GETSELECTIONSTART), e = this.send(SC.SCI_GETSELECTIONEND);
    return this.getRange(s, e);
  }
  replaceSel(str) { this.sendStr(SC.SCI_REPLACESEL, 0, str); }
  insertText(str) {
    this._withStr(str, (p, len) => this.M._sci_insert_text(this.sci, p, len));
  }
  pasteText(text, rectangular = false, line = false) {
    this._withStr(text, (p, len) => this.M._sci_paste_text(this.sci, p, len, rectangular ? 1 : 0, line ? 1 : 0));
  }
  setLexer(name) {
    return this._withStr(name || '', (p) => this.M._sci_set_lexer(this.sci, p));
  }
  focus() { this.input.focus({ preventScroll: true }); }
  hasFocus() { return document.activeElement === this.input; }

  // ------------------------------------------------------------------ events out
  on(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(fn);
  }
  emit(name, arg) {
    const l = this.listeners.get(name);
    if (l) for (const fn of l) fn(arg);
  }

  // ------------------------------------------------------------------ painting
  invalidate(l, t, r, b) {
    if (l === undefined || l < 0) {
      this.dirty = { l: 0, t: 0, r: this.width, b: this.height, all: true };
    } else if (!this.dirty) {
      this.dirty = { l, t, r, b };
    } else if (!this.dirty.all) {
      this.dirty.l = Math.min(this.dirty.l, l);
      this.dirty.t = Math.min(this.dirty.t, t);
      this.dirty.r = Math.max(this.dirty.r, r);
      this.dirty.b = Math.max(this.dirty.b, b);
    }
    if (!this.rafPending) {
      this.rafPending = true;
      requestAnimationFrame(() => this._paint());
    }
  }
  _paint() {
    this.rafPending = false;
    const d = this.dirty;
    this.dirty = null;
    if (!d || !this.sci || this.width <= 0 || this.height <= 0) return;
    const dpr = this.P.dpr();
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const l = Math.max(0, Math.floor(d.l)), t = Math.max(0, Math.floor(d.t));
    const r = Math.min(this.width, Math.ceil(d.r)), b = Math.min(this.height, Math.ceil(d.b));
    if (r <= l || b <= t) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(l, t, r - l, b - t);
    ctx.clip();
    this.M._sci_paint(this.sci, l, t, r, b);
    ctx.restore();
  }

  // ------------------------------------------------------------------ layout & scrolling
  _layout() {
    const w = this.scroller.clientWidth, h = this.scroller.clientHeight;
    const dpr = this.P.dpr();
    const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    if (w === this.width && h === this.height && this.canvas.width === bw && this.canvas.height === bh) return;
    this.width = w;
    this.height = h;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.canvas.width = Math.max(1, bw);
    this.canvas.height = Math.max(1, bh);
    this.M._sci_resize(this.sci);
    this.invalidate();
  }
  _scrollbars(vMax, vPage, vPos, hMax, hPage, hPos, lh, vVis, hVis) {
    const maxTop = Math.max(0, vMax - vPage + 1);
    this.lineHeight = lh;
    this.pxPerLine = maxTop * lh > 8e6 ? 8e6 / maxTop : lh;
    this.spacer.style.height = Math.round(this.height + maxTop * this.pxPerLine) + 'px';
    this.spacer.style.width = Math.round(this.width + Math.max(0, hMax)) + 'px';
    this.scroller.style.overflowY = vVis ? 'auto' : 'hidden';
    this.scroller.style.overflowX = hVis ? 'auto' : 'hidden';
    this._scrollPos(vPos, hPos);
  }
  _scrollPos(vPos, hPos) {
    const sc = this.scroller;
    if (Math.round(sc.scrollTop / this.pxPerLine) !== vPos) sc.scrollTop = vPos * this.pxPerLine;
    if (Math.round(sc.scrollLeft) !== hPos) sc.scrollLeft = hPos;
  }
  _onScroll() {
    const line = Math.round(this.scroller.scrollTop / this.pxPerLine);
    if (line !== this.send(SC.SCI_GETFIRSTVISIBLELINE)) this.M._sci_vscroll(this.sci, line);
    const x = Math.round(this.scroller.scrollLeft);
    if (x !== this.send(SC.SCI_GETXOFFSET)) this.M._sci_hscroll(this.sci, x);
  }

  // ------------------------------------------------------------------ callbacks from wasm
  _notify(n) {
    this.emit('notify', n);
    if (n.code === SC.SCN_UPDATEUI) this._placeInput();
  }
  _command(code) {
    switch (code) {
      case 1: this.pasteFromClipboard(); break;
      case 2: this.focus(); break;
      case 768: this.emit('change'); break;
      case 512: this.emit('focus'); break;
      case 256: this.emit('blur'); break;
    }
  }
  _copied(text, rect, line) {
    this.lastCopy = { text, rect, line };
    if (this.inClipboardEvent) {
      this.pendingCopy = this.lastCopy;
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
  }
  async pasteFromClipboard() {
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch (e) {
      this.emit('clipboard-denied', e);
      return;
    }
    if (!text) return;
    const lc = this.lastCopy && this.lastCopy.text === text ? this.lastCopy : null;
    this.pasteText(text, lc ? lc.rect : false, lc ? lc.line : false);
  }
  _placeInput() {
    const pos = this.send(SC.SCI_GETCURRENTPOS);
    const x = this.send(SC.SCI_POINTXFROMPOSITION, 0, pos);
    const y = this.send(SC.SCI_POINTYFROMPOSITION, 0, pos);
    const cx = Math.max(0, Math.min(this.width - 2, x));
    const cy = Math.max(0, Math.min(this.height - 2, y));
    this.input.style.transform = `translate(${cx}px, ${cy}px)`;
  }

  // ------------------------------------------------------------------ input
  _mods(e) {
    const ctrl = isMac ? e.metaKey : e.ctrlKey;
    const meta = isMac ? e.ctrlKey : false;
    return (e.shiftKey ? 1 : 0) | (ctrl ? 2 : 0) | (e.altKey ? 4 : 0) | (meta ? 16 : 0);
  }
  _point(e) {
    const r = this.scroller.getBoundingClientRect();
    return [e.clientX - r.left - this.scroller.clientLeft, e.clientY - r.top - this.scroller.clientTop];
  }
  _bindEvents() {
    const sc = this.scroller, inp = this.input, M = this.M;
    const now = () => Math.floor(performance.now()) >>> 0;

    this.resizeObserver = new ResizeObserver(() => this._layout());
    this.resizeObserver.observe(sc);
    this._onWinResize = () => this._layout();
    window.addEventListener('resize', this._onWinResize);

    sc.addEventListener('scroll', () => this._onScroll(), { passive: true });
    sc.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        this.send(e.deltaY < 0 ? SC.SCI_ZOOMIN : SC.SCI_ZOOMOUT);
        this.emit('zoom');
      }
    }, { passive: false });

    // ---------------------------------------------------------------- touch
    // tap: place caret (double-tap selects a word through Scintilla's own
    // double-click logic); long-press: select word, drag to extend;
    // two fingers: pinch to zoom. One-finger drags scroll natively.
    let touch = null;
    this.touchSelecting = false;
    const clearLong = () => { if (touch && touch.timer) { clearTimeout(touch.timer); touch.timer = 0; } };
    sc.addEventListener('pointerdown', (e) => {
      this.lastPointerType = e.pointerType;
      const [x, y] = this._point(e);
      if (x >= sc.clientWidth || y >= sc.clientHeight) return; // on a native scrollbar
      if (e.pointerType === 'touch') {
        if (touch) { touch.cancelled = true; clearLong(); return; } // second finger
        touch = { id: e.pointerId, x, y, cx: e.clientX, cy: e.clientY, cancelled: false, timer: 0 };
        touch.timer = setTimeout(() => this._longPress(touch), 450);
        return;
      }
      if (e.button === 0) {
        e.preventDefault();
        this.focus();
        try { sc.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        M._sci_mouse(this.sci, 0, x, y, now(), this._mods(e));
      } else if (e.button === 2) {
        this.focus();
        M._sci_mouse(this.sci, 3, x, y, now(), this._mods(e));
      } else if (e.button === 1) {
        e.preventDefault();
      }
    });
    sc.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') {
        if (!touch || e.pointerId !== touch.id) return;
        const [x, y] = this._point(e);
        if (this.touchSelecting) { this._extendTouchSelection(x, y); return; }
        if (Math.abs(x - touch.x) > 8 || Math.abs(y - touch.y) > 8) { touch.cancelled = true; clearLong(); }
        return;
      }
      const [x, y] = this._point(e);
      M._sci_mouse(this.sci, 1, x, y, now(), this._mods(e));
    });
    sc.addEventListener('pointerup', (e) => {
      const [x, y] = this._point(e);
      if (e.pointerType === 'touch') {
        if (!touch || e.pointerId !== touch.id) return;
        clearLong();
        if (this.touchSelecting) {
          this.touchSelecting = false;
          this._stopAutoScroll();
          this.emit('touchmenu', { x: e.clientX, y: e.clientY });
        } else if (!touch.cancelled) {
          this.focus();
          const pos = this.positionFromPoint(x, y);
          const s = this.send(SC.SCI_GETSELECTIONSTART), en = this.send(SC.SCI_GETSELECTIONEND);
          if (s !== en && pos >= s && pos <= en) {
            this.emit('touchmenu', { x: e.clientX, y: e.clientY }); // tap inside the selection
          } else {
            M._sci_mouse(this.sci, 0, x, y, now(), 0);
            M._sci_mouse(this.sci, 2, x, y, now(), 0);
            this.emit('tap', { x: e.clientX, y: e.clientY });
          }
        }
        touch = null;
        return;
      }
      if (e.button === 0) {
        M._sci_mouse(this.sci, 2, x, y, now(), this._mods(e));
        try { sc.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      }
    });
    // Compatibility mouse events that follow a tap would move focus away from the hidden input
    sc.addEventListener('mousedown', (e) => e.preventDefault());
    sc.addEventListener('pointercancel', (e) => {
      if (touch && e.pointerId === touch.id) {
        clearLong();
        if (this.touchSelecting) { this.touchSelecting = false; this._stopAutoScroll(); }
        touch = null;
      }
    });
    sc.addEventListener('pointerleave', (e) => {
      if (e.pointerType !== 'touch' && !this.captured) M._sci_mouse(this.sci, 4, 0, 0, now(), 0);
    });
    // Touch events: stop native panning while selecting, and implement pinch zoom.
    let pinch = null;
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    sc.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        pinch = { d0: dist(e.touches), zoom0: this.send(SC.SCI_GETZOOM) };
        if (touch) { touch.cancelled = true; clearLong(); }
      }
    }, { passive: true });
    sc.addEventListener('touchmove', (e) => {
      if (this.touchSelecting) { e.preventDefault(); return; }
      if (pinch && e.touches.length === 2) {
        e.preventDefault();
        const ratio = dist(e.touches) / pinch.d0;
        const z = Math.max(-10, Math.min(20, pinch.zoom0 + Math.round(Math.log2(ratio) * 8)));
        if (z !== this.send(SC.SCI_GETZOOM)) { this.send(SC.SCI_SETZOOM, z); this.emit('zoom'); }
      }
    }, { passive: false });
    sc.addEventListener('touchend', (e) => { if (e.touches.length < 2) pinch = null; }, { passive: true });
    sc.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (this.lastPointerType === 'touch') return; // long-press is handled above
      this.emit('contextmenu', e);
    });

    inp.addEventListener('focus', () => { M._sci_focus(this.sci, 1); this._resetInput(); this.emit('inputfocus'); });
    inp.addEventListener('blur', () => { M._sci_focus(this.sci, 0); this.emit('inputblur'); });

    // ---------------------------------------------------------------- text input
    // The hidden textarea holds a one-space sentinel before the caret so that
    // soft keyboards (which report keys as code 229) still send deletions.
    inp.addEventListener('keydown', (e) => this._keydown(e));
    inp.addEventListener('beforeinput', (e) => {
      if (this.composing || e.isComposing) return;
      const t = e.inputType;
      if (t === 'insertFromPaste' || t === 'insertFromDrop' || t === 'insertCompositionText') return;
      e.preventDefault();
      switch (t) {
        case 'insertText':
        case 'insertReplacementText': {
          let data = e.data;
          if (data == null && e.dataTransfer) data = e.dataTransfer.getData('text/plain');
          if (data) this.insertText(data.replace(/\r\n?/g, '\n'));
          break;
        }
        case 'insertLineBreak':
        case 'insertParagraph':
          this.key(13);
          break;
        case 'deleteContentBackward': this.key(8); break;
        case 'deleteContentForward': this.key(308); break;
        case 'deleteWordBackward': this.key(8, 2); break;
        case 'deleteWordForward': this.key(308, 2); break;
        case 'deleteSoftLineBackward':
        case 'deleteHardLineBackward': this.send(SC.SCI_DELLINELEFT); break;
        case 'deleteSoftLineForward':
        case 'deleteHardLineForward': this.send(SC.SCI_DELLINERIGHT); break;
        case 'historyUndo': this.send(SC.SCI_UNDO); break;
        case 'historyRedo': this.send(SC.SCI_REDO); break;
        default: break;
      }
      this._resetInput();
    });
    inp.addEventListener('input', (e) => {
      // Fallback for browsers that changed the textarea without a cancellable beforeinput
      if (this.composing || e.isComposing) return;
      const v = inp.value;
      if (v === ' ') return;
      if (v === '') this.key(8);
      else this.insertText((v.startsWith(' ') ? v.slice(1) : v).replace(/\r\n?/g, '\n'));
      this._resetInput();
    });
    inp.addEventListener('compositionstart', () => { this.composing = true; });
    inp.addEventListener('compositionupdate', (e) => {
      this._withStr(e.data || '', (p, len) => M._sci_ime_composition(this.sci, p, len));
    });
    inp.addEventListener('compositionend', (e) => {
      this.composing = false;
      M._sci_ime_end(this.sci);
      if (e.data) this.insertText(e.data);
      this._resetInput();
    });

    inp.addEventListener('copy', (e) => this._clipboardEvent(e, SC.SCI_COPY));
    inp.addEventListener('cut', (e) => this._clipboardEvent(e, SC.SCI_CUT));
    inp.addEventListener('paste', (e) => {
      e.preventDefault();
      const dt = e.clipboardData;
      const text = dt.getData('text/plain');
      if (!text) return;
      const types = Array.from(dt.types || []);
      const lc = this.lastCopy && this.lastCopy.text === text ? this.lastCopy : null;
      const rect = types.includes('application/x-scintilla-rect') || (lc ? lc.rect : false);
      this.pasteText(text, rect, lc ? lc.line : false);
      this._resetInput();
    });

    // Dropping text or files is forwarded to the application.
    sc.addEventListener('dragover', (e) => { e.preventDefault(); });
    sc.addEventListener('drop', (e) => {
      e.preventDefault();
      this.emit('drop', e);
    });
  }
  _resetInput() {
    if (this.composing) return;
    const inp = this.input;
    if (inp.value !== ' ') inp.value = ' ';
    try { if (document.activeElement === inp) inp.setSelectionRange(1, 1); } catch (_) { /* ignore */ }
  }
  key(code, mods = 0) {
    return this.M._sci_key(this.sci, code, mods);
  }
  positionFromPoint(x, y) {
    return this.send(SC.SCI_POSITIONFROMPOINT, Math.round(x), Math.round(y));
  }
  selectWordAt(x, y) {
    const pos = this.positionFromPoint(x, y);
    let s = this.send(SC.SCI_WORDSTARTPOSITION, pos, 1), e = this.send(SC.SCI_WORDENDPOSITION, pos, 1);
    if (s === e) { e = this.send(SC.SCI_POSITIONAFTER, pos); }
    this.send(SC.SCI_SETSEL, s, e);
    return [s, e];
  }
  _longPress(t) {
    if (!t || t.cancelled) return;
    t.timer = 0;
    this.touchSelecting = true;
    const [s, e] = this.selectWordAt(t.x, t.y);
    t.anchorStart = s;
    t.anchorEnd = e;
    this._touch = t;
    if (navigator.vibrate) { try { navigator.vibrate(12); } catch (_) { /* ignore */ } }
    this.emit('touchselect');
  }
  _extendTouchSelection(x, y) {
    const t = this._touch;
    if (!t) return;
    t.lastX = x; t.lastY = y;
    const pos = this.positionFromPoint(x, y);
    if (pos < t.anchorStart) this.send(SC.SCI_SETSEL, t.anchorEnd, pos);
    else this.send(SC.SCI_SETSEL, t.anchorStart, Math.max(pos, t.anchorEnd));
    // auto-scroll when dragging near the top or bottom edge
    const edge = 24;
    const dir = y < edge ? -1 : y > this.height - edge ? 1 : 0;
    if (dir && !this._autoScroll) {
      this._autoScroll = setInterval(() => {
        this.send(SC.SCI_LINESCROLL, 0, dir);
        this._extendTouchSelection(t.lastX, Math.max(0, Math.min(this.height - 1, t.lastY)));
      }, 60);
    } else if (!dir) {
      this._stopAutoScroll();
    }
  }
  _stopAutoScroll() {
    if (this._autoScroll) { clearInterval(this._autoScroll); this._autoScroll = 0; }
  }
  _clipboardEvent(e, msg) {
    e.preventDefault();
    this.inClipboardEvent = true;
    this.pendingCopy = null;
    try { this.send(msg); } finally { this.inClipboardEvent = false; }
    const c = this.pendingCopy;
    if (c) {
      e.clipboardData.setData('text/plain', c.text);
      if (c.rect) { try { e.clipboardData.setData('application/x-scintilla-rect', '1'); } catch (_) { /* ignore */ } }
    }
    this._resetInput();
  }
  _keydown(e) {
    if (this.composing || e.isComposing || e.keyCode === 229) return;
    if (this.onKeyDown && this.onKeyDown(e)) { e.preventDefault(); return; }
    const ctrl = isMac ? e.metaKey : e.ctrlKey;
    const lower = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    // Clipboard shortcuts go through native copy/cut/paste events.
    if ((ctrl && !e.altKey && (e.code === 'KeyC' || e.code === 'KeyX' || e.code === 'KeyV' || lower === 'c' || lower === 'x' || lower === 'v')) ||
        (e.key === 'Insert' && (e.ctrlKey || e.shiftKey)) || (e.key === 'Delete' && e.shiftKey && !e.ctrlKey)) {
      this.input.value = ' ';
      this.input.select();
      return;
    }
    let code = KEYS[e.key];
    if (e.code in NUMPAD && (ctrl || e.altKey)) code = NUMPAD[e.code];
    const altGr = !isMac && e.ctrlKey && e.altKey && e.key.length === 1 && !/[a-z0-9]/i.test(e.key);
    if (code === undefined && (ctrl || e.altKey || (isMac && e.ctrlKey)) && !altGr) {
      let ch = null;
      if (e.code.startsWith('Key')) ch = e.code.slice(3);
      else if (e.code.startsWith('Digit')) ch = e.code.slice(5);
      else if (e.code in CODE_CHARS) ch = CODE_CHARS[e.code];
      else if (e.key.length === 1) ch = e.key.toUpperCase();
      if (ch) code = ch.charCodeAt(0);
    }
    if (code === undefined) return; // printable character: arrives through the input event
    const consumed = this.M._sci_key(this.sci, code, this._mods(e));
    if (consumed || code === 9 || code === 13 || code === 8) e.preventDefault();
  }

  destroy() {
    this.resizeObserver.disconnect();
    window.removeEventListener('resize', this._onWinResize);
    this.P.views.delete(this.sci);
    this.M._sci_destroy(this.sci);
    this.P.unregisterWindow(this.wid);
    this.sci = 0;
    this.host.textContent = '';
  }
}

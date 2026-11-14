// app.js - Notepad++ for the web: application shell around the wasm Scintilla.

import { SC } from './sci-consts.js';
import { ScintillaView } from './sciview.js';
import { NppConfig, hexToBgr } from './config.js';
import { h, MenuBar, showPopupMenu, closeAllPopups, menuKeyDown, Dialog, messageBox, promptBox, toast } from './ui.js';
import { FindReplace, SearchResults, SearchEngine } from './find.js';
import { decodeBytes, encodeText, detectEol, ENCODINGS } from './encoding.js';
import * as store from './storage.js';
import { md5 } from './md5.js';
import { BUILD } from './version.js';
import { MobileSupport, onLongPress } from './mobile.js';

const VERSION = `${BUILD.npp} (WebAssembly build)`;
const MARK_BOOKMARK = 20;
const MARK_HIDELINESBEGIN = 19;
const MARK_HIDELINESEND = 18;
const URL_INDIC = 8;
const M_LINENUMBER = 0, M_SYMBOL = 1, M_CHANGEHISTORY = 2, M_FOLDER = 3;
const EOL_MODES = { crlf: SC.SC_EOL_CRLF, lf: SC.SC_EOL_LF, cr: SC.SC_EOL_CR };
const EOL_LABELS = { crlf: 'Windows (CR LF)', lf: 'Unix (LF)', cr: 'Macintosh (CR)' };
const EOL_STR = { crlf: '\r\n', lf: '\n', cr: '\r' };
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || '');
const CTRL = isMac ? 'Cmd' : 'Ctrl';

const DEFAULTS = {
  theme: 'stylers.xml', darkMode: false, wrap: false, showWS: false, showEOL: false, showWrapSymbol: false,
  indentGuide: true, lineNumbers: true, bookmarkMargin: true, changeHistory: true, currentLine: true,
  smartHighlight: true, smartMatchCase: false, smartWholeWord: true, braceHighlight: true, autoIndent: true,
  autoComplete: true, autoCompleteFrom: 1, funcParamsHint: true, wordCompletion: true,
  tabSize: 4, useSpaces: false, defaultEol: 'crlf', defaultEncoding: 'utf-8', defaultLang: 'normal',
  caretWidth: 1, caretBlink: 600, edge: 0, scrollBeyondLast: false, clickableLinks: true,
  fontName: '', fontSize: 0, rememberSession: true, macros: [], multiEdit: true, virtualSpace: false,
};

const textEncoder = new TextEncoder();
const C_LIKE = new Set(['c', 'cpp', 'cs', 'java', 'javascript', 'javascript.js', 'typescript', 'php', 'css', 'json', 'json5', 'go', 'rust', 'swift', 'objc', 'actionscript', 'd', 'perl', 'powershell', 'rc', 'tcl', 'verilog', 'scala', 'kotlin', 'gdscript', 'awk', 'sas', 'coffeescript', 'jsp', 'asp', 'html', 'bash', 'lua', 'r']);
const fmt = (n) => n.toLocaleString('en-US');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

class Buffer {
  constructor(app, opts) {
    this.id = Buffer.next = (Buffer.next || 0) + 1;
    this.name = opts.name;
    this.path = opts.path || '';
    this.handle = opts.handle || null;
    this.untitled = !!opts.untitled;
    this.lang = opts.lang || 'normal';
    this.encoding = opts.encoding || 'utf-8';
    this.eol = opts.eol || 'crlf';
    this.forceDirty = false;
    this.modified = false;
    this.readOnly = false;
    this.state = null;
    this.words = null;
    this.lastModified = opts.lastModified || null;
    this.doc = app.view.send(SC.SCI_CREATEDOCUMENT, 0, SC.SC_DOCUMENTOPTION_DEFAULT) >>> 0;
  }
  get dirty() { return this.forceDirty || this.modified; }
  get isEmptyUntitled() { return this.untitled && !this.dirty && this.length === 0; }
}

class App {
  async init() {
    const bootText = document.getElementById('boot-text');
    if (typeof WebAssembly !== 'object') throw new Error('This browser does not support WebAssembly.');
    bootText.textContent = 'Loading Scintilla (WebAssembly)…';
    this.M = await createNppModule();
    bootText.textContent = 'Loading configuration…';
    this.config = new NppConfig();
    await this.config.load('config/');
    this.settings = store.loadSettings(DEFAULTS);
    try { await this.config.setTheme(this.settings.theme); } catch (e) { console.warn(e); this.settings.theme = 'stylers.xml'; }
    document.body.classList.toggle('dark', !!this.settings.darkMode);

    this.buffers = [];
    this.current = null;
    this.recent = (await store.kvGet('recent')) || [];
    this.macro = null;
    this.recording = false;
    this.api = new Map();

    this.view = new ScintillaView(this.M, document.getElementById('editor'));
    this.searchView = new ScintillaView(this.M, document.getElementById('search-host'));
    this.results = new SearchResults(this, document.getElementById('results-panel'), ScintillaView, this.M);
    this.find = new FindReplace(this);

    this.buildCommands();
    this.buildMenus();
    this.buildToolbar();
    this.setupView(this.view);
    this.bindEvents();
    this.mobile = new MobileSupport(this);
    this.applyTheme();

    const restored = this.settings.rememberSession && await this.restoreSession();
    if (!restored) this.newFile();
    this.handleLaunchQueue();
    this.handleUrlParams();

    document.getElementById('app').classList.remove('booting');
    const boot = document.getElementById('boot');
    boot.classList.add('hide');
    setTimeout(() => boot.remove(), 400);
    this.focusEditor();
    window.ready = true;
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  get v() { return this.view; }
  send(msg, wp = 0, lp = 0) { return this.view.send(msg, wp, lp); }

  // ================================================================ view setup
  setupView(v) {
    const s = this.settings;
    v.send(SC.SCI_SETMARGINTYPEN, M_LINENUMBER, SC.SC_MARGIN_NUMBER);
    v.send(SC.SCI_SETMARGINTYPEN, M_SYMBOL, SC.SC_MARGIN_SYMBOL);
    v.send(SC.SCI_SETMARGINMASKN, M_SYMBOL, (1 << MARK_BOOKMARK) | (1 << MARK_HIDELINESBEGIN) | (1 << MARK_HIDELINESEND));
    v.send(SC.SCI_SETMARGINSENSITIVEN, M_SYMBOL, 1);
    v.send(SC.SCI_SETMARGINTYPEN, M_CHANGEHISTORY, SC.SC_MARGIN_SYMBOL);
    v.send(SC.SCI_SETMARGINMASKN, M_CHANGEHISTORY, SC.SC_MASK_HISTORY);
    v.send(SC.SCI_SETMARGINTYPEN, M_FOLDER, SC.SC_MARGIN_SYMBOL);
    v.send(SC.SCI_SETMARGINMASKN, M_FOLDER, SC.SC_MASK_FOLDERS);
    v.send(SC.SCI_SETMARGINSENSITIVEN, M_FOLDER, 1);
    v.send(SC.SCI_SETMARGINWIDTHN, M_FOLDER, 14);
    v.send(SC.SCI_SETMARGINS, 4);
    v.send(SC.SCI_SETMARGINLEFT, 0, 2);
    v.send(SC.SCI_SETMARGINRIGHT, 0, 2);
    v.send(SC.SCI_SETFOLDFLAGS, SC.SC_FOLDFLAG_LINEAFTER_CONTRACTED);
    v.send(SC.SCI_SETAUTOMATICFOLD, SC.SC_AUTOMATICFOLD_SHOW | SC.SC_AUTOMATICFOLD_CLICK | SC.SC_AUTOMATICFOLD_CHANGE);
    // bookmark and hide-lines markers from Notepad++'s RGBA icons
    const img = (marker, name, size) => {
      const bytes = this.config.rgbaIcons[name];
      if (!bytes) { v.send(SC.SCI_MARKERDEFINE, marker, SC.SC_MARK_BOOKMARK); return; }
      const p = this.M._malloc(bytes.length);
      this.M.HEAPU8.set(bytes, p);
      v.send(SC.SCI_RGBAIMAGESETWIDTH, size);
      v.send(SC.SCI_RGBAIMAGESETHEIGHT, size);
      v.send(SC.SCI_MARKERDEFINERGBAIMAGE, marker, p);
      this.M._free(p);
    };
    img(MARK_BOOKMARK, 'bookmark14', 14);
    img(MARK_HIDELINESBEGIN, 'hidelines_begin14', 14);
    img(MARK_HIDELINESEND, 'hidelines_end14', 14);

    v.send(SC.SCI_SETMULTIPLESELECTION, s.multiEdit ? 1 : 0);
    v.send(SC.SCI_SETADDITIONALSELECTIONTYPING, 1);
    v.send(SC.SCI_SETMULTIPASTE, SC.SC_MULTIPASTE_EACH);
    v.send(SC.SCI_SETVIRTUALSPACEOPTIONS, SC.SCVS_RECTANGULARSELECTION | (s.virtualSpace ? SC.SCVS_USERACCESSIBLE : 0));
    v.send(SC.SCI_SETMOUSESELECTIONRECTANGULARSWITCH, 1);
    v.send(SC.SCI_SETSCROLLWIDTHTRACKING, 1);
    v.send(SC.SCI_SETSCROLLWIDTH, 1);
    v.send(SC.SCI_SETCARETLINEVISIBLEALWAYS, 1);
    v.send(SC.SCI_SETLAYOUTCACHE, SC.SC_CACHE_PAGE);
    v.send(SC.SCI_SETCARETSTICKY, SC.SC_CARETSTICKY_OFF);
    v.send(SC.SCI_SETWORDCHARS, 0, 0);
    v.send(SC.SCI_AUTOCSETIGNORECASE, 1);
    v.send(SC.SCI_AUTOCSETCASEINSENSITIVEBEHAVIOUR, SC.SC_CASEINSENSITIVEBEHAVIOUR_IGNORECASE);
    v.send(SC.SCI_AUTOCSETMAXHEIGHT, 10);
    v.send(SC.SCI_AUTOCSETORDER, SC.SC_ORDER_PRESORTED);
    v.send(SC.SCI_CALLTIPSETPOSITION, 1);
    for (const ind of [29, 31, 28, 27, 26, 25, 24, 23, 22, 21, 30]) {
      v.send(SC.SCI_INDICSETSTYLE, ind, SC.INDIC_ROUNDBOX);
      v.send(SC.SCI_INDICSETALPHA, ind, 100);
      v.send(SC.SCI_INDICSETUNDER, ind, 1);
    }
    v.send(SC.SCI_INDICSETSTYLE, URL_INDIC, SC.INDIC_PLAIN);
    v.send(SC.SCI_INDICSETHOVERSTYLE, URL_INDIC, SC.INDIC_TEXTFORE);
    // Notepad++ keyboard defaults that differ from Scintilla's
    const key = (k, mods) => k + (mods << 16);
    v.send(SC.SCI_ASSIGNCMDKEY, key(SC.SCK_UP, SC.SCMOD_CTRL | SC.SCMOD_SHIFT), SC.SCI_MOVESELECTEDLINESUP);
    v.send(SC.SCI_ASSIGNCMDKEY, key(SC.SCK_DOWN, SC.SCMOD_CTRL | SC.SCMOD_SHIFT), SC.SCI_MOVESELECTEDLINESDOWN);
    v.send(SC.SCI_ASSIGNCMDKEY, key('D'.charCodeAt(0), SC.SCMOD_CTRL), SC.SCI_SELECTIONDUPLICATE);
    v.send(SC.SCI_CLEARCMDKEY, key('T'.charCodeAt(0), SC.SCMOD_CTRL));
    v.send(SC.SCI_CLEARCMDKEY, key('U'.charCodeAt(0), SC.SCMOD_CTRL));
    v.send(SC.SCI_CLEARCMDKEY, key('U'.charCodeAt(0), SC.SCMOD_CTRL | SC.SCMOD_SHIFT));
    v.send(SC.SCI_CLEARCMDKEY, key('[' .charCodeAt(0), SC.SCMOD_CTRL));
    v.send(SC.SCI_CLEARCMDKEY, key(']'.charCodeAt(0), SC.SCMOD_CTRL));
    v.send(SC.SCI_CLEARCMDKEY, key('/'.charCodeAt(0), SC.SCMOD_CTRL));
    v.send(SC.SCI_CLEARCMDKEY, key('\\'.charCodeAt(0), SC.SCMOD_CTRL));
    this.applyViewSettings();
  }

  applyViewSettings() {
    const v = this.view, s = this.settings;
    v.send(SC.SCI_SETWRAPMODE, s.wrap ? SC.SC_WRAP_WORD : SC.SC_WRAP_NONE);
    v.send(SC.SCI_SETWRAPVISUALFLAGS, s.showWrapSymbol ? SC.SC_WRAPVISUALFLAG_END : 0);
    v.send(SC.SCI_SETVIEWWS, s.showWS ? SC.SCWS_VISIBLEALWAYS : SC.SCWS_INVISIBLE);
    v.send(SC.SCI_SETWHITESPACESIZE, 2);
    v.send(SC.SCI_SETVIEWEOL, s.showEOL ? 1 : 0);
    v.send(SC.SCI_SETCARETLINEVISIBLE, s.currentLine ? 1 : 0);
    v.send(SC.SCI_SETCARETWIDTH, s.caretWidth);
    v.send(SC.SCI_SETCARETPERIOD, s.caretBlink);
    v.send(SC.SCI_SETENDATLASTLINE, s.scrollBeyondLast ? 0 : 1);
    v.send(SC.SCI_SETEDGEMODE, s.edge > 0 ? SC.EDGE_LINE : SC.EDGE_NONE);
    v.send(SC.SCI_SETEDGECOLUMN, s.edge);
    v.send(SC.SCI_SETMARGINWIDTHN, M_SYMBOL, s.bookmarkMargin ? 16 : 0);
    v.send(SC.SCI_SETMARGINWIDTHN, M_CHANGEHISTORY, s.changeHistory ? 9 : 0);
    v.send(SC.SCI_SETMULTIPLESELECTION, s.multiEdit ? 1 : 0);
    v.send(SC.SCI_SETVIRTUALSPACEOPTIONS, SC.SCVS_RECTANGULARSELECTION | (s.virtualSpace ? SC.SCVS_USERACCESSIBLE : 0));
    this.updateLineNumberWidth(true);
    if (this.current) this.applyIndentGuides();
  }
  applyIndentGuides() {
    const py = ['python', 'coffeescript', 'haskell', 'nim', 'yaml', 'gdscript', 'fortran'].includes(this.current.lang);
    this.send(SC.SCI_SETINDENTATIONGUIDES, this.settings.indentGuide ? (py ? SC.SC_IV_LOOKFORWARD : SC.SC_IV_LOOKBOTH) : SC.SC_IV_NONE);
  }
  updateLineNumberWidth(force) {
    const v = this.view;
    if (!this.settings.lineNumbers) { v.send(SC.SCI_SETMARGINWIDTHN, M_LINENUMBER, 0); this.lnDigits = 0; return; }
    const lines = v.send(SC.SCI_GETLINECOUNT);
    const digits = Math.max(3, String(lines).length);
    if (!force && digits === this.lnDigits) return;
    this.lnDigits = digits;
    const w = v.sendStr(SC.SCI_TEXTWIDTH, SC.STYLE_LINENUMBER, '8'.repeat(digits));
    v.send(SC.SCI_SETMARGINWIDTHN, M_LINENUMBER, w + 8);
  }

  // Applies language + theme to the main view for the current buffer.
  styleCurrent() {
    const v = this.view, b = this.current;
    const c = this.config;
    c.applyLanguage(v, b.lang);
    c.applyGlobalStyles(v);
    this.applyFontOverride(v);
    // calltip & autocomplete list colours follow the default style
    const def = c.globalStyleById(32) || {};
    v.send(SC.SCI_CALLTIPSETBACK, hexToBgr(this.settings.darkMode ? '3A3A3A' : 'FFFFE1'));
    v.send(SC.SCI_CALLTIPSETFORE, hexToBgr(this.settings.darkMode ? 'E0E0E0' : '000000'));
    v.send(SC.SCI_CALLTIPSETFOREHLT, hexToBgr(this.settings.darkMode ? '7BB7FF' : '0000FF'));
    const dark = this.settings.darkMode;
    const el = (e, hex) => v.send(SC.SCI_SETELEMENTCOLOUR, e, (hexToBgr(hex) | 0xFF000000) >>> 0);
    el(SC.SC_ELEMENT_LIST, dark ? 'E0E0E0' : '000000');
    el(SC.SC_ELEMENT_LIST_BACK, dark ? '2B2B2B' : 'FFFFFF');
    el(SC.SC_ELEMENT_LIST_SELECTED, 'FFFFFF');
    el(SC.SC_ELEMENT_LIST_SELECTED_BACK, dark ? '3D6A99' : '0078D7');
    const lang = c.langs.get(b.lang);
    let tab = this.settings.tabSize, spaces = this.settings.useSpaces;
    if (lang && lang.tabSettings && !isNaN(+lang.tabSettings) && +lang.tabSettings >= 0) {
      const t = +lang.tabSettings;
      if ((t & 0x7F) > 0) { tab = t & 0x7F; spaces = !!(t & 0x80); }
    }
    v.send(SC.SCI_SETTABWIDTH, tab);
    v.send(SC.SCI_SETUSETABS, spaces ? 0 : 1);
    v.send(SC.SCI_SETINDENT, 0);
    v.send(SC.SCI_SETTABINDENTS, 1);
    v.send(SC.SCI_SETBACKSPACEUNINDENTS, 0);
    this.applyIndentGuides();
    this.updateLineNumberWidth(true);
    this.chromeFromTheme(def);
    this.ensureApi(b.lang);
  }
  applyFontOverride(v) {
    const s = this.settings;
    if (!s.fontName && !(s.fontSize > 0)) return;
    for (let i = 0; i < 256; i++) {
      if (i >= 40 && i < 256 && i > 39 && false) continue;
      if (s.fontName) v.sendStr(SC.SCI_STYLESETFONT, i, s.fontName);
      if (s.fontSize > 0) v.send(SC.SCI_STYLESETSIZE, i, s.fontSize);
    }
  }
  chromeFromTheme(def) {
    // keep the browser chrome colour in sync with the theme
    const meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.content = this.settings.darkMode ? '#202020' : '#f0f0f0';
  }
  applyTheme() {
    document.body.classList.toggle('dark', !!this.settings.darkMode);
    this.results.applyTheme(this.config);
    this.applyFontOverride(this.results.view);
    if (this.current) this.styleCurrent();
    this.buildToolbar();
    this.renderTabs();
  }

  // ================================================================ buffers
  untitledName() {
    const used = new Set(this.buffers.filter((b) => b.untitled).map((b) => b.name));
    for (let i = 1; ; i++) if (!used.has('new ' + i)) return 'new ' + i;
  }
  createBuffer(opts, text = '') {
    const b = new Buffer(this, opts);
    const idx = opts.index !== undefined ? opts.index : (this.current ? this.buffers.indexOf(this.current) + 1 : this.buffers.length);
    this.buffers.splice(Math.min(idx, this.buffers.length), 0, b);
    this.attachDoc(b);
    this.current = b;
    this.loading = true;
    const v = this.view;
    v.send(SC.SCI_SETUNDOCOLLECTION, 0);
    v.setText(text);
    v.send(SC.SCI_SETUNDOCOLLECTION, 1);
    v.send(SC.SCI_EMPTYUNDOBUFFER);
    v.send(SC.SCI_SETSAVEPOINT);
    v.send(SC.SCI_SETEOLMODE, EOL_MODES[b.eol]);
    v.send(SC.SCI_SETCHANGEHISTORY, this.settings.changeHistory ? (SC.SC_CHANGE_HISTORY_ENABLED | SC.SC_CHANGE_HISTORY_MARKERS) : 0);
    b.modified = false;
    b.length = text.length;
    this.loading = false;
    this.styleCurrent();
    this.send(SC.SCI_GOTOPOS, 0);
    this.afterActivate();
    return b;
  }
  attachDoc(b) {
    if (this.current && this.current !== b && this.buffers.includes(this.current)) this.saveState(this.current);
    this.send(SC.SCI_SETDOCPOINTER, 0, b.doc);
  }
  saveState(b) {
    const v = this.view;
    const folds = [];
    let line = v.send(SC.SCI_CONTRACTEDFOLDNEXT, 0);
    while (line >= 0 && folds.length < 5000) { folds.push(line); line = v.send(SC.SCI_CONTRACTEDFOLDNEXT, line + 1); }
    const hidden = [];
    b.state = {
      anchor: v.send(SC.SCI_GETANCHOR), caret: v.send(SC.SCI_GETCURRENTPOS),
      first: v.send(SC.SCI_DOCLINEFROMVISIBLE, v.send(SC.SCI_GETFIRSTVISIBLELINE)), xoff: v.send(SC.SCI_GETXOFFSET), folds, hidden,
      zoom: v.send(SC.SCI_GETZOOM),
    };
  }
  restoreState(b) {
    const v = this.view, st = b.state;
    if (!st) return;
    if (st.folds && st.folds.length) {
      v.send(SC.SCI_COLOURISE, 0, -1);
      for (const l of st.folds) v.send(SC.SCI_FOLDLINE, l, SC.SC_FOLDACTION_CONTRACT);
    }
    v.send(SC.SCI_SETSEL, st.anchor, st.caret);
    v.send(SC.SCI_SETFIRSTVISIBLELINE, v.send(SC.SCI_VISIBLEFROMDOCLINE, st.first));
    v.send(SC.SCI_SETXOFFSET, st.xoff);
  }
  activate(b) {
    if (!b || !this.buffers.includes(b)) return;
    if (b === this.current) { this.focusEditor(); return; }
    this.send(SC.SCI_AUTOCCANCEL);
    this.send(SC.SCI_CALLTIPCANCEL);
    this.attachDoc(b);
    this.current = b;
    this.styleCurrent();
    this.restoreState(b);
    this.afterActivate();
  }
  afterActivate() {
    this.lnDigits = 0;
    this.updateLineNumberWidth();
    this.renderTabs();
    this.updateTitle();
    this.updateStatus();
    this.updateToolbar();
    this.smartHighlight();
    this.highlightUrls();
    this.scheduleSessionSave();
    const tab = this.tabEls && this.tabEls.get(this.current);
    if (tab) tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  newFile(text = '', lang) {
    return this.createBuffer({ name: this.untitledName(), untitled: true, lang: lang || this.settings.defaultLang, eol: this.settings.defaultEol, encoding: this.settings.defaultEncoding }, text);
  }
  async closeBuffer(b, { force = false } = {}) {
    if (!b) return true;
    if (b.dirty && !force) {
      this.activate(b);
      const r = await messageBox('Save', `Save file "${b.path || b.name}" ?`, ['Yes', 'No', 'Cancel'], 'question');
      if (r === 'Cancel') return false;
      if (r === 'Yes' && !(await this.save(b))) return false;
    }
    const idx = this.buffers.indexOf(b);
    if (idx < 0) return true;
    if (this.buffers.length === 1) {
      // Notepad++ keeps one empty document open
      this.buffers.splice(idx, 1);
      this.current = null;
      this.newFile();
    } else if (b === this.current) {
      const next = this.buffers[idx + 1] || this.buffers[idx - 1];
      this.buffers.splice(idx, 1);
      this.current = null;
      this.send(SC.SCI_SETDOCPOINTER, 0, next.doc);
      this.current = next;
      this.styleCurrent();
      this.restoreState(next);
      this.afterActivate();
    } else {
      this.buffers.splice(idx, 1);
      this.renderTabs();
    }
    this.send(SC.SCI_RELEASEDOCUMENT, 0, b.doc);
    this.scheduleSessionSave();
    return true;
  }
  async closeMany(list) {
    for (const b of list.slice()) {
      if (!(await this.closeBuffer(b))) return false;
    }
    return true;
  }
  // Runs fn(buffer, view) with every buffer's document available in a view.
  forEachBufferInView(fn) {
    for (const b of this.buffers) {
      if (b === this.current) { fn(b, this.view); continue; }
      this.searchView.send(SC.SCI_SETDOCPOINTER, 0, b.doc);
      fn(b, this.searchView);
    }
    this.searchView.send(SC.SCI_SETDOCPOINTER, 0, 0);
  }
  refreshAll() {
    for (const b of this.buffers) {
      if (b === this.current) continue;
      this.searchView.send(SC.SCI_SETDOCPOINTER, 0, b.doc);
      b.modified = !!this.searchView.send(SC.SCI_GETMODIFY);
    }
    this.searchView.send(SC.SCI_SETDOCPOINTER, 0, 0);
    this.renderTabs();
    this.updateStatus();
  }
  bufferText(b) {
    if (b === this.current) return this.view.getText();
    this.searchView.send(SC.SCI_SETDOCPOINTER, 0, b.doc);
    const t = this.searchView.getText();
    this.searchView.send(SC.SCI_SETDOCPOINTER, 0, 0);
    return t;
  }
  moveBuffer(b, toIndex) {
    const i = this.buffers.indexOf(b);
    if (i < 0) return;
    this.buffers.splice(i, 1);
    this.buffers.splice(Math.max(0, Math.min(toIndex, this.buffers.length)), 0, b);
    this.renderTabs();
    this.scheduleSessionSave();
  }
  eolString() { return EOL_STR[this.current ? this.current.eol : 'crlf']; }

  // ================================================================ files
  async openDialog() {
    if (window.showOpenFilePicker) {
      let handles;
      try { handles = await window.showOpenFilePicker({ multiple: true }); } catch (e) { return; }
      for (const hd of handles) await this.openHandle(hd);
    } else {
      const input = document.getElementById('file-input');
      input.value = '';
      input.onchange = async () => { for (const f of input.files) await this.openFile(f, null); };
      input.click();
    }
  }
  async openHandle(handle) {
    for (const b of this.buffers) {
      if (b.handle && handle.isSameEntry && await b.handle.isSameEntry(handle).catch(() => false)) { this.activate(b); return b; }
    }
    const file = await handle.getFile();
    return this.openFile(file, handle);
  }
  async openFile(file, handle) {
    if (!handle) {
      const same = this.buffers.find((b) => !b.handle && !b.untitled && b.name === file.name && b.lastModified === file.lastModified);
      if (same) { this.activate(same); return same; }
    }
    if (file.size > 256 * 1024 * 1024) {
      await messageBox('File size problem', `File "${file.name}" is too big to be opened in the web version.`, ['OK'], 'warning');
      return null;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { text, encoding } = decodeBytes(bytes);
    const eol = detectEol(text.slice(0, 65536)) || this.settings.defaultEol;
    const reuse = this.current && this.current.isEmptyUntitled && this.buffers.length === 1 ? this.current : null;
    const b = this.createBuffer({ name: file.name, path: handle ? file.name : file.name, handle, lang: this.config.languageForExtension(file.name), encoding, eol, lastModified: file.lastModified }, text);
    b.rawBytes = bytes.length < 16 * 1024 * 1024 ? bytes : null;
    if (reuse) await this.closeBuffer(reuse, { force: true });
    this.addRecent(file.name, handle);
    this.focusEditor();
    return b;
  }
  async save(b = this.current, { as = false, copy = false } = {}) {
    if (!b) return false;
    const text = this.bufferText(b);
    const bytes = encodeText(text, b.encoding);
    let handle = as || copy ? null : b.handle;
    let name = b.untitled ? b.name + '.txt' : b.name;
    if (!handle) {
      if (window.showSaveFilePicker) {
        try {
          handle = await window.showSaveFilePicker({ suggestedName: b.untitled ? (b.name.replace(/\s+/g, '') + this.defaultExt(b.lang)) : b.name });
        } catch (e) { return false; }
      } else {
        const r = await promptBox(copy ? 'Save a Copy As' : 'Save As', 'File name:', b.untitled ? b.name + this.defaultExt(b.lang) : b.name,
          { note: 'The file will be downloaded by your browser.', okLabel: 'Save' });
        if (!r) return false;
        this.download(r, bytes);
        if (!copy) this.markSaved(b, r, null);
        return true;
      }
    }
    try {
      if (handle.requestPermission) {
        const perm = await handle.requestPermission({ mode: 'readwrite' });
        if (perm !== 'granted') throw new Error('Permission to write the file was denied.');
      }
      const w = await handle.createWritable();
      await w.write(bytes);
      await w.close();
    } catch (e) {
      await messageBox('Save failed', `Please check whether this file is opened in another program.\n\n${e.message || e}`, ['OK'], 'error');
      return false;
    }
    if (!copy) {
      let fname = name;
      try { fname = (await handle.getFile()).name; } catch (_) { fname = handle.name || name; }
      this.markSaved(b, fname, handle);
      this.addRecent(fname, handle);
    }
    return true;
  }
  markSaved(b, name, handle) {
    const wasUntitled = b.untitled;
    b.name = name;
    b.path = name;
    if (handle) b.handle = handle;
    b.untitled = false;
    b.forceDirty = false;
    if (wasUntitled && b.lang === 'normal') {
      b.lang = this.config.languageForExtension(name);
    }
    const attach = b !== this.current;
    if (attach) this.searchView.send(SC.SCI_SETDOCPOINTER, 0, b.doc);
    (attach ? this.searchView : this.view).send(SC.SCI_SETSAVEPOINT);
    if (attach) this.searchView.send(SC.SCI_SETDOCPOINTER, 0, 0);
    b.modified = false;
    if (b === this.current && wasUntitled) this.styleCurrent();
    this.renderTabs();
    this.updateTitle();
    this.updateToolbar();
    this.updateStatus();
    this.scheduleSessionSave();
  }
  defaultExt(lang) {
    const l = this.config.langs.get(lang);
    return l && l.ext.length ? '.' + l.ext[0] : '.txt';
  }
  download(name, bytes) {
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  async saveAll() {
    for (const b of this.buffers.slice()) if (b.dirty && !(await this.save(b))) return;
  }
  async reload(b = this.current) {
    if (!b.handle) { toast('This document is not linked to a file on disk.'); return; }
    if (b.dirty) {
      const r = await messageBox('Reload', `Are you sure you want to reload the current file and lose the changes made in Notepad++?`, ['Yes', 'No'], 'question');
      if (r !== 'Yes') return;
    }
    try {
      if (b.handle.requestPermission) await b.handle.requestPermission({ mode: 'read' });
      const file = await b.handle.getFile();
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { text, encoding } = decodeBytes(bytes);
      this.activate(b);
      const pos = this.send(SC.SCI_GETCURRENTPOS);
      const first = this.send(SC.SCI_GETFIRSTVISIBLELINE);
      this.view.setText(text);
      this.send(SC.SCI_EMPTYUNDOBUFFER);
      this.send(SC.SCI_SETSAVEPOINT);
      b.encoding = encoding;
      b.forceDirty = false;
      b.rawBytes = bytes;
      this.send(SC.SCI_GOTOPOS, Math.min(pos, this.send(SC.SCI_GETLENGTH)));
      this.send(SC.SCI_SETFIRSTVISIBLELINE, first);
      this.updateStatus();
    } catch (e) {
      messageBox('Reload', 'Cannot reload the file: ' + (e.message || e), ['OK'], 'error');
    }
  }
  async rename(b = this.current) {
    const r = await promptBox('Rename Current Document', 'New name:', b.name);
    if (!r || r === b.name) return;
    if (b.handle && b.handle.move) {
      try { await b.handle.move(r); } catch (e) { messageBox('Rename', 'Could not rename the file: ' + e.message, ['OK'], 'error'); return; }
    }
    b.name = r;
    b.path = b.untitled ? '' : r;
    if (b.untitled && /\.[^.]+$/.test(r)) b.lang = this.config.languageForExtension(r);
    if (b === this.current) this.styleCurrent();
    this.renderTabs();
    this.updateTitle();
    this.updateStatus();
    this.scheduleSessionSave();
  }
  addRecent(name, handle) {
    if (!handle) return;
    this.recent = [{ name, handle }, ...this.recent.filter((r) => r.name !== name)].slice(0, 10);
    store.kvSet('recent', this.recent);
  }
  async openRecent(r) {
    try {
      if (r.handle.requestPermission) {
        const p = await r.handle.requestPermission({ mode: 'read' });
        if (p !== 'granted') return;
      }
      await this.openHandle(r.handle);
    } catch (e) {
      const ans = await messageBox('Open', `"${r.name}" cannot be opened:\n${e.message}\n\nRemove it from the Recent Files list?`, ['Yes', 'No'], 'question');
      if (ans === 'Yes') { this.recent = this.recent.filter((x) => x !== r); store.kvSet('recent', this.recent); }
    }
  }
  print() {
    const b = this.current;
    const text = this.view.getText();
    const w = window.open('', '_blank');
    if (!w) { toast('Pop-up blocked: allow pop-ups to print.'); return; }
    const pre = w.document.createElement('pre');
    pre.style.cssText = 'font: 10pt "Courier New", monospace; white-space: pre-wrap; margin: 0';
    pre.textContent = text;
    w.document.title = b.name;
    w.document.body.append(pre);
    w.focus();
    w.print();
  }
  viewInBrowser() {
    const b = this.current;
    const type = ['html', 'xml', 'php', 'asp', 'jsp'].includes(b.lang) ? (b.lang === 'xml' ? 'text/xml' : 'text/html') : 'text/plain';
    const url = URL.createObjectURL(new Blob([this.view.getText()], { type: type + ';charset=utf-8' }));
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  // ================================================================ session
  scheduleSessionSave() {
    if (!this.settings.rememberSession) return;
    clearTimeout(this.sessionTimer);
    this.sessionTimer = setTimeout(() => this.saveSession(), 1200);
  }
  async saveSession() {
    if (!this.current) return;
    this.saveState(this.current);
    const bufs = this.buffers.map((b, i) => ({
      key: i, name: b.name, path: b.path, untitled: b.untitled, lang: b.lang, encoding: b.encoding, eol: b.eol,
      text: this.bufferText(b), dirty: b.dirty, handle: b.handle || null, state: b.state, readOnly: b.readOnly,
      bookmarks: this.bookmarksOf(b), lastModified: b.lastModified,
    }));
    const session = { current: this.buffers.indexOf(this.current), version: 1 };
    try {
      await store.saveSession(session, bufs);
    } catch (e) {
      // FileSystemHandles may not be cloneable in some browsers: retry without them
      for (const b of bufs) b.handle = null;
      await store.saveSession(session, bufs);
    }
  }
  bookmarksOf(b) {
    const v = b === this.current ? this.view : this.searchView;
    if (v === this.searchView) v.send(SC.SCI_SETDOCPOINTER, 0, b.doc);
    const out = [];
    let l = v.send(SC.SCI_MARKERNEXT, 0, 1 << MARK_BOOKMARK);
    while (l >= 0 && out.length < 10000) { out.push(l); l = v.send(SC.SCI_MARKERNEXT, l + 1, 1 << MARK_BOOKMARK); }
    if (v === this.searchView) v.send(SC.SCI_SETDOCPOINTER, 0, 0);
    return out;
  }
  async restoreSession() {
    const s = await store.loadSession();
    if (!s || !s.buffers || !s.buffers.length) return false;
    const list = s.buffers.sort((a, b) => a.key - b.key);
    for (const sb of list) {
      const b = this.createBuffer({ name: sb.name, path: sb.path, untitled: sb.untitled, lang: sb.lang, encoding: sb.encoding, eol: sb.eol, handle: sb.handle, index: this.buffers.length, lastModified: sb.lastModified }, sb.text || '');
      b.forceDirty = !!sb.dirty;
      b.state = sb.state;
      if (sb.readOnly) { b.readOnly = true; this.send(SC.SCI_SETREADONLY, 1); }
      for (const l of sb.bookmarks || []) this.send(SC.SCI_MARKERADD, l, MARK_BOOKMARK);
      this.restoreState(b);
    }
    const cur = this.buffers[s.session.current] || this.buffers[0];
    this.activate(cur);
    this.restoreState(cur);
    this.renderTabs();
    return true;
  }

  // ================================================================ UI: title, tabs, status, toolbar
  updateTitle() {
    const b = this.current;
    document.title = `${b.dirty ? '*' : ''}${b.path || b.name} - Notepad++`;
  }
  renderTabs() {
    const bar = document.getElementById('tabbar');
    if (!this.buffers) return;
    bar.textContent = '';
    this.tabEls = new Map();
    const theme = this.settings.darkMode ? 'dark' : 'light';
    for (const b of this.buffers) {
      const icon = b.readOnly ? 'readonly' : (b.dirty ? 'unsaved' : 'saved');
      const iconSrc = `img/tabbar/${theme === 'dark' && icon === 'saved' ? 'light' : theme}/${icon}.png`;
      const close = h('button', { class: 'tab-close', title: 'Close' });
      const tab = h('div', {
        class: 'tab' + (b === this.current ? ' active' : '') + (b.dirty ? ' dirty' : ''), role: 'tab', draggable: 'true',
        title: b.path || b.name,
      }, h('img', { class: 'tab-icon', src: iconSrc, alt: '' }), h('span', { class: 'tab-name' }, b.name), close);
      tab.addEventListener('mousedown', (e) => {
        if (e.button === 0 && !e.target.closest('.tab-close')) { this.activate(b); setTimeout(() => this.focusEditor(), 0); }
        if (e.button === 1) { e.preventDefault(); this.closeBuffer(b); }
      });
      tab.addEventListener('dblclick', (e) => { if (!e.target.closest('.tab-close')) this.closeBuffer(b); });
      close.addEventListener('click', (e) => { e.stopPropagation(); this.closeBuffer(b); });
      tab.addEventListener('contextmenu', (e) => { e.preventDefault(); if (this.mobile && this.mobile.touch && e.pointerType !== 'mouse') return; this.activate(b); showPopupMenu(this.tabMenu(b), e.clientX, e.clientY); });
      onLongPress(tab, (e) => { this.activate(b); showPopupMenu(this.tabMenu(b), e.clientX, e.clientY + 10); });
      tab.addEventListener('dragstart', (e) => { this.dragTab = b; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/x-npp-tab', String(b.id)); });
      tab.addEventListener('dragover', (e) => { if (this.dragTab) { e.preventDefault(); tab.classList.add('drag-over'); } });
      tab.addEventListener('dragleave', () => tab.classList.remove('drag-over'));
      tab.addEventListener('drop', (e) => {
        if (!this.dragTab) return;
        e.preventDefault(); e.stopPropagation();
        tab.classList.remove('drag-over');
        const to = this.buffers.indexOf(b);
        const from = this.buffers.indexOf(this.dragTab);
        this.moveBuffer(this.dragTab, from < to ? to : to);
        this.dragTab = null;
      });
      tab.addEventListener('dragend', () => { this.dragTab = null; });
      this.tabEls.set(b, tab);
      bar.append(tab);
    }
    const filler = h('div', { class: 'tab-filler' });
    filler.addEventListener('dblclick', () => this.newFile());
    bar.append(filler);
  }
  updateStatus() {
    if (this.statusPending) return;
    this.statusPending = true;
    requestAnimationFrame(() => {
      this.statusPending = false;
      const v = this.view, b = this.current;
      if (!b) return;
      const len = v.send(SC.SCI_GETLENGTH);
      b.length = len;
      const lines = v.send(SC.SCI_GETLINECOUNT);
      const pos = v.send(SC.SCI_GETCURRENTPOS);
      const line = v.send(SC.SCI_LINEFROMPOSITION, pos);
      const col = v.send(SC.SCI_GETCOLUMN, pos);
      const s1 = v.send(SC.SCI_GETSELECTIONSTART), s2 = v.send(SC.SCI_GETSELECTIONEND);
      document.getElementById('sb-lang').textContent = this.config.longName(b.lang);
      document.getElementById('sb-size').textContent = `length : ${fmt(len)}    lines : ${fmt(lines)}`;
      let posText = `Ln : ${fmt(line + 1)}    Col : ${fmt(col + 1)}    `;
      const nsel = v.send(SC.SCI_GETSELECTIONS);
      if (v.send(SC.SCI_SELECTIONISRECTANGLE) || nsel > 1) {
        let chars = 0;
        for (let i = 0; i < nsel; i++) chars += v.send(SC.SCI_COUNTCHARACTERS, v.send(SC.SCI_GETSELECTIONNSTART, i), v.send(SC.SCI_GETSELECTIONNEND, i));
        posText += `Sel : ${fmt(chars)} | ${fmt(nsel)}`;
      } else if (s1 !== s2) {
        const chars = len < 50e6 ? v.send(SC.SCI_COUNTCHARACTERS, s1, s2) : s2 - s1;
        const l1 = v.send(SC.SCI_LINEFROMPOSITION, s1), l2 = v.send(SC.SCI_LINEFROMPOSITION, s2);
        posText += `Sel : ${fmt(chars)} | ${fmt(l2 - l1 + 1)}`;
      } else {
        posText += `Pos : ${fmt(pos + 1)}`;
      }
      document.getElementById('sb-pos').textContent = posText;
      document.getElementById('sb-eol').textContent = EOL_LABELS[b.eol];
      document.getElementById('sb-enc').textContent = ENCODINGS[b.encoding].status;
      document.getElementById('sb-ins').textContent = v.send(SC.SCI_GETOVERTYPE) ? 'OVR' : 'INS';
    });
  }
  buildToolbar() {
    const tb = document.getElementById('toolbar');
    tb.textContent = '';
    const theme = this.settings && this.settings.darkMode ? 'dark' : 'light';
    const items = [
      ['new', 'file.new', 'New'], ['open', 'file.open', 'Open'], ['save', 'file.save', 'Save'], ['saveall', 'file.saveAll', 'Save All'],
      ['close', 'file.close', 'Close'], ['closeall', 'file.closeAll', 'Close All'], ['print', 'file.print', 'Print'], '|',
      ['cut', 'edit.cut', 'Cut'], ['copy', 'edit.copy', 'Copy'], ['paste', 'edit.paste', 'Paste'], '|',
      ['undo', 'edit.undo', 'Undo'], ['redo', 'edit.redo', 'Redo'], '|',
      ['find', 'search.find', 'Find'], ['findrep', 'search.replace', 'Replace'], '|',
      ['zoomIn', 'view.zoomIn', 'Zoom In (Ctrl+Mouse Wheel Up)'], ['zoomOut', 'view.zoomOut', 'Zoom Out (Ctrl+Mouse Wheel Down)'], '|',
      ['wrap', 'view.wrap', 'Word wrap'], ['allChars', 'view.allChars', 'Show All Characters'], ['indentGuide', 'view.indentGuide', 'Show Indent Guide'], '|',
      ['startrecord', 'macro.start', 'Start Recording'], ['stoprecord', 'macro.stop', 'Stop Recording'], ['playrecord', 'macro.play', 'Playback'],
      ['playrecord_m', 'macro.runMulti', 'Run a Macro Multiple Times...'], ['saverecord', 'macro.save', 'Save Current Recorded Macro...'],
    ];
    this.tbButtons = new Map();
    const menuBtn = h('button', { class: 'tb-btn tb-menu', title: 'Menu', 'aria-label': 'Menu' }, h('span', { class: 'tb-burger' }));
    menuBtn.addEventListener('mousedown', (e) => e.preventDefault());
    menuBtn.addEventListener('click', () => this.mobile.showMainMenu(menuBtn));
    tb.append(menuBtn, h('div', { class: 'tb-sep tb-menu-sep' }));
    const optional = new Set(['file.closeAll', 'file.print', 'view.indentGuide', 'macro.runMulti', 'macro.save', 'view.zoomIn', 'view.zoomOut']);
    let group = 0;
    for (const it of items) {
      if (it === '|') { group++; tb.append(h('div', { class: 'tb-sep' + (group >= 7 ? ' tb-opt' : '') })); continue; }
      const [icon, cmd, title] = it;
      const key = this.shortcutFor(cmd);
      const b = h('button', { class: 'tb-btn', title: title + (key ? ` (${key})` : ''), 'aria-label': title },
        h('img', { src: `img/toolbar/${theme}/${icon}_off.png`, alt: '' }));
      if (optional.has(cmd) || cmd.startsWith('macro.')) b.classList.add('tb-opt');
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => { this.run(cmd); });
      this.tbButtons.set(cmd, b);
      tb.append(b);
    }
    this.updateToolbar();
  }
  updateToolbar() {
    if (!this.tbButtons || !this.current) return;
    const v = this.view;
    const set = (cmd, enabled, checked) => {
      const b = this.tbButtons.get(cmd);
      if (!b) return;
      b.disabled = !enabled;
      b.classList.toggle('checked', !!checked);
    };
    const sel = !v.send(SC.SCI_GETSELECTIONEMPTY);
    set('file.save', this.current.dirty);
    set('file.saveAll', this.buffers.some((b) => b.dirty));
    set('edit.cut', sel && !this.current.readOnly);
    set('edit.copy', sel);
    set('edit.paste', !this.current.readOnly);
    set('edit.undo', v.send(SC.SCI_CANUNDO));
    set('edit.redo', v.send(SC.SCI_CANREDO));
    set('view.wrap', true, this.settings.wrap);
    set('view.allChars', true, this.settings.showWS && this.settings.showEOL);
    set('view.indentGuide', true, this.settings.indentGuide);
    set('macro.start', !this.recording);
    set('macro.stop', this.recording);
    set('macro.play', !this.recording && !!this.macro);
    set('macro.runMulti', !this.recording && !!this.macro);
    set('macro.save', !this.recording && !!this.macro);
  }
  // On touch devices focusing the editor opens the on-screen keyboard, so only
  // refocus it there when the keyboard was already in use.
  focusEditor() {
    if (this.mobile && this.mobile.touch && !document.body.classList.contains('editor-focus')) return;
    this.view.focus();
  }
  flash(text) { toast(text); }
  beep() { /* Notepad++ beeps; stay quiet in the browser */ }
  layoutChanged() { this.view._layout(); this.results.view._layout(); }

  // ================================================================ editor behaviours
  onNotify(n) {
    const v = this.view, b = this.current;
    if (!b || this.loading) return;
    switch (n.code) {
      case SC.SCN_SAVEPOINTREACHED:
      case SC.SCN_SAVEPOINTLEFT:
        b.modified = n.code === SC.SCN_SAVEPOINTLEFT;
        this.renderTabs();
        this.updateTitle();
        this.updateToolbar();
        break;
      case SC.SCN_MODIFIED:
        if (n.modificationType & (SC.SC_MOD_INSERTTEXT | SC.SC_MOD_DELETETEXT)) {
          b.words = null;
          if (n.linesAdded) this.updateLineNumberWidth();
          this.scheduleSessionSave();
          this.updateStatus();
          if (!this.toolbarPending) {
            this.toolbarPending = true;
            requestAnimationFrame(() => { this.toolbarPending = false; this.updateToolbar(); });
          }
        }
        break;
      case SC.SCN_UPDATEUI:
        this.updateStatus();
        if (n.updated & (SC.SC_UPDATE_SELECTION | SC.SC_UPDATE_CONTENT)) {
          this.braceMatch();
          this.updateToolbar();
        }
        if (n.updated & (SC.SC_UPDATE_SELECTION | SC.SC_UPDATE_V_SCROLL | SC.SC_UPDATE_CONTENT)) {
          this.smartHighlight();
          this.highlightUrlsSoon();
        }
        break;
      case SC.SCN_CHARADDED:
        this.onCharAdded(n.ch);
        break;
      case SC.SCN_MARGINCLICK: {
        const line = v.send(SC.SCI_LINEFROMPOSITION, n.position);
        if (n.margin === M_SYMBOL) {
          const mk = v.send(SC.SCI_MARKERGET, line);
          if (mk & ((1 << MARK_HIDELINESBEGIN) | (1 << MARK_HIDELINESEND))) this.showHiddenAt(line, mk);
          else this.toggleBookmark(line);
        }
        break;
      }
      case SC.SCN_MACRORECORD:
        if (this.recording) {
          const rec = { msg: n.message, wp: n.wParam >>> 0, lp: n.lParam };
          if (n.message === SC.SCI_REPLACESEL || n.message === SC.SCI_INSERTTEXT || n.message === SC.SCI_ADDTEXT) {
            rec.str = this.M.UTF8ToString(n.lParam >>> 0);
            rec.lp = 0;
          }
          this.macroBuf.push(rec);
        }
        break;
      case SC.SCN_INDICATORRELEASE:
        if (this.settings.clickableLinks && v.send(SC.SCI_INDICATORVALUEAT, URL_INDIC, n.position) && v.send(SC.SCI_GETSELECTIONEMPTY)) {
          const s = v.send(SC.SCI_INDICATORSTART, URL_INDIC, n.position), e = v.send(SC.SCI_INDICATOREND, URL_INDIC, n.position);
          const url = v.getRange(s, e);
          if (/^(https?|ftp):\/\//i.test(url) || /^mailto:/i.test(url)) window.open(url, '_blank', 'noopener');
        }
        break;
      case SC.SCN_ZOOM:
        this.updateLineNumberWidth(true);
        break;
      case SC.SCN_AUTOCCOMPLETED:
        break;
    }
  }
  onCharAdded(ch) {
    const v = this.view, s = this.settings;
    const eolMode = v.send(SC.SCI_GETEOLMODE);
    if (s.autoIndent && ((ch === 10 && eolMode !== SC.SC_EOL_CR) || (ch === 13 && eolMode === SC.SC_EOL_CR))) {
      const line = v.send(SC.SCI_LINEFROMPOSITION, v.send(SC.SCI_GETCURRENTPOS));
      if (line > 0) {
        // Notepad++ smart indent: keep the previous indentation, add a level after "{" (C-like) or ":" (Python)
        let prev = line - 1;
        while (prev > 0 && v.send(SC.SCI_GETLINEINDENTPOSITION, prev) === v.send(SC.SCI_GETLINEENDPOSITION, prev)) prev--;
        let indent = v.send(SC.SCI_GETLINEINDENTATION, prev);
        const prevText = v.getRange(v.send(SC.SCI_POSITIONFROMLINE, prev), v.send(SC.SCI_GETLINEENDPOSITION, prev)).replace(/\s+$/, '');
        const lang = this.current.lang;
        const width = v.send(SC.SCI_GETINDENT) || v.send(SC.SCI_GETTABWIDTH);
        if (C_LIKE.has(lang) && /[{(\[]$/.test(prevText)) indent += width;
        else if ((lang === 'python' || lang === 'gdscript' || lang === 'nim') && /:$/.test(prevText.replace(/#.*$/, '').trimEnd())) indent += width;
        const pos = v.send(SC.SCI_GETCURRENTPOS);
        const atStart = pos === v.send(SC.SCI_POSITIONFROMLINE, line) || pos === v.send(SC.SCI_GETLINEINDENTPOSITION, line);
        if (indent > 0 && atStart) {
          v.send(SC.SCI_SETLINEINDENTATION, line, indent);
          v.send(SC.SCI_GOTOPOS, v.send(SC.SCI_GETLINEINDENTPOSITION, line));
          // "{|}" -> put the closing brace on its own line
          const next = v.send(SC.SCI_GETCHARAT, v.send(SC.SCI_GETCURRENTPOS));
          if (C_LIKE.has(lang) && (next === 125 || next === 41 || next === 93) && /[{(\[]$/.test(prevText)) {
            const here = v.send(SC.SCI_GETCURRENTPOS);
            v.sendStr(SC.SCI_INSERTTEXT, here, this.eolString());
            v.send(SC.SCI_SETLINEINDENTATION, line + 1, Math.max(0, indent - width));
            v.send(SC.SCI_GOTOPOS, here);
          }
        }
      }
      return;
    }
    if (s.autoIndent && (ch === 125 || ch === 41 || ch === 93) && C_LIKE.has(this.current.lang)) {
      const pos = v.send(SC.SCI_GETCURRENTPOS);
      const line = v.send(SC.SCI_LINEFROMPOSITION, pos);
      if (v.send(SC.SCI_GETLINEINDENTPOSITION, line) === pos - 1) {
        v.send(SC.SCI_COLOURISE, 0, pos);
        const m = v.send(SC.SCI_BRACEMATCH, pos - 1, 0);
        if (m >= 0) {
          const ind = v.send(SC.SCI_GETLINEINDENTATION, v.send(SC.SCI_LINEFROMPOSITION, m));
          v.send(SC.SCI_SETLINEINDENTATION, line, ind);
        }
      }
    }
    const c = String.fromCodePoint(ch);
    const api = this.api.get(this.current.lang);
    if (s.funcParamsHint && api) {
      if (c === api.startFunc || c === api.paramSeparator) { this.showCallTip(api); }
      else if (c === api.stopFunc) v.send(SC.SCI_CALLTIPCANCEL);
    }
    if (s.autoComplete && this.isWordChar(c, api)) this.autoComplete(false, s.autoCompleteFrom);
    else if (v.send(SC.SCI_AUTOCACTIVE)) v.send(SC.SCI_AUTOCCANCEL);
  }
  isWordChar(c, api) {
    return /[\p{L}\p{N}_]/u.test(c) || (api && api.additionalWordChar.includes(c));
  }
  async ensureApi(lang) {
    if (this.api.has(lang)) return this.api.get(lang);
    this.api.set(lang, null);
    const a = await this.config.loadApi(lang);
    this.api.set(lang, a);
    return a;
  }
  docWords() {
    const b = this.current;
    if (!b.words) {
      const len = this.send(SC.SCI_GETLENGTH);
      const text = len > 8 * 1024 * 1024 ? this.view.getRange(0, 8 * 1024 * 1024) : this.view.getText();
      const counts = new Map();
      for (const m of text.matchAll(/[\p{L}_][\p{L}\p{N}_]*/gu)) counts.set(m[0], (counts.get(m[0]) || 0) + 1);
      b.words = counts;
    }
    return b.words;
  }
  autoComplete(force, minLen = 1, which = 'both') {
    const v = this.view;
    const pos = v.send(SC.SCI_GETCURRENTPOS);
    const start = v.send(SC.SCI_WORDSTARTPOSITION, pos, 1);
    const prefix = v.getRange(start, pos);
    if (!force && (prefix.length < minLen || /^\d/.test(prefix))) { if (v.send(SC.SCI_AUTOCACTIVE)) v.send(SC.SCI_AUTOCCANCEL); return; }
    const api = this.api.get(this.current.lang);
    if (api === undefined) this.ensureApi(this.current.lang);
    const lower = prefix.toLowerCase();
    const set = new Set();
    if (api && which !== 'word') for (const w of api.words) if (w.name.toLowerCase().startsWith(lower)) set.add(w.name);
    if (which !== 'func' && (this.settings.wordCompletion || which === 'word')) {
      for (const [w, n] of this.docWords()) {
        if (w.toLowerCase().startsWith(lower) && !(w === prefix && n <= 1)) set.add(w);
      }
    }
    if (!force) set.delete(prefix);
    let list = Array.from(set);
    if (!list.length || (list.length === 1 && list[0] === prefix)) { if (v.send(SC.SCI_AUTOCACTIVE)) v.send(SC.SCI_AUTOCCANCEL); return; }
    list.sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : (a < b ? -1 : 1));
    if (list.length > 1000) list = list.slice(0, 1000);
    v.send(SC.SCI_AUTOCSETSEPARATOR, 10);
    v.sendStr(SC.SCI_AUTOCSHOW, textEncoder.encode(prefix).length, list.join('\n'));
  }
  showCallTip(api) {
    const v = this.view;
    const pos = v.send(SC.SCI_GETCURRENTPOS);
    // walk back to the opening bracket of the current call
    const ls = v.send(SC.SCI_POSITIONFROMLINE, v.send(SC.SCI_LINEFROMPOSITION, pos));
    const text = v.getRange(ls, pos);
    let depth = 0, commas = 0, open = -1;
    for (let i = text.length - 1; i >= 0; i--) {
      const ch = text[i];
      if (ch === api.stopFunc) depth++;
      else if (ch === api.startFunc) { if (depth === 0) { open = i; break; } depth--; }
      else if (ch === api.paramSeparator && depth === 0) commas++;
    }
    if (open < 0) { v.send(SC.SCI_CALLTIPCANCEL); return; }
    const m = /([\p{L}\p{N}_.$:]+)\s*$/u.exec(text.slice(0, open));
    if (!m) return;
    const name = m[1];
    const cmp = api.ignoreCase ? (a) => a.toLowerCase() === name.toLowerCase() : (a) => a === name;
    const kw = api.words.find((w) => w.func && cmp(w.name));
    if (!kw || !kw.overloads.length) { v.send(SC.SCI_CALLTIPCANCEL); return; }
    const o = kw.overloads[0];
    const sig = `${o.retVal ? o.retVal + ' ' : ''}${kw.name}${api.startFunc}${o.params.join(api.paramSeparator + ' ')}${api.stopFunc}`;
    const tip = sig + (o.descr ? '\n' + o.descr.replace(/\\n/g, '\n') : '') + (kw.overloads.length > 1 ? `\n(1 of ${kw.overloads.length})` : '');
    const openPos = ls + textEncoder.encode(text.slice(0, open)).length;
    v.sendStr(SC.SCI_CALLTIPSHOW, openPos - textEncoder.encode(name).length, tip);
    if (commas < o.params.length) {
      const before = `${o.retVal ? o.retVal + ' ' : ''}${kw.name}${api.startFunc}${o.params.slice(0, commas).map((p) => p + api.paramSeparator + ' ').join('')}`;
      const a = textEncoder.encode(before).length;
      v.send(SC.SCI_CALLTIPSETHLT, a, a + textEncoder.encode(o.params[commas]).length);
    }
  }
  braceMatch() {
    const v = this.view;
    if (!this.settings.braceHighlight) return;
    const pos = v.send(SC.SCI_GETCURRENTPOS);
    const isBrace = (p) => { const c = v.send(SC.SCI_GETCHARAT, p); return c === 40 || c === 41 || c === 91 || c === 93 || c === 123 || c === 125; };
    let p = -1;
    if (pos > 0 && isBrace(pos - 1)) p = pos - 1;
    else if (isBrace(pos)) p = pos;
    if (p < 0) {
      v.send(SC.SCI_BRACEHIGHLIGHT, -1, -1);
      v.send(SC.SCI_SETHIGHLIGHTGUIDE, 0);
      return;
    }
    const m = v.send(SC.SCI_BRACEMATCH, p, 0);
    if (m < 0) { v.send(SC.SCI_BRACEBADLIGHT, p); v.send(SC.SCI_SETHIGHLIGHTGUIDE, 0); return; }
    v.send(SC.SCI_BRACEHIGHLIGHT, p, m);
    if (this.settings.indentGuide) {
      const c1 = v.send(SC.SCI_GETCOLUMN, p), c2 = v.send(SC.SCI_GETCOLUMN, m);
      v.send(SC.SCI_SETHIGHLIGHTGUIDE, Math.min(c1, c2));
    }
  }
  smartHighlight() {
    const v = this.view;
    const ind = SC.SCE_UNIVERSAL_FOUND_STYLE_SMART;
    v.send(SC.SCI_SETINDICATORCURRENT, ind);
    const len = v.send(SC.SCI_GETLENGTH);
    if (this.smartRange) v.send(SC.SCI_INDICATORCLEARRANGE, 0, len);
    this.smartRange = false;
    if (!this.settings.smartHighlight) return;
    const s = v.send(SC.SCI_GETSELECTIONSTART), e = v.send(SC.SCI_GETSELECTIONEND);
    if (s === e || e - s > 200 || v.send(SC.SCI_GETSELECTIONS) > 1) return;
    if (v.send(SC.SCI_LINEFROMPOSITION, s) !== v.send(SC.SCI_LINEFROMPOSITION, e)) return;
    const word = v.getRange(s, e);
    if (this.settings.smartWholeWord) {
      if (!/^[\p{L}\p{N}_]+$/u.test(word)) return;
      if (v.send(SC.SCI_WORDSTARTPOSITION, s, 1) !== s || v.send(SC.SCI_WORDENDPOSITION, e, 1) !== e) return;
    }
    const first = v.send(SC.SCI_DOCLINEFROMVISIBLE, v.send(SC.SCI_GETFIRSTVISIBLELINE));
    const last = v.send(SC.SCI_DOCLINEFROMVISIBLE, v.send(SC.SCI_GETFIRSTVISIBLELINE) + v.send(SC.SCI_LINESONSCREEN) + 1);
    const from = v.send(SC.SCI_POSITIONFROMLINE, first);
    const to = v.send(SC.SCI_GETLINEENDPOSITION, Math.min(last, v.send(SC.SCI_GETLINECOUNT) - 1));
    let flags = 0;
    if (this.settings.smartMatchCase) flags |= SC.SCFIND_MATCHCASE;
    if (this.settings.smartWholeWord) flags |= SC.SCFIND_WHOLEWORD;
    const prepared = { text: word, flags, regex: false };
    let pos = from, n = 0;
    const tgtS = v.send(SC.SCI_GETTARGETSTART), tgtE = v.send(SC.SCI_GETTARGETEND);
    while (pos < to && n < 2000) {
      const r = SearchEngine.searchRange(v, prepared, pos, to);
      if (!r || r.error || r.end <= r.start) break;
      v.send(SC.SCI_INDICATORFILLRANGE, r.start, r.end - r.start);
      pos = r.end;
      n++;
    }
    v.send(SC.SCI_SETTARGETRANGE, tgtS, tgtE);
    this.smartRange = n > 0;
  }
  highlightUrlsSoon() {
    clearTimeout(this.urlTimer);
    this.urlTimer = setTimeout(() => this.highlightUrls(), 120);
  }
  highlightUrls() {
    const v = this.view;
    v.send(SC.SCI_SETINDICATORCURRENT, URL_INDIC);
    v.send(SC.SCI_INDICATORCLEARRANGE, 0, v.send(SC.SCI_GETLENGTH));
    if (!this.settings.clickableLinks) return;
    const first = v.send(SC.SCI_DOCLINEFROMVISIBLE, v.send(SC.SCI_GETFIRSTVISIBLELINE));
    const last = Math.min(v.send(SC.SCI_GETLINECOUNT) - 1, v.send(SC.SCI_DOCLINEFROMVISIBLE, v.send(SC.SCI_GETFIRSTVISIBLELINE) + v.send(SC.SCI_LINESONSCREEN) + 1));
    const from = v.send(SC.SCI_POSITIONFROMLINE, first), to = v.send(SC.SCI_GETLINEENDPOSITION, last);
    if (to - from > 500000) return;
    const bytes = v.getBytes(from, to);
    const text = new TextDecoder().decode(bytes);
    const re = /\b(?:https?|ftp):\/\/[^\s<>"'`{}|\\^)\]]+[^\s<>"'`{}|\\^.,;:!?)\]]|\bmailto:[^\s<>"']+/gi;
    let m;
    while ((m = re.exec(text))) {
      const s = from + textEncoder.encode(text.slice(0, m.index)).length;
      v.send(SC.SCI_INDICATORFILLRANGE, s, textEncoder.encode(m[0]).length);
    }
  }

  // ---------------------------------------------------------------- bookmarks & hidden lines
  toggleBookmark(line = this.send(SC.SCI_LINEFROMPOSITION, this.send(SC.SCI_GETCURRENTPOS))) {
    if (this.send(SC.SCI_MARKERGET, line) & (1 << MARK_BOOKMARK)) this.send(SC.SCI_MARKERDELETE, line, MARK_BOOKMARK);
    else this.send(SC.SCI_MARKERADD, line, MARK_BOOKMARK);
  }
  addBookmark(line) { if (!(this.send(SC.SCI_MARKERGET, line) & (1 << MARK_BOOKMARK))) this.send(SC.SCI_MARKERADD, line, MARK_BOOKMARK); }
  clearBookmarks() { this.send(SC.SCI_MARKERDELETEALL, MARK_BOOKMARK); }
  nextBookmark(dir) {
    const v = this.view, mask = 1 << MARK_BOOKMARK;
    const line = v.send(SC.SCI_LINEFROMPOSITION, v.send(SC.SCI_GETCURRENTPOS));
    let l = dir > 0 ? v.send(SC.SCI_MARKERNEXT, line + 1, mask) : v.send(SC.SCI_MARKERPREVIOUS, line - 1, mask);
    if (l < 0) l = dir > 0 ? v.send(SC.SCI_MARKERNEXT, 0, mask) : v.send(SC.SCI_MARKERPREVIOUS, v.send(SC.SCI_GETLINECOUNT), mask);
    if (l >= 0) { v.send(SC.SCI_ENSUREVISIBLEENFORCEPOLICY, l); v.send(SC.SCI_GOTOLINE, l); }
  }
  bookmarkedLines() {
    const out = [];
    const mask = 1 << MARK_BOOKMARK;
    let l = this.send(SC.SCI_MARKERNEXT, 0, mask);
    while (l >= 0) { out.push(l); l = this.send(SC.SCI_MARKERNEXT, l + 1, mask); }
    return out;
  }
  bookmarkOp(op) {
    const v = this.view;
    const lines = this.bookmarkedLines();
    const all = v.send(SC.SCI_GETLINECOUNT);
    const lineText = (l) => v.getRange(v.send(SC.SCI_POSITIONFROMLINE, l), v.send(SC.SCI_POSITIONFROMLINE, l + 1) || v.send(SC.SCI_GETLENGTH));
    if (op === 'inverse') {
      for (let l = 0; l < all; l++) this.toggleBookmark(l);
      return;
    }
    if (op === 'copy' || op === 'cut') {
      if (!lines.length) return;
      const text = lines.map((l) => lineText(l).replace(/\r?\n$|\r$/, '')).join(this.eolString());
      navigator.clipboard.writeText(text + this.eolString()).catch(() => {});
      this.view.lastCopy = { text: text + this.eolString(), rect: false, line: false };
      if (op === 'copy') return;
    }
    if (op === 'paste') {
      navigator.clipboard.readText().then((t) => {
        const parts = t.split(/\r\n|\n|\r/);
        v.send(SC.SCI_BEGINUNDOACTION);
        lines.forEach((l, i) => {
          if (i >= parts.length) return;
          v.send(SC.SCI_SETTARGETRANGE, v.send(SC.SCI_POSITIONFROMLINE, l), v.send(SC.SCI_GETLINEENDPOSITION, l));
          v.sendStr(SC.SCI_REPLACETARGET, -1, parts[i]);
        });
        v.send(SC.SCI_ENDUNDOACTION);
      }).catch(() => toast('Clipboard access was denied.'));
      return;
    }
    const removeSet = op === 'removeNon' ? Array.from({ length: all }, (_, i) => i).filter((l) => !lines.includes(l)) : lines;
    v.send(SC.SCI_BEGINUNDOACTION);
    for (let i = removeSet.length - 1; i >= 0; i--) {
      const l = removeSet[i];
      const s = v.send(SC.SCI_POSITIONFROMLINE, l);
      let e = v.send(SC.SCI_POSITIONFROMLINE, l + 1);
      if (l === all - 1) { e = v.send(SC.SCI_GETLENGTH); }
      v.send(SC.SCI_DELETERANGE, s, e - s);
    }
    v.send(SC.SCI_ENDUNDOACTION);
  }
  hideLines() {
    const v = this.view;
    let l1 = v.send(SC.SCI_LINEFROMPOSITION, v.send(SC.SCI_GETSELECTIONSTART));
    let l2 = v.send(SC.SCI_LINEFROMPOSITION, v.send(SC.SCI_GETSELECTIONEND));
    if (l1 === 0) l1 = 1;
    const last = v.send(SC.SCI_GETLINECOUNT) - 1;
    if (l2 >= last) l2 = last - 1;
    if (l2 < l1) return;
    v.send(SC.SCI_MARKERADD, l1 - 1, MARK_HIDELINESBEGIN);
    v.send(SC.SCI_MARKERADD, l2 + 1, MARK_HIDELINESEND);
    v.send(SC.SCI_HIDELINES, l1, l2);
    v.send(SC.SCI_GOTOLINE, l2 + 1);
  }
  showHiddenAt(line, mk) {
    const v = this.view;
    const mB = 1 << MARK_HIDELINESBEGIN, mE = 1 << MARK_HIDELINESEND;
    let start = line, end = line;
    if (mk & mB) end = v.send(SC.SCI_MARKERNEXT, line + 1, mE);
    else start = v.send(SC.SCI_MARKERPREVIOUS, line - 1, mB);
    if (start < 0 || end < 0) return;
    v.send(SC.SCI_SHOWLINES, start + 1, end - 1);
    v.send(SC.SCI_MARKERDELETE, start, MARK_HIDELINESBEGIN);
    v.send(SC.SCI_MARKERDELETE, end, MARK_HIDELINESEND);
  }

  // ---------------------------------------------------------------- text transforms
  selectedLineRange(wholeDocIfNoSel = true) {
    const v = this.view;
    const s = v.send(SC.SCI_GETSELECTIONSTART), e = v.send(SC.SCI_GETSELECTIONEND);
    let l1, l2;
    if (s === e || v.send(SC.SCI_LINEFROMPOSITION, s) === v.send(SC.SCI_LINEFROMPOSITION, e)) {
      if (!wholeDocIfNoSel) { l1 = l2 = v.send(SC.SCI_LINEFROMPOSITION, s); }
      else { l1 = 0; l2 = v.send(SC.SCI_GETLINECOUNT) - 1; }
    } else {
      l1 = v.send(SC.SCI_LINEFROMPOSITION, s);
      l2 = v.send(SC.SCI_LINEFROMPOSITION, e);
      if (e === v.send(SC.SCI_POSITIONFROMLINE, l2) && l2 > l1) l2--;
    }
    return { l1, l2, start: v.send(SC.SCI_POSITIONFROMLINE, l1), end: v.send(SC.SCI_GETLINEENDPOSITION, l2), hadSel: s !== e };
  }
  transformLines(fn, wholeDoc = true) {
    const v = this.view;
    if (this.current.readOnly) return;
    const r = this.selectedLineRange(wholeDoc);
    const text = v.getRange(r.start, r.end);
    const lines = text.split(/\r\n|\n|\r/);
    const out = fn(lines);
    if (!out) return;
    const joined = out.join(this.eolString());
    if (joined === text) return;
    v.send(SC.SCI_BEGINUNDOACTION);
    v.send(SC.SCI_SETTARGETRANGE, r.start, r.end);
    const n = v.sendStr(SC.SCI_REPLACETARGET, -1, joined);
    v.send(SC.SCI_ENDUNDOACTION);
    if (r.hadSel) v.send(SC.SCI_SETSEL, r.start, r.start + n);
  }
  transformSelection(fn) {
    const v = this.view;
    if (this.current.readOnly) return;
    const n = v.send(SC.SCI_GETSELECTIONS);
    v.send(SC.SCI_BEGINUNDOACTION);
    for (let i = 0; i < n; i++) {
      const s = v.send(SC.SCI_GETSELECTIONNSTART, i), e = v.send(SC.SCI_GETSELECTIONNEND, i);
      if (s === e) continue;
      const t = v.getRange(s, e);
      const r = fn(t);
      if (r === t) continue;
      v.send(SC.SCI_SETTARGETRANGE, s, e);
      const len = v.sendStr(SC.SCI_REPLACETARGET, -1, r);
      v.send(SC.SCI_SETSELECTIONNSTART, i, s);
      v.send(SC.SCI_SETSELECTIONNEND, i, s + len);
    }
    v.send(SC.SCI_ENDUNDOACTION);
  }
  sortLines(cmp, desc) {
    this.transformLines((lines) => {
      const sorted = lines.slice().sort(cmp);
      if (desc) sorted.reverse();
      return sorted;
    });
  }
  toggleComment(mode) {
    const v = this.view, b = this.current;
    const lang = this.config.langs.get(b.lang) || {};
    const cl = lang.commentLine, cs = lang.commentStart, ce = lang.commentEnd;
    if (mode === 'block' || mode === 'blockUn' || (!cl && (cs && ce))) {
      if (!cs || !ce) { toast('Block comment is not available for this language.'); return; }
      if (mode === 'blockUn' || (mode !== 'block' && false)) {
        this.transformSelection((t) => {
          const re = new RegExp('^(\\s*)' + escapeRe(cs) + ' ?([\\s\\S]*?) ?' + escapeRe(ce) + '(\\s*)$');
          const m = re.exec(t);
          return m ? m[1] + m[2] + m[3] : t;
        });
        return;
      }
      if (v.send(SC.SCI_GETSELECTIONEMPTY)) {
        const r = this.selectedLineRange(false);
        v.send(SC.SCI_SETSEL, r.start, r.end);
      }
      this.transformSelection((t) => cs + ' ' + t + ' ' + ce);
      return;
    }
    if (!cl) { toast('Comment is not available for this language.'); return; }
    const r = this.selectedLineRange(false);
    const lines = [];
    for (let l = r.l1; l <= r.l2; l++) lines.push(l);
    const isCommented = (l) => {
      const s = v.send(SC.SCI_GETLINEINDENTPOSITION, l);
      return v.getRange(s, s + textEncoder.encode(cl).length) === cl;
    };
    const blank = (l) => v.send(SC.SCI_GETLINEINDENTPOSITION, l) === v.send(SC.SCI_GETLINEENDPOSITION, l);
    let action = mode;
    if (mode === 'toggle') action = lines.filter((l) => !blank(l)).every(isCommented) ? 'un' : 'comment';
    v.send(SC.SCI_BEGINUNDOACTION);
    for (const l of lines) {
      if (blank(l) && action === 'comment' && lines.length > 1) continue;
      const s = v.send(SC.SCI_GETLINEINDENTPOSITION, l);
      if (action === 'comment') {
        v.sendStr(SC.SCI_INSERTTEXT, s, cl + ' ');
      } else if (isCommented(l)) {
        let n = textEncoder.encode(cl).length;
        if (v.send(SC.SCI_GETCHARAT, s + n) === 32) n++;
        v.send(SC.SCI_DELETERANGE, s, n);
      }
    }
    v.send(SC.SCI_ENDUNDOACTION);
  }
  convertEol(eol) {
    const b = this.current;
    b.eol = eol;
    this.send(SC.SCI_SETEOLMODE, EOL_MODES[eol]);
    this.send(SC.SCI_CONVERTEOLS, EOL_MODES[eol]);
    this.updateStatus();
  }
  encodeIn(enc) {
    // Reinterpret the original bytes (like "Encode in ...") when the file is unmodified
    const b = this.current;
    if (b.rawBytes && !b.dirty) {
      const { text } = decodeBytes(b.rawBytes, enc);
      this.view.setText(text);
      this.send(SC.SCI_EMPTYUNDOBUFFER);
      this.send(SC.SCI_SETSAVEPOINT);
    }
    b.encoding = enc;
    this.updateStatus();
  }
  convertTo(enc) {
    const b = this.current;
    if (b.encoding === enc) return;
    b.encoding = enc;
    b.forceDirty = true;
    this.renderTabs();
    this.updateTitle();
    this.updateStatus();
    this.updateToolbar();
  }
  setLanguage(lang) {
    this.current.lang = lang;
    this.styleCurrent();
    this.updateStatus();
    this.scheduleSessionSave();
    this.ensureApi(lang);
  }
  zoom(delta) {
    if (delta === 0) this.send(SC.SCI_SETZOOM, 0);
    else this.send(delta > 0 ? SC.SCI_ZOOMIN : SC.SCI_ZOOMOUT);
  }
  async hash(algo, fromSelection) {
    const text = fromSelection ? this.view.getSelText() : this.view.getText();
    const bytes = textEncoder.encode(text);
    let hex;
    if (algo === 'MD5') hex = md5(bytes);
    else {
      if (!crypto.subtle) { toast('Hashing needs a secure (https) context.'); return; }
      const d = await crypto.subtle.digest(algo, bytes);
      hex = Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, '0')).join('');
    }
    if (fromSelection) {
      navigator.clipboard.writeText(hex).then(() => toast(`${algo} copied to clipboard: ${hex}`)).catch(() => messageBox(algo, hex, ['OK'], 'info'));
    } else {
      const out = h('input', { class: 'txt', value: hex, readonly: true, style: { width: '100%', fontFamily: 'monospace' } });
      new Dialog({
        title: `Generate ${algo} digest`, width: 560, modal: true,
        body: h('div', { class: 'prompt' }, h('label', {}, `${algo} of "${this.current.name}" (UTF-8 bytes):`), out),
        buttons: [
          { label: 'Copy to clipboard', default: true, action: () => { navigator.clipboard.writeText(hex).catch(() => {}); } },
          { label: 'Close', cancel: true, action: (d) => d.close() },
        ],
      }).show();
    }
  }

  // ---------------------------------------------------------------- macros
  startRecording() {
    this.macroBuf = [];
    this.recording = true;
    this.send(SC.SCI_STARTRECORD);
    this.updateToolbar();
    toast('Recording macro…');
  }
  stopRecording() {
    if (!this.recording) return;
    this.send(SC.SCI_STOPRECORD);
    this.recording = false;
    this.macro = this.macroBuf;
    this.updateToolbar();
  }
  playMacro(macro = this.macro, times = 1) {
    if (!macro || this.recording) return;
    const v = this.view;
    v.send(SC.SCI_BEGINUNDOACTION);
    for (let t = 0; t < times; t++) {
      for (const r of macro) {
        if (r.str !== undefined) v.sendStr(r.msg, r.wp, r.str);
        else v.send(r.msg, r.wp, r.lp);
      }
    }
    v.send(SC.SCI_ENDUNDOACTION);
  }
  async runMacroMulti() {
    const r = await promptBox('Run a Macro Multiple Times', 'Run', '1', { type: 'number', min: 1, note: 'times (or 0 to run until the end of file)' });
    if (r === null) return;
    let n = parseInt(r, 10);
    if (isNaN(n) || n < 0) return;
    if (n === 0) {
      // until end of file: stop when caret no longer moves
      const v = this.view;
      let guard = 0, last = -1;
      v.send(SC.SCI_BEGINUNDOACTION);
      while (guard++ < 100000) {
        const pos = v.send(SC.SCI_GETCURRENTPOS);
        if (pos === last || pos >= v.send(SC.SCI_GETLENGTH)) break;
        last = pos;
        this.playMacro(this.macro, 1);
      }
      v.send(SC.SCI_ENDUNDOACTION);
    } else {
      this.playMacro(this.macro, n);
    }
  }
  async saveMacro() {
    if (!this.macro) return;
    const name = await promptBox('Save Macro', 'Name:', 'My macro');
    if (!name) return;
    this.settings.macros = [...this.settings.macros.filter((m) => m.name !== name), { name, actions: this.macro }];
    this.saveSettings();
    this.rebuildMenus();
  }

  // ================================================================ commands & menus
  buildCommands() {
    const v = () => this.view;
    const S = (m, w = 0, l = 0) => () => this.send(m, w, l);
    const toggle = (key) => () => { this.settings[key] = !this.settings[key]; this.saveSettings(); this.applyViewSettings(); this.updateToolbar(); };
    const dateFmt = (long) => {
      const d = new Date();
      const t = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      const ds = long ? d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : d.toLocaleDateString();
      return `${t} ${ds}`;
    };
    const properCase = (t, blend) => t.replace(/[\p{L}\p{N}']+/gu, (w) => w[0].toUpperCase() + (blend ? w.slice(1) : w.slice(1).toLowerCase()));
    const sentenceCase = (t, blend) => {
      let start = true;
      return Array.from(blend ? t : t.toLowerCase()).map((ch) => {
        if (start && /\p{L}/u.test(ch)) { start = false; return ch.toUpperCase(); }
        if (/[.!?]/.test(ch)) start = true;
        return ch;
      }).join('');
    };
    const coll = new Intl.Collator(undefined, { sensitivity: 'base' });
    const num = (s) => { const m = /-?\d+/.exec(s); return m ? parseInt(m[0], 10) : -Infinity; };
    const dec = (s, comma) => { const m = (comma ? /-?\d+(?:,\d+)?/ : /-?\d+(?:\.\d+)?/).exec(s); return m ? parseFloat(comma ? m[0].replace(',', '.') : m[0]) : -Infinity; };
    const C = {
      // File
      'file.new': () => this.newFile(),
      'file.open': () => this.openDialog(),
      'file.reload': () => this.reload(),
      'file.save': () => this.save(),
      'file.saveAs': () => this.save(this.current, { as: true }),
      'file.saveCopy': () => this.save(this.current, { copy: true }),
      'file.saveAll': () => this.saveAll(),
      'file.rename': () => this.rename(),
      'file.close': () => this.closeBuffer(this.current),
      'file.closeAll': () => this.closeMany(this.buffers),
      'file.closeAllBut': () => this.closeMany(this.buffers.filter((b) => b !== this.current)),
      'file.closeLeft': () => this.closeMany(this.buffers.slice(0, this.buffers.indexOf(this.current))),
      'file.closeRight': () => this.closeMany(this.buffers.slice(this.buffers.indexOf(this.current) + 1)),
      'file.closeUnchanged': () => this.closeMany(this.buffers.filter((b) => !b.dirty)),
      'file.print': () => this.print(),
      'file.openAllRecent': async () => { for (const r of this.recent.slice()) await this.openRecent(r); },
      'file.clearRecent': () => { this.recent = []; store.kvSet('recent', []); },
      // Edit
      'edit.undo': S(SC.SCI_UNDO),
      'edit.redo': S(SC.SCI_REDO),
      'edit.cut': () => { this.send(SC.SCI_CUT); },
      'edit.copy': () => { this.send(SC.SCI_COPY); },
      'edit.paste': () => { this.view.pasteFromClipboard(); },
      'edit.delete': S(SC.SCI_CLEAR),
      'edit.selectAll': S(SC.SCI_SELECTALL),
      'edit.beginEndSelect': () => {
        if (this.beginSel === undefined || this.beginSel === null) { this.beginSel = this.send(SC.SCI_GETCURRENTPOS); toast('Begin select set'); }
        else { this.send(SC.SCI_SETSEL, this.beginSel, this.send(SC.SCI_GETCURRENTPOS)); this.beginSel = null; }
      },
      'edit.dateShort': () => v().replaceSel(dateFmt(false)),
      'edit.dateLong': () => v().replaceSel(dateFmt(true)),
      'edit.dateIso': () => v().replaceSel(new Date().toISOString().replace('T', ' ').slice(0, 19)),
      'edit.copyPath': () => navigator.clipboard.writeText(this.current.path || this.current.name),
      'edit.copyName': () => navigator.clipboard.writeText(this.current.name),
      'edit.indent': S(SC.SCI_TAB),
      'edit.outdent': S(SC.SCI_BACKTAB),
      'edit.upper': () => this.transformSelection((t) => t.toUpperCase()),
      'edit.lower': () => this.transformSelection((t) => t.toLowerCase()),
      'edit.proper': () => this.transformSelection((t) => properCase(t, false)),
      'edit.properBlend': () => this.transformSelection((t) => properCase(t, true)),
      'edit.sentence': () => this.transformSelection((t) => sentenceCase(t, false)),
      'edit.sentenceBlend': () => this.transformSelection((t) => sentenceCase(t, true)),
      'edit.invert': () => this.transformSelection((t) => Array.from(t).map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join('')),
      'edit.random': () => this.transformSelection((t) => Array.from(t).map((c) => (Math.random() < 0.5 ? c.toLowerCase() : c.toUpperCase())).join('')),
      'edit.duplicate': S(SC.SCI_SELECTIONDUPLICATE),
      'edit.removeDup': () => this.transformLines((l) => Array.from(new Set(l))),
      'edit.removeConsecDup': () => this.transformLines((l) => l.filter((x, i) => i === 0 || x !== l[i - 1])),
      'edit.split': () => { this.send(SC.SCI_TARGETFROMSELECTION); this.send(SC.SCI_LINESSPLIT, 0); },
      'edit.join': () => { this.send(SC.SCI_TARGETFROMSELECTION); this.send(SC.SCI_LINESJOIN); },
      'edit.moveUp': S(SC.SCI_MOVESELECTEDLINESUP),
      'edit.moveDown': S(SC.SCI_MOVESELECTEDLINESDOWN),
      'edit.removeEmpty': () => this.transformLines((l) => l.filter((x) => x.length)),
      'edit.removeBlank': () => this.transformLines((l) => l.filter((x) => x.trim().length)),
      'edit.blankAbove': () => { const l = this.send(SC.SCI_LINEFROMPOSITION, this.send(SC.SCI_GETCURRENTPOS)); const p = this.send(SC.SCI_POSITIONFROMLINE, l); this.view.sendStr(SC.SCI_INSERTTEXT, p, this.eolString()); this.send(SC.SCI_GOTOPOS, p); },
      'edit.blankBelow': () => { const l = this.send(SC.SCI_LINEFROMPOSITION, this.send(SC.SCI_GETCURRENTPOS)); const p = this.send(SC.SCI_GETLINEENDPOSITION, l); this.view.sendStr(SC.SCI_INSERTTEXT, p, this.eolString()); this.send(SC.SCI_GOTOPOS, this.send(SC.SCI_POSITIONFROMLINE, l + 1)); },
      'edit.reverse': () => this.transformLines((l) => l.slice().reverse()),
      'edit.randomize': () => this.transformLines((l) => { const a = l.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }),
      'edit.sortAsc': () => this.sortLines((a, b) => (a < b ? -1 : a > b ? 1 : 0), false),
      'edit.sortDesc': () => this.sortLines((a, b) => (a < b ? -1 : a > b ? 1 : 0), true),
      'edit.sortCiAsc': () => this.sortLines(coll.compare, false),
      'edit.sortCiDesc': () => this.sortLines(coll.compare, true),
      'edit.sortIntAsc': () => this.sortLines((a, b) => num(a) - num(b), false),
      'edit.sortIntDesc': () => this.sortLines((a, b) => num(a) - num(b), true),
      'edit.sortDecDotAsc': () => this.sortLines((a, b) => dec(a) - dec(b), false),
      'edit.sortDecDotDesc': () => this.sortLines((a, b) => dec(a) - dec(b), true),
      'edit.sortDecCommaAsc': () => this.sortLines((a, b) => dec(a, true) - dec(b, true), false),
      'edit.sortDecCommaDesc': () => this.sortLines((a, b) => dec(a, true) - dec(b, true), true),
      'edit.sortLenAsc': () => this.sortLines((a, b) => a.length - b.length, false),
      'edit.sortLenDesc': () => this.sortLines((a, b) => a.length - b.length, true),
      'edit.commentToggle': () => this.toggleComment('toggle'),
      'edit.comment': () => this.toggleComment('comment'),
      'edit.uncomment': () => this.toggleComment('un'),
      'edit.blockComment': () => this.toggleComment('block'),
      'edit.blockUncomment': () => this.toggleComment('blockUn'),
      'edit.funcCompletion': () => { this.ensureApi(this.current.lang).then(() => this.autoComplete(true, 0, 'func')); },
      'edit.wordCompletion': () => this.autoComplete(true, 0, 'word'),
      'edit.paramHint': () => { this.ensureApi(this.current.lang).then((a) => a && this.showCallTip(a)); },
      'edit.eolCrlf': () => this.convertEol('crlf'),
      'edit.eolLf': () => this.convertEol('lf'),
      'edit.eolCr': () => this.convertEol('cr'),
      'edit.trimTrailing': () => this.transformLines((l) => l.map((x) => x.replace(/[ \t]+$/, ''))),
      'edit.trimLeading': () => this.transformLines((l) => l.map((x) => x.replace(/^[ \t]+/, ''))),
      'edit.trimBoth': () => this.transformLines((l) => l.map((x) => x.replace(/^[ \t]+|[ \t]+$/g, ''))),
      'edit.eolToSpace': () => this.transformLines((l) => [l.join(' ')]),
      'edit.trimBothEolToSpace': () => this.transformLines((l) => [l.map((x) => x.trim()).filter(Boolean).join(' ')]),
      'edit.tabToSpace': () => { const tw = this.send(SC.SCI_GETTABWIDTH); this.transformLines((l) => l.map((x) => { let out = '', col = 0; for (const ch of x) { if (ch === '\t') { const n = tw - (col % tw); out += ' '.repeat(n); col += n; } else { out += ch; col++; } } return out; })); },
      'edit.spaceToTabAll': () => { const tw = this.send(SC.SCI_GETTABWIDTH); this.transformLines((l) => l.map((x) => x.replace(new RegExp(` {${tw}}`, 'g'), '\t'))); },
      'edit.spaceToTabLeading': () => { const tw = this.send(SC.SCI_GETTABWIDTH); this.transformLines((l) => l.map((x) => x.replace(/^[ \t]+/, (m) => { let col = 0; for (const ch of m) col = ch === '\t' ? col + tw - (col % tw) : col + 1; return '\t'.repeat(Math.floor(col / tw)) + ' '.repeat(col % tw); }))); },
      'edit.columnEditor': () => this.columnEditor(),
      'edit.readOnly': () => { const b = this.current; b.readOnly = !b.readOnly; this.send(SC.SCI_SETREADONLY, b.readOnly ? 1 : 0); this.renderTabs(); this.scheduleSessionSave(); },
      'edit.searchInternet': () => { const t = this.view.getSelText() || this.wordAtCaret(); if (t) window.open('https://www.google.com/search?q=' + encodeURIComponent(t), '_blank', 'noopener'); },
      // Search
      'search.find': () => this.find.show('find'),
      'search.replace': () => this.find.show('replace'),
      'search.mark': () => this.find.show('mark'),
      'search.next': () => this.find.findNextQuick(1),
      'search.prev': () => this.find.findNextQuick(-1),
      'search.selNext': () => this.find.selectAndFind(1),
      'search.selPrev': () => this.find.selectAndFind(-1),
      'search.results': () => { if (this.results.visible) this.results.view.focus(); else toast('No search results yet: use "Find All" in the Find dialog.'); },
      'search.nextResult': () => this.results.next(1),
      'search.prevResult': () => this.results.next(-1),
      'search.goto': () => this.gotoDialog(),
      'search.matchingBrace': () => { const p = this.send(SC.SCI_GETCURRENTPOS); let m = this.send(SC.SCI_BRACEMATCH, p, 0); if (m < 0 && p > 0) m = this.send(SC.SCI_BRACEMATCH, p - 1, 0); if (m >= 0) this.send(SC.SCI_GOTOPOS, m); },
      'search.selectBetweenBraces': () => this.selectBetweenBraces(),
      'search.toggleBookmark': () => this.toggleBookmark(),
      'search.nextBookmark': () => this.nextBookmark(1),
      'search.prevBookmark': () => this.nextBookmark(-1),
      'search.clearBookmarks': () => this.clearBookmarks(),
      'search.cutBookmarked': () => this.bookmarkOp('cut'),
      'search.copyBookmarked': () => this.bookmarkOp('copy'),
      'search.pasteBookmarked': () => this.bookmarkOp('paste'),
      'search.removeBookmarked': () => this.bookmarkOp('remove'),
      'search.removeNonBookmarked': () => this.bookmarkOp('removeNon'),
      'search.inverseBookmark': () => this.bookmarkOp('inverse'),
      'search.clearAllStyles': () => { for (const i of [25, 24, 23, 22, 21, 31]) { this.send(SC.SCI_SETINDICATORCURRENT, i); this.send(SC.SCI_INDICATORCLEARRANGE, 0, this.send(SC.SCI_GETLENGTH)); } },
      // View
      'view.fullscreen': () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {}); },
      'view.browser': () => this.viewInBrowser(),
      'view.showWS': toggle('showWS'),
      'view.showEOL': toggle('showEOL'),
      'view.allChars': () => { const on = !(this.settings.showWS && this.settings.showEOL); this.settings.showWS = on; this.settings.showEOL = on; this.saveSettings(); this.applyViewSettings(); this.updateToolbar(); },
      'view.indentGuide': toggle('indentGuide'),
      'view.wrapSymbol': toggle('showWrapSymbol'),
      'view.wrap': toggle('wrap'),
      'view.zoomIn': () => this.zoom(1),
      'view.zoomOut': () => this.zoom(-1),
      'view.zoomReset': () => this.zoom(0),
      'view.nextTab': () => this.activate(this.buffers[(this.buffers.indexOf(this.current) + 1) % this.buffers.length]),
      'view.prevTab': () => this.activate(this.buffers[(this.buffers.indexOf(this.current) - 1 + this.buffers.length) % this.buffers.length]),
      'view.firstTab': () => this.activate(this.buffers[0]),
      'view.lastTab': () => this.activate(this.buffers[this.buffers.length - 1]),
      'view.moveTabFwd': () => this.moveBuffer(this.current, this.buffers.indexOf(this.current) + 1),
      'view.moveTabBack': () => this.moveBuffer(this.current, this.buffers.indexOf(this.current) - 1),
      'view.hideLines': () => this.hideLines(),
      'view.foldAll': S(SC.SCI_FOLDALL, SC.SC_FOLDACTION_CONTRACT),
      'view.unfoldAll': S(SC.SCI_FOLDALL, SC.SC_FOLDACTION_EXPAND),
      'view.foldCurrent': () => this.foldCurrent(true),
      'view.unfoldCurrent': () => this.foldCurrent(false),
      'view.summary': () => this.summary(),
      // Settings
      'settings.prefs': () => this.preferences(),
      'settings.style': () => this.styleConfigurator(),
      'settings.shortcuts': () => this.shortcutMapper(),
      'settings.darkMode': () => this.setDarkMode(!this.settings.darkMode),
      // Tools
      'tools.md5': () => this.hash('MD5', false), 'tools.md5sel': () => this.hash('MD5', true),
      'tools.sha1': () => this.hash('SHA-1', false), 'tools.sha1sel': () => this.hash('SHA-1', true),
      'tools.sha256': () => this.hash('SHA-256', false), 'tools.sha256sel': () => this.hash('SHA-256', true),
      'tools.sha512': () => this.hash('SHA-512', false), 'tools.sha512sel': () => this.hash('SHA-512', true),
      // Macro
      'macro.start': () => this.startRecording(),
      'macro.stop': () => this.stopRecording(),
      'macro.play': () => this.playMacro(),
      'macro.runMulti': () => this.runMacroMulti(),
      'macro.save': () => this.saveMacro(),
      'macro.trimSave': async () => { this.run('edit.trimTrailing'); await this.save(); },
      // Run
      'run.google': () => this.searchWeb('https://www.google.com/search?q='),
      'run.wikipedia': () => this.searchWeb('https://en.wikipedia.org/wiki/Special:Search?search='),
      'run.php': () => this.searchWeb('https://www.php.net/'),
      'run.mdn': () => this.searchWeb('https://developer.mozilla.org/search?q='),
      'run.newWindow': () => window.open(location.href.split('#')[0].split('?')[0], '_blank'),
      // Plugins
      'plugin.b64enc': () => this.transformSelection((t) => btoa(String.fromCharCode(...textEncoder.encode(t)))),
      'plugin.b64dec': () => this.transformSelection((t) => { try { return new TextDecoder().decode(Uint8Array.from(atob(t.replace(/\s+/g, '')), (c) => c.charCodeAt(0))); } catch (_) { toast('Base64 decode: invalid input'); return t; } }),
      'plugin.urlenc': () => this.transformSelection((t) => encodeURIComponent(t)),
      'plugin.urldec': () => this.transformSelection((t) => { try { return decodeURIComponent(t); } catch (_) { return t; } }),
      'plugin.qpenc': () => this.transformSelection((t) => Array.from(textEncoder.encode(t), (b) => (b === 61 || b > 126 || (b < 32 && b !== 10 && b !== 13 && b !== 9) ? '=' + b.toString(16).toUpperCase().padStart(2, '0') : String.fromCharCode(b))).join('')),
      'plugin.asciiToHex': () => this.transformSelection((t) => Array.from(textEncoder.encode(t), (b) => b.toString(16).toUpperCase().padStart(2, '0')).join('')),
      'plugin.hexToAscii': () => this.transformSelection((t) => { const hx = t.replace(/[^0-9a-f]/gi, ''); if (hx.length % 2) return t; return new TextDecoder().decode(Uint8Array.from(hx.match(/../g) || [], (x) => parseInt(x, 16))); }),
      'plugin.admin': () => messageBox('Plugins Admin', 'Notepad++ plugins are native Windows DLLs, so they cannot run in the WebAssembly build.\n\nMIME Tools and Converter are re-implemented here in JavaScript.', ['OK'], 'info'),
      // Window
      'window.list': () => this.windowsDialog(),
      'window.sortName': () => { this.buffers.sort((a, b) => coll.compare(a.name, b.name)); this.renderTabs(); },
      // Help
      'help.home': () => window.open('https://notepad-plus-plus.org/', '_blank', 'noopener'),
      'help.project': () => window.open('https://github.com/notepad-plus-plus/notepad-plus-plus', '_blank', 'noopener'),
      'help.manual': () => window.open('https://npp-user-manual.org/', '_blank', 'noopener'),
      'help.community': () => window.open('https://community.notepad-plus-plus.org/', '_blank', 'noopener'),
      'help.about': () => this.about(),
      'help.debug': () => this.debugInfo(),
    };
    for (let i = 1; i <= 9; i++) C['view.tab' + i] = () => this.activate(this.buffers[i - 1]);
    for (let i = 1; i <= 8; i++) {
      C['view.collapse' + i] = () => this.foldLevel(i, true);
      C['view.expand' + i] = () => this.foldLevel(i, false);
    }
    for (let i = 1; i <= 5; i++) {
      const ind = 26 - i; // Mark Style 1..5 = indicators 25..21
      C['search.styleAll' + i] = () => this.styleToken(ind, true);
      C['search.styleOne' + i] = () => this.styleToken(ind, false);
      C['search.clearStyle' + i] = () => { this.send(SC.SCI_SETINDICATORCURRENT, ind); this.send(SC.SCI_INDICATORCLEARRANGE, 0, this.send(SC.SCI_GETLENGTH)); };
    }
    for (const enc of Object.keys(ENCODINGS)) {
      C['enc.in.' + enc] = () => this.encodeIn(enc);
      C['enc.to.' + enc] = () => this.convertTo(enc);
    }
    this.cmds = C;
  }
  run(cmd) {
    const f = this.cmds[cmd];
    if (!f) { console.warn('unknown command', cmd); return; }
    closeAllPopups();
    const r = f();
    if (r && r.catch) r.catch((e) => console.error(e));
    if (!cmd.startsWith('search.find') && !cmd.startsWith('search.replace') && !cmd.startsWith('search.mark') && !document.querySelector('.dlg-backdrop')) {
      setTimeout(() => { if (!document.activeElement || document.activeElement === document.body) this.focusEditor(); }, 0);
    }
    setTimeout(() => { this.updateToolbar(); this.updateStatus(); }, 0);
  }
  searchWeb(prefix) {
    const t = this.view.getSelText() || this.wordAtCaret();
    if (t) window.open(prefix + encodeURIComponent(t), '_blank', 'noopener');
  }
  wordAtCaret() {
    const p = this.send(SC.SCI_GETCURRENTPOS);
    return this.view.getRange(this.send(SC.SCI_WORDSTARTPOSITION, p, 1), this.send(SC.SCI_WORDENDPOSITION, p, 1));
  }
  styleToken(ind, all) {
    const v = this.view;
    let s = v.send(SC.SCI_GETSELECTIONSTART), e = v.send(SC.SCI_GETSELECTIONEND);
    if (s === e) { s = v.send(SC.SCI_WORDSTARTPOSITION, s, 1); e = v.send(SC.SCI_WORDENDPOSITION, e, 1); }
    if (s === e) return;
    v.send(SC.SCI_SETINDICATORCURRENT, ind);
    if (!all) { v.send(SC.SCI_INDICATORFILLRANGE, s, e - s); return; }
    const list = SearchEngine.findAll(v, { text: v.getRange(s, e), flags: SC.SCFIND_MATCHCASE, regex: false });
    v.send(SC.SCI_SETINDICATORCURRENT, ind);
    for (const r of list) v.send(SC.SCI_INDICATORFILLRANGE, r.start, r.end - r.start);
  }
  selectBetweenBraces() {
    const v = this.view;
    const pos = v.send(SC.SCI_GETCURRENTPOS);
    const text = v.getText();
    const bytes = textEncoder.encode(text);
    // walk backwards in bytes for an unmatched opener, using Scintilla's brace matcher
    for (let p = pos - 1; p >= 0; p--) {
      const c = bytes[p];
      if (c === 40 || c === 91 || c === 123) {
        const m = v.send(SC.SCI_BRACEMATCH, p, 0);
        if (m >= pos) { v.send(SC.SCI_SETSEL, p + 1, m); return; }
      }
    }
  }
  foldCurrent(collapse) {
    const v = this.view;
    let line = v.send(SC.SCI_LINEFROMPOSITION, v.send(SC.SCI_GETCURRENTPOS));
    if (!(v.send(SC.SCI_GETFOLDLEVEL, line) & SC.SC_FOLDLEVELHEADERFLAG)) line = v.send(SC.SCI_GETFOLDPARENT, line);
    if (line >= 0) v.send(SC.SCI_FOLDLINE, line, collapse ? SC.SC_FOLDACTION_CONTRACT : SC.SC_FOLDACTION_EXPAND);
  }
  foldLevel(level, collapse) {
    const v = this.view;
    v.send(SC.SCI_COLOURISE, 0, -1);
    const n = v.send(SC.SCI_GETLINECOUNT);
    for (let l = 0; l < n; l++) {
      const fl = v.send(SC.SCI_GETFOLDLEVEL, l);
      if ((fl & SC.SC_FOLDLEVELHEADERFLAG) && ((fl & SC.SC_FOLDLEVELNUMBERMASK) - SC.SC_FOLDLEVELBASE) === level - 1) {
        v.send(SC.SCI_FOLDLINE, l, collapse ? SC.SC_FOLDACTION_CONTRACT : SC.SC_FOLDACTION_EXPAND);
      }
    }
  }

  menuItem(label, cmd, extra = {}) {
    return { label, cmd, key: extra.key !== undefined ? extra.key : this.keyLabel(cmd), ...extra };
  }
  buildMenus() {
    // Shortcut table (Notepad++ defaults). Keys use "Ctrl" and are shown as Cmd on macOS.
    this.keys = {
      'file.new': 'Ctrl+N', 'file.open': 'Ctrl+O', 'file.save': 'Ctrl+S', 'file.saveAs': 'Ctrl+Alt+S', 'file.saveAll': 'Ctrl+Shift+S',
      'file.close': 'Ctrl+W', 'file.closeAll': 'Ctrl+Shift+W', 'file.print': 'Ctrl+P',
      'edit.undo': 'Ctrl+Z', 'edit.redo': 'Ctrl+Y', 'edit.cut': 'Ctrl+X', 'edit.copy': 'Ctrl+C', 'edit.paste': 'Ctrl+V', 'edit.delete': 'Del',
      'edit.selectAll': 'Ctrl+A', 'edit.beginEndSelect': 'Ctrl+Alt+Shift+B', 'edit.indent': 'Tab', 'edit.outdent': 'Shift+Tab',
      'edit.upper': 'Ctrl+Shift+U', 'edit.lower': 'Ctrl+U', 'edit.proper': 'Alt+U', 'edit.properBlend': 'Alt+Shift+U',
      'edit.sentence': 'Ctrl+Alt+U', 'edit.sentenceBlend': 'Ctrl+Alt+Shift+U', 'edit.invert': 'Ctrl+Alt+I', 'edit.random': 'Ctrl+Alt+R',
      'edit.duplicate': 'Ctrl+D', 'edit.split': 'Ctrl+I', 'edit.join': 'Ctrl+J', 'edit.moveUp': 'Ctrl+Shift+Up', 'edit.moveDown': 'Ctrl+Shift+Down',
      'edit.blankAbove': 'Ctrl+Alt+Enter', 'edit.blankBelow': 'Ctrl+Alt+Shift+Enter',
      'edit.commentToggle': 'Ctrl+Q', 'edit.comment': 'Ctrl+K', 'edit.uncomment': 'Ctrl+Shift+K', 'edit.blockComment': 'Ctrl+Shift+Q',
      'edit.funcCompletion': 'Ctrl+Space', 'edit.wordCompletion': 'Ctrl+Enter', 'edit.paramHint': 'Ctrl+Shift+Space', 'edit.columnEditor': 'Alt+C',
      'search.find': 'Ctrl+F', 'search.next': 'F3', 'search.prev': 'Shift+F3', 'search.selNext': 'Ctrl+F3', 'search.selPrev': 'Ctrl+Shift+F3',
      'search.replace': 'Ctrl+H', 'search.mark': 'Ctrl+M', 'search.results': 'F7', 'search.nextResult': 'F4', 'search.prevResult': 'Shift+F4',
      'search.goto': 'Ctrl+G', 'search.matchingBrace': 'Ctrl+B', 'search.selectBetweenBraces': 'Ctrl+Alt+B',
      'search.toggleBookmark': 'Ctrl+F2', 'search.nextBookmark': 'F2', 'search.prevBookmark': 'Shift+F2', 'search.clearAllStyles': 'Ctrl+Alt+Shift+0',
      'view.fullscreen': 'F11', 'view.zoomIn': 'Ctrl+Num +', 'view.zoomOut': 'Ctrl+Num -', 'view.zoomReset': 'Ctrl+Num /',
      'view.nextTab': 'Ctrl+PgDn', 'view.prevTab': 'Ctrl+PgUp', 'view.moveTabFwd': 'Ctrl+Shift+PgDn', 'view.moveTabBack': 'Ctrl+Shift+PgUp',
      'view.hideLines': 'Alt+H', 'view.foldAll': 'Alt+0', 'view.unfoldAll': 'Alt+Shift+0', 'view.foldCurrent': 'Ctrl+Alt+F', 'view.unfoldCurrent': 'Ctrl+Alt+Shift+F',
      'macro.start': 'Ctrl+Shift+R', 'macro.play': 'Ctrl+Shift+P', 'help.about': 'F1',
      'tools.md5sel': '', 'run.google': '',
    };
    for (let i = 1; i <= 9; i++) this.keys['view.tab' + i] = 'Ctrl+' + i;
    for (let i = 1; i <= 8; i++) { this.keys['view.collapse' + i] = 'Alt+' + i; this.keys['view.expand' + i] = 'Alt+Shift+' + i; }
    for (let i = 1; i <= 5; i++) { this.keys['search.styleAll' + i] = 'Ctrl+Alt+' + i; this.keys['search.styleOne' + i] = 'Ctrl+Alt+Num ' + i; this.keys['search.clearStyle' + i] = 'Ctrl+Alt+Shift+' + i; }
    // Extra bindings that are not shown in menus (browser-friendly alternatives)
    this.extraKeys = {
      'Ctrl+=': 'view.zoomIn', 'Ctrl+-': 'view.zoomOut', 'Ctrl+0': 'view.zoomReset', 'Ctrl+Shift+Z': 'edit.redo',
      'Ctrl+Alt+N': 'file.new', 'Ctrl+Alt+W': 'file.close', 'Ctrl+Tab': 'view.nextTab', 'Ctrl+Shift+Tab': 'view.prevTab',
      'Alt+PgDn': 'view.nextTab', 'Alt+PgUp': 'view.prevTab', 'Ctrl+Alt+F3': 'search.selNext',
    };
    this.keyMap = new Map();
    for (const [cmd, k] of Object.entries(this.keys)) if (k) this.keyMap.set(k, cmd);
    for (const [k, cmd] of Object.entries(this.extraKeys)) this.keyMap.set(k, cmd);
    this.rebuildMenus();
  }
  keyLabel(cmd) {
    const k = this.keys && this.keys[cmd];
    return k ? (isMac ? k.replace(/Ctrl\+/g, 'Cmd+') : k) : '';
  }
  shortcutFor(cmd) { return this.keyLabel(cmd); }
  rebuildMenus() {
    const I = (label, cmd, extra) => this.menuItem(label, cmd, extra);
    const chk = (label, cmd, fn, extra = {}) => I(label, cmd, { checked: fn, ...extra });
    const s = this.settings;
    const hasSel = () => !this.send(SC.SCI_GETSELECTIONEMPTY);
    const notRO = () => this.current && !this.current.readOnly;
    const editSel = () => hasSel() && notRO();

    // Language menu: "None (Normal Text)" + one sub-menu per initial letter
    const langMenu = () => {
      const groups = new Map();
      const all = this.config.languages.filter((l) => l.name !== 'normal' && l.name !== 'searchResult' && l.name !== 'ext' && l.name !== 'user' && l.name !== 'javascript' && this.config.langs.has(l.name));
      for (const l of all) {
        const letter = l.short[0].toUpperCase();
        if (!groups.has(letter)) groups.set(letter, []);
        groups.get(letter).push(l);
      }
      const items = [{ label: 'None (Normal Text)', action: () => this.setLanguage('normal'), checked: () => this.current.lang === 'normal', radio: true }, '-'];
      for (const letter of Array.from(groups.keys()).sort()) {
        const ls = groups.get(letter).sort((a, b) => a.short.localeCompare(b.short));
        items.push({
          label: letter, checked: () => ls.some((l) => l.name === this.current.lang), radio: true,
          submenu: ls.map((l) => ({ label: l.short.replace(/&/g, '&&'), action: () => this.setLanguage(l.name), checked: () => this.current.lang === l.name, radio: true })),
        });
      }
      items.push('-', { label: 'User Defined Language', enabled: false, submenu: [] });
      return items;
    };
    const recentItems = () => this.recent.length
      ? this.recent.map((r, i) => ({ label: `&${(i + 1) % 10}: ${r.name.replace(/&/g, '&&')}`, action: () => this.openRecent(r) }))
      : [];
    const encItems = (prefix) => Object.entries(ENCODINGS).map(([k, e]) => ({
      label: (prefix === 'to' ? 'Convert to ' : '') + e.label, cmd: `enc.${prefix}.${k}`, radio: true,
      checked: prefix === 'in' ? () => this.current.encoding === k : undefined,
    }));
    const macroItems = () => s.macros.map((m) => ({ label: m.name.replace(/&/g, '&&'), action: () => this.playMacro(m.actions) }));
    const hashMenu = (name, cmd) => ({ label: name, submenu: [I('Generate...', cmd), I('Generate from selection into clipboard', cmd + 'sel', { enabled: hasSel })] });

    this.menus = [
      { label: '&File', items: () => [
        I('&New', 'file.new'), I('&Open...', 'file.open'), I('Re&load from Disk', 'file.reload', { enabled: () => !!this.current.handle }),
        I('&Save', 'file.save', { enabled: () => this.current.dirty }), I('Save &As...', 'file.saveAs'), I('Save a Copy As...', 'file.saveCopy'),
        I('Sa&ve All', 'file.saveAll', { enabled: () => this.buffers.some((b) => b.dirty) }), I('Rename...', 'file.rename'),
        I('&Close', 'file.close'), I('Clos&e All', 'file.closeAll'),
        { label: 'Close Multiple Documents', submenu: [I('Close All BUT Current Document', 'file.closeAllBut'), I('Close All to the Left', 'file.closeLeft'), I('Close All to the Right', 'file.closeRight'), I('Close All Unchanged', 'file.closeUnchanged')] },
        '-', I('&Print...', 'file.print'), '-',
        ...recentItems(), ...(this.recent.length ? ['-', I('Open All Recent Files', 'file.openAllRecent'), I('Empty Recent Files List', 'file.clearRecent'), '-'] : []),
        { label: 'E&xit', action: () => this.exitApp() },
      ] },
      { label: '&Edit', items: () => [
        I('&Undo', 'edit.undo', { enabled: () => this.send(SC.SCI_CANUNDO) }), I('&Redo', 'edit.redo', { enabled: () => this.send(SC.SCI_CANREDO) }), '-',
        I('Cu&t', 'edit.cut', { enabled: editSel }), I('&Copy', 'edit.copy', { enabled: hasSel }), I('&Paste', 'edit.paste', { enabled: notRO }),
        I('&Delete', 'edit.delete', { enabled: notRO }), I('Select A&ll', 'edit.selectAll'), I('Begin/End &Select', 'edit.beginEndSelect'), '-',
        { label: 'Insert', submenu: [I('Date Time (short)', 'edit.dateShort'), I('Date Time (long)', 'edit.dateLong'), I('Date Time (ISO)', 'edit.dateIso')] },
        { label: 'Cop&y to Clipboard', submenu: [I('Copy Current Full File path', 'edit.copyPath'), I('Copy Current Filename', 'edit.copyName')] },
        { label: '&Indent', submenu: [I('Increase Line Indent', 'edit.indent'), I('Decrease Line Indent', 'edit.outdent')] },
        { label: 'Convert Case to', submenu: [I('&UPPERCASE', 'edit.upper'), I('&lowercase', 'edit.lower'), I('&Proper Case', 'edit.proper'), I('Proper Case (blend)', 'edit.properBlend'),
          I('&Sentence case', 'edit.sentence'), I('Sentence case (blend)', 'edit.sentenceBlend'), I('&iNVERT cASE', 'edit.invert'), I('&ranDOm CasE', 'edit.random')] },
        { label: 'Line Operations', submenu: [
          I('Duplicate Current Line', 'edit.duplicate'), I('Remove Duplicate Lines', 'edit.removeDup'), I('Remove Consecutive Duplicate Lines', 'edit.removeConsecDup'),
          I('Split Lines', 'edit.split'), I('Join Lines', 'edit.join'), I('Move Up Current Line', 'edit.moveUp'), I('Move Down Current Line', 'edit.moveDown'),
          I('Remove Empty Lines', 'edit.removeEmpty'), I('Remove Empty Lines (Containing Blank characters)', 'edit.removeBlank'),
          I('Insert Blank Line Above Current', 'edit.blankAbove'), I('Insert Blank Line Below Current', 'edit.blankBelow'), '-',
          I('Reverse Line Order', 'edit.reverse'), I('Randomize Line Order', 'edit.randomize'), '-',
          I('Sort Lines Lexicographically Ascending', 'edit.sortAsc'), I('Sort Lines Lex. Ascending Ignoring Case', 'edit.sortCiAsc'),
          I('Sort Lines As Integers Ascending', 'edit.sortIntAsc'), I('Sort Lines As Decimals (Comma) Ascending', 'edit.sortDecCommaAsc'),
          I('Sort Lines As Decimals (Dot) Ascending', 'edit.sortDecDotAsc'), I('Sort Lines By Length Ascending', 'edit.sortLenAsc'), '-',
          I('Sort Lines Lexicographically Descending', 'edit.sortDesc'), I('Sort Lines Lex. Descending Ignoring Case', 'edit.sortCiDesc'),
          I('Sort Lines As Integers Descending', 'edit.sortIntDesc'), I('Sort Lines As Decimals (Comma) Descending', 'edit.sortDecCommaDesc'),
          I('Sort Lines As Decimals (Dot) Descending', 'edit.sortDecDotDesc'), I('Sort Lines By Length Descending', 'edit.sortLenDesc')] },
        { label: 'Comment/Uncomment', submenu: [I('Toggle Single Line Comment', 'edit.commentToggle'), I('Single Line Comment', 'edit.comment'), I('Single Line Uncomment', 'edit.uncomment'),
          I('Block Comment', 'edit.blockComment'), I('Block Uncomment', 'edit.blockUncomment')] },
        { label: 'Auto-Completion', submenu: [I('Function Completion', 'edit.funcCompletion'), I('Word Completion', 'edit.wordCompletion'), I('Function Parameters Hint', 'edit.paramHint')] },
        { label: 'EOL Conversion', submenu: [
          chk('Windows (CR LF)', 'edit.eolCrlf', () => this.current.eol === 'crlf', { radio: true }),
          chk('Unix (LF)', 'edit.eolLf', () => this.current.eol === 'lf', { radio: true }),
          chk('Macintosh (CR)', 'edit.eolCr', () => this.current.eol === 'cr', { radio: true })] },
        { label: 'Blank Operations', submenu: [I('Trim Trailing Space', 'edit.trimTrailing'), I('Trim Leading Space', 'edit.trimLeading'), I('Trim Leading and Trailing Space', 'edit.trimBoth'),
          I('EOL to Space', 'edit.eolToSpace'), I('Trim both and EOL to Space', 'edit.trimBothEolToSpace'), '-',
          I('TAB to Space', 'edit.tabToSpace'), I('Space to TAB (All)', 'edit.spaceToTabAll'), I('Space to TAB (Leading)', 'edit.spaceToTabLeading')] },
        { label: 'On Selection', submenu: [I('Search on Internet', 'edit.searchInternet')] },
        '-', I('Column Editor...', 'edit.columnEditor'), '-',
        chk('Read-Only in Notepad++', 'edit.readOnly', () => this.current.readOnly),
      ] },
      { label: '&Search', items: () => [
        I('&Find...', 'search.find'), I('Find &Next', 'search.next'), I('Find &Previous', 'search.prev'),
        I('Select and Find Next', 'search.selNext'), I('Select and Find Previous', 'search.selPrev'), I('&Replace...', 'search.replace'), '-',
        I('Search Results Window', 'search.results'), I('Next Search Result', 'search.nextResult'), I('Previous Search Result', 'search.prevResult'), '-',
        I('&Go to...', 'search.goto'), I('Go to Matching Brace', 'search.matchingBrace'), I('Select All In-between {} [] or ()', 'search.selectBetweenBraces'),
        I('Mar&k...', 'search.mark'), '-',
        { label: 'Style All Occurrences of Token', submenu: [1, 2, 3, 4, 5].map((i) => I(`Using ${['1st', '2nd', '3rd', '4th', '5th'][i - 1]} Style`, 'search.styleAll' + i)) },
        { label: 'Style One Token', submenu: [1, 2, 3, 4, 5].map((i) => I(`Using ${['1st', '2nd', '3rd', '4th', '5th'][i - 1]} Style`, 'search.styleOne' + i)) },
        { label: 'Clear Style', submenu: [...[1, 2, 3, 4, 5].map((i) => I(`Clear ${['1st', '2nd', '3rd', '4th', '5th'][i - 1]} Style`, 'search.clearStyle' + i)), I('Clear all Styles', 'search.clearAllStyles')] },
        '-',
        { label: 'Bookmark', submenu: [I('Toggle Bookmark', 'search.toggleBookmark'), I('Next Bookmark', 'search.nextBookmark'), I('Previous Bookmark', 'search.prevBookmark'),
          I('Clear All Bookmarks', 'search.clearBookmarks'), I('Cut Bookmarked Lines', 'search.cutBookmarked'), I('Copy Bookmarked Lines', 'search.copyBookmarked'),
          I('Paste to (Replace) Bookmarked Lines', 'search.pasteBookmarked'), I('Remove Bookmarked Lines', 'search.removeBookmarked'),
          I('Remove Non-Bookmarked Lines', 'search.removeNonBookmarked'), I('Inverse Bookmark', 'search.inverseBookmark')] },
      ] },
      { label: '&View', items: () => [
        chk('Toggle Full Screen Mode', 'view.fullscreen', () => !!document.fullscreenElement), '-',
        I('View Current File in Browser', 'view.browser'),
        { label: 'Show Symbol', submenu: [chk('Show Space and Tab', 'view.showWS', () => s.showWS), chk('Show End of Line', 'view.showEOL', () => s.showEOL),
          chk('Show All Characters', 'view.allChars', () => s.showWS && s.showEOL), '-', chk('Show Indent Guide', 'view.indentGuide', () => s.indentGuide),
          chk('Show Wrap Symbol', 'view.wrapSymbol', () => s.showWrapSymbol)] },
        { label: 'Zoom', submenu: [I('Zoom &In', 'view.zoomIn'), I('Zoom &Out', 'view.zoomOut'), I('Restore Default Zoom', 'view.zoomReset')] },
        { label: 'Tab', submenu: [...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => I(`${['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th'][i - 1]} Tab`, 'view.tab' + i)),
          I('First Tab', 'view.firstTab'), I('Last Tab', 'view.lastTab'), I('Next Tab', 'view.nextTab'), I('Previous Tab', 'view.prevTab'), '-',
          I('Move Tab Forward', 'view.moveTabFwd'), I('Move Tab Backward', 'view.moveTabBack')] },
        chk('&Word wrap', 'view.wrap', () => s.wrap), '-',
        I('Hide Lines', 'view.hideLines'), '-',
        I('Fold All', 'view.foldAll'), I('Unfold All', 'view.unfoldAll'), I('Collapse Current Level', 'view.foldCurrent'), I('Uncollapse Current Level', 'view.unfoldCurrent'),
        { label: 'Collapse Level', submenu: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => I(String(i), 'view.collapse' + i)) },
        { label: 'Uncollapse Level', submenu: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => I(String(i), 'view.expand' + i)) },
        '-', I('Summary...', 'view.summary'),
      ] },
      { label: 'E&ncoding', items: () => [...encItems('in'), '-', ...encItems('to')] },
      { label: '&Language', items: langMenu },
      { label: 'Se&ttings', items: () => [I('Preferences...', 'settings.prefs'), I('Style Configurator...', 'settings.style'), I('Shortcut Mapper...', 'settings.shortcuts'), '-',
        chk('Dark Mode', 'settings.darkMode', () => s.darkMode)] },
      { label: 'T&ools', items: () => [hashMenu('MD5', 'tools.md5'), hashMenu('SHA-1', 'tools.sha1'), hashMenu('SHA-256', 'tools.sha256'), hashMenu('SHA-512', 'tools.sha512')] },
      { label: '&Macro', items: () => [
        I('Start Recording', 'macro.start', { enabled: () => !this.recording }), I('Stop Recording', 'macro.stop', { enabled: () => this.recording }),
        I('Playback', 'macro.play', { enabled: () => !!this.macro && !this.recording }), I('Save Current Recorded Macro...', 'macro.save', { enabled: () => !!this.macro && !this.recording }),
        I('Run a Macro Multiple Times...', 'macro.runMulti', { enabled: () => !!this.macro && !this.recording }), '-',
        I('Trim Trailing Space and Save', 'macro.trimSave'), ...(s.macros.length ? ['-', ...macroItems()] : []),
      ] },
      { label: '&Run', items: () => [I('Google Search', 'run.google'), I('Wikipedia Search', 'run.wikipedia'), I('Get PHP help', 'run.php'), I('MDN Web Docs Search', 'run.mdn'), '-',
        I('Open in another instance', 'run.newWindow')] },
      { label: '&Plugins', items: () => [
        { label: 'MIME Tools', submenu: [I('Base64 Encode', 'plugin.b64enc', { enabled: editSel }), I('Base64 Decode', 'plugin.b64dec', { enabled: editSel }), '-',
          I('Quoted-printable Encode', 'plugin.qpenc', { enabled: editSel }), I('URL Encode', 'plugin.urlenc', { enabled: editSel }), I('URL Decode', 'plugin.urldec', { enabled: editSel })] },
        { label: 'Converter', submenu: [I('ASCII -> HEX', 'plugin.asciiToHex', { enabled: editSel }), I('HEX -> ASCII', 'plugin.hexToAscii', { enabled: editSel })] },
        '-', I('Plugins Admin...', 'plugin.admin'),
      ] },
      { label: '&Window', items: () => [I('&Windows...', 'window.list'), I('Sort By Name A to Z', 'window.sortName'), '-',
        ...this.buffers.slice(0, 20).map((b, i) => ({ label: `&${(i + 1) % 10}: ${b.name.replace(/&/g, '&&')}`, action: () => this.activate(b), checked: () => b === this.current, radio: true }))] },
      { label: '&?', items: () => [I('Notepad++ &Home', 'help.home'), I('Notepad++ &Project Page', 'help.project'), I('Online User &Manual', 'help.manual'),
        I('Notepad++ &Community (Forum)', 'help.community'), '-', I('Debug Info...', 'help.debug'), I('&About Notepad++', 'help.about')] },
    ];
    const bar = document.getElementById('menubar');
    bar.textContent = '';
    this.menubar = new MenuBar(bar, this.menus, (cmd) => this.run(cmd), () => { document.body.classList.remove('show-mnemonics'); this.focusEditor(); });
    bar.append(h('div', { class: 'menubar-spacer' }), h('div', { class: 'menubar-right' }, h('a', { href: 'https://github.com/notepad-plus-plus/notepad-plus-plus', target: '_blank', rel: 'noopener', title: 'Notepad++ source code' }, 'WebAssembly build')));
  }
  editorContextMenu() {
    const I = (label, cmd, extra) => this.menuItem(label, cmd, extra);
    const hasSel = () => !this.send(SC.SCI_GETSELECTIONEMPTY);
    return [
      I('Cut', 'edit.cut', { enabled: hasSel }), I('Copy', 'edit.copy', { enabled: hasSel }), I('Paste', 'edit.paste'), I('Delete', 'edit.delete'),
      I('Select All', 'edit.selectAll'), '-', I('Begin/End Select', 'edit.beginEndSelect'), '-',
      { label: 'Style All Occurrences of Token', submenu: [1, 2, 3, 4, 5].map((i) => I(`Using ${['1st', '2nd', '3rd', '4th', '5th'][i - 1]} Style`, 'search.styleAll' + i)) },
      { label: 'Style One Token', submenu: [1, 2, 3, 4, 5].map((i) => I(`Using ${['1st', '2nd', '3rd', '4th', '5th'][i - 1]} Style`, 'search.styleOne' + i)) },
      { label: 'Clear Style', submenu: [...[1, 2, 3, 4, 5].map((i) => I(`Clear ${['1st', '2nd', '3rd', '4th', '5th'][i - 1]} Style`, 'search.clearStyle' + i)), I('Clear all Styles', 'search.clearAllStyles')] },
      '-', I('UPPERCASE', 'edit.upper', { enabled: hasSel }), I('lowercase', 'edit.lower', { enabled: hasSel }), '-',
      I('Search on Internet', 'edit.searchInternet'), '-',
      I('Toggle Single Line Comment', 'edit.commentToggle'), I('Block Comment', 'edit.blockComment'), I('Block Uncomment', 'edit.blockUncomment'), '-',
      I('Hide Lines', 'view.hideLines'),
    ];
  }
  tabMenu(b) {
    const I = (label, cmd, extra) => this.menuItem(label, cmd, extra);
    return [
      I('Close', 'file.close'), I('Close All BUT This', 'file.closeAllBut'), I('Close All to the Left', 'file.closeLeft'), I('Close All to the Right', 'file.closeRight'),
      I('Close All Unchanged', 'file.closeUnchanged'), '-', I('Save', 'file.save'), I('Save As...', 'file.saveAs'), I('Rename', 'file.rename'),
      I('Reload', 'file.reload', { enabled: () => !!b.handle }), I('Print', 'file.print'), '-',
      I('Copy Full File Path', 'edit.copyPath'), I('Copy Filename', 'edit.copyName'), '-',
      { label: 'Read-Only in Notepad++', cmd: 'edit.readOnly', checked: () => b.readOnly }, '-',
      I('Move to Start', null, { action: () => this.moveBuffer(b, 0) }), I('Move to End', null, { action: () => this.moveBuffer(b, this.buffers.length) }),
    ];
  }

  // ---------------------------------------------------------------- keyboard
  eventKeyString(e) {
    const ctrl = isMac ? e.metaKey : e.ctrlKey;
    let k = e.key;
    const code = e.code || '';
    if (code.startsWith('Key')) k = code.slice(3);
    else if (code.startsWith('Digit')) k = code.slice(5);
    else if (code === 'NumpadAdd') k = 'Num +';
    else if (code === 'NumpadSubtract') k = 'Num -';
    else if (code === 'NumpadDivide') k = 'Num /';
    else if (code === 'NumpadMultiply') k = 'Num *';
    else if (/^Numpad\d$/.test(code)) k = 'Num ' + code.slice(6);
    else if (code === 'Equal') k = '=';
    else if (code === 'Minus') k = '-';
    else {
      k = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', PageUp: 'PgUp', PageDown: 'PgDn', Delete: 'Del', Insert: 'Ins', Escape: 'Esc' }[k] || k;
      if (k.length === 1) k = k.toUpperCase();
    }
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(k)) return null;
    return (ctrl ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') + (e.shiftKey ? 'Shift+' : '') + k;
  }
  globalKey(e) {
    if (menuKeyDown(e)) return true;
    if (e.key === 'Alt') return false;
    const ks = this.eventKeyString(e);
    if (!ks) return false;
    // Alt+mnemonic opens a menu
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && /^[A-Z?]$/.test(ks.slice(4)) && this.menubar.openByMnemonic(ks.slice(4).toLowerCase())) return true;
    const cmd = this.keyMap.get(ks);
    if (!cmd) return false;
    // Keys Scintilla already implements identically are left to it while the editor has focus
    if (['edit.undo', 'edit.redo', 'edit.selectAll', 'edit.indent', 'edit.outdent', 'edit.delete', 'edit.duplicate', 'edit.moveUp', 'edit.moveDown', 'edit.cut', 'edit.copy', 'edit.paste'].includes(cmd) && e.target === this.view.input) return false;
    if (cmd === 'edit.wordCompletion' && this.send(SC.SCI_AUTOCACTIVE)) return false;
    this.run(cmd);
    return true;
  }

  // ================================================================ dialogs
  async gotoDialog() {
    const v = this.view;
    const lines = v.send(SC.SCI_GETLINECOUNT);
    const cur = v.send(SC.SCI_LINEFROMPOSITION, v.send(SC.SCI_GETCURRENTPOS)) + 1;
    let mode = 'line';
    const input = h('input', { class: 'txt', type: 'number', value: cur, min: 1, autofocus: true });
    const info = h('div', { class: 'note' });
    const upd = () => {
      info.textContent = mode === 'line' ? `You are here : ${cur}    You want to go to : (1 - ${fmt(lines)})` : `You are here : ${v.send(SC.SCI_GETCURRENTPOS)}    You want to go to : (0 - ${fmt(v.send(SC.SCI_GETLENGTH))})`;
    };
    const r1 = h('input', { type: 'radio', name: 'gotomode', checked: true }), r2 = h('input', { type: 'radio', name: 'gotomode' });
    r1.addEventListener('change', () => { mode = 'line'; input.value = cur; upd(); });
    r2.addEventListener('change', () => { mode = 'offset'; input.value = v.send(SC.SCI_GETCURRENTPOS); upd(); });
    upd();
    const d = new Dialog({
      title: 'Go To...', modal: true, width: 380,
      body: h('div', { class: 'prompt' }, h('div', { style: { display: 'flex', gap: '16px' } }, h('label', { class: 'chk' }, r1, ' Line'), h('label', { class: 'chk' }, r2, ' Offset')), info, input),
      buttons: [
        { label: 'Go', default: true, action: (dlg) => {
          const n = parseInt(input.value, 10);
          dlg.close();
          if (isNaN(n)) return;
          if (mode === 'line') {
            const l = Math.max(0, Math.min(lines - 1, n - 1));
            v.send(SC.SCI_ENSUREVISIBLE, l);
            v.send(SC.SCI_GOTOLINE, l);
            v.send(SC.SCI_SETFIRSTVISIBLELINE, Math.max(0, v.send(SC.SCI_VISIBLEFROMDOCLINE, l) - Math.floor(v.send(SC.SCI_LINESONSCREEN) / 2)));
          } else {
            v.send(SC.SCI_GOTOPOS, Math.max(0, Math.min(n, v.send(SC.SCI_GETLENGTH))));
          }
          this.focusEditor();
        } },
        { label: 'Cancel', cancel: true, action: (dlg) => { dlg.close(); this.focusEditor(); } },
      ],
    });
    d.show();
  }
  columnEditor() {
    const v = this.view;
    const textIn = h('input', { class: 'txt', autofocus: true });
    const rText = h('input', { type: 'radio', name: 'colmode', checked: true }), rNum = h('input', { type: 'radio', name: 'colmode' });
    const initial = h('input', { class: 'txt', type: 'number', value: 1 });
    const incr = h('input', { class: 'txt', type: 'number', value: 1 });
    const lead = h('select', { class: 'txt' }, h('option', { value: 'none' }, 'None'), h('option', { value: 'zeros' }, 'Zeros'), h('option', { value: 'spaces' }, 'Spaces'));
    const fmtSel = h('select', { class: 'txt' }, ...['Dec', 'Hex', 'Oct', 'Bin'].map((f) => h('option', { value: f }, f)));
    const body = h('div', { class: 'form-grid' },
      h('label', { class: 'chk span2' }, rText, ' Text to Insert'), h('span'), textIn,
      h('label', { class: 'chk span2' }, rNum, ' Number to Insert'),
      h('label', {}, 'Initial number :'), initial, h('label', {}, 'Increase by :'), incr, h('label', {}, 'Leading :'), lead, h('label', {}, 'Format :'), fmtSel);
    new Dialog({
      title: 'Column / Multi-Selection Editor', modal: true, body, width: 400,
      buttons: [
        { label: 'OK', default: true, action: (dlg) => {
          dlg.close();
          // determine target positions: each selection's caret, or the column of the caret down to the end of a rectangular block
          let targets = [];
          const n = v.send(SC.SCI_GETSELECTIONS);
          if (n > 1 || v.send(SC.SCI_SELECTIONISRECTANGLE)) {
            for (let i = 0; i < n; i++) targets.push(v.send(SC.SCI_GETSELECTIONNSTART, i));
          } else {
            const p = v.send(SC.SCI_GETCURRENTPOS);
            const col = v.send(SC.SCI_GETCOLUMN, p);
            const l0 = v.send(SC.SCI_LINEFROMPOSITION, p);
            const last = v.send(SC.SCI_GETLINECOUNT) - 1;
            for (let l = l0; l <= last; l++) targets.push({ line: l, col });
          }
          const values = targets.map((_, i) => {
            if (rText.checked) return textIn.value;
            const num = (+initial.value || 0) + i * (+incr.value || 0);
            const radix = { Dec: 10, Hex: 16, Oct: 8, Bin: 2 }[fmtSel.value];
            return num.toString(radix).toUpperCase();
          });
          if (!rText.checked && lead.value !== 'none') {
            const w = Math.max(...values.map((x) => x.length));
            for (let i = 0; i < values.length; i++) values[i] = values[i].padStart(w, lead.value === 'zeros' ? '0' : ' ');
          }
          v.send(SC.SCI_BEGINUNDOACTION);
          for (let i = targets.length - 1; i >= 0; i--) {
            let pos = targets[i];
            if (typeof pos === 'object') {
              const end = v.send(SC.SCI_GETLINEENDPOSITION, pos.line);
              pos = v.send(SC.SCI_FINDCOLUMN, pos.line, pos.col);
              const have = v.send(SC.SCI_GETCOLUMN, pos);
              if (have < targets[i].col && pos === end) { v.sendStr(SC.SCI_INSERTTEXT, pos, ' '.repeat(targets[i].col - have)); pos += targets[i].col - have; }
            }
            v.sendStr(SC.SCI_INSERTTEXT, pos, values[i]);
          }
          v.send(SC.SCI_ENDUNDOACTION);
          v.focus();
        } },
        { label: 'Cancel', cancel: true, action: (dlg) => dlg.close() },
      ],
    }).show();
  }
  summary() {
    const v = this.view, b = this.current;
    const text = v.getText();
    const words = (text.match(/[\p{L}\p{N}_]+/gu) || []).length;
    const chars = Array.from(text.replace(/\r\n|\r|\n/g, '')).length;
    const selChars = v.send(SC.SCI_COUNTCHARACTERS, v.send(SC.SCI_GETSELECTIONSTART), v.send(SC.SCI_GETSELECTIONEND));
    const lines = [
      `Full file path: ${b.path || b.name}`,
      b.lastModified ? `Modified: ${new Date(b.lastModified).toLocaleString()}` : null,
      '',
      `Characters (without line endings): ${fmt(chars)}`,
      `Words: ${fmt(words)}`,
      `Lines: ${fmt(v.send(SC.SCI_GETLINECOUNT))}`,
      `Document length: ${fmt(v.send(SC.SCI_GETLENGTH))}`,
      `${fmt(selChars)} selected characters (${fmt(v.send(SC.SCI_GETSELECTIONEND) - v.send(SC.SCI_GETSELECTIONSTART))} bytes) in ${fmt(v.send(SC.SCI_GETSELECTIONS))} ranges`,
    ].filter((x) => x !== null);
    messageBox('Summary', lines.join('\n'), ['OK']);
  }
  windowsDialog() {
    let sel = this.buffers.indexOf(this.current);
    const tbody = h('tbody');
    const render = () => {
      tbody.textContent = '';
      this.buffers.forEach((b, i) => {
        const tr = h('tr', { class: i === sel ? 'sel' : '' }, h('td', {}, (b.dirty ? '*' : '') + b.name), h('td', {}, b.path || ''), h('td', {}, this.config.displayName(b.lang)), h('td', {}, fmt(b.length || 0)));
        tr.addEventListener('click', () => { sel = i; render(); });
        tr.addEventListener('dblclick', () => { this.activate(b); d.close(); });
        tbody.append(tr);
      });
    };
    render();
    const d = new Dialog({
      title: 'Windows', modal: true,
      body: h('div', { class: 'doclist' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Path'), h('th', {}, 'Type'), h('th', {}, 'Size'))), tbody)),
      buttons: [
        { label: 'Activate', default: true, action: (dlg) => { const b = this.buffers[sel]; dlg.close(); this.activate(b); this.focusEditor(); } },
        { label: 'Save', action: async () => { await this.save(this.buffers[sel]); render(); } },
        { label: 'Close Window', action: async () => { await this.closeBuffer(this.buffers[sel]); sel = Math.min(sel, this.buffers.length - 1); render(); } },
        { label: 'OK', cancel: true, action: (dlg) => dlg.close() },
      ],
    });
    d.show();
  }
  preferences() {
    const s = { ...this.settings };
    const rows = [];
    const section = (t) => rows.push(h('h4', {}, t));
    const check = (key, label) => {
      const i = h('input', { type: 'checkbox' }); i.checked = !!s[key];
      i.addEventListener('change', () => { s[key] = i.checked; });
      rows.push(h('label', { class: 'chk span2' }, i, ' ' + label));
    };
    const num = (key, label, min, max) => {
      const i = h('input', { class: 'txt', type: 'number', min, max, value: s[key], style: { width: '80px' } });
      i.addEventListener('change', () => { s[key] = Math.max(min, Math.min(max, parseInt(i.value, 10) || 0)); });
      rows.push(h('label', {}, label), i);
    };
    const select = (key, label, opts) => {
      const i = h('select', { class: 'txt' }, ...opts.map(([v, t]) => h('option', { value: v, selected: s[key] === v }, t)));
      i.addEventListener('change', () => { s[key] = i.value; });
      rows.push(h('label', {}, label), i);
    };
    section('General');
    check('darkMode', 'Enable dark mode');
    check('rememberSession', 'Remember current session for next launch (keeps unsaved documents)');
    section('Editing');
    check('currentLine', 'Highlight current line');
    check('lineNumbers', 'Display line numbers');
    check('bookmarkMargin', 'Display bookmark margin');
    check('changeHistory', 'Display change history');
    check('multiEdit', 'Enable Multi-Editing (Ctrl+Mouse click/selection)');
    check('virtualSpace', 'Enable virtual space');
    check('scrollBeyondLast', 'Enable scrolling beyond last line');
    check('clickableLinks', 'Clickable links');
    num('caretWidth', 'Caret width', 1, 3);
    num('caretBlink', 'Caret blink rate (ms, 0 = off)', 0, 2000);
    num('edge', 'Vertical edge at column (0 = off)', 0, 500);
    section('Tab settings');
    num('tabSize', 'Tab size', 1, 16);
    check('useSpaces', 'Replace by space');
    section('New Document');
    select('defaultEol', 'Format (Line ending)', [['crlf', 'Windows (CR LF)'], ['lf', 'Unix (LF)'], ['cr', 'Macintosh (CR)']]);
    select('defaultEncoding', 'Encoding', Object.entries(ENCODINGS).map(([k, e]) => [k, e.label]));
    select('defaultLang', 'Default language', [['normal', 'Normal Text'], ...this.config.languages.filter((l) => this.config.langs.has(l.name) && l.name !== 'normal' && l.name !== 'searchResult').map((l) => [l.name, l.short]).sort((a, b) => a[1].localeCompare(b[1]))]);
    section('Auto-Completion');
    check('autoComplete', 'Enable auto-completion on each input (function and word completion)');
    num('autoCompleteFrom', 'From character', 1, 9);
    check('funcParamsHint', 'Function parameters hint on input');
    check('autoIndent', 'Auto-indent');
    section('Highlighting');
    check('smartHighlight', 'Enable smart highlighting');
    check('smartMatchCase', 'Smart highlighting: match case');
    check('smartWholeWord', 'Smart highlighting: match whole word only');
    check('braceHighlight', 'Highlight matching braces');
    new Dialog({
      title: 'Preferences', modal: true,
      body: h('div', { class: 'form-grid', style: { maxHeight: '65vh', overflow: 'auto', paddingRight: '8px' } }, ...rows),
      buttons: [
        { label: 'OK', default: true, action: async (dlg) => {
          dlg.close();
          const darkChanged = s.darkMode !== this.settings.darkMode;
          Object.assign(this.settings, s);
          this.saveSettings();
          if (darkChanged) await this.setDarkMode(s.darkMode, true);
          this.applyViewSettings();
          this.styleCurrent();
          this.renderTabs();
          this.updateToolbar();
          this.smartHighlight();
          this.highlightUrls();
        } },
        { label: 'Cancel', cancel: true, action: (dlg) => dlg.close() },
      ],
    }).show();
  }
  async setDarkMode(on, fromPrefs) {
    this.settings.darkMode = on;
    const theme = on ? 'DarkModeDefault.xml' : 'stylers.xml';
    if (this.config.themes.includes(theme) || theme === 'stylers.xml') {
      this.settings.theme = theme;
      await this.config.setTheme(theme);
    }
    this.saveSettings();
    this.applyTheme();
    if (!fromPrefs) this.focusEditor();
  }
  styleConfigurator() {
    const s = this.settings;
    const themeSel = h('select', { class: 'txt' }, h('option', { value: 'stylers.xml' }, 'Default (stylers.xml)'),
      ...this.config.themes.map((t) => h('option', { value: t, selected: s.theme === t }, t.replace(/\.xml$/i, ''))));
    const fontIn = h('input', { class: 'txt', value: s.fontName, placeholder: 'theme default (e.g. Courier New)', list: 'font-list' });
    const fonts = h('datalist', { id: 'font-list' }, ...['Courier New', 'Consolas', 'Cascadia Code', 'Cascadia Mono', 'Lucida Console', 'Menlo', 'Monaco', 'SF Mono', 'DejaVu Sans Mono', 'Liberation Mono', 'Ubuntu Mono', 'Fira Code', 'JetBrains Mono', 'Source Code Pro', 'monospace'].map((f) => h('option', { value: f })));
    const sizeIn = h('input', { class: 'txt', type: 'number', min: 0, max: 72, value: s.fontSize || '', placeholder: 'default', style: { width: '80px' } });
    const preview = async () => {
      s.theme = themeSel.value;
      s.fontName = fontIn.value.trim();
      s.fontSize = parseInt(sizeIn.value, 10) || 0;
      try { await this.config.setTheme(s.theme); } catch (e) { toast(e.message); }
      const darkTheme = /dark|obsidian|monokai|zenburn|deep black|twilight|vibrant|solarized$|blackboard|choco|hot fudge|mono industrial|plastic|ruby blue|vim dark|bespin/i.test(s.theme);
      if (s.theme === 'DarkModeDefault.xml') s.darkMode = true;
      else if (s.theme === 'stylers.xml') s.darkMode = false;
      else s.darkMode = darkTheme && s.darkMode ? true : s.darkMode;
      this.saveSettings();
      this.applyTheme();
    };
    themeSel.addEventListener('change', preview);
    new Dialog({
      title: 'Style Configurator', modal: false, width: 460,
      body: h('div', { class: 'form-grid' },
        h('label', {}, 'Select theme :'), themeSel,
        h('h4', {}, 'Global override'),
        h('label', {}, 'Font name :'), fontIn, fonts,
        h('label', {}, 'Font size :'), sizeIn,
        h('div', { class: 'span2 note', style: { color: 'var(--text-dim)', lineHeight: '1.4' } },
          `Themes are Notepad++'s own theme files (${this.config.themes.length} included). The global font applies to every style; leave it empty to use the theme's fonts.`)),
      buttons: [
        { label: 'Save & Close', default: true, action: async (dlg) => { await preview(); dlg.close(); this.focusEditor(); } },
        { label: 'Apply', action: () => preview() },
        { label: 'Cancel', cancel: true, action: (dlg) => dlg.close() },
      ],
    }).show();
  }
  shortcutMapper() {
    const rows = [];
    const walk = (items, path) => {
      for (const it of (typeof items === 'function' ? items() : items)) {
        if (it === '-' || !it) continue;
        const label = (typeof it.label === 'function' ? it.label() : it.label).replace(/&(.)/g, '$1');
        if (it.submenu) { walk(it.submenu, path + label + ' > '); continue; }
        if (it.key) rows.push([path + label, it.key]);
      }
    };
    for (const m of this.menus) if (m.label !== '&Language' && m.label !== '&Window') walk(m.items, m.label.replace('&', '') + ' > ');
    const extra = Object.entries(this.extraKeys).map(([k, c]) => [`(extra) ${c}`, isMac ? k.replace(/Ctrl\+/g, 'Cmd+') : k]);
    const tbl = h('table', {}, ...[...rows, ...extra].map(([a, b]) => h('tr', {}, h('td', {}, a), h('td', {}, b))));
    new Dialog({
      title: 'Shortcut Mapper', modal: true,
      body: h('div', {}, h('div', { class: 'shortcut-table' }, tbl),
        h('p', { style: { color: 'var(--text-dim)', maxWidth: '520px' } }, 'In a normal browser tab some shortcuts (Ctrl+N, Ctrl+W, Ctrl+T, Ctrl+Tab) are reserved by the browser. Use the alternatives above, or install the page as an app to get them back.')),
      buttons: [{ label: 'Close', default: true, cancel: true, action: (d) => d.close() }],
    }).show();
  }
  about() {
    new Dialog({
      title: 'About Notepad++', modal: true,
      body: h('div', { class: 'about' }, h('img', { src: 'img/chameleon.png', alt: '' }),
        h('div', {},
          h('h2', {}, `Notepad++ v${VERSION}`),
          h('p', {}, 'Notepad++\'s editing engine, ', h('b', {}, `Scintilla ${BUILD.scintilla}`), ' and ', h('b', {}, `Lexilla ${BUILD.lexilla}`), ' (with all ', String(this.M._lexilla_count()), ' lexers, including Notepad++\'s own), compiled from the Notepad++ source tree to WebAssembly and drawn on an HTML canvas.'),
          h('p', {}, 'Languages, styles and the ', String(this.config.themes.length), ' themes come straight from Notepad++\'s langs.model.xml, stylers.model.xml and themes folder; icons are Notepad++\'s own.'),
          h('p', {}, 'Notepad++ is © Don Ho and contributors: ', h('a', { href: 'https://notepad-plus-plus.org/', target: '_blank', rel: 'noopener' }, 'notepad-plus-plus.org'),
            '. This is an unofficial port, not affiliated with the Notepad++ project.'),
          h('pre', {}, 'This program is free software; you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation; either version 3 of the License, or (at your option) any later version.\n\nScintilla and Lexilla are © Neil Hodgson, under the Historical Permission Notice and Disclaimer licence.'),
          h('p', {}, h('a', { href: 'LICENSE.txt', target: '_blank' }, 'GNU GPL v3 licence text')))),
      buttons: [{ label: 'OK', default: true, cancel: true, action: (d) => d.close() }],
    }).show();
  }
  debugInfo() {
    const info = [
      `Notepad++ v${VERSION}`,
      `Scintilla ${BUILD.scintilla}, Lexilla ${BUILD.lexilla} (${this.M._lexilla_count()} lexers)`,
      `Source commit: ${BUILD.commit || 'unknown'}`,
      `Browser: ${navigator.userAgent}`,
      `Device pixel ratio: ${window.devicePixelRatio}`,
      `File System Access API: ${'showOpenFilePicker' in window ? 'yes' : 'no (download/upload fallback)'}`,
      `Theme: ${this.config.themeName}`,
      `Wasm memory: ${(this.M.HEAPU8.length / 1048576).toFixed(1)} MB`,
      `Documents open: ${this.buffers.length}`,
    ].join('\n');
    const ta = h('textarea', { class: 'txt', readonly: true, style: { width: '560px', height: '180px', fontFamily: 'monospace', padding: '6px' } }, info);
    new Dialog({ title: 'Debug Info', modal: true, body: ta, buttons: [
      { label: 'Copy debug info into clipboard', action: () => navigator.clipboard.writeText(info) },
      { label: 'OK', default: true, cancel: true, action: (d) => d.close() },
    ] }).show();
  }
  async exitApp() {
    if (await this.closeMany(this.buffers.slice())) {
      toast('All documents closed. You can close this browser tab.');
    }
  }
  saveSettings() { store.saveSettings(this.settings); }

  // ================================================================ events
  bindEvents() {
    const v = this.view;
    v.on('notify', (n) => this.onNotify(n));
    v.onKeyDown = (e) => this.globalKey(e);
    v.on('contextmenu', (e) => showPopupMenu(this.editorContextMenu(), e.clientX, e.clientY, (cmd) => this.run(cmd)));
    v.on('clipboard-denied', () => toast(`Clipboard access was denied. Use ${CTRL}+V to paste.`));
    v.on('zoom', () => this.updateLineNumberWidth(true));
    v.on('drop', (e) => this.onDrop(e));

    let altAlone = false;
    document.addEventListener('keydown', (e) => {
      altAlone = e.key === 'Alt' && !e.ctrlKey && !e.shiftKey && !e.metaKey;
      if (e.target === v.input || e.target === this.results.view.input) return; // handled by the views
      if (e.target.closest && e.target.closest('.dlg')) { if (menuKeyDown(e)) e.preventDefault(); return; }
      if (this.globalKey(e)) e.preventDefault();
    });
    document.addEventListener('keyup', (e) => {
      if (e.key === 'Alt' && altAlone) {
        altAlone = false;
        e.preventDefault();
        document.body.classList.add('show-mnemonics');
        this.menubar.enterFocusMode();
      } else if (e.key !== 'Alt') {
        altAlone = false;
      }
    });
    document.addEventListener('mousedown', () => { altAlone = false; });

    // status bar shortcuts
    document.getElementById('sb-eol').addEventListener('click', (e) => showPopupMenu([
      { label: 'Windows (CR LF)', cmd: 'edit.eolCrlf', checked: () => this.current.eol === 'crlf', radio: true },
      { label: 'Unix (LF)', cmd: 'edit.eolLf', checked: () => this.current.eol === 'lf', radio: true },
      { label: 'Macintosh (CR)', cmd: 'edit.eolCr', checked: () => this.current.eol === 'cr', radio: true },
    ], e.clientX, e.clientY - 90, (c) => this.run(c)));
    document.getElementById('sb-enc').addEventListener('click', (e) => {
      const items = this.menus.find((m) => m.label === 'E&ncoding').items();
      showPopupMenu(items, e.clientX, e.clientY - 280, (c) => this.run(c));
    });
    document.getElementById('sb-pos').addEventListener('click', () => this.run('search.goto'));
    document.getElementById('sb-ins').addEventListener('click', () => { this.send(SC.SCI_EDITTOGGLEOVERTYPE); this.updateStatus(); v.focus(); });
    document.getElementById('sb-lang').addEventListener('click', (e) => {
      const items = this.menus.find((m) => m.label === '&Language').items();
      showPopupMenu(items, e.clientX, e.clientY - 400, (c) => this.run(c));
    });

    // results panel resize
    const head = document.querySelector('#results-panel .panel-head');
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.panel-close')) return;
      e.preventDefault();
      const panel = document.getElementById('results-panel');
      const startY = e.clientY, startH = panel.getBoundingClientRect().height;
      const move = (ev) => { panel.style.height = Math.max(80, Math.min(window.innerHeight - 200, startH - (ev.clientY - startY))) + 'px'; this.layoutChanged(); };
      const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    });

    // drag & drop files anywhere
    window.addEventListener('dragover', (e) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) { e.preventDefault(); document.body.classList.add('dropping'); }
    });
    window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
    window.addEventListener('drop', (e) => this.onDrop(e));

    window.addEventListener('pagehide', () => this.saveSession());
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.saveSession(); });
    window.addEventListener('beforeunload', (e) => {
      if (!this.settings.rememberSession && this.buffers.some((b) => b.dirty)) { e.preventDefault(); e.returnValue = ''; }
    });
    document.addEventListener('fullscreenchange', () => this.layoutChanged());
  }
  async onDrop(e) {
    document.body.classList.remove('dropping');
    const dt = e.dataTransfer;
    if (!dt || !Array.from(dt.types).includes('Files')) return;
    e.preventDefault();
    const items = Array.from(dt.items || []);
    const handlesP = items.filter((i) => i.kind === 'file').map((i) => (i.getAsFileSystemHandle ? i.getAsFileSystemHandle().catch(() => null) : Promise.resolve(null)));
    const files = Array.from(dt.files);
    const handles = await Promise.all(handlesP);
    for (let i = 0; i < files.length; i++) {
      const hd = handles[i];
      if (hd && hd.kind === 'file') await this.openHandle(hd);
      else if (!hd || hd.kind !== 'directory') await this.openFile(files[i], null);
    }
  }
  handleLaunchQueue() {
    if ('launchQueue' in window) {
      window.launchQueue.setConsumer(async (params) => {
        for (const hd of params.files || []) await this.openHandle(hd);
      });
    }
  }
  handleUrlParams() {
    const p = new URLSearchParams(location.search);
    if (p.has('text')) {
      this.newFile(p.get('text'), p.get('lang') || undefined);
    }
  }
}

const app = new App();
window.npp = app;
app.init().catch((e) => {
  console.error(e);
  const boot = document.getElementById('boot');
  boot.classList.add('error');
  document.getElementById('boot-text').textContent = 'Notepad++ could not start:\n' + (e && e.message ? e.message : e);
});

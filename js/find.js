// find.js - Find / Replace / Mark dialog, search engine and the
// "Search results" panel (rendered by Notepad++'s own searchResult lexer).

import { SC } from './sci-consts.js';
import { h, Dialog } from './ui.js';

const enc = new TextEncoder();

export function extendedToString(s) {
  // Notepad++ "Extended" mode: \n \r \t \0 \\ \xHH \uHHHH \oOOO \dDDD \bBBBBBBBB
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\' || i + 1 >= s.length) { out += c; continue; }
    const n = s[++i];
    const take = (len, re, radix) => {
      const part = s.substr(i + 1, len);
      if (part.length === len && re.test(part)) { i += len; return String.fromCodePoint(parseInt(part, radix)); }
      return null;
    };
    let r = null;
    switch (n) {
      case 'n': r = '\n'; break;
      case 'r': r = '\r'; break;
      case 't': r = '\t'; break;
      case '0': r = '\0'; break;
      case '\\': r = '\\'; break;
      case 'x': r = take(2, /^[0-9a-f]{2}$/i, 16); break;
      case 'u': r = take(4, /^[0-9a-f]{4}$/i, 16); break;
      case 'o': r = take(3, /^[0-7]{3}$/, 8); break;
      case 'd': r = take(3, /^[0-9]{3}$/, 10); break;
      case 'b': r = take(8, /^[01]{8}$/, 2); break;
      default: r = null;
    }
    out += r === null ? '\\' + n : r;
  }
  return out;
}

// "." matches newline: rewrite unescaped dots outside character classes
function dotAll(re) {
  let out = '', inClass = false;
  for (let i = 0; i < re.length; i++) {
    const c = re[i];
    if (c === '\\') { out += c + (re[i + 1] || ''); i++; continue; }
    if (inClass) { if (c === ']') inClass = false; out += c; continue; }
    if (c === '[') { inClass = true; out += c; continue; }
    out += c === '.' ? '[\\s\\S]' : c;
  }
  return out;
}

export class SearchEngine {
  // opts: {text, mode: 'normal'|'extended'|'regex', matchCase, wholeWord, dotNewline}
  static prepare(opts) {
    let text = opts.text;
    let flags = 0;
    if (opts.matchCase) flags |= SC.SCFIND_MATCHCASE;
    if (opts.wholeWord && opts.mode !== 'regex') flags |= SC.SCFIND_WHOLEWORD;
    if (opts.mode === 'extended') text = extendedToString(text);
    if (opts.mode === 'regex') {
      flags |= SC.SCFIND_REGEXP | SC.SCFIND_CXX11REGEX;
      if (opts.dotNewline) text = dotAll(text);
    }
    return { text, flags, regex: opts.mode === 'regex' };
  }
  static replacement(opts, rep) {
    if (opts.mode === 'extended') return extendedToString(rep);
    if (opts.mode === 'regex') {
      // Notepad++ (boost) uses $1 / \1; Scintilla's C++11 regex uses \1
      return rep.replace(/\$(\d)/g, '\\$1');
    }
    return rep;
  }
  // returns {start, end} or null; -2 on regex error
  static searchRange(view, prepared, from, to) {
    view.send(SC.SCI_SETSEARCHFLAGS, prepared.flags);
    view.send(SC.SCI_SETTARGETRANGE, from, to);
    const r = view._withStr(prepared.text, (p, n) => view.send(SC.SCI_SEARCHINTARGET, n, p));
    if (r === -2 || view.send(SC.SCI_GETSTATUS) === 1001) { view.send(SC.SCI_SETSTATUS, 0); return { error: true }; }
    if (r < 0) return null;
    return { start: view.send(SC.SCI_GETTARGETSTART), end: view.send(SC.SCI_GETTARGETEND) };
  }
  static findAll(view, prepared, limit = 1e6) {
    const out = [];
    const len = view.send(SC.SCI_GETLENGTH);
    let pos = 0;
    view.send(SC.SCI_SETSEARCHFLAGS, prepared.flags);
    const bytes = enc.encode(prepared.text);
    if (!bytes.length) return out;
    const M = view.M;
    const p = M._malloc(bytes.length + 1);
    M.HEAPU8.set(bytes, p);
    M.HEAPU8[p + bytes.length] = 0;
    try {
      while (pos <= len && out.length < limit) {
        view.send(SC.SCI_SETTARGETRANGE, pos, len);
        const r = view.send(SC.SCI_SEARCHINTARGET, bytes.length, p);
        if (r === -2 || view.send(SC.SCI_GETSTATUS) === 1001) { view.send(SC.SCI_SETSTATUS, 0); out.error = true; break; }
        if (r < 0) break;
        const s = view.send(SC.SCI_GETTARGETSTART), e = view.send(SC.SCI_GETTARGETEND);
        out.push({ start: s, end: e });
        pos = e > s ? e : view.send(SC.SCI_POSITIONAFTER, e);
        if (e === len && e === s) break;
      }
    } finally { M._free(p); }
    return out;
  }
  static replaceAll(view, prepared, replacement, from = 0, to = -1) {
    let count = 0;
    let len = view.send(SC.SCI_GETLENGTH);
    let end = to < 0 ? len : to;
    let pos = from;
    const M = view.M;
    const pb = enc.encode(prepared.text), rb = enc.encode(replacement);
    if (!pb.length) return 0;
    const p = M._malloc(pb.length + 1), r = M._malloc(rb.length + 1);
    M.HEAPU8.set(pb, p); M.HEAPU8[p + pb.length] = 0;
    M.HEAPU8.set(rb, r); M.HEAPU8[r + rb.length] = 0;
    view.send(SC.SCI_SETSEARCHFLAGS, prepared.flags);
    view.send(SC.SCI_BEGINUNDOACTION);
    try {
      while (pos <= end) {
        view.send(SC.SCI_SETTARGETRANGE, pos, end);
        const found = view.send(SC.SCI_SEARCHINTARGET, pb.length, p);
        if (found === -2 || view.send(SC.SCI_GETSTATUS) === 1001) { view.send(SC.SCI_SETSTATUS, 0); count = -1; break; }
        if (found < 0) break;
        const s = view.send(SC.SCI_GETTARGETSTART), e = view.send(SC.SCI_GETTARGETEND);
        const newLen = view.send(prepared.regex ? SC.SCI_REPLACETARGETRE : SC.SCI_REPLACETARGET, rb.length, r);
        count++;
        const delta = newLen - (e - s);
        end += delta;
        len += delta;
        pos = s + newLen;
        if (e === s) {
          if (pos >= len) break;
          pos = view.send(SC.SCI_POSITIONAFTER, pos);
        }
      }
    } finally {
      view.send(SC.SCI_ENDUNDOACTION);
      M._free(p); M._free(r);
    }
    return count;
  }
}

const ordinal = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');

export class FindReplace {
  constructor(app) {
    this.app = app;
    this.history = [];
    this.replaceHistory = [];
    this.opts = { text: '', replace: '', mode: 'normal', matchCase: false, wholeWord: false, wrap: true, backward: false, dotNewline: false, bookmark: false, purge: false, inSelection: false };
    this.dialog = null;
  }

  get view() { return this.app.view; }

  // ---------------------------------------------------------------- dialog
  show(tab = 'find') {
    const sel = this.view.getSelText();
    if (sel && !sel.includes('\n') && sel.length < 512) this.opts.text = sel;
    if (!this.dialog) this.build();
    this.switchTab(tab);
    this.findInput.value = this.opts.text;
    if (!this.dialog.open) {
      const r = document.getElementById('editor-area').getBoundingClientRect();
      this.dialog.show({ x: r.right - 620, y: r.top + 30 });
    } else {
      this.dialog.raise();
    }
    this.setStatus('');
    setTimeout(() => { this.findInput.focus(); this.findInput.select(); }, 0);
  }
  build() {
    const o = this.opts;
    const chk = (key, label, extra = {}) => {
      const input = h('input', { type: 'checkbox' });
      input.checked = !!o[key];
      input.addEventListener('change', () => { o[key] = input.checked; this.syncState(); });
      const el = h('label', { class: 'chk', ...extra }, input, ' ' + label);
      el.input = input;
      return el;
    };
    const radio = (value, label) => {
      const input = h('input', { type: 'radio', name: 'findmode', value });
      input.checked = o.mode === value;
      input.addEventListener('change', () => { if (input.checked) { o.mode = value; this.syncState(); } });
      return h('label', { class: 'chk' }, input, ' ' + label);
    };
    this.findList = h('datalist', { id: 'find-history' });
    this.replList = h('datalist', { id: 'replace-history' });
    this.findInput = h('input', { class: 'txt', list: 'find-history', spellcheck: 'false' });
    this.findInput.addEventListener('input', () => { o.text = this.findInput.value; });
    this.replaceInput = h('input', { class: 'txt', list: 'replace-history', spellcheck: 'false' });
    this.replaceInput.addEventListener('input', () => { o.replace = this.replaceInput.value; });

    this.tabs = {};
    const tabBar = h('div', { class: 'fr-tabs' });
    for (const [key, label] of [['find', 'Find'], ['replace', 'Replace'], ['mark', 'Mark']]) {
      const t = h('div', { class: 'fr-tab', onclick: () => this.switchTab(key) }, label);
      this.tabs[key] = t;
      tabBar.append(t);
    }
    this.replaceRow = h('div', { class: 'fr-row' }, h('label', { class: 'fr-label' }, 'Replace with :'), this.replaceInput);
    this.chkInSel = chk('inSelection', 'In selection');
    this.chkBackward = chk('backward', 'Backward direction');
    this.chkWhole = chk('wholeWord', 'Match whole word only');
    this.chkCase = chk('matchCase', 'Match case');
    this.chkWrap = chk('wrap', 'Wrap around');
    this.chkBookmark = chk('bookmark', 'Bookmark line');
    this.chkPurge = chk('purge', 'Purge for each search');
    this.chkDot = chk('dotNewline', '. matches newline');

    const btn = (label, fn, cls = '') => h('button', { class: 'btn ' + cls, onclick: fn }, label);
    this.buttons = {
      findNext: btn('Find Next', () => this.findNext(o.backward ? -1 : 1), 'default'),
      count: btn('Count', () => this.count()),
      findAllAll: btn('Find All in All Opened Documents', () => this.findAll(true)),
      findAllCur: btn('Find All in Current Document', () => this.findAll(false)),
      replace: btn('Replace', () => this.replaceOne()),
      replaceAll: btn('Replace All', () => this.replaceAll(false)),
      replaceAllAll: btn('Replace All in All Opened Documents', () => this.replaceAll(true)),
      markAll: btn('Mark All', () => this.markAll()),
      clearMarks: btn('Clear all marks', () => this.clearMarks()),
      copyMarked: btn('Copy Marked Text', () => this.copyMarked()),
      close: btn('Close', () => this.dialog.close()),
    };
    this.status = h('div', { class: 'fr-status' });

    const left = h('div', { class: 'fr-left' },
      h('div', { class: 'fr-row' }, h('label', { class: 'fr-label' }, 'Find what :'), this.findInput),
      this.replaceRow,
      h('div', { class: 'fr-row fr-insel' }, this.chkInSel),
      h('div', { class: 'fr-opts' },
        h('div', { class: 'fr-col' }, this.chkBookmark, this.chkPurge, this.chkBackward, this.chkWhole, this.chkCase, this.chkWrap),
      ),
      h('fieldset', { class: 'fr-mode' }, h('legend', {}, 'Search Mode'),
        radio('normal', 'Normal'),
        radio('extended', 'Extended (\\n, \\r, \\t, \\0, \\x...)'),
        h('div', { class: 'fr-regex' }, radio('regex', 'Regular expression'), this.chkDot)),
    );
    const right = h('div', { class: 'fr-right' }, ...Object.values(this.buttons));
    const body = h('div', { class: 'fr' }, tabBar, h('div', { class: 'fr-main' }, left, right), this.status, this.findList, this.replList);
    this.dialog = new Dialog({ title: 'Find', body, className: 'find-dlg', width: 640 });
    this.dialog.el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.target === this.findInput || e.target === this.replaceInput)) {
        e.preventDefault();
        if (this.tab === 'mark') this.markAll();
        else this.findNext(e.shiftKey ? -1 : (o.backward ? -1 : 1));
      } else if (e.key === 'F3') {
        e.preventDefault();
        this.findNext(e.shiftKey ? -1 : 1);
      }
    });
  }
  syncState() {
    this.chkWhole.input.disabled = this.opts.mode === 'regex';
    this.chkDot.input.disabled = this.opts.mode !== 'regex';
  }
  switchTab(tab) {
    this.tab = tab;
    for (const [k, t] of Object.entries(this.tabs)) t.classList.toggle('active', k === tab);
    const title = { find: 'Find', replace: 'Replace', mark: 'Mark' }[tab];
    this.dialog.titleEl.firstChild.textContent = title;
    const show = (el, on) => { el.style.display = on ? '' : 'none'; };
    show(this.replaceRow, tab === 'replace');
    show(this.chkBookmark, tab === 'mark');
    show(this.chkPurge, tab === 'mark');
    show(this.chkBackward, tab !== 'mark');
    show(this.chkInSel.parentNode, tab !== 'find');
    const b = this.buttons;
    const vis = {
      find: ['findNext', 'count', 'findAllAll', 'findAllCur', 'close'],
      replace: ['findNext', 'replace', 'replaceAll', 'replaceAllAll', 'close'],
      mark: ['markAll', 'clearMarks', 'copyMarked', 'close'],
    }[tab];
    for (const [k, el] of Object.entries(b)) show(el, vis.includes(k));
    b.findNext.classList.toggle('default', tab !== 'mark');
    b.markAll.classList.toggle('default', tab === 'mark');
    this.syncState();
  }
  setStatus(text, kind = 'msg') {
    if (!this.status) return;
    this.status.textContent = text;
    this.status.className = 'fr-status ' + kind;
    if (text && (!this.dialog || !this.dialog.open)) this.app.flash(text);
  }
  remember() {
    const t = this.opts.text;
    if (!t) return;
    this.history = [t, ...this.history.filter((x) => x !== t)].slice(0, 20);
    if (this.findList) {
      this.findList.textContent = '';
      for (const x of this.history) this.findList.append(h('option', { value: x }));
    }
    if (this.opts.replace && this.replList) {
      this.replaceHistory = [this.opts.replace, ...this.replaceHistory.filter((x) => x !== this.opts.replace)].slice(0, 20);
      this.replList.textContent = '';
      for (const x of this.replaceHistory) this.replList.append(h('option', { value: x }));
    }
  }
  prepared() {
    if (this.findInput) this.opts.text = this.findInput.value;
    if (this.replaceInput) this.opts.replace = this.replaceInput.value;
    return SearchEngine.prepare(this.opts);
  }
  modeLabel() {
    return { normal: 'Normal', extended: 'Extended', regex: 'Regular expression' }[this.opts.mode];
  }

  // ---------------------------------------------------------------- operations
  select(view, r) {
    const line = view.send(SC.SCI_LINEFROMPOSITION, r.start);
    view.send(SC.SCI_ENSUREVISIBLE, line);
    view.send(SC.SCI_SETSEL, r.start, r.end);
    view.send(SC.SCI_SCROLLRANGE, r.end, r.start);
  }
  findNext(dir = 1, quiet = false) {
    const v = this.view;
    const p = this.prepared();
    if (!p.text) return false;
    this.remember();
    const len = v.send(SC.SCI_GETLENGTH);
    const selStart = v.send(SC.SCI_GETSELECTIONSTART), selEnd = v.send(SC.SCI_GETSELECTIONEND);
    let r;
    if (dir > 0) {
      r = SearchEngine.searchRange(v, p, selEnd, len);
      if (r && !r.error && r.start === r.end && r.start === selEnd && selStart === selEnd && selEnd < len) {
        r = SearchEngine.searchRange(v, p, v.send(SC.SCI_POSITIONAFTER, selEnd), len);
      }
    } else {
      r = SearchEngine.searchRange(v, p, selStart, 0);
    }
    if (r && r.error) { this.setStatus('Find: Invalid regular expression', 'err'); return false; }
    let wrapped = false;
    if (!r && this.opts.wrap) {
      r = dir > 0 ? SearchEngine.searchRange(v, p, 0, len) : SearchEngine.searchRange(v, p, len, 0);
      wrapped = !!r;
    }
    if (!r) {
      this.setStatus(`Find: Can't find the text "${this.opts.text}"`, 'err');
      if (!quiet) this.app.beep();
      return false;
    }
    this.select(v, r);
    if (wrapped) {
      this.setStatus(dir > 0
        ? 'Find: Found the 1st occurrence from the top. The end of the document has been reached.'
        : 'Find: Found the 1st occurrence from the bottom. The beginning of the document has been reached.', 'wrap');
    } else {
      this.setStatus('');
    }
    return true;
  }
  count() {
    const p = this.prepared();
    if (!p.text) return;
    this.remember();
    const list = this.rangeLimited(SearchEngine.findAll(this.view, p));
    if (list.error) { this.setStatus('Count: Invalid regular expression', 'err'); return; }
    this.setStatus(`Count: ${list.length} match${list.length === 1 ? '' : 'es'}${this.inSel() ? ' in selection' : ' in entire file'}`, 'msg');
  }
  inSel() {
    return this.tab !== 'find' && this.opts.inSelection && !this.view.send(SC.SCI_GETSELECTIONEMPTY);
  }
  rangeLimited(list) {
    if (!this.inSel()) return list;
    const s = this.view.send(SC.SCI_GETSELECTIONSTART), e = this.view.send(SC.SCI_GETSELECTIONEND);
    const out = list.filter((r) => r.start >= s && r.end <= e);
    out.error = list.error;
    return out;
  }
  replaceOne() {
    const v = this.view;
    const p = this.prepared();
    if (!p.text) return;
    this.remember();
    const rep = SearchEngine.replacement(this.opts, this.opts.replace);
    const s = v.send(SC.SCI_GETSELECTIONSTART), e = v.send(SC.SCI_GETSELECTIONEND);
    // Is the current selection a match? Then replace it.
    const r = SearchEngine.searchRange(v, p, s, e);
    if (r && !r.error && r.start === s && r.end === e) {
      v.send(SC.SCI_SETTARGETRANGE, s, e);
      const newLen = v._withStr(rep, (ptr, n) => v.send(p.regex ? SC.SCI_REPLACETARGETRE : SC.SCI_REPLACETARGET, n, ptr));
      v.send(SC.SCI_SETSEL, s + newLen, s + newLen);
    }
    const found = this.findNext(this.opts.backward ? -1 : 1, true);
    if (!found) this.setStatus('Replace: no more occurrence found.', 'err');
    else if (r && r.start === s && r.end === e) this.setStatus('Replace: 1 occurrence was replaced. The next occurrence found.', 'msg');
  }
  replaceAll(allDocs) {
    const p = this.prepared();
    if (!p.text) return;
    this.remember();
    const rep = SearchEngine.replacement(this.opts, this.opts.replace);
    if (!allDocs) {
      const v = this.view;
      let from = 0, to = -1;
      if (this.inSel()) { from = v.send(SC.SCI_GETSELECTIONSTART); to = v.send(SC.SCI_GETSELECTIONEND); }
      const n = SearchEngine.replaceAll(v, p, rep, from, to);
      if (n < 0) { this.setStatus('Replace All: Invalid regular expression', 'err'); return; }
      this.setStatus(`Replace All: ${n} occurrence${n === 1 ? ' was' : 's were'} replaced in ${this.inSel() ? 'selected text' : 'entire file'}.`, n ? 'msg' : 'err');
      return;
    }
    let total = 0, files = 0;
    this.app.forEachBufferInView((buf, v) => {
      if (buf.readOnly) return;
      const n = SearchEngine.replaceAll(v, p, rep);
      if (n > 0) { total += n; files++; }
    });
    this.setStatus(`Replace in Opened Files: ${total} occurrence${total === 1 ? ' was' : 's were'} replaced in ${files} document${files === 1 ? '' : 's'}.`, total ? 'msg' : 'err');
    this.app.refreshAll();
  }
  markAll() {
    const v = this.view;
    const p = this.prepared();
    if (!p.text) return;
    this.remember();
    if (this.opts.purge) this.clearMarks(true);
    const list = this.rangeLimited(SearchEngine.findAll(v, p));
    if (list.error) { this.setStatus('Mark: Invalid regular expression', 'err'); return; }
    v.send(SC.SCI_SETINDICATORCURRENT, SC.SCE_UNIVERSAL_FOUND_STYLE);
    for (const r of list) {
      if (r.end > r.start) v.send(SC.SCI_INDICATORFILLRANGE, r.start, r.end - r.start);
      if (this.opts.bookmark) this.app.addBookmark(v.send(SC.SCI_LINEFROMPOSITION, r.start));
    }
    this.setStatus(`Mark: ${list.length} match${list.length === 1 ? '' : 'es'}${this.inSel() ? ' in selection' : ' in entire file'}`, list.length ? 'msg' : 'err');
  }
  clearMarks(silent) {
    const v = this.view;
    v.send(SC.SCI_SETINDICATORCURRENT, SC.SCE_UNIVERSAL_FOUND_STYLE);
    v.send(SC.SCI_INDICATORCLEARRANGE, 0, v.send(SC.SCI_GETLENGTH));
    if (this.opts.bookmark || !silent) {
      if (this.opts.bookmark) this.app.clearBookmarks();
    }
    if (!silent) this.setStatus('');
  }
  copyMarked() {
    const v = this.view;
    const ind = SC.SCE_UNIVERSAL_FOUND_STYLE;
    const len = v.send(SC.SCI_GETLENGTH);
    const parts = [];
    let pos = 0;
    while (pos < len) {
      const start = v.send(SC.SCI_INDICATORVALUEAT, ind, pos) ? pos : v.send(SC.SCI_INDICATOREND, ind, pos);
      if (start >= len || start <= pos && !v.send(SC.SCI_INDICATORVALUEAT, ind, start)) break;
      const end = v.send(SC.SCI_INDICATOREND, ind, start);
      if (end <= start) break;
      parts.push(v.getRange(start, end));
      pos = end;
    }
    if (!parts.length) { this.setStatus('Copy Marked Text: no marked text', 'err'); return; }
    navigator.clipboard.writeText(parts.join(this.app.eolString())).catch(() => {});
    this.setStatus(`Copy Marked Text: ${parts.length} marked text${parts.length === 1 ? '' : 's'} copied`, 'msg');
  }
  findAll(allDocs) {
    const p = this.prepared();
    if (!p.text) return;
    this.remember();
    const groups = [];
    let error = false;
    const collect = (buf, v) => {
      const list = SearchEngine.findAll(v, p, 100000);
      if (list.error) { error = true; return; }
      if (!list.length) return;
      const hits = [];
      let lastLine = -1;
      for (const r of list) {
        const line = v.send(SC.SCI_LINEFROMPOSITION, r.start);
        const ls = v.send(SC.SCI_POSITIONFROMLINE, line);
        const le = v.send(SC.SCI_GETLINEENDPOSITION, line);
        if (line === lastLine) {
          hits[hits.length - 1].segs.push([r.start - ls, Math.min(r.end, le) - ls]);
          continue;
        }
        lastLine = line;
        const cap = Math.min(le, ls + 1024);
        hits.push({ line, lineStart: ls, text: v.getRange(ls, cap), segs: [[r.start - ls, Math.min(r.end, cap) - ls]], pos: r.start, end: r.end });
      }
      groups.push({ buf, hits, count: list.length });
    };
    if (allDocs) this.app.forEachBufferInView(collect);
    else collect(this.app.current, this.view);
    if (error) { this.setStatus('Find: Invalid regular expression', 'err'); return; }
    const total = groups.reduce((a, g) => a + g.count, 0);
    const searched = allDocs ? this.app.buffers.length : 1;
    this.app.results.show(this.opts.text, groups, total, searched, this.modeLabel());
    this.setStatus(total ? '' : `Find: Can't find the text "${this.opts.text}"`, total ? 'msg' : 'err');
    if (total && this.dialog && this.dialog.open && allDocs) this.dialog.close();
  }

  // quick actions from menu / keyboard
  findNextQuick(dir) {
    if (!this.opts.text) { this.show('find'); return; }
    this.findNext(dir);
  }
  selectAndFind(dir) {
    const v = this.view;
    let s = v.send(SC.SCI_GETSELECTIONSTART), e = v.send(SC.SCI_GETSELECTIONEND);
    if (s === e) {
      s = v.send(SC.SCI_WORDSTARTPOSITION, s, 1);
      e = v.send(SC.SCI_WORDENDPOSITION, e, 1);
      if (s === e) return;
      v.send(SC.SCI_SETSEL, s, e);
    }
    this.opts.text = v.getRange(s, e);
    if (this.findInput) this.findInput.value = this.opts.text;
    const saved = this.opts.mode;
    this.opts.mode = 'normal';
    this.findNext(dir);
    this.opts.mode = saved;
  }
}

// ------------------------------------------------------------------ search results panel
export class SearchResults {
  constructor(app, panelEl, ScintillaView, M) {
    this.app = app;
    this.panel = panelEl;
    this.M = M;
    this.lineInfo = [];
    this.title = panelEl.querySelector('.panel-title');
    panelEl.querySelector('.panel-close').addEventListener('click', () => this.hide());
    this.host = panelEl.querySelector('.panel-body');
    this.view = new ScintillaView(M, this.host);
    const v = this.view;
    v.send(SC.SCI_SETMARGINWIDTHN, 0, 0);
    v.send(SC.SCI_SETMARGINWIDTHN, 1, 0);
    v.send(SC.SCI_SETMARGINTYPEN, 2, SC.SC_MARGIN_SYMBOL);
    v.send(SC.SCI_SETMARGINMASKN, 2, SC.SC_MASK_FOLDERS);
    v.send(SC.SCI_SETMARGINWIDTHN, 2, 14);
    v.send(SC.SCI_SETMARGINSENSITIVEN, 2, 1);
    v.send(SC.SCI_SETCARETLINEVISIBLE, 1);
    v.send(SC.SCI_SETCARETLINEVISIBLEALWAYS, 1);
    v.on('notify', (n) => {
      if (n.code === SC.SCN_DOUBLECLICK) this.goto(v.send(SC.SCI_LINEFROMPOSITION, n.position));
      else if (n.code === SC.SCN_MARGINCLICK) v.send(SC.SCI_TOGGLEFOLD, v.send(SC.SCI_LINEFROMPOSITION, n.position));
    });
    v.onKeyDown = (e) => {
      if (e.key === 'Enter') { this.goto(v.send(SC.SCI_LINEFROMPOSITION, v.send(SC.SCI_GETCURRENTPOS))); return true; }
      if (e.key === 'Escape') { this.app.view.focus(); return true; }
      return this.app.globalKey(e);
    };
    this.cur = -1;
  }
  applyTheme(config) {
    const v = this.view;
    config.applyLanguage(v, 'searchResult');
    v.send(SC.SCI_SETREADONLY, 1);
    config.applyGlobalStyles(v);
    v.send(SC.SCI_SETMARGINWIDTHN, 1, 0);
    v.send(SC.SCI_SETMARGINWIDTHN, 3, 0);
  }
  show(what, groups, total, searched, mode) {
    const lines = [];
    const marks = [];
    this.lineInfo = [];
    const fileCount = groups.length;
    lines.push(`Search "${what}" (${total} hit${total === 1 ? '' : 's'} in ${fileCount} file${fileCount === 1 ? '' : 's'} of ${searched} searched) [${mode}]`);
    marks.push([]);
    this.lineInfo.push(null);
    for (const g of groups) {
      lines.push(`  ${g.buf.path || g.buf.name} (${g.count} hit${g.count === 1 ? '' : 's'})`);
      marks.push([]);
      this.lineInfo.push(null);
      for (const hit of g.hits) {
        const prefix = `\tLine ${hit.line + 1}: `;
        const text = hit.text.replace(/[\r\n]+$/, '');
        const pb = enc.encode(prefix).length;
        lines.push(prefix + text);
        marks.push(hit.segs.map(([a, b]) => [pb + a, pb + b]));
        this.lineInfo.push({ buf: g.buf, pos: hit.pos, end: hit.end });
      }
    }
    // Byte offsets of segments must be relative to the UTF-8 text of each line
    for (let i = 0; i < lines.length; i++) {
      const info = this.lineInfo[i];
      if (!info) continue;
      // segment offsets computed from Scintilla byte positions already
    }
    const v = this.view;
    v.send(SC.SCI_SETREADONLY, 0);
    v.setText(lines.join('\n'));
    v.send(SC.SCI_SETREADONLY, 1);
    // markings for the searchResult lexer
    const flat = [];
    for (const segs of marks) { flat.push(segs.length); for (const [a, b] of segs) flat.push(a, b); }
    const M = this.M;
    const p = M._malloc(flat.length * 4 + 4);
    M.HEAP32.set(flat, p >> 2);
    M._sci_search_markings(v.sci, p, marks.length);
    M._free(p);
    v.send(SC.SCI_COLOURISE, 0, -1);
    this.title.textContent = `Search results - (${total} hit${total === 1 ? '' : 's'})`;
    this.cur = -1;
    this.panel.hidden = false;
    this.app.layoutChanged();
    v.send(SC.SCI_GOTOLINE, 0);
  }
  hide() {
    this.panel.hidden = true;
    this.app.layoutChanged();
    this.app.view.focus();
  }
  get visible() { return !this.panel.hidden; }
  goto(line) {
    const info = this.lineInfo[line];
    if (!info) {
      this.view.send(SC.SCI_TOGGLEFOLD, line);
      return;
    }
    this.cur = line;
    this.view.send(SC.SCI_GOTOLINE, line);
    if (this.app.buffers.includes(info.buf)) {
      this.app.activate(info.buf);
      const v = this.app.view;
      v.send(SC.SCI_ENSUREVISIBLE, v.send(SC.SCI_LINEFROMPOSITION, info.pos));
      v.send(SC.SCI_SETSEL, info.pos, info.end);
      v.send(SC.SCI_SCROLLRANGE, info.end, info.pos);
      v.focus();
    }
  }
  next(dir) {
    if (!this.lineInfo.length) return;
    let i = this.cur;
    for (let k = 0; k < this.lineInfo.length; k++) {
      i = (i + dir + this.lineInfo.length) % this.lineInfo.length;
      if (this.lineInfo[i]) { this.goto(i); return; }
    }
  }
}

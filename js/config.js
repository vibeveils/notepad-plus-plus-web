// config.js - loads Notepad++'s own configuration files (langs.xml,
// stylers.xml, themes/*.xml) and applies them to a ScintillaView the way
// ScintillaEditView::defineDocType / performGlobalStyles do in Notepad++.

import { SC } from './sci-consts.js';

const KW_CLASS = {
  instre1: 0, instre2: 1, type1: 2, type2: 3, type3: 4, type4: 5, type5: 6, type6: 7, type7: 8,
  substyle1: 9, substyle2: 10, substyle3: 11, substyle4: 12, substyle5: 13, substyle6: 14, substyle7: 15, substyle8: 16,
};
const L = (...ns) => ns; // keyword list indices

// Simple lexers: languages configured through ScintillaEditView::setLexer(lang, lists, ...)
const SIMPLE = {
  css: { lists: L(0, 1, 4, 6) },
  lua: { lists: L(0, 1, 2, 3, 4, 5, 6, 7), sub: [[SC.SCE_LUA_IDENTIFIER, 4, 9]] },
  makefile: { lists: [] },
  ini: { lists: [], eolFilled: [SC.SCE_PROPS_SECTION] },
  props: { lists: [], eolFilled: [SC.SCE_PROPS_SECTION] },
  sql: { lists: L(0, 1, 4), props: { 'sql.backslash.escapes': '0' } },
  mssql: { lists: L(0, 1, 2, 3, 4, 5) },
  vb: { lists: L(0) },
  pascal: { lists: L(0), props: { 'fold.preprocessor': '1' } },
  perl: { lists: L(0) },
  python: { lists: L(0, 1), sub: [[SC.SCE_P_IDENTIFIER, 8, 9]], props: { 'fold.quotes.python': '1', 'lexer.python.decorator.attributes': '1', 'lexer.python.identifier.attributes': '1' } },
  gdscript: { lists: L(0, 1), sub: [[SC.SCE_GD_IDENTIFIER, 8, 9]], props: { 'lexer.gdscript.keywords2.no.sub.identifiers': '1', 'lexer.gdscript.whinge.level': '1' } },
  batch: { lists: L(0) },
  tex: { lists: [] },
  nsis: { lists: L(0, 1, 2, 3) },
  fortran: { lists: L(0, 1, 2) },
  fortran77: { lists: L(0, 1, 2) },
  lisp: { lists: L(0, 1) },
  scheme: { lists: L(0, 1) },
  asm: { lists: L(0, 1, 2, 3, 4, 5, 6, 7), props: { 'fold.asm.syntax.based': '1', 'fold.asm.comment.multiline': '1', 'fold.asm.comment.explicit': '1' } },
  diff: { lists: [] },
  postscript: { lists: L(0, 1, 2, 3) },
  ruby: { lists: L(0) },
  smalltalk: { lists: L(0) },
  vhdl: { lists: L(0, 1, 2, 3, 4, 5, 6) },
  kix: { lists: L(0, 1, 2) },
  autoit: { lists: L(0, 1, 2, 3, 4, 5, 6), props: { 'fold.preprocessor': '1' } },
  caml: { lists: L(0, 1, 2) },
  ada: { lists: L(0) },
  verilog: { lists: L(0, 1), props: { 'fold.preprocessor': '1' } },
  matlab: { lists: L(0) },
  haskell: { lists: L(0) },
  inno: { lists: L(0, 1, 2, 3, 4, 5) },
  cmake: { lists: L(0, 1, 2) },
  yaml: { lists: L(0) },
  cobol: { lists: L(0, 1, 2) },
  gui4cli: { lists: L(0, 1, 2, 3, 4) },
  d: { lists: L(0, 1, 2, 3, 4, 5, 6) },
  powershell: { lists: L(0, 1, 2, 3, 4, 5) },
  r: { lists: L(0, 1, 2), props: { 'lexer.r.escape.sequence': '1' } },
  coffeescript: { lists: L(0, 1, 2, 3) },
  baanc: { lists: L(0, 1, 2, 3, 4, 5, 6, 7, 8), props: { 'lexer.baan.styling.within.preprocessor': '1', 'fold.preprocessor': '1', 'fold.baan.syntax.based': '1', 'fold.baan.keywords.based': '1', 'fold.baan.sections': '1', 'fold.baan.inner.level': '1' } },
  srec: { lists: [] }, ihex: { lists: [] }, tehex: { lists: [] },
  asn1: { lists: L(0, 1, 2, 3) },
  avs: { lists: L(0, 1, 2, 3, 4, 5) },
  blitzbasic: { lists: L(0, 1, 2, 3) },
  purebasic: { lists: L(0, 1, 2, 3) },
  freebasic: { lists: L(0, 1, 2, 3) },
  csound: { lists: L(0, 1, 2) },
  erlang: { lists: L(0, 1, 2, 3, 4, 5) },
  escript: { lists: L(0, 1, 2) },
  forth: { lists: L(0, 1, 2, 3, 4, 5) },
  latex: { lists: [] },
  mmixal: { lists: L(0, 1, 2) },
  nim: { lists: L(0) },
  nncrontab: { lists: L(0, 1, 2) },
  oscript: { lists: L(0, 1, 2, 3, 4, 5) },
  rebol: { lists: L(0, 1, 2, 3, 4, 5, 6) },
  registry: { lists: [] },
  rust: { lists: L(0, 1, 2, 3, 4, 5, 6) },
  spice: { lists: L(0, 1, 2) },
  txt2tags: { lists: [] },
  visualprolog: { lists: L(0, 1, 2, 3) },
  hollywood: { lists: L(0, 1, 2, 3) },
  raku: { lists: L(0, 1, 2, 3, 4, 5, 6), props: { 'fold.raku.comment.multiline': '1', 'fold.raku.comment.pod': '1' } },
  toml: { lists: L(0) },
  sas: { lists: L(0, 1, 2, 3) },
  fcST: { lists: L(0, 1, 2, 3, 4, 5), props: { fold: '1', 'fold.compact': '0', 'fold.comment': '1', 'fold.preprocessor': '1' } },
  errorlist: { lists: [], props: { 'lexer.errorlist.value.separate': '0', 'lexer.errorlist.escape.sequences': '1' } },
  escseq: { lists: [], props: { 'lexer.escseq.colour.text': '1' } },
  searchResult: { lists: [] },
};

const CPP_FAMILY = new Set(['c', 'cpp', 'java', 'rc', 'cs', 'actionscript', 'swift', 'go']);
const HTML_FAMILY = new Set(['php', 'asp', 'jsp', 'html']);
const PYTHON_INDENT = new Set(['python', 'coffeescript', 'haskell', 'nim', 'yaml', 'gdscript', 'fortran']);

// --------------------------------------------------------------------------
// colours: Notepad++ XML stores RRGGBB; Scintilla wants 0xBBGGRR
export function hexToBgr(hex) {
  if (hex === undefined || hex === null || hex === '') return undefined;
  const v = parseInt(hex, 16);
  if (Number.isNaN(v)) return undefined;
  return ((v & 0xFF) << 16) | (v & 0xFF00) | ((v >> 16) & 0xFF);
}
export function hexToCss(hex) {
  return hex ? '#' + hex.padStart(6, '0') : undefined;
}

function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const err = doc.querySelector('parsererror');
  if (err) throw new Error('XML parse error: ' + err.textContent.slice(0, 200));
  return doc;
}

function parseStyle(el) {
  const intAttr = (n) => { const a = el.getAttribute(n); return a === null || a === '' ? undefined : parseInt(a, 10); };
  return {
    name: el.getAttribute('name') || '',
    id: intAttr('styleID') ?? 0,
    fg: el.getAttribute('fgColor') || undefined,
    bg: el.getAttribute('bgColor') || undefined,
    colorStyle: intAttr('colorStyle') ?? 3,
    fontName: el.getAttribute('fontName') || '',
    fontStyle: intAttr('fontStyle'),
    fontSize: intAttr('fontSize'),
    keywordClass: el.hasAttribute('keywordClass') ? KW_CLASS[el.getAttribute('keywordClass')] : undefined,
    keywords: (el.textContent || '').trim(),
  };
}

export function parseStylers(text) {
  const doc = parseXml(text);
  const lexers = new Map();
  for (const lt of doc.querySelectorAll('LexerStyles > LexerType')) {
    lexers.set(lt.getAttribute('name'), {
      name: lt.getAttribute('name'),
      desc: lt.getAttribute('desc'),
      ext: lt.getAttribute('ext') || '',
      styles: Array.from(lt.querySelectorAll('WordsStyle')).map(parseStyle),
    });
  }
  const globals = Array.from(doc.querySelectorAll('GlobalStyles > WidgetStyle')).map(parseStyle);
  return { lexers, globals };
}

export function parseLangs(text) {
  const doc = parseXml(text);
  const langs = new Map();
  for (const el of doc.querySelectorAll('Languages > Language')) {
    const kw = {};
    for (const k of el.querySelectorAll('Keywords')) {
      const idx = KW_CLASS[k.getAttribute('name')];
      if (idx !== undefined) kw[idx] = (k.textContent || '').trim();
    }
    langs.set(el.getAttribute('name'), {
      name: el.getAttribute('name'),
      ext: (el.getAttribute('ext') || '').split(/\s+/).filter(Boolean).map((e) => e.toLowerCase()),
      commentLine: el.getAttribute('commentLine') || '',
      commentStart: el.getAttribute('commentStart') || '',
      commentEnd: el.getAttribute('commentEnd') || '',
      tabSettings: el.getAttribute('tabSettings'),
      keywords: kw,
    });
  }
  return langs;
}

// --------------------------------------------------------------------------
export class NppConfig {
  constructor() {
    this.langs = new Map();       // langs.xml
    this.languages = [];          // LangType table (languages.json)
    this.byName = new Map();
    this.model = null;            // stylers.xml
    this.theme = null;            // current theme (falls back to model)
    this.themeName = 'Default (stylers.xml)';
    this.themes = [];
    this.rgbaIcons = {};
    this.apiCache = new Map();
  }

  async load(base = 'config/') {
    const [langsText, stylersText, languages, themes, icons] = await Promise.all([
      fetch(base + 'langs.xml').then((r) => r.text()),
      fetch(base + 'stylers.xml').then((r) => r.text()),
      fetch(base + 'languages.json').then((r) => r.json()),
      fetch(base + 'themes/index.json').then((r) => r.json()),
      fetch(base + 'rgba_icons.json').then((r) => r.json()),
    ]);
    this.base = base;
    this.langs = parseLangs(langsText);
    this.model = parseStylers(stylersText);
    this.theme = this.model;
    this.languages = languages;
    for (const l of languages) this.byName.set(l.name, l);
    this.themes = themes;
    for (const [k, v] of Object.entries(icons)) {
      this.rgbaIcons[k] = Uint8Array.from(atob(v), (c) => c.charCodeAt(0));
    }
  }

  async setTheme(fileName) {
    if (!fileName || fileName === 'stylers.xml') {
      this.theme = this.model;
      this.themeName = 'Default (stylers.xml)';
      return;
    }
    const text = await fetch(this.base + 'themes/' + encodeURIComponent(fileName)).then((r) => {
      if (!r.ok) throw new Error('Theme not found: ' + fileName);
      return r.text();
    });
    this.theme = parseStylers(text);
    this.themeName = fileName.replace(/\.xml$/i, '');
  }

  async loadApi(langName) {
    if (this.apiCache.has(langName)) return this.apiCache.get(langName);
    const file = { 'javascript.js': 'javascript', javascript: 'javascript', coffeescript: 'coffee', baanc: 'BaanC' }[langName] || langName;
    const p = (this.apiIndex ? Promise.resolve(this.apiIndex) : fetch(this.base + 'autoCompletion/index.json').then((r) => r.json()).then((x) => (this.apiIndex = x)))
      .then((idx) => (idx.includes(file + '.xml') ? fetch(this.base + 'autoCompletion/' + encodeURIComponent(file) + '.xml') : { ok: false }))
      .then((r) => (r.ok ? r.text() : null))
      .then((text) => {
        if (!text) return null;
        const doc = parseXml(text);
        const env = doc.querySelector('Environment');
        const words = Array.from(doc.querySelectorAll('AutoComplete > KeyWord')).map((k) => ({
          name: k.getAttribute('name'),
          func: k.getAttribute('func') === 'yes',
          overloads: Array.from(k.querySelectorAll('Overload')).map((o) => ({
            retVal: o.getAttribute('retVal') || '',
            descr: o.getAttribute('descr') || '',
            params: Array.from(o.querySelectorAll('Param')).map((p2) => p2.getAttribute('name')),
          })),
        }));
        return {
          ignoreCase: env ? env.getAttribute('ignoreCase') === 'yes' : false,
          startFunc: env ? env.getAttribute('startFunc') || '(' : '(',
          stopFunc: env ? env.getAttribute('stopFunc') || ')' : ')',
          paramSeparator: env ? env.getAttribute('paramSeparator') || ',' : ',',
          terminal: env ? env.getAttribute('terminal') || ';' : ';',
          additionalWordChar: env ? env.getAttribute('additionalWordChar') || '' : '',
          words,
        };
      })
      .catch(() => null);
    this.apiCache.set(langName, p);
    return p;
  }

  // ---------------------------------------------------------------- lookups
  globalStyle(name) {
    const g = this.theme.globals.find((s) => s.name === name);
    return g || this.model.globals.find((s) => s.name === name);
  }
  globalStyleById(id) {
    const g = this.theme.globals.find((s) => s.id === id && s.id !== 0);
    return g || this.model.globals.find((s) => s.id === id && s.id !== 0);
  }
  lexerStyler(name) {
    return this.theme.lexers.get(name) || this.model.lexers.get(name);
  }
  languageForExtension(fileName) {
    const lower = fileName.toLowerCase();
    const base = lower.split(/[\\/]/).pop();
    const dot = base.lastIndexOf('.');
    const ext = dot >= 0 ? base.slice(dot + 1) : '';
    // whole-name matches first (e.g. "makefile", "CMakeLists.txt")
    for (const [name, l] of this.langs) {
      if (l.ext.includes(base)) return name;
    }
    if (!ext) return 'normal';
    // user extensions in stylers.xml take precedence like in Notepad++
    for (const [name, lx] of this.theme.lexers) {
      if (lx.ext && lx.ext.toLowerCase().split(/\s+/).includes(ext) && this.langs.has(name)) return name;
    }
    for (const [name, l] of this.langs) {
      if (name === 'normal') continue;
      if (l.ext.includes(ext)) return name;
    }
    return 'normal';
  }
  wordList(langName, index) {
    const l = this.langs.get(langName);
    return l && l.keywords[index] ? l.keywords[index] : '';
  }
  displayName(langName) {
    const l = this.byName.get(langName);
    return l ? l.short : langName;
  }
  longName(langName) {
    const l = this.byName.get(langName);
    return l ? l.long : langName;
  }

  // ---------------------------------------------------------------- style application
  setStyle(view, st, fallback) {
    const id = st.id;
    const fg = st.fg ?? (fallback ? fallback.fg : undefined);
    const bg = st.bg ?? (fallback ? fallback.bg : undefined);
    if ((st.colorStyle & 1) && fg !== undefined) view.send(SC.SCI_STYLESETFORE, id, hexToBgr(fg));
    if ((st.colorStyle & 2) && bg !== undefined) view.send(SC.SCI_STYLESETBACK, id, hexToBgr(bg));
    if (st.fontName) view.sendStr(SC.SCI_STYLESETFONT, id, st.fontName);
    if (st.fontStyle !== undefined && st.fontStyle >= 0) {
      view.send(SC.SCI_STYLESETBOLD, id, st.fontStyle & 1 ? 1 : 0);
      view.send(SC.SCI_STYLESETITALIC, id, st.fontStyle & 2 ? 1 : 0);
      view.send(SC.SCI_STYLESETUNDERLINE, id, st.fontStyle & 4 ? 1 : 0);
    }
    if (st.fontSize > 0) view.send(SC.SCI_STYLESETSIZE, id, st.fontSize);
  }

  // makeStyle: apply a language's styles, collect keyword overrides from the styler
  makeStyle(view, langName, kwArray) {
    const lx = this.lexerStyler(langName);
    if (!lx) return;
    const def = this.globalStyleById(32);
    for (const st of lx.styles) {
      this.setStyle(view, st, def);
      if (kwArray && st.keywordClass !== undefined && st.keywords) kwArray[st.keywordClass] = st.keywords;
    }
  }
  concat(kwArray, idx, langName, index) {
    return ((kwArray[idx] || '') + ' ' + this.wordList(langName, index)).trim();
  }
  setKeywords(view, set, words) {
    view.sendStr(SC.SCI_SETKEYWORDS, set, words);
  }
  setProps(view, props) {
    for (const [k, v] of Object.entries(props)) view.sendStrStr(SC.SCI_SETPROPERTY, k, v);
  }
  populateSubStyles(view, langName, baseStyle, count, firstIdx, kwArray) {
    const first = view.send(SC.SCI_ALLOCATESUBSTYLES, baseStyle, count) & 0xFF;
    if (first < 0) return;
    for (let i = 0; i < count; i++) {
      const words = this.concat(kwArray, firstIdx + i, langName, firstIdx + i);
      view.sendStr(SC.SCI_SETIDENTIFIERS, first + i, words);
    }
  }
  lexerFor(langName) {
    const l = this.byName.get(langName);
    if (!l) return 'null';
    if (HTML_FAMILY.has(langName)) return 'hypertext';
    if (langName === 'javascript.js' || langName === 'javascript' || langName === 'typescript') return 'cpp';
    return l.lexer;
  }

  // ScintillaEditView::defineDocType
  applyLanguage(view, langName, opts = {}) {
    const def = this.globalStyleById(32);
    view.send(SC.SCI_FREESUBSTYLES);
    if (def) this.setStyle(view, { ...def, colorStyle: 3 });
    view.send(SC.SCI_STYLECLEARALL);

    // special indicators (smart highlight, find marks, tag match, mark styles 1-5)
    const indic = (id, fallbackRgb) => {
      const st = this.globalStyleById(id);
      view.send(SC.SCI_INDICSETFORE, id, hexToBgr(st && st.bg ? st.bg : fallbackRgb));
    };
    indic(31, 'FF0000'); indic(29, '00FF00'); indic(28, '0080FF');
    const inc = this.globalStyleById(28);
    view.send(SC.SCI_INDICSETFORE, 30, hexToBgr(inc && inc.bg ? inc.bg : '0080FF'));
    indic(27, '8000FF'); indic(26, 'FFFF00');
    indic(25, '00FFFF'); indic(24, 'FF8000'); indic(23, 'FFFF00'); indic(22, '8000FF'); indic(21, '008000');

    const lexer = this.lexerFor(langName);
    view.setLexer(lexer === 'null' ? '' : lexer);
    const kw = {};

    if (CPP_FAMILY.has(langName)) {
      if (langName === 'go') this.setProps(view, { 'lexer.cpp.backquoted.strings': '1' });
      if (langName !== 'rc') this.setKeywords(view, 2, this.wordList('cpp', 3));
      this.makeStyle(view, langName, kw);
      this.setKeywords(view, 0, this.concat(kw, 0, langName, 0));
      this.setKeywords(view, 1, this.concat(kw, 2, langName, 2));
      this.setKeywords(view, 3, this.concat(kw, 1, langName, 1));
      this.populateSubStyles(view, langName, SC.SCE_C_IDENTIFIER, 8, 9, kw);
      this.setProps(view, { fold: '1', 'fold.compact': '0', 'fold.comment': '1', 'fold.cpp.comment.explicit': '0', 'fold.preprocessor': '1', 'lexer.cpp.track.preprocessor': '0' });
    } else if (langName === 'javascript.js' || langName === 'javascript') {
      const name = 'javascript.js';
      this.setKeywords(view, 2, this.wordList('cpp', 3));
      this.makeStyle(view, name, kw);
      this.setKeywords(view, 0, this.concat(kw, 0, name, 0));
      this.setKeywords(view, 1, this.concat(kw, 2, name, 2));
      this.setKeywords(view, 3, this.concat(kw, 1, name, 1));
      this.populateSubStyles(view, name, SC.SCE_C_IDENTIFIER, 8, 9, kw);
      this.setProps(view, { fold: '1', 'fold.compact': '0', 'fold.comment': '1', 'fold.preprocessor': '1', 'lexer.cpp.track.preprocessor': '0', 'lexer.cpp.backquoted.strings': '1' });
    } else if (langName === 'typescript') {
      this.setKeywords(view, 2, this.wordList('cpp', 3));
      this.makeStyle(view, 'typescript', kw);
      this.setKeywords(view, 0, this.concat(kw, 0, 'typescript', 0));
      this.setKeywords(view, 1, this.concat(kw, 2, 'typescript', 2));
      this.populateSubStyles(view, 'typescript', SC.SCE_C_IDENTIFIER, 8, 9, kw);
      this.setProps(view, { fold: '1', 'fold.compact': '0', 'fold.comment': '1', 'fold.cpp.comment.explicit': '0', 'fold.preprocessor': '1', 'lexer.cpp.backquoted.strings': '1' });
    } else if (langName === 'objc') {
      this.makeStyle(view, 'objc', kw);
      this.setKeywords(view, 0, this.concat(kw, 0, 'objc', 0));
      this.setKeywords(view, 1, this.concat(kw, 2, 'objc', 2));
      this.setKeywords(view, 2, this.wordList('cpp', 3));
      this.setKeywords(view, 3, this.concat(kw, 1, 'objc', 1));
      this.setKeywords(view, 4, this.concat(kw, 3, 'objc', 3));
      this.setProps(view, { fold: '1', 'fold.compact': '0', 'fold.comment': '1', 'fold.cpp.comment.explicit': '0', 'fold.preprocessor': '1' });
    } else if (langName === 'tcl') {
      this.makeStyle(view, 'tcl', kw);
      const order = [0, 2, 1, 3, 4, 5, 6, 7, 8];
      order.forEach((idx, set) => this.setKeywords(view, set, this.concat(kw, idx, 'tcl', idx)));
    } else if (langName === 'xml') {
      this.makeStyle(view, 'xml', kw);
      this.setKeywords(view, 5, this.concat(kw, 0, 'xml', 0));
      this.populateSubStyles(view, 'xml', SC.SCE_H_ATTRIBUTE, 8, 9, kw);
      this.setProps(view, { 'lexer.xml.allow.scripts': '0', fold: '1', 'fold.compact': '0', 'fold.html': '1', 'fold.hypertext.comment': '1' });
    } else if (HTML_FAMILY.has(langName)) {
      // setHTMLLexer + embedded JS / PHP / ASP
      const h = {};
      this.makeStyle(view, 'html', h);
      this.setKeywords(view, 0, this.concat(h, 0, 'html', 0));
      this.setKeywords(view, 5, this.concat(h, 1, 'html', 1));
      this.populateSubStyles(view, 'html', SC.SCE_H_TAG, 4, 9, h);
      this.populateSubStyles(view, 'html', SC.SCE_H_ATTRIBUTE, 4, 13, h);
      const j = {};
      this.makeStyle(view, 'javascript', j);
      this.setKeywords(view, 1, this.concat(j, 0, 'javascript', 0));
      this.populateSubStyles(view, 'javascript', SC.SCE_HJ_WORD, 8, 9, j);
      for (const s of [SC.SCE_HJ_DEFAULT, SC.SCE_HJ_COMMENT, SC.SCE_HJ_COMMENTDOC, SC.SCE_HJ_TEMPLATELITERAL, SC.SCE_HJA_TEMPLATELITERAL]) view.send(SC.SCI_STYLESETEOLFILLED, s, 1);
      const p = {};
      this.makeStyle(view, 'php', p);
      this.setKeywords(view, 4, this.concat(p, 0, 'php', 0));
      this.populateSubStyles(view, 'php', SC.SCE_HPHP_WORD, 8, 9, p);
      view.send(SC.SCI_STYLESETEOLFILLED, SC.SCE_HPHP_DEFAULT, 1);
      view.send(SC.SCI_STYLESETEOLFILLED, SC.SCE_HPHP_COMMENT, 1);
      const a = {};
      this.makeStyle(view, 'asp', a);
      this.setProps(view, { 'asp.default.language': '2' });
      this.setKeywords(view, 2, this.concat(a, 0, 'vb', 0));
      this.populateSubStyles(view, 'asp', SC.SCE_HB_WORD, 8, 9, a);
      view.send(SC.SCI_STYLESETEOLFILLED, SC.SCE_HBA_DEFAULT, 1);
      this.setProps(view, { fold: '1', 'fold.compact': '0', 'fold.html': '1', 'fold.hypertext.comment': '1' });
    } else if (langName === 'json' || langName === 'json5') {
      this.makeStyle(view, 'json', kw);
      this.setKeywords(view, 0, this.concat(kw, 0, 'json', 0));
      this.setKeywords(view, 1, this.concat(kw, 1, 'json', 1));
      this.setProps(view, { fold: '1', 'fold.compact': '0', 'lexer.json.allow.comments': langName === 'json5' ? '1' : '0', 'lexer.json.escape.sequence': '1' });
    } else if (langName === 'bash') {
      this.makeStyle(view, 'bash', kw);
      this.setKeywords(view, 0, this.concat(kw, 0, 'bash', 0));
      this.populateSubStyles(view, 'bash', SC.SCE_SH_IDENTIFIER, 4, 9, kw);
      this.populateSubStyles(view, 'bash', SC.SCE_SH_SCALAR, 4, 13, kw);
      this.setProps(view, { fold: '1', 'fold.compact': '0', 'fold.comment': '1' });
    } else if (langName === 'nfo') {
      const lx = this.lexerStyler('nfo');
      const d = lx && lx.styles.find((s) => s.name === 'DEFAULT');
      this.setStyle(view, { id: 32, fg: d ? d.fg : '000000', bg: d ? d.bg : 'FFFFFF', colorStyle: 3, fontName: (d && d.fontName) || 'Lucida Console', fontSize: 10 });
      view.send(SC.SCI_STYLECLEARALL);
    } else if (SIMPLE[langName]) {
      const cfg = SIMPLE[langName];
      if (langName === 'tex') for (let i = 0; i < 4; i++) this.setKeywords(view, i, '');
      this.makeStyle(view, langName, kw);
      for (const idx of cfg.lists) this.setKeywords(view, idx, this.concat(kw, idx, langName, idx));
      if (cfg.sub) for (const [base, n, first] of cfg.sub) this.populateSubStyles(view, langName, base, n, first, kw);
      if (cfg.eolFilled) for (const s of cfg.eolFilled) view.send(SC.SCI_STYLESETEOLFILLED, s, 1);
      if (cfg.props) this.setProps(view, cfg.props);
    } else {
      this.makeStyle(view, langName, kw);
    }
    // folding is enabled generally for lexers that support it
    this.setProps(view, { fold: '1' });

    // global styles that sit on top of the language styles
    for (const id of [37, 34, 35]) {
      const st = this.globalStyleById(id);
      if (st) this.setStyle(view, st, def);
    }
    const ln = this.globalStyleById(33);
    if (ln) this.setStyle(view, ln, def);

    if (opts.indentGuide) {
      view.send(SC.SCI_SETINDENTATIONGUIDES, PYTHON_INDENT.has(langName) ? SC.SC_IV_LOOKFORWARD : SC.SC_IV_LOOKBOTH);
    }
  }

  // ScintillaEditView::performGlobalStyles
  applyGlobalStyles(view) {
    const g = (n) => this.globalStyle(n);
    const bgr = hexToBgr;
    const el = (element, hex, alpha = 0xFF) => {
      if (hex === undefined) return;
      view.send(SC.SCI_SETELEMENTCOLOUR, element, (bgr(hex) | (alpha << 24)) >>> 0);
    };
    let s = g('Current line background colour');
    if (s) el(SC.SC_ELEMENT_CARET_LINE_BACK, s.bg);
    s = g('Selected text colour');
    const selBack = s && s.bg ? s.bg : 'C0C0C0';
    el(SC.SC_ELEMENT_SELECTION_BACK, selBack);
    el(SC.SC_ELEMENT_SELECTION_INACTIVE_BACK, selBack);
    s = g('Multi-selected text color');
    el(SC.SC_ELEMENT_SELECTION_ADDITIONAL_BACK, s && s.bg ? s.bg : 'C0C0C0');
    s = g('Caret colour');
    el(SC.SC_ELEMENT_CARET, s && s.fg ? s.fg : '000000');
    s = g('Multi-edit carets color');
    el(SC.SC_ELEMENT_CARET_ADDITIONAL, s && s.fg ? s.fg : '404040');
    s = g('Edge colour');
    view.send(SC.SCI_SETEDGECOLOUR, bgr(s && s.fg ? s.fg : 'C0C0C0'));
    s = g('Fold margin');
    view.send(SC.SCI_SETFOLDMARGINCOLOUR, 1, bgr(s && s.bg ? s.bg : '808080'));
    view.send(SC.SCI_SETFOLDMARGINHICOLOUR, 1, bgr(s && s.fg ? s.fg : 'FFFFFF'));
    s = g('Bookmark margin') || g('Line number margin');
    view.send(SC.SCI_SETMARGINTYPEN, 1, SC.SC_MARGIN_COLOUR);
    view.send(SC.SCI_SETMARGINBACKN, 1, bgr(s && s.bg ? s.bg : 'E0E0E0'));
    s = g('Change History margin') || g('Line number margin');
    view.send(SC.SCI_SETMARGINTYPEN, 2, SC.SC_MARGIN_COLOUR);
    view.send(SC.SCI_SETMARGINBACKN, 2, bgr(s && s.bg ? s.bg : 'E0E0E0'));
    const hist = [
      ['Change History modified', SC.SC_MARKNUM_HISTORY_MODIFIED, 'FF8000', SC.INDICATOR_HISTORY_MODIFIED_INSERTION, SC.INDICATOR_HISTORY_MODIFIED_DELETION],
      ['Change History revert modified', SC.SC_MARKNUM_HISTORY_REVERTED_TO_MODIFIED, 'A0C000', SC.INDICATOR_HISTORY_REVERTED_TO_MODIFIED_INSERTION, SC.INDICATOR_HISTORY_REVERTED_TO_MODIFIED_DELETION],
      ['Change History revert origin', SC.SC_MARKNUM_HISTORY_REVERTED_TO_ORIGIN, '40A0BF', SC.INDICATOR_HISTORY_REVERTED_TO_ORIGIN_INSERTION, SC.INDICATOR_HISTORY_REVERTED_TO_ORIGIN_DELETION],
      ['Change History saved', SC.SC_MARKNUM_HISTORY_SAVED, '00A000', SC.INDICATOR_HISTORY_SAVED_INSERTION, SC.INDICATOR_HISTORY_SAVED_DELETION],
    ];
    for (const [name, marker, dflt, i1, i2] of hist) {
      s = g(name);
      const fg = bgr(s && s.fg ? s.fg : dflt), bg = bgr(s && s.bg ? s.bg : dflt);
      view.send(SC.SCI_MARKERSETFORE, marker, fg);
      view.send(SC.SCI_MARKERSETBACK, marker, bg);
      view.send(SC.SCI_INDICSETFORE, i1, fg);
      view.send(SC.SCI_INDICSETFORE, i2, fg);
    }
    // fold markers: box tree
    s = g('Fold');
    // getFoldColor: marker fore = style background, marker back = style foreground
    const foldFg = bgr(s && s.bg ? s.bg : 'FFFFFF'), foldBg = bgr(s && s.fg ? s.fg : '808080');
    s = g('Fold active');
    const foldActive = bgr(s && s.fg ? s.fg : 'FF0000');
    const markers = [
      [SC.SC_MARKNUM_FOLDEROPEN, SC.SC_MARK_BOXMINUS], [SC.SC_MARKNUM_FOLDER, SC.SC_MARK_BOXPLUS],
      [SC.SC_MARKNUM_FOLDERSUB, SC.SC_MARK_VLINE], [SC.SC_MARKNUM_FOLDERTAIL, SC.SC_MARK_LCORNER],
      [SC.SC_MARKNUM_FOLDEREND, SC.SC_MARK_BOXPLUSCONNECTED], [SC.SC_MARKNUM_FOLDEROPENMID, SC.SC_MARK_BOXMINUSCONNECTED],
      [SC.SC_MARKNUM_FOLDERMIDTAIL, SC.SC_MARK_TCORNER],
    ];
    for (const [num, type] of markers) {
      view.send(SC.SCI_MARKERDEFINE, num, type);
      view.send(SC.SCI_MARKERSETFORE, num, foldFg);
      view.send(SC.SCI_MARKERSETBACK, num, foldBg);
      view.send(SC.SCI_MARKERSETBACKSELECTED, num, foldActive);
    }
    view.send(SC.SCI_MARKERENABLEHIGHLIGHT, 1);
    s = g('White space symbol');
    view.send(SC.SCI_SETWHITESPACEFORE, 1, bgr(s && s.fg ? s.fg : '000000'));
    s = g('URL hovered');
    view.send(SC.SCI_INDICSETHOVERFORE, 8, bgr(s && s.fg ? s.fg : '0000FF'));
  }

  // Colours for the UI chrome (tabs etc.) taken from the theme
  chromeColours() {
    const def = this.globalStyleById(32) || {};
    return {
      editorBg: hexToCss(def.bg) || '#ffffff',
      editorFg: hexToCss(def.fg) || '#000000',
    };
  }
}

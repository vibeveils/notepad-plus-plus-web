# Notepad++ for the web (WebAssembly)

Notepad++'s editing engine, **Scintilla** and **Lexilla**, compiled from the
[Notepad++ source tree](https://github.com/notepad-plus-plus/notepad-plus-plus)
to WebAssembly. A new canvas platform layer draws it in the browser, inside a
Notepad++-style interface, and the whole thing is a static site you can host
on GitHub Pages.

This is an unofficial port. It is not affiliated with the Notepad++ project.

## Why it isn't a straight compile

Notepad++ itself (`PowerEditor/`) is a Win32 application: windows, dialogs,
menus, docking and plugins are all built on the Windows API, which
WebAssembly toolchains don't provide. So this port splits the work:

| Part | Source |
|---|---|
| Text engine: editing, undo, folding, selection, multi-caret, regex search, change history, autocomplete list, call tips | Scintilla, from `npp/scintilla`, compiled to wasm |
| Syntax highlighting: all 142 lexers, including Notepad++'s own `searchResult` and `user` lexers | Lexilla, from `npp/lexilla`, compiled to wasm |
| Languages, keywords, extensions, comment syntax | `PowerEditor/src/langs.model.xml` |
| Styles and the 22 themes | `stylers.model.xml` and `PowerEditor/installer/themes/*.xml` |
| Auto-completion and call-tip APIs | `PowerEditor/installer/APIs/*.xml` |
| Toolbar, tab and bookmark icons | `PowerEditor/src/icons`, `rgba_icons.h` |
| Per-language lexer setup (keyword sets, substyles, properties) | Ported to JS from `ScintillaEditView::defineDocType` / `performGlobalStyles` |
| Platform layer (Surface, Font, Window, ListBox, timers, clipboard, IME) | New: `src/ScintillaWeb.cxx` + `src/sciplat.js` |
| Application shell (menus, toolbar, tabs, Find/Replace, status bar, session) | New: `docs/js/*.js` |

## Features

- Tabs that share one Scintilla view through `SCI_SETDOCPOINTER`, as in Notepad++
- Session restore, including unsaved documents (IndexedDB)
- Open and save real files through the File System Access API in Chromium
  browsers; elsewhere files are uploaded and downloaded
- Drag and drop files; installable as an app that registers as a file handler
- Find / Replace / Mark with Normal, Extended and Regular-expression modes;
  *Find All* results go to a Search results panel rendered by Notepad++'s own
  `searchResult` lexer
- Smart highlighting, brace matching, bookmarks, hide lines, folding (box
  tree), change-history margin, clickable links
- Line operations, sorting, case conversion, comment toggling, blank
  operations, EOL conversion, column editor
- Encodings: ANSI (Windows-1252), UTF-8, UTF-8-BOM, UTF-16 LE/BE BOM
- Auto-completion (functions and words) and parameter hints from Notepad++'s API files
- Macro recording and playback, including multiple runs and saved macros
- Dark mode and every bundled theme; global font override
- MD5/SHA-1/SHA-256/SHA-512, Base64/URL/quoted-printable, ASCII⇄HEX

### Phones and tablets

- **Layout:** below 760 px wide (phones, and tablets in portrait), the menu
  bar folds into a ☰ button. Menus drill down in place, and dialogs such as
  Find/Replace become bottom sheets that sit above the on-screen keyboard.
  Tablets in landscape keep the full menu bar, with touch-sized targets.
- **Editing:** tap to place the caret and double-tap to select a word.
  Long-press selects a word, and dragging extends the selection. This brings
  up a Cut / Copy / Paste / Select All / Line bar, with ⋯ for the full
  context menu.
- **Gestures:** one-finger drags scroll and pinching zooms. Long-press a tab
  for the tab menu.
- **Key bar:** while typing, a bar above the keyboard adds Tab, arrows, a
  sticky **Sel** (Shift) for keyboard selection, Home/End, undo/redo, Find,
  Esc and the symbols code needs.
- **On-screen keyboard:** the app follows the visual viewport, so the
  keyboard never covers the caret. Text input goes through `beforeinput` and
  composition events, so Android and iOS keyboards (including IME) work.
- Install it to the home screen for a full-screen, app-like editor.

### Not available

Plugins (they are Windows DLLs), the User Defined Language editor, Find in
Files, split view, Document Map, Function List and printing with syntax
colours. In a normal browser tab, Ctrl+N, Ctrl+W, Ctrl+T and Ctrl+Tab are
reserved by the browser: use the toolbar, Ctrl+Alt+N / Ctrl+Alt+W, or install
the page as an app.

## Deploying to GitHub Pages

`docs/` is a complete prebuilt site. Choose one of these:

**A. Serve the prebuilt site (no build needed)**
1. Push this repository to GitHub.
2. Go to **Settings → Pages**, choose **Deploy from a branch**, then `main` and `/docs`.

**B. Rebuild from upstream on every push**
1. Push this repository to GitHub.
2. Go to **Settings → Pages** and set **Source** to **GitHub Actions**.
3. `.github/workflows/pages.yml` clones Notepad++ (default `master`; you can
   choose another ref when running it manually), builds with Emscripten 3.1.6
   and deploys `docs/`.

## Building locally

Requirements: Emscripten (tested with 3.1.6), GNU make, Python 3 with Pillow.

```sh
git clone --depth 1 https://github.com/notepad-plus-plus/notepad-plus-plus.git ../npp
make -j8 NPP=../npp      # builds docs/npp.wasm + docs/npp.js and regenerates assets
make serve               # http://localhost:8000
make test                # functional tests (needs Playwright + Chrome)
python3 test/mobile.py docs   # phone/tablet tests with emulated touch
```

Build notes:

- `-fwasm-exceptions` is needed because Scintilla reports regex syntax
  errors by throwing `std::regex_error`. Native wasm exceptions are supported
  by all current browsers.
- `-DPTRDIFF_DOESNT_ALIAS_INT` is needed because on wasm32 `ptrdiff_t` is
  `long`, so it has the same width as `int` but is a distinct type (the same
  situation as on Haiku).
- `src/stub/windows.h` lets Notepad++'s `LexUser.cxx` compile without Windows
  headers.

## Layout

```
src/ScintillaWeb.cxx     Scintilla platform layer + ScintillaBase subclass + exports
src/sciplat.js           JS side of the platform: canvas drawing, fonts, windows, timers
src/library_sci.js       Emscripten JS-library glue
docs/                    the site (index.html, js/, css/, config/, img/, npp.wasm)
docs/js/sciview.js       canvas editor widget: input, IME, clipboard, scrolling
docs/js/config.js        langs/stylers/themes parsing and lexer setup (port of ScintillaEditView)
docs/js/app.js           the Notepad++ shell
docs/js/find.js          Find/Replace/Mark and the search-results panel
docs/js/mobile.js        phone/tablet support: key bar, selection bar, keyboard viewport
tools/                   generators for constants, assets and version info
test/functional.py       end-to-end tests in headless Chrome
```

## Licence

Notepad++ is © Don Ho and contributors, licensed under the GNU GPL v3 (see
`LICENSE`). This port includes Notepad++ data and icons and is therefore
distributed under the GPL v3 too. Scintilla and Lexilla are © Neil Hodgson
and contributors under the Historical Permission Notice and Disclaimer (see
`licenses/`).

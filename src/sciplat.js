// sciplat.js - JavaScript half of the Scintilla web platform layer.
// Included with --pre-js so it shares scope with the Emscripten runtime
// (HEAPU8, HEAPF64, UTF8ToString ...).

var SciPlat = (function () {
  'use strict';
  const P = {};
  let nextId = 1;
  const windows = new Map();   // id -> {kind, el, canvas, ctx, view, ...}
  const surfaces = new Map();  // id -> {canvas, ctx, dpr, saves}
  const fonts = new Map();     // id -> {css, ascent, descent, ave, widths: Map}
  const views = new Map();     // sci pointer -> ScintillaView
  const colourCache = new Map();
  const utf8Decoder = new TextDecoder('utf-8');
  const mcanvas = document.createElement('canvas');
  const mctx = mcanvas.getContext('2d');
  let mfont = '';

  P.windows = windows;
  P.views = views;

  function dpr() { return Math.max(1, window.devicePixelRatio || 1); }
  P.dpr = dpr;

  function colour(c) {
    c >>>= 0;
    let s = colourCache.get(c);
    if (s === undefined) {
      const r = c & 255, g = (c >>> 8) & 255, b = (c >>> 16) & 255, a = (c >>> 24) & 255;
      s = a === 255 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`;
      colourCache.set(c, s);
    }
    return s;
  }
  P.colour = colour;
  function transparent(c) { return ((c >>> 24) & 255) === 0; }

  function decode(ptr, len, utf8) {
    if (len <= 0) return '';
    const bytes = HEAPU8.subarray(ptr, ptr + len);
    if (utf8) return utf8Decoder.decode(bytes);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }
  P.decode = decode;

  // ---------------------------------------------------------------- fonts
  const genericFamilies = new Set(['monospace', 'serif', 'sans-serif', 'cursive', 'fantasy', 'system-ui']);
  function fontCss(face, px, weight, italic) {
    let family;
    if (!face) family = 'monospace';
    else if (genericFamilies.has(face.toLowerCase())) family = face;
    else family = `"${face.replace(/"/g, '')}", ${P.fallbackFamily || 'monospace'}`;
    return `${italic ? 'italic ' : ''}${weight} ${px}px ${family}`;
  }
  function useFont(f) {
    if (mfont !== f.css) { mctx.font = f.css; mfont = f.css; }
  }
  P.fontCreate = function (facePtr, size, weight, italic, stretch) {
    const face = UTF8ToString(facePtr);
    const px = size; // Scintilla passes device pixels (DeviceHeightFont already applied)
    const f = { css: fontCss(face, px, weight, italic), widths: new Map(), refs: 1 };
    useFont(f);
    const m = mctx.measureText('Mgjpq|ÉÅ');
    const asc = m.fontBoundingBoxAscent !== undefined ? m.fontBoundingBoxAscent : m.actualBoundingBoxAscent;
    const desc = m.fontBoundingBoxDescent !== undefined ? m.fontBoundingBoxDescent : m.actualBoundingBoxDescent;
    f.ascent = Math.ceil(asc);
    f.descent = Math.ceil(desc);
    f.ave = mctx.measureText('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ').width / 52;
    const id = nextId++;
    fonts.set(id, f);
    return id;
  };
  P.fontRelease = function (id) { fonts.delete(id); };
  P.fontMetric = function (id, which) {
    const f = fonts.get(id);
    if (!f) return which === 3 ? 8 : 10;
    switch (which) {
      case 0: return f.ascent;
      case 1: return f.descent;
      case 2: return 0;
      default: return f.ave;
    }
  };
  P.fontCss = function (id) { const f = fonts.get(id); return f ? f.css : '13px monospace'; };

  function charWidth(f, cp, ch) {
    let w = f.widths.get(cp);
    if (w === undefined) {
      useFont(f);
      w = mctx.measureText(ch).width;
      f.widths.set(cp, w);
    }
    return w;
  }

  // Fill positions[] with the right edge of the character containing each byte.
  P.measure = function (fid, ptr, len, utf8, outPtr) {
    const f = fonts.get(fid);
    const out = outPtr >> 3;
    if (!f) { for (let i = 0; i < len; i++) HEAPF64[out + i] = (i + 1) * 8; return; }
    const H = HEAPU8;
    let x = 0, i = 0;
    while (i < len) {
      const b = H[ptr + i];
      let n = 1, cp = b;
      if (utf8 && b >= 0x80) {
        if (b >= 0xF0 && i + 3 < len) { n = 4; cp = ((b & 7) << 18) | ((H[ptr + i + 1] & 63) << 12) | ((H[ptr + i + 2] & 63) << 6) | (H[ptr + i + 3] & 63); }
        else if (b >= 0xE0 && i + 2 < len) { n = 3; cp = ((b & 15) << 12) | ((H[ptr + i + 1] & 63) << 6) | (H[ptr + i + 2] & 63); }
        else if (b >= 0xC0 && i + 1 < len) { n = 2; cp = ((b & 31) << 6) | (H[ptr + i + 1] & 63); }
        else { n = 1; cp = 0xFFFD; }
      }
      x += charWidth(f, cp, String.fromCodePoint(cp));
      for (let k = 0; k < n; k++) HEAPF64[out + i + k] = x;
      i += n;
    }
  };
  P.textWidth = function (fid, ptr, len, utf8) {
    const f = fonts.get(fid);
    if (!f) return len * 8;
    const s = decode(ptr, len, utf8);
    let x = 0;
    for (const ch of s) x += charWidth(f, ch.codePointAt(0), ch);
    return x;
  };
  P.measureString = function (fid, s) {
    const f = fonts.get(fid);
    if (!f) return s.length * 8;
    let x = 0;
    for (const ch of s) x += charWidth(f, ch.codePointAt(0), ch);
    return x;
  };

  // ---------------------------------------------------------------- surfaces
  function makeSurface(canvas, ctx, scale) {
    return { canvas, ctx, dpr: scale, saves: 0 };
  }
  P.registerSurface = function (id, canvas) {
    const ctx = canvas.getContext('2d', { alpha: false });
    surfaces.set(id, makeSurface(canvas, ctx, dpr()));
    return surfaces.get(id);
  };
  P.surfaceForWindow = function (wid) {
    return surfaces.has(wid) ? wid : 0;
  };
  P.pixmapCreate = function (w, h) {
    const scale = dpr();
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(w * scale));
    canvas.height = Math.max(1, Math.ceil(h * scale));
    const ctx = canvas.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    const id = nextId++;
    surfaces.set(id, makeSurface(canvas, ctx, scale));
    return id;
  };
  P.surfaceRelease = function (id) { surfaces.delete(id); };
  function ctxOf(sid) { const s = surfaces.get(sid); return s ? s.ctx : null; }

  P.fillRect = function (sid, l, t, r, b, c) {
    const ctx = ctxOf(sid); if (!ctx || transparent(c)) return;
    ctx.fillStyle = colour(c);
    ctx.fillRect(l, t, r - l, b - t);
  };
  P.fillPattern = function (sid, l, t, r, b, psid) {
    const ctx = ctxOf(sid), src = surfaces.get(psid); if (!ctx || !src) return;
    const pat = ctx.createPattern(src.canvas, 'repeat');
    if (pat.setTransform) pat.setTransform(new DOMMatrix([1 / src.dpr, 0, 0, 1 / src.dpr, 0, 0]));
    ctx.fillStyle = pat;
    ctx.fillRect(l, t, r - l, b - t);
  };
  P.strokeRect = function (sid, l, t, r, b, c, w) {
    const ctx = ctxOf(sid); if (!ctx || transparent(c) || w <= 0) return;
    ctx.strokeStyle = colour(c);
    ctx.lineWidth = w;
    ctx.strokeRect(l, t, r - l, b - t);
  };
  P.line = function (sid, x1, y1, x2, y2, c, w) {
    const ctx = ctxOf(sid); if (!ctx) return;
    ctx.strokeStyle = colour(c);
    ctx.lineWidth = w;
    ctx.lineCap = 'square';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.lineCap = 'butt';
  };
  function pathPts(ctx, ptr, n) {
    const o = ptr >> 3;
    ctx.beginPath();
    ctx.moveTo(HEAPF64[o], HEAPF64[o + 1]);
    for (let i = 1; i < n; i++) ctx.lineTo(HEAPF64[o + i * 2], HEAPF64[o + i * 2 + 1]);
  }
  P.polyline = function (sid, ptr, n, c, w) {
    const ctx = ctxOf(sid); if (!ctx) return;
    pathPts(ctx, ptr, n);
    ctx.strokeStyle = colour(c);
    ctx.lineWidth = w;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'miter';
    ctx.stroke();
    ctx.lineCap = 'butt';
  };
  P.polygon = function (sid, ptr, n, fill, stroke, w) {
    const ctx = ctxOf(sid); if (!ctx) return;
    pathPts(ctx, ptr, n);
    ctx.closePath();
    ctx.fillStyle = colour(fill);
    ctx.fill();
    if (w > 0 && !transparent(stroke)) {
      ctx.strokeStyle = colour(stroke);
      ctx.lineWidth = w;
      ctx.stroke();
    }
  };
  function roundRectPath(ctx, l, t, r, b, rad) {
    const w = r - l, h = b - t;
    rad = Math.max(0, Math.min(rad, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(l + rad, t);
    ctx.lineTo(r - rad, t);
    ctx.arcTo(r, t, r, t + rad, rad);
    ctx.lineTo(r, b - rad);
    ctx.arcTo(r, b, r - rad, b, rad);
    ctx.lineTo(l + rad, b);
    ctx.arcTo(l, b, l, b - rad, rad);
    ctx.lineTo(l, t + rad);
    ctx.arcTo(l, t, l + rad, t, rad);
    ctx.closePath();
  }
  P.roundedRect = function (sid, l, t, r, b, rad, fill, stroke, w, mode) {
    const ctx = ctxOf(sid); if (!ctx) return;
    roundRectPath(ctx, l, t, r, b, rad);
    if (mode === 1) {
      if (transparent(fill)) return;
      ctx.fillStyle = colour(fill);
      ctx.fill();
    } else {
      if (transparent(stroke) || w <= 0) return;
      ctx.strokeStyle = colour(stroke);
      ctx.lineWidth = w;
      ctx.stroke();
    }
  };
  P.gradientRect = function (sid, l, t, r, b, ptr, n, horizontal) {
    const ctx = ctxOf(sid); if (!ctx) return;
    const g = horizontal ? ctx.createLinearGradient(l, t, r, t) : ctx.createLinearGradient(l, t, l, b);
    const o = ptr >> 3;
    for (let i = 0; i < n; i++) {
      g.addColorStop(Math.min(1, Math.max(0, HEAPF64[o + i * 2])), colour(HEAPF64[o + i * 2 + 1] >>> 0));
    }
    ctx.fillStyle = g;
    ctx.fillRect(l, t, r - l, b - t);
  };
  const imgCanvas = document.createElement('canvas');
  const imgCtx = imgCanvas.getContext('2d');
  P.rgbaImage = function (sid, l, t, w, h, ptr) {
    const ctx = ctxOf(sid); if (!ctx || w <= 0 || h <= 0) return;
    imgCanvas.width = w;
    imgCanvas.height = h;
    const data = new ImageData(new Uint8ClampedArray(HEAPU8.slice(ptr, ptr + w * h * 4).buffer), w, h);
    imgCtx.putImageData(data, 0, 0);
    ctx.drawImage(imgCanvas, l, t, w, h);
  };
  P.ellipse = function (sid, cx, cy, rFill, rStroke, fill, stroke, w) {
    const ctx = ctxOf(sid); if (!ctx) return;
    if (rFill > 0 && !transparent(fill)) {
      ctx.beginPath();
      ctx.arc(cx, cy, rFill, 0, Math.PI * 2);
      ctx.fillStyle = colour(fill);
      ctx.fill();
    }
    if (rStroke > 0 && w > 0 && !transparent(stroke)) {
      ctx.beginPath();
      ctx.arc(cx, cy, rStroke, 0, Math.PI * 2);
      ctx.strokeStyle = colour(stroke);
      ctx.lineWidth = w;
      ctx.stroke();
    }
  };
  P.stadium = function (sid, l, t, r, b, fill, stroke, w, ends) {
    const ctx = ctxOf(sid); if (!ctx) return;
    const radius = (b - t) / 2;
    const hs = w / 2;
    const cy = (t + b) / 2;
    if (ends === 0) {
      roundRectPath(ctx, l + w, t + w, r - w, b - w, radius - w);
      ctx.fillStyle = colour(fill); ctx.fill();
      roundRectPath(ctx, l + hs, t + hs, r - hs, b - hs, radius);
      ctx.strokeStyle = colour(stroke); ctx.lineWidth = w; ctx.stroke();
      return;
    }
    const rf = Math.max(0, radius - w);
    const innerL = l + radius, innerR = r - radius;
    const left = ends & 0xf, right = ends & 0xf0;
    ctx.beginPath();
    if (left === 1) { ctx.moveTo(l + hs, t + hs); ctx.lineTo(l + hs, b - hs); }
    else if (left === 2) { ctx.moveTo(innerL + hs, t + hs); ctx.lineTo(l + hs, cy); ctx.lineTo(innerL + hs, b - hs); }
    else { ctx.moveTo(innerL + hs, t + hs); ctx.arc(innerL + hs, cy, rf, -Math.PI / 2, Math.PI / 2, true); }
    if (right === 0x10) { ctx.lineTo(r - hs, b - hs); ctx.lineTo(r - hs, t + hs); }
    else if (right === 0x20) { ctx.lineTo(innerR - hs, b - hs); ctx.lineTo(r - hs, cy); ctx.lineTo(innerR - hs, t + hs); }
    else { ctx.lineTo(innerR - hs, b - hs); ctx.arc(innerR - hs, cy, rf, Math.PI / 2, -Math.PI / 2, true); }
    ctx.closePath();
    ctx.fillStyle = colour(fill); ctx.fill();
    ctx.strokeStyle = colour(stroke); ctx.lineWidth = w; ctx.stroke();
  };
  P.copy = function (sid, l, t, r, b, fx, fy, srcSid) {
    const ctx = ctxOf(sid), src = surfaces.get(srcSid); if (!ctx || !src) return;
    const w = r - l, h = b - t; if (w <= 0 || h <= 0) return;
    const s = src.dpr;
    ctx.drawImage(src.canvas, fx * s, fy * s, w * s, h * s, l, t, w, h);
  };
  P.text = function (sid, l, t, r, b, fid, ybase, ptr, len, utf8, fore, back, mode) {
    const ctx = ctxOf(sid); if (!ctx) return;
    const f = fonts.get(fid);
    const s = decode(ptr, len, utf8);
    if (mode === 1) { ctx.save(); ctx.beginPath(); ctx.rect(l, t, r - l, b - t); ctx.clip(); }
    if (mode !== 2 && !transparent(back)) { ctx.fillStyle = colour(back); ctx.fillRect(l, t, r - l, b - t); }
    if (s.length) {
      ctx.font = f ? f.css : '13px monospace';
      ctx.fillStyle = colour(fore);
      ctx.fillText(s, l, ybase);
    }
    if (mode === 1) ctx.restore();
  };
  P.setClip = function (sid, l, t, r, b) {
    const s = surfaces.get(sid); if (!s) return;
    s.ctx.save();
    s.saves++;
    s.ctx.beginPath();
    s.ctx.rect(l, t, r - l, b - t);
    s.ctx.clip();
  };
  P.popClip = function (sid) {
    const s = surfaces.get(sid); if (!s || s.saves <= 0) return;
    s.ctx.restore();
    s.saves--;
  };

  // ---------------------------------------------------------------- windows
  P.registerWindow = function (rec) {
    const id = nextId++;
    windows.set(id, rec);
    if (rec.canvas) P.registerSurface(id, rec.canvas);
    return id;
  };
  P.unregisterWindow = function (id) { windows.delete(id); surfaces.delete(id); };

  function writeRect(out, l, t, r, b) {
    const o = out >> 3;
    HEAPF64[o] = l; HEAPF64[o + 1] = t; HEAPF64[o + 2] = r; HEAPF64[o + 3] = b;
  }
  P.windowRect = function (wid, client, out) {
    const w = windows.get(wid);
    if (!w) { writeRect(out, 0, 0, 0, 0); return; }
    if (w.kind === 'main') {
      writeRect(out, 0, 0, w.view.width, w.view.height);
    } else if (w.rel) {
      if (client) writeRect(out, 0, 0, w.rel[2] - w.rel[0], w.rel[3] - w.rel[1]);
      else writeRect(out, w.rel[0], w.rel[1], w.rel[2], w.rel[3]);
    } else {
      writeRect(out, 0, 0, 0, 0);
    }
  };
  P.windowSetPosition = function (wid, l, t, r, b, relTo) {
    const w = windows.get(wid); if (!w || w.kind === 'main') return;
    w.rel = [l, t, r, b];
    const base = windows.get(relTo);
    let ox = 0, oy = 0;
    if (base && base.canvas) { const br = base.canvas.getBoundingClientRect(); ox = br.left; oy = br.top; }
    const el = w.el;
    // keep popups (autocompletion list, call tips) inside the visible screen
    const width = Math.min(r - l, window.innerWidth - 4);
    const height = b - t;
    const left = Math.max(2, Math.min(ox + l, window.innerWidth - width - 2));
    el.style.left = left + 'px';
    el.style.top = (oy + t) + 'px';
    el.style.width = width + 'px';
    el.style.height = height + 'px';
    if (w.kind === 'calltip') {
      const s = dpr();
      w.canvas.width = Math.max(1, Math.ceil((r - l) * s));
      w.canvas.height = Math.max(1, Math.ceil((b - t) * s));
      const surf = surfaces.get(wid);
      surf.dpr = s;
      P.invalidateWindow(wid);
    }
  };
  P.windowShow = function (wid, show) {
    const w = windows.get(wid); if (!w || w.kind === 'main') return;
    w.el.style.display = show ? '' : 'none';
    if (show && w.kind === 'calltip') P.invalidateWindow(wid);
  };
  P.invalidateWindow = function (wid, l, t, r, b) {
    const w = windows.get(wid); if (!w) return;
    if (w.kind === 'main') w.view.invalidate(l, t, r, b);
    else if (w.kind === 'calltip' && !w.pending) {
      w.pending = true;
      requestAnimationFrame(() => {
        w.pending = false;
        if (!windows.has(wid)) return;
        const surf = surfaces.get(wid);
        surf.ctx.setTransform(surf.dpr, 0, 0, surf.dpr, 0, 0);
        Module._sci_paint_calltip(w.sci);
      });
    }
  };
  const reverseArrow = 'url("data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="20"><path d="M15 1v15l-4-4-3 6-2-1 3-6H3z" fill="white" stroke="black" stroke-width="1"/></svg>') + '") 15 1, default';
  const cursors = ['', 'text', 'default', 'default', 'wait', 'ew-resize', 'ns-resize', reverseArrow, 'pointer'];
  P.windowCursor = function (wid, c) {
    const w = windows.get(wid); if (!w) return;
    const el = w.kind === 'main' ? w.view.scroller : w.el;
    el.style.cursor = cursors[c] || '';
  };
  P.windowDestroy = function (wid) {
    const w = windows.get(wid); if (!w) return;
    if (w.kind !== 'main' && w.el && w.el.parentNode) w.el.parentNode.removeChild(w.el);
    P.unregisterWindow(wid);
  };
  P.monitorRect = function (wid, out) {
    const w = windows.get(wid);
    let ox = 0, oy = 0;
    if (w && w.canvas) { const r = w.canvas.getBoundingClientRect(); ox = r.left; oy = r.top; }
    writeRect(out, -ox, -oy, window.innerWidth - ox, window.innerHeight - oy);
  };

  // ---------------------------------------------------------------- list box (autocompletion)
  P.listboxCreate = function (lbPtr, fid, lineHeight) {
    const el = document.createElement('div');
    el.className = 'sci-listbox';
    el.style.font = P.fontCss(fid);
    el.style.lineHeight = lineHeight + 'px';
    el.style.display = 'none';
    document.body.appendChild(el);
    const rec = { kind: 'listbox', el, lb: lbPtr, items: [], sel: -1, lineHeight };
    const id = P.registerWindow(rec);
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const row = e.target.closest('.sci-listbox-item');
      if (!row) return;
      const idx = +row.dataset.i;
      P.listboxSelect(id, idx);
      Module._sci_listbox_event(lbPtr, 0, idx);
    });
    el.addEventListener('dblclick', (e) => {
      e.preventDefault();
      const row = e.target.closest('.sci-listbox-item');
      if (!row) return;
      Module._sci_listbox_event(lbPtr, 1, +row.dataset.i);
    });
    return id;
  };
  P.listboxSetItems = function (wid, ptr) {
    const w = windows.get(wid); if (!w) return;
    const text = UTF8ToString(ptr);
    const items = text.split('\n'); items.pop();
    w.items = items;
    w.el.textContent = '';
    const frag = document.createDocumentFragment();
    items.forEach((s, i) => {
      const d = document.createElement('div');
      d.className = 'sci-listbox-item';
      d.dataset.i = i;
      d.textContent = s;
      frag.appendChild(d);
    });
    w.el.appendChild(frag);
  };
  P.listboxSelect = function (wid, n) {
    const w = windows.get(wid); if (!w) return;
    const prev = w.el.children[w.sel];
    if (prev) prev.classList.remove('sel');
    w.sel = n;
    const cur = w.el.children[n];
    if (cur) {
      cur.classList.add('sel');
      if (w.colours) { cur.style.background = w.colours.backSel; cur.style.color = w.colours.foreSel; }
      if (prev && prev !== cur) { prev.style.background = ''; prev.style.color = ''; }
      const top = cur.offsetTop, bottom = top + cur.offsetHeight;
      if (top < w.el.scrollTop) w.el.scrollTop = top;
      else if (bottom > w.el.scrollTop + w.el.clientHeight) w.el.scrollTop = bottom - w.el.clientHeight;
    }
  };
  P.listboxOptions = function (wid, fore, back, foreSel, backSel, rows) {
    const w = windows.get(wid); if (!w) return;
    w.colours = { fore: colour(fore), back: colour(back), foreSel: colour(foreSel), backSel: colour(backSel) };
    w.el.style.color = w.colours.fore;
    w.el.style.background = w.colours.back;
  };

  // ---------------------------------------------------------------- call tip
  P.calltipCreate = function (sci) {
    const el = document.createElement('canvas');
    el.className = 'sci-calltip';
    el.style.display = 'none';
    document.body.appendChild(el);
    const rec = { kind: 'calltip', el, canvas: el, sci };
    const id = P.registerWindow(rec);
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      Module._sci_calltip_click(sci, e.clientX - r.left, e.clientY - r.top);
    });
    return id;
  };

  // ---------------------------------------------------------------- editor services
  const timers = new Map();
  P.timer = function (sci, reason, ms) {
    const key = sci + ':' + reason;
    const old = timers.get(key);
    if (old) { clearInterval(old); timers.delete(key); }
    if (ms > 0) timers.set(key, setInterval(() => { if (views.has(sci)) Module._sci_tick(sci, reason); }, ms));
  };
  const idlers = new Set();
  P.idle = function (sci, on) {
    if (on) {
      if (idlers.has(sci)) return;
      idlers.add(sci);
      const run = () => {
        if (!idlers.has(sci) || !views.has(sci)) { idlers.delete(sci); return; }
        if (Module._sci_idle(sci)) setTimeout(run, 0); else idlers.delete(sci);
      };
      setTimeout(run, 0);
    } else {
      idlers.delete(sci);
    }
  };
  const workQueued = new Set();
  P.idleWork = function (sci) {
    if (workQueued.has(sci)) return;
    workQueued.add(sci);
    setTimeout(() => { workQueued.delete(sci); if (views.has(sci)) Module._sci_idle_work(sci); }, 0);
  };
  P.notify = function (sci, fptr, textPtr) {
    const v = views.get(sci); if (!v) return;
    const o = fptr >> 2, H = HEAP32;
    const n = {
      code: H[o], position: H[o + 1], ch: H[o + 2], modifiers: H[o + 3], modificationType: H[o + 4],
      length: H[o + 5], linesAdded: H[o + 6], message: H[o + 7], wParam: H[o + 8], lParam: H[o + 9],
      line: H[o + 10], foldLevelNow: H[o + 11], foldLevelPrev: H[o + 12], margin: H[o + 13],
      listType: H[o + 14], x: H[o + 15], y: H[o + 16], token: H[o + 17], annotationLinesAdded: H[o + 18],
      updated: H[o + 19], listCompletionMethod: H[o + 20], characterSource: H[o + 21], textPtr
    };
    v._notify(n);
  };
  P.command = function (sci, code) { const v = views.get(sci); if (v) v._command(code); };
  P.copyText = function (sci, ptr, len, rect, line) {
    const v = views.get(sci); if (v) v._copied(decode(ptr, len, true), !!rect, !!line);
  };
  P.scrollbars = function (sci, vMax, vPage, vPos, hMax, hPage, hPos, lh, vVis, hVis) {
    const v = views.get(sci); if (v) v._scrollbars(vMax, vPage, vPos, hMax, hPage, hPos, lh, vVis, hVis);
  };
  P.scrollPos = function (sci, vPos, hPos) { const v = views.get(sci); if (v) v._scrollPos(vPos, hPos); };
  P.capture = function (sci, on) { const v = views.get(sci); if (v) v.captured = !!on; };

  return P;
})();
Module.SciPlat = SciPlat;

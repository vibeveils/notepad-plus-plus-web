"""Phone and tablet checks with real (CDP) touch events. Usage: python3 test/mobile.py docs [outdir]"""
import asyncio, functools, http.server, threading, sys, os, json
from playwright.async_api import async_playwright
root = sys.argv[1]
out = sys.argv[2] if len(sys.argv) > 2 else '/tmp'
class H(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8767), functools.partial(H, directory=root))
threading.Thread(target=srv.serve_forever, daemon=True).start()
results = []
def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))

SAMPLE = r'''#include <stdio.h>

/* Notepad++ on a phone */
int main(int argc, char *argv[]) {
	for (int i = 0; i < argc; i++) {
		printf("arg %d: %s\n", i, argv[i]);
	}
	return 0;
}
'''

async def touch(cdp, kind, points):
    await cdp.send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': [{'x': x, 'y': y, 'id': i} for i, (x, y) in enumerate(points)]})

async def phone(p, b):
    ctx = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=3, is_mobile=True, has_touch=True,
        user_agent='Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36')
    pg = await ctx.new_page()
    errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    await pg.goto('http://127.0.0.1:8767/index.html')
    await pg.wait_for_function('window.ready === true', timeout=20000)
    ev = pg.evaluate
    cdp = await ctx.new_cdp_session(pg)
    cls = await ev("() => document.body.className")
    check('phone: touch + narrow classes', 'touch' in cls and 'narrow' in cls, cls)
    check('phone: menubar hidden, hamburger shown', await ev("() => getComputedStyle(document.getElementById('menubar')).display === 'none' && getComputedStyle(document.querySelector('.tb-menu')).display !== 'none'"))
    check('phone: keyboard not opened at start', await ev("() => document.activeElement !== npp.view.input"))
    await ev("(t) => { npp.setLanguage('cpp'); npp.view.setText(t); npp.send(2025, 0); }", SAMPLE)
    await pg.screenshot(path=f'{out}/m-phone.png')

    # tap places the caret on line 4 and focuses the editor
    r = await ev("() => { const v = npp.view, rc = v.scroller.getBoundingClientRect(); const y = v.send(2165, 0, v.send(2167, 3)); return [rc.left + 120, rc.top + y + 6]; }")
    await touch(cdp, 'touchStart', [r]); await touch(cdp, 'touchEnd', [])
    await pg.wait_for_timeout(150)
    check('phone: tap moves caret', await ev("() => npp.send(2166, npp.send(2008))") == 3)
    check('phone: tap focuses editor (keyboard)', await ev("() => document.activeElement === npp.view.input"))
    check('phone: key bar visible while editing', await ev("() => getComputedStyle(document.getElementById('keybar')).display !== 'none'"))

    # soft-keyboard style input: beforeinput events without key events (Android reports keyCode 229)
    t = await ev("""() => { const v = npp.view; v.send(2025, v.send(2136, 2));  // end of line 3
        const inp = v.input; const fire = (type, data) => inp.dispatchEvent(new InputEvent('beforeinput', {inputType: type, data, cancelable: true, bubbles: true}));
        fire('insertText', ' ok'); fire('deleteContentBackward'); fire('insertLineBreak'); fire('insertText', '//x');
        return v.getRange(v.send(2167, 2), v.send(2136, 3)); }""")
    check('phone: beforeinput insert/delete/newline', t == '/* Notepad++ on a phone */ o\r\n//x', repr(t))
    # IME composition path
    t = await ev("""() => { const v = npp.view, inp = v.input;
        inp.dispatchEvent(new CompositionEvent('compositionstart', {data: ''}));
        inp.dispatchEvent(new CompositionEvent('compositionupdate', {data: 'he'}));
        inp.dispatchEvent(new CompositionEvent('compositionupdate', {data: 'hello'}));
        inp.dispatchEvent(new CompositionEvent('compositionend', {data: 'hello'}));
        return v.getRange(v.send(2167, 3), v.send(2136, 3)); }""")
    check('phone: composition commits once', t == '//xhello', repr(t))
    # key bar: arrows with sticky Sel, symbols
    await ev("() => npp.send(2025, npp.send(2167, 3))")
    await pg.tap('.kb-shift'); await pg.tap('.kb-key[title=Right]'); await pg.tap('.kb-key[title=Right]'); await pg.tap('.kb-shift')
    check('phone: key bar Sel + arrows select', await ev("() => npp.view.getSelText()") == '//', repr(await ev("() => npp.view.getSelText()")))
    await pg.tap('.kb-key.sym >> text="{"')
    check('phone: key bar symbol replaces selection', await ev("() => npp.view.getRange(npp.send(2167,3), npp.send(2136,3))") == '{xhello')
    check('phone: still focused after key bar taps', await ev("() => document.activeElement === npp.view.input"))

    # long-press selects a word and shows the selection bar; dragging extends
    r = await ev("() => { const v = npp.view, rc = v.scroller.getBoundingClientRect(); const pos = v.send(2167, 5) + 3; return [rc.left + v.send(2164, 0, pos) + 3, rc.top + v.send(2165, 0, pos) + 6]; }")
    await touch(cdp, 'touchStart', [r])
    await pg.wait_for_timeout(650)
    sel1 = await ev("() => npp.view.getSelText()")
    await touch(cdp, 'touchMove', [[r[0] + 90, r[1]]])
    await touch(cdp, 'touchMove', [[r[0] + 120, r[1]]])
    await pg.wait_for_timeout(50)
    sel2 = await ev("() => npp.view.getSelText()")
    await touch(cdp, 'touchEnd', [])
    await pg.wait_for_timeout(150)
    check('phone: long-press selects word', sel1 == 'for', repr(sel1))
    check('phone: drag extends selection', len(sel2) > len(sel1) and sel2.startswith('for'), repr(sel2))
    check('phone: selection bar shown', await ev("() => !document.getElementById('touchbar').hidden"))
    await pg.screenshot(path=f'{out}/m-phone-select.png')
    await pg.tap('.tbar-btn >> text=Select All')
    check('phone: selection bar Select All', await ev("() => npp.send(2143) === 0 && npp.send(2145) === npp.send(2006)"))
    await ev("() => npp.send(2025, 0)")

    # pinch zoom
    z0 = await ev("() => npp.send(2374)")
    await touch(cdp, 'touchStart', [[150, 400], [240, 400]])
    for d in range(10):
        await touch(cdp, 'touchMove', [[150 - d * 8, 400], [240 + d * 8, 400]])
    await touch(cdp, 'touchEnd', [])
    z1 = await ev("() => npp.send(2374)")
    check('phone: pinch zooms in', z1 > z0, f'{z0} -> {z1}')
    await ev("() => npp.send(2373, 0)")

    # one-finger drag scrolls natively (no selection)
    await ev("() => { npp.view.setText(Array.from({length: 300}, (_, i) => 'line ' + i).join('\\n')); npp.send(2025, 0); }")
    await touch(cdp, 'touchStart', [[200, 600]])
    for d in range(1, 12): await touch(cdp, 'touchMove', [[200, 600 - d * 30]])
    await touch(cdp, 'touchEnd', [])
    await pg.wait_for_timeout(300)
    check('phone: drag scrolls, no selection', await ev("() => npp.send(2152) > 3 && npp.send(2650)"), await ev("() => [npp.send(2152), npp.view.getSelText()]"))
    await ev("(t) => { npp.view.setText(t); npp.send(2025, 0); }", SAMPLE)

    # hamburger -> drill-down menus
    await ev("() => npp.view.input.blur()")
    await pg.tap('.tb-menu')
    await pg.wait_for_timeout(100)
    await pg.screenshot(path=f'{out}/m-phone-menu.png')
    await pg.tap('.menu-item >> text=Edit')
    await pg.wait_for_timeout(100)
    await pg.tap('.menu-item >> text=Line Operations')
    await pg.wait_for_timeout(100)
    vis = await ev("() => Array.from(document.querySelectorAll('.menu-popup')).map(p => [getComputedStyle(p).visibility, Math.round(p.getBoundingClientRect().right)])")
    check('phone: drill-down shows one menu at a time, on screen', [v[0] for v in vis] == ['hidden', 'hidden', 'visible'] and all(v[1] <= 390 for v in vis), repr(vis))
    await pg.screenshot(path=f'{out}/m-phone-submenu.png')
    await pg.locator('.menu-back').last.tap()
    check('phone: back returns to parent', await ev("() => Array.from(document.querySelectorAll('.menu-popup')).filter(p => getComputedStyle(p).visibility === 'visible').length") == 1)
    await pg.tap('.menu-item >> text=Select All')
    check('phone: menu command runs', await ev("() => npp.send(2145) - npp.send(2143) === npp.send(2006)"))

    # find dialog as a bottom sheet
    await ev("() => npp.run('search.find')")
    await pg.wait_for_timeout(200)
    r = await ev("() => { const d = document.querySelector('.find-dlg').getBoundingClientRect(); return [d.left, Math.round(d.width), Math.round(d.bottom), innerHeight]; }")
    check('phone: find dialog is a full-width bottom sheet', r[0] == 0 and r[1] == 390 and abs(r[2] - r[3]) <= 1, repr(r))
    await pg.fill('.find-dlg .fr-row input', 'printf')
    await pg.tap('.find-dlg .btn >> text=Count')
    check('phone: find works from the sheet', 'Count: 1 match' in await ev("() => npp.find.status.textContent"))
    await pg.screenshot(path=f'{out}/m-phone-find.png')
    await pg.tap('.find-dlg .dlg-x')

    # tab long-press menu
    await ev("() => npp.newFile('second')")
    tab = await pg.query_selector('.tab')
    bb = await tab.bounding_box()
    await touch(cdp, 'touchStart', [[bb['x'] + 30, bb['y'] + 15]])
    await pg.wait_for_timeout(650)
    await touch(cdp, 'touchEnd', [])
    await pg.wait_for_timeout(100)
    check('phone: long-press tab opens tab menu', await ev("() => !!Array.from(document.querySelectorAll('.menu-item')).find(m => m.textContent.includes('Close All BUT This'))"))
    await ev("() => document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}))")
    # a normal tap on another tab still switches after a long-press
    tabs = await pg.query_selector_all('.tab')
    bb2 = await tabs[1].bounding_box()
    await touch(cdp, 'touchStart', [[bb2['x'] + 30, bb2['y'] + 15]]); await touch(cdp, 'touchEnd', [])
    await pg.wait_for_timeout(100)
    bb = await (await pg.query_selector_all('.tab'))[0].bounding_box()
    await touch(cdp, 'touchStart', [[bb['x'] + 30, bb['y'] + 15]]); await touch(cdp, 'touchEnd', [])
    await pg.wait_for_timeout(100)
    check('phone: tab taps switch documents', await ev("() => npp.buffers.indexOf(npp.current)") == 0)
    check('phone: switching tabs does not open the keyboard', await ev("() => document.activeElement !== npp.view.input"))

    # dark mode on phone, for a screenshot
    await ev("async () => { await npp.setDarkMode(true); npp.activate(npp.buffers[0]); }")
    await ev("() => { npp.view.focus(); document.body.classList.add('editor-focus'); }")
    await pg.wait_for_timeout(200)
    await pg.screenshot(path=f'{out}/m-phone-dark.png')
    await ev("async () => { await npp.setDarkMode(false); }")
    check('phone: no page errors', not errors, '\n'.join(errors[:5]))
    await ctx.close()

async def tablet(p, b):
    ctx = await b.new_context(viewport={'width': 1180, 'height': 820}, device_scale_factor=2, is_mobile=True, has_touch=True,
        user_agent='Mozilla/5.0 (Linux; Android 14; Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36')
    pg = await ctx.new_page()
    errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    await pg.goto('http://127.0.0.1:8767/index.html')
    await pg.wait_for_function('window.ready === true', timeout=20000)
    ev = pg.evaluate
    cls = await ev("() => document.body.className")
    check('tablet: touch but not narrow', 'touch' in cls and 'narrow' not in cls, cls)
    check('tablet: full menubar', await ev("() => getComputedStyle(document.getElementById('menubar')).display !== 'none'"))
    await ev("(t) => { npp.setLanguage('cpp'); npp.view.setText(t); }", SAMPLE)
    await pg.tap('.menubar-item >> text=Search')
    await pg.wait_for_timeout(100)
    h = await ev("() => document.querySelector('.menu-item').getBoundingClientRect().height")
    check('tablet: touch-sized menu rows', h >= 40, str(h))
    await pg.screenshot(path=f'{out}/m-tablet.png')
    await ev("() => document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}))")
    # portrait tablet switches to the narrow layout
    await pg.set_viewport_size({'width': 744, 'height': 1133})
    await pg.wait_for_timeout(200)
    check('tablet portrait: narrow layout', 'narrow' in await ev("() => document.body.className"))
    await pg.screenshot(path=f'{out}/m-tablet-portrait.png')
    check('tablet: no page errors', not errors, '\n'.join(errors[:5]))
    await ctx.close()

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        await phone(p, b)
        await tablet(p, b)
        await b.close()
asyncio.run(main())
srv.shutdown()
for name, passed, detail in results:
    print(('PASS ' if passed else 'FAIL ') + name + ('' if passed else '  -> ' + detail))
print(f"{sum(1 for r in results if r[1])}/{len(results)} passed")

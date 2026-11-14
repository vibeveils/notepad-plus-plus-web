import asyncio, functools, http.server, threading, json, sys
from playwright.async_api import async_playwright
root = sys.argv[1]
class H(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8766), functools.partial(H, directory=root))
threading.Thread(target=srv.serve_forever, daemon=True).start()
results = []
def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        ctx = await b.new_context(viewport={'width': 1100, 'height': 700})
        pg = await ctx.new_page()
        errors = []
        pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' and '404' not in m.text else None)
        await pg.goto('http://127.0.0.1:8766/index.html')
        await pg.wait_for_function('window.ready === true', timeout=20000)
        ev = pg.evaluate
        # 1. typing with smart indent and outdent in C++
        await ev("() => npp.setLanguage('cpp')")
        await pg.mouse.click(500, 300)
        await pg.keyboard.type('int main() {\nreturn 0;\n}')
        t = await ev("() => npp.view.getText()")
        check('smart indent + outdent', t == 'int main() {\r\n\treturn 0;\r\n}', repr(t))
        # 2. undo all
        for _ in range(30): await pg.keyboard.press('Control+z')
        check('undo to empty', await ev("() => npp.view.getText()") == '')
        # 3. line ops: sort, remove dup, case
        await ev("() => { npp.view.setText('pear\\r\\napple\\r\\npear\\r\\nBanana'); npp.run('edit.sortCiAsc'); }")
        check('sort ignoring case', await ev("() => npp.view.getText()") == 'apple\r\nBanana\r\npear\r\npear')
        await ev("() => npp.run('edit.removeDup')")
        check('remove duplicate lines', await ev("() => npp.view.getText()") == 'apple\r\nBanana\r\npear')
        await ev("() => { npp.send(2013); npp.run('edit.upper'); }")
        check('uppercase selection', await ev("() => npp.view.getText()") == 'APPLE\r\nBANANA\r\nPEAR')
        await ev("() => { npp.send(2013); npp.run('edit.proper'); }")
        check('proper case', await ev("() => npp.view.getText()") == 'Apple\r\nBanana\r\nPear')
        # 4. comment toggle (C++ //)
        await ev("() => { npp.send(2013); npp.run('edit.commentToggle'); }")
        check('toggle comment on', await ev("() => npp.view.getText()") == '// Apple\r\n// Banana\r\n// Pear')
        await ev("() => { npp.send(2013); npp.run('edit.commentToggle'); }")
        check('toggle comment off', await ev("() => npp.view.getText()") == 'Apple\r\nBanana\r\nPear')
        # 5. regex replace all with backreference
        r = await ev("""() => { const f = npp.find; f.opts.mode='regex'; f.opts.text='(\\\\w)(\\\\w+)'; f.opts.replace='$2$1';
           f.build(); f.switchTab('replace'); f.findInput.value=f.opts.text; f.replaceInput.value=f.opts.replace; f.replaceAll(false);
           return [npp.view.getText(), f.status.textContent]; }""")
        check('regex replace all ($2$1)', r[0] == 'ppleA\r\nananaB\r\nearP', repr(r))
        # 6. invalid regex does not crash
        r = await ev("""() => { const f = npp.find; f.findInput.value='(unclosed'; f.count(); return f.status.textContent; }""")
        check('invalid regex reported', 'Invalid' in r, r)
        # 7. macro record + playback
        await ev("() => { npp.setLanguage('normal'); npp.view.setText(''); }")
        await pg.mouse.click(500, 300)
        await ev("() => npp.run('macro.start')")
        await pg.keyboard.type('ab')
        await pg.keyboard.press('Enter')
        await ev("() => npp.run('macro.stop')")
        await ev("() => npp.playMacro(npp.macro, 2)")
        t = await ev("() => npp.view.getText()")
        check('macro playback x2', t == 'ab\r\nab\r\nab\r\n', repr(t))
        # 8. EOL conversion
        await ev("() => npp.run('edit.eolLf')")
        check('EOL to LF', await ev("() => npp.view.getText()") == 'ab\nab\nab\n')
        # 9. encodings round trip
        r = await ev("""async () => { const m = await import('./js/encoding.js');
            const s = 'héllo ✓ 日本';
            const out = {};
            for (const e of ['utf-8','utf-8-bom','utf-16le','utf-16be']) { const b = m.encodeText(s, e); const d = m.decodeBytes(b); out[e] = d.text === s && d.encoding === e; }
            const a = m.decodeBytes(new Uint8Array([0x63,0x61,0x66,0xE9])); out.ansi = a.text === 'café' && a.encoding === 'ansi';
            return out; }""")
        check('encoding round trips', all(r.values()), json.dumps(r))
        # 10. bookmarks
        await ev("() => { npp.send(2024, 1); npp.run('search.toggleBookmark'); npp.send(2024, 0); npp.run('search.nextBookmark'); }")
        check('bookmark next', await ev("() => npp.send(2166, npp.send(2008))") == 1)
        # 11. tabs: new, switch, dirty state
        await ev("() => { npp.newFile('second doc', 'python'); }")
        check('two tabs', await ev("() => npp.buffers.length") == 2)
        check('dirty first tab', await ev("() => npp.buffers[0].dirty") == True)
        await ev("() => npp.activate(npp.buffers[0])")
        check('doc switch keeps text', await ev("() => npp.view.getText()") == 'ab\nab\nab\n')
        # 12. hashes
        r = await ev("""async () => { const m = await import('./js/md5.js'); return [m.md5(new TextEncoder().encode('')), m.md5(new TextEncoder().encode('The quick brown fox jumps over the lazy dog'))]; }""")
        check('md5', r == ['d41d8cd98f00b204e9800998ecf8427e', '9e107d9d372bb6826bd81d3542a419d6'], repr(r))
        # 13. lexers present
        check('lexilla lexer count', await ev("() => npp.M._lexilla_count()") > 120)
        # 14. session restore after reload
        await ev("() => npp.saveSession()")
        await pg.wait_for_timeout(500)
        await pg.reload()
        await pg.wait_for_function('window.ready === true', timeout=20000)
        r = await ev("() => [npp.buffers.length, npp.buffers.map(b => b.name), npp.buffers[1] && npp.buffers[1].lang, npp.view.getText(), npp.buffers[0].dirty]")
        check('session restored', r[0] == 2 and r[2] == 'python' and r[3] == 'ab\nab\nab\n' and r[4] is True, repr(r))
        # 15. every language applies without errors
        r = await ev("""() => { const bad = []; for (const l of npp.config.languages) { if (!npp.config.langs.has(l.name)) continue; try { npp.setLanguage(l.name); } catch (e) { bad.push(l.name + ': ' + e.message); } } npp.setLanguage('normal'); return bad; }""")
        check('all languages apply', not r, repr(r))
        # 16. every theme loads
        r = await ev("""async () => { const bad = []; for (const t of npp.config.themes) { try { await npp.config.setTheme(t); npp.applyTheme(); } catch (e) { bad.push(t + ': ' + e.message); } } await npp.config.setTheme('stylers.xml'); npp.applyTheme(); return bad; }""")
        check('all themes load', not r, repr(r))
        check('no page errors', not errors, '\n'.join(errors[:5]))
        await b.close()
asyncio.run(main())
srv.shutdown()
ok = sum(1 for r in results if r[1])
for name, passed, detail in results:
    print(('PASS ' if passed else 'FAIL ') + name + ('' if passed else '  -> ' + detail))
print(f'{ok}/{len(results)} passed')

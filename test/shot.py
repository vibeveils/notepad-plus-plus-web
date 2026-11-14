import asyncio, sys, functools, http.server, threading
from playwright.async_api import async_playwright
root, page_name, out = sys.argv[1], sys.argv[2], sys.argv[3]
actions = sys.argv[4] if len(sys.argv) > 4 else ''
class H(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store'); super().end_headers()
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8765), functools.partial(H, directory=root))
threading.Thread(target=srv.serve_forever, daemon=True).start()
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        pg = await b.new_page(viewport={'width': 1100, 'height': 700}, device_scale_factor=1)
        logs = []
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}'))
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        await pg.goto(f'http://127.0.0.1:8765/{page_name}')
        try:
            await pg.wait_for_function('window.ready === true', timeout=15000)
        except Exception as e:
            logs.append('TIMEOUT waiting for ready')
        await pg.wait_for_timeout(400)
        if actions:
            exec(compile('async def _act(pg):\n' + '\n'.join('    ' + l for l in actions.split('\n')), 'act', 'exec'), globals())
            await _act(pg)
            await pg.wait_for_timeout(300)
        await pg.screenshot(path=out)
        for l in logs[:40]: print(l)
        await b.close()
asyncio.run(main())
srv.shutdown()

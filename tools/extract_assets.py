"""Convert Notepad++ icons and copy XML config (langs, stylers, themes, APIs) into docs/."""
import os, sys, shutil, glob
from PIL import Image
npp, out = sys.argv[1], sys.argv[2]
src = os.path.join(npp, 'PowerEditor', 'src')
inst = os.path.join(npp, 'PowerEditor', 'installer')

def ico_png(path, dest, size):
    im = Image.open(path)
    sizes = im.ico.sizes()
    best = min(sizes, key=lambda s: (abs(s[0] - size), -s[0]))
    im.size = best
    im = im.convert('RGBA')
    if im.size != (size, size):
        im = im.resize((size, size), Image.LANCZOS)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    im.save(dest)

for theme in ('light', 'dark'):
    for f in glob.glob(os.path.join(src, 'icons', theme, 'toolbar', 'filled', '*.ico')):
        name = os.path.splitext(os.path.basename(f))[0]
        ico_png(f, os.path.join(out, 'img', 'toolbar', theme, name + '.png'), 32)
for d in ('standard', 'dark'):
    for f in glob.glob(os.path.join(src, 'icons', d, 'tabbar', '*.ico')):
        name = os.path.splitext(os.path.basename(f))[0]
        ico_png(f, os.path.join(out, 'img', 'tabbar', 'light' if d == 'standard' else 'dark', name + '.png'), 16)
ico_png(os.path.join(src, 'icons', 'npp.ico'), os.path.join(out, 'img', 'npp-32.png'), 32)
ico_png(os.path.join(src, 'icons', 'npp.ico'), os.path.join(out, 'img', 'npp-256.png'), 256)
ico_png(os.path.join(src, 'icons', 'npp.ico'), os.path.join(out, 'favicon.png'), 64)
ico_png(os.path.join(src, 'icons', 'standard', 'about', 'chameleon.ico'), os.path.join(out, 'img', 'chameleon.png'), 128)

cfg = os.path.join(out, 'config')
os.makedirs(os.path.join(cfg, 'themes'), exist_ok=True)
shutil.copy(os.path.join(src, 'langs.model.xml'), os.path.join(cfg, 'langs.xml'))
shutil.copy(os.path.join(src, 'stylers.model.xml'), os.path.join(cfg, 'stylers.xml'))
names = []
for f in sorted(glob.glob(os.path.join(inst, 'themes', '*.xml'))):
    shutil.copy(f, os.path.join(cfg, 'themes', os.path.basename(f)))
    names.append(os.path.basename(f))
with open(os.path.join(cfg, 'themes', 'index.json'), 'w') as fh:
    import json; json.dump(names, fh)
os.makedirs(os.path.join(cfg, 'autoCompletion'), exist_ok=True)
apis = []
for f in sorted(glob.glob(os.path.join(inst, 'APIs', '*.xml'))):
    shutil.copy(f, os.path.join(cfg, 'autoCompletion', os.path.basename(f)))
    apis.append(os.path.basename(f))
with open(os.path.join(cfg, 'autoCompletion', 'index.json'), 'w') as fh:
    json.dump(apis, fh)
shutil.copy(os.path.join(npp, 'LICENSE'), os.path.join(out, 'LICENSE.txt'))
print('ok', len(names), 'themes', len(apis), 'api files')

# Language table from ScintillaEditView.cpp (_langNameInfoArray), in LangType order
import re, json, base64
sev = open(os.path.join(src, 'ScintillaComponent', 'ScintillaEditView.cpp'), encoding='utf-8').read()
block = sev[sev.index('_langNameInfoArray[L_EXTERNAL + 1] = {'):]
block = block[:block.index('};')]
langs = []
for m in re.finditer(r'\{L"([^"]*)",\s*L"([^"]*)",\s*L"([^"]*)",\s*(L_\w+),\s*"([^"]*)"\}', block):
    langs.append({'name': m.group(1), 'short': m.group(2), 'long': m.group(3), 'id': m.group(4), 'lexer': m.group(5)})
with open(os.path.join(cfg, 'languages.json'), 'w') as fh:
    json.dump(langs, fh, indent=0)

# RGBA marker images (bookmark etc.) from rgba_icons.h
hdr = open(os.path.join(src, 'rgba_icons.h'), encoding='utf-8', errors='replace').read()
icons = {}
for m in re.finditer(r'static const unsigned char (\w+)\[(\d+)\]\s*=\s*\{(.*?)\};', hdr, re.S):
    vals = [int(v, 0) for v in re.findall(r'0x[0-9A-Fa-f]+|\b\d+\b', m.group(3))]
    icons[m.group(1)] = base64.b64encode(bytes(vals)).decode()
with open(os.path.join(cfg, 'rgba_icons.json'), 'w') as fh:
    json.dump(icons, fh)
print(len(langs), 'languages', len(icons), 'rgba icons')

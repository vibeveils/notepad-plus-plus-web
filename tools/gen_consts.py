"""Generate docs/js/sci-consts.js from Scintilla.iface and SciLexer.h."""
import re, sys, json
npp = sys.argv[1]
out = {}
for line in open(f"{npp}/scintilla/include/Scintilla.iface", encoding="utf-8"):
    m = re.match(r"(fun|get|set)\s+\S+\s+(\w+)=(\d+)\(", line)
    if m:
        out["SCI_" + m.group(2).upper()] = int(m.group(3)); continue
    m = re.match(r"evt\s+\S+\s+(\w+)=(\d+)\(", line)
    if m:
        out["SCN_" + m.group(1).upper()] = int(m.group(2)); continue
    m = re.match(r"val\s+(\w+)=(-?(?:0x[0-9A-Fa-f]+|\d+))", line)
    if m:
        out[m.group(1)] = int(m.group(2), 0)
for line in open(f"{npp}/lexilla/include/SciLexer.h", encoding="utf-8"):
    m = re.match(r"#define\s+(SCE_\w+|SCLEX_\w+)\s+(-?\d+)", line)
    if m:
        out[m.group(1)] = int(m.group(2))
with open(sys.argv[2], "w") as f:
    f.write("// Generated from Scintilla.iface and SciLexer.h by tools/gen_consts.py\n")
    f.write("export const SC = " + json.dumps(out, separators=(",", ":")) + ";\n")
print(len(out), "constants")

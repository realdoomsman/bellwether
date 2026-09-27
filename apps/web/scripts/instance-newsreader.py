"""Instance Newsreader for display use: opsz fixed at 60, wght kept variable 300-500, Latin only.

Run from the repo root after `npm install`:
    python apps/web/scripts/instance-newsreader.py
Requires fontTools and brotli (pip install fonttools brotli). Output is committed.
"""
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = Path(__file__).resolve().parents[3]
SRC = ROOT / "node_modules/@fontsource-variable/newsreader/files/newsreader-latin-opsz-normal.woff2"
OUT = ROOT / "apps/web/src/assets/fonts/newsreader-display.woff2"

font = TTFont(SRC)
font = instancer.instantiateVariableFont(font, {"opsz": 60, "wght": (300, 500)})
font.flavor = "woff2"
OUT.parent.mkdir(parents=True, exist_ok=True)
font.save(OUT)
print(f"{OUT.relative_to(ROOT)}: {OUT.stat().st_size} bytes")

"""Generates the app icons from build/logo.svg: white logo on a blue rounded square.

Run it again after changing the logo and commit the results:

    pip install cairosvg pillow
    python3 packages/desktop/scripts/icons.py

Writes
- build/icon.svg, build/icon.png (1024 px), build/icon.icns: macOS and Linux. The square follows Apple's icon grid
  (824 px on a 1024 px canvas) so the icon is as large as other apps in the Dock.
- build/mark.svg, build/icon.ico: Windows, the handbook, the UI. The square fills the canvas and the logo is larger,
  so it stays recognizable at 16 px.
- guide/public/favicon.svg and packages/ui/src/logo.svg: copies of the mark.
"""

import io
import re
import shutil
from pathlib import Path

import cairosvg
from PIL import Image

BLUE = "#1d4ed8"
desktop = Path(__file__).resolve().parent.parent
build = desktop / "build"
root = desktop.parent.parent

path = re.search(r'<path[^>]* d="([^"]+)"', (build / "logo.svg").read_text()).group(1)

# The logo's viewBox is 80 x 80.
icon = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img"><title>Lotse</title>'
    f'<rect x="100" y="100" width="824" height="824" rx="185" fill="{BLUE}"/>'
    f'<path fill="#fff" transform="translate(232 232) scale(7)" d="{path}"/></svg>\n'
)
mark = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img"><title>Lotse</title>'
    f'<rect width="64" height="64" rx="14" fill="{BLUE}"/>'
    f'<path fill="#fff" transform="translate(6 6) scale(0.65)" d="{path}"/></svg>\n'
)
(build / "icon.svg").write_text(icon)
(build / "mark.svg").write_text(mark)
shutil.copy(build / "mark.svg", root / "guide" / "public" / "favicon.svg")
shutil.copy(build / "mark.svg", root / "packages" / "ui" / "src" / "logo.svg")


def render(svg: str, size: int) -> Image.Image:
    png = cairosvg.svg2png(bytestring=svg.encode(), output_width=size, output_height=size)
    return Image.open(io.BytesIO(png)).convert("RGBA")


big = render(icon, 1024)
big.save(build / "icon.png")
big.save(build / "icon.icns")
# Each size rendered from the vector instead of scaled down, so small sizes stay sharp.
sizes = [16, 24, 32, 48, 64, 128, 256]
small = [render(mark, s) for s in sizes]
small[-1].save(build / "icon.ico", sizes=[(s, s) for s in sizes], append_images=small[:-1])

#!/usr/bin/env python3
"""Bake the planets' maps for the view from space (src/space/solar.js) from Solar System Scope's textures.

Source: Solar System Scope, "Solar Textures" (https://www.solarsystemscope.com/textures/), distributed under
Creative Commons Attribution 4.0 International; made from NASA's elevation and imagery data. The files, as
that page names them:

    2k_mercury.jpg  2k_venus_atmosphere.jpg  8k_mars.jpg  8k_jupiter.jpg  8k_saturn.jpg
    2k_uranus.jpg   2k_neptune.jpg           8k_saturn_ring_alpha.png

Usage:  python3 tools/bake-planets.py <folder holding those files>

Writes into public/data/planets/:
    mercury.jpg venus.jpg uranus.jpg neptune.jpg   2048 x 1024, plate carree, north up, as they are
    mars.jpg jupiter.jpg saturn.jpg                4096 x 2048 (Mars reduced from 8192; the other two are that size already)
    saturn_rings.png                               4096 x 4, RGBA: color and opacity along a radius of the rings,
                                                   the strip's own rows averaged
and prints the radii the strip spans, which solar.js needs to lay it down in the right place (found from the
C ring's inner edge, 74,658 km from Saturn's center, and the A ring's outer edge, 136,775 km).
"""
import os, shutil, sys
import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'data', 'planets')
COPY = {'2k_mercury.jpg': 'mercury.jpg', '2k_venus_atmosphere.jpg': 'venus.jpg', '2k_uranus.jpg': 'uranus.jpg', '2k_neptune.jpg': 'neptune.jpg',
        '8k_jupiter.jpg': 'jupiter.jpg', '8k_saturn.jpg': 'saturn.jpg'}
BIG = (4096, 2048)


def main():
    d = sys.argv[1]
    os.makedirs(OUT, exist_ok=True)
    for src, dst in COPY.items():
        im = Image.open(os.path.join(d, src))
        if im.size[0] > BIG[0]: im.convert('RGB').resize(BIG, Image.LANCZOS).save(os.path.join(OUT, dst), quality=88, subsampling=1)
        else: shutil.copyfile(os.path.join(d, src), os.path.join(OUT, dst))
        print('%-14s %d x %d' % (dst, min(im.size[0], BIG[0]), min(im.size[1], BIG[1])))
    Image.open(os.path.join(d, '8k_mars.jpg')).convert('RGB').resize(BIG, Image.LANCZOS).save(os.path.join(OUT, 'mars.jpg'), quality=88, subsampling=1)
    print('%-14s %d x %d' % ('mars.jpg', *BIG))

    ring = np.asarray(Image.open(os.path.join(d, '8k_saturn_ring_alpha.png')).convert('RGBA'), dtype=np.float64)
    row = ring.mean(axis=0)                                   # one value per radius
    a = row[:, 3]
    solid = np.nonzero(a > 6)[0]
    dense = np.nonzero(a > 100)[0]                              # (beyond the A ring's edge the strip carries the faint F ring)
    u0, u1 = solid[0] / len(a), (dense[-1] + 1) / len(a)
    # Where the strip is clear its color is white, which would bleed into the rings' edges when the picture is
    # filtered: give those texels the color of the nearest ring material instead.
    rgb = row[:, :3].copy()
    last = rgb[solid[0]]
    for i in range(len(a)):
        if a[i] > 6: last = rgb[i]
        else: rgb[i] = last
    strip = np.concatenate([rgb, a[:, None]], axis=1).reshape(1, -1, 4)
    out = Image.fromarray(np.clip(strip, 0, 255).astype(np.uint8), 'RGBA').resize((4096, 1), Image.LANCZOS).resize((4096, 4), Image.NEAREST)
    out.save(os.path.join(OUT, 'saturn_rings.png'), optimize=True)
    km0, km1 = 74658.0, 136775.0
    per = (km1 - km0) / (u1 - u0)
    print('saturn_rings.png 4096 x 4: the C ring begins at u = %.4f, the A ring ends at %.4f; the strip spans %.0f km to %.0f km from the center' % (u0, u1, km0 - u0 * per, km0 + (1 - u0) * per))


if __name__ == '__main__':
    main()

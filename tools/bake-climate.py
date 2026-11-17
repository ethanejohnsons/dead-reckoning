#!/usr/bin/env python3
"""Bakes public/data/climate.bin: how wet the lowlands are (0 desert .. 1 wet forest) all over the earth, half a
degree to the cell, for src/world/terrain.js (lowlandMoisture: everywhere but North America, which has a map
drawn by hand there).

There is no rainfall in it: the number is read off the color of the ground in the game's own satellite
picture (Sentinel-2 cloudless by EOX, the 128 tiles of zoom 4... see ZOOM), which is the ground the player
will see: dark green country is wet, pale and tan country dry. The scale is fitted to the hand-drawn map of
North America, so the two agree where they meet. The sea is told from the land with the elevation tiles
(Mapzen terrain on AWS), and cells of open sea take the value of the nearest land.

    python3 tools/bake-climate.py [CACHE_DIR]        (the tiles are kept in CACHE_DIR, default /tmp/dr-world-bake/climate)

The file: one byte a cell (moisture * 255), W x H = 720 x 290, rows from LAT_TOP (north) down in steps of half
a degree, columns from 180 W eastward: the cell [j][i] is centered at LAT_TOP - 0.25 - j / 2, -179.75 + i / 2.
"""
import io, math, os, sys, time, urllib.request
import numpy as np
from PIL import Image

ZOOM = 4
LAT_TOP, LAT_BOTTOM, STEP = 80.0, -65.0, 0.5
W, H = int(360 / STEP), int((LAT_TOP - LAT_BOTTOM) / STEP)
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
OUT = os.path.join(ROOT, 'public', 'data', 'climate.bin')
CACHE = sys.argv[1] if len(sys.argv) > 1 else '/tmp/dr-world-bake/climate'
S2 = 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg'
DEM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'


def tile(kind, url, z, x, y):
    path = os.path.join(CACHE, f'{kind}_{z}_{x}_{y}')
    if not os.path.exists(path):
        req = urllib.request.Request(url.format(z=z, x=x, y=y), headers={'User-Agent': 'climate-grid-bake/1.0'})
        with urllib.request.urlopen(req, timeout=60) as r:
            data = r.read()
        with open(path, 'wb') as f:
            f.write(data)
        time.sleep(0.05)
    return Image.open(path)


def mosaic(kind, url, mode):
    n = 2 ** ZOOM
    img = Image.new(mode, (256 * n, 256 * n))
    for y in range(n):
        for x in range(n):
            img.paste(tile(kind, url, ZOOM, x, y).convert(mode), (x * 256, y * 256))
    return np.asarray(img).astype(np.float32)


def linear(c):
    c = c / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def cells():
    """Mean linear color of the land in each cell, and the share of the cell that is land."""
    os.makedirs(CACHE, exist_ok=True)
    rgb = linear(mosaic('s2', S2, 'RGB'))
    d = mosaic('dem', DEM, 'RGB')
    land = (d[..., 0] * 256 + d[..., 1] + d[..., 2] / 256 - 32768) > 0.5
    size = rgb.shape[0]
    col = np.zeros((H, W, 3), np.float32)
    share = np.zeros((H, W), np.float32)
    # the picture's rows for each row of cells (Mercator), its columns for each column
    def row(lat):
        return (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * size
    for j in range(H):
        y0, y1 = int(row(LAT_TOP - j * STEP)), max(int(row(LAT_TOP - (j + 1) * STEP)), int(row(LAT_TOP - j * STEP)) + 1)
        for i in range(W):
            x0, x1 = int(i * STEP / 360 * size), max(int((i + 1) * STEP / 360 * size), int(i * STEP / 360 * size) + 1)
            m = land[y0:y1, x0:x1]
            share[j, i] = m.mean()
            if m.any():
                col[j, i] = rgb[y0:y1, x0:x1][m].mean(axis=0)
    return col, share


def features(col):
    """What of a cell's color says how wet it is: how green it is of its brightness, and how dark."""
    r, g, b = col[..., 0], col[..., 1], col[..., 2]
    s = r + g + b + 1e-4
    return (2 * g - r - b) / s, np.sqrt(s / 3)


def hand_drawn(lat, lon):
    """terrain.js's lowlandMoisture for North America, as far as the fit needs it (east of the Rockies, west of them)."""
    def along(t, x):
        if x <= t[0][0]:
            return t[0][1]
        for a, b in zip(t, t[1:]):
            if x <= b[0]:
                return a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0])
        return t[-1][1]
    ss = lambda a, b, x: (lambda t: t * t * (3 - 2 * t))(min(1.0, max(0.0, (x - a) / (b - a))))
    if lon > -104:
        m = along([(-104, 0.28), (-100, 0.33), (-97, 0.4), (-94, 0.52), (-90, 0.66), (-84, 0.72), (-70, 0.74)], lon)
        edge = along([(-115, 54.2), (-110, 53.6), (-105, 53.2), (-101, 52), (-98, 51), (-96, 48.6), (-92, 44.4)], lon)
        m = max(m, 0.78 * ss(edge - 0.5, edge + 0.5, lat))
        return max(m, 0.62 * ss(20.5, 17.5, lat))
    m = 0.26 - 0.11 * ss(38, 33, lat) + 0.03 * ss(44, 48, lat)
    return max(m, 0.74 * ss(53.2, 54.6, lat))


def main():
    col, share = cells()
    green, light = features(col)
    # Fit moisture = a + b * green + c * light to the hand-drawn map over the plains, deserts and woods of North
    # America between the Rockies' foot and the Atlantic and in the dry West (not the mountains, whose forests the
    # hand-drawn map leaves to the relief, nor the Pacific slope).
    rows, want = [], []
    for j in range(H):
        lat = LAT_TOP - (j + 0.5) * STEP
        for i in range(W):
            lon = -180 + (i + 0.5) * STEP
            if share[j, i] < 0.9 or not (26 < lat < 58) or not (-116 < lon < -66) or (-112 < lon < -104):
                continue
            rows.append([1, green[j, i], light[j, i]])
            want.append(hand_drawn(lat, lon))
    A, y = np.array(rows), np.array(want)
    k, *_ = np.linalg.lstsq(A, y, rcond=None)
    print(f'fit on {len(y)} cells: moisture = {k[0]:.3f} + {k[1]:.3f} green + {k[2]:.3f} light, rms error {np.sqrt(((A @ k - y) ** 2).mean()):.3f}')
    m = np.clip(k[0] + k[1] * green + k[2] * light, 0.05, 0.9)
    # Ice and snow (bright and without color) say nothing of the ground: middling.
    m[(light > 0.75) & (np.abs(green) < 0.03)] = 0.5
    # The sea takes the nearest land's value, a ring of cells at a time; land cells mostly sea are smoothed in with them.
    known = share >= 0.15
    m[~known] = 0
    for _ in range(W):
        if known.all():
            break
        acc = np.zeros_like(m); cnt = np.zeros_like(m)
        for dj, di in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            sm = np.roll(m, di, axis=1); sk = np.roll(known, di, axis=1)
            if dj:
                sm = np.roll(sm, dj, axis=0); sk = np.roll(sk, dj, axis=0)
                if dj > 0: sk[0, :] = False
                else: sk[-1, :] = False
            acc += np.where(sk, sm, 0); cnt += sk
        new = (~known) & (cnt > 0)
        m[new] = acc[new] / cnt[new]
        known = known | new
    # A light blur (the cell and its neighbors, around the earth east and west): the biomes' edges are not half-degree steps.
    b = m.copy()
    for ax in (0, 1):
        lo, hi = np.roll(b, 1, axis=ax), np.roll(b, -1, axis=ax)
        if ax == 0:
            lo[0, :] = b[0, :]; hi[-1, :] = b[-1, :]
        b = 0.25 * lo + 0.5 * b + 0.25 * hi
    out = np.clip(np.round(b * 255), 0, 255).astype(np.uint8)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'wb') as f:
        f.write(out.tobytes())
    print(f'{W} x {H} cells written to {OUT} ({out.size / 1024:.0f} kB)')
    for name, lat, lon in [('Sahara', 24, 10), ('Amazon', -4, -63), ('Germany', 51, 10), ('England', 52, -1), ('Spain', 39.5, -3.5), ('Ukraine', 49, 32), ('Taiga', 60, 100), ('Gobi', 43, 105), ('Outback', -25, 133), ('Sydney', -33.8, 150.8), ('India', 23, 79), ('Congo', 0, 22), ('Sahel', 14, 5), ('Kalahari', -24, 22), ('Cape Town', -33.8, 19), ('Patagonia', -47, -69), ('Chile lakes', -41, -72.5), ('Japan', 36, 138.5), ('Arabia', 24, 46), ('Dubai', 25.1, 55.6), ('Nepal', 27.6, 85.4), ('Iceland', 64.5, -19), ('Tierra del Fuego', -54.5, -67.5), ('Fiji', -17.8, 178), ('Borneo', 1, 114), ('Alps', 47.2, 11.4), ('Kansas', 38.5, -99), ('Minnesota', 45, -93.5), ('Nevada', 39.5, -117), ('Georgia', 32.5, -83.5)]:
        j, i = int((LAT_TOP - lat) / STEP), int((lon + 180) / STEP)
        print(f'  {name:18s} {out[j, i] / 255:.2f}   green {green[j, i]:+.3f} light {light[j, i]:.3f}')


main()

#!/usr/bin/env python3
"""
Bake the building wall materials in public/facades/ from ambientCG material sets (https://ambientcg.com, all CC0).

    python3 -I tools/bake-facades.py <dir with the unpacked 1K-JPG sets, one folder per asset id> [out dir]

Download each set as  https://ambientcg.com/get?file=<AssetId>_1K-JPG.zip  and unpack it into <dir>/<AssetId>/.

Two kinds of layer come out, all 512 x 512 and tiling:
  facade    a whole stretch of wall with its windows. The picture is twice as wide: colour on the left, and on the
            right a mask that is white on glass. It is rolled so that the lines between window cells lie on the
            picture's edges, and stored bottom row first (v runs up the wall).
  cladding  a wall surface with no windows (brick, concrete, sheeting, boards); the game draws the windows on it.
manifest.json lists them in layer order with the metres one tile covers, the window cells across and up (0 for a
cladding), the linear mean colour of the part that takes the building's own colour, whether the glass is tinted too, and (a cladding) how strongly it shows.
"""
import json, os, sys
import numpy as np
from PIL import Image

S = 512
# id, kind, metres across, metres up, cells across, cells up, mask map, and
#   for a facade: whether it is all glass (the glass takes the building's colour too)
#   for a cladding: how strongly the picture shows through the building's colour, 0..1
LAYERS = [
    ('Facade001', 'facade', 37.0, 37.0, 16, 10, 'Metalness', True),     # dark glass curtain wall
    ('Facade006', 'facade', 29.6, 29.6, 14, 8, 'Metalness', False),     # bands of glass between pale spandrels
    ('Facade014', 'facade', 115.2, 115.2, 32, 32, 'Roughness', False),  # a fine grid of piers and windows: a slab tower
    ('Facade018A', 'facade', 20.4, 20.4, 6, 6, 'Metalness', False),     # brick, a window to a bay
    ('Facade019A', 'facade', 20.4, 20.4, 6, 6, 'Metalness', False),     # concrete frame, wide windows
    ('Facade020A', 'facade', 20.4, 20.4, 6, 6, 'Metalness', False),     # dark brick piers
    ('Bricks085', 'cladding', 2.4, 2.4, 0, 0, None, 0.8),
    ('Bricks066', 'cladding', 3.6, 3.6, 0, 0, None, 0.6),             # dressed stone blocks
    ('Concrete031', 'cladding', 4.8, 4.8, 0, 0, None, 0.6),           # cast panels with their joints
    ('CorrugatedSteel007A', 'cladding', 3.0, 3.0, 0, 0, None, 0.7),
    ('WoodSiding013', 'cladding', 1.6, 1.6, 0, 0, None, 0.3),          # painted boards: the weathering barely shows
]


def linear(a):
    return np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)


def phase(profile, cells):
    """Where along a tile the cell boundaries (the least glass) fall: the pixel offset of the first one."""
    n = len(profile); period = n / cells; best = (2.0, 0)
    for p in range(int(round(period))):
        idx = (np.round(p + np.arange(cells) * period).astype(int)) % n
        v = float(np.mean([profile[(idx + d) % n].mean() for d in (-1, 0, 1)]))
        if v < best[0]: best = (v, p)
    return best[1]


def main():
    src = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'facades')
    os.makedirs(out, exist_ok=True)
    manifest = {'size': S, 'source': 'ambientCG (ambientcg.com), CC0 1.0', 'layers': []}
    for i, (aid, kind, w, h, cols, rows, mask_map, all_glass) in enumerate(LAYERS):
        col = Image.open(os.path.join(src, aid, f'{aid}_1K-JPG_Color.jpg')).convert('RGB')
        c = np.asarray(col, dtype=np.float32) / 255
        if kind == 'facade':
            m = np.asarray(Image.open(os.path.join(src, aid, f'{aid}_1K-JPG_{mask_map}.jpg')).convert('L'), dtype=np.float32) / 255
            if mask_map == 'Roughness': m = (m < 0.25).astype(np.float32)        # glass is the smooth part
            dx, dy = phase(m.mean(axis=0), cols), phase(m.mean(axis=1), rows)
            c = np.roll(c, (-dy, -dx), axis=(0, 1))[::-1]; m = np.roll(m, (-dy, -dx), axis=(0, 1))[::-1]
        else:
            m = np.zeros(c.shape[:2], dtype=np.float32); c = c[::-1]
        ci = Image.fromarray((c * 255 + 0.5).astype(np.uint8)).resize((S, S), Image.LANCZOS)
        mi = Image.fromarray((m * 255 + 0.5).astype(np.uint8)).resize((S, S), Image.LANCZOS)
        cl, ml = linear(np.asarray(ci, dtype=np.float64) / 255), np.asarray(mi, dtype=np.float64) / 255
        wgt = np.ones_like(ml) if kind != 'facade' or all_glass else np.clip(1 - ml * 2, 0, 1)
        mean = [(cl[..., k] * wgt).sum() / wgt.sum() for k in range(3)]
        name = f'{i:02d}-{aid.lower()}.jpg'
        if kind == 'facade':
            both = Image.new('RGB', (2 * S, S)); both.paste(ci, (0, 0)); both.paste(mi.convert('RGB'), (S, 0)); both.save(os.path.join(out, name), quality=88)
        else:
            ci.save(os.path.join(out, name), quality=88)
        manifest['layers'].append({'id': aid, 'file': name, 'kind': kind, 'w': w, 'h': h, 'cols': cols, 'rows': rows,
                                   'mean': [round(float(v), 4) for v in mean], 'glassTint': kind == 'facade' and bool(all_glass),
                                   'strength': 1.0 if kind == 'facade' else float(all_glass), 'glass': round(float(ml.mean()), 3)})
        print(name, kind, 'mean', [round(float(v), 3) for v in mean], 'glass', round(float(ml.mean()), 3))
    with open(os.path.join(out, 'manifest.json'), 'w') as f: json.dump(manifest, f, indent=1)


if __name__ == '__main__':
    main()

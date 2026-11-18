#!/usr/bin/env python3
"""Bake the maps of the big moons of Jupiter and Saturn (src/space/solar.js) from NASA's 3D models of them.

Source: NASA's 3D resources (https://science.nasa.gov/3d-resources/), one binary glTF model per moon, credited to
NASA Visualization Technology Applications and Development (VTAD); NASA's works are in the public domain. The
files, as their pages (https://science.nasa.gov/resource/<moon>-3d-model/) give them:

    Io_1_3643.glb  Europa_1_3138.glb  Ganymede_1_5268.glb  Callisto_1_4821.glb
    Mimas_1_1000.glb  Enceladus_1_504.glb  Tethys_1_1077-1.glb  Dione_1_1123.glb  Rhea_1_1529.glb  Iapetus_1_1471.glb

(Titan's model, Titan_1_5150.glb, carries only its haze's even orange: solar.js draws that without a map.)

Usage:  python3 tools/bake-moons.py <folder holding those files>

Writes into public/data/planets/ one <moon>.jpg each, 2048 x 1024, plate carree, north up, with the middle of
the face the moon keeps to its planet (longitude 0) in the middle of the map and east to the right, which is
how solar.js lays a moon's map on it. What that takes:
  - Nine of the models are spheres wearing exactly such a map: it is taken out of the file and reduced.
    Europa's is the exception among them: its map has longitude 180 in the middle (its rayed crater Pwyll, at
    271 W, sits a quarter of the way along), so it is turned half way round.
  - Mimas's model is its real, slightly egg-shaped figure, with its picture cut into two patches. Here every
    triangle of the mesh is drawn into the map at the latitude and longitude of its corners, carrying its
    piece of the picture with it. The picture is not laid on the figure by longitude, though: the great crater
    Herschel comes out 23 degrees north on the meridian that faces Saturn, and it belongs on the equator at
    112 W, in the middle of the side that leads. The figure is turned to put it there (down to the equator,
    then round); what cannot be known from one landmark, a turn about Herschel itself, is left as it is.
"""
import io, json, os, struct, sys
import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'data', 'planets')
W, H = 2048, 1024
SPHERES = {'io': 'Io_1_3643', 'europa': 'Europa_1_3138', 'ganymede': 'Ganymede_1_5268', 'callisto': 'Callisto_1_4821', 'enceladus': 'Enceladus_1_504',
           'tethys': 'Tethys_1_1077-1', 'dione': 'Dione_1_1123', 'rhea': 'Rhea_1_1529', 'iapetus': 'Iapetus_1_1471'}
TURNED = {'europa'}                                    # maps with longitude 180 in the middle
HERSCHEL = {'found': (23.2, -0.7), 'true': (0.0, -112.0)}   # Mimas's great crater: latitude and east longitude (degrees) as the model has it, and as it is
CT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}


def read_glb(path):
    b = open(path, 'rb').read()
    assert b[:4] == b'glTF', path
    off, chunks = 12, []
    while off < len(b):
        n, _ = struct.unpack('<I4s', b[off:off + 8]); chunks.append(b[off + 8:off + 8 + n]); off += 8 + n
    return json.loads(chunks[0]), chunks[1]


def color_map(js, bin_):
    """The model's base color picture."""
    mat = js['materials'][0]['pbrMetallicRoughness']['baseColorTexture']['index']
    bv = js['bufferViews'][js['images'][js['textures'][mat]['source']]['bufferView']]
    o = bv.get('byteOffset', 0)
    return Image.open(io.BytesIO(bin_[o:o + bv['byteLength']])).convert('RGB')


def accessor(js, bin_, i):
    a = js['accessors'][i]; bv = js['bufferViews'][a['bufferView']]; dt = np.dtype(CT[a['componentType']]); nc = NC[a['type']]
    off = bv.get('byteOffset', 0) + a.get('byteOffset', 0); stride = bv.get('byteStride') or dt.itemsize * nc
    raw = np.frombuffer(bin_, dtype=np.uint8, count=stride * (a['count'] - 1) + dt.itemsize * nc, offset=off)
    if stride != dt.itemsize * nc: raw = np.lib.stride_tricks.as_strided(raw, shape=(a['count'], dt.itemsize * nc), strides=(stride, 1)).copy()
    return raw.view(dt).reshape(a['count'], nc).astype(np.float64)


def unwrap(js, bin_):
    """A model that is not a mapped sphere, as a plate carree map: each triangle drawn where its corners are on the globe."""
    prim = js['meshes'][0]['primitives'][0]
    pos = accessor(js, bin_, prim['attributes']['POSITION']); uv = accessor(js, bin_, prim['attributes']['TEXCOORD_0'])
    idx = accessor(js, bin_, prim['indices']).astype(np.int64).reshape(-1, 3)
    tex = np.asarray(color_map(js, bin_), dtype=np.float64); th, tw = tex.shape[:2]
    pos = pos - (pos.max(0) + pos.min(0)) / 2                    # (the figure's own middle)
    # Turn the figure so its landmark is where it belongs: round to the meridian, down to the equator, round to its longitude.
    (la0, lo0), (la1, lo1) = HERSCHEL['found'], HERSCHEL['true']
    rz = lambda a: np.array([[np.cos(a), -np.sin(a), 0], [np.sin(a), np.cos(a), 0], [0, 0, 1]])
    ry = lambda a: np.array([[np.cos(a), 0, np.sin(a)], [0, 1, 0], [-np.sin(a), 0, np.cos(a)]])
    pos = pos @ (rz(np.radians(lo1)) @ ry(np.radians(la0 - la1)) @ rz(np.radians(-lo0))).T
    r = np.linalg.norm(pos, axis=1)
    lon = np.arctan2(pos[:, 1], pos[:, 0]); lat = np.arcsin(np.clip(pos[:, 2] / r, -1, 1))
    px = (0.5 + lon / (2 * np.pi)) * W; py = (0.5 - lat / np.pi) * H
    out = np.zeros((H, W, 3)); done = np.zeros((H, W), dtype=bool)
    for tri in idx:
        x, y, t = px[tri].copy(), py[tri], uv[tri]
        if x.max() - x.min() > W / 2: x[x < W / 2] += W          # across the seam at 180 degrees
        x0, x1 = int(np.floor(x.min())), int(np.ceil(x.max())); y0, y1 = max(int(np.floor(y.min())), 0), min(int(np.ceil(y.max())), H - 1)
        gx, gy = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        den = (y[1] - y[2]) * (x[0] - x[2]) + (x[2] - x[1]) * (y[0] - y[2])
        if abs(den) < 1e-9: continue
        a = ((y[1] - y[2]) * (gx - x[2]) + (x[2] - x[1]) * (gy - y[2])) / den
        b = ((y[2] - y[0]) * (gx - x[2]) + (x[0] - x[2]) * (gy - y[2])) / den
        c = 1 - a - b
        inside = (a >= -0.02) & (b >= -0.02) & (c >= -0.02)
        if not inside.any(): continue
        u = (a * t[0, 0] + b * t[1, 0] + c * t[2, 0])[inside] * tw - 0.5; v = (a * t[0, 1] + b * t[1, 1] + c * t[2, 1])[inside] * th - 0.5
        u0 = np.clip(np.floor(u).astype(int), 0, tw - 2); v0 = np.clip(np.floor(v).astype(int), 0, th - 2); fu = np.clip(u - u0, 0, 1)[:, None]; fv = np.clip(v - v0, 0, 1)[:, None]
        col = (tex[v0, u0] * (1 - fu) + tex[v0, u0 + 1] * fu) * (1 - fv) + (tex[v0 + 1, u0] * (1 - fu) + tex[v0 + 1, u0 + 1] * fu) * fv
        yy = (gy[inside] - 0.5).astype(int); xx = (gx[inside] - 0.5).astype(int) % W
        out[yy, xx] = col; done[yy, xx] = True
    # What no triangle reached (a few pixels at the poles): the nearest pixel that one did, along the row and then the column.
    for axis in (1, 0):
        for _ in range(64):
            if done.all(): break
            for step in (1, -1):
                src = np.roll(done, step, axis=axis) & ~done
                out[src] = np.roll(out, step, axis=axis)[src]; done |= src
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), 'RGB')


def main():
    d = sys.argv[1]
    os.makedirs(OUT, exist_ok=True)
    for moon, name in SPHERES.items():
        im = color_map(*read_glb(os.path.join(d, name + '.glb'))).resize((W, H), Image.LANCZOS)
        if moon in TURNED: im = Image.fromarray(np.roll(np.asarray(im), W // 2, axis=1), 'RGB')
        im.save(os.path.join(OUT, moon + '.jpg'), quality=88, subsampling=1)
        print('%-10s %d x %d' % (moon + '.jpg', W, H))
    unwrap(*read_glb(os.path.join(d, 'Mimas_1_1000.glb'))).save(os.path.join(OUT, 'mimas.jpg'), quality=88, subsampling=1)
    print('%-10s %d x %d, drawn from its mesh' % ('mimas.jpg', W, H))


if __name__ == '__main__':
    main()

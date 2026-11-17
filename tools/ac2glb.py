#!/usr/bin/env python3
"""Turn AC3D model files (.ac, the format FlightGear aircraft are drawn in) into one binary glTF (.glb).

    python3 tools/ac2glb.py OUT.glb PART.ac [PART.ac ...] [--at NAME=x,y,z] [--drop REGEX] [--texture OLD=NEW]
                            [--rig MODEL.xml ...] [--drive PROPERTY=driver[*scale]]

The aircraft in public/models/ were made with it (public/models/CREDITS.md has the command for each).

What it does:
  - reads every part into one model, in the game's axes: +X right wing, +Y up, -Z out the nose, meters
    (an .ac file from FlightGear has x aft, y up, z toward the left wing);
  - keeps each object as its own node, named as in the .ac file, with the names of the groups it sits in
    stored in `extras.path` and its own again in `extras.name` (loaders tidy node names; the game hinges
    landing gear and control surfaces by these);
    vertices are written in model coordinates, so every node sits at the origin;
  - smooths normals as AC3D does: across the faces around a vertex that are marked smooth and lie within
    the object's crease angle of each other;
  - merges materials that look the same, and embeds the textures.

--at NAME=x,y,z   move the part whose file name is NAME (without .ac) by x, y, z in FlightGear's axes
                  (x aft, y right, z up), as the <offsets> of a FlightGear model file do
--drop REGEX      leave out objects whose name, or the name of a group they are in, matches
--texture OLD=NEW use the image NEW wherever the .ac files name OLD (a livery)
--rig MODEL.xml   read the hinges from a FlightGear model file (its <animation> blocks of type rotate and translate) and
                  store them in the .glb as `scenes[0].extras.rig`, in the game's axes: for each, the objects it moves
                  (`on`), what drives it (`by`: gear, flap, elev, rud, ail, ailL, ailR, brake, ...), `axis`, center `c`,
                  and a table `tab` of [driver value, degrees or meters]. Listed in the file's order: where several
                  move one object, the first is the outermost. Only animations whose property has a driver are kept.
--drive PROPERTY=driver[*scale]   which driver a FlightGear property (a regular expression) stands for, and what one
                  unit of the driver is in the property's units; the usual ones (gear position, flaps, elevator,
                  rudder, ailerons, speedbrake) are known already
Needs numpy. Textures are looked up beside each .ac file.
"""
import json, math, os, re, struct, sys
import numpy as np


def parse_ac(path):
    """-> (materials, root object). An object: dict(kind, name, loc, rot, texture, rep, off, crease, verts, surfs, kids)."""
    with open(path, 'rb') as f:
        data = f.read()
    lines = data.split(b'\n')
    i = 0
    mats = []

    def obj():
        nonlocal i
        o = dict(kind=lines[i].split()[1].decode(), name='', loc=np.zeros(3), rot=np.eye(3), texture=None, rep=(1, 1), off=(0, 0), crease=45.0, verts=np.zeros((0, 3)), surfs=[], kids=[])
        i += 1
        while i < len(lines):
            t = lines[i].decode('latin-1').strip()
            k = t.split(' ', 1)[0]
            if k == 'name': o['name'] = t.split(' ', 1)[1].strip().strip('"'); i += 1
            elif k == 'data':
                n = int(t.split()[1]); i += 1
                got = 0
                while got < n and i < len(lines): got += len(lines[i]) + 1; i += 1     # the text of the data block, however many lines it took
            elif k == 'texture':
                if o['texture'] is None: o['texture'] = t.split(' ', 1)[1].strip().strip('"').split('"')[0]
                i += 1
            elif k == 'texrep': o['rep'] = tuple(float(v) for v in t.split()[1:3]); i += 1
            elif k == 'texoff': o['off'] = tuple(float(v) for v in t.split()[1:3]); i += 1
            elif k == 'rot': o['rot'] = np.array([float(v) for v in t.split()[1:10]]).reshape(3, 3).T; i += 1
            elif k == 'loc': o['loc'] = np.array([float(v) for v in t.split()[1:4]]); i += 1
            elif k == 'crease': o['crease'] = float(t.split()[1]); i += 1
            elif k == 'numvert':
                n = int(t.split()[1])
                o['verts'] = np.array([[float(v) for v in lines[i + 1 + j].split()[:3]] for j in range(n)]).reshape(n, 3)
                i += 1 + n
            elif k == 'numsurf':
                n = int(t.split()[1]); i += 1
                for _ in range(n):
                    flags = int(lines[i].split()[1], 16); i += 1
                    mat = 0
                    while not lines[i].startswith(b'refs'):
                        if lines[i].startswith(b'mat'): mat = int(lines[i].split()[1])
                        i += 1
                    r = int(lines[i].split()[1]); i += 1
                    refs = []
                    for j in range(r):
                        p = lines[i + j].split(); refs.append((int(p[0]), float(p[1]), float(p[2])))
                    i += r
                    o['surfs'].append((flags, mat, refs))
            elif k == 'kids':
                n = int(t.split()[1]); i += 1
                for _ in range(n):
                    while i < len(lines) and (not lines[i].strip() or lines[i].startswith(b'kids')): i += 1     # (blank lines, a repeated "kids 0")
                    if i >= len(lines) or not lines[i].startswith(b'OBJECT'): break      # (some files count more children than they hold)
                    o['kids'].append(obj())
                return o
            else: i += 1
        return o

    root = None
    while i < len(lines):
        t = lines[i].decode('latin-1').strip()
        if t.startswith('MATERIAL'):
            m = re.match(r'MATERIAL\s+"([^"]*)"\s+rgb\s+(\S+)\s+(\S+)\s+(\S+)\s+amb\s+\S+\s+\S+\s+\S+\s+emis\s+(\S+)\s+(\S+)\s+(\S+)\s+spec\s+(\S+)\s+(\S+)\s+(\S+)\s+shi\s+(\S+)\s+trans\s+(\S+)', t)
            g = [float(v) for v in m.groups()[1:]]
            mats.append(dict(name=m.group(1), rgb=g[0:3], emis=g[3:6], spec=g[6:9], shi=g[9], trans=g[10]))
            i += 1
        elif t.startswith('OBJECT'): root = obj()
        else: i += 1
    return mats, root


DRIVES = [(r'gear/gear(\[\d\])?/position-norm$', 'gear', 1), (r'flap-pos-norm$', 'flap', 1), (r'elevator-pos-norm$', 'elev', 1), (r'rudder-pos-norm$', 'rud', 1),
          (r'left-aileron-pos-norm$', 'ailL', 1), (r'right-aileron-pos-norm$', 'ailR', 1), (r'/aileron-pos-norm$', 'ail', 1), (r'(speedbrake|spoilers)-pos-norm$', 'brake', 1)]
RANGE = dict(gear=(0, 1), flap=(0, 1), brake=(0, 1))          # the others run -1..1


def read_rig(path, drives):
    """The rotate and translate animations of a FlightGear model file, for the drivers we have, in the game's axes."""
    with open(path, errors='replace') as f: s = re.sub(r'<!--.*?-->', '', f.read(), flags=re.S)
    num = lambda blk, tags: [float((re.search(r'<%s>\s*(-?\d+\.?\d*(?:[eE]-?\d+)?)' % t, blk) or [0, 0])[1]) for t in tags]
    game = lambda v: [v[1], v[2], v[0]]                         # FlightGear x aft, y right, z up -> X right, Y up, Z aft
    rig = []
    for m in re.finditer(r'<animation>(.*?)</animation>', s, re.S):
        b = re.sub(r'<condition>.*?</condition>', '', m.group(1), flags=re.S)
        g = lambda tag: (lambda x: x.group(1).strip() if x else None)(re.search(r'<%s>\s*([^<]*?)\s*</%s>' % (tag, tag), b))
        kind, prop = g('type'), g('property')
        if kind not in ('rotate', 'translate') or not prop: continue
        d = next(((by, k) for rx, by, k in drives if re.search(rx, prop)), None)
        if not d: continue
        by, scale = d
        ax = re.search(r'<axis>(.*?)</axis>', b, re.S); ce = re.search(r'<center>(.*?)</center>', b, re.S)
        if ax and '<x1-m>' in ax.group(1): c = num(ax.group(1), ['x1-m', 'y1-m', 'z1-m']); p2 = num(ax.group(1), ['x2-m', 'y2-m', 'z2-m']); axis = [q - p for p, q in zip(c, p2)]
        else: axis = num(ax.group(1), ['x', 'y', 'z']) if ax else [0, 0, 1]; c = num(ce.group(1), ['x-m', 'y-m', 'z-m']) if ce else [0, 0, 0]
        n = math.sqrt(sum(v * v for v in axis)) or 1
        tab = [(float(i) / scale, float(v)) for i, v in re.findall(r'<entry>\s*<ind>\s*([-\d.eE]+)\s*</ind>\s*<dep>\s*([-\d.eE]+)\s*</dep>\s*</entry>', b, re.S)]
        if not tab:
            f = float(g('factor') or 1) * scale; off = float(g('offset-deg') or g('offset-m') or 0)
            lo, hi = float(g('min-deg') or g('min-m') or -1e9), float(g('max-deg') or g('max-m') or 1e9)
            a, z = RANGE.get(by, (-1, 1))
            xs = {a, z} | ({(lim - off) / f for lim in (lo, hi) if abs(lim) < 1e8 and a < (lim - off) / f < z} if f else set())
            tab = [(x, min(hi, max(lo, f * x + off))) for x in sorted(xs)]
        if all(abs(v) < 1e-9 for _, v in tab): continue
        rig.append(dict(on=[o.strip() for o in re.findall(r'<object-name>(.*?)</object-name>', b)], by=by, kind=kind[0], axis=[round(v / n, 5) for v in game(axis)], c=[round(v, 4) for v in game(c)], tab=[[round(x, 4), round(v, 4)] for x, v in sorted(tab)]))
    return rig


def main(argv):
    out, parts, at, drop, swap, rigs, drives = argv[0], [], {}, [], {}, [], []
    a = 1
    while a < len(argv):
        if argv[a] == '--at': n, v = argv[a + 1].split('='); at[n] = [float(x) for x in v.split(',')]; a += 2
        elif argv[a] == '--drop': drop.append(re.compile(argv[a + 1])); a += 2
        elif argv[a] == '--texture': o, n = argv[a + 1].split('='); swap[o] = n; a += 2
        elif argv[a] == '--rig': rigs.append(argv[a + 1]); a += 2
        elif argv[a] == '--drive': rx, d = argv[a + 1].rsplit('=', 1); by, _, k = d.partition('*'); drives.append((rx, by, float(k or 1))); a += 2
        else: parts.append(argv[a]); a += 1

    nodes, meshes, materials, mat_key, images, img_key, textures = [], [], [], {}, [], {}, []
    chunks = []                                    # binary blobs, each padded to 4 bytes
    views, accessors = [], []

    def blob(b, target=None):
        off = sum(len(c) for c in chunks)
        chunks.append(b + b'\0' * (-len(b) % 4))
        v = dict(buffer=0, byteOffset=off, byteLength=len(b))
        if target: v['target'] = target
        views.append(v)
        return len(views) - 1

    def accessor(arr, kind, comp, target, minmax=False):
        arr = np.ascontiguousarray(arr)
        acc = dict(bufferView=blob(arr.tobytes(), target), componentType=comp, count=len(arr), type=kind)
        if minmax: acc['min'] = arr.min(0).tolist(); acc['max'] = arr.max(0).tolist()
        accessors.append(acc)
        return len(accessors) - 1

    def image(path):
        if path not in img_key:
            with open(path, 'rb') as f: b = f.read()
            mime = 'image/png' if b[:4] == b'\x89PNG' else 'image/jpeg'
            images.append(dict(bufferView=blob(b), mimeType=mime, name=os.path.basename(path)))
            textures.append(dict(source=len(images) - 1, sampler=0))
            img_key[path] = len(textures) - 1
        return img_key[path]

    def material(m, tex, two_sided):
        key = (tuple(round(v, 3) for v in m['rgb']), tuple(round(v, 3) for v in m['emis']), round(m['trans'], 3), round(m['shi']), tex, two_sided)
        if key not in mat_key:
            rough = float(np.clip(1.0 - 0.55 * (sum(m['spec']) / 3) * min(m['shi'], 64) / 64, 0.25, 1.0))
            g = dict(name=m['name'], pbrMetallicRoughness=dict(baseColorFactor=[*m['rgb'], 1.0 - m['trans']], metallicFactor=0.0, roughnessFactor=rough))
            if tex is not None: g['pbrMetallicRoughness']['baseColorTexture'] = dict(index=tex)
            if max(m['emis']) > 0: g['emissiveFactor'] = m['emis']
            if m['trans'] > 0: g['alphaMode'] = 'BLEND'
            if two_sided: g['doubleSided'] = True
            materials.append(g); mat_key[key] = len(materials) - 1
        return mat_key[key]

    for part in parts:
        mats, root = parse_ac(part)
        base = os.path.dirname(part)
        shift = np.array(at.get(os.path.splitext(os.path.basename(part))[0], [0, 0, 0]), float)
        shift = np.array([shift[0], shift[2], -shift[1]])            # FlightGear's axes -> the file's

        def walk(o, M, T, path):
            # (the file's axes: a child's vertices are in its parent's frame, turned by rot and moved by loc)
            T = T + M @ o['loc']; M = M @ o['rot']
            names = path + [o['name']] if o['name'] and o['kind'] != 'world' else path
            if any(d.search(n) for d in drop for n in names): return
            if o['kind'] == 'poly' and len(o['verts']) and o['surfs']:
                V = (M @ o['verts'].T).T + T
                tex = None
                if o['texture']:
                    p = os.path.join(base, swap.get(o['texture'], o['texture']))
                    if os.path.exists(p): tex = image(p)
                    else: print(f'  (no texture {p} for {o["name"]})', file=sys.stderr)
                # triangles, by material and sidedness
                groups = {}
                for flags, mat, refs in o['surfs']:
                    if flags & 0xF or len(refs) < 3: continue        # lines
                    k = (mat, bool(flags & 0x20))
                    for j in range(1, len(refs) - 1): groups.setdefault(k, []).append((refs[0], refs[j], refs[j + 1], bool(flags & 0x10)))
                if not groups: return
                # face normals, then per-corner normals smoothed within the crease angle
                tris = [t for g in groups.values() for t in g]
                fn = np.array([np.cross(V[t[1][0]] - V[t[0][0]], V[t[2][0]] - V[t[0][0]]) for t in tris])
                ln = np.linalg.norm(fn, axis=1); un = fn / np.maximum(ln, 1e-20)[:, None]
                around = {}
                for f, t in enumerate(tris):
                    for c in range(3): around.setdefault(t[c][0], []).append(f)
                cos_crease = math.cos(math.radians(min(o['crease'], 179.0)))
                prims = []
                f = 0
                for (mat, two), g in groups.items():
                    pos, nor, uv, idx, seen = [], [], [], [], {}
                    for t in g:
                        if ln[f] < 1e-14: f += 1; continue              # a sliver with no area
                        for c in range(3):
                            vi, u, v = t[c]
                            if t[3]:
                                n = np.zeros(3)
                                for h in around[vi]:
                                    if tris[h][3] and un[h] @ un[f] >= cos_crease: n += fn[h]      # (weighted by area)
                                n = n / max(np.linalg.norm(n), 1e-20)
                            else: n = un[f]
                            u2 = u * o['rep'][0] + o['off'][0]; v2 = 1.0 - (v * o['rep'][1] + o['off'][1])
                            key = (vi, round(n[0], 4), round(n[1], 4), round(n[2], 4), round(u2, 5), round(v2, 5))
                            if key not in seen: seen[key] = len(pos); pos.append(V[vi]); nor.append(n); uv.append((u2, v2))
                            idx.append(seen[key])
                        f += 1
                    if not idx: continue
                    # into the game's axes: X = -z, Y = y, Z = x
                    P = np.array(pos, np.float32)[:, [2, 1, 0]] * np.array([-1, 1, 1], np.float32)
                    N = np.array(nor, np.float32)[:, [2, 1, 0]] * np.array([-1, 1, 1], np.float32)
                    big = len(pos) > 65535
                    prims.append(dict(attributes=dict(POSITION=accessor(P, 'VEC3', 5126, 34962, True), NORMAL=accessor(N, 'VEC3', 5126, 34962), TEXCOORD_0=accessor(np.array(uv, np.float32), 'VEC2', 5126, 34962)),
                                      indices=accessor(np.array(idx, np.uint32 if big else np.uint16), 'SCALAR', 5125 if big else 5123, 34963),
                                      material=material(mats[mat], tex, two)))
                if prims:
                    meshes.append(dict(name=o['name'], primitives=prims))
                    nodes.append(dict(name=o['name'], mesh=len(meshes) - 1, extras=dict(name=o['name'], path=path)))
            for k in o['kids']: walk(k, M, T, names)

        walk(root, np.eye(3), shift, [])

    n = len(nodes)
    nodes.append(dict(name='aircraft', children=list(range(n))))
    gltf = dict(asset=dict(version='2.0', generator='Dead Reckoning tools/ac2glb.py'), scene=0, scenes=[dict(nodes=[n])], nodes=nodes, meshes=meshes, materials=materials,
                accessors=accessors, bufferViews=views, buffers=[dict(byteLength=sum(len(c) for c in chunks))])
    rig = [r for x in rigs for r in read_rig(x, drives + DRIVES)]
    names = {n.get('name') for n in nodes} | {p for n in nodes for p in n.get('extras', {}).get('path', [])}
    for r in rig: r['on'] = [o for o in r['on'] if o in names]
    rig = [r for r in rig if r['on']]
    if rig: gltf['scenes'][0]['extras'] = dict(rig=rig)
    if images: gltf.update(images=images, textures=textures, samplers=[dict(magFilter=9729, minFilter=9987, wrapS=10497, wrapT=10497)])
    js = json.dumps(gltf, separators=(',', ':')).encode()
    js += b' ' * (-len(js) % 4)
    bin_ = b''.join(chunks)
    with open(out, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(bin_)))
        f.write(struct.pack('<II', len(js), 0x4E4F534A)); f.write(js)
        f.write(struct.pack('<II', len(bin_), 0x004E4942)); f.write(bin_)
    tri = sum(accessors[p['indices']]['count'] for m in meshes for p in m['primitives']) // 3
    print(f'{out}: {n} objects, {tri} triangles, {len(materials)} materials, {len(images)} images, {len(rig)} hinges ({", ".join(sorted({r["by"] for r in rig}))}), {(12 + 16 + len(js) + len(bin_)) / 1e6:.2f} MB')


if __name__ == '__main__':
    if len(sys.argv) < 3: sys.exit(__doc__)
    main(sys.argv[1:])

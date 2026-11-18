#!/usr/bin/env python3
"""Turn AC3D model files (.ac, the format FlightGear aircraft are drawn in) into one binary glTF (.glb).

    python3 tools/ac2glb.py OUT.glb [PART.ac ...] [--at NAME=x,y,z] [--drop REGEX] [--texture OLD=NEW]
                            [--rig MODEL.xml ...] [--drive PROPERTY=driver[*scale][@lo:hi]]
                            [--model MODEL.xml[@x,y,z[,heading,pitch,roll]] ...] [--aircraft NAME=DIR]
                            [--prop NAME=VALUE] [--false REGEX] [--keep REGEX] [--max-texture N] [--texture-size REGEX=N] [--atlas N]
                            [--vertex-colors] [--compact] [--webp Q] [--files]

The aircraft and cockpits in public/models/ were made with it (public/models/CREDITS.md has the command for each).

What it does:
  - reads every part into one model, in the game's axes: +X right wing, +Y up, -Z out the nose, meters
    (an .ac file from FlightGear has x aft, y up, z toward the left wing);
  - keeps each object as its own node, named as in the .ac file, with the names of the groups it sits in
    stored in `extras.path` and its own again in `extras.name` (loaders tidy node names; the game hinges
    landing gear, control surfaces and instrument needles by these);
    vertices are written in model coordinates, so every node sits at the origin;
  - smooths normals as AC3D does: across the faces around a vertex that are marked smooth and lie within
    the object's crease angle of each other;
  - merges materials that look the same, and embeds the textures.

--at NAME=x,y,z   move the part whose file name is NAME (without .ac) by x, y, z in FlightGear's axes
                  (x aft, y right, z up), as the <offsets> of a FlightGear model file do
--drop REGEX      leave out objects whose name, or the name of a group or sub-model they are in, matches
--texture OLD=NEW use the image NEW wherever the .ac files name OLD (a livery)
--rig MODEL.xml   read the hinges from a FlightGear model file (its <animation> blocks of type rotate and translate) and
                  store them in the .glb as `scenes[0].extras.rig`, in the game's axes: for each, the objects it moves
                  (`on`), what drives it (`by`: gear, flap, elev, rud, ail, ailL, ailR, brake, ...), `axis`, center `c`,
                  and a table `tab` of [driver value, degrees or meters]. Listed in the file's order: where several
                  move one object, the first is the outermost. Only animations whose property has a driver are kept.
--drive PROPERTY=driver[*scale][@lo:hi]   which driver a FlightGear property (a regular expression) stands for, and
                  what one unit of the driver is in the property's units; the usual ones (gear position, flaps, elevator,
                  rudder, ailerons, speedbrake) are known already. lo:hi is the driver's range where it is not -1..1
                  (an airspeed needle's: 0:800), for animations given as a factor and not as a table.

A whole FlightGear model, sub-models and all (a cockpit):
--model MODEL.xml[@x,y,z[,heading,pitch,roll]]
                  read a FlightGear model file: its own .ac <path>, and every <model> it includes with its <offsets>
                  (meters and degrees, turned as FlightGear does: pitch, then roll, then heading), to any depth. The
                  optional @... places the whole of it, as a parent file's <offsets> would. An object of a sub-model is
                  named SUBMODEL/.../OBJECT (the <name> each <model> is given), and `extras.path` lists the sub-models
                  and groups it sits in, outermost first, so a hinge can move a whole sub-model. The hinges of every
                  file read are kept (as --rig), moved to where their file was placed; besides rotate and translate,
                  `textranslate` (a drum of digits: kind `u`, axis in texture coordinates, with the `step`, `scroll`
                  and `bias` of the animation). The properties of the usual instruments and controls have drivers
                  already (PIT_DRIVES below: kt, altft, fpm, roll, pitch, hdg, rpm, stickP, thr, ...). <animation>s of type select and <model>s under a <condition> that the
                  --prop values make false are left out; a condition on a property not given counts as true.
--aircraft NAME=DIR   where the paths Aircraft/NAME/... of the model files are (anything not found is skipped, and said)
--prop NAME=VALUE     a FlightGear property's value, for those conditions
--false REGEX         the properties whose name matches are false (0), for those conditions: warning lights that are out
                  (A select that turns on one of the driven values, such as an altimeter's flag that shows below 10,000
                  feet, becomes a hinge of kind `s`: the object is shown while the driver is within `show`: [from, to).)
--keep REGEX          keep only objects whose name (as --drop sees it) matches; --drop still applies
--max-texture N   textures are scaled down to at most N pixels a side and written as PNG (also .rgb and .dds ones), and
                  looked at: one with see-through pixels makes its material cut out (alphaMode MASK) or, where the
                  transparency is graded, blended. Needs Pillow.
--texture-size REGEX=N   the same, for the textures whose file name matches: a smaller or larger limit of their own
--atlas N         put the textures that are never tiled (and are not a scrolling drum) together on sheets of N pixels a
                  side, each with its edge pixels repeated around it, and point the objects at their place on the
                  sheet: objects whose textures share a sheet can share a material. Implies --max-texture N.
--vertex-colors   write each object's material color into its vertices (COLOR_0) instead of into the material, so
                  objects that share a texture share a material: far fewer draw calls for a cockpit.
--compact         normals and vertex colors as bytes, places on a sheet as 16-bit numbers (the glTF extension
                  KHR_mesh_quantization): a smaller file
--files           list the files that went into the model (for the credits)
--webp Q          write the textures as WebP of quality Q (0-100) instead of PNG (the glTF extension EXT_texture_webp)
Needs numpy. Textures are looked up beside each .ac file.
"""
import hashlib, io, json, math, os, re, struct, sys
import xml.etree.ElementTree as ET
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

# The same for a cockpit (--model): the properties FlightGear's instruments and controls follow, the driver each stands
# for (src/aircraft/pit.js has the other end: what the game puts into each, in these units), one driver unit in the
# property's units, and the driver's range.
PIT_DRIVES = [
    (r'indicated-speed-kt$|velocities/vc-kts$', 'kt', 1, (0, 1000)), (r'velocities/mach$', 'mach', 1, (0, 3)),
    (r'indicated-altitude-ft$', 'altft', 1, (0, 100000)), (r'(velocities|vertical-speed-indicator)/(vertical-speed-fpm|indicated-speed-fpm)$', 'fpm', 1, (-6000, 6000)), (r'indicated-speed-fps$', 'fpm', 1 / 60, (-6000, 6000)),
    (r'roll-deg$', 'roll', 1, (-180, 180)), (r'pitch-deg$', 'pitch', 1, (-90, 90)), (r'heading-magnetic-deg$|indicated-heading-deg$', 'hdg', 1, (0, 360)),
    (r'indicated-slip-skid$', 'slip', 1, (-1, 1)), (r'indicated-turn-rate$', 'turn', 1 / 3, (-9, 9)),
    (r'z-accel-fps_sec', 'g', -32.174, (-5, 10)), (r'alpha-indicated$', 'aoa', 1, (-10, 40)),
    (r'engine(\[0\])?/rpm$', 'rpm', 1, (0, 5000)), (r'engine(\[0\])?/mp-(osi|inhg)$', 'map', 1, (0, 100)), (r'engine(\[\d\])?/n[12]$', 'n1', 1, (0, 110)),
    (r'controls/flight/elevator$', 'stickP', 1, (-1, 1)), (r'controls/flight/aileron$', 'stickR', 1, (-1, 1)), (r'controls/flight/rudder$', 'pedal', 1, (-1, 1)),
    (r'/throttle(-movement|-pos-norm(\[\d\])?)?$', 'thr', 1, (0, 1)), (r'controls/gear/(leverPos|gear-down)$', 'gearLever', 1, (0, 1)), (r'controls/flight/flaps$', 'flapLever', 1, (0, 1)),
    (r'clock/indicated-sec$', 'clock', 1, (0, 86400)), (r'clock/indicated-hour$', 'clockH', 1, (0, 24)), (r'clock/indicated-min$', 'clockM', 1, (0, 60)),
    (r'setting-inhg$', 'baro', 1, (28, 31)), (r'oil-pressure-psi$', 'oilP', 1, (0, 200)), (r'oil-temp-degC$', 'oilT', 1, (0, 150)), (r'coolant-temp-degC$', 'coolT', 1, (-70, 150)),
    (r'fuel-pump-psi$', 'fuelP', 1, (0, 25)), (r'suction-inhg$', 'vac', 1, (0, 10)), (r'Ox/pressure$', 'oxP', 1, (0, 500)), (r'ftit-degc$', 'ftit', 1, (0, 1200)),
    (r'nozzle-pos-norm', 'noz', 1, (0, 1)), (r'environment/temperature-degc$', 'oat', 1, (-70, 150)),
]


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


# ---------------------------------------------------------------- a FlightGear model file and what it includes

def fg_matrix(x=0.0, y=0.0, z=0.0, heading=0.0, pitch=0.0, roll=0.0):
    """<offsets> as a 4x4 matrix in FlightGear's axes (x aft, y right, z up): turned by pitch (about y), then roll
    (about x), then heading (about z), then moved."""
    def rot(deg, ax):
        a = math.radians(deg); c, s = math.cos(a), math.sin(a); i, j = [(1, 2), (2, 0), (0, 1)][ax]
        m = np.eye(3); m[i, i] = c; m[j, j] = c; m[i, j] = -s; m[j, i] = s
        return m
    M = np.eye(4); M[:3, :3] = rot(heading, 2) @ rot(roll, 0) @ rot(pitch, 1); M[:3, 3] = [x, y, z]
    return M


def xml_root(path):
    with open(path, errors='replace') as f: s = f.read()
    s = re.sub(r'<!--.*?-->', '', s, flags=re.S); s = re.sub(r'<!DOCTYPE[^>]*>', '', s); s = re.sub(r'&(?!(amp|lt|gt|quot|apos|#\d+);)', '&amp;', s)
    try: return ET.fromstring(s)
    except ET.ParseError as e:
        print(f'  (could not read {path}: {e})', file=sys.stderr)
        return None


def _txt(el, tag, default=None):
    c = el.find(tag) if el is not None else None
    return c.text.strip() if c is not None and c.text and c.text.strip() else default


def _num(el, tag, default=0.0):
    try: return float(_txt(el, tag, default))
    except (TypeError, ValueError): return default


def _offsets(el):
    o = el.find('offsets') if el is not None else None
    if o is None: return np.eye(4)
    return fg_matrix(_num(o, 'x-m'), _num(o, 'y-m'), _num(o, 'z-m'), _num(o, 'heading-deg'), _num(o, 'pitch-deg'), _num(o, 'roll-deg'))


def condition(el, props):
    """A FlightGear <condition> (or anything with the same children): True, False, or None where it turns on a
    property we were not told."""
    def val(c):
        if c.tag == 'property':
            k = (c.text or '').strip().lstrip('/')
            if k not in props and any(rx.search(k) for rx in props.get('', [])): return '0'       # (--false)
            return props.get(k, None)
        if c.tag == 'value': return (c.text or '').strip()
        return None
    def same(a, b):
        try: return float(a) == float(b)
        except ValueError: return str(a) == str(b)
    def truth(v):
        try: return float(v) != 0
        except ValueError: return v not in ('', 'false')
    def ev(c):
        t = c.tag
        if t == 'property': v = val(c); return None if v is None else truth(v)
        if t in ('and', 'condition'): r = [ev(k) for k in c]; return False if False in r else None if None in r else True
        if t == 'or': r = [ev(k) for k in c]; return True if True in r else None if None in r else False
        if t == 'not': r = [ev(k) for k in c]; r = False if False in r else None if None in r else True; return None if r is None else not r
        if t in ('equals', 'not-equals', 'less-than', 'greater-than', 'less-than-equals', 'greater-than-equals'):
            ops = [val(k) for k in c if k.tag in ('property', 'value')]
            if len(ops) < 2 or None in ops: return None
            a, b = ops[0], ops[1]
            if t == 'equals': return same(a, b)
            if t == 'not-equals': return not same(a, b)
            try: a, b = float(a), float(b)
            except ValueError: return None
            return a < b if t == 'less-than' else a > b if t == 'greater-than' else a <= b if t == 'less-than-equals' else a >= b
        return None
    return ev(el)


def load_model(path, frame, scope, ctx):
    """Read the model file at `path`, placed by `frame` (4x4, FlightGear's axes), into ctx: its parts
    (.ac path, 4x4, scope), its animations, and what its conditions hide."""
    root = xml_root(path)
    if root is None: return
    ctx['read'].append(path)
    here = os.path.dirname(path)

    def resolve(p):
        p = p.replace('\\', '/').lstrip('/')
        m = re.match(r'Aircraft/([^/]+)/(.*)', p)
        if m:
            if m.group(1) in ctx['aircraft']: q = os.path.join(ctx['aircraft'][m.group(1)], m.group(2))
            else: return None
        else:
            # (beside the file that names it, or from the top of an aircraft's folder)
            q = next((c for c in [os.path.join(here, p)] + [os.path.join(d, p) for d in ctx['aircraft'].values()] if os.path.exists(c)), '')
        return q if os.path.exists(q) else None

    def place(p, M, sc, what):
        q = resolve(p)
        if q is None: print(f'  (no file {p} for {what})', file=sys.stderr); return
        if q.lower().endswith('.ac'): ctx['parts'].append((q, M, sc))
        elif q.lower().endswith('.xml'): load_model(q, M, sc, ctx)

    frame = frame @ _offsets(root)                 # (a file's own <offsets> place all of it: its sub-models and hinges too)
    main = _txt(root, 'path')
    if main: place(main, frame, scope, os.path.basename(path))
    for m in root.findall('model'):
        p = _txt(m, 'path')
        if not p: continue
        name = _txt(m, 'name') or os.path.splitext(os.path.basename(p.replace('\\', '/')))[0]
        c = m.find('condition')
        if c is not None and condition(c, ctx['props']) is False: continue
        k, base = 2, name
        while '/'.join(scope + [name]) in ctx['scopes']: name = f'{base}.{k}'; k += 1       # (two sub-models of one name)
        ctx['scopes'].add('/'.join(scope + [name]))
        place(p, frame @ _offsets(m), scope + [name], name)
    for a in root.findall('animation'):
        kind = _txt(a, 'type')
        names = [(o.text or '').strip() for o in a.findall('object-name')]
        if kind == 'select':
            c = a.find('condition')
            if c is None: continue
            if condition(c, ctx['props']) is False: ctx['hidden'].update((tuple(scope), n) for n in names); continue
            # Shown or not by one of the values the game has (an altimeter's flag below 10,000 feet)? Then a hinge of kind `s`.
            COMP = ('equals', 'not-equals', 'less-than', 'greater-than', 'less-than-equals', 'greater-than-equals')
            found = {}
            for k in c.iter():
                if k.tag not in COMP: continue
                pr = [(x.text or '').strip().lstrip('/') for x in k if x.tag == 'property']; vs = [(x.text or '').strip() for x in k if x.tag == 'value']
                if len(pr) == 1 and len(vs) == 1 and pr[0] not in ctx['props']:
                    d = next((x for x in ctx['drives'] if re.search(x[0], pr[0])), None)
                    try:
                        if d and d[2] > 0: found.setdefault((pr[0], d[1], d[2]), []).append(float(vs[0]))
                    except ValueError: pass
            if len(found) != 1: continue
            (prop, by, scale), ts = next(iter(found.items())); ts = sorted(set(ts))
            pts = [ts[0] - 1] + [(x + y) / 2 for x, y in zip(ts, ts[1:])] + [ts[-1] + 1]
            vis = [condition(c, {**ctx['props'], prop: repr(x)}) is not False for x in pts]
            if all(vis): continue
            if not any(vis): ctx['hidden'].update((tuple(scope), n) for n in names); continue
            i0 = vis.index(True); i1 = len(vis) - 1 - vis[::-1].index(True)
            if not all(vis[i0:i1 + 1]): continue
            ctx['shows'].append(dict(on=list(names), scope=list(scope), by=by, kind='s', show=[round(ts[i0 - 1] / scale, 5) if i0 > 0 else -1e9, round(ts[i1] / scale, 5) if i1 < len(ts) else 1e9]))
            continue
        ctx['anims'].append((a, kind, names, scope, frame))


def anim_rig(a, kind, names, scope, F, drives, ranges):
    """One <animation> as a hinge in the game's axes: [] or [hinge]."""
    if kind in ('knob', 'slider'): kind = 'rotate' if kind == 'knob' else 'translate'
    prop = _txt(a, 'property')
    if kind not in ('rotate', 'translate', 'textranslate') or not prop: return []
    d = next((x for x in drives if re.search(x[0], prop)), None)
    if not d: return []
    by, scale = d[1], d[2]
    tex = kind == 'textranslate'
    ax, ce = a.find('axis'), a.find('center')
    if ax is not None and ax.find('x1-m') is not None:
        c = [_num(ax, t) for t in ('x1-m', 'y1-m', 'z1-m')]; axis = [_num(ax, t) - p for t, p in zip(('x2-m', 'y2-m', 'z2-m'), c)]
    else:
        axis = [_num(ax, t) for t in ('x', 'y', 'z')] if ax is not None else [0, 0, 1]
        c = [_num(ce, t) for t in ('x-m', 'y-m', 'z-m')] if ce is not None else [0, 0, 0]
    tab = []
    it = a.find('interpolation')
    if it is not None:
        for e in it.findall('entry'): tab.append((_num(e, 'ind') / scale, _num(e, 'dep')))
    if not tab:
        f = _num(a, 'factor', 1.0) * scale
        off = _num(a, 'offset-deg', None); off = _num(a, 'offset-m', None) if off is None else off; off = _num(a, 'offset', 0.0) if off is None else off
        lo = _num(a, 'min-deg', None); lo = _num(a, 'min-m', -1e9) if lo is None else lo
        hi = _num(a, 'max-deg', None); hi = _num(a, 'max-m', 1e9) if hi is None else hi
        r0, r1 = ranges.get(by, RANGE.get(by, (-1, 1)))
        if tex: tab = [(x, f * (x + off / scale)) for x in (r0, r1)]          # (a texture is slid by (value + offset) * factor)
        else:
            xs = {r0, r1} | ({(lim - off) / f for lim in (lo, hi) if abs(lim) < 1e8 and r0 < (lim - off) / f < r1} if f else set())
            tab = [(x, min(hi, max(lo, f * x + off))) for x in sorted(xs)]
    if all(abs(v) < 1e-9 for _, v in tab): return []
    e = dict(on=list(names), scope=list(scope), by=by, kind='u' if tex else kind[0], tab=[[round(x, 5), round(v, 5)] for x, v in sorted(tab)])
    if tex: e['axis'] = [round(axis[0], 5), round(-axis[1], 5)]
    else:
        av = F[:3, :3] @ np.array(axis, float); cv = F @ np.array([*c, 1.0])
        n = float(np.linalg.norm(av)) or 1.0
        e['axis'] = [round(float(v) / n, 5) for v in (av[1], av[2], av[0])]; e['c'] = [round(float(v), 5) for v in (cv[1], cv[2], cv[0])]
    for t in ('step', 'scroll', 'bias'):
        v = _num(a, t, 0.0)
        if v: e[t] = round(v / scale, 6)
    return [e]


def read_sgi(b):
    """An SGI image (.rgb, .rgba, .bw: FlightGear's older textures) as a Pillow image; one byte a channel, plain or run-length coded."""
    from PIL import Image
    magic, storage, bpc, dim, w, h, z = struct.unpack('>HBBHHHH', b[:12])
    if magic != 474 or bpc != 1: raise ValueError('not an 8-bit SGI image')
    if dim < 3: z = 1
    if dim < 2: h = 1
    px = np.zeros((z, h, w), np.uint8)
    if storage == 0: px[:] = np.frombuffer(b, np.uint8, w * h * z, 512).reshape(z, h, w)
    else:
        starts = struct.unpack('>%dI' % (h * z), b[512:512 + 4 * h * z])
        for c in range(z):
            for y in range(h):
                i, x, row = starts[c * h + y], 0, px[c, y]
                while x < w and i < len(b):
                    k = b[i]; i += 1; cnt = k & 0x7F
                    if not cnt: break
                    cnt = min(cnt, w - x)
                    if k & 0x80: row[x:x + cnt] = np.frombuffer(b, np.uint8, cnt, i); i += cnt
                    else: row[x:x + cnt] = b[i]; i += 1
                    x += cnt
    px = px[:, ::-1, :]                                          # (rows run from the bottom)
    if z == 1: return Image.fromarray(px[0], 'L')
    if z == 2: return Image.fromarray(np.dstack([px[0], px[0], px[0], px[1]]), 'RGBA')
    return Image.fromarray(np.dstack(list(px[:4])), 'RGBA' if z >= 4 else 'RGB')


def main(argv):
    out, parts, at, drop, keep, swap, rigs, drives, ranges = argv[0], [], {}, [], [], {}, [], [], {}
    models, aircraft, props, max_tex, vcol, atlas_size, tex_size, compact, webp, say = [], {}, {}, 0, False, 0, [], False, 0, False
    a = 1
    while a < len(argv):
        if argv[a] == '--at': n, v = argv[a + 1].split('='); at[n] = [float(x) for x in v.split(',')]; a += 2
        elif argv[a] == '--drop': drop.append(re.compile(argv[a + 1])); a += 2
        elif argv[a] == '--keep': keep.append(re.compile(argv[a + 1])); a += 2
        elif argv[a] == '--texture': o, n = argv[a + 1].split('='); swap[o] = n; a += 2
        elif argv[a] == '--rig': rigs.append(argv[a + 1]); a += 2
        elif argv[a] == '--drive':
            rx, d = argv[a + 1].rsplit('=', 1); d, _, rg = d.partition('@'); by, _, k = d.partition('*'); drives.append((rx, by, float(k or 1)))
            if rg: ranges[by] = tuple(float(x) for x in rg.split(':'))
            a += 2
        elif argv[a] == '--model': p, _, o = argv[a + 1].partition('@'); models.append((p, [float(x) for x in o.split(',')] if o else [])); a += 2
        elif argv[a] == '--aircraft': n, d = argv[a + 1].split('=', 1); aircraft[n] = d; a += 2
        elif argv[a] == '--prop': n, v = argv[a + 1].split('=', 1); props[n.lstrip('/')] = v; a += 2
        elif argv[a] == '--false': props.setdefault('', []).append(re.compile(argv[a + 1])); a += 2
        elif argv[a] == '--max-texture': max_tex = int(argv[a + 1]); a += 2
        elif argv[a] == '--texture-size': rx, n = argv[a + 1].rsplit('=', 1); tex_size.append((re.compile(rx), int(n))); a += 2
        elif argv[a] == '--atlas': atlas_size = int(argv[a + 1]); max_tex = max_tex or atlas_size; a += 2
        elif argv[a] == '--vertex-colors': vcol = True; a += 1
        elif argv[a] == '--compact': compact = True; a += 1
        elif argv[a] == '--files': say = True; a += 1
        elif argv[a] == '--webp': webp = int(argv[a + 1]); max_tex = max_tex or 8192; a += 2
        else: parts.append(argv[a]); a += 1

    nodes, meshes, materials, mat_key, images, tex_ix, textures = [], [], [], {}, [], {}, []
    chunks = []                                    # binary blobs, each padded to 4 bytes
    views, accessors = [], []

    def blob(b, target=None):
        off = sum(len(c) for c in chunks)
        chunks.append(b + b'\0' * (-len(b) % 4))
        v = dict(buffer=0, byteOffset=off, byteLength=len(b))
        if target: v['target'] = target
        views.append(v)
        return len(views) - 1

    def accessor(arr, kind, comp, target, minmax=False, norm=False):
        arr = np.ascontiguousarray(arr)
        acc = dict(bufferView=blob(arr.tobytes(), target), componentType=comp, count=len(arr), type=kind)
        if minmax: acc['min'] = arr.min(0).tolist(); acc['max'] = arr.max(0).tolist()
        if norm: acc['normalized'] = True
        accessors.append(acc)
        return len(accessors) - 1

    def packed(arr, kind, comp):
        """An accessor over rows that carry padding (three bytes of a normal in four): the view's stride says so."""
        v = blob(np.ascontiguousarray(arr).tobytes(), 34962); views[v]['byteStride'] = arr.shape[1] * arr.itemsize
        accessors.append(dict(bufferView=v, componentType=comp, count=len(arr), type=kind, normalized=True))
        return len(accessors) - 1

    pictures = {}                                  # path -> (Pillow image, None | 'MASK' | 'BLEND'), scaled to size

    def picture(path):
        if path not in pictures:
            from PIL import Image
            with open(path, 'rb') as f: b = f.read()
            if b[:2] == b'\x01\xda': im = read_sgi(b)
            else: im = Image.open(io.BytesIO(b)); im.load()
            if im.mode in ('P', 'LA', 'PA') or (im.mode == 'L' and 'transparency' in im.info): im = im.convert('RGBA')
            elif im.mode not in ('RGB', 'RGBA'): im = im.convert('RGBA' if 'A' in im.mode else 'RGB')
            alpha = None
            if im.mode == 'RGBA':
                al = np.asarray(im)[:, :, 3]
                if al.min() >= 250: im = im.convert('RGB')
                else: alpha = 'BLEND' if ((al > 24) & (al < 232)).mean() > 0.03 else 'MASK'
            cap = next((n for rx, n in tex_size if rx.search(os.path.basename(path))), max_tex)
            if max(im.size) > cap:
                k = cap / max(im.size); im = im.resize((max(1, round(im.size[0] * k)), max(1, round(im.size[1] * k))), Image.LANCZOS)
            pictures[path] = (im, alpha)
        return pictures[path]

    def png(im):
        o = io.BytesIO()
        if webp: im.save(o, 'WEBP', quality=webp, method=6, exact=True)
        else: im.save(o, 'PNG', optimize=True)
        return o.getvalue()

    def embed(key, b, name):
        mime = 'image/png' if b[:4] == b'\x89PNG' else 'image/webp' if b[:4] == b'RIFF' else 'image/jpeg'
        images.append(dict(bufferView=blob(b), mimeType=mime, name=name))
        textures.append(dict(sampler=0, extensions=dict(EXT_texture_webp=dict(source=len(images) - 1))) if mime == 'image/webp' else dict(source=len(images) - 1, sampler=0))
        tex_ix[key] = len(textures) - 1
        return tex_ix[key]

    def image(path):
        """-> (texture index, None | 'MASK' | 'BLEND') of an image on its own."""
        if max_tex:
            im, alpha = picture(path)
            return (tex_ix[path] if path in tex_ix else embed(path, png(im), os.path.basename(path))), alpha
        if path not in tex_ix:
            with open(path, 'rb') as f: embed(path, f.read(), os.path.basename(path))
        return tex_ix[path], None

    same = {}                                      # contents -> the first path that had them (a cockpit keeps copies of one image in many folders)

    def find_texture(base, name):
        name = swap.get(name, name).replace('\\', '/')
        found = next((p for p in (os.path.join(base, name), os.path.join(base, os.path.basename(name))) if os.path.exists(p)), None)
        d = os.path.dirname(os.path.join(base, name))               # (a name in another case)
        if not found and os.path.isdir(d): found = next((os.path.join(d, f) for f in sorted(os.listdir(d)) if f.lower() == os.path.basename(name).lower()), None)
        if not found: return None
        found = os.path.normpath(found)
        if not models: return found
        with open(found, 'rb') as f: key = hashlib.sha1(f.read()).digest()
        return same.setdefault(key, found)

    def material(m, tex, two_sided, alpha):
        rough = float(np.clip(1.0 - 0.55 * (sum(m['spec']) / 3) * min(m['shi'], 64) / 64, 0.25, 1.0))
        if vcol:
            # the color rides in the vertices: what is left is the texture, the finish and whether it is see-through
            rough = round(rough * 4) / 4
            emis = tuple(round(v * 2) / 2 for v in m['emis'])
            mode = 'BLEND' if m['trans'] > 0 else alpha
            key = ('v', rough, emis, mode, tex, two_sided)
            if key not in mat_key:
                g = dict(name=m['name'], pbrMetallicRoughness=dict(metallicFactor=0.0, roughnessFactor=rough))
                if tex is not None: g['pbrMetallicRoughness']['baseColorTexture'] = dict(index=tex)
                if max(emis) > 0: g['emissiveFactor'] = list(emis)
                if mode: g['alphaMode'] = mode
                if mode == 'MASK': g['alphaCutoff'] = 0.4
                if two_sided: g['doubleSided'] = True
                materials.append(g); mat_key[key] = len(materials) - 1
            return mat_key[key]
        key = (tuple(round(v, 3) for v in m['rgb']), tuple(round(v, 3) for v in m['emis']), round(m['trans'], 3), round(m['shi']), tex, two_sided, alpha)
        if key not in mat_key:
            g = dict(name=m['name'], pbrMetallicRoughness=dict(baseColorFactor=[*m['rgb'], 1.0 - m['trans']], metallicFactor=0.0, roughnessFactor=rough))
            if tex is not None: g['pbrMetallicRoughness']['baseColorTexture'] = dict(index=tex)
            if max(m['emis']) > 0: g['emissiveFactor'] = m['emis']
            if m['trans'] > 0 or alpha == 'BLEND': g['alphaMode'] = 'BLEND'
            elif alpha == 'MASK': g['alphaMode'] = 'MASK'; g['alphaCutoff'] = 0.4
            if two_sided: g['doubleSided'] = True
            materials.append(g); mat_key[key] = len(materials) - 1
        return mat_key[key]

    # ---- what to read: the parts named on the command line, then the model files and all they include
    todo = [(p, None, [], np.array(at.get(os.path.splitext(os.path.basename(p))[0], [0, 0, 0]), float)) for p in parts]
    ctx = dict(read=[], parts=[], anims=[], shows=[], hidden=set(), scopes=set(), aircraft=aircraft, props=props, drives=drives + [d[:3] for d in PIT_DRIVES] + DRIVES)
    for p, o in models:
        o = o + [0.0] * (6 - len(o))
        load_model(p, fg_matrix(o[0], o[1], o[2], o[3], o[4], o[5]), [], ctx)
    todo += [(p, M, sc, np.zeros(3)) for p, M, sc in ctx['parts']]
    ac_cache = {}
    objs = []                                      # every object read: dict(name, extras, tex (path), prims: [dict(P, N, uv, idx, m, two)])

    for part, F, scope, shift in todo:
        if part not in ac_cache: ac_cache[part] = parse_ac(part)
        mats, root = ac_cache[part]
        if root is None: print(f'  (nothing in {part})', file=sys.stderr); continue
        base = os.path.dirname(part)
        shift = np.array([shift[0], shift[2], -shift[1]])            # FlightGear's axes -> the file's
        pre = '/'.join(scope) + '/' if scope else ''
        chain = ['/'.join(scope[:k + 1]) for k in range(len(scope))]
        # (a placed part: the file's axes -> FlightGear's, the placement, -> the game's, as one matrix and a shift)
        if F is not None:
            A2F = np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]], float); F2G = np.array([[0, 1, 0], [0, 0, 1], [1, 0, 0]], float)
            R = F2G @ F[:3, :3] @ A2F; place = F2G @ F[:3, 3]

        def walk(o, M, T, path):
            # (the file's axes: a child's vertices are in its parent's frame, turned by rot and moved by loc)
            T = T + M @ o['loc']; M = M @ o['rot']
            names = path + [o['name']] if o['name'] and o['kind'] != 'world' else path
            seen_as = names + scope + chain + [pre + n for n in names]
            if any(d.search(n) for d in drop for n in seen_as): return
            # (hidden by a file's select: an object, group or sub-model of that name anywhere within the file)
            if any(scope[:len(hs)] == list(hs) and (hn in names or hn in scope[len(hs):]) for hs, hn in ctx['hidden']): return
            if o['kind'] == 'poly' and len(o['verts']) and o['surfs'] and (not keep or any(d.search(n) for d in keep for n in seen_as)):
                V = (M @ o['verts'].T).T + T
                rec = dict(name=o['name'], extras=dict(name=pre + o['name'], path=chain + [pre + n for n in path]), tex=None, prims=[])
                objs.append(rec)
                if o['texture']:
                    rec['tex'] = find_texture(base, o['texture'])
                    if not rec['tex']: print(f'  (no texture {os.path.join(base, o["texture"])} for {o["name"]})', file=sys.stderr)
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
                    if F is None:
                        # into the game's axes: X = -z, Y = y, Z = x
                        P = np.array(pos, np.float32)[:, [2, 1, 0]] * np.array([-1, 1, 1], np.float32)
                        N = np.array(nor, np.float32)[:, [2, 1, 0]] * np.array([-1, 1, 1], np.float32)
                    else:
                        P = (np.array(pos) @ R.T + place).astype(np.float32); N = (np.array(nor) @ R.T).astype(np.float32)
                    rec['prims'].append(dict(P=P, N=N, uv=np.array(uv, np.float32), idx=idx, m=mats[mat] if mat < len(mats) else mats[0], two=two))
            for k in o['kids']: walk(k, M, T, names)

        walk(root, np.eye(3), shift, [])

    # ---- hinges (before the textures: a drum of digits that scrolls keeps its texture to itself)
    rig = [r for x in rigs for r in read_rig(x, drives + DRIVES)]
    pit_ranges = {**{by: rg for _, by, _, rg in PIT_DRIVES}, **ranges}
    for an in ctx['anims']: rig += anim_rig(*an, drives + [d[:3] for d in PIT_DRIVES] + DRIVES, pit_ranges)
    rig += ctx['shows']
    names = {o['extras']['name'] for o in objs if o['prims']} | {p for o in objs if o['prims'] for p in o['extras']['path']}
    for r in rig:
        if 'scope' in r:
            # a model file's hinge moves the objects, groups and sub-models of that name anywhere within the file
            pre = '/'.join(r.pop('scope')); pre = pre + '/' if pre else ''
            r['on'] = sorted(f for f in names if f.startswith(pre) and f.rsplit('/', 1)[-1] in r['on'])
        else: r['on'] = [o for o in r['on'] if o in names]
    rig = [r for r in rig if r['on']]

    # ---- one sheet for the textures that are never tiled: fewer materials, fewer draw calls
    atlas, pages = {}, []                          # path -> (page, x, y, w, h); pages: dict(im, alpha, key)
    if atlas_size:
        from PIL import Image
        scroll = {n for r in rig if r['kind'] == 'u' for n in r['on']}
        ok = {}
        for o in objs:
            if not o['tex'] or not o['prims']: continue
            uv = np.concatenate([p['uv'] for p in o['prims']])
            fits = uv.min() >= -0.02 and uv.max() <= 1.02 and o['extras']['name'] not in scroll and not any(p in scroll for p in o['extras']['path'])
            ok[o['tex']] = ok.get(o['tex'], True) and bool(fits)
        G, N = 4, atlas_size
        x = y = shelf = 0; page = None
        for path in sorted((p for p in ok if ok[p]), key=lambda p: (-picture(p)[0].size[1], -picture(p)[0].size[0], p)):
            im, alpha = picture(path)
            # (a large one gives up a few pixels to its border, so that it still fills a power-of-two cell of the sheet)
            fit = tuple(d - 2 * G if d >= 256 and d & (d - 1) == 0 else d for d in im.size)
            if fit != im.size: im = im.resize(fit, Image.LANCZOS)
            w, h = im.size
            if w + 2 * G > N or h + 2 * G > N: continue
            if page is None or x + w + 2 * G > N: y += shelf; x = shelf = 0
            if page is None or y + h + 2 * G > N:
                page = dict(im=np.zeros((N, N, 4), np.uint8), alpha=False, used=0, key=('page', len(pages))); pages.append(page); x = y = shelf = 0
            page['im'][y:y + h + 2 * G, x:x + w + 2 * G] = np.pad(np.asarray(im.convert('RGBA')), ((G, G), (G, G), (0, 0)), mode='edge')     # (its edge pixels repeated around it)
            page['alpha'] = page['alpha'] or alpha is not None
            atlas[path] = (len(pages) - 1, x + G, y + G, w, h)
            x += w + 2 * G; shelf = max(shelf, h + 2 * G); page['used'] = y + shelf
        for pg in pages:
            hh = 1
            while hh < pg['used']: hh *= 2
            pg['im'] = Image.fromarray(pg['im'][:min(hh, N)], 'RGBA')
            if not pg['alpha']: pg['im'] = pg['im'].convert('RGB')

    # ---- write: each object's texture, then its triangles
    for o in objs:
        tex, alpha, uvmap = None, None, None
        if o['tex']:
            if o['tex'] in atlas:
                k, x0, y0, w, h = atlas[o['tex']]; pg = pages[k]; W, H = pg['im'].size
                tex = tex_ix[pg['key']] if pg['key'] in tex_ix else embed(pg['key'], png(pg['im']), f'sheet{k}')
                alpha = picture(o['tex'])[1]; uvmap = (x0 / W, y0 / H, w / W, h / H)
            else: tex, alpha = image(o['tex'])
        prims = []
        for p in o['prims']:
            uv = p['uv'] if uvmap is None else (np.clip(p['uv'], 0, 1) * np.array(uvmap[2:], np.float32) + np.array(uvmap[:2], np.float32)).astype(np.float32)
            big = len(p['P']) > 65535
            m = p['m']
            if compact:
                nb = np.zeros((len(p['N']), 4), np.int8); nb[:, :3] = np.round(np.clip(p['N'], -1, 1) * 127)
                # (a place on a sheet is within 0..1: sixteen bits each way; a texture that tiles keeps its floats)
                tc = accessor(np.round(uv * 65535).astype(np.uint16), 'VEC2', 5123, 34962, norm=True) if uvmap is not None else accessor(uv, 'VEC2', 5126, 34962)
                attrs = dict(POSITION=accessor(p['P'], 'VEC3', 5126, 34962, True), NORMAL=packed(nb, 'VEC3', 5120), TEXCOORD_0=tc)
            else: attrs = dict(POSITION=accessor(p['P'], 'VEC3', 5126, 34962, True), NORMAL=accessor(p['N'], 'VEC3', 5126, 34962), TEXCOORD_0=accessor(uv, 'VEC2', 5126, 34962))
            if vcol:
                col = np.clip(np.array([*m['rgb'], 1.0 - m['trans']]), 0, 1)
                if compact: attrs['COLOR_0'] = accessor(np.tile(np.round(col * 255).astype(np.uint8), (len(p['P']), 1)), 'VEC4', 5121, 34962, norm=True)
                else: attrs['COLOR_0'] = accessor(np.tile(np.round(col * 65535).astype(np.uint16), (len(p['P']), 1)), 'VEC4', 5123, 34962, norm=True)
            prims.append(dict(attributes=attrs,
                              indices=accessor(np.array(p['idx'], np.uint32 if big else np.uint16), 'SCALAR', 5125 if big else 5123, 34963),
                              material=material(m, tex, p['two'], alpha)))
        if prims:
            meshes.append(dict(name=o['name'], primitives=prims))
            nodes.append(dict(name=o['name'], mesh=len(meshes) - 1, extras=o['extras']))

    n = len(nodes)
    nodes.append(dict(name='aircraft', children=list(range(n))))
    gltf = dict(asset=dict(version='2.0', generator='Dead Reckoning tools/ac2glb.py'), scene=0, scenes=[dict(nodes=[n])], nodes=nodes, meshes=meshes, materials=materials,
                accessors=accessors, bufferViews=views, buffers=[dict(byteLength=sum(len(c) for c in chunks))])
    if rig: gltf['scenes'][0]['extras'] = dict(rig=rig)
    ext = (['KHR_mesh_quantization'] if compact else []) + (['EXT_texture_webp'] if any(i['mimeType'] == 'image/webp' for i in images) else [])
    if ext: gltf['extensionsUsed'] = ext; gltf['extensionsRequired'] = ext
    if images: gltf.update(images=images, textures=textures, samplers=[dict(magFilter=9729, minFilter=9987, wrapS=10497, wrapT=10497)])
    js = json.dumps(gltf, separators=(',', ':')).encode()
    js += b' ' * (-len(js) % 4)
    bin_ = b''.join(chunks)
    with open(out, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(bin_)))
        f.write(struct.pack('<II', len(js), 0x4E4F534A)); f.write(js)
        f.write(struct.pack('<II', len(bin_), 0x004E4942)); f.write(bin_)
    tri = sum(accessors[p['indices']]['count'] for m in meshes for p in m['primitives']) // 3
    if say:
        used = sorted({os.path.normpath(p) for p in [t[0] for t in todo] + ctx['read'] + [o['tex'] for o in objs if o['tex'] and o['prims']]})
        print('\n'.join('  ' + os.path.relpath(p) + (' (sheet %d, %d x %d)' % (atlas[p][0], atlas[p][3], atlas[p][4]) if p in atlas else '') for p in used))
    print(f'{out}: {n} objects, {tri} triangles, {len(materials)} materials, {len(images)} images, {len(rig)} hinges ({", ".join(sorted({r["by"] for r in rig}))}), {(12 + 16 + len(js) + len(bin_)) / 1e6:.2f} MB')


if __name__ == '__main__':
    if len(sys.argv) < 3: sys.exit(__doc__)
    main(sys.argv[1:])

# Packs the Yale Bright Star Catalogue (BSC5, Hoffleit & Warren 1991) into a compact binary for the game.
# usage: python3 -I bake_stars.py <bsc5.dat.gz> <out.bin>
# Layout: 'DRS1', uint32 count, then per star 6 bytes little-endian:
#   uint16 RA  (0..65535 -> 0..2pi, J2000)   int16 Dec (-32767..32767 -> -pi/2..pi/2, J2000)
#   uint8  V magnitude: (V + 2) * 25           uint8  B-V colour: (B-V + 0.5) * 100
# Sorted brightest first, so a reader can stop early.
import gzip, struct, sys, math
src, out = sys.argv[1], sys.argv[2]
stars = []
with gzip.open(src, 'rt', encoding='latin-1') as f:
    for line in f:
        line = line.rstrip('\n').ljust(197)
        if not line[75:77].strip() or not line[102:107].strip():
            continue                       # the 14 non-stellar entries have no position
        ra = (int(line[75:77]) + int(line[77:79]) / 60 + float(line[79:83]) / 3600) * 15
        dec = (int(line[84:86]) + int(line[86:88]) / 60 + int(line[88:90]) / 3600) * (-1 if line[83] == '-' else 1)
        v = float(line[102:107])
        bv = float(line[109:114]) if line[109:114].strip() else 0.6
        stars.append((v, ra, dec, bv, int(line[0:4]), line[4:14].strip()))
stars.sort()
with open(out, 'wb') as f:
    f.write(b'DRS1' + struct.pack('<I', len(stars)))
    for v, ra, dec, bv, hr, name in stars:
        f.write(struct.pack('<HhBB', min(65535, round(ra / 360 * 65536) % 65536), max(-32767, min(32767, round(dec / 90 * 32767))),
                            max(0, min(255, round((v + 2) * 25))), max(0, min(255, round((bv + 0.5) * 100)))))
print(len(stars), 'stars; brightest:', [(s[5], s[0]) for s in stars[:5]], 'faintest', stars[-1][0])
for want in ('Alp UMi', 'Alp UMa', 'Eta UMa', 'Alp Ori', 'Alp CMa', 'Alp Lyr'):
    for s in stars:
        if s[5].endswith(want) or want in s[5]:
            print(want, 'V', s[0], 'RA', round(s[1], 3), 'Dec', round(s[2], 3), 'B-V', s[3]); break

# Encodes the NASA SVS Deep Star Maps 2020 Milky Way background (linear half-float EXR, celestial plate carree,
# centre RA 0h, RA increasing to the left) as an 8-bit image: value = sqrt(min(linear, CLIP) / CLIP).
# usage: python3 -I mw_encode.py <in.raw float32 rgb> <width> <height> <out.jpg> <quality>
import numpy as np, sys
from PIL import Image
CLIP = 0.6
w, h = int(sys.argv[2]), int(sys.argv[3])
a = np.fromfile(sys.argv[1], dtype='<f4').reshape(h, w, 3)
e = np.sqrt(np.clip(a, 0, CLIP) / CLIP)
Image.fromarray((e * 255 + 0.5).astype(np.uint8)).save(sys.argv[4], quality=int(sys.argv[5]), subsampling=0, optimize=True)

#!/usr/bin/env python3
"""Bake the Moon's surface for the view from space (src/space/cosmos.js) from NASA's CGI Moon Kit.

Source: NASA's Scientific Visualization Studio, "CGI Moon Kit" (https://svs.gsfc.nasa.gov/4720): the Lunar
Reconnaissance Orbiter Camera's color mosaic and the laser altimeter's elevation model, both public domain.

    lroc_color_poles_4k.tif   color, 4096 x 2048, plate carree, longitude 0 (the middle of the near side) at the center
    ldem_16_uint.tif          elevation, 5760 x 2880 (16 pixels per degree), 16-bit, half a meter per count

Usage:  python3 tools/bake-moon.py <folder holding the two files>

Writes into public/data/:
    moon_color.jpg    the color map as it is, 4096 x 2048
    moon_relief.jpg   4096 x 2048: red and green are the ground's slope toward the east and toward the north
                      (0.5 is level, the full range is a slope of 0.7 either way), blue its height
                      (0.5 is the mean radius, the full range 20 km). The shader tilts the surface's normal by
                      the slope, which is what makes the craters and mountains show under a low sun.
and prints the color map's mean brightness, which cosmos.js uses to turn the picture into an albedo.
"""
import os, sys
import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'data')
W, H = 4096, 2048
R_MOON = 1737400.0
SLOPE_RANGE = 0.7


def main():
    d = sys.argv[1]
    color = Image.open(os.path.join(d, 'lroc_color_poles_4k.tif')).convert('RGB')
    if color.size != (W, H): color = color.resize((W, H), Image.LANCZOS)
    color.save(os.path.join(OUT, 'moon_color.jpg'), quality=88, subsampling=1)
    a = np.asarray(color, dtype=np.float64) / 255
    lin = np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)
    w = np.cos(np.deg2rad((np.arange(H) + 0.5) / H * 180 - 90))[:, None]            # by area, not by pixel
    lum = (lin @ np.array([0.2126, 0.7152, 0.0722]))
    print('mean linear luminance of the color map (by area): %.4f' % ((lum * w).sum() / (w.sum() * W)))

    dem = np.asarray(Image.open(os.path.join(d, 'ldem_16_uint.tif')), dtype=np.float64) * 0.5       # meters (an offset does not matter to a slope)
    dem -= dem.mean()
    img = Image.fromarray(dem.astype(np.float32), mode='F').resize((W, H), Image.BOX)
    h = np.asarray(img, dtype=np.float64)
    lat = np.deg2rad(90 - (np.arange(H) + 0.5) / H * 180)[:, None]
    dx = R_MOON * np.maximum(np.cos(lat), 0.03) * (2 * np.pi / W)
    dy = R_MOON * (np.pi / H)
    east = (np.roll(h, -1, axis=1) - np.roll(h, 1, axis=1)) / (2 * dx)
    north = np.zeros_like(h); north[1:-1] = (h[:-2] - h[2:]) / (2 * dy)                    # (row 0 is the north pole)
    enc = lambda s: np.clip(0.5 + s / (2 * SLOPE_RANGE), 0, 1)
    out = np.stack([enc(east), enc(north), np.clip(0.5 + h / 20000.0, 0, 1)], axis=-1)
    Image.fromarray((out * 255 + 0.5).astype(np.uint8), 'RGB').save(os.path.join(OUT, 'moon_relief.jpg'), quality=90, subsampling=0)
    print('height range %.0f .. %.0f m; slope beyond the stored range in %.2f%% of pixels' % (h.min(), h.max(), 100 * (np.abs(east) > SLOPE_RANGE).mean()))
    for f in ('moon_color.jpg', 'moon_relief.jpg'): print(f, os.path.getsize(os.path.join(OUT, f)))


if __name__ == '__main__':
    main()

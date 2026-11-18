#!/usr/bin/env python3
"""Cut the starship's recordings in public/audio/ (ship_*.mp3) from their sources.

The sources are CC0 recordings on Freesound (see public/audio/CREDITS.md), taken as Freesound's public
high-quality previews (Ogg Vorbis), as the airplane's and the rocket's recordings were:

    609830  tlalexander  grocery store fridge mechanical sound, spaceship ambient droning   https://freesound.org/people/tlalexander/sounds/609830/
    453475  kyles        motor industrial turbine hum metal vibrate2.flac                   https://freesound.org/people/kyles/sounds/453475/
    453445  kyles        hum electric transformer in large room2.flac                       https://freesound.org/people/kyles/sounds/453445/
    647669  JotrainG     Train Motor Departing passenger (Electric Multiple Unit).wav       https://freesound.org/people/JotrainG/sounds/647669/
    668561  g0ggs        Sonic boom from Falcon 9 rocket landing                            https://freesound.org/people/g0ggs/sounds/668561/

Usage:  python3 tools/bake-ship-sounds.py <folder holding 609830.ogg, 453475.ogg, 453445.ogg, 647669.ogg, 668561.ogg>

What it makes (48 kHz MP3; needs ffmpeg, NumPy):
  ship_hum.mp3      the ship itself: the deep drone of a wall of refrigeration plant, most of it below 120 Hz. A 14 s loop
  ship_impulse.mp3  the impulse engines: an industrial turbine's motor, two tones a few hertz apart beating slowly. A 10 s loop
  ship_warp.mp3     the warp field: a power transformer humming in a large room, as steady as a recording gets. A 10 s loop
  ship_spool.mp3    winding up for warp: the motor of an electric train pulling away, its whine climbing for three seconds
  ship_boom.mp3     the jump: the double sonic boom of a returning rocket booster, and its roll across the country after

Loops and levels are made as tools/bake-rocket-sounds.py makes them: the end of each cut cross-faded into its
beginning, 0.3 s of the loop's end stored before it and 0.3 s of its beginning after it (played between loop[0]
and loop[1]), loops at -23 LUFS and single sounds at -20 LUFS by plain gain. Writes ship.json beside them.
"""
import json, os, re, subprocess, sys, tempfile
import numpy as np

SR = 48000
PAD = 0.3
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'audio')


def decode(path, start, length):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(start), '-t', str(length), '-i', path, '-af', 'highpass=f=18', '-ac', '2', '-ar', str(SR), '-f', 'f32le', '-'],
                         check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).astype(np.float64)


def loudness(x):
    """Integrated loudness (LUFS) of a float array, by ffmpeg's EBU R128 meter."""
    with tempfile.NamedTemporaryFile(suffix='.f32') as f:
        f.write(x.astype(np.float32).tobytes()); f.flush()
        err = subprocess.run(['ffmpeg', '-v', 'info', '-f', 'f32le', '-ar', str(SR), '-ac', '2', '-i', f.name, '-af', 'ebur128', '-f', 'null', '-'], capture_output=True, text=True).stderr
    return float(re.findall(r'I:\s*(-?[\d.]+) LUFS', err)[-1])


def encode(x, name, lufs):
    x = x * 10 ** ((lufs - loudness(x)) / 20)
    peak = np.abs(x).max()
    if peak > 0.97: x = np.tanh(x / peak * 1.6) / np.tanh(1.6) * 0.97      # (only the boom's first crack comes near this)
    path = os.path.join(OUT, name + '.mp3')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ar', str(SR), '-ac', '2', '-i', '-', '-c:a', 'libmp3lame', '-b:a', '160k', path], input=x.astype(np.float32).tobytes(), check=True)
    return path, 20 * np.log10(np.abs(x).max())


def loop(src, start, length, fade, name):
    n, f, p = int(length * SR), int(fade * SR), int(PAD * SR)
    x = decode(src, start, length + fade + 0.05)[: n + f]
    t = np.linspace(0, np.pi / 2, f)[:, None]
    body = x[:n].copy()
    body[:f] = x[:f] * np.sin(t) + x[n:n + f] * np.cos(t)            # the end of the cut fades into its beginning
    out = np.concatenate([body[-p:], body, body[:p]])
    path, peak = encode(out, name, -23)
    return {'file': os.path.basename(path), 'loop': [PAD, round(PAD + n / SR, 6)], 'duration': round(len(out) / SR, 4), 'lufs': -23, 'truePeak': round(peak, 1)}


def single(src, start, length, fade_in, fade_out, name):
    x = decode(src, start, length)
    a, b = int(fade_in * SR), int(fade_out * SR)
    x[:a] *= np.linspace(0, 1, a)[:, None] ** 2
    x[-b:] *= np.cos(np.linspace(0, np.pi / 2, b))[:, None] ** 2
    path, peak = encode(x, name, -20)
    return {'file': os.path.basename(path), 'duration': round(len(x) / SR, 4), 'lufs': -20, 'truePeak': round(peak, 1)}


def main():
    d = sys.argv[1]
    src = lambda i: os.path.join(d, '%d.ogg' % i)
    made = {
        'ship_hum': loop(src(609830), 20.0, 14.0, 2.0, 'ship_hum'),
        'ship_impulse': loop(src(453475), 8.0, 10.0, 1.5, 'ship_impulse'),
        'ship_warp': loop(src(453445), 6.0, 10.0, 1.5, 'ship_warp'),
        'ship_spool': single(src(647669), 0.15, 2.95, 0.12, 0.12, 'ship_spool'),
        'ship_boom': single(src(668561), 1.38, 6.6, 0.02, 2.5, 'ship_boom'),
    }
    with open(os.path.join(OUT, 'ship.json'), 'w') as f:
        json.dump({'version': 1, 'format': 'mp3', 'sampleRate': SR, 'note': 'The starship\'s recordings (space/shipsound.js). Loops are played between loop[0] and loop[1].', 'sounds': made}, f, indent=1)
    for k, v in made.items(): print(k, v)


if __name__ == '__main__':
    main()

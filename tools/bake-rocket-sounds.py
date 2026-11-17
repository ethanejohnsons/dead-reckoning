#!/usr/bin/env python3
"""Cut the rocket recordings in public/audio/ (rocket_*.mp3) from their sources.

The sources are CC0 recordings on Freesound (see public/audio/CREDITS.md), taken as Freesound's public
high-quality previews (Ogg Vorbis), as the airplane's recordings were:

    613855  felix.blume   Rocket Launch Rumble at Canaveral      https://freesound.org/people/felix.blume/sounds/613855/
    220127  klangfabrik   shuttlelaunch.wav                      https://freesound.org/people/klangfabrik/sounds/220127/
    849949  qubodup       NASA Artemis II Moon Rocket Launch     https://freesound.org/people/qubodup/sounds/849949/

Usage:  python3 tools/bake-rocket-sounds.py <folder holding 613855.ogg, 220127.ogg, 849949.ogg>

What it makes (48 kHz MP3; needs ffmpeg, NumPy):
  rocket_roar.mp3     the roar and crackle of a launch heard from a few miles: 8 s of the Shuttle recording, as a loop
  rocket_rumble.mp3   the ground-shaking rumble below 120 Hz: 14 s of the Canaveral recording, as a loop
  rocket_ignite.mp3   engines lighting: the first six seconds of the Artemis II recording, from silence to full roar

Loops are made seamless by cross-fading the end of the cut into its beginning with equal power, and are stored
as the airplane's loops are: 0.3 s of the loop's end before it and 0.3 s of its beginning after it, to be played
between loopStart = 0.3 and loopEnd = 0.3 + length (an MP3 cannot be relied on to begin and end on the sample).
Loops are brought to -23 LUFS and the single sound to -20 LUFS by plain gain, like the rest of the folder.
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
    if peak > 0.97: x = np.tanh(x / peak * 1.6) / np.tanh(1.6) * 0.97      # (only the ignition's first crack comes near this)
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
    made = {
        'rocket_roar': loop(os.path.join(d, '220127.ogg'), 4.8, 8.0, 1.0, 'rocket_roar'),
        'rocket_rumble': loop(os.path.join(d, '613855.ogg'), 18.0, 14.0, 2.0, 'rocket_rumble'),
        'rocket_ignite': single(os.path.join(d, '849949.ogg'), 7.2, 6.5, 0.05, 2.5, 'rocket_ignite'),
    }
    with open(os.path.join(OUT, 'rocket.json'), 'w') as f:
        json.dump({'version': 1, 'format': 'mp3', 'sampleRate': SR, 'note': 'The rocket\'s recordings (space/rocketsound.js). Loops are played between loop[0] and loop[1].', 'sounds': made}, f, indent=1)
    for k, v in made.items(): print(k, v)


if __name__ == '__main__':
    main()

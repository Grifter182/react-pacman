#!/usr/bin/env python3
"""
Asset build: turn the raw ambientCG downloads into what the game actually ships.

Two jobs.

1. PBR TEXTURE SETS -> colour / normal / ORM
   Six greyscale-or-colour JPEGs per material is six HTTP requests and six
   samplers. AO, roughness and metalness are each a single channel, so they
   pack into one RGB image on the glTF convention (AO=R, rough=G, metal=B),
   which is exactly what MeshStandardMaterial samples when aoMap, roughnessMap
   and metalnessMap all point at the same texture. Three files, three samplers.

   Normals use the GL variant (green up). Using the DX one flips lighting on
   every sloped surface, which is the kind of bug that reads as "the art is
   wrong" rather than "the code is wrong".

2. EQUIRECT HDRI (.exr) -> RGBE (.hdr)
   Three reads .hdr with RGBELoader, which ships in the examples bundle — no
   new dependency, and RGBE is 4 bytes/pixel against EXR's 6+ for half-float
   RGB. The sky is downsampled: PMREM only needs modest resolution for
   irradiance, and 2K equirect is still sharp enough to sit behind an 80-degree
   FOV as a visible background.

Run:  python3 tools/build_assets.py <extracted-dir>
"""
import sys
import struct
from pathlib import Path

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

OUT_TEX = Path('public/textures')
OUT_ENV = Path('public/env')

# JPEG quality per map type. Normals carry geometry, not colour, so chroma
# artefacts there are visible as shading noise — they get the highest quality.
Q_COLOR = 88
Q_NORMAL = 94
Q_ORM = 90

TEXTURE_SETS = [
    {
        'name': 'rock063',
        'prefix': 'Rock063_2K-JPG',
        'size': 1024,
        'maps': {'color': 'Color', 'normal': 'NormalGL',
                 'ao': 'AmbientOcclusion', 'rough': 'Roughness', 'metal': None},
    },
    {
        'name': 'metal053c',
        'prefix': 'Metal053C_2K-JPG',
        'size': 1024,
        'maps': {'color': 'Color', 'normal': 'NormalGL',
                 'ao': None, 'rough': 'Roughness', 'metal': 'Metalness'},
    },
]

HDRIS = [
    {'name': 'daysky', 'file': 'DaySkyHDRI066B_4K_HDR.exr', 'width': 2048},
    {'name': 'indoor', 'file': 'IndoorEnvironmentHDRI005_2K_HDR.exr', 'width': 1024},
]


# --------------------------------------------------------------------- utils

def load_gray(path, size):
    """Load a single-channel map, resized. Missing map -> None."""
    if path is None or not path.exists():
        return None
    im = Image.open(path).convert('L').resize((size, size), Image.LANCZOS)
    return np.asarray(im, dtype=np.uint8)


def build_texture_set(src: Path, spec):
    name, prefix, size = spec['name'], spec['prefix'], spec['size']
    maps = spec['maps']
    dst = OUT_TEX / name
    dst.mkdir(parents=True, exist_ok=True)

    def p(suffix):
        return None if suffix is None else src / f'{prefix}_{suffix}.jpg'

    color = Image.open(p(maps['color'])).convert('RGB').resize((size, size), Image.LANCZOS)
    color.save(dst / 'color.jpg', quality=Q_COLOR, optimize=True, subsampling=1)

    normal = Image.open(p(maps['normal'])).convert('RGB').resize((size, size), Image.LANCZOS)
    normal.save(dst / 'normal.jpg', quality=Q_NORMAL, optimize=True, subsampling=0)

    # A material with no AO map is not occluded (white); one with no metalness
    # map is a dielectric (black). Those defaults keep the packed texture
    # meaningful for every material regardless of which maps shipped with it.
    ao = load_gray(p(maps['ao']), size)
    rough = load_gray(p(maps['rough']), size)
    metal = load_gray(p(maps['metal']), size)

    if ao is None:
        ao = np.full((size, size), 255, np.uint8)
    if rough is None:
        rough = np.full((size, size), 200, np.uint8)
    if metal is None:
        metal = np.zeros((size, size), np.uint8)

    orm = np.dstack([ao, rough, metal])
    Image.fromarray(orm, 'RGB').save(dst / 'orm.jpg', quality=Q_ORM, optimize=True, subsampling=0)

    total = sum(f.stat().st_size for f in dst.iterdir())
    print(f'  {name:12s} {size}px  color+normal+orm  {total/1e6:.2f} MB')


# ----------------------------------------------------------------- exr → hdr

def read_exr(path):
    import OpenEXR
    import Imath
    f = OpenEXR.InputFile(str(path))
    hdr = f.header()
    dw = hdr['dataWindow']
    w = dw.max.x - dw.min.x + 1
    h = dw.max.y - dw.min.y + 1
    pt = Imath.PixelType(Imath.PixelType.FLOAT)
    chans = [np.frombuffer(f.channel(c, pt), dtype=np.float32).reshape(h, w)
             for c in ('R', 'G', 'B')]
    return np.dstack(chans)


def box_resize(img, out_w):
    """Area-average downsample. Averaging in LINEAR light is the whole point —
    resampling an HDR in a gamma space would dim every highlight."""
    h, w, _ = img.shape
    out_h = out_w // 2
    fy, fx = h // out_h, w // out_w
    if fy < 1 or fx < 1:
        return img
    trimmed = img[:out_h * fy, :out_w * fx]
    return trimmed.reshape(out_h, fy, out_w, fx, 3).mean(axis=(1, 3))


def _rle_channel(data):
    """Radiance adaptive RLE for one channel of one scanline.

    Alternates two record types: a run (count 4..127, stored as 128+count,
    then the repeated byte) and a literal block (count 1..128, then the bytes).
    A run is only worth emitting at length 4+, because a 2- or 3-byte run costs
    the same as writing it literally but ends the current literal block.
    """
    out = bytearray()
    n = len(data)
    i = 0
    while i < n:
        run = 1
        while i + run < n and data[i + run] == data[i] and run < 127:
            run += 1
        if run >= 4:
            out.append(128 + run)
            out.append(data[i])
            i += run
            continue
        # Gather literals up to the next run of 4+.
        start = i
        while i < n and (i - start) < 128:
            look = 1
            while i + look < n and data[i + look] == data[i] and look < 4:
                look += 1
            if look >= 4:
                break
            i += 1
        out.append(i - start)
        out.extend(data[start:i])
    return bytes(out)


def write_hdr(path, img):
    """Radiance RGBE with adaptive RLE.

    RGBE shares one exponent across the three channels, so a pixel is 4 bytes
    regardless of dynamic range — a 60,000:1 sun costs the same as flat sky.
    RLE then collapses the large smooth regions an equirect sky is mostly made
    of, which is where the file size actually goes.
    """
    h, w, _ = img.shape
    rgb = np.maximum(img, 0.0)
    peak = rgb.max(axis=2)
    rgbe = np.zeros((h, w, 4), np.uint8)
    nz = peak > 1e-32
    exp = np.zeros_like(peak)
    mant = np.zeros_like(peak)
    mant[nz], exp[nz] = np.frexp(peak[nz])
    scale = np.zeros_like(peak)
    scale[nz] = mant[nz] * 256.0 / peak[nz]
    for c in range(3):
        rgbe[:, :, c] = np.clip(rgb[:, :, c] * scale, 0, 255).astype(np.uint8)
    rgbe[:, :, 3] = np.clip(exp + 128, 0, 255).astype(np.uint8)
    rgbe[~nz] = 0

    with open(path, 'wb') as f:
        f.write(b'#?RADIANCE\n')
        f.write(b'FORMAT=32-bit_rle_rgbe\n\n')
        f.write(f'-Y {h} +X {w}\n'.encode())
        # Adaptive RLE only applies to scanlines 8..32767 wide; outside that
        # range the format requires flat scanlines.
        if 8 <= w < 32768:
            for y in range(h):
                f.write(bytes([2, 2, (w >> 8) & 0xFF, w & 0xFF]))
                row = rgbe[y]
                for c in range(4):
                    f.write(_rle_channel(row[:, c].tobytes()))
        else:
            f.write(rgbe.tobytes())


def analyse_sun(img):
    """Find the sun in an equirect probe and describe it for the light rig.

    If the HDRI is the visible sky, the directional light MUST point along the
    sun that is actually in the image — otherwise shadows fall one way and the
    sky says another, which reads instantly as fake. Rather than trust a single
    hot texel (sensor noise, or a clipped cluster), take the luminance-weighted
    centroid of everything above a high percentile: that lands on the middle of
    the solar disc even when it is blown out across several pixels.

    Equirect convention matches three's: u wraps longitude from -Z, v is
    latitude from +Y down.
    """
    h, w, _ = img.shape
    lum = img @ np.array([0.2126, 0.7152, 0.0722], np.float32)

    # Latitude weighting: rows near the pole cover far less solid angle, so an
    # unweighted mean would over-count them.
    theta = (np.arange(h, dtype=np.float32) + 0.5) * np.pi / h
    solid = np.sin(theta)[:, None]

    thresh = np.percentile(lum, 99.99)
    mask = lum >= max(thresh, lum.max() * 0.5)
    if not mask.any():
        mask = lum >= lum.max() * 0.5

    ys, xs = np.nonzero(mask)
    wts = lum[ys, xs]
    u = (xs + 0.5) / w
    v = (ys + 0.5) / h
    phi = (u * 2.0 - 1.0) * np.pi
    th = v * np.pi

    # Average as vectors, not as angles — averaging longitudes numerically
    # breaks across the +/-180 seam.
    dirs = np.stack([
        np.sin(th) * np.sin(phi),
        np.cos(th),
        -np.sin(th) * np.cos(phi),
    ], axis=1)
    d = (dirs * wts[:, None]).sum(axis=0) / wts.sum()
    d /= np.linalg.norm(d)

    total = float((lum * solid).sum() / solid.sum())
    peak = float(lum.max())
    return {
        'direction': [round(float(x), 5) for x in d],
        'elevationDeg': round(float(np.degrees(np.arcsin(d[1]))), 2),
        'peakLuminance': round(peak, 1),
        'meanLuminance': round(total, 4),
        'sunPixels': int(mask.sum()),
    }


def build_hdri(src: Path, spec):
    import json
    path = src / spec['file']
    if not path.exists():
        print(f'  !! missing {spec["file"]}')
        return
    img = read_exr(path)
    img = box_resize(img, spec['width'])
    OUT_ENV.mkdir(parents=True, exist_ok=True)
    out = OUT_ENV / f'{spec["name"]}.hdr'
    write_hdr(out, img)

    meta = analyse_sun(img)
    meta['width'] = int(img.shape[1])
    meta['height'] = int(img.shape[0])
    (OUT_ENV / f'{spec["name"]}.json').write_text(json.dumps(meta, indent=2) + '\n')

    print(f'  {spec["name"]:12s} {img.shape[1]}x{img.shape[0]}  '
          f'max {img.max():.1f}  {out.stat().st_size/1e6:.2f} MB  '
          f'sun elev {meta["elevationDeg"]}deg dir {meta["direction"]}')


def main():
    src = Path(sys.argv[1] if len(sys.argv) > 1 else '.')
    print('textures:')
    for spec in TEXTURE_SETS:
        build_texture_set(src, spec)
    print('hdri:')
    for spec in HDRIS:
        build_hdri(src, spec)


if __name__ == '__main__':
    main()

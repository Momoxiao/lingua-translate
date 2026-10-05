#!/usr/bin/env python3
"""Generate Lingua's toolbar icons.

Pure stdlib (no Pillow). Renders at 4x and box-downsamples for clean edges.
The mark: a dark rounded tile with two subtitle bars, the lower one in the
brand vermilion — it stays legible all the way down to 16px.

Usage:  python3 scripts/make-icons.py
"""
import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")
SS = 4  # supersampling factor

INK = (26, 23, 20, 255)
BAR_TOP = (168, 158, 146, 255)
BAR_BOTTOM = (228, 87, 46, 255)
TRANSPARENT = (0, 0, 0, 0)


def in_rrect(px, py, x0, y0, x1, y1, r):
    if px < x0 or px > x1 or py < y0 or py > y1:
        return False
    cx = min(max(px, x0 + r), x1 - r)
    cy = min(max(py, y0 + r), y1 - r)
    dx, dy = px - cx, py - cy
    return dx * dx + dy * dy <= r * r


def render(size):
    """Return a flat RGBA bytearray of size*size."""
    hi = size * SS
    buf = bytearray(hi * hi * 4)

    # geometry, expressed in fractions of the tile so every size matches
    pad = 0.02
    radius = 0.24
    bars = [
        (0.22, 0.31, 0.78, 0.415, 0.045, BAR_TOP),
        (0.22, 0.545, 0.62, 0.65, 0.045, BAR_BOTTOM),
    ]

    for y in range(hi):
        fy = (y + 0.5) / hi
        for x in range(hi):
            fx = (x + 0.5) / hi
            color = TRANSPARENT
            if in_rrect(fx, fy, pad, pad, 1 - pad, 1 - pad, radius):
                color = INK
                for (bx0, by0, bx1, by1, br, bcol) in bars:
                    if in_rrect(fx, fy, bx0, by0, bx1, by1, br):
                        color = bcol
                        break
            i = (y * hi + x) * 4
            buf[i : i + 4] = bytes(color)

    # box downsample -> anti-aliasing
    out = bytearray(size * size * 4)
    area = SS * SS
    for y in range(size):
        for x in range(size):
            r = g = b = a = 0
            for dy in range(SS):
                base = ((y * SS + dy) * hi + x * SS) * 4
                for dx in range(SS):
                    i = base + dx * 4
                    r += buf[i]
                    g += buf[i + 1]
                    b += buf[i + 2]
                    a += buf[i + 3]
            o = (y * size + x) * 4
            out[o] = r // area
            out[o + 1] = g // area
            out[o + 2] = b // area
            out[o + 3] = a // area
    return out


def write_png(path, size, rgba):
    raw = b"".join(b"\x00" + bytes(rgba[y * size * 4 : (y + 1) * size * 4]) for y in range(size))

    def chunk(typ, data):
        return (
            struct.pack(">I", len(data))
            + typ
            + data
            + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)
        )

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as fh:
        fh.write(png)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in (16, 32, 48, 128):
        rgba = render(size)
        path = os.path.join(OUT_DIR, f"icon{size}.png")
        write_png(path, size, rgba)
        print(f"wrote {os.path.relpath(path)} ({os.path.getsize(path)} bytes)")


if __name__ == "__main__":
    main()

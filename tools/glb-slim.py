#!/usr/bin/env python3
"""Slim a baked GLB.

An FK bake out of a DCC tool writes every channel for every joint on every
frame, whether or not anything moved -- and then the exporter writes a PNG
copy of the texture alongside the WebP you asked for, in case the target
cannot read WebP. Between them that is most of the file.

Measured on colin_animations.glb: 11.8 MB, of which

    translation   4.11 MB   every channel moves < 0.001 units on a model
                            5.47 units tall. Bake noise, not animation.
    rotation      4.63 MB   the actual performance.
    scale         0.09 MB   entirely constant, as it always is.
    PNG texture   1.58 MB   a duplicate of a 40 KB WebP.

So: collapse anything that does not move to a single keyframe, store
rotations as normalised 16-bit (a quaternion component lives in [-1, 1],
which is exactly what that format is for, and 3e-5 of resolution is far
below anything a joint can show), and drop the duplicate image.

Run again after any re-export:  python3 tools/glb-slim.py models/thing.glb
"""
import json, struct, sys, os

DEFAULT = {"translation": [0, 0, 0], "rotation": [0, 0, 0, 1], "scale": [1, 1, 1]}
N = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT2": 4, "MAT3": 9, "MAT4": 16}
SZ = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}
FMT = {5120: "b", 5121: "B", 5122: "h", 5123: "H", 5125: "I", 5126: "f"}
STILL = 1e-4          # a channel that moves less than this did not move


def load(path):
    b = open(path, "rb").read()
    total = struct.unpack_from("<III", b, 0)[2]
    off, chunks = 12, []
    while off < total:
        clen, ctype = struct.unpack_from("<II", b, off)
        chunks.append((ctype, off + 8, clen))
        off += 8 + clen
    g = json.loads(b[chunks[0][1]:chunks[0][1] + chunks[0][2]].decode("utf-8"))
    bin_at = next(c[1] for c in chunks if c[0] == 0x004E4942)
    return b, g, bin_at


def main(path):
    src = path
    raw, g, BIN = load(path)
    bvs, acc = g["bufferViews"], g["accessors"]

    def read(i):
        a = acc[i]
        n, cs = N[a["type"]], SZ[a["componentType"]]
        bv = bvs[a["bufferView"]]
        base = BIN + bv.get("byteOffset", 0) + a.get("byteOffset", 0)
        stride = bv.get("byteStride") or cs * n
        f = FMT[a["componentType"]]
        out = []
        for k in range(a["count"]):
            out.append(list(struct.unpack_from("<%d%s" % (n, f), raw, base + k * stride)))
        return out

    def blob(i):
        """The bytes an accessor covers, for anything copied through untouched."""
        a = acc[i]
        bv = bvs[a["bufferView"]]
        n, cs = N[a["type"]], SZ[a["componentType"]]
        stride = bv.get("byteStride") or cs * n
        base = BIN + bv.get("byteOffset", 0) + a.get("byteOffset", 0)
        return raw[base:base + stride * a["count"]], stride

    out = bytearray()
    newbv, newacc = [], []

    def put(data, target=None):
        while len(out) % 4:
            out.append(0)
        off = len(out)
        out.extend(data)
        bv = {"buffer": 0, "byteOffset": off, "byteLength": len(data)}
        if target:
            bv["target"] = target
        newbv.append(bv)
        return len(newbv) - 1

    seen = {}

    def add(data, comp, typ, count, mn=None, mx=None, norm=False, target=None):
        """Deduplicated by content, which is most of the saving in the JSON.

        A bake writes one sampler per joint per channel per clip, and the vast
        majority of them are byte-identical: every constant scale is (1,1,1),
        every constant translation is that joint's own bone offset and does not
        change between clips, and all 246 channels of one clip share the same
        list of key TIMES. Collapsing those took the accessor table from 8,856
        entries to a few hundred -- and the JSON chunk, which is pure accessor
        bookkeeping, from 3.6 MB to a fraction of it."""
        key = (bytes(data), comp, typ, count, norm)
        if key in seen:
            return seen[key]
        a = {"bufferView": put(data, target), "componentType": comp,
             "count": count, "type": typ}
        if norm:
            a["normalized"] = True
        if mn is not None:
            a["min"], a["max"] = mn, mx
        newacc.append(a)
        seen[key] = len(newacc) - 1
        return seen[key]

    def copy(i, target=None):
        """Straight through, keeping min/max."""
        data, stride = blob(i)
        a = acc[i]
        na = {"bufferView": put(data, target), "componentType": a["componentType"],
              "count": a["count"], "type": a["type"]}
        for k in ("min", "max", "normalized"):
            if k in a:
                na[k] = a[k]
        newacc.append(na)
        return len(newacc) - 1

    remap = {}

    def once(i, target=None):
        if i not in remap:
            remap[i] = copy(i, target)
        return remap[i]

    # ---- mesh, skin, everything that is not an animation: copied ----
    for m in g.get("meshes", []):
        for p in m["primitives"]:
            for k, v in p["attributes"].items():
                p["attributes"][k] = once(v, 34962)
            if "indices" in p:
                p["indices"] = once(p["indices"], 34963)
    for s in g.get("skins", []):
        if "inverseBindMatrices" in s:
            s["inverseBindMatrices"] = once(s["inverseBindMatrices"])

    # ---- animations ----
    kept = {"translation": 0, "rotation": 0, "scale": 0}
    flat = {"translation": 0, "rotation": 0, "scale": 0}
    dropped = {"translation": 0, "rotation": 0, "scale": 0}
    for an in g.get("animations", []):
        for ch in an["channels"]:
            s = an["samplers"][ch["sampler"]]
            path = ch["target"]["path"]
            times = [t[0] for t in read(s["input"])]
            vals = read(s["output"])
            n = len(vals[0])
            moved = any(abs(vals[k][c] - vals[0][c]) > STILL
                        for k in range(1, len(vals)) for c in range(n))
            if not moved:
                flat[path] += 1
                # A constant channel that agrees with the node's rest transform
                # says nothing at all: without it the node simply stays where
                # the scene put it. Those are dropped outright rather than
                # collapsed to one key, which is what takes the JSON down -- the
                # JSON is almost entirely channel and sampler bookkeeping, two
                # objects per channel per clip, and there are 8,856 of them.
                nd = g["nodes"][ch["target"]["node"]]
                rest = nd.get(path) or DEFAULT[path]
                if all(abs(vals[0][c] - rest[c]) <= STILL for c in range(n)):
                    dropped[path] += 1
                    ch["_drop"] = 1
                    continue
                s["input"] = add(struct.pack("<f", times[0]), 5126, "SCALAR", 1,
                                 [times[0]], [times[0]])
                s["output"] = add(struct.pack("<%df" % n, *vals[0]), 5126,
                                  "VEC%d" % n if n > 1 else "SCALAR", 1)
                s["interpolation"] = "STEP"
                continue
            kept[path] += 1
            s["input"] = add(struct.pack("<%df" % len(times), *times), 5126,
                             "SCALAR", len(times), [min(times)], [max(times)])
            if path == "rotation":
                # normalised int16: a quaternion component is already in [-1, 1]
                q = bytearray()
                for v in vals:
                    for c in v:
                        c = -1.0 if c < -1 else 1.0 if c > 1 else c
                        q += struct.pack("<h", max(-32767, min(32767, round(c * 32767))))
                s["output"] = add(bytes(q), 5122, "VEC4", len(vals), norm=True)
            else:
                d = bytearray()
                for v in vals:
                    d += struct.pack("<%df" % n, *v)
                s["output"] = add(bytes(d), 5126, "VEC%d" % n, len(vals))

    for an in g.get("animations", []):
        chans, samps, smap = [], [], {}
        for ch in an["channels"]:
            if ch.pop("_drop", 0):
                continue
            si = ch["sampler"]
            if si not in smap:
                smap[si] = len(samps)
                samps.append(an["samplers"][si])
            ch["sampler"] = smap[si]
            chans.append(ch)
        an["channels"], an["samplers"] = chans, samps

    # ---- images: keep one, prefer the small one ----
    keep = {}
    for t in g.get("textures", []):
        w = (t.get("extensions", {}).get("EXT_texture_webp") or {}).get("source")
        base = t.get("source")
        pick = base
        if w is not None:
            a = g["images"][w].get("bufferView")
            bfr = g["images"][base].get("bufferView") if base is not None else None
            wl = bvs[a]["byteLength"] if a is not None else 1 << 30
            pl = bvs[bfr]["byteLength"] if bfr is not None else 1 << 30
            pick = w if wl < pl else base
        keep[id(t)] = pick
    newimg, imap = [], {}
    for t in g.get("textures", []):
        p = keep[id(t)]
        if p is None:
            continue
        if p not in imap:
            im = dict(g["images"][p])
            data = raw[BIN + bvs[im["bufferView"]].get("byteOffset", 0):
                       BIN + bvs[im["bufferView"]].get("byteOffset", 0) + bvs[im["bufferView"]]["byteLength"]]
            im["bufferView"] = put(data)
            imap[p] = len(newimg)
            newimg.append(im)
        t["source"] = imap[p]
        # the extension pointed at an index in the OLD image list
        if "extensions" in t:
            t["extensions"].pop("EXT_texture_webp", None)
            if not t["extensions"]:
                t.pop("extensions")
    g["images"] = newimg
    if not any("EXT_texture_webp" in json.dumps(t) for t in g.get("textures", [])):
        for k in ("extensionsUsed", "extensionsRequired"):
            if k in g:
                g[k] = [e for e in g[k] if e != "EXT_texture_webp"]
                if not g[k]:
                    g.pop(k)

    g["bufferViews"] = newbv
    g["accessors"] = newacc
    g["buffers"] = [{"byteLength": len(out)}]

    js = json.dumps(g, separators=(",", ":")).encode("utf-8")
    while len(js) % 4:
        js += b" "
    while len(out) % 4:
        out.append(0)
    head = struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(out))
    blobs = head + struct.pack("<II", len(js), 0x4E4F534A) + js + \
        struct.pack("<II", len(out), 0x004E4942) + bytes(out)
    dst = sys.argv[2] if len(sys.argv) > 2 else src.replace(".glb", ".slim.glb")
    f = open(dst, "wb")
    f.write(blobs)
    f.flush()
    os.fsync(f.fileno())
    f.close()

    print("channels animated ", kept)
    print("channels flattened", flat)
    print("channels dropped  ", dropped)
    print("%s  %.2f MB  ->  %s  %.2f MB   (json %.2f + bin %.2f)"
          % (src, os.path.getsize(src) / 1e6, dst, os.path.getsize(dst) / 1e6,
             len(js) / 1e6, len(out) / 1e6))


if __name__ == "__main__":
    main(sys.argv[1])

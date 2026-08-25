# A synthetic head with real ARKit-named morph targets. There is no CC mesh in
# the repo yet, so without this the viseme driver is only ever tested against
# models that have no shapes at all -- which proves nothing about the driver.
import json, struct, math, os

import sys
# Two fixtures, because the page has two rigs worth proving. "arkit" exercises
# the fallback that reconstructs a mouth from parts; "eight" exercises the
# purpose-sculpted set -- which matters most before anyone spends a weekend
# sculpting into it, since a fixture is a lot cheaper than a re-sculpt.
MODE = sys.argv[1] if len(sys.argv) > 1 else "arkit"
SETS = {
 "arkit": (["jawOpen","mouthClose","mouthPucker","mouthFunnel","mouthShrugUpper",
            "mouthSmileLeft","mouthSmileRight","mouthStretchLeft","mouthStretchRight",
            "mouthPressLeft","mouthPressRight","mouthLowerDownLeft","mouthLowerDownRight",
            "tongueOut"], "_probe.glb"),
 "eight": (["viseme_AI","viseme_E","viseme_O","viseme_U",
            "viseme_MBP","viseme_FV","viseme_L","viseme_etc"], "_probe8.glb"),
}
NAMES, OUTNAME = SETS[MODE]

RS, RT = 28, 20           # a UV sphere: rings, stacks
verts, idx = [], []
for j in range(RT + 1):
    v = j / RT; phi = v * math.pi
    for i in range(RS + 1):
        u = i / RS; th = u * 2 * math.pi
        verts.append((math.sin(phi) * math.sin(th), math.cos(phi), math.sin(phi) * math.cos(th)))
for j in range(RT):
    for i in range(RS):
        a = j * (RS + 1) + i; b = a + RS + 1
        idx += [a, b, a + 1, b, b + 1, a + 1]

MOUTH = (0.0, -0.42, 0.90)   # front of the sphere, low: where a mouth would be
def falloff(p, r=0.55):
    d = math.dist(p, MOUTH)
    return max(0.0, 1.0 - (d / r)) ** 2

# each shape moves the mouth region its own way, so the silhouettes differ
# deliberately exaggerated. This is a yes/no instrument -- a shape you have to
# squint at cannot answer "did the influence reach the mesh".
DIR = {
 "jawOpen":(0,-.90,.10), "mouthClose":(0,.34,-.22), "mouthPucker":(0,0,.80),
 "mouthFunnel":(0,-.26,.62), "mouthShrugUpper":(0,.42,.24),
 "mouthSmileLeft":(-.62,.32,0), "mouthSmileRight":(.62,.32,0),
 "mouthStretchLeft":(-.74,0,0), "mouthStretchRight":(.74,0,0),
 "mouthPressLeft":(-.34,.20,-.26), "mouthPressRight":(.34,.20,-.26),
 "mouthLowerDownLeft":(-.24,-.62,0), "mouthLowerDownRight":(.24,-.62,0),
 "tongueOut":(0,-.22,.95),
 # the eight, each a plainly different mouth so a wrong mapping is obvious
 "viseme_AI":(0,-.85,.10), "viseme_E":(-.55,-.20,0), "viseme_O":(0,-.30,.70),
 "viseme_U":(0,-.05,.90),  "viseme_MBP":(0,.30,-.24), "viseme_FV":(0,-.45,-.15),
 "viseme_L":(0,-.30,.85),  "viseme_etc":(0,-.35,.15),
}

def pack_f32(rows):  return b"".join(struct.pack("<3f", *r) for r in rows)
def pack_u16(v):     return b"".join(struct.pack("<H", x) for x in v)

blobs, views, accs = [], [], []
def add(data, target, acc):
    off = sum(len(b) + (-len(b)) % 4 for b in blobs)
    blobs.append(data)
    views.append({"buffer":0, "byteOffset":off, "byteLength":len(data), **({"target":target} if target else {})})
    accs.append({**acc, "bufferView":len(views)-1})
    return len(accs) - 1

def mm(rows):
    lo = [min(r[k] for r in rows) for k in range(3)]
    hi = [max(r[k] for r in rows) for k in range(3)]
    return lo, hi

lo, hi = mm(verts)
POS = add(pack_f32(verts), 34962, {"componentType":5126,"count":len(verts),"type":"VEC3","min":lo,"max":hi})
nrm = [tuple(c for c in v) for v in verts]     # unit sphere: position is the normal
NRM = add(pack_f32(nrm), 34962, {"componentType":5126,"count":len(nrm),"type":"VEC3"})
IDX = add(pack_u16(idx), 34963, {"componentType":5123,"count":len(idx),"type":"SCALAR"})

targets = []
for n in NAMES:
    d = DIR[n]
    rows = [tuple(d[k] * falloff(v) for k in range(3)) for v in verts]
    tlo, thi = mm(rows)
    targets.append({"POSITION": add(pack_f32(rows), 34962,
        {"componentType":5126,"count":len(rows),"type":"VEC3","min":tlo,"max":thi})})

buf = b""
for b in blobs:
    buf += b + b"\x00" * ((-len(b)) % 4)

g = {
 "asset":{"version":"2.0","generator":"glorb face-test fixture"},
 "scene":0, "scenes":[{"nodes":[0]}],
 "nodes":[{"mesh":0,"name":"Head"}],
 "meshes":[{"name":"Head","weights":[0.0]*len(NAMES),
   "extras":{"targetNames":NAMES},
   "primitives":[{"attributes":{"POSITION":POS,"NORMAL":NRM},"indices":IDX,
                  "targets":targets,"material":0}]}],
 "materials":[{"name":"skin","pbrMetallicRoughness":
   {"baseColorFactor":[0.82,0.66,0.58,1],"metallicFactor":0.0,"roughnessFactor":0.62}}],
 "buffers":[{"byteLength":len(buf)}],
 "bufferViews":views, "accessors":accs,
}

j = json.dumps(g, separators=(",",":")).encode()
j += b" " * ((-len(j)) % 4)
out = struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(j) + 8 + len(buf))
out += struct.pack("<II", len(j), 0x4E4F534A) + j
out += struct.pack("<II", len(buf), 0x004E4942) + buf
p = os.path.join(os.path.dirname(__file__), "..", "models", OUTNAME)
open(p, "wb").write(out)
print("wrote", p, len(out), "bytes,", len(NAMES), "shapes,", len(verts), "verts")

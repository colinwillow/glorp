"""Cut a face mesh down to the shapes the viseme rig can actually drive.

    blender --background --python tools/slim_face.py -- --in char.fbx --report
    blender --background --python tools/slim_face.py -- --in char.fbx --out models/face.glb

A Character Creator export ships 60-70 blend shapes. face-test.html drives
fourteen. Every one of the others is per-vertex data written into the file for
a mouth that will never use it, and morph data scales as vertices x shapes --
it is the whole reason the export is enormous.

The keep-list is matched with the SAME canonicalisation the page uses, so
whatever your mesh calls a shape, the script keeps exactly what the page can
find. Mouth_Smile_L and mouthSmileLeft are the same shape to both.

--report changes nothing. Run it first: it prints how many vertices each shape
actually moves, which is the number that tells you where the bytes went, and
which shapes are dead weight that move nothing at all.
"""

import sys, os, re

# the fourteen the rig drives, spelled the ARKit way (see VIS_RIG in face-test.html)
WANT = [
    "jawOpen", "mouthClose", "mouthPucker", "mouthFunnel", "mouthShrugUpper",
    "mouthSmileLeft", "mouthSmileRight", "mouthStretchLeft", "mouthStretchRight",
    "mouthPressLeft", "mouthPressRight", "mouthLowerDownLeft", "mouthLowerDownRight",
    "tongueOut",
]

def canon(x):
    """Identical to canon() in face-test.html. If these two ever disagree, the
    script keeps shapes the page cannot find, or drops ones it needs."""
    x = re.sub(r"[^a-z]", "", x.lower())
    x = re.sub(r"left$", "l", x)
    x = re.sub(r"right$", "r", x)
    return x

WANT_C = {canon(w): w for w in WANT}


def build_map(names):
    """names -> {wanted shape: the key chosen for it}. Byte-for-byte the same
    rule as buildMap() in face-test.html. If these two ever disagree the script
    keeps shapes the page cannot find, or drops ones it needs.

    Shortest containing name wins, because CC ships Mouth_Funnel_Up_L and
    Mouth_Funnel_Down_L alongside plain Mouth_Funnel, and picking a corner
    variant for O does not look like a bug -- it looks like a bad mesh."""
    cn = [canon(n) for n in names]
    out = {}
    for wc, w in WANT_C.items():
        i = cn.index(wc) if wc in cn else -1
        if i < 0:
            for j, c in enumerate(cn):
                if wc in c and (i < 0 or len(c) < len(cn[i])):
                    i = j
        if i >= 0:
            out[w] = names[i]
    return out


def args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    a = {"in": None, "out": None, "report": False,
         "morph_normals": False, "keep": [], "eps": 1e-4}
    i = 0
    while i < len(argv):
        t = argv[i]
        if t in ("--in", "--out"):
            a[t[2:]] = argv[i + 1]; i += 2
        elif t == "--keep":
            a["keep"] += [s.strip() for s in argv[i + 1].split(",") if s.strip()]; i += 2
        elif t == "--eps":
            a["eps"] = float(argv[i + 1]); i += 2
        elif t == "--report":
            a["report"] = True; i += 1
        elif t == "--morph-normals":
            a["morph_normals"] = True; i += 1
        else:
            print("unknown argument: " + t); sys.exit(2)
    return a


def main():
    import bpy, numpy as np

    a = args()
    if not a["in"]:
        print("need --in <file.fbx|file.glb|file.obj>"); sys.exit(2)
    if not a["report"] and not a["out"]:
        print("need --out <file.glb>, or --report to only look"); sys.exit(2)

    for w in a["keep"]:
        WANT_C.setdefault(canon(w), w)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    src = os.path.abspath(a["in"])
    ext = os.path.splitext(src)[1].lower()
    if ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=src)
    elif ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=src)
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=src)
    else:
        print("cannot import " + ext); sys.exit(2)

    print("\n=== %s ===" % os.path.basename(src))
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    print("%d mesh object(s), %d total vertices"
          % (len(meshes), sum(len(o.data.vertices) for o in meshes)))

    grand_keep = grand_drop = grand_dead = 0

    for o in meshes:
        me = o.data
        sk = me.shape_keys
        n = len(me.vertices)
        if not sk or len(sk.key_blocks) < 2:
            print("\n  %-28s %6d verts   no shape keys" % (o.name, n))
            continue

        basis = sk.key_blocks[0]
        b = np.empty(n * 3, dtype=np.float32)
        basis.data.foreach_get("co", b)

        # a threshold in absolute units is meaningless across a mesh in metres
        # and one in centimetres, so scale it to the model
        bb = b.reshape(n, 3)
        diag = float(np.linalg.norm(bb.max(axis=0) - bb.min(axis=0))) or 1.0
        eps = diag * a["eps"]

        names = [kb.name for kb in sk.key_blocks[1:]]
        chosen = build_map(names)                 # {want: key name}
        by_key = {v: k for k, v in chosen.items()}

        cur = np.empty(n * 3, dtype=np.float32)
        keep, drop, dead = [], [], []
        rows = []
        for kb in sk.key_blocks[1:]:
            kb.data.foreach_get("co", cur)
            d = (cur - b).reshape(n, 3)
            mag = np.sqrt((d * d).sum(axis=1))
            moved = int((mag > eps).sum())
            hit = by_key.get(kb.name)
            if hit and moved == 0:
                # chosen for a slot but it deforms nothing: worth saying loudly,
                # because the rig will drive it and the mouth will not move
                dead.append(kb); tag = "DEAD but wanted for " + hit
            elif moved == 0:
                dead.append(kb); tag = "dead"
            elif hit:
                keep.append(kb); tag = "keep -> " + hit
            else:
                drop.append(kb); tag = "drop"
            rows.append((kb.name, moved, float(mag.max()), tag))

        print("\n  %-28s %6d verts   %d shape keys" % (o.name, n, len(sk.key_blocks) - 1))
        print("    %-34s %8s %9s  %s" % ("shape", "moves", "max", "verdict"))
        for name, moved, mx, tag in sorted(rows, key=lambda r: -r[1]):
            print("    %-34s %7d%% %9.4f  %s"
                  % (name[:34], round(100 * moved / n), mx, tag))
        print("    -> %d keep, %d drop, %d dead" % (len(keep), len(drop), len(dead)))

        # Where the bytes go. Positions only, which is what we export -- morph
        # normals double every one of these numbers, which is why they are off.
        # Dense is 3 floats a vertex; sparse adds a 4-byte index but only pays
        # for vertices that actually moved.
        tot_moved = sum(r[1] for r in rows)
        keep_moved = sum(r[1] for r in rows if r[0] in {k.name for k in keep})
        print("    morph data, dense all shapes : %7.1f MB" % (n * len(rows) * 12 / 1e6))
        print("    morph data, sparse all       : %7.1f MB" % (tot_moved * 16 / 1e6))
        print("    morph data, sparse kept only : %7.1f MB  <- what you get"
              % (keep_moved * 16 / 1e6))

        grand_keep += len(keep); grand_drop += len(drop); grand_dead += len(dead)

        if not a["report"]:
            for kb in drop + dead:
                o.shape_key_remove(kb)

    found = set()
    for o in meshes:
        if o.data.shape_keys:
            found |= set(build_map([kb.name for kb in o.data.shape_keys.key_blocks[1:]]))
    missing = set(WANT_C.values()) - found
    print("\n%d kept, %d dropped, %d dead across the file" % (grand_keep, grand_drop, grand_dead))
    if missing:
        print("NOT FOUND, the rig will not be able to drive these: "
              + ", ".join(sorted(missing)))
    else:
        print("all %d shapes the rig drives are present." % len(WANT_C))

    if a["report"]:
        print("\n--report: nothing was changed.")
        return

    out = os.path.abspath(a["out"])
    os.makedirs(os.path.dirname(out), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=out,
        export_format="GLB",
        export_morph=True,
        # morph normals roughly double the morph data. The silhouette is right
        # without them; only the shading inside the deformed area is stale.
        export_morph_normal=a["morph_normals"],
        export_morph_tangent=False,
        # only the vertices that move get written -- a mouth shape touches a few
        # percent of a body mesh, so this is where the order of magnitude is
        export_try_sparse_sk=True,
        export_apply=False,
    )
    print("\nwrote %s  (%.2f MB)" % (out, os.path.getsize(out) / 1e6))


if __name__ == "__main__":
    main()

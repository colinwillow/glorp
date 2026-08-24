"""Delete nodes from a GLB and garbage-collect everything they were holding.

    python3 tools/glb_prune.py in.glb out.glb --drop "Poses_*"
    python3 tools/glb_prune.py in.glb --list

A Cinema 4D Pose Morph exports twice: once as proper blend shapes, and again
as one full duplicate mesh per target, parented under a Poses_ group. The
duplicates are pure waste -- and worse than waste, because they sit outside
the armature at a different scale, so anything measuring the model measures
them instead.

Nothing here decodes geometry. Draco-compressed primitives are moved across
untouched; we only drop the ones nobody references any more and repack the
buffer around what is left.
"""

import json, struct, sys, fnmatch, os

GLB, JSON_C, BIN_C = 0x46546C67, 0x4E4F534A, 0x004E4942


def read(path):
    f = open(path, "rb").read()
    if f[:4] != b"glTF":
        raise SystemExit(path + " is not a GLB")
    off, chunks = 12, {}
    while off < len(f):
        ln, ty = struct.unpack("<II", f[off:off + 8])
        chunks[ty] = f[off + 8:off + 8 + ln]
        off += 8 + ln
    return json.loads(chunks[JSON_C]), chunks.get(BIN_C, b"")


def write(path, g, buf):
    j = json.dumps(g, separators=(",", ":")).encode()
    j += b" " * ((-len(j)) % 4)
    buf += b"\x00" * ((-len(buf)) % 4)
    out = struct.pack("<III", GLB, 2, 12 + 8 + len(j) + (8 + len(buf) if buf else 0))
    out += struct.pack("<II", len(j), JSON_C) + j
    if buf:
        out += struct.pack("<II", len(buf), BIN_C) + buf
    open(path, "wb").write(out)
    return len(out)


def descendants(nodes, i, out):
    out.add(i)
    for c in nodes[i].get("children", []):
        descendants(nodes, c, out)


def main():
    a = sys.argv[1:]
    if not a:
        raise SystemExit(__doc__)
    src = a[0]
    g, buf = read(src)
    nodes = g.get("nodes", [])

    if "--list" in a:
        print("%d nodes, %d meshes, %.2f MB" % (len(nodes), len(g.get("meshes", [])),
                                                os.path.getsize(src) / 1e6))
        for i, n in enumerate(nodes):
            if n.get("children"):
                print("  [%3d] %-34s %d children" % (i, n.get("name", "?"), len(n["children"])))
        return

    dst = a[1]
    pats = [a[i + 1] for i, t in enumerate(a) if t == "--drop"]
    if not pats:
        raise SystemExit("need --drop <pattern>")

    doomed = set()
    for i, n in enumerate(nodes):
        if any(fnmatch.fnmatch(n.get("name", ""), p) for p in pats):
            descendants(nodes, i, doomed)
    if not doomed:
        raise SystemExit("nothing matched " + ", ".join(pats))

    # a joint must never be dropped out from under its skin, however it is named
    joints = {j for s in g.get("skins", []) for j in s.get("joints", [])}
    kept_joints = doomed & joints
    if kept_joints:
        print("refusing to drop %d node(s) that are skin joints: %s"
              % (len(kept_joints), [nodes[i].get("name") for i in sorted(kept_joints)][:6]))
        doomed -= kept_joints

    keep = [i for i in range(len(nodes)) if i not in doomed]
    print("dropping %d of %d nodes" % (len(doomed), len(nodes)))

    ni = {old: new for new, old in enumerate(keep)}
    new_nodes = []
    for old in keep:
        n = dict(nodes[old])
        if "children" in n:
            kids = [ni[c] for c in n["children"] if c in ni]
            if kids: n["children"] = kids
            else: n.pop("children")
        new_nodes.append(n)

    # which meshes survive
    used_mesh = sorted({n["mesh"] for n in new_nodes if "mesh" in n})
    mi = {old: new for new, old in enumerate(used_mesh)}
    print("keeping %d of %d meshes" % (len(used_mesh), len(g.get("meshes", []))))
    new_meshes = [g["meshes"][m] for m in used_mesh]
    for n in new_nodes:
        if "mesh" in n: n["mesh"] = mi[n["mesh"]]

    # every accessor anything still points at
    used_acc = set()
    for m in new_meshes:
        for p in m["primitives"]:
            used_acc |= set(p.get("attributes", {}).values())
            if "indices" in p: used_acc.add(p["indices"])
            for t in p.get("targets", []): used_acc |= set(t.values())
    for s in g.get("skins", []):
        if "inverseBindMatrices" in s: used_acc.add(s["inverseBindMatrices"])
    for an in g.get("animations", []):
        for sm in an.get("samplers", []): used_acc |= {sm["input"], sm["output"]}

    acc = g.get("accessors", [])
    keep_acc = sorted(used_acc)
    ai = {old: new for new, old in enumerate(keep_acc)}

    # bufferViews come from accessors, from sparse accessors, and from Draco --
    # miss the Draco one and every kept mesh loses its geometry
    used_bv = set()
    for o in keep_acc:
        A = acc[o]
        if "bufferView" in A: used_bv.add(A["bufferView"])
        sp = A.get("sparse")
        if sp:
            used_bv.add(sp["indices"]["bufferView"]); used_bv.add(sp["values"]["bufferView"])
    for m in new_meshes:
        for p in m["primitives"]:
            d = p.get("extensions", {}).get("KHR_draco_mesh_compression")
            if d: used_bv.add(d["bufferView"])
    for im in g.get("images", []):
        if "bufferView" in im: used_bv.add(im["bufferView"])

    bvs = g.get("bufferViews", [])
    keep_bv = sorted(used_bv)
    bi = {old: new for new, old in enumerate(keep_bv)}
    print("keeping %d of %d accessors, %d of %d bufferViews"
          % (len(keep_acc), len(acc), len(keep_bv), len(bvs)))

    # repack the binary chunk around only the views we kept
    out = bytearray()
    new_bvs = []
    for o in keep_bv:
        B = dict(bvs[o])
        st, ln = B.get("byteOffset", 0), B["byteLength"]
        while len(out) % 4: out.append(0)
        B["byteOffset"] = len(out); B["buffer"] = 0
        out += buf[st:st + ln]
        new_bvs.append(B)

    new_acc = []
    for o in keep_acc:
        A = dict(acc[o])
        if "bufferView" in A: A["bufferView"] = bi[A["bufferView"]]
        if "sparse" in A:
            S = json.loads(json.dumps(A["sparse"]))
            S["indices"]["bufferView"] = bi[S["indices"]["bufferView"]]
            S["values"]["bufferView"] = bi[S["values"]["bufferView"]]
            A["sparse"] = S
        new_acc.append(A)

    for m in new_meshes:
        for p in m["primitives"]:
            p["attributes"] = {k: ai[v] for k, v in p.get("attributes", {}).items()}
            if "indices" in p: p["indices"] = ai[p["indices"]]
            if "targets" in p:
                p["targets"] = [{k: ai[v] for k, v in t.items()} for t in p["targets"]]
            d = p.get("extensions", {}).get("KHR_draco_mesh_compression")
            if d: d["bufferView"] = bi[d["bufferView"]]

    for s in g.get("skins", []):
        if "inverseBindMatrices" in s: s["inverseBindMatrices"] = ai[s["inverseBindMatrices"]]
        s["joints"] = [ni[j] for j in s["joints"] if j in ni]
        if "skeleton" in s and s["skeleton"] not in ni: s.pop("skeleton")
        elif "skeleton" in s: s["skeleton"] = ni[s["skeleton"]]
    for an in g.get("animations", []):
        for sm in an.get("samplers", []):
            sm["input"] = ai[sm["input"]]; sm["output"] = ai[sm["output"]]
        an["channels"] = [c for c in an.get("channels", []) if c["target"].get("node") in ni]
        for c in an["channels"]: c["target"]["node"] = ni[c["target"]["node"]]
    for im in g.get("images", []):
        if "bufferView" in im: im["bufferView"] = bi[im["bufferView"]]
    for sc in g.get("scenes", []):
        sc["nodes"] = [ni[n] for n in sc["nodes"] if n in ni]

    g["nodes"], g["meshes"], g["accessors"], g["bufferViews"] = \
        new_nodes, new_meshes, new_acc, new_bvs
    g["buffers"] = [{"byteLength": len(out)}] if out else []

    n = write(dst, g, bytes(out))
    print("\n%s  %.2f MB  ->  %s  %.2f MB  (%.0f%% smaller)"
          % (src, os.path.getsize(src) / 1e6, dst, n / 1e6,
             100 * (1 - n / os.path.getsize(src))))


if __name__ == "__main__":
    main()

"""Convert the official BIOBUZZ field STEP into browser assets.

Usage (from repo root, with a venv that has cascadio, trimesh, fast-simplification):
    python tools/convert_field.py cad/field-cad-step.step web/assets

Outputs:
    field.glb           visual mesh: nodes 'static', 'hive_red', 'hive_blue'
    field.json          game-piece start positions, HIVE pivots, zones, FLOWERs

Coordinates are the CAD's: meters, Y up. Red alliance is -X, blue is +X,
audience is +Z. HIVE meshes are stored relative to their pivot so the game can
rotate them.
"""
import json
import os
import re
import sys
import tempfile
from collections import defaultdict

import numpy as np
import trimesh

try:
    import fast_simplification
except ImportError:  # pragma: no cover
    fast_simplification = None

HARDWARE = re.compile(
    r"screw|nut\b|nut_|washer|bolt|rivnut|rivet|bearing|spacer|strap|clip|fastener|"
    r"\bpin\b|pins\b|insert|sticker|label|april tag|cable tie",
    re.I,
)
SKIP = re.compile(r"am-2499|Soft Tile|am-5851: Pollen|Nectar", re.I)


def leaves(scene, node):
    graph = scene.graph.transforms
    out, stack = [], [node]
    while stack:
        n = stack.pop()
        if n in scene.graph.nodes_geometry:
            out.append(n)
        stack += list(graph.children.get(n, []))
    return out


def ancestors(scene, node):
    parents = scene.graph.transforms.parents
    out = []
    while node in parents:
        node = parents[node]
        out.append(node)
    return out


def world_mesh(scene, leaf):
    T, g = scene.graph[leaf]
    m = scene.geometry[g].copy()
    m.apply_transform(T)
    return m


def color_of(mesh):
    try:
        c = mesh.visual.material.baseColorFactor
        return tuple(int(x) for x in c[:3])
    except Exception:
        return (150, 150, 150)


def cluster(mesh, cell):
    """Vertex clustering: snap vertices to a `cell`-sized grid and drop collapsed triangles.
    Robust on messy CAD tessellation where quadric decimation stalls."""
    if cell <= 0:
        return mesh
    q = np.round(mesh.vertices / cell).astype(np.int64)
    uq, inv = np.unique(q, axis=0, return_inverse=True)
    inv = inv.reshape(-1)
    # average position of the vertices in each cell
    verts = np.zeros((len(uq), 3))
    np.add.at(verts, inv, mesh.vertices)
    verts /= np.bincount(inv, minlength=len(uq))[:, None]
    f = inv[mesh.faces]
    ok = (f[:, 0] != f[:, 1]) & (f[:, 1] != f[:, 2]) & (f[:, 0] != f[:, 2])
    f = f[ok]
    f = np.unique(np.sort(f, axis=1), axis=0, return_index=True)[1]
    faces = inv[mesh.faces][ok][np.sort(f)]
    return trimesh.Trimesh(verts, faces, process=True)


def simplify(mesh, cell, keep):
    """Cluster to a grid, then optionally quadric-decimate to `keep` fraction."""
    mesh = mesh.copy()
    mesh.merge_vertices()
    mesh = cluster(mesh, cell)
    if fast_simplification is None or keep >= 0.99 or len(mesh.faces) < 400:
        return mesh
    pts, faces = fast_simplification.simplify(
        mesh.vertices.astype(np.float32), mesh.faces.astype(np.int32), target_reduction=1 - keep
    )
    return trimesh.Trimesh(pts, faces, process=True)


def bounds_of(scene, node):
    lo, hi = np.full(3, 1e9), np.full(3, -1e9)
    for lf in leaves(scene, node):
        b = world_mesh(scene, lf).bounds
        lo, hi = np.minimum(lo, b[0]), np.maximum(hi, b[1])
    return lo, hi


def find(scene, pattern, parent=None):
    graph = scene.graph.transforms
    pool = graph.children[parent] if parent else list(graph.nodes)
    return [n for n in pool if re.search(pattern, n)]


def main(step_path, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    raw = os.path.join(tempfile.gettempdir(), "field_raw.glb")
    if step_path.endswith(".glb"):
        raw = step_path
    else:
        import cascadio

        cascadio.step_to_glb(step_path, raw, tol_linear=1.0, tol_angular=0.5)
    scene = trimesh.load(raw)
    top = find(scene, r"^am-5850")[0]

    # --- HIVE pivots (centre of the two pivot bearings) ---
    info = {"units": "meters", "axes": "Y up; red -X, blue +X, audience +Z", "hives": {}}
    hive_nodes = {}
    for color, pat in (("red", r"Red Hive"), ("blue", r"Blue Hive")):
        hive = find(scene, pat, top)[0]
        hive_nodes[color] = hive
        piv = find(scene, r"Pivot Assembly", hive)[0]
        bearings = [n for n in scene.graph.transforms.children[piv] if "Bearing" in n]
        centers = [np.mean(bounds_of(scene, b), axis=0) for b in bearings]
        pivot = np.mean(centers, axis=0)
        cells = {}
        for c in find(scene, r"Cell", hive):
            lo, hi = bounds_of(scene, c)
            side = "audience" if "Audience" in c else "scoring"
            cells[side] = {"lo": (lo - pivot).tolist(), "hi": (hi - pivot).tolist()}
        a = np.mean([cells["audience"]["lo"], cells["audience"]["hi"]], axis=0)
        s = np.mean([cells["scoring"]["lo"], cells["scoring"]["hi"]], axis=0)
        up = "audience" if a[1] > s[1] else "scoring"
        d = a - s
        tilt = float(np.degrees(np.arctan2(abs(d[1]), abs(d[2]))))
        info["hives"][color] = {
            "pivot": pivot.tolist(),
            "axis": [1, 0, 0],
            "tilt_deg": tilt,
            "tip_rotation_deg": 2 * tilt,
            "cells_local": cells,  # bounds in hive-local (pivot-relative) coords, CAD pose
            "start_up_cell": up,
        }

    # --- game pieces ---
    r_p, r_n = 0.0355, 0.0455
    wall = 1.8288  # 72 in: inside face of perimeter
    pieces = []
    for n in scene.graph.transforms.children[top]:
        kind = "pollen" if "Pollen" in n else "red_nectar" if "Red Nectar" in n else "blue_nectar" if "Blue Nectar" in n else None
        if not kind:
            continue
        lo, hi = bounds_of(scene, n)
        c = (lo + hi) / 2
        r = r_p if kind == "pollen" else r_n
        # Some CAD balls are partial tessellations; snap ones touching a wall.
        for ax in (0, 2):
            if abs(c[ax]) > wall - r - 0.03 and abs(c[ax]) < wall:
                c[ax] = np.sign(c[ax]) * (wall - r)
        if c[1] < 0.1:
            c[1] = r
        pieces.append({"kind": kind, "pos": [round(float(v), 4) for v in c]})
    info["pieces_cad"] = pieces

    # --- FLOWERS ---
    flowers = []
    for f in find(scene, r"Flower Assembly", top):
        top_ring = find(scene, r"Layer C", f)[0]
        mid_ring = find(scene, r"Layer B", f)[0]
        pipes = find(scene, r"HIPS Pipe", f)
        tl, th = bounds_of(scene, top_ring)
        ml, mh = bounds_of(scene, mid_ring)
        pc = np.mean([np.mean(bounds_of(scene, p), axis=0) for p in pipes], axis=0)
        flowers.append({
            "center": [float(pc[0]), float(pc[2])],
            "top_ring_y": [float(tl[1]), float(th[1])],
            "mid_ring_y": [float(ml[1]), float(mh[1])],
            "score_y": [float(mh[1]), float(tl[1])],
            "radius": 0.05,
        })
    info["flowers"] = flowers

    # --- zones from tape (rectangles on the floor, x/z) ---
    info["zones"] = {
        "field_half": wall,
        "loading": {"red": {"x": [-wall, -1.50], "z": [-1.18, -0.61]},
                    "blue": {"x": [1.50, wall], "z": [0.61, 1.18]}},
        "garden": {"red": {"x": [-wall, -1.20], "z": [1.73, wall]},
                   "blue": {"x": [1.20, wall], "z": [-wall, -1.73]}},
        "alliance_area": {"red": {"x": [-3.19, -wall], "z": [-1.23, 1.23]},
                          "blue": {"x": [wall, 3.19], "z": [-1.23, 1.23]}},
    }

    # --- meshes ---
    groups = {"static": defaultdict(list), "hive_red": defaultdict(list), "hive_blue": defaultdict(list)}
    hive_of = {v: k for k, v in hive_nodes.items()}
    for leaf in scene.graph.nodes_geometry:
        chain = [leaf] + ancestors(scene, leaf)
        names = " / ".join(chain)
        if SKIP.search(names) or HARDWARE.search(leaf):
            continue
        m = world_mesh(scene, leaf)
        if np.linalg.norm(m.extents) < 0.02:
            continue
        group = "static"
        for anc in chain:
            if anc in hive_of:
                group = "hive_" + hive_of[anc]
        if group != "static":
            m.apply_translation(-np.array(info["hives"][group[5:]]["pivot"]))
        tag = ""
        if "Gaffer Tape" in names:
            m.apply_translation([0, 0.004, 0])
            tag = "_tape"  # visual only; the game leaves it out of collision
        elif "Side Glass" in names:
            tag = "_glass"  # polycarbonate perimeter panels; rendered see-through
        groups[group][(color_of(m), tag)].append(m)

    def build(cell, keep):
        sc = trimesh.Scene()
        total = 0
        for gname, by_color in groups.items():
            for i, ((col, tag), meshes) in enumerate(by_color.items()):
                merged = trimesh.util.concatenate(meshes)
                mm = simplify(merged, cell, keep)
                mm.visual = trimesh.visual.TextureVisuals(
                    material=trimesh.visual.material.PBRMaterial(
                        baseColorFactor=[*col, 255], metallicFactor=0.1, roughnessFactor=0.8))
                total += len(mm.faces)
                sc.add_geometry(mm, node_name=f"{gname}{tag}__{i}", geom_name=f"{gname}{tag}__{i}")
        return sc, total

    vis, vt = build(cell=0.004, keep=0.5)
    vis.export(os.path.join(out_dir, "field.glb"))
    ct = 0  # the game builds collision from field.glb itself
    with open(os.path.join(out_dir, "field.json"), "w") as fh:
        json.dump(info, fh, indent=1)
    print(f"visual tris {vt}, collision tris {ct}, pieces {len(pieces)}, flowers {len(flowers)}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])

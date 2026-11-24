"""Convert the official 2026 REBUILT field STEP into browser assets.

Usage (from repo root, venv with cascadio, trimesh, numpy, fast-simplification==0.1.9):
    python rebuilt/tools/convert_field.py rebuilt/cad/rebuilt-field.step rebuilt/web/assets

Outputs field.glb (simplified visual mesh) and field.json (FUEL start positions and
element bounds). Game axes: meters, Y up, red alliance at -X, scoring table at -Z.

Node names carry tags the game reads:
    *_tape    floor tape, visual only
    *_glass   polycarbonate guardrail panels, drawn see-through
    *_hub     HUB parts; the game uses a simple box collider for the HUB instead
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
    r"screw|\bnut\b|nut_|washer|bolt|rivet|bearing|spacer|PEM |REV-21|Hook Tape|Loop Tape|"
    r"Gas Spring|Vinyl|Knob|Wheel|Tread|Pin\b|Clip|Cable|Zip|Diffuser|Light Mount|Case",
    re.I,
)
GLASS = re.compile(r"Field Plastic|Tower Upper Plastic", re.I)

# CAD: Z up, Y toward the scoring table.  Game: Y up.  x'=x, y'=z, z'=-y (det +1)
CAD_TO_GAME = np.array([[1, 0, 0, 0], [0, 0, 1, 0], [0, -1, 0, 0], [0, 0, 0, 1]], dtype=float)


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
    m.apply_transform(CAD_TO_GAME @ T)
    return m


def color_of(mesh):
    try:
        return tuple(int(x) for x in mesh.visual.material.baseColorFactor[:3])
    except Exception:
        return (150, 150, 150)


def cluster(mesh, cell):
    """Vertex clustering: snap to a grid and drop collapsed triangles."""
    q = np.round(mesh.vertices / cell).astype(np.int64)
    uq, inv = np.unique(q, axis=0, return_inverse=True)
    inv = inv.reshape(-1)
    verts = np.zeros((len(uq), 3))
    np.add.at(verts, inv, mesh.vertices)
    verts /= np.bincount(inv, minlength=len(uq))[:, None]
    f = inv[mesh.faces]
    f = f[(f[:, 0] != f[:, 1]) & (f[:, 1] != f[:, 2]) & (f[:, 0] != f[:, 2])]
    _, keep = np.unique(np.sort(f, axis=1), axis=0, return_index=True)
    return trimesh.Trimesh(verts, f[np.sort(keep)], process=True)


def simplify(mesh, cell, keep=0.5):
    mesh = mesh.copy()
    mesh.merge_vertices()
    mesh = cluster(mesh, cell)
    if fast_simplification is None or len(mesh.faces) < 400:
        return mesh
    pts, faces = fast_simplification.simplify(
        mesh.vertices.astype(np.float32), mesh.faces.astype(np.int32), target_reduction=1 - keep)
    return trimesh.Trimesh(pts, faces, process=True)


def subtree_bounds(scene, node):
    lo, hi = np.full(3, 1e9), np.full(3, -1e9)
    for lf in leaves(scene, node):
        b = world_mesh(scene, lf).bounds
        lo, hi = np.minimum(lo, b[0]), np.maximum(hi, b[1])
    return lo, hi


def main(step_path, out_dir):
    raw = step_path
    if not step_path.endswith(".glb"):
        import cascadio

        raw = os.path.join(tempfile.gettempdir(), "rebuilt_field_raw.glb")
        cascadio.step_to_glb(step_path, raw, tol_linear=1.0, tol_angular=0.5)
    scene = trimesh.load(raw)
    graph = scene.graph.transforms
    top = [n for n in graph.children[scene.graph.base_frame]][0]

    info = {"units": "meters", "axes": "Y up; red -X, blue +X, scoring table -Z", "elements": defaultdict(list)}
    fuel = []
    for child in graph.children[top]:
        kind = child.split(":")[1].split("<")[0].strip() if ":" in child else child
        lo, hi = subtree_bounds(scene, child)
        if "Fuel" in child:
            fuel.append([round(float(v), 4) for v in (lo + hi) / 2])
            continue
        for key in ("Hub", "Bump", "Trench", "Tower", "Outpost", "Depot"):
            if child.split(":")[1].strip().startswith(key) if ":" in child else False:
                info["elements"][key.lower()].append({"lo": lo.tolist(), "hi": hi.tolist()})
        if "Carpet" in child and "Seaming" not in child:
            info["carpet"] = {"lo": lo.tolist(), "hi": hi.tolist()}
    info["fuel_cad"] = fuel
    info["elements"] = dict(info["elements"])

    groups = defaultdict(list)
    for leaf in scene.graph.nodes_geometry:
        chain = [leaf] + ancestors(scene, leaf)
        names = " / ".join(chain)
        if "Fuel" in names or "Playing Field Carpet" in names or "Seaming Tape" in names:
            continue
        if HARDWARE.search(leaf):
            continue
        m = world_mesh(scene, leaf)
        if np.linalg.norm(m.extents) < 0.03:
            continue
        tag = ""
        if "Gaffer Tape" in names or "Gaff Tape" in names:
            m.apply_translation([0, 0.003, 0])
            tag = "_tape"
        elif GLASS.search(names):
            tag = "_glass"
        elif ": Hub" in names:
            tag = "_hub"
        groups[(color_of(m), tag)].append(m)

    out = trimesh.Scene()
    total = 0
    for i, ((col, tag), meshes) in enumerate(groups.items()):
        merged = trimesh.util.concatenate(meshes)
        mm = merged if tag == "_tape" else simplify(merged, 0.006)
        mm.visual = trimesh.visual.TextureVisuals(material=trimesh.visual.material.PBRMaterial(
            baseColorFactor=[*col, 255], metallicFactor=0.1, roughnessFactor=0.8))
        total += len(mm.faces)
        out.add_geometry(mm, node_name=f"static{tag}__{i}", geom_name=f"static{tag}__{i}")

    os.makedirs(out_dir, exist_ok=True)
    out.export(os.path.join(out_dir, "field.glb"))
    with open(os.path.join(out_dir, "field.json"), "w") as fh:
        json.dump(info, fh, indent=1)
    print(f"tris {total}, fuel {len(fuel)}")
    print(json.dumps(info["elements"], indent=1))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])

"""Convert the goBILDA kit robot STEP (3200-2627-0004) into a light browser model.

Usage (from repo root):
    python tools/convert_robot.py cad/3200-2627-0004.step web/assets

Drops screws, nuts, zip ties and other tiny parts, merges by color, and clusters
vertices so the ~8.5M-triangle CAD becomes a game-sized mesh.

Output robot.glb is in game axes: meters, Y up, robot faces -Z (intake side),
origin on the floor at the center of the chassis footprint. Each mecanum wheel is
its own node ('wheel_fl', 'wheel_fr', 'wheel_bl', 'wheel_br') with its origin on the
axle so the game can spin it. Also writes robot.json with key dimensions.
"""
import json
import os
import re
import sys
import tempfile
from collections import defaultdict

import numpy as np
import trimesh

sys.path.insert(0, os.path.dirname(__file__))
from convert_field import simplify, color_of, leaves, ancestors, world_mesh  # noqa: E402

HARDWARE = re.compile(r"Hardware|Zip Tie|screw|nut|washer|1501-|1502-|1522-|1516-|2807-|label|Labels", re.I)
WHEEL = re.compile(r"^3625-0(001|100)-0104")  # goBILDA 104mm mecanum (left/right)

# CAD axes: X right-ish, Y toward the shooter (intake is -Y), Z up.
# Game axes: Y up, robot forward is -Z.  x' = -x, y' = z, z' = y   (det = +1)
CAD_TO_GAME = np.array([
    [-1, 0, 0, 0],
    [0, 0, 1, 0],
    [0, 1, 0, 0],
    [0, 0, 0, 1],
], dtype=float)


def main(step_path, out_dir):
    raw = step_path
    if not step_path.endswith(".glb"):
        import cascadio

        raw = os.path.join(tempfile.gettempdir(), "robot_raw.glb")
        cascadio.step_to_glb(step_path, raw, tol_linear=0.5, tol_angular=0.5)
    scene = trimesh.load(raw)

    lo, hi = scene.bounds
    # Recentre: footprint centre at x/y = 0, floor (lowest wheel point) at z = 0.
    shift = np.eye(4)
    shift[:3, 3] = [-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -lo[2]]
    to_game = CAD_TO_GAME @ shift

    body = defaultdict(list)
    wheels = {}
    for leaf in scene.graph.nodes_geometry:
        chain = [leaf] + ancestors(scene, leaf)
        wheel_root = next((a for a in chain if WHEEL.search(a)), None)
        if wheel_root is None and any(HARDWARE.search(a) for a in chain):
            continue
        m = world_mesh(scene, leaf)
        if wheel_root is None and np.linalg.norm(m.extents) < 0.012:
            continue
        m.apply_transform(to_game)
        if wheel_root:
            wheels.setdefault(wheel_root, []).append(m)
        else:
            body[color_of(m)].append(m)

    out = trimesh.Scene()
    total = 0

    def add(mesh, name, col, cell, transform=None):
        nonlocal total
        mm = simplify(mesh, cell, 0.5)
        mm.visual = trimesh.visual.TextureVisuals(
            material=trimesh.visual.material.PBRMaterial(
                baseColorFactor=[*col, 255], metallicFactor=0.2, roughnessFactor=0.7))
        total += len(mm.faces)
        out.add_geometry(mm, node_name=name, geom_name=name, transform=transform)

    for i, (col, meshes) in enumerate(body.items()):
        add(trimesh.util.concatenate(meshes), f"body__{i}", col, 0.003)

    info = {"wheels": {}}
    for root, meshes in wheels.items():
        merged = trimesh.util.concatenate(meshes)
        c = merged.bounds.mean(axis=0)
        side = "l" if c[0] < 0 else "r"
        end = "f" if c[2] < 0 else "b"
        name = f"wheel_{end}{side}"
        merged.apply_translation(-c)
        T = np.eye(4)
        T[:3, 3] = c
        add(merged, name, (60, 60, 60), 0.004, transform=T)
        info["wheels"][name] = {"center": c.tolist(), "diameter": float(merged.extents[1])}

    glo, ghi = out.bounds
    info["bounds"] = {"lo": glo.tolist(), "hi": ghi.tolist()}
    info["source"] = "goBILDA kit 3200-2627-0004"
    os.makedirs(out_dir, exist_ok=True)
    out.export(os.path.join(out_dir, "robot.glb"))
    with open(os.path.join(out_dir, "robot.json"), "w") as fh:
        json.dump(info, fh, indent=1)
    print(f"robot tris {total}", json.dumps(info, indent=1))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])

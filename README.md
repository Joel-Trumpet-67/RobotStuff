# RobotStuff – BIOBUZZ Sim

A browser robot simulator for the FTC 2026–27 game **BIOBUZZ**, using the official field CAD and the goBILDA kit robot (3200-2627-0004).

## Run it locally

```sh
cd web
python3 -m http.server 8765
```

Then open http://localhost:8765. Opening `index.html` directly from disk won't work, because browsers block loading the 3D models that way.

## Branches

- `main` always has a working version and is what GitHub Pages publishes (see `.github/workflows/pages.yml`).
- `dev` is where new work happens; merge into `main` when it's stable.

## Layout

| Path | What |
| --- | --- |
| `web/` | The game (plain ES modules, no build step). Three.js + Rapier physics from a CDN. |
| `web/src/config.js` | Every tunable number: speeds, shooter, HIVE tip weights, match timing, points. |
| `web/assets/` | Converted CAD (`field.glb`, `robot.glb`) and data pulled from it (`field.json`, `robot.json`). |
| `tools/` | Python scripts that turn the STEP files into the browser assets. |
| `cad/` | Original STEP files. Ignored by git because of their size; keep them locally. |

## Rebuilding the models from CAD

```sh
python3 -m venv .venv
.venv/bin/pip install cascadio trimesh numpy "fast-simplification==0.1.9"
.venv/bin/python tools/convert_field.py cad/field-cad-step.step web/assets
.venv/bin/python tools/convert_robot.py cad/3200-2627-0004.step web/assets
```

## Where the rules come from

- Match timing, scoring, pre-loads, and the human player NECTAR rules come from the Competition Manual (TU10), §10 and G426/G427.
- HIVE tip weights come from the Event Field Setup Guide §12.3: 7 POLLEN don't tip it and 8 do; 3 NECTAR + 2 POLLEN don't and 3 NECTAR + 3 POLLEN do.
- Field geometry, the starting position of every game piece, the HIVE pivots, and the zones come from the official field CAD.

# RobotStuff – robot sims

Browser robot simulators built from official FIRST field CAD.

| Folder | Game | Status |
| --- | --- | --- |
| `rebuilt/` | FRC 2026 **REBUILT**, with a team 3603 swerve chassis | Active. GitHub Pages publishes this one. |
| `biobuzz/` | FTC 2026–27 **BIOBUZZ**, with the goBILDA kit robot | Shelved |

## Run locally

```sh
cd rebuilt/web        # or biobuzz/web
python3 -m http.server 8765
```

Then open http://localhost:8765. Opening `index.html` directly from disk won't work, because browsers block loading the 3D models that way.

## Branches

- `main` always has a working version, and it's what GitHub Pages publishes (`.github/workflows/pages.yml` publishes `rebuilt/web`).
- `dev` is where new work happens.

## Layout (per game)

| Path | What |
| --- | --- |
| `web/` | The game: plain ES modules with no build step. Uses Three.js and Rapier physics from a CDN. |
| `web/src/config.js` | Every tunable number. |
| `web/assets/` | Converted CAD (`field.glb`) and data pulled from it (`field.json`). |
| `tools/` | Python scripts that turn STEP files into the browser assets. |
| `cad/` | Original STEP files. Git ignores them because of their size; keep them locally. |

## Rebuilding the REBUILT field from CAD

```sh
python3 -m venv .venv
.venv/bin/pip install cascadio trimesh numpy "fast-simplification==0.1.9"
.venv/bin/python rebuilt/tools/convert_field.py rebuilt/cad/rebuilt-field.step rebuilt/web/assets
```

## Sources

- The REBUILT rules come from the 2026 Game Manual (HTML version on firstfrc.blob.core.windows.net): §5 Arena, §6 Game details, R104 size, and R405 BUMPER ZONE.
- Field geometry and the DEPOT, CHUTE, and NEUTRAL ZONE FUEL positions come from the official field CAD. The NEUTRAL ZONE layout (408 FUEL, no pre-loads) follows §6.3.4.1.

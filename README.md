# ParCoar

A parking guidance simulator. A three-floor garage in the browser, and a
Python backend that decides where every arriving car should park and how it
gets there. Overhead signboards in the garage show each driver their
instruction, the way real guidance systems do.

The point of the project is the search. The backend holds the garage as a
graph and runs a breadth-first sweep outward from the car to the nearest free
bay it fits in. Everything else exists to make that visible.

## Running it

Two processes. Python 3.11+ and Node 20+.

```bash
# 1. Backend
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt
backend/.venv/bin/python backend/server.py        # ws://127.0.0.1:8765

# 2. Frontend
cd frontend
npm install
npm run dev                                        # http://localhost:5180
```

Open the page. Cars start arriving on their own.

## What you are looking at

Three floors, four two-way aisles each, 480 bays. Cars enter at the ground
floor, get a bay from the backend, and drive to it through 180-degree turn
loops and an L-shaped ramp that climbs the outside of the west face. After a
while they leave again.

The garage starts full near the entrance and empty at the back, which is what
makes guidance worth having. Without that, every car parks within a few metres
of the door and never passes a sign.

Press **C** for the controls drawer: traffic volume, spawn rate, time scale
including pause, how full the garage starts, and what gets drawn over the 3D
view. **M** toggles the route map, which draws the graph the backend searched
with the selected car's path lit up. **P** pauses.

Camera modes along the bottom: free orbit, overview, one per floor, follow a
car, and two driving modes where you steer a car yourself with WASD.

## Layout

```
backend/     Python. The graph generator and the WebSocket server that runs
             the search. Deliberately small and plain: this is the part that
             has to be explainable line by line.
frontend/    React, TypeScript, three.js. The 3D garage, the signboards, the
             cars, the camera rig, the controls.
shared/      lot.json, the generated garage graph, and spec.md, the message
             contract both sides follow.
tools/       simcheck, a movement gate. See tools/simcheck/README.md.
```

Regenerating the graph writes both copies, the one the backend reads and the
one the browser fetches:

```bash
backend/.venv/bin/python backend/generate_lot.py
```

The backend loads `lot.json` at import, so restart it after regenerating.

## Checks

```bash
cd frontend && npm run build                       # types and production build
backend/.venv/bin/python -m unittest backend.test_lot_graph
node tools/simcheck/check.mjs                      # both servers must be up
```

`simcheck` drives the running simulator in a real browser for a few minutes
and fails if a car stops with clear road ahead, two cars interpenetrate, a car
jumps or pops vertically, a bay is reassigned mid-journey, or fewer than 90%
of cars pass a guidance board.

There is no ESLint config. `typescript-eslint` does not yet support the
TypeScript 7 this project uses, and a lint setup that needs
`--legacy-peer-deps` to install is worse than none. `tsc -b` runs on every
build with `noUnusedLocals` and `noUnusedParameters` on, and does most of the
same work.

## Licence

MIT. See [LICENSE](LICENSE).

Car models are by [Quaternius](https://quaternius.com/packs/cars.html) and are
CC0. See [frontend/public/models/CREDITS.md](frontend/public/models/CREDITS.md).

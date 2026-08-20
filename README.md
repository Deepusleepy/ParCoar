# ParCoar

A parking garage you can watch from the inside.

Cars drive in, a Python server works out which free bay each one should take
and how to get there, and signs hanging over the road tell each driver where
to go. Three floors, 480 bays, in the browser.

The interesting part is the server. It holds the garage as a graph of 737
nodes and runs a breadth-first search outward from the car, so the first free
bay it reaches is the closest one that fits. Everything else exists to show
that search happening.

## Run it

You need Python 3.11 or newer and Node 20 or newer. Open two terminals.

```bash
# Terminal 1: the server that decides where cars park
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt
backend/.venv/bin/python backend/server.py
```

```bash
# Terminal 2: the garage
cd frontend
npm install
npm run dev
```

Open http://localhost:5180. Cars start arriving by themselves.

## What you can do

Press **C** to open the controls. From there you can change how many cars are
on the road, how often a new one turns up, how fast time runs, and how full
the garage starts. You can also add a single car, clear the road, or pause.

Press **M** for the route map. It draws the graph the server searched, with
the selected car's path lit up.

The buttons along the bottom change the camera. You can orbit the building,
look at one floor, follow a car, or drive one yourself with WASD.

## How it works

The garage has three floors. Each floor has four two-way aisles with bays on
both sides, 180 degree turns at the ends, and a ramp that climbs the outside
of the building to the floor above.

A car arrives at the entrance. The frontend tells the server where it is and
which bays are taken. The server searches for the nearest free bay and sends
back the whole route. The car drives it, and every sign along the way shows
that car's instruction until it has passed.

The garage starts nearly full at the entrance and emptier further in. That
sounds like a detail, but it is the whole reason guidance is worth having. If
bays are free everywhere, every car parks a few metres from the door and never
passes a single sign.

## The files

```
backend/     Python. Builds the garage graph, and runs the server that does
             the searching. Kept small and plain on purpose.
frontend/    React, TypeScript and three.js. The 3D garage, the cars, the
             signs, the camera, the controls.
shared/      lot.json is the garage graph. spec.md is the message format the
             two sides agree on.
tools/       simcheck, which watches the cars and complains if they misbehave.
```

To change the garage layout, edit `backend/generate_lot.py` and run it. It
writes the graph to both places that need it. Restart the server afterwards,
because it reads the graph once at startup.

```bash
backend/.venv/bin/python backend/generate_lot.py
```

## Checks

```bash
cd frontend && npm run build                        # types and build
backend/.venv/bin/python -m unittest backend.test_lot_graph
node tools/simcheck/check.mjs                       # both servers must be up
```

`simcheck` drives the running garage in a real browser for a few minutes. It
fails if a car stops with clear road ahead, if two cars end up inside each
other, if a car jumps or drops, if a car is sent to a different bay halfway
through its journey, or if cars stop passing the signs.

There is no ESLint setup. The linter plugin for TypeScript does not support
TypeScript 7 yet, and a setup that only installs with `--legacy-peer-deps` is
worse than none. `tsc` runs on every build and catches unused code as well as
type errors.

## Licence

MIT. See [LICENSE](LICENSE).

Car models are by [Quaternius](https://quaternius.com/packs/cars.html) and are
CC0. See [frontend/public/models/CREDITS.md](frontend/public/models/CREDITS.md).

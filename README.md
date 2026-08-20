# ParCoar

A parking garage you can watch from the inside.

Cars drive in. A server works out which free space each one should take and
how to get there. Signs hanging over the road tell each driver where to go,
the way they do in a real multi-storey car park. Three floors, 480 spaces, all
running in a browser.

You can also take a car and drive it yourself.

## Run it

You need Python 3.11 or newer and Node 22 or newer. Open two terminals.

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

Open http://localhost:5180. Cars start arriving on their own.

## What you can do

Press **C** for the controls. Change how many cars are on the road, how often
a new one turns up, how fast time runs, and how full the garage starts. Add a
single car, clear the road, or pause.

Press **M** for the route map. It draws the garage as a diagram with the
selected car's route lit up, so you can watch the plan and the car following
it at the same time.

The buttons along the bottom change the camera. Orbit the building, look at
one floor, follow a car, or drive one yourself with WASD.

---

## How it works

The rest of this is the detail, for anyone who wants it.

### The garage is a graph

`backend/generate_lot.py` builds the layout and writes it to `lot.json`. It
comes to 737 nodes.

| type | count | what it is |
|---|---|---|
| `slot` | 480 | a parking space |
| `junction` | 240 | a point on an aisle, one per pair of spaces |
| `turn` | 9 | a 180 degree loop joining two aisles |
| `ramp_up`, `ramp_in` | 4 | the two ends of each ramp between floors |
| `entry`, `exit`, `approach` | 4 | the way in and the way out |

Every road is two-way. A parking space is a dead end with one edge in and one
edge out, so a car can drive into it and later reverse out, but the search can
never use a space as a shortcut to somewhere else.

Edges carry a direction label: `left`, `right`, `straight`, `up`, `down`. That
label is what the overhead signs display, so it has to be right in both
directions. Driving a turn one way is a left, and driving the same turn the
other way is a right.

### Finding a space

`nearest_free_slot` in `backend/server.py` is a breadth-first search outward
from wherever the car is. BFS visits nodes in order of distance, so the first
free space it reaches is already the closest one and nothing needs sorting.
The whole graph is a few hundred nodes, so sweeping all of it costs well under
a millisecond.

One rule sits on top of that. If three or more cars are already heading to a
floor, the search skips that floor and takes the nearest space on another one.
Without it, every car piles onto the ground floor and the upper storeys stay
empty.

The same search produces the route, and the server sends the whole route
rather than one instruction at a time. That is what lets a sign show a car's
instruction from the moment the car turns into the aisle, instead of lighting
up as it arrives.

### The two sides talk over a WebSocket

`ws://127.0.0.1:8765`, JSON frames, five times a second. The frontend sends
where every car is and which spaces are taken. The server replies with one
instruction per car: the direction to take, the space assigned, and the route
still to drive. The format is written down in [shared/spec.md](shared/spec.md)
and both sides follow it.

State is per connection, so two browser tabs get two independent garages
instead of fighting over one.

### Why the garage starts nearly full

Occupancy is a gradient. Near the entrance of each floor almost every space is
taken, and it thins out toward the far end.

That is not decoration. The server sends each car to its nearest free space,
so in a garage that is half empty everywhere, every car parks a few metres
from the door and never passes a single sign. Measured on a flat 50% fill, 18
of 26 cars had a route that never touched a sign, and six of the eleven signs
were lit under 2% of the time. With the gradient, every car passes at least
one. Quiet, normal and busy are selectable in the controls.

### Drawing it

React, TypeScript and three.js, through `@react-three/fiber`.

A garage is mostly repetition: hundreds of parked cars, thousands of painted
lines, hundreds of space numbers. Three things keep that cheap.

Every flat marking on a floor is drawn once into a single canvas texture and
laid on one plane, so road lines, space outlines, numbers and lane arrows cost
one draw call per floor instead of thousands. Parked cars are instanced: 3,819
of them render from 41 instanced meshes. Guardrails, kerbs, signs and pillars
are each merged into a single geometry.

Measured from `renderer.info` on an M-series Mac at 1440x900: about 575 draw
calls and 2.1 million triangles a frame, holding the 120Hz cap.

## Layout

```
backend/     Python. Builds the graph, and runs the server that searches it.
             Small and plain on purpose: it is the part worth reading.
frontend/    React, TypeScript, three.js. The garage, the cars, the signs,
             the camera, the controls.
shared/      lot.json is the graph. spec.md is the message format.
tests/       Two suites. See tests/README.md.
```

To change the layout, edit `backend/generate_lot.py` and run it. It writes the
graph to both places that need it. Restart the server afterwards, because it
reads the graph once at startup.

```bash
backend/.venv/bin/python backend/generate_lot.py
```

One catch worth knowing before you try it. The frontend does not read the
layout numbers out of `lot.json`; it mirrors them as constants in
`frontend/src/sim/constants.ts`. Changing the number of bays, or moving nodes
around within the existing spacing, works on its own. Changing a spacing
(`JUNCTION_SPACING`, `AISLE_SPACING`, `SLOT_OFFSET`, `ROAD_WIDTH`) or the
number of floors means changing it in `constants.ts` to match, or the 3D
garage will be built to different dimensions than the graph the cars are
driving. `frontend/src/sim/constants.test.ts` pins the relationships between
those constants, but nothing checks them against `lot.json`.

## Checks

```bash
cd frontend && npm run build                              # types and build
cd frontend && npm test                                   # unit tests
backend/.venv/bin/python -m unittest discover -s tests -t .
node tests/simcheck/check.mjs                             # both servers up
```

The first three are fast. The last one opens the running garage in a real browser
and watches the cars for a few minutes. It fails if a car stops with clear
road ahead, if two cars end up inside each other, if a car jumps or drops, if
a car is sent to a different space halfway through its journey, or if cars
stop passing the signs. See [tests/README.md](tests/README.md).

There is no ESLint setup. The TypeScript plugin for it does not support
TypeScript 7 yet, and a setup that only installs with `--legacy-peer-deps`
would break for anyone cloning this. `tsc` runs on every build with
`noUnusedLocals` and `noUnusedParameters`, which covers most of the same
ground.

## Licence

MIT. See [LICENSE](LICENSE).

Car models are by [Quaternius](https://quaternius.com/packs/cars.html) and are
CC0. See [frontend/public/models/CREDITS.md](frontend/public/models/CREDITS.md).

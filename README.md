# ParCoar

A 3D multi-storey parking guidance simulator.

Cars enter a three-floor, 480-bay garage. A small Python server reserves the
closest free bay by real driving distance, calculates the route, and sends it
to the browser. Overhead boards identify each car and show the turn it should
take. You can also inspect the route graph or drive a car yourself.

![The garage, all three floors and the ramp](docs/images/garage.png)

## Run it

Requirements: Python 3.11+ and Node 22+.

```bash
# Terminal 1
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt
backend/.venv/bin/python backend/server.py
```

```bash
# Terminal 2
cd frontend
npm install
npm run dev
```

Open `http://localhost:5180`.

## Controls

- **C**: controls drawer
- **M**: route map
- **P**: pause
- Camera buttons: overview, floor views, car follow, POV and drive
- Driving: **WASD**

![The controls drawer and route map](docs/images/controls.png)

## How it works

### Graph

`backend/generate_lot.py` creates the garage graph and writes it to:

- `shared/lot.json`
- `frontend/public/lot.json`

The graph contains 480 identical bay nodes plus junctions, turns, ramps,
entry and exit nodes. Roads are two-way. Bays are dead ends, so a route may
finish in one or start from one, but cannot cut through one.

Every directed edge stores its real driving cost. A 2.6-unit aisle step costs
2.6, while turns and ramps use their curved physical length.

### Routing

The Python server runs Dijkstra's algorithm. The first available bay finalized
by the search is the bay with the shortest real driving distance.

There is no congestion-routing or hard floor-spreading rule. This garage graph
has one road path between locations, so pretending to choose an alternate route
would add complexity without changing the route. Cars still wait behind traffic
in the frontend so they cannot overlap.

### State ownership

The browser simulates bay sensors and reports physical occupancy. Python owns:

- active cars
- bay reservations
- assigned destinations
- route calculations

The browser includes its existing assignment when reconnecting, so the server
can restore it instead of sending a moving car to a different bay.

### WebSocket

The frontend sends state to `ws://127.0.0.1:8765` about five times per second.
The backend replies with the destination, route, direction, remaining physical
distance and estimated driving time. See [`shared/spec.md`](shared/spec.md).

### Frontend

React, TypeScript, Three.js and React Three Fiber render the garage. Static
parked cars are instanced, repeated floor markings are baked into textures, and
shared curve generators keep roads and AI paths aligned.

The vehicle models have different visual dimensions, but those dimensions do
not affect parking allocation. All parking bays are equivalent.

## Project layout

```text
backend/     Graph generator and small WebSocket routing server
frontend/    React/TypeScript/Three.js simulator
shared/      Generated graph and WebSocket protocol
tests/       Backend tests and browser movement checks
```

## Checks

```bash
python -m unittest discover -s tests -t . -v
cd frontend && npm run build && npm test
node tests/simcheck/check.mjs   # both servers must already be running
```

## Licence

MIT. Car models are from Quaternius and released under CC0. See
`frontend/public/models/CREDITS.md`.

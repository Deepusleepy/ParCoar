# ParCoar — Message Contract & Shared Spec

This file defines the communication protocol between the 3D simulator
(frontend) and the parking guidance backend (Python). Both sides must follow
this exactly.

## Transport

- WebSocket on `ws://127.0.0.1:8765` (use 127.0.0.1 explicitly, not localhost, to avoid IPv6 issues)
- Messages are JSON text frames
- Frontend connects, backend accepts one persistent connection

## Lot Layout

Both sides load `shared/lot.json` (or `public/lot.json` in the frontend).
The lot is a 3-floor parking garage with a serpentine layout: 4 aisles per
floor, 20 bays per aisle side, 2 sides per aisle = 160 slots per floor,
480 slots total. 180° curved turns connect aisles. An L-shaped ramp running
along the outside of the west face connects each floor to the next.

A parking bay has one outgoing edge, back to its own aisle junction, so a
parked car can leave. The backend never routes *through* a bay, only to one.

Top-level fields in lot.json:
```json
{
  "floors": 3,
  "floor_height": 15,
  "aisles_per_floor": 4,
  "junctions_per_aisle": 8,
  "junction_spacing": 5,
  "aisle_spacing": 24,
  "slot_offset": 9,
  "road_width": 9,
  "slot_depth": 5,
  "nodes": { ... },
  "edges": { ... }
}
```

- `junction_spacing`: x-distance between junctions along an aisle
- `aisle_spacing`: y-distance between aisle centrelines
- `slot_offset`: y-distance from an aisle centre to a slot centre
- `road_width`: full driving-road width across both lanes (±4.5 of centre)
- `slot_depth`: parking bay depth (perpendicular to the aisle)

Node shape:
```json
{
  "J0_0_1":   {"type": "junction", "floor": 0, "x": 5, "y": 0},
  "S0_1":     {"type": "slot", "floor": 0, "x": 5, "y": -9, "size": "large"},
  "T0_0":     {"type": "turn", "floor": 0, "x": 45, "y": 0},
  "R0_up":    {"type": "ramp_up", "floor": 0, "x": 0, "y": 72},
  "R1_in":    {"type": "ramp_in", "floor": 1, "x": 0, "y": 0},
  "E0":       {"type": "entry", "floor": 0, "x": 0, "y": 0},
  "EXIT2":    {"type": "exit", "floor": 2, "x": 0, "y": 72},
  "ENTRY_ROAD": {"type": "approach", "floor": 0, "x": -15, "y": 0},
  "EXIT_ROAD":  {"type": "approach", "floor": 2, "x": -15, "y": 72}
}
```

Edge shape (adjacency list, directed):
```json
{
  "J0_0_1": [
    {"dir": "left", "to": "S0_1"},
    {"dir": "right", "to": "S0_9"},
    {"dir": "straight", "to": "J0_0_2"}
  ],
  "T0_0": [{"dir": "straight", "to": "J0_1_8"}],
  "R0_up": [{"dir": "up", "to": "R1_in"}],
  "ENTRY_ROAD": [{"dir": "straight", "to": "E0"}],
  "EXIT2": [{"dir": "straight", "to": "EXIT_ROAD"}],
  "S0_1": []
}
```

Node types: `entry`, `junction`, `slot`, `turn`, `ramp_up`, `ramp_in`, `exit`, `approach`
Slot sizes: `small`, `medium`, `large`
Direction labels: `left`, `right`, `straight`, `up`, `arrived`

Node ID convention:
- Junctions: `J{floor}_{aisle}_{number}` (e.g. `J0_0_1` = floor 0, aisle 0, junction 1)
- Slots: `S{floor}_{global_number}` (e.g. `S0_1` = floor 0, slot 1). Numbers are
  assigned side-by-side per aisle: each aisle side is a contiguous run in travel
  order (s_pos 0 = the -y side, s_pos 1 = the +y side), and aisles chain
  contiguously (aisle 0 = 1..16, aisle 1 = 17..32, etc.).
- Turns: `T{floor}_{aisle}` (e.g. `T0_0` = floor 0, turn after aisle 0)
- Ramps: `R{floor}_up` (bottom of ramp) and `R{floor}_in` (top of ramp, = entry to that floor)
- Entry: `E0` (floor 0 only)
- Exit: `EXIT{floor}` (top floor only)
- Approach roads: `ENTRY_ROAD` (west of E0) and `EXIT_ROAD` (west of the exit).
  These are outside the lot footprint and are not part of the routing graph the
  backend uses for slot assignment — they only exist so the frontend can render
  the road leading into/out of the garage. `ENTRY_ROAD` has one edge to `E0`;
  the exit node has one edge to `EXIT_ROAD`.

Aisles are one-way (serpentine: even aisles go right, odd aisles go left).
Turn nodes are 180° curves at the end of each aisle connecting to the next.
The graph is directed — cars can only travel in the direction of the edges.

## Message: Frontend -> Backend (state update)

Sent every ~200ms while cars are moving:

```json
{
  "type": "state",
  "cars": [
    {
      "id": "C1",
      "color": "red",
      "plate": "ABC-123",
      "size": "medium",
      "node": "J0_0_1"
    }
  ],
  "occupied_slots": ["S0_1", "S0_3", "S1_2"]
}
```

- `id`: unique car identifier (string)
- `color`: car color for signboard display
- `plate`: license plate for signboard display
- `size`: "small" | "medium" | "large" — must fit in slot size (car can park
  in a slot of equal or larger size, not smaller)
- `node`: the graph node the car is currently at
- `occupied_slots`: slot node IDs that already have a car (pre-parked + parked).
  The backend uses this to avoid assigning occupied slots to active cars.

If a car is new (backend hasn't seen it), the backend assigns it a slot.
If a car has reached its assigned slot node, it's parked.

## Message: Backend -> Frontend (instructions)

Sent in response to each state update:

```json
{
  "type": "instructions",
  "signs": [
    {
      "car_id": "C1",
      "color": "red",
      "plate": "ABC-123",
      "node": "J0_0_1",
      "direction": "left",
      "slot": "S0_1",
      "slot_floor": 0,
      "status": "routing",
      "next_node": "S0_1",
      "next_direction": "arrived",
      "path": ["J0_0_1", "S0_1"]
    }
  ]
}
```

- `car_id`: which car this instruction is for
- `color`, `plate`: echoed back for the signboard display
- `node`: the node where this signboard is shown (the car's current node)
- `direction`: "left" | "right" | "straight" | "up" | "arrived"
- `slot`: the assigned slot node id
- `slot_floor`: which floor the slot is on
- `next_node`: the next node on the car's BFS path to its slot (look-ahead).
  The frontend lights up the signboard at this node BEFORE the car arrives,
  so the driver sees the direction in advance. null when the car is one step
  from its slot or already parked.
- `next_direction`: the direction to take at `next_node`. null when
  `next_node` is null.
- `path`: the car's whole remaining route as a list of node ids, current node
  first, assigned slot last. The frontend lights up the permanent signboard at
  every turn and ramp along this route, so a driver sees the board from the
  moment they enter an aisle rather than when they are already underneath it.
  Each board shows the direction to take *at that board*, and how many hops
  away the car still is.
- `status`: "routing" | "parked" | "no_slot"

If `status` is "parked", `direction` is "arrived" — the frontend should
stop the car and show it parked in its slot.

If `status` is "no_slot", the lot is full for this car's size.

## Slot Assignment Rules

The backend assigns slots considering, in order:
1. **Size match**: car can only use a slot of equal or larger size
2. **Distance**: nearest free slot by BFS hop count from the car's current node
3. **Load spread**: if the nearest floor already has 3+ cars routing to it,
   prefer the next nearest slot on a different floor

## Pre-parked Cars

At startup, ~50% of slots are pre-filled with static cars (random color,
plate, size matching the slot). These cars never move. The frontend
generates them deterministically (every other slot, sorted by floor/y/x)
and renders them in the 3D scene. The frontend reports all occupied slots
(pre-parked + parked) to the backend via `occupied_slots` in every state
message, so the backend never assigns a slot that already has a car.

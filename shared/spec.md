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
floor, 8 junctions per aisle, 2 slots per junction = 64 slots per floor,
192 slots total. 180° curved turns connect aisles. Spiral ramps connect floors.

Top-level fields in lot.json:
```json
{
  "floors": 3,
  "floor_height": 15,
  "aisles_per_floor": 4,
  "junctions_per_aisle": 8,
  "junction_spacing": 10,
  "aisle_spacing": 14,
  "slot_offset": 4.5,
  "nodes": { ... },
  "edges": { ... }
}
```

Node shape:
```json
{
  "J0_0_1": {"type": "junction", "floor": 0, "x": 10, "y": 0},
  "S0_1":   {"type": "slot", "floor": 0, "x": 10, "y": -4.5, "size": "large"},
  "T0_0":   {"type": "turn", "floor": 0, "x": 90, "y": 0},
  "R0_up":  {"type": "ramp_up", "floor": 0, "x": 90, "y": 42},
  "R1_in":  {"type": "ramp_in", "floor": 1, "x": 0, "y": 0},
  "E0":     {"type": "entry", "floor": 0, "x": 0, "y": 0},
  "EXIT2":  {"type": "exit", "floor": 2, "x": 0, "y": 42}
}
```

Edge shape (adjacency list, directed):
```json
{
  "J0_0_1": [
    {"dir": "left", "to": "S0_1"},
    {"dir": "right", "to": "S0_2"},
    {"dir": "straight", "to": "J0_0_2"}
  ],
  "T0_0": [{"dir": "straight", "to": "J0_1_8"}],
  "R0_up": [{"dir": "up", "to": "R1_in"}],
  "S0_1": []
}
```

Node types: `entry`, `junction`, `slot`, `turn`, `ramp_up`, `ramp_in`, `exit`
Slot sizes: `small`, `medium`, `large`
Direction labels: `left`, `right`, `straight`, `up`, `arrived`

Node ID convention:
- Junctions: `J{floor}_{aisle}_{number}` (e.g. `J0_0_1` = floor 0, aisle 0, junction 1)
- Slots: `S{floor}_{global_number}` (e.g. `S0_1` = floor 0, slot 1)
- Turns: `T{floor}_{aisle}` (e.g. `T0_0` = floor 0, turn after aisle 0)
- Ramps: `R{floor}_up` (bottom of ramp) and `R{floor}_in` (top of ramp, = entry to that floor)
- Entry: `E0` (floor 0 only)
- Exit: `EXIT{floor}` (top floor only)

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
  ]
}
```

- `id`: unique car identifier (string)
- `color`: car color for signboard display
- `plate`: license plate for signboard display
- `size`: "small" | "medium" | "large" — must fit in slot size (car can park
  in a slot of equal or larger size, not smaller)
- `node`: the graph node the car is currently at

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
      "status": "routing"
    }
  ]
}
```

- `car_id`: which car this instruction is for
- `color`, `plate`: echoed back for the signboard display
- `node`: the node where this signboard is shown
- `direction`: "left" | "right" | "straight" | "up" | "arrived"
- `slot`: the assigned slot node id
- `slot_floor`: which floor the slot is on
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

At startup, ~50% of slots (96 of 192) are pre-filled with static cars
(random color, plate, size matching the slot). These cars never move.
The backend marks those slots as occupied. The frontend renders them as
parked cars in the 3D scene. The backend uses a fixed random seed (42)
so the pre-parked set is deterministic.

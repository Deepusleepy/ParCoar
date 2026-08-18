# ParCoar — Message Contract & Shared Spec

This file defines the communication protocol between the 3D simulator
(frontend) and the parking guidance backend (Python). Both sides must follow
this exactly.

## Transport

- WebSocket on `ws://localhost:8765`
- Messages are JSON text frames
- Frontend connects, backend accepts one persistent connection

## Lot Layout

Both sides load `shared/lot.json`. It contains:

```json
{
  "nodes": {
    "E0":     {"type": "entry",     "floor": 0, "x": 0,  "y": 0},
    "J0_1":   {"type": "junction",  "floor": 0, "x": 8,  "y": 0},
    "S0_1":   {"type": "slot",      "floor": 0, "x": 8,  "y": -4, "size": "large"},
    "R0_up":  {"type": "ramp_up",   "floor": 0, "x": 72, "y": 0},
    "R1_in":  {"type": "ramp_in",   "floor": 1, "x": 0,  "y": 0},
    "EXIT2":  {"type": "exit",      "floor": 2, "x": 72, "y": 0}
  },
  "edges": {
    "E0":    [{"dir": "straight", "to": "J0_1"}],
    "J0_1":  [{"dir": "left", "to": "S0_1"}, {"dir": "right", "to": "S0_2"}, {"dir": "straight", "to": "J0_2"}],
    "J0_8":  [{"dir": "left", "to": "S0_15"}, {"dir": "right", "to": "S0_16"}, {"dir": "up", "to": "R0_up"}],
    "R0_up": [{"dir": "up", "to": "R1_in"}],
    "S0_1":  []
  }
}
```

Node types: `entry`, `junction`, `slot`, `ramp_up`, `ramp_in`, `exit`
Slot sizes: `small`, `medium`, `large`
Direction labels: `left`, `right`, `straight`, `up`

Aisles are one-way. Each junction has at most one incoming road, so the
direction labels are always correct regardless of approach.

## Message: Frontend -> Backend (state update)

Sent every tick (the frontend's animation frame, throttled to ~5/sec):

```json
{
  "type": "state",
  "cars": [
    {
      "id": "C1",
      "color": "red",
      "plate": "ABC-123",
      "size": "medium",
      "node": "J0_1"
    }
  ]
}
```

- `id`: unique car identifier (string)
- `color`: car color for signboard display
- `plate`: license plate for signboard display
- `size`: "small" | "medium" | "large" — must fit in slot size (car can park
  in a slot of equal or larger size, not smaller)
- `node`: the graph node the car is currently at (junction, ramp, entry, slot)

If a car is new (backend hasn't seen it), the backend assigns it a slot.
If a car has reached its assigned slot node, it's parked — the backend
sends no further instructions for it.

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
      "node": "J0_1",
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
- `node`: the junction where this signboard is shown
- `direction`: "left" | "right" | "straight" | "up" | "arrived"
- `slot`: the assigned slot node id
- `slot_floor`: which floor the slot is on (for the signboard)
- `status`: "routing" (still moving) | "parked" (reached slot) | "no_slot" (no
  suitable free slot found)

If `status` is "parked", `direction` is "arrived" and the frontend should
stop the car and show it parked.

If `status` is "no_slot", the lot is full for this car's size — the frontend
can show a "LOT FULL" sign.

## Slot Assignment Rules

The backend assigns slots considering, in order:
1. **Size match**: car can only use a slot of equal or larger size
2. **Distance**: nearest free slot by BFS hop count from the car's current node
3. **Load spread**: if the nearest floor already has 3+ cars routing to it,
   prefer the next nearest slot on a different floor

## Pre-parked Cars

At startup, ~50% of slots are pre-filled with static cars (random color,
plate, size matching the slot). These cars never move. The backend marks
those slots as occupied. The frontend renders them as parked cars in the 3D scene.

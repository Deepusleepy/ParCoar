# ParCoar message contract

The browser simulates cars and bay sensors. The Python server owns bay
reservations and calculates routes. Each WebSocket connection has independent
state, so separate browser tabs do not share a garage.

## Transport

- WebSocket: `ws://127.0.0.1:8765`
- JSON text frames
- Frontend sends a state snapshot about five times per second

## Layout

Both sides use `lot.json`. The garage has three floors and 480 identical bays.
Every directed graph edge has:

```json
{"to": "J0_0_2", "dir": "straight", "cost": 2.6}
```

`cost` is physical driving distance. Long curved turns and ramps therefore cost
more than a short aisle step. Bays are dead ends and can never be used as a
shortcut through the graph.

Vehicle models may look different in the 3D scene, but model dimensions are not
part of allocation. Any car can use any free bay.

## Frontend to backend

```json
{
  "type": "state",
  "cars": [
    {
      "id": "C1",
      "color": "red",
      "plate": "ABC-123",
      "node": "J0_0_1",
      "leaving": false,
      "assigned_slot": "S1_84",
      "vacating_slot": null
    }
  ],
  "occupied_slots": ["S0_1", "S0_2"]
}
```

- `occupied_slots` is a physical sensor snapshot: pre-parked cars, parked cars,
  and a bay still occupied while a departing car reverses out.
- Active reservations are not included. Python owns them.
- `assigned_slot` lets a new server session restore an existing route after a
  WebSocket reconnect. Python accepts it only when the bay is still safe.
- `vacating_slot` identifies the bay a departing car has not physically cleared.

## Backend to frontend

```json
{
  "type": "instructions",
  "signs": [
    {
      "car_id": "C1",
      "color": "red",
      "plate": "ABC-123",
      "node": "J0_0_1",
      "direction": "straight",
      "destination": "S1_84",
      "destination_type": "bay",
      "destination_floor": 1,
      "slot": "S1_84",
      "status": "routing",
      "next_node": "J0_0_2",
      "next_direction": "straight",
      "path": ["J0_0_1", "J0_0_2", "...", "S1_84"],
      "route_distance": 138.4,
      "estimated_seconds": 19.8
    }
  ]
}
```

Statuses:

- `routing`: follow `path`
- `parked`: the car reached its assigned bay
- `left`: the car reached the exit
- `no_slot`: every bay is occupied or reserved
- `no_path`: the destination exists but cannot be reached

`direction` is `arrived` only for `parked` or `left`. A routing failure is never
reported as arrival.

## Assignment rules

1. Treat physically occupied and server-reserved bays as unavailable.
2. Run Dijkstra from the car's current node using edge `cost`.
3. Reserve the first free bay finalized by the search.
4. Preserve that reservation until the car parks, leaves, disappears, or a bay
   sensor reports a conflict.

There is no congestion-routing or floor-load rule. The road graph has one route
between locations, so traffic cannot create a meaningful alternate path. The
frontend still prevents cars from entering an occupied lane segment; that is
collision safety, not route selection.

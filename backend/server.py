import json, os
from collections import deque
from websockets.sync.server import serve

# Load the lot layout (nodes and edges) from shared/lot.json.
HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, "..", "shared", "lot.json")) as f:
    lot = json.load(f)
nodes = lot["nodes"]
edges = lot["edges"]

# Size rank: a car fits in a slot of equal or larger size (small=0, medium=1, large=2).
SIZE_RANK = {"small": 0, "medium": 1, "large": 2}

# All slot node ids in the lot.
all_slots = [n for n, d in nodes.items() if d["type"] == "slot"]

# Slots that already have a car. Synced from the frontend on every state
# message (pre-parked + parked cars), plus slots we assign to routing cars.
occupied = set()

# Active cars we are tracking: id -> {color, plate, size, node, slot, status}.
cars = {}

def bfs(start, goal):
    """Shortest path (list of node ids) from start to goal, or None.

    Breadth-first search, so the first route that reaches the goal is the one
    with the fewest hops. Parking bays are dead ends on purpose: a bay has an
    edge back to its aisle so a parked car can leave, but we never let a route
    pass *through* a bay, or cars would cut across the parking to save a hop.
    """
    if start == goal:
        return [start]
    seen = {start}
    queue = deque([[start]])
    while queue:
        path = queue.popleft()
        for e in edges.get(path[-1], []):
            nxt = e["to"]
            if nxt in seen:
                continue
            if nxt == goal:
                return path + [nxt]
            seen.add(nxt)
            # A bay is only ever a destination, never a shortcut.
            if nodes[nxt]["type"] == "slot":
                continue
            queue.append(path + [nxt])
    return None


# How many candidate bays to keep looking for after finding the first one.
# Only needed so the load-spreading rule below has an alternative to offer.
CANDIDATES = 12


def nearest_free_slot(car_node, car_size):
    """Nearest free bay the car fits in, spreading load away from busy floors.

    One breadth-first sweep outward from the car. Because BFS visits nodes in
    order of distance, the bays land in `found` nearest-first, so we can stop
    as soon as we have a handful of candidates instead of searching the whole
    garage. (The previous version ran a separate search to every single bay,
    which is hundreds of searches per car.)
    """
    found = []
    seen = {car_node}
    queue = deque([car_node])
    while queue and len(found) < CANDIDATES:
        for e in edges.get(queue.popleft(), []):
            nxt = e["to"]
            if nxt in seen:
                continue
            seen.add(nxt)
            if nodes[nxt]["type"] == "slot":
                # Bays are destinations, not through-routes, so never enqueue
                # one. Keep it only if it is free and big enough for this car.
                if nxt not in occupied and SIZE_RANK[car_size] <= SIZE_RANK[nodes[nxt]["size"]]:
                    found.append(nxt)
            else:
                queue.append(nxt)
    if not found:
        return None
    # Count how many cars are already heading to each floor.
    floor_count = {}
    for c in cars.values():
        if c["status"] == "routing" and c["slot"]:
            fl = nodes[c["slot"]]["floor"]
            floor_count[fl] = floor_count.get(fl, 0) + 1
    # Load spread: if the nearest bay's floor already has 3 cars heading to it,
    # send this one to the next-nearest bay on a different floor instead.
    best_floor = nodes[found[0]]["floor"]
    if floor_count.get(best_floor, 0) >= 3:
        for s in found[1:]:
            if nodes[s]["floor"] != best_floor:
                return s
    return found[0]


def assign_slot(car):
    """Assign a free slot to a new car and mark that slot occupied."""
    slot = nearest_free_slot(car["node"], car["size"])
    if slot is None:
        car["slot"] = None
        car["status"] = "no_slot"
        return
    car["slot"] = slot
    car["status"] = "routing"
    occupied.add(slot)


def next_direction(car):
    """Compute the direction label for the car's next move via BFS from its node to its slot."""
    if car["node"] == car["slot"]:
        return "arrived"
    path = bfs(car["node"], car["slot"])
    if not path or len(path) < 2:
        return "arrived"
    for e in edges.get(path[0], []):
        if e["to"] == path[1]:
            return e["dir"]
    return "arrived"


def next_node_and_direction(car):
    """Compute the next node id and the direction at that node, so the
    frontend can light up the signboard at the next junction BEFORE the car
    arrives (the car is still en route to the next node). Returns
    (next_node, next_direction) or (None, None) if there is no next node."""
    if car["node"] == car["slot"]:
        return None, None
    path = bfs(car["node"], car["slot"])
    if not path or len(path) < 3:
        return None, None
    next_node = path[1]
    for e in edges.get(path[1], []):
        if e["to"] == path[2]:
            return next_node, e["dir"]
    return next_node, "arrived"


def handle_message(msg):
    """Process an incoming state message and build the instructions reply."""
    # Sync occupied slots from the frontend. The frontend now sends ALL
    # occupied slots: pre-parked, parked, and slots active routing cars are
    # heading toward. This closes the race where a just-parked car's slot
    # briefly left routing_claimed before appearing in the frontend parked
    # list, allowing the backend to reassign it to another car.
    frontend_occupied = set(msg.get("occupied_slots", []))
    occupied.clear()
    occupied.update(frontend_occupied)
    # After syncing from the frontend, also keep ALL backend-tracked cars'
    # slots. The frontend's occupied_slots may briefly omit a just-parked
    # car's slot during the React re-render window (or after a page reload
    # before the frontend re-sends it); this keeps the backend from
    # reassigning it to another car. Keeping parked cars' slots too means a
    # stale parked car that vanished from the frontend's message doesn't
    # free its slot until the prune step below removes it from `cars`.
    for c in cars.values():
        if c["slot"]:
            occupied.add(c["slot"])

    # Track which car ids appear in this message so we can prune stale cars
    # from the backend's tracking dict (cars that vanished, e.g. after a
    # page reload or no_slot timeout).
    seen_this_message = {c["id"] for c in msg.get("cars", [])}

    signs = []
    for c in msg.get("cars", []):
        cid = c["id"]
        # New car: record it and assign a slot.
        if cid not in cars:
            cars[cid] = {"color": c["color"], "plate": c["plate"], "size": c["size"],
                         "node": c["node"], "slot": None, "status": "routing"}
            assign_slot(cars[cid])
        else:
            # Existing car: just update where it is now.
            cars[cid]["node"] = c["node"]
            # If a previously-parked car reappears at a different node
            # (e.g. page reload reuses the same car ID), re-route it.
            if cars[cid]["status"] == "parked" and cars[cid]["node"] != cars[cid].get("slot"):
                cars[cid]["status"] = "routing"
        car = cars[cid]
        # No suitable slot anywhere: report lot full.
        if car["status"] == "no_slot":
            signs.append({"car_id": cid, "color": car["color"], "plate": car["plate"],
                          "node": car["node"], "direction": "arrived", "slot": None,
                          "slot_floor": None, "status": "no_slot"})
            continue
        # Car reached its slot: mark parked.
        if car["node"] == car["slot"]:
            car["status"] = "parked"
            direction = "arrived"
            next_node = None
            next_dir = None
        else:
            direction = next_direction(car)
            next_node, next_dir = next_node_and_direction(car)
        signs.append({"car_id": cid, "color": car["color"], "plate": car["plate"],
                      "node": car["node"], "direction": direction, "slot": car["slot"],
                      "slot_floor": nodes[car["slot"]]["floor"], "status": car["status"],
                      "next_node": next_node, "next_direction": next_dir})

    # Prune stale cars: those we track that didn't appear in this message.
    for cid in list(cars.keys()):
        if cid not in seen_this_message:
            del cars[cid]

    return {"type": "instructions", "signs": signs}


def handler(ws):
    """WebSocket handler: read each incoming message, compute instructions, send them back."""
    for message in ws:
        reply = handle_message(json.loads(message))
        ws.send(json.dumps(reply))


def main():
    """Start the WebSocket server on localhost:8765 and serve forever."""
    with serve(handler, "localhost", 8765) as server:
        server.serve_forever()


if __name__ == "__main__":
    main()

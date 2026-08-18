import json, os, random
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

# Pre-fill ~50% of slots with static parked cars (random color/plate, size matches slot).
# These never move; we just mark their slots occupied.
occupied = set()
parked = {}
random.seed(42)
for slot in random.sample(all_slots, len(all_slots) // 2):
    occupied.add(slot)
    n = len(parked) + 1
    parked[slot] = {"id": "P" + str(n), "color": random.choice(["red", "blue", "green", "white", "black"]), "plate": "PARK-" + str(n), "size": nodes[slot]["size"]}
print("Pre-parked", len(parked), "slots;", len(all_slots) - len(occupied), "free")

# Active cars we are tracking: id -> {color, plate, size, node, slot, status}.
cars = {}

def bfs(start, goal):
    """Find the shortest path (list of node ids) from start to goal using BFS. Returns None if unreachable."""
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
            queue.append(path + [nxt])
    return None


def nearest_free_slot(car_node, car_size):
    """Find the nearest free slot the car fits in, spreading load away from crowded floors."""
    # Collect every free slot this car fits in, with its BFS hop count from the car.
    scored = []
    for s in all_slots:
        if s in occupied or SIZE_RANK[car_size] > SIZE_RANK[nodes[s]["size"]]:
            continue
        p = bfs(car_node, s)
        if p:
            scored.append((len(p), s))
    scored.sort()
    if not scored:
        return None
    # Count how many routing cars are already heading to each floor.
    floor_count = {}
    for c in cars.values():
        if c["status"] == "routing" and c["slot"]:
            fl = nodes[c["slot"]]["floor"]
            floor_count[fl] = floor_count.get(fl, 0) + 1
    # Load spread: if the nearest slot's floor has 3+ routing cars, prefer a slot on another floor.
    best_floor = nodes[scored[0][1]]["floor"]
    if floor_count.get(best_floor, 0) >= 3:
        for _, s in scored[1:]:
            if nodes[s]["floor"] != best_floor:
                return s
    return scored[0][1]


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


def handle_message(msg):
    """Process an incoming state message and build the instructions reply."""
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
        else:
            direction = next_direction(car)
        signs.append({"car_id": cid, "color": car["color"], "plate": car["plate"],
                      "node": car["node"], "direction": direction, "slot": car["slot"],
                      "slot_floor": nodes[car["slot"]]["floor"], "status": car["status"]})
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

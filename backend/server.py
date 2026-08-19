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

# The one exit node. Cars that have finished parking are routed here.
EXIT_NODE = next(n for n, d in nodes.items() if d["type"] == "exit")

# Per-connection state.
#
# These used to be module-level globals shared by every client. With two
# browser tabs open (or one still closing while another loads) both talked to
# the same dictionaries, and because each message prunes cars it does not
# mention, the two clients deleted each other's cars several times a second.
# Each recreated car was then assigned a fresh bay, which is why cars appeared
# to "dance between parking spaces". Measured: 747 prune/recreate events in 45
# seconds with two tabs open.
#
# A Session holds one client's view, so clients can no longer corrupt one
# another.
class Session:
    def __init__(self):
        # Bays that already have a car: pre-parked, parked, and bays this
        # client's routing cars are heading for.
        self.occupied = set()
        # Cars we are tracking for this client:
        # id -> {color, plate, size, node, slot, status, leaving}
        self.cars = {}

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


# A floor with this many cars already heading to it counts as busy, and an
# arriving car is sent further up instead. This is what keeps all three
# storeys in use rather than piling every car onto the nearest one.
BUSY_FLOOR = 3


def nearest_free_slot(session, car_node, car_size):
    """Nearest free bay the car fits in, spreading load away from busy floors.

    One breadth-first sweep outward from the car. BFS visits nodes in order of
    distance, so `found` comes out sorted nearest-first for free, and we can
    just walk it. The whole garage is a few hundred nodes, so sweeping all of
    it costs well under a millisecond; an earlier version stopped after a
    dozen candidates and, because those were all on the nearest floor, it
    could never offer an alternative and sent every single car to floor A.
    """
    found = []
    seen = {car_node}
    queue = deque([car_node])
    while queue:
        for e in edges.get(queue.popleft(), []):
            nxt = e["to"]
            if nxt in seen:
                continue
            seen.add(nxt)
            if nodes[nxt]["type"] == "slot":
                # Bays are destinations, not through-routes, so never enqueue
                # one. Keep it only if it is free and big enough for this car.
                if nxt not in session.occupied and SIZE_RANK[car_size] <= SIZE_RANK[nodes[nxt]["size"]]:
                    found.append(nxt)
            else:
                queue.append(nxt)
    if not found:
        return None
    # Count how many cars are already heading to each floor.
    floor_count = {}
    for c in session.cars.values():
        if c["status"] == "routing" and c["slot"]:
            fl = nodes[c["slot"]]["floor"]
            floor_count[fl] = floor_count.get(fl, 0) + 1
    # Take the nearest bay on a floor that is not already busy.
    for s in found:
        if floor_count.get(nodes[s]["floor"], 0) < BUSY_FLOOR:
            return s
    # Every floor is busy: fall back to the nearest bay of all.
    return found[0]


def assign_slot(session, car):
    """Assign a free bay to a new car and mark that bay occupied."""
    slot = nearest_free_slot(session, car["node"], car["size"])
    if slot is None:
        car["slot"] = None
        car["status"] = "no_slot"
        return
    car["slot"] = slot
    car["status"] = "routing"
    session.occupied.add(slot)


def direction_along(path, step):
    """Direction label for hop `step` of a path, e.g. "left" or "straight".

    A path is a list of node ids. The direction of a hop is the label on the
    edge joining two consecutive nodes, which is exactly what a signboard
    needs to display.
    """
    if not path or len(path) < step + 2:
        return None
    for e in edges.get(path[step], []):
        if e["to"] == path[step + 1]:
            return e["dir"]
    return None


def handle_message(session, msg):
    """Process an incoming state message and build the instructions reply."""
    # Sync occupied slots from the frontend. The frontend now sends ALL
    # occupied slots: pre-parked, parked, and slots active routing cars are
    # heading toward. This closes the race where a just-parked car's slot
    # briefly left routing_claimed before appearing in the frontend parked
    # list, allowing the backend to reassign it to another car.
    frontend_occupied = set(msg.get("occupied_slots", []))
    session.occupied.clear()
    session.occupied.update(frontend_occupied)
    # After syncing from the frontend, also keep ALL backend-tracked cars'
    # slots. The frontend's occupied_slots may briefly omit a just-parked
    # car's slot during the React re-render window (or after a page reload
    # before the frontend re-sends it); this keeps the backend from
    # reassigning it to another car. Keeping parked cars' slots too means a
    # stale parked car that vanished from the frontend's message doesn't
    # free its slot until the prune step below removes it from `cars`.
    for c in session.cars.values():
        if c["slot"] and not c.get("leaving"):
            session.occupied.add(c["slot"])

    # Track which car ids appear in this message so we can prune stale cars
    # from the backend's tracking dict (cars that vanished, e.g. after a
    # page reload or no_slot timeout).
    seen_this_message = {c["id"] for c in msg.get("cars", [])}

    signs = []
    for c in msg.get("cars", []):
        cid = c["id"]
        # A car is either looking for a bay, or on its way back out.
        leaving = bool(c.get("leaving"))
        # New car: record it and assign a bay.
        if cid not in session.cars:
            session.cars[cid] = {"color": c["color"], "plate": c["plate"], "size": c["size"],
                         "node": c["node"], "slot": None, "status": "routing",
                         "leaving": leaving}
            if not leaving:
                assign_slot(session, session.cars[cid])
        else:
            # Existing car: just update where it is now.
            session.cars[cid]["node"] = c["node"]
            session.cars[cid]["leaving"] = leaving
            # If a previously-parked car reappears at a different node
            # (e.g. page reload reuses the same car ID), re-route it.
            if session.cars[cid]["status"] == "parked" and session.cars[cid]["node"] != session.cars[cid].get("slot"):
                session.cars[cid]["status"] = "routing"
        car = session.cars[cid]
        # A leaving car heads for the exit instead of a bay. Same search, a
        # different destination, so nothing else in here has to change.
        target = EXIT_NODE if car["leaving"] else car["slot"]
        # No suitable slot anywhere: report lot full.
        if car["status"] == "no_slot":
            signs.append({"car_id": cid, "color": car["color"], "plate": car["plate"],
                          "node": car["node"], "direction": "arrived", "slot": None,
                          "slot_floor": None, "status": "no_slot"})
            continue
        # Car reached where it was going: parked in its bay, or out of the lot.
        if car["node"] == target:
            car["status"] = "left" if car["leaving"] else "parked"
            path = [target]
            direction = "arrived"
            next_node = None
            next_dir = None
        else:
            # ONE search per car per tick. Everything the frontend needs is
            # derived from this single route rather than searching again for
            # each field.
            path = bfs(car["node"], target) or [car["node"]]
            direction = direction_along(path, 0) or "arrived"
            next_node = path[1] if len(path) > 2 else None
            next_dir = direction_along(path, 1)
        signs.append({"car_id": cid, "color": car["color"], "plate": car["plate"],
                      "node": car["node"], "direction": direction, "slot": target,
                      "slot_floor": nodes[target]["floor"], "status": car["status"],
                      "next_node": next_node, "next_direction": next_dir,
                      # The full remaining route. Signboards along it light up
                      # as soon as the car is heading their way, instead of
                      # only when it has already arrived underneath them.
                      "path": path})

    # Prune stale cars: those we track that didn't appear in this message.
    for cid in list(session.cars.keys()):
        if cid not in seen_this_message:
            del session.cars[cid]

    return {"type": "instructions", "signs": signs}


def handler(ws):
    """One connection. Each client gets its own Session, so two open tabs
    cannot delete each other's cars."""
    session = Session()
    for message in ws:
        reply = handle_message(session, json.loads(message))
        ws.send(json.dumps(reply))


def main():
    """Start the WebSocket server on localhost:8765 and serve forever."""
    with serve(handler, "localhost", 8765) as server:
        server.serve_forever()


if __name__ == "__main__":
    main()

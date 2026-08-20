"""Small WebSocket backend for the ParCoar parking simulator."""

import heapq
import json
import os
from websockets.sync.server import serve

HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, "..", "shared", "lot.json"), encoding="utf-8") as file:
    lot = json.load(file)

nodes = lot["nodes"]
edges = lot["edges"]
all_slots = {node_id for node_id, node in nodes.items() if node["type"] == "slot"}
EXIT_NODE = next(node_id for node_id, node in nodes.items() if node["type"] == "exit")
CAR_SPEED = 7.0


class Session:
    """Independent logical garage state for one browser connection."""

    def __init__(self) -> None:
        # Physical occupancy reported by the simulated bay sensors.
        self.occupied: set[str] = set()
        # Server-owned reservations: car id -> assigned bay.
        self.reservations: dict[str, str] = {}
        # id -> {id, color, plate, node, slot, status, leaving}
        self.cars: dict[str, dict] = {}


def _edge_cost(edge: dict) -> float:
    cost = float(edge.get("cost", 1.0))
    return cost if cost > 0 else 1.0


def shortest_path(start: str, goal: str):
    """Return (path, total distance), or None when the goal is unreachable."""
    if start not in nodes or goal not in nodes:
        return None
    if start == goal:
        return [start], 0.0

    distances = {start: 0.0}
    previous: dict[str, str] = {}
    queue = [(0.0, start)]

    while queue:
        distance, current = heapq.heappop(queue)
        if distance != distances.get(current):
            continue
        if current == goal:
            path = [goal]
            while path[-1] != start:
                path.append(previous[path[-1]])
            path.reverse()
            return path, distance

        for edge in edges.get(current, []):
            neighbour = edge["to"]
            # Bays are destinations, never shortcuts through the graph.
            if nodes[neighbour]["type"] == "slot" and neighbour != goal:
                continue
            candidate = distance + _edge_cost(edge)
            if candidate >= distances.get(neighbour, float("inf")):
                continue
            distances[neighbour] = candidate
            previous[neighbour] = current
            heapq.heappush(queue, (candidate, neighbour))

    return None


def unavailable_slots(session: Session, exclude_car: str | None = None) -> set[str]:
    reserved = {
        slot
        for car_id, slot in session.reservations.items()
        if car_id != exclude_car
    }
    return session.occupied | reserved


def nearest_free_slot(session: Session, start: str, car_id: str):
    """Return the physically closest unoccupied, unreserved bay using Dijkstra."""
    if start not in nodes:
        return None

    blocked = unavailable_slots(session, exclude_car=car_id)
    distances = {start: 0.0}
    previous: dict[str, str] = {}
    queue = [(0.0, start)]

    while queue:
        distance, current = heapq.heappop(queue)
        if distance != distances.get(current):
            continue

        if nodes[current]["type"] == "slot":
            if current not in blocked:
                path = [current]
                while path[-1] != start:
                    path.append(previous[path[-1]])
                path.reverse()
                return current, path, distance
            continue

        for edge in edges.get(current, []):
            neighbour = edge["to"]
            if nodes[neighbour]["type"] == "slot" and neighbour in blocked:
                continue
            candidate = distance + _edge_cost(edge)
            if candidate >= distances.get(neighbour, float("inf")):
                continue
            distances[neighbour] = candidate
            previous[neighbour] = current
            heapq.heappush(queue, (candidate, neighbour))

    return None


def release_reservation(session: Session, car_id: str) -> None:
    session.reservations.pop(car_id, None)


def adopt_slot(session: Session, car: dict, slot: str | None) -> bool:
    """Restore a frontend-known reservation after a WebSocket reconnect."""
    if slot not in all_slots:
        return False
    if slot in unavailable_slots(session, exclude_car=car["id"]):
        return False
    session.reservations[car["id"]] = slot
    car["slot"] = slot
    car["status"] = "routing"
    return True


def assign_slot(session: Session, car: dict) -> None:
    """Reserve the closest available bay for a car."""
    release_reservation(session, car["id"])
    result = nearest_free_slot(session, car["node"], car["id"])
    if result is None:
        car["slot"] = None
        car["status"] = "no_slot"
        return

    slot, _, _ = result
    session.reservations[car["id"]] = slot
    car["slot"] = slot
    car["status"] = "routing"


def direction_along(path: list[str], step: int):
    """Return the direction label for one hop of a path."""
    if len(path) < step + 2:
        return None
    source = path[step]
    target = path[step + 1]
    for edge in edges.get(source, []):
        if edge["to"] == target:
            return edge["dir"]
    return None


def _new_car(payload: dict) -> dict:
    required = ("id", "color", "plate", "node")
    missing = [key for key in required if key not in payload]
    if missing:
        raise KeyError(", ".join(missing))
    if payload["node"] not in nodes:
        raise ValueError(f"unknown node {payload['node']}")
    return {
        "id": str(payload["id"]),
        "color": payload["color"],
        "plate": payload["plate"],
        "node": payload["node"],
        "slot": None,
        "status": "routing",
        "leaving": bool(payload.get("leaving")),
    }


def _instruction(car: dict, path: list[str], distance: float, status: str) -> dict:
    leaving = car["leaving"]
    destination = EXIT_NODE if leaving else car["slot"]
    destination_type = "exit" if leaving else ("bay" if destination else None)
    slot = None if leaving else car["slot"]
    direction = "arrived" if status in {"parked", "left"} else direction_along(path, 0)
    next_node = path[1] if len(path) > 2 else None
    next_direction = direction_along(path, 1) if next_node else None

    return {
        "car_id": car["id"],
        "color": car["color"],
        "plate": car["plate"],
        "node": car["node"],
        "direction": direction,
        "destination": destination,
        "destination_type": destination_type,
        "destination_floor": nodes[destination]["floor"] if destination else None,
        "slot": slot,
        "status": status,
        "next_node": next_node,
        "next_direction": next_direction,
        "path": path,
        "route_distance": round(distance, 3),
        "estimated_seconds": round(distance / CAR_SPEED, 1),
    }


def handle_message(session: Session, message: dict) -> dict:
    """Apply one sensor/vehicle snapshot and return routing instructions."""
    if message.get("type", "state") != "state":
        raise ValueError("expected a state message")

    # This is the physical bay-sensor snapshot. Reservations are kept
    # separately by Python and are not accepted from the browser.
    session.occupied = {
        slot for slot in message.get("occupied_slots", []) if slot in all_slots
    }

    payloads = message.get("cars", [])
    seen = {str(payload["id"]) for payload in payloads if "id" in payload}
    instructions = []

    for payload in payloads:
        car_id = str(payload["id"])
        leaving = bool(payload.get("leaving"))
        assigned_slot = payload.get("assigned_slot")

        if car_id not in session.cars:
            car = _new_car(payload)
            session.cars[car_id] = car
            if not leaving:
                if not adopt_slot(session, car, assigned_slot):
                    assign_slot(session, car)
        else:
            car = session.cars[car_id]
            if payload.get("node") not in nodes:
                raise ValueError(f"unknown node {payload.get('node')}")
            was_leaving = car["leaving"]
            car["node"] = payload["node"]
            car["color"] = payload.get("color", car["color"])
            car["plate"] = payload.get("plate", car["plate"])
            car["leaving"] = leaving

            if leaving and not was_leaving:
                release_reservation(session, car_id)
                car["slot"] = None
                car["status"] = "routing"
            elif not leaving and car["slot"] is None:
                if not adopt_slot(session, car, assigned_slot):
                    assign_slot(session, car)

        # A sensor says the reserved bay is now physically occupied by
        # something else. Pick a replacement rather than guiding into it.
        if (
            not car["leaving"]
            and car["slot"] is not None
            and car["slot"] in session.occupied
            and car["node"] != car["slot"]
        ):
            assign_slot(session, car)

        destination = EXIT_NODE if car["leaving"] else car["slot"]
        if destination is None:
            car["status"] = "no_slot"
            instructions.append(_instruction(car, [car["node"]], 0.0, "no_slot"))
            continue

        if car["node"] == destination:
            status = "left" if car["leaving"] else "parked"
            car["status"] = status
            release_reservation(session, car_id)
            if status == "parked":
                session.occupied.add(destination)
            instructions.append(_instruction(car, [destination], 0.0, status))
            continue

        result = shortest_path(car["node"], destination)
        if result is None:
            car["status"] = "no_path"
            instructions.append(_instruction(car, [car["node"]], 0.0, "no_path"))
            continue

        path, distance = result
        car["status"] = "routing"
        instructions.append(_instruction(car, path, distance, "routing"))

    for car_id in list(session.cars):
        if car_id in seen:
            continue
        release_reservation(session, car_id)
        del session.cars[car_id]

    return {"type": "instructions", "signs": instructions}


def handler(websocket) -> None:
    session = Session()
    for raw_message in websocket:
        try:
            reply = handle_message(session, json.loads(raw_message))
        except (json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
            print(f"ignored a bad message: {error}")
            continue
        websocket.send(json.dumps(reply))


def main() -> None:
    with serve(handler, "127.0.0.1", 8765) as server:
        server.serve_forever()


if __name__ == "__main__":
    main()

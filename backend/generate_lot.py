"""Generate the graph used by the ParCoar parking simulator.

The output is written to both shared/lot.json and frontend/public/lot.json.
All bays are identical. Directed edges carry a physical driving cost so the
backend can choose the genuinely closest free bay instead of counting hops.
"""

import json
import math
import os

FLOORS = 3
AISLES_PER_FLOOR = 4
JUNCTIONS_PER_AISLE = 20
SLOTS_PER_JUNCTION = 2
JUNCTION_SPACING = 2.6
AISLE_SPACING = 17
SLOT_OFFSET = 6
ROAD_WIDTH = 7
SLOT_DEPTH = 5
FLOOR_HEIGHT = 15
APPROACH_OFFSET = 15

# These mirror the rendered ramp geometry. They are included in lot.json so
# routing and rendering can share the same dimensions.
RAMP_OUTSET = 19
RAMP_CORNER_RADIUS = 7


def slot_number(aisle: int, junction_index: int, side: int) -> int:
    """Return the sequential bay number within a floor."""
    per_aisle = JUNCTIONS_PER_AISLE * SLOTS_PER_JUNCTION
    return aisle * per_aisle + side * JUNCTIONS_PER_AISLE + junction_index + 1


def edge_cost(nodes: dict, source: str, target: str) -> float:
    """Approximate the real distance driven along one directed graph edge."""
    a = nodes[source]
    b = nodes[target]
    dx = b["x"] - a["x"]
    dy = b["y"] - a["y"]
    dz = (b["floor"] - a["floor"]) * FLOOR_HEIGHT

    # The long side of a 180-degree turn is a semicircle plus the short
    # approach from the turn node to the junction. The near side is straight.
    if a["type"] == "turn" or b["type"] == "turn":
        turn = a if a["type"] == "turn" else b
        other = b if a["type"] == "turn" else a
        aisle_gap = abs(other["y"] - turn["y"])
        if aisle_gap > 1e-9:
            return math.pi * (aisle_gap / 2) + abs(other["x"] - turn["x"])

    # The rendered inter-floor ramp leaves the slab, rounds two corners, runs
    # along the outside wall, and returns to the next floor. Its horizontal
    # centreline is two straight approaches, a middle run, and two quarter arcs.
    if {a["type"], b["type"]} == {"ramp_up", "ramp_in"}:
        floor_run = abs(b["y"] - a["y"])
        horizontal = (
            2 * (RAMP_OUTSET - RAMP_CORNER_RADIUS)
            + max(0, floor_run - 2 * RAMP_CORNER_RADIUS)
            + math.pi * RAMP_CORNER_RADIUS
        )
        return math.hypot(horizontal, dz)

    return math.sqrt(dx * dx + dy * dy + dz * dz)


def main() -> None:
    nodes: dict[str, dict] = {}
    edges: dict[str, list[dict]] = {}

    for floor in range(FLOORS):
        if floor == 0:
            entry_id = "E0"
            nodes[entry_id] = {"type": "entry", "floor": floor, "x": 0, "y": 0}
        else:
            entry_id = f"R{floor}_in"
            nodes[entry_id] = {"type": "ramp_in", "floor": floor, "x": 0, "y": 0}

        previous = entry_id

        for aisle in range(AISLES_PER_FLOOR):
            y = aisle * AISLE_SPACING
            going_right = aisle % 2 == 0

            junction_ids = []
            for number in range(1, JUNCTIONS_PER_AISLE + 1):
                junction_id = f"J{floor}_{aisle}_{number}"
                nodes[junction_id] = {
                    "type": "junction",
                    "floor": floor,
                    "x": number * JUNCTION_SPACING,
                    "y": y,
                }
                junction_ids.append(junction_id)

            if not going_right:
                junction_ids.reverse()

            for junction_index, junction_id in enumerate(junction_ids):
                x = nodes[junction_id]["x"]
                for side in range(SLOTS_PER_JUNCTION):
                    slot_id = f"S{floor}_{slot_number(aisle, junction_index, side)}"
                    slot_y = y + (-SLOT_OFFSET if side == 0 else SLOT_OFFSET)
                    nodes[slot_id] = {
                        "type": "slot",
                        "floor": floor,
                        "x": x,
                        "y": slot_y,
                    }

            first_junction = junction_ids[0]
            edges.setdefault(previous, [])
            direction = ("left" if going_right else "right") if previous.startswith("T") else "straight"
            edges[previous].append({"dir": direction, "to": first_junction})

            for junction_index, junction_id in enumerate(junction_ids):
                outgoing = [
                    {"dir": "left", "to": f"S{floor}_{slot_number(aisle, junction_index, 0)}"},
                    {"dir": "right", "to": f"S{floor}_{slot_number(aisle, junction_index, 1)}"},
                ]
                if junction_index < len(junction_ids) - 1:
                    outgoing.append({"dir": "straight", "to": junction_ids[junction_index + 1]})
                edges[junction_id] = outgoing

            last_junction = junction_ids[-1]
            if aisle < AISLES_PER_FLOOR - 1:
                turn_id = f"T{floor}_{aisle}"
                turn_x = (JUNCTIONS_PER_AISLE + 1) * JUNCTION_SPACING if going_right else 0
                nodes[turn_id] = {"type": "turn", "floor": floor, "x": turn_x, "y": y}
                edges[last_junction].append({"dir": "straight", "to": turn_id})
                edges[turn_id] = []
                previous = turn_id
            elif floor < FLOORS - 1:
                ramp_id = f"R{floor}_up"
                ramp_x = (JUNCTIONS_PER_AISLE + 1) * JUNCTION_SPACING if going_right else 0
                nodes[ramp_id] = {"type": "ramp_up", "floor": floor, "x": ramp_x, "y": y}
                edges[last_junction].append({"dir": "straight", "to": ramp_id})
                edges[ramp_id] = [{"dir": "up", "to": f"R{floor + 1}_in"}]
            else:
                exit_id = f"EXIT{floor}"
                exit_x = (JUNCTIONS_PER_AISLE + 1) * JUNCTION_SPACING if going_right else 0
                nodes[exit_id] = {"type": "exit", "floor": floor, "x": exit_x, "y": y}
                edges[last_junction].append({"dir": "straight", "to": exit_id})
                edges[exit_id] = []

    nodes["ENTRY_ROAD"] = {
        "type": "approach",
        "floor": 0,
        "x": -APPROACH_OFFSET,
        "y": nodes["E0"]["y"],
    }
    edges["ENTRY_ROAD"] = [{"dir": "straight", "to": "E0"}]

    exit_id = f"EXIT{FLOORS - 1}"
    exit_node = nodes[exit_id]
    nodes["EXIT_ROAD"] = {
        "type": "approach",
        "floor": FLOORS - 1,
        "x": -APPROACH_OFFSET,
        "y": exit_node["y"],
    }
    edges[exit_id].append({"dir": "straight", "to": "EXIT_ROAD"})
    edges["EXIT_ROAD"] = []

    junctions_by_position = {
        (node["floor"], node["x"], node["y"]): node_id
        for node_id, node in nodes.items()
        if node["type"] == "junction"
    }
    for node_id, node in nodes.items():
        if node["type"] != "slot":
            continue
        aisle_y = round(node["y"] / AISLE_SPACING) * AISLE_SPACING
        junction_id = junctions_by_position.get((node["floor"], node["x"], aisle_y))
        edges[node_id] = [{"dir": "straight", "to": junction_id}] if junction_id else []

    road_edges = [
        (source, edge["to"], edge["dir"])
        for source, outgoing in edges.items()
        for edge in outgoing
        if nodes[source]["type"] != "slot" and nodes[edge["to"]]["type"] != "slot"
    ]
    opposite = {"left": "right", "right": "left", "up": "down", "down": "up"}
    for source, target, direction in road_edges:
        if nodes[target]["type"] == "turn":
            direction = opposite[edges[target][0]["dir"]]
        else:
            direction = opposite.get(direction, direction)
        edges[target].append({"dir": direction, "to": source})

    for source, outgoing in edges.items():
        for edge in outgoing:
            edge["cost"] = round(edge_cost(nodes, source, edge["to"]), 3)

    lot = {
        "floors": FLOORS,
        "floor_height": FLOOR_HEIGHT,
        "aisles_per_floor": AISLES_PER_FLOOR,
        "junctions_per_aisle": JUNCTIONS_PER_AISLE,
        "junction_spacing": JUNCTION_SPACING,
        "aisle_spacing": AISLE_SPACING,
        "slot_offset": SLOT_OFFSET,
        "road_width": ROAD_WIDTH,
        "slot_depth": SLOT_DEPTH,
        "ramp_outset": RAMP_OUTSET,
        "ramp_corner_radius": RAMP_CORNER_RADIUS,
        "nodes": nodes,
        "edges": edges,
    }

    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    output_paths = [
        os.path.join(project_root, "shared", "lot.json"),
        os.path.join(project_root, "frontend", "public", "lot.json"),
    ]
    for output_path in output_paths:
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as file:
            json.dump(lot, file, separators=(",", ":"))
            file.write("\n")
        print(f"Generated {output_path}")

    counts = {
        node_type: sum(1 for node in nodes.values() if node["type"] == node_type)
        for node_type in {node["type"] for node in nodes.values()}
    }
    print(f"  Floors: {FLOORS}")
    print(f"  Slots: {counts.get('slot', 0)}")
    print(f"  Total nodes: {len(nodes)}")


if __name__ == "__main__":
    main()

"""
Lot layout generator for the ParCoar parking guidance system.

Produces shared/lot.json — a 3-floor parking garage with a serpentine layout:
each floor has 4 aisles running back and forth, with 180° curved turns at the
ends. Slots line both sides of every aisle. Spiral ramps connect floors.

Layout per floor (top view), 4 aisles x 8 junctions x 2 slots = 64 slots:

    Aisle 1 (→):  J1 → J2 → J3 → J4 → J5 → J6 → J7 → J8 → [Turn1]
                                                                   ↓
    Aisle 2 (←): [Turn2] ← J9 ← J10 ← J11 ← J12 ← J13 ← J14 ← J15 ← J16
                    ↓
    Aisle 3 (→):  J17 → J18 → J19 → J20 → J21 → J22 → J23 → J24 → [Turn3]
                                                                     ↓
    Aisle 4 (←): [Turn4] ← J25 ← J26 ← J27 ← J28 ← J29 ← J30 ← J31 ← J32
                    ↓
                [Ramp up to next floor]

3 floors x 64 slots = 192 total slots.

Run:  python backend/generate_lot.py
Output: shared/lot.json
"""

import json
import os
import random

FLOORS = 3
AISLES_PER_FLOOR = 4
JUNCTIONS_PER_AISLE = 8
SLOTS_PER_JUNCTION = 2  # left + right
JUNCTION_SPACING = 2.6  # x-distance between junctions = one parking bay pitch
AISLE_SPACING = 17      # y-distance between aisle centrelines (road + a bay each side)
SLOT_OFFSET = 6         # y-distance from aisle centre to slot centre
ROAD_WIDTH = 7          # full driving-road width across both lanes (±3.5 of centre)
SLOT_DEPTH = 5          # parking bay depth (perpendicular to the aisle)
SLOT_SIZES = ["small", "medium", "large"]
FLOOR_HEIGHT = 15       # z-distance between floors (used by frontend only)
APPROACH_OFFSET = 15    # x-distance of entry/exit approach roads west of the lot


def slot_number(aisle, j_idx, s_pos):
    """Sequential per-side slot number within a floor.

    Each aisle holds JUNCTIONS_PER_AISLE junctions, each with two slots
    (s_pos 0 = the -y side, s_pos 1 = the +y side). Numbers are assigned
    side-by-side rather than interleaved per junction, so every *side* of
    an aisle is a contiguous, predictable run (e.g. A1..A8 on one side,
    A9..A16 on the other), in travel order. Aisles chain contiguously:
    aisle 0 = 1..16, aisle 1 = 17..32, etc.
    """
    per_aisle = JUNCTIONS_PER_AISLE * SLOTS_PER_JUNCTION
    return aisle * per_aisle + s_pos * JUNCTIONS_PER_AISLE + j_idx + 1


def main():
    random.seed(42)

    nodes = {}
    edges = {}

    for floor in range(FLOORS):
        f = floor

        # Entry / ramp-in for this floor
        if floor == 0:
            entry_id = "E0"
            nodes[entry_id] = {"type": "entry", "floor": f, "x": 0, "y": 0}
        else:
            entry_id = f"R{f}_in"
            nodes[entry_id] = {"type": "ramp_in", "floor": f, "x": 0, "y": 0}

        # Build aisles — serpentine pattern (alternating direction)
        prev_node = entry_id  # chain aisles together

        for aisle in range(AISLES_PER_FLOOR):
            y = aisle * AISLE_SPACING
            going_right = (aisle % 2 == 0)  # even aisles go right, odd go left

            junction_ids = []
            for j in range(1, JUNCTIONS_PER_AISLE + 1):
                jid = f"J{f}_{aisle}_{j}"
                jx = j * JUNCTION_SPACING
                nodes[jid] = {"type": "junction", "floor": f, "x": jx, "y": y}
                junction_ids.append(jid)

            # If going left, reverse the junction order for edge-building
            if not going_right:
                junction_ids = list(reversed(junction_ids))

            # --- Slots branching off each junction ---
            for j_idx, jid in enumerate(junction_ids):
                jx = nodes[jid]["x"]
                for s_pos in range(SLOTS_PER_JUNCTION):
                    sid = f"S{f}_{slot_number(aisle, j_idx, s_pos)}"
                    sy = y + (-SLOT_OFFSET if s_pos == 0 else SLOT_OFFSET)
                    size = random.choice(SLOT_SIZES)
                    nodes[sid] = {"type": "slot", "floor": f, "x": jx, "y": sy, "size": size}

            # --- Chain: previous node → first junction of this aisle ---
            # Always "straight": the 180° direction changes between aisles are
            # represented by the turn nodes, not by this edge.
            first_j = junction_ids[0]
            if prev_node not in edges:
                edges[prev_node] = []
            edges[prev_node].append({"dir": "straight", "to": first_j})

            # --- Edges along the aisle: each junction → its slots + next junction ---
            for j_idx, jid in enumerate(junction_ids):
                edge_list = []
                # Slots — s_pos 0 is the -y side ("left"), s_pos 1 the +y side ("right").
                left_slot = f"S{f}_{slot_number(aisle, j_idx, 0)}"
                right_slot = f"S{f}_{slot_number(aisle, j_idx, 1)}"
                edge_list.append({"dir": "left", "to": left_slot})
                edge_list.append({"dir": "right", "to": right_slot})
                # Next junction along the aisle
                if j_idx < len(junction_ids) - 1:
                    edge_list.append({"dir": "straight", "to": junction_ids[j_idx + 1]})
                edges[jid] = edge_list

            # --- Turn node at the end of the aisle (180° curve to next aisle) ---
            if aisle < AISLES_PER_FLOOR - 1:
                last_j = junction_ids[-1]
                turn_id = f"T{f}_{aisle}"
                turn_x = (JUNCTIONS_PER_AISLE + 1) * JUNCTION_SPACING
                if not going_right:
                    turn_x = 0  # turn at the left end if going left
                nodes[turn_id] = {"type": "turn", "floor": f, "x": turn_x, "y": y}
                # last junction → turn
                edges[last_j].append({"dir": "straight", "to": turn_id})
                # turn → first junction of next aisle (will be chained in next iteration)
                edges[turn_id] = []  # will be set when next aisle starts
                prev_node = turn_id
            else:
                # Last aisle: connect to ramp up or exit
                last_j = junction_ids[-1]
                if floor < FLOORS - 1:
                    ramp_id = f"R{f}_up"
                    ramp_x = (JUNCTIONS_PER_AISLE + 1) * JUNCTION_SPACING
                    if not going_right:
                        ramp_x = 0
                    nodes[ramp_id] = {"type": "ramp_up", "floor": f, "x": ramp_x, "y": y}
                    edges[last_j].append({"dir": "straight", "to": ramp_id})
                    # Ramp up → ramp_in of next floor
                    next_floor = floor + 1
                    ramp_in_next = f"R{next_floor}_in"
                    edges[ramp_id] = [{"dir": "up", "to": ramp_in_next}]
                else:
                    # Top floor: exit
                    exit_id = f"EXIT{f}"
                    exit_x = (JUNCTIONS_PER_AISLE + 1) * JUNCTION_SPACING
                    if not going_right:
                        exit_x = 0
                    nodes[exit_id] = {"type": "exit", "floor": f, "x": exit_x, "y": y}
                    edges[last_j].append({"dir": "straight", "to": exit_id})
                    edges[exit_id] = []
                prev_node = None  # end of chain

    # --- Entry / exit approach roads (road segments outside the lot) ---
    # Entry approach: cars arrive from the west and enter at E0 (floor 0).
    nodes["ENTRY_ROAD"] = {"type": "approach", "floor": 0, "x": -APPROACH_OFFSET, "y": nodes["E0"]["y"]}
    edges["ENTRY_ROAD"] = [{"dir": "straight", "to": "E0"}]

    # Exit approach: cars leave EXIT2 (top floor) and drive away to the west.
    exit_id = f"EXIT{FLOORS - 1}"
    exit_node = nodes[exit_id]
    nodes["EXIT_ROAD"] = {"type": "approach", "floor": FLOORS - 1, "x": -APPROACH_OFFSET, "y": exit_node["y"]}
    edges[exit_id].append({"dir": "straight", "to": "EXIT_ROAD"})
    edges["EXIT_ROAD"] = []

    # --- Slot nodes are terminal (no outgoing edges) ---
    for nid, node in nodes.items():
        if node["type"] == "slot" and nid not in edges:
            edges[nid] = []

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
        "nodes": nodes,
        "edges": edges,
    }

    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(script_dir)
    out_path = os.path.join(project_root, "shared", "lot.json")
    with open(out_path, "w") as f:
        json.dump(lot, f, indent=2)

    slot_count = sum(1 for n in nodes.values() if n["type"] == "slot")
    junction_count = sum(1 for n in nodes.values() if n["type"] == "junction")
    turn_count = sum(1 for n in nodes.values() if n["type"] == "turn")
    ramp_count = sum(1 for n in nodes.values() if "ramp" in n["type"])
    approach_count = sum(1 for n in nodes.values() if n["type"] == "approach")
    print(f"Generated {out_path}")
    print(f"  Floors: {FLOORS}")
    print(f"  Aisles/floor: {AISLES_PER_FLOOR}")
    print(f"  Junctions: {junction_count}")
    print(f"  Turns: {turn_count}")
    print(f"  Slots: {slot_count}")
    print(f"  Ramp nodes: {ramp_count}")
    print(f"  Approach roads: {approach_count}")
    print(f"  Total nodes: {len(nodes)}")


if __name__ == "__main__":
    main()

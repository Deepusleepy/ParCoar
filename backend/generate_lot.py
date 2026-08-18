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
JUNCTION_SPACING = 10   # x-distance between junctions along an aisle
AISLE_SPACING = 14      # y-distance between aisles
SLOT_OFFSET = 4.5       # y-distance from aisle center to slot
SLOT_SIZES = ["small", "medium", "large"]
FLOOR_HEIGHT = 15       # z-distance between floors (used by frontend only)


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
                    slot_global = aisle * JUNCTIONS_PER_AISLE * SLOTS_PER_JUNCTION + j_idx * SLOTS_PER_JUNCTION + s_pos + 1
                    sid = f"S{f}_{slot_global}"
                    sy = y + (-SLOT_OFFSET if s_pos == 0 else SLOT_OFFSET)
                    size = random.choice(SLOT_SIZES)
                    nodes[sid] = {"type": "slot", "floor": f, "x": jx, "y": sy, "size": size}

            # --- Chain: previous node → first junction of this aisle ---
            first_j = junction_ids[0]
            # Determine direction from prev_node to first_j
            if going_right:
                chain_dir = "straight"
            else:
                chain_dir = "left" if aisle == 1 else "right"  # alternate turn direction
            # Actually, the turn direction depends on the geometry.
            # Going right on aisle 0, then turn to go left on aisle 1: that's a right-curving U-turn
            # Going left on aisle 1, then turn to go right on aisle 2: that's a left-curving U-turn
            # Simplify: use "straight" for entry-to-first, and "turn" for inter-aisle connections
            chain_dir = "straight" if aisle == 0 else "straight"  # turns are handled by turn nodes

            if prev_node not in edges:
                edges[prev_node] = []
            edges[prev_node].append({"dir": chain_dir, "to": first_j})

            # --- Edges along the aisle: each junction → its slots + next junction ---
            for j_idx, jid in enumerate(junction_ids):
                edge_list = []
                # Slots
                slot_global_base = aisle * JUNCTIONS_PER_AISLE * SLOTS_PER_JUNCTION + j_idx * SLOTS_PER_JUNCTION
                left_slot = f"S{f}_{slot_global_base + 1}"
                right_slot = f"S{f}_{slot_global_base + 2}"
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

        # Ramp-in node for upper floors needs to chain to first aisle
        if floor > 0:
            # The ramp_in node was created at the top; its edges will be set
            # when the first aisle chains from it (prev_node starts as entry_id = ramp_in)
            pass

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
    print(f"Generated {out_path}")
    print(f"  Floors: {FLOORS}")
    print(f"  Aisles/floor: {AISLES_PER_FLOOR}")
    print(f"  Junctions: {junction_count}")
    print(f"  Turns: {turn_count}")
    print(f"  Slots: {slot_count}")
    print(f"  Ramp nodes: {ramp_count}")
    print(f"  Total nodes: {len(nodes)}")


if __name__ == "__main__":
    main()

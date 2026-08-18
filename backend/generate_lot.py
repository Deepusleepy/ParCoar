"""
Lot layout generator for the ParCoar parking guidance system.

This script produces shared/lot.json — a description of a 3-floor parking lot
with one-way aisles, ramps between floors, and slots of varying sizes.

Run:  python backend/generate_lot.py
Output: shared/lot.json

Layout per floor:
  Entry/Ramp-in -> J1 -> J2 -> J3 -> J4 -> J5 -> J6 -> J7 -> J8 -> Ramp-up/End
                   |     |     |     |     |     |     |     |
                  S_L   S_L   S_L   S_L   S_L   S_L   S_L   S_L
                  S_R   S_R   S_R   S_R   S_R   S_R   S_R   S_R

  8 junctions x 2 slots = 16 slots per floor x 3 floors = 48 slots total.
  Each aisle is one-way (left-to-right in the diagram).
  Ramps connect the end of one floor to the start of the next.
"""

import json
import os
import random

FLOORS = 3
JUNCTIONS_PER_FLOOR = 8
SLOTS_PER_JUNCTION = 2  # left + right
JUNCTION_SPACING = 8    # x-distance between junctions
SLOT_OFFSET = 4         # y-distance from aisle to slot
SLOT_SIZES = ["small", "medium", "large"]


def main():
    random.seed(42)  # reproducible layout

    nodes = {}
    edges = {}

    for floor in range(FLOORS):
        f = floor  # floor index 0, 1, 2

        # --- Entry point for this floor ---
        if floor == 0:
            entry_id = "E0"
            nodes[entry_id] = {"type": "entry", "floor": f, "x": 0, "y": 0}
        else:
            entry_id = f"R{f}_in"
            nodes[entry_id] = {"type": "ramp_in", "floor": f, "x": 0, "y": 0}

        # --- Junctions along the aisle ---
        junction_ids = []
        for j in range(1, JUNCTIONS_PER_FLOOR + 1):
            jid = f"J{f}_{j}"
            jx = j * JUNCTION_SPACING
            nodes[jid] = {"type": "junction", "floor": f, "x": jx, "y": 0}
            junction_ids.append(jid)

        # --- Slots branching off each junction ---
        for j_idx, jid in enumerate(junction_ids):
            jx = nodes[jid]["x"]
            for s_pos in range(SLOTS_PER_JUNCTION):
                slot_num = j_idx * SLOTS_PER_JUNCTION + s_pos + 1
                sid = f"S{f}_{slot_num}"
                # left slot (negative y) or right slot (positive y)
                sy = -SLOT_OFFSET if s_pos == 0 else SLOT_OFFSET
                size = random.choice(SLOT_SIZES)
                nodes[sid] = {"type": "slot", "floor": f, "x": jx, "y": sy, "size": size}

        # --- Edges: entry -> first junction ---
        first_j = junction_ids[0]
        edges[entry_id] = [{"dir": "straight", "to": first_j}]

        # --- Edges: each junction -> its slots + next junction ---
        for j_idx, jid in enumerate(junction_ids):
            edge_list = []
            # left slot
            left_slot_num = j_idx * SLOTS_PER_JUNCTION + 1
            edge_list.append({"dir": "left", "to": f"S{f}_{left_slot_num}"})
            # right slot
            right_slot_num = j_idx * SLOTS_PER_JUNCTION + 2
            edge_list.append({"dir": "right", "to": f"S{f}_{right_slot_num}"})
            # straight to next junction, ramp, or end
            if j_idx < len(junction_ids) - 1:
                next_j = junction_ids[j_idx + 1]
                edge_list.append({"dir": "straight", "to": next_j})
            else:
                # last junction on this floor
                if floor < FLOORS - 1:
                    # connect to ramp up
                    ramp_id = f"R{f}_up"
                    edge_list.append({"dir": "up", "to": ramp_id})
                else:
                    # top floor: connect to exit
                    edge_list.append({"dir": "straight", "to": f"EXIT{f}"})
            edges[jid] = edge_list

        # --- Ramp edges (connect end of this floor to start of next) ---
        if floor < FLOORS - 1:
            ramp_up_id = f"R{f}_up"
            next_floor = floor + 1
            ramp_in_id = f"R{next_floor}_in"
            # Place ramp node at the end of this floor
            ramp_x = (JUNCTIONS_PER_FLOOR + 1) * JUNCTION_SPACING
            nodes[ramp_up_id] = {"type": "ramp_up", "floor": f, "x": ramp_x, "y": 0}
            # Ramp edge: ramp_up -> ramp_in of next floor
            edges[ramp_up_id] = [{"dir": "up", "to": ramp_in_id}]

        # --- Exit on top floor ---
        if floor == FLOORS - 1:
            exit_id = f"EXIT{f}"
            exit_x = (JUNCTIONS_PER_FLOOR + 1) * JUNCTION_SPACING
            nodes[exit_id] = {"type": "exit", "floor": f, "x": exit_x, "y": 0}
            edges[exit_id] = []  # dead end

    # --- Slot edges: slots are terminal (car parks there, no outgoing edges) ---
    for nid, node in nodes.items():
        if node["type"] == "slot" and nid not in edges:
            edges[nid] = []

    lot = {"nodes": nodes, "edges": edges}

    # Write to shared/lot.json
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(script_dir)
    out_path = os.path.join(project_root, "shared", "lot.json")
    with open(out_path, "w") as f:
        json.dump(lot, f, indent=2)

    # Summary
    slot_count = sum(1 for n in nodes.values() if n["type"] == "slot")
    junction_count = sum(1 for n in nodes.values() if n["type"] == "junction")
    ramp_count = sum(1 for n in nodes.values() if "ramp" in n["type"])
    print(f"Generated {out_path}")
    print(f"  Floors: {FLOORS}")
    print(f"  Junctions: {junction_count}")
    print(f"  Slots: {slot_count}")
    print(f"  Ramp nodes: {ramp_count}")
    print(f"  Total nodes: {len(nodes)}")


if __name__ == "__main__":
    main()

import json
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
with open(os.path.join(ROOT, "shared", "lot.json")) as f:
    LOT = json.load(f)

sys.path.insert(0, os.path.join(ROOT, "backend"))
import server


class LotGraphTest(unittest.TestCase):
    def test_every_road_edge_has_a_reverse(self):
        nodes = LOT["nodes"]
        edges = LOT["edges"]
        for source, outgoing in edges.items():
            for edge in outgoing:
                target = edge["to"]
                if nodes[source]["type"] == "slot" or nodes[target]["type"] == "slot":
                    continue
                self.assertTrue(
                    any(reverse["to"] == source for reverse in edges[target]),
                    f"missing reverse edge for {source} -> {target}",
                )

    def test_turns_label_both_directions(self):
        nodes = LOT["nodes"]
        for turn_id, turn in nodes.items():
            if turn["type"] != "turn":
                continue
            aisle = int(turn_id.rsplit("_", 1)[1])
            expected = {"right", "left"}
            labels = {
                edge["dir"]
                for edge in LOT["edges"][turn_id]
                if nodes[edge["to"]]["type"] == "junction"
            }
            self.assertEqual(labels, expected, turn_id)
            next_aisle = aisle + 1
            next_edge = next(
                edge
                for edge in LOT["edges"][turn_id]
                if edge["to"].startswith(f"J{turn['floor']}_{next_aisle}_")
            )
            self.assertEqual(next_edge["dir"], "right" if aisle % 2 == 0 else "left")

    def test_bfs_never_uses_a_bay_as_a_shortcut(self):
        path = server.bfs("J0_0_1", "J0_0_3")
        self.assertIsNotNone(path)
        self.assertFalse(any(LOT["nodes"][node]["type"] == "slot" for node in path[1:-1]))

    def test_slot_assignment_reaches_all_floors(self):
        session = server.Session()
        for i in range(7):
            car = {
                "color": "blue",
                "plate": f"TEST-{i}",
                "size": "small",
                "node": "E0",
                "slot": None,
                "status": "routing",
                "leaving": False,
            }
            session.cars[str(i)] = car
            server.assign_slot(session, car)
        floors = {LOT["nodes"][car["slot"]]["floor"] for car in session.cars.values()}
        self.assertEqual(floors, {0, 1, 2})

    def test_departing_car_can_reach_the_exit(self):
        path = server.bfs("S0_1", server.EXIT_NODE)
        self.assertIsNotNone(path)
        self.assertEqual(path[-1], server.EXIT_NODE)
        self.assertFalse(any(LOT["nodes"][node]["type"] == "slot" for node in path[1:-1]))


if __name__ == "__main__":
    unittest.main()

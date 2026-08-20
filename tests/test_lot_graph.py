import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))
import server
from generate_lot import build_lot

LOT = build_lot()


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
            labels = {
                edge["dir"]
                for edge in LOT["edges"][turn_id]
                if nodes[edge["to"]]["type"] == "junction"
            }
            self.assertEqual(labels, {"left", "right"}, turn_id)

    def test_all_bays_are_identical(self):
        slots = [node for node in LOT["nodes"].values() if node["type"] == "slot"]
        self.assertEqual(len(slots), 480)
        self.assertTrue(all("size" not in node for node in slots))

    def test_every_edge_has_a_positive_cost(self):
        for source, outgoing in LOT["edges"].items():
            for edge in outgoing:
                self.assertGreater(edge.get("cost", 0), 0, f"{source} -> {edge['to']}")

    def test_ramp_cost_reflects_its_real_length(self):
        aisle = next(edge for edge in LOT["edges"]["J0_0_1"] if edge["to"] == "J0_0_2")
        ramp = next(edge for edge in LOT["edges"]["R0_up"] if edge["to"] == "R1_in")
        self.assertGreater(ramp["cost"], aisle["cost"] * 30)

    def test_shortest_path_never_uses_a_bay_as_a_shortcut(self):
        result = server.shortest_path("J0_0_1", "J0_0_3")
        self.assertIsNotNone(result)
        path, _ = result
        self.assertFalse(any(LOT["nodes"][node]["type"] == "slot" for node in path[1:-1]))

    def test_departing_car_can_reach_the_exit(self):
        result = server.shortest_path("S0_1", server.EXIT_NODE)
        self.assertIsNotNone(result)
        path, distance = result
        self.assertEqual(path[-1], server.EXIT_NODE)
        self.assertGreater(distance, 0)
        self.assertFalse(any(LOT["nodes"][node]["type"] == "slot" for node in path[1:-1]))

    def test_slot_choice_uses_distance_not_hop_count(self):
        # From J0_0_12, S0_41 is one hop closer in the graph but requires a
        # long turn. S0_1 is the genuinely shorter drive.
        session = server.Session()
        session.occupied = server.all_slots - {"S0_41", "S0_1"}
        result = server.nearest_free_slot(session, "J0_0_12", "test-car")
        self.assertIsNotNone(result)
        slot, _, distance = result
        self.assertEqual(slot, "S0_1")
        self.assertAlmostEqual(distance, 34.6, places=2)


if __name__ == "__main__":
    unittest.main()

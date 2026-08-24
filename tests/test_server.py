import heapq
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))
import server
from generate_lot import build_lot

LOT = build_lot()


def car(car_id, **overrides):
    payload = {
        "id": car_id,
        "color": "red",
        "plate": f"P-{car_id}",
        "node": "E0",
        "leaving": False,
        "assigned_slot": None,
    }
    payload.update(overrides)
    return payload


def message(cars, occupied_slots=None):
    return {
        "type": "state",
        "cars": cars,
        "occupied_slots": occupied_slots or [],
    }


def edge_direction(source, target):
    """Return the turn label on the lot edge from source towards target."""
    for edge in server.edges[source]:
        if edge["to"] == target:
            return edge["dir"]
    return None


def reference_shortest_distance(start, goal):
    """Independent Dijkstra over lot costs; bays are never shortcuts."""
    distances = {start: 0.0}
    queue = [(0.0, start)]
    while queue:
        distance, current = heapq.heappop(queue)
        if distance != distances.get(current):
            continue
        if current == goal:
            return distance
        for edge in LOT["edges"].get(current, []):
            neighbour = edge["to"]
            if LOT["nodes"][neighbour]["type"] == "slot" and neighbour != goal:
                continue
            candidate = distance + float(edge["cost"])
            if candidate < distances.get(neighbour, float("inf")):
                distances[neighbour] = candidate
                heapq.heappush(queue, (candidate, neighbour))
    return None


def find_tied_free_slots():
    """Return (junction, [slot_a, slot_b], distance) for any equidistant bays."""
    junctions = sorted(
        node_id for node_id, node in server.nodes.items()
        if node["type"] == "junction"
    )
    for start in junctions:
        road_distance = {start: 0.0}
        queue = [(0.0, start)]
        while queue:
            distance, current = heapq.heappop(queue)
            if distance != road_distance.get(current):
                continue
            for edge in server.edges.get(current, []):
                neighbour = edge["to"]
                if server.nodes[neighbour]["type"] == "slot":
                    continue
                candidate = distance + float(edge["cost"])
                if candidate < road_distance.get(neighbour, float("inf")):
                    road_distance[neighbour] = candidate
                    heapq.heappush(queue, (candidate, neighbour))

        buckets: dict[float, set[str]] = {}
        for junction_id, distance in road_distance.items():
            for edge in server.edges[junction_id]:
                if server.nodes[edge["to"]]["type"] == "slot":
                    buckets.setdefault(round(distance + float(edge["cost"]), 6), set()).add(edge["to"])
        for tie_distance, slots in buckets.items():
            if len(slots) >= 2:
                return start, sorted(slots)[:2], tie_distance
    raise AssertionError("no equidistant bay pair exists in the generated lot")


def park_car():
    """Drive one car through appear -> parked; return (session, routing sign, parked sign)."""
    session = server.Session()
    routing = server.handle_message(session, message([car("c1")]))["signs"][0]
    parked = server.handle_message(
        session,
        message([car("c1", node=routing["slot"])]),
    )["signs"][0]
    return session, routing, parked


class AssignmentTest(unittest.TestCase):
    def test_new_car_gets_a_bay_without_a_size_field(self):
        session = server.Session()
        reply = server.handle_message(session, message([car("c1")]))
        sign = reply["signs"][0]
        self.assertEqual(sign["status"], "routing")
        self.assertIsNotNone(sign["slot"])
        self.assertEqual(sign["destination_type"], "bay")
        self.assertGreater(sign["route_distance"], 0)

    def test_reservations_prevent_duplicate_assignments(self):
        session = server.Session()
        reply = server.handle_message(session, message([car("c1"), car("c2")]))
        slots = [sign["slot"] for sign in reply["signs"]]
        self.assertEqual(len(slots), len(set(slots)))
        self.assertEqual(len(session.reservations), 2)

    def test_reconnect_restores_the_existing_assignment(self):
        first = server.Session()
        first_reply = server.handle_message(first, message([car("c1")]))
        assigned = first_reply["signs"][0]["slot"]

        reconnected = server.Session()
        second_reply = server.handle_message(
            reconnected,
            message([car("c1", node="J0_0_2", assigned_slot=assigned)]),
        )
        self.assertEqual(second_reply["signs"][0]["slot"], assigned)
        self.assertEqual(reconnected.reservations["c1"], assigned)

    def test_sensor_conflict_reassigns_a_reserved_bay(self):
        session = server.Session()
        first = server.handle_message(session, message([car("c1")]))
        old_slot = first["signs"][0]["slot"]
        second = server.handle_message(
            session,
            message([car("c1", assigned_slot=old_slot)], occupied_slots=[old_slot]),
        )
        self.assertNotEqual(second["signs"][0]["slot"], old_slot)

    def test_all_bays_occupied_returns_no_slot(self):
        session = server.Session()
        reply = server.handle_message(
            session,
            message([car("c1")], occupied_slots=sorted(server.all_slots)),
        )
        sign = reply["signs"][0]
        self.assertEqual(sign["status"], "no_slot")
        self.assertIsNone(sign["slot"])
        self.assertIsNone(sign["destination"])

    def test_stale_car_releases_its_reservation(self):
        session = server.Session()
        server.handle_message(session, message([car("c1")]))
        self.assertIn("c1", session.reservations)
        server.handle_message(session, message([]))
        self.assertNotIn("c1", session.reservations)
        self.assertNotIn("c1", session.cars)


class DepartureTest(unittest.TestCase):
    def test_leaving_car_routes_to_exit_without_overloading_slot(self):
        session = server.Session()
        reply = server.handle_message(session, message([car("c1", leaving=True)]))
        sign = reply["signs"][0]
        self.assertEqual(sign["destination"], server.EXIT_NODE)
        self.assertEqual(sign["destination_type"], "exit")
        self.assertIsNone(sign["slot"])

    def test_parked_car_leaving_routes_to_the_exit(self):
        session, _, parked = park_car()
        slot = parked["slot"]

        reply = server.handle_message(
            session,
            message([car("c1", node=slot, leaving=True)]),
        )
        sign = reply["signs"][0]
        self.assertEqual(sign["destination"], server.EXIT_NODE)
        self.assertEqual(sign["destination_type"], "exit")
        self.assertIsNone(sign["slot"])
        self.assertNotIn("c1", session.reservations)

        final = server.handle_message(
            session,
            message([car("c1", node=server.EXIT_NODE, leaving=True)]),
        )["signs"][0]
        self.assertEqual(final["status"], "left")
        self.assertEqual(final["direction"], "arrived")
        self.assertEqual(final["path"], [server.EXIT_NODE])
        self.assertIsNone(final["slot"])
        self.assertNotIn(server.EXIT_NODE, session.occupied)


class FailureStatusTest(unittest.TestCase):
    def test_unreachable_target_is_no_path_not_arrived(self):
        session = server.Session()
        tracked = {
            "id": "c1",
            "color": "red",
            "plate": "P-c1",
            "node": "E0",
            "slot": "S0_1",
            "status": "routing",
            "leaving": False,
        }
        session.cars["c1"] = tracked
        session.reservations["c1"] = "S0_1"

        original_edges = server.edges
        try:
            server.edges = {"E0": []}
            reply = server.handle_message(
                session,
                message([car("c1", assigned_slot="S0_1")]),
            )
        finally:
            server.edges = original_edges

        sign = reply["signs"][0]
        self.assertEqual(sign["status"], "no_path")
        self.assertIsNone(sign["direction"])
        self.assertEqual(sign["path"], ["E0"])


class ShortestPathOptimalityTest(unittest.TestCase):
    def test_entry_to_exit_matches_reference_dijkstra_distance(self):
        result = server.shortest_path("E0", server.EXIT_NODE)
        self.assertIsNotNone(result)
        path, distance = result
        self.assertGreater(len(path), 2)
        self.assertEqual(path[0], "E0")
        self.assertEqual(path[-1], server.EXIT_NODE)

        expected = reference_shortest_distance("E0", server.EXIT_NODE)
        self.assertIsNotNone(expected)
        self.assertAlmostEqual(distance, expected, places=6)


class NearestFreeSlotTest(unittest.TestCase):
    def test_equidistant_bays_resolve_identically_on_repeat_calls(self):
        start, tied_slots, tie_distance = find_tied_free_slots()
        session = server.Session()

        first = server.nearest_free_slot(session, start, "tie-car")
        second = server.nearest_free_slot(session, start, "tie-car")

        self.assertIsNotNone(first)
        slot, path, distance = first
        self.assertIn(slot, tied_slots)
        self.assertNotEqual(tied_slots[0], tied_slots[1])
        self.assertEqual(path[0], start)
        self.assertEqual(path[-1], slot)
        self.assertAlmostEqual(distance, tie_distance, places=6)
        self.assertEqual(first, second)

    def test_reserved_and_occupied_bay_is_skipped_even_when_closer(self):
        # From J0_0_12 the two closest bays are S0_12 and S0_32 (both 6.0).
        # S0_12 is reserved by another car but NOT sensor-occupied, so it
        # tests the reservation-skip path in isolation. S0_32 is sensor-
        # occupied but NOT reserved, so it tests the occupied-skip path in
        # isolation. The next best bay (S0_11 or S0_13, 8.6) must win.
        session = server.Session()
        session.occupied = {"S0_32"}
        session.reservations["other-car"] = "S0_12"

        result = server.nearest_free_slot(session, "J0_0_12", "blocked-car")

        self.assertIsNotNone(result)
        slot, _, distance = result
        self.assertNotIn(slot, {"S0_12", "S0_32"})
        self.assertGreater(distance, 6.0)


class LifecyclePayloadTest(unittest.TestCase):
    def test_full_lifecycle_payload_fields(self):
        session, routing, parked = park_car()
        slot = routing["slot"]

        expected_keys = {
            "car_id", "color", "plate", "node", "direction",
            "destination", "destination_type", "destination_floor",
            "slot", "status", "next_node", "next_direction",
            "path", "route_distance", "estimated_seconds",
        }
        self.assertEqual(set(routing), expected_keys)
        self.assertEqual(set(parked), expected_keys)

        self.assertEqual(routing["car_id"], "c1")
        self.assertEqual(routing["color"], "red")
        self.assertEqual(routing["plate"], "P-c1")
        self.assertEqual(routing["node"], "E0")
        self.assertEqual(routing["status"], "routing")
        self.assertEqual(routing["slot"], slot)
        self.assertEqual(routing["destination"], slot)
        self.assertEqual(routing["destination_type"], "bay")
        self.assertEqual(routing["destination_floor"], server.nodes[slot]["floor"])
        path = routing["path"]
        self.assertGreater(len(path), 2)
        self.assertEqual(path[0], "E0")
        self.assertEqual(path[-1], slot)
        self.assertNotEqual(routing["direction"], "arrived")
        self.assertEqual(routing["direction"], edge_direction(path[0], path[1]))
        self.assertEqual(routing["next_node"], path[1])
        self.assertEqual(routing["next_direction"], edge_direction(path[1], path[2]))
        reference = server.shortest_path("E0", slot)
        self.assertEqual(routing["route_distance"], round(reference[1], 3))
        self.assertGreater(routing["route_distance"], 0)
        self.assertEqual(
            routing["estimated_seconds"],
            round(routing["route_distance"] / 7.0, 1),
        )

        self.assertEqual(parked["node"], slot)
        self.assertEqual(parked["status"], "parked")
        self.assertEqual(parked["direction"], "arrived")
        self.assertEqual(parked["path"], [slot])
        self.assertEqual(parked["destination"], slot)
        self.assertEqual(parked["destination_type"], "bay")
        self.assertIsNone(parked["next_node"])
        self.assertIsNone(parked["next_direction"])
        self.assertEqual(parked["route_distance"], 0.0)
        self.assertEqual(parked["estimated_seconds"], 0.0)

    def test_parking_marks_the_bay_occupied_and_releases_the_reservation(self):
        session, _, parked = park_car()
        slot = parked["slot"]
        self.assertIn(slot, session.occupied)
        self.assertNotIn("c1", session.reservations)
        self.assertEqual(session.reservations, {})


class PurgeTest(unittest.TestCase):
    def test_missing_car_is_removed_while_reported_cars_remain(self):
        session = server.Session()
        server.handle_message(session, message([car("c1"), car("c2")]))
        self.assertEqual(len(session.cars), 2)

        server.handle_message(session, message([car("c2")]))

        self.assertNotIn("c1", session.cars)
        self.assertNotIn("c1", session.reservations)
        self.assertIn("c2", session.cars)
        self.assertIn("c2", session.reservations)


class UnknownNodeTest(unittest.TestCase):
    def test_unknown_node_on_new_car_raises_value_error(self):
        session = server.Session()
        with self.assertRaises(ValueError):
            server.handle_message(session, message([car("c1", node="NOWHERE")]))

    def test_unknown_node_on_tracked_car_raises_value_error(self):
        session = server.Session()
        server.handle_message(session, message([car("c1")]))
        with self.assertRaises(ValueError):
            server.handle_message(session, message([car("c1", node="NOWHERE")]))


class ReconnectAdoptionConflictTest(unittest.TestCase):
    def test_conflicted_adoption_falls_back_to_a_fresh_assignment(self):
        session = server.Session()
        first = server.handle_message(session, message([car("c2")]))
        taken = first["signs"][0]["slot"]

        reply = server.handle_message(
            session,
            message([car("c2"), car("c1", assigned_slot=taken)]),
        )
        signs = {sign["car_id"]: sign for sign in reply["signs"]}
        self.assertEqual(signs["c2"]["slot"], taken)
        self.assertIsNotNone(signs["c1"]["slot"])
        self.assertNotEqual(signs["c1"]["slot"], taken)
        self.assertEqual(session.reservations["c2"], taken)
        self.assertEqual(session.reservations["c1"], signs["c1"]["slot"])


class TestAdjustDistanceForPos(unittest.TestCase):
    """Tests that adjust_distance_for_pos computes the remaining route
    distance from the player's live position, not the stale reported node."""

    def setUp(self):
        server.nodes = LOT["nodes"]
        server.edges = LOT["edges"]
        server.all_slots = {
            nid for nid, n in server.nodes.items() if n["type"] == "slot"
        }
        server.EXIT_NODE = next(
            nid for nid, n in server.nodes.items() if n["type"] == "exit"
        )

    def test_returns_original_distance_when_pos_is_none(self):
        result = server.shortest_path("E0", "J0_0_5")
        self.assertIsNotNone(result)
        path, dist = result
        self.assertEqual(server.adjust_distance_for_pos(None, path, dist), dist)

    def test_returns_original_distance_for_short_path(self):
        result = server.shortest_path("E0", "J0_0_1")
        self.assertIsNotNone(result)
        path, dist = result
        # Path has only 2 nodes; adjust should still return something sensible.
        adjusted = server.adjust_distance_for_pos(
            {"x": 1.0, "z": 0.0, "floor": 0}, path, dist
        )
        # Player at x=1 is between E0(0) and J0_0_1(2.6), so distance to
        # J0_0_1 should be ~1.6.
        self.assertAlmostEqual(adjusted, 1.6, places=1)

    def test_distance_decreases_as_player_drives_forward(self):
        """The distance should decrease as the player moves toward the slot."""
        session = server.Session()
        # Spawn the player at E0
        msg = message([car("P0", pos={"x": 0, "z": 0, "floor": 0})])
        reply = server.handle_message(session, msg)
        instr = reply["signs"][0]
        slot = instr["slot"]
        initial_dist = instr["route_distance"]

        # Drive 5 units forward along x
        msg2 = message([car("P0", assigned_slot=slot, pos={"x": 5, "z": 0, "floor": 0})])
        reply2 = server.handle_message(session, msg2)
        dist_after_5 = reply2["signs"][0]["route_distance"]

        # Drive 10 units forward
        msg3 = message([car("P0", assigned_slot=slot, pos={"x": 10, "z": 0, "floor": 0})])
        reply3 = server.handle_message(session, msg3)
        dist_after_10 = reply3["signs"][0]["route_distance"]

        # Distance should decrease as the player drives toward the slot.
        # (It might not be strictly monotonic if the path turns, but for
        # a slot near the entry on the same aisle, it should decrease.)
        self.assertLess(dist_after_5, initial_dist + 1,
                        f"Distance after 5m ({dist_after_5}) should be less than "
                        f"initial ({initial_dist}) + tolerance")

    def test_distance_without_pos_is_stale(self):
        """Without pos, the distance should be the full path distance
        from the stale node, not adjusted."""
        session = server.Session()
        msg = message([car("P0")])  # no pos field
        reply = server.handle_message(session, msg)
        instr = reply["signs"][0]
        slot = instr["slot"]
        stale_dist = instr["route_distance"]

        # Send again without pos — distance should be the same (stale)
        msg2 = message([car("P0", assigned_slot=slot)])
        reply2 = server.handle_message(session, msg2)
        stale_dist2 = reply2["signs"][0]["route_distance"]

        self.assertEqual(stale_dist, stale_dist2,
                         "Without pos, distance should be stale (same every reply)")


class TestParkingOverlapPrevention(unittest.TestCase):
    """Tests that a car arriving at a slot that is physically occupied by
    a pre-parked car is reassigned instead of parking on top of it."""

    def setUp(self):
        server.nodes = LOT["nodes"]
        server.edges = LOT["edges"]
        server.all_slots = {
            nid for nid, n in server.nodes.items() if n["type"] == "slot"
        }
        server.EXIT_NODE = next(
            nid for nid, n in server.nodes.items() if n["type"] == "exit"
        )

    def test_car_arriving_at_occupied_slot_is_reassigned(self):
        session = server.Session()
        # First message: no occupied slots, car gets assigned a slot
        reply = server.handle_message(session, message([car("c1")]))
        slot = reply["signs"][0]["slot"]
        self.assertIsNotNone(slot)

        # Simulate the car arriving at the slot, but the slot is now
        # physically occupied by a pre-parked car (reported in
        # occupied_slots).
        reply2 = server.handle_message(
            session,
            message([car("c1", node=slot, assigned_slot=slot)], occupied_slots=[slot]),
        )
        instr = reply2["signs"][0]
        # The car should NOT be parked — it should be reassigned and routing
        self.assertNotEqual(instr["status"], "parked",
                            "Car should be reassigned, not parked on top of occupant")
        self.assertEqual(instr["status"], "routing")
        # The new slot should be different from the occupied one
        self.assertNotEqual(instr["slot"], slot,
                            "Car should be assigned a different slot")

    def test_already_parked_car_is_not_reassigned(self):
        """A car that was already parked at a slot should not be
        reassigned when the slot appears in occupied_slots (it owns it)."""
        session = server.Session()
        reply = server.handle_message(session, message([car("c1")]))
        slot = reply["signs"][0]["slot"]

        # Car arrives and parks (slot not in occupied_slots yet)
        reply2 = server.handle_message(
            session, message([car("c1", node=slot, assigned_slot=slot)])
        )
        self.assertEqual(reply2["signs"][0]["status"], "parked")

        # Next message: slot is now in occupied_slots (because the car
        # itself is parked there). The car should stay parked.
        reply3 = server.handle_message(
            session,
            message([car("c1", node=slot, assigned_slot=slot)], occupied_slots=[slot]),
        )
        self.assertEqual(reply3["signs"][0]["status"], "parked",
                         "Already-parked car should not be reassigned")


if __name__ == "__main__":
    unittest.main()

import json
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
with open(os.path.join(ROOT, "shared", "lot.json")) as f:
    LOT = json.load(f)

sys.path.insert(0, os.path.join(ROOT, "backend"))
import server


def _car(cid, **overrides):
    """A minimal valid state-message car, with any field overridden."""
    base = {"id": cid, "color": "red", "plate": "P-" + cid, "size": "small",
            "node": "E0", "leaving": False}
    base.update(overrides)
    return base


def _msg(cars, occupied_slots=None):
    return {"cars": cars, "occupied_slots": occupied_slots or []}


class StopLeavingGetsBayTest(unittest.TestCase):
    """Fix 1: a tracked car that stops leaving must be re-assigned a bay.

    Before the fix, a car reported with leaving:true kept slot=None, and when
    the same id came back with leaving:false the reply crashed looking up
    nodes[None]['floor']. The new branch in handle_message calls assign_slot
    when a tracked car stops leaving and has no bay.
    """

    def test_car_that_stops_leaving_gets_a_slot(self):
        session = server.Session()
        # First tick: the car is leaving, so it routes to the exit and has no bay.
        reply = server.handle_message(session, _msg([_car("c1", leaving=True)]))
        sign = reply["signs"][0]
        self.assertEqual(sign["status"], "routing")
        # A leaving car's "slot" is the exit node, not a real bay.
        self.assertEqual(sign["slot"], server.EXIT_NODE)

        # Second tick: same car id, now not leaving. This used to crash.
        reply = server.handle_message(session, _msg([_car("c1", leaving=False)]))
        sign = reply["signs"][0]
        self.assertIsNotNone(sign["slot"])
        self.assertIsNotNone(sign["slot_floor"])
        self.assertNotEqual(sign["status"], "no_slot")

    def test_brand_new_car_with_leaving_false_gets_a_bay(self):
        # The normal path is unchanged: a car we have never seen before, not
        # leaving, gets a bay on its first message.
        session = server.Session()
        reply = server.handle_message(session, _msg([_car("new")]))
        sign = reply["signs"][0]
        self.assertIsNotNone(sign["slot"])
        self.assertIsNotNone(sign["slot_floor"])
        self.assertEqual(sign["status"], "routing")

    def test_no_slot_car_is_not_assigned_a_bay_by_the_new_branch(self):
        # The new branch only fires when status != "no_slot". A car that is
        # genuinely out of options must stay without a bay rather than be
        # handed one that does not exist.
        #
        # A large car only fits in large bays (SIZE_RANK large == 2). Occupy
        # every large bay in the garage so the car has nowhere to go.
        large_slots = [n for n, d in server.nodes.items()
                       if d["type"] == "slot" and d["size"] == "large"]
        session = server.Session()
        car = _car("big", size="large")
        # First tick: no free large bay, so the car is marked no_slot.
        reply = server.handle_message(session, _msg([car], occupied_slots=large_slots))
        sign = reply["signs"][0]
        self.assertEqual(sign["status"], "no_slot")
        self.assertIsNone(sign["slot"])
        self.assertIsNone(sign["slot_floor"])

        # Second tick: same car, still not leaving, still no_slot. The new
        # branch must NOT try to assign it a bay, and the reply must not raise.
        reply = server.handle_message(session, _msg([car], occupied_slots=large_slots))
        sign = reply["signs"][0]
        self.assertEqual(sign["status"], "no_slot")
        self.assertIsNone(sign["slot"])
        self.assertIsNone(sign["slot_floor"])


class HandleMessageRobustnessTest(unittest.TestCase):
    """Fix 2: malformed frames used to close the connection.

    The handler loop now wraps handle_message in try/except, so one bad frame
    costs only that frame. These tests pin what handle_message itself does
    with two inputs a client could realistically send. Today it raises
    KeyError for both; the handler catches that and continues. If handle_message
    is ever made tolerant of these, update the assertion here.
    """

    def test_car_missing_a_required_key_raises_keyerror(self):
        # The new-car branch reads c["color"], c["plate"], c["size"], c["node"]
        # directly. A car dict missing one of those raises KeyError.
        # The handler catches this; see server.handler.
        session = server.Session()
        car = {"id": "c1", "plate": "P", "size": "small", "node": "E0",
               "leaving": False}  # missing "color"
        with self.assertRaises(KeyError):
            server.handle_message(session, _msg([car]))

    def test_car_with_invalid_size_raises_keyerror(self):
        # An unknown size blows up in nearest_free_slot at SIZE_RANK[car_size].
        # The handler catches this; see server.handler.
        session = server.Session()
        with self.assertRaises(KeyError):
            server.handle_message(session, _msg([_car("c1", size="huge")]))


class LoadSpreadingBoundaryTest(unittest.TestCase):
    """Pin the boundary of the load-spreading rule in nearest_free_slot.

    A reviewer found the rule can never fire at the shipped defaults, so this
    test documents the actual threshold behaviour so a future change to
    BUSY_FLOOR or the count logic is caught.

    nearest_free_slot counts cars with status "routing" and a non-null slot,
    per floor. A floor counts as busy at BUSY_FLOOR (3) routing cars. With
    fewer than that on the nearest floor, the nearest bay is returned; with
    BUSY_FLOOR or more, the search moves to another floor.
    """

    def test_load_spreading_boundary_at_busy_floor(self):
        # From E0 the nearest bays are on floor 0, so we drive floor 0's count.
        # Fewer than BUSY_FLOOR routing cars on floor 0: nearest bay returned.
        session = server.Session()
        for i in range(server.BUSY_FLOOR - 1):
            car = {"color": "blue", "plate": f"R{i}", "size": "small",
                   "node": "E0", "slot": None, "status": "routing", "leaving": False}
            session.cars[str(i)] = car
            server.assign_slot(session, car)
            self.assertEqual(server.nodes[car["slot"]]["floor"], 0)
        # floor 0 now has BUSY_FLOOR - 1 routing cars: still not busy.
        next_car = {"color": "red", "plate": "NEXT", "size": "small",
                    "node": "E0", "slot": None, "status": "routing", "leaving": False}
        session.cars["next"] = next_car
        server.assign_slot(session, next_car)
        self.assertEqual(server.nodes[next_car["slot"]]["floor"], 0)

        # BUSY_FLOOR routing cars on floor 0: now busy, search moves off floor 0.
        session = server.Session()
        for i in range(server.BUSY_FLOOR):
            car = {"color": "blue", "plate": f"R{i}", "size": "small",
                   "node": "E0", "slot": None, "status": "routing", "leaving": False}
            session.cars[str(i)] = car
            server.assign_slot(session, car)
            self.assertEqual(server.nodes[car["slot"]]["floor"], 0)
        next_car = {"color": "red", "plate": "NEXT", "size": "small",
                    "node": "E0", "slot": None, "status": "routing", "leaving": False}
        session.cars["next"] = next_car
        server.assign_slot(session, next_car)
        self.assertNotEqual(server.nodes[next_car["slot"]]["floor"], 0)


if __name__ == "__main__":
    unittest.main()

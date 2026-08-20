import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))
import server


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


if __name__ == "__main__":
    unittest.main()

"""Regression for FreeRouting's repeated SES wire on Net-(D4-A)."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))
from specctra import Rejected, ses_geometry, without_original_ses


def session(wires):
    return (
        '(session "board(test)" (routes (resolution um 10) (library_out) '
        '(network_out (net "Net-(D4-A)" ' + wires + "))))"
    )


class DuplicateSesTests(unittest.TestCase):
    def clean(self, text, originals=()):
        return without_original_ses(text, originals, {"top_layer", "bottom_layer"}, {"Net-(D4-A)"})

    def test_real_repeated_wire_retains_one_exact_segment(self):
        wire = "(wire (path top_layer 2000 1219519 -1210500 1221167 -1208852))"
        text = session(wire + wire)
        with self.assertRaises(Rejected) as error:
            ses_geometry(text, {"top_layer"}, {"Net-(D4-A)"})
        self.assertEqual(error.exception.code, "DUPLICATE_COPPER")
        clean, geometry = self.clean(text)
        self.assertEqual(
            geometry,
            [
                (
                    "track",
                    "Net-(D4-A)",
                    "top_layer",
                    200000,
                    (121951900, 121050000),
                    (122116700, 120885200),
                )
            ],
        )
        self.assertEqual(len(ses_geometry(clean, {"top_layer"}, {"Net-(D4-A)"})), 1)

    def test_shared_reversed_middle_segment_keeps_both_branches(self):
        text = session(
            "(wire (path top_layer 2000 10 0 20 0))"
            "(wire (path top_layer 2000 30 10 20 0 10 0 0 10) (type route))"
        )
        clean, geometry = self.clean(text)
        self.assertEqual(len(geometry), 3)
        self.assertIn(("track", "Net-(D4-A)", "top_layer", 200000, (0, -1000), (1000, 0)), geometry)
        self.assertIn(
            ("track", "Net-(D4-A)", "top_layer", 200000, (2000, 0), (3000, -1000)), geometry
        )
        self.assertEqual(clean.count("(type route)"), 2)
        self.assertEqual(self.clean(clean), (clean, geometry))

    def test_same_coordinates_on_other_layer_or_width_are_not_removed(self):
        text = session(
            "(wire (path top_layer 2000 10 0 20 0))"
            "(wire (path bottom_layer 2000 10 0 20 0))"
            "(wire (path top_layer 3000 10 0 20 0))"
        )
        clean, geometry = self.clean(text)
        self.assertEqual(clean, text)
        self.assertEqual(len(geometry), 3)

    def test_same_coordinates_on_another_net_are_not_removed(self):
        wire = "(wire (path top_layer 2000 10 0 20 0))"
        text = session(wire).replace("(network_out ", "(network_out (net GND " + wire + ") ")
        clean, geometry = without_original_ses(text, [], {"top_layer"}, {"Net-(D4-A)", "GND"})
        self.assertEqual(clean, text)
        self.assertEqual({item[1] for item in geometry}, {"Net-(D4-A)", "GND"})

    def test_repeated_through_via_is_created_once(self):
        library = "(padstack Via[0-1]_600:300_um (shape (circle top_layer 6000)) (shape (circle bottom_layer 6000)))"
        text = session("(via Via[0-1]_600:300_um 10 -20)" * 2).replace(
            "(library_out)", "(library_out " + library + ")"
        )
        clean, geometry = self.clean(text)
        self.assertEqual(geometry, [("via", "Net-(D4-A)", 1000, 2000, 600000, 300000)])
        self.assertEqual(clean.count("(via "), 1)

    def test_repeated_original_echo_is_removed_without_deleting_new_copper(self):
        old = ("track", "Net-(D4-A)", "top_layer", 200000, (1000, 0), (2000, 0))
        text = session(
            "(wire (path top_layer 2000 10 0 20 0))" * 2 + "(wire (path top_layer 2000 20 0 30 10))"
        )
        clean, geometry = self.clean(text, [old])
        self.assertEqual(len(geometry), 1)
        self.assertNotIn(old, geometry)

    def test_mixed_original_and_new_path_still_rejects(self):
        old = ("track", "Net-(D4-A)", "top_layer", 200000, (1000, 0), (2000, 0))
        with self.assertRaises(Rejected) as error:
            self.clean(session("(wire (path top_layer 2000 10 0 20 0 30 10))"), [old])
        self.assertEqual(error.exception.code, "ORIGINAL_COPPER_AMBIGUOUS")

    def test_exact_point_copper_retains_width_and_can_remove_only_its_original_echo(self):
        wire = "(wire (path top_layer 2000 10 0 10 0))"
        original = ("track", "Net-(D4-A)", "top_layer", 200000, (1000, 0), (1000, 0))
        clean, geometry = self.clean(session(wire + wire))
        self.assertEqual(geometry, [original])
        self.assertEqual(clean.count("(wire "), 1)
        clean, geometry = self.clean(session(wire), [original])
        self.assertEqual(geometry, [])
        self.assertNotIn("(wire ", clean)

    def test_point_copper_inside_a_longer_path_still_rejects(self):
        with self.assertRaises(Rejected) as error:
            self.clean(session("(wire (path top_layer 2000 10 0 10 0 20 0))"))
        self.assertEqual(error.exception.code, "INVALID_SES")


if __name__ == "__main__":
    unittest.main()

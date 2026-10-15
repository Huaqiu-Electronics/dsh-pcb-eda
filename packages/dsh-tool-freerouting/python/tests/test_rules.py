import sys
from pathlib import Path

sys.path[:0] = [str(Path(__file__).parents[1]), str(Path(__file__).parents[1] / "vendor")]
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from design_checks import validate_report
from ipc_context import fingerprint
from kipy.proto.common.types.project_settings_pb2 import NetClass
from rule_state import (
    check_board_minimums,
    check_custom_rules,
    netclass_state,
    reject_auto_teardrops,
    reject_diff_pairs,
)
from specctra import Rejected, without_original_ses


def rule():
    proto = NetClass(name="Default")
    proto.board.track_width.value_nm = 250000
    proto.board.clearance.value_nm = 200000
    proto.board.via_stack.copper_layers.add().size.x_nm = 600000
    proto.board.via_stack.drill.diameter.x_nm = 300000
    return SimpleNamespace(proto=proto)


class RuleTests(unittest.TestCase):
    def test_usb_pairs_with_branch_suffix_do_not_fall_back_to_ordinary_routing(self):
        pairs = [
            ("/USB_DP_C", "/USB_DM_C"),
            ("/USB_DP_C", "/USB_DN_C"),
            ("/sheet/USB2_DP_ESD", "/sheet/USB2_DM_ESD"),
            ("BUS_USB_DPLUS_C", "BUS_USB_DMINUS_C"),
            ("/USB_D+_C", "/USB_D-_C"),
            ("/usb_dp_c", "/usb_dm_c"),
        ]
        for positive, negative in pairs:
            with self.subTest(positive=positive, negative=negative):
                with self.assertRaises(Rejected) as error:
                    reject_diff_pairs(["GND", positive, negative])
                self.assertEqual(error.exception.code, "DIFF_PAIR_UNSUPPORTED")
                self.assertIn(positive, str(error.exception))
                self.assertIn(negative, str(error.exception))

    def test_usb_guard_does_not_pair_different_branches_or_sheets(self):
        for names in (
            ["/USB_DP_C", "/USB_DM"],
            ["/USB_DP_C", "/USB_DM_D"],
            ["/a/USB_DP_C", "/b/USB_DM_C"],
            ["/USB_DP_C", "GND", "/OSCIN"],
            ["/USB_DPOWER", "/USB_DMOWER"],
            ["/NOTUSB_DP_C", "/NOTUSB_DM_C"],
        ):
            with self.subTest(names=names):
                reject_diff_pairs(names)

    def test_gdf505_usb_guard_stops_before_snapshot_or_native_export(self):
        from tempfile import TemporaryDirectory

        from ipc_context import export

        state = {"routing": {"/USB_DP_C": [], "/USB_DM_C": []}}
        with TemporaryDirectory() as directory:
            live = SimpleNamespace(get_tracks=lambda: [])
            with (
                patch("ipc_context.connect", return_value=(None, live, "board.kicad_pcb")),
                patch(
                    "ipc_context.fingerprint",
                    return_value=("(kicad_pcb)", {".kicad_pro": b"{}"}, state, "digest"),
                ),
                patch("ipc_context.reject_auto_teardrops"),
                patch("ipc_context.pcbnew.LoadBoard") as load,
                patch("ipc_context.pcbnew.ExportSpecctraDSN") as native_export,
            ):
                with self.assertRaises(Rejected) as error:
                    export({"directory": directory})
            self.assertEqual(error.exception.code, "DIFF_PAIR_UNSUPPORTED")
            load.assert_not_called()
            native_export.assert_not_called()
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_export_rejects_enabled_teardrops_before_any_output_or_native_load(self):
        from tempfile import TemporaryDirectory

        from ipc_context import export

        with TemporaryDirectory() as directory:
            live = SimpleNamespace(get_tracks=lambda: [])
            snapshot = "(kicad_pcb (footprint (pad (teardrops (enabled yes)))))"
            with (
                patch("ipc_context.connect", return_value=(None, live, "board.kicad_pcb")),
                patch(
                    "ipc_context.fingerprint",
                    return_value=(snapshot, {".kicad_pro": b"{}"}, {"routing": {}}, "digest"),
                ),
                patch("ipc_context.pcbnew.LoadBoard") as load,
            ):
                with self.assertRaises(Rejected) as error:
                    export({"directory": directory})
            self.assertEqual(error.exception.code, "AUTO_TEARDROPS_UNSUPPORTED")
            load.assert_not_called()
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_enabled_editor_teardrops_are_rejected_before_routing(self):
        for owner in ("pad", "via"):
            with self.assertRaises(Rejected) as error:
                reject_auto_teardrops(
                    "(kicad_pcb (" + owner + " (teardrops (enabled yes))))", b"{}"
                )
            self.assertEqual(error.exception.code, "AUTO_TEARDROPS_UNSUPPORTED")

    def test_disabled_teardrops_and_quoted_text_do_not_reject_plain_board(self):
        reject_auto_teardrops(
            '(kicad_pcb (pad (teardrops (enabled no))) (gr_text "(teardrops (enabled yes))"))',
            b'{"board":{"design_settings":{"teardrop_options":['
            b'{"td_onvia":true,"td_onpthpad":true,"td_onsmdpad":true,"td_ontrackend":false}]}}}',
        )

    def test_project_automatic_track_end_teardrops_are_rejected(self):
        with self.assertRaises(Rejected) as error:
            reject_auto_teardrops(
                "(kicad_pcb)",
                b'{"board":{"design_settings":{"teardrop_options":[{"td_ontrackend":true}]}}}',
            )
        self.assertEqual(error.exception.code, "AUTO_TEARDROPS_UNSUPPORTED")

    def test_unknown_teardrop_options_fail_closed(self):
        for data in (
            b"{}",
            b"{",
            b'{"board":null}',
            b'{"board":{"design_settings":{"teardrop_options":[]}}}',
            b'{"board":{"design_settings":{"teardrop_options":[{"td_ontrackend":"false"}]}}}',
        ):
            with self.assertRaises(Rejected) as error:
                reject_auto_teardrops("(kicad_pcb)", data)
            self.assertEqual(error.exception.code, "PROJECT_RULES_UNVERIFIABLE")

    def test_mixer_board_minimum_conflicts_are_logged_without_blocking_or_rewriting(self):
        settings = SimpleNamespace(
            m_TrackMinWidth=300000,
            m_MinClearance=300000,
            m_ViasMinSize=1500000,
            m_MinThroughDrill=300000,
            m_ViasMinAnnularWidth=300000,
        )
        values = [200000, 200000, 600000, 300000]
        warnings = check_board_minimums(settings, {"GND": values})
        self.assertEqual(len(warnings), 4)
        self.assertTrue(all("网络 GND" in item and "继续布线" in item for item in warnings))
        self.assertIn("0.2 mm", warnings[0])
        self.assertIn("0.3 mm", warnings[0])
        self.assertEqual(values, [200000, 200000, 600000, 300000])
        self.assertEqual(settings.m_ViasMinSize, 1500000)
        compatible = [300000, 300000, 1500000, 300000]
        self.assertEqual(check_board_minimums(settings, {"GND": compatible}), [])
        for i in range(4):
            values = compatible.copy()
            values[i] -= 1
            self.assertEqual(len(check_board_minimums(settings, {"GND": values})), 1)
        settings.m_ViasMinAnnularWidth = 600001
        self.assertEqual(len(check_board_minimums(settings, {"GND": compatible})), 1)
        settings.m_TrackMinWidth = None
        with self.assertRaises(Rejected) as error:
            check_board_minimums(settings, {"GND": compatible})
        self.assertEqual(error.exception.code, "PROJECT_RULES_UNVERIFIABLE")

    def test_exact_ses_echo_is_removed_before_native_conversion(self):
        original = ("track", "GND", "F.Cu", 800000, (5000000, 10000000), (10000000, 10000000))
        text = '(session "a(via)" (routes (resolution um 10) (library_out) (network_out (net GND (wire (path F.Cu 8000 50000 -100000 100000 -100000)) (wire (path F.Cu 2000 100000 -100000 250000 -100000))))))'
        result, geometry = without_original_ses(text, [original], {"F.Cu", "B.Cu"}, {"GND"})
        self.assertIn('"a(via)"', result)
        self.assertNotIn("(path F.Cu 8000", result)
        self.assertEqual(len(geometry), 1)

    def test_all_physical_rule_types_are_reported_without_rejecting_valid_reports(self):
        violation = {"type": "clearance", "items": [{"uuid": "original", "pos": {"x": 1, "y": 2}}]}
        self.assertEqual(validate_report({"violations": [violation]}, {"new"})["count"], 0)
        violation["items"].append({"uuid": "new", "pos": {"x": 3, "y": 4}})
        for kind in (
            "clearance",
            "shorting_items",
            "track_width",
            "hole_clearance",
            "copper_edge_clearance",
            "future_rule",
        ):
            violation["type"] = kind
            result = validate_report({"coordinate_units": "mm", "violations": [violation]}, {"new"})
            self.assertEqual(result["count"], 1)
            self.assertEqual(result["violations"][0]["type"], kind)
            self.assertEqual(result["violations"][0]["items"][1]["x"], 3)
        validate_report(
            {"violations": [{"type": "via_dangling", "items": [{"uuid": "new"}]}]}, {"new"}
        )

    def test_unverifiable_rule_report_still_stops_import(self):
        for report in (
            {},
            {"violations": [None]},
            {"violations": [{"items": []}]},
            {
                "coordinate_units": "mm",
                "violations": [{"type": "clearance", "items": [{"uuid": "new"}]}],
            },
        ):
            with self.assertRaises(Rejected) as error:
                validate_report(report, {"new"})
            self.assertEqual(error.exception.code, "DESIGN_CHECK_PROTOCOL")

    def test_custom_rule_whitespace_cannot_bypass_preflight(self):
        for prefix in ("( rule", "(\nrule", "(\t rule"):
            data = (
                "(version 1)\n" + prefix + ' "width" (constraint track_width (min 2mm)))'
            ).encode()
            self.assertNotIn(b"(rule", data)  # Negative control: the former byte test accepted it.
            with self.assertRaises(Rejected) as error:
                check_custom_rules(data)
            self.assertEqual(error.exception.code, "CUSTOM_RULES_UNSUPPORTED")

    def test_rule_names_in_comments_do_not_reject_supported_empty_rule_file(self):
        check_custom_rules(b'# (rule "example")\n(version 1)')
        check_custom_rules(b"")

    def test_diff_pair_names_are_rejected_using_kicad_suffix_rules(self):
        for names in ({"USB_P", "USB_N"}, {"CLK+2", "CLK-2"}, {"TX_P_0", "TX_N_0"}):
            with self.assertRaises(Rejected) as error:
                reject_diff_pairs(names)
            self.assertEqual(error.exception.code, "DIFF_PAIR_UNSUPPORTED")
        reject_diff_pairs({"GND", "VCC", "unpaired_P"})

    def test_unsaved_diff_or_unused_class_change_changes_full_fingerprint(self):
        effective, unused = rule(), rule()
        board = SimpleNamespace(
            get_as_string=lambda: "(kicad_pcb (version 1))",
            get_nets=lambda: [],
            get_netclass_for_nets=lambda _: {"GND": effective},
            get_project=lambda: SimpleNamespace(get_net_classes=lambda: [effective, unused]),
        )
        with patch("ipc_context.rule_files", return_value={".kicad_pro": b"{}"}):
            before = fingerprint(board)[3]
            exported = netclass_state(board)["routing"]
            effective.proto.board.diff_pair_gap.value_nm = 500000
            self.assertEqual(netclass_state(board)["routing"], exported)
            self.assertNotEqual(fingerprint(board)[3], before)
            before = fingerprint(board)[3]
            unused.proto.board.tuning_profile = "changed"
            self.assertNotEqual(fingerprint(board)[3], before)


if __name__ == "__main__":
    unittest.main()

import sys
from pathlib import Path

sys.path[:0] = [str(Path(__file__).parents[1]), str(Path(__file__).parents[1] / "vendor")]
import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from ipc_display import DISPLAY_WARNING, refresh_editor
from kipy.proto.common.commands.editor_commands_pb2 import RAS_INVALID, RAS_OK


class DisplayTests(unittest.TestCase):
    def test_redraw_uses_the_connected_editor_without_any_board_operation(self):
        api = Mock()
        api.run_action.return_value = SimpleNamespace(status=RAS_OK)
        self.assertEqual(refresh_editor(api), {})
        self.assertEqual(
            api.mock_calls, [unittest.mock.call.run_action("common.Control.zoomRedraw")]
        )

    def test_unavailable_action_is_a_display_warning_not_a_failed_transaction(self):
        api = Mock()
        api.run_action.return_value = SimpleNamespace(status=RAS_INVALID)
        self.assertEqual(refresh_editor(api), {"displayWarning": DISPLAY_WARNING})

    def test_lost_redraw_response_does_not_retry_or_revert_confirmed_copper(self):
        api = Mock()
        api.run_action.side_effect = ConnectionError("lost response")
        self.assertEqual(refresh_editor(api), {"displayWarning": DISPLAY_WARNING})
        self.assertEqual(
            api.mock_calls, [unittest.mock.call.run_action("common.Control.zoomRedraw")]
        )

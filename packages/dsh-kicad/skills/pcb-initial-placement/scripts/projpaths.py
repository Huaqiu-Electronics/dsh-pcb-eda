#!/usr/bin/env python3
"""Where a placement run puts its files: ``<project>/placement/``.

Every artefact this skill generates - geometry, config, plan, pose table, SVG view,
verification report, offline board copy - belongs in ONE directory next to the board
file, never in the skill directory and never scattered over the caller's cwd:

    <project>/            <- directory that holds board.kicad_pcb
      board.kicad_pcb
      placement/          <- created on demand; everything lands here
        geometry.json
        placement_config.json
        placement_plan.json
        placement_pose_table.csv
        placement_view.svg
        verify_placement.txt

Resolution order for the output directory:

1. an explicit ``--outdir`` (wins verbatim, absolute or relative to cwd),
2. ``<directory of --board>/placement`` when a board path is known,
3. the directory of the primary reference input (which already lives in
   ``placement/`` once the convention is being followed),
4. ``./placement`` as a last resort.

An explicit ``--out`` always bypasses this module: the caller asked for that exact
path, so it is honoured, and only its parent directory is created.
"""
from __future__ import annotations

import atexit
import os
import sys

PLACEMENT_DIRNAME = "placement"


def placement_dir(board=None, refs=(), outdir=None, create=True):
    """Resolve (and by default create) the placement output directory.

    ``board`` is the .kicad_pcb path, ``refs`` the input files of this step.
    """
    if outdir:
        d = os.path.abspath(outdir)
    else:
        d = None
        if board:
            d = os.path.join(os.path.dirname(os.path.abspath(board)), PLACEMENT_DIRNAME)
        if d is None:
            for r in refs:
                if r:
                    d = os.path.dirname(os.path.abspath(r))
                    break
        if d is None:
            d = os.path.abspath(PLACEMENT_DIRNAME)
    if create:
        os.makedirs(d, exist_ok=True)
    return d


def resolve_out(explicit, default_name, board=None, refs=(), outdir=None):
    """``--out`` wins verbatim; otherwise ``<placement dir>/<default_name>``."""
    if explicit:
        p = os.path.abspath(explicit)
        parent = os.path.dirname(p)
        if parent:
            os.makedirs(parent, exist_ok=True)
        return p
    return os.path.join(placement_dir(board=board, refs=refs, outdir=outdir),
                        default_name)


def add_outdir(ap):
    """Attach the standard ``--outdir`` flag (and return the argparse action)."""
    return ap.add_argument(
        "--outdir", default=None,
        help="directory for every generated file; default <directory of the board>/"
             "placement/ (created if missing)")


def announce(paths, label="placement directory"):
    """Print the one line that tells the reviewer where this run's files live."""
    seen, out = set(), []
    for p in paths:
        d = os.path.dirname(os.path.abspath(p))
        if d not in seen:
            seen.add(d)
            out.append(d)
    if out:
        print("%s: %s" % (label, ", ".join(out)))


class Tee:
    """Mirror everything printed into a report file, so the run leaves evidence.

    A verified run is only as good as the record of it: the console scrolls away,
    the file stays next to the plan it describes.
    """

    def __init__(self, path):
        self.path = path
        self.fh = open(path, "w", encoding="utf-8")
        self.stdout = sys.stdout
        self.closed = False

    def write(self, s):
        self.stdout.write(s)
        self.fh.write(s)
        return len(s)

    def flush(self):
        if self.closed:
            return
        self.stdout.flush()
        self.fh.flush()

    def close(self):
        if self.closed:
            return
        self.flush()
        self.fh.close()
        self.closed = True
        sys.stdout = self.stdout


def make_console_safe():
    """Stop a device value from killing a run on a legacy-code-page console.

    A board may hold a value like ``100µF``; on Windows with a GBK/cp1252 console,
    ``print()`` raises UnicodeEncodeError and the whole script dies *after* doing its
    work.  Reconfiguring the stream (not any file) keeps report files UTF-8 while
    replacing only the characters the console cannot represent.

    Called by ``start_report()``, and worth calling directly in scripts that print
    without writing a report (a geometry or preflight pass, for instance).
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


def start_report(path):
    """Send stdout through a :class:`Tee` writing to ``path``; return the Tee.

    The report file is always UTF-8, whatever the console encoding is: a legacy
    Windows code page may garble Chinese module titles *on screen*, but the file a
    reviewer opens later is correct.  Deliberately not reconfiguring sys.stdout -
    forcing UTF-8 helps only terminals that decode UTF-8 and breaks consoles that
    render their own legacy code page correctly.

    Registered with :mod:`atexit` as well, so an early ``return`` or a
    ``SystemExit`` still leaves a complete, flushed report.
    """
    tee = Tee(path)
    atexit.register(tee.close)
    sys.stdout = tee
    make_console_safe()
    return tee

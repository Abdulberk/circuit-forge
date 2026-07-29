#!/usr/bin/env python3
"""
Fill the copper zones in a .kicad_pcb, in place.

WHY THIS EXISTS. `kicad-cli pcb export gerbers` takes `--check-zones`, which refills the pour before
plotting — that is what makes the DELIVERED gerbers carry the ground plane. Neither `export glb` nor
`pcb render` has an equivalent flag: `--include-zones` only exports fills that ALREADY exist, and pcb-core
emits the zone unfilled (measured: every gallery board has one `(zone …)` and `filled_polygon` count 0).

So the fab bundle had a ground plane and the 3D preview the customer inspects did not — the same
checked-≠-delivered split we closed on the gerber side, reappearing on the visual side. It is not only
cosmetic: the copper the pour adds is most of the board's copper area, so a preview without it shows a
board that does not exist.

Filling is only available through the Python API (`pcbnew.ZONE_FILLER`), which is why this is a script
rather than another CLI flag. It is a no-op on a board with no zones, and it rewrites the file only when a
fill actually happened, so a caller can safely run it on every board.

Usage: python3 fill-zones.py <board.kicad_pcb>
Exit 0 = the board is fill-current (either filled now, or had nothing to fill).
"""

import sys

import pcbnew


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: fill-zones.py <board.kicad_pcb>", file=sys.stderr)
        return 2

    path = sys.argv[1]
    board = pcbnew.LoadBoard(path)
    zones = board.Zones()
    if len(zones) == 0:
        print("no zones — nothing to fill")
        return 0

    filler = pcbnew.ZONE_FILLER(board)
    # Fill returns False when it could not fill every zone. That is worth reporting rather than
    # swallowing: a zone that fails to fill is a board whose plane is missing, which is exactly the
    # condition this script exists to prevent.
    ok = filler.Fill(zones)
    pcbnew.SaveBoard(path, board)

    if not ok:
        print(f"WARNING: ZONE_FILLER could not fill all {len(zones)} zone(s)", file=sys.stderr)
        return 1

    print(f"filled {len(zones)} zone(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

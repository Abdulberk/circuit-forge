/**
 * Does the bundle agree with itself?
 *
 * Every artifact we ship was verified ALONE. The gerbers were checked for required layers and real
 * geometry; the position file was well-formed CSV with plausible numbers; DRC passed on the board both
 * were supposed to come from. Each answer was correct. Nothing asked the one question that mattered —
 * whether the two files describe the same board in the same frame — and for that reason a bundle whose
 * placements sat exactly (+100, −100) mm away from its own copper passed every check we had, on every
 * board, for as long as the feature has existed. It was found by measuring, not by a test failing.
 *
 * So this module exists to compare artifacts to EACH OTHER rather than each to its own spec. That is a
 * different kind of check from the rest of the pipeline and the reason it catches a different kind of bug:
 * two views of the same decision can each be internally consistent and still disagree.
 *
 * The invariant chosen is the cheapest one that is decisive. Not "is this part in the right place" —
 * that needs the very pad geometry the position file does not carry, and would make the check as complex
 * as the thing it verifies. Instead: **every placement must land inside the board's own outline.** A
 * frame mismatch throws every component clean off the board, so the failure is enormous and unambiguous;
 * a correct bundle passes with room to spare. No polygon arithmetic, no tolerance tuning, one comparison.
 */

/** Board outline extent, in the gerber's own coordinates (millimetres). */
export interface OutlineExtent {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

export interface Placement {
    ref: string;
    x: number;
    y: number;
}

export type FrameCheck =
    | { ok: true; placements: number; extent: OutlineExtent }
    | {
          ok: false;
          reason: 'no-outline-geometry' | 'no-placements' | 'off-board';
          message: string;
          offBoard?: Placement[];
      };

/**
 * How far outside the outline a placement may still be considered on the board.
 *
 * A component's ORIGIN is not its body: an edge connector or a board-edge fiducial can legitimately sit
 * a little beyond the routed outline, and a check that fired on those would be turned off within a week.
 * Five millimetres is far more slack than any real part needs and hopelessly less than any frame error —
 * the defect this exists for was twenty times this margin. The gap between "generous" and "catches it"
 * is what makes the check keepable.
 */
const EDGE_SLACK_MM = 5;

/**
 * Bounding box of a Gerber's drawn geometry.
 *
 * Only D01/D02/D03 coordinate blocks count — an aperture DEFINITION (`%ADD10C,0.1*%`) carries numbers
 * that are sizes, not positions, and folding those into an extent would quietly shrink the board toward
 * the origin. The format word (`%FSLAX46Y46*%`) gives the implied decimal point; Gerber omits it.
 */
export function gerberExtent(gerber: string): OutlineExtent | null {
    const fs = /%FSLAX(\d)(\d)Y(\d)(\d)\*%/.exec(gerber);
    if (!fs) return null;
    const scale = 10 ** -Number(fs[2]);

    let x: number | null = null;
    let y: number | null = null;
    const pts: Array<[number, number]> = [];
    for (const line of gerber.split(/\r?\n/)) {
        const m = /^(?:X(-?\d+))?(?:Y(-?\d+))?D0[123]\*$/.exec(line.trim());
        if (!m) continue;
        // Gerber coordinates are MODAL: an omitted axis repeats the previous value, so a block that
        // names only X still plots at the last Y. Dropping those points would understate the extent.
        if (m[1] !== undefined) x = Number(m[1]) * scale;
        if (m[2] !== undefined) y = Number(m[2]) * scale;
        if (x !== null && y !== null) pts.push([x, y]);
    }
    if (!pts.length) return null;
    return {
        minX: Math.min(...pts.map((p) => p[0])),
        minY: Math.min(...pts.map((p) => p[1])),
        maxX: Math.max(...pts.map((p) => p[0])),
        maxY: Math.max(...pts.map((p) => p[1])),
    };
}

/**
 * Read placements out of a kicad-cli CSV position file.
 *
 * Columns are located BY HEADER NAME rather than by index. kicad-cli writes `Ref,Val,Package,PosX,PosY,
 * Rot,Side`, but a column added upstream would silently shift every fixed index by one and this check
 * would then compare the wrong numbers while still reporting a confident pass — the exact failure mode
 * the module was written to end.
 */
export function parsePositionCsv(csv: string): Placement[] | null {
    const lines = csv.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return null;

    const cells = (line: string): string[] =>
        (line.match(/("([^"]|"")*"|[^,]*)(,|$)/g) ?? [])
            .map((c) => c.replace(/,$/, '').trim().replace(/^"|"$/g, '').replace(/""/g, '"'))
            .slice(0, -1);

    // Normalise away spacing and units before matching: the same column is spelled `PosX` by kicad-cli,
    // `Mid X` by JLCPCB's template and `MidX(mm)` by our own preview writer. Matching the raw string means
    // the check silently declines to run on a file it could perfectly well read — and a check that did not
    // run must never be mistaken for one that passed, so the cheap fix is to read all three spellings.
    const header = cells(lines[0]!).map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
    const iRef = header.findIndex((h) => h === 'ref' || h === 'refdes' || h === 'designator');
    const iX = header.findIndex((h) => h === 'posx' || h === 'x' || h.startsWith('midx'));
    const iY = header.findIndex((h) => h === 'posy' || h === 'y' || h.startsWith('midy'));
    if (iRef < 0 || iX < 0 || iY < 0) return null;

    const out: Placement[] = [];
    for (const line of lines.slice(1)) {
        const c = cells(line);
        const x = Number(c[iX]);
        const y = Number(c[iY]);
        // A row whose coordinates do not parse is not a placement to skip quietly — it is a row the
        // machine will also fail to read. Refuse the file rather than check the subset that happened to
        // parse and call the bundle sound.
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        out.push({ ref: c[iRef] ?? '', x, y });
    }
    return out.length ? out : null;
}

/**
 * The check itself: do the placements live on the board the copper describes?
 *
 * Takes the Edge.Cuts gerber rather than the board file on purpose — the outline as the FAB will read it,
 * from the same export that produced the copper. Comparing against the design's intended outline would
 * re-introduce the original mistake in a new place: two artifacts, each checked against intent, neither
 * checked against the other.
 */
export function checkDeliveryFrame(edgeCutsGerber: string, positionCsv: string): FrameCheck {
    const extent = gerberExtent(edgeCutsGerber);
    if (!extent)
        return {
            ok: false,
            reason: 'no-outline-geometry',
            message: 'The Edge_Cuts gerber has no drawn geometry, so there is no outline to check placements against.',
        };

    const placements = parsePositionCsv(positionCsv);
    if (!placements)
        return {
            ok: false,
            reason: 'no-placements',
            message: 'The position file carries no readable placements (missing Ref/PosX/PosY columns, or no rows).',
        };

    const offBoard = placements.filter(
        (p) =>
            p.x < extent.minX - EDGE_SLACK_MM ||
            p.x > extent.maxX + EDGE_SLACK_MM ||
            p.y < extent.minY - EDGE_SLACK_MM ||
            p.y > extent.maxY + EDGE_SLACK_MM,
    );

    if (offBoard.length) {
        // Name the SHAPE of the failure, not just the count. "3 parts are off the board" sends someone
        // hunting a placement bug; "the whole file is shifted" names the actual cause and the actual fix.
        //
        // The signature of a frame mismatch is a RIGID TRANSLATION: the same parts, in the same
        // arrangement, somewhere else. So the test is on the point cloud as a whole — every placement off
        // the board, and the cloud no bigger than the board it should be sitting on. Measuring each part's
        // distance to the nearest edge does NOT work and is worth recording: parts sit at different places
        // on the board, so those distances differ even under a perfectly uniform shift, and the real
        // defect was reported as "not uniform" until a test caught it.
        const xs = placements.map((p) => p.x);
        const ys = placements.map((p) => p.y);
        const cloud = {
            minX: Math.min(...xs),
            minY: Math.min(...ys),
            maxX: Math.max(...xs),
            maxY: Math.max(...ys),
        };
        const fits =
            cloud.maxX - cloud.minX <= extent.maxX - extent.minX + 2 * EDGE_SLACK_MM &&
            cloud.maxY - cloud.minY <= extent.maxY - extent.minY + 2 * EDGE_SLACK_MM;
        const translated = offBoard.length === placements.length && placements.length > 1 && fits;
        const dx = Math.round((cloud.minX + cloud.maxX) / 2 - (extent.minX + extent.maxX) / 2);
        const dy = Math.round((cloud.minY + cloud.maxY) / 2 - (extent.minY + extent.maxY) / 2);

        return {
            ok: false,
            reason: 'off-board',
            offBoard,
            message:
                `${offBoard.length} of ${placements.length} placements fall outside the board outline ` +
                `(x ${extent.minX.toFixed(2)}…${extent.maxX.toFixed(2)}, y ${extent.minY.toFixed(2)}…${extent.maxY.toFixed(2)} mm). ` +
                (translated
                    ? `They keep their arrangement and sit about (${dx}, ${dy}) mm away as a group, so the position file and the gerbers were plotted in different frames — the parts are not misplaced, the two files disagree about where the board is.`
                    : `Example: ${offBoard[0]!.ref} at (${offBoard[0]!.x}, ${offBoard[0]!.y}).`),
        };
    }

    return { ok: true, placements: placements.length, extent };
}

/**
 * The check that would have caught the (+100, −100) mm bundle.
 *
 * These tests are written around the REAL defect rather than around the function's signature: the middle
 * case below is the actual geometry that shipped — a board outline in one frame and placements 100 mm away
 * in another — and it must fail. A test suite for this module that never reproduces that arrangement would
 * pass just as happily against the broken code it replaced.
 */
import { checkDeliveryFrame, gerberExtent, parsePositionCsv } from './delivery-frame';

/** A minimal but real Edge.Cuts gerber: a 20 × 20 mm outline whose lower-left corner is the origin. */
const OUTLINE = [
    '%FSLAX46Y46*%',
    '%MOMM*%',
    '%ADD10C,0.100000*%',
    'D10*',
    'X0Y0D02*',
    'X20000000Y0D01*',
    'X20000000Y20000000D01*',
    'X0Y20000000D01*',
    'X0Y0D01*',
    'M02*',
].join('\n');

const POS = (rows: Array<[string, number, number]>): string =>
    ['Ref,Val,Package,PosX,PosY,Rot,Side', ...rows.map(([r, x, y]) => `"${r}","","",${x},${y},0,top`)].join('\n');

describe('reading the two artifacts', () => {
    it('measures a gerber outline in millimetres, from the format word', () => {
        // 4.6 format: the six trailing digits are the fraction, so 20000000 is 20 mm, not 20 000 000.
        expect(gerberExtent(OUTLINE)).toEqual({ minX: 0, minY: 0, maxX: 20, maxY: 20 });
    });

    it('ignores aperture definitions — those numbers are sizes, not positions', () => {
        // A 0.1 mm aperture must not drag the extent toward the origin. The outline starts at x=10 here,
        // so an implementation that folded `%ADD10C,0.100000*%` into the box would report minX 0.1 or 0.
        const offset = OUTLINE.replace(/X0Y0D02\*/, 'X10000000Y10000000D02*')
            .replace(/X20000000Y0D01\*/, 'X30000000Y10000000D01*')
            .replace(/X20000000Y20000000D01\*/, 'X30000000Y30000000D01*')
            .replace(/X0Y20000000D01\*/, 'X10000000Y30000000D01*')
            .replace(/X0Y0D01\*/, 'X10000000Y10000000D01*');
        expect(gerberExtent(offset)).toEqual({ minX: 10, minY: 10, maxX: 30, maxY: 30 });
    });

    it('honours modal coordinates — an omitted axis repeats the last one', () => {
        // `X30000000D01*` with no Y plots at the previous Y. Skipping those blocks understates the board.
        const modal = ['%FSLAX46Y46*%', '%MOMM*%', 'D10*', 'X0Y0D02*', 'X30000000D01*', 'M02*'].join('\n');
        expect(gerberExtent(modal)).toEqual({ minX: 0, minY: 0, maxX: 30, maxY: 0 });
    });

    it('finds columns by NAME, so an added upstream column cannot silently shift them', () => {
        const withExtra = ['Ref,Val,Package,Variant,PosX,PosY,Rot,Side', '"R1","","","default",5,6,0,top'].join('\n');
        expect(parsePositionCsv(withExtra)).toEqual([{ ref: 'R1', x: 5, y: 6 }]);
    });

    it('refuses a file whose coordinates do not parse rather than checking the rows that did', () => {
        expect(parsePositionCsv(['Ref,PosX,PosY', 'R1,5,6', 'R2,nonsense,6'].join('\n'))).toBeNull();
        expect(parsePositionCsv('Ref,PosX,PosY')).toBeNull(); // header only — an empty board and a broken export look alike
    });

    it('refuses a file with no recognisable position columns', () => {
        expect(parsePositionCsv(['Designator,Comment', 'R1,10k'].join('\n'))).toBeNull();
    });
});

describe('do the gerbers and the placements agree about where the board is', () => {
    it('passes a bundle whose placements sit on the board', () => {
        const res = checkDeliveryFrame(
            OUTLINE,
            POS([
                ['R1', 5, 5],
                ['C1', 15, 12],
                ['U1', 10, 10],
            ]),
        );
        expect(res).toEqual({ ok: true, placements: 3, extent: { minX: 0, minY: 0, maxX: 20, maxY: 20 } });
    });

    it('FAILS the bundle that actually shipped — placements 100 mm from their own copper', () => {
        // The defect verbatim: the outline is where it always was, and every placement is offset by the
        // same (+100, −100) mm because it came from a different producer with a different origin.
        const res = checkDeliveryFrame(
            OUTLINE,
            POS([
                ['R1', 105, -95],
                ['C1', 115, -88],
                ['U1', 110, -90],
            ]),
        );
        expect(res.ok).toBe(false);
        if (res.ok) throw new Error('unreachable');
        expect(res.reason).toBe('off-board');
        expect(res.offBoard).toHaveLength(3);
        // The message must name the SHAPE of the failure. "3 parts are off the board" sends someone
        // hunting a placement bug; "all three are off by the same amount" names the actual cause.
        expect(res.message).toMatch(/keep their arrangement/i);
        expect(res.message).toMatch(/different frames/i);
    });

    it('tolerates a part whose origin sits just past the outline — an edge connector is not a frame bug', () => {
        // Without this slack the check fires on legitimate boards, gets switched off, and protects nothing.
        const res = checkDeliveryFrame(
            OUTLINE,
            POS([
                ['J1', 20.5, 10],
                ['R1', -1.5, 10],
            ]),
        );
        expect(res.ok).toBe(true);
    });

    it('still catches a frame error far smaller than the one that shipped', () => {
        // The slack must not be so generous that a real mismatch hides inside it. 25 mm — a quarter of the
        // measured defect, and larger than any plausible edge overhang.
        const res = checkDeliveryFrame(
            OUTLINE,
            POS([
                ['R1', 30, 30],
                ['C1', 40, 35],
            ]),
        );
        expect(res.ok).toBe(false);
    });

    it('reports one stray part DIFFERENTLY from a whole-file shift', () => {
        const res = checkDeliveryFrame(
            OUTLINE,
            POS([
                ['R1', 5, 5],
                ['C1', 15, 12],
                ['STRAY', 99, 99],
            ]),
        );
        expect(res.ok).toBe(false);
        if (res.ok) throw new Error('unreachable');
        expect(res.message).toMatch(/STRAY/);
        expect(res.message).not.toMatch(/different frames/i);
    });

    it('refuses rather than passes when either artifact is unreadable', () => {
        // Silence must not be indistinguishable from agreement: an empty outline or an empty position file
        // means the check DID NOT RUN, and a bundle must never be called self-consistent on that basis.
        expect(checkDeliveryFrame('%FSLAX46Y46*%\nM02*', POS([['R1', 5, 5]]))).toMatchObject({
            ok: false,
            reason: 'no-outline-geometry',
        });
        expect(checkDeliveryFrame(OUTLINE, 'Ref,PosX,PosY')).toMatchObject({ ok: false, reason: 'no-placements' });
    });
});

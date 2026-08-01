/**
 * The draft boundary: shaped like a circuit, but not required to be a finished one.
 *
 * `circuitJson` was `@IsObject()` and nothing more, so `{"nope": true}` was accepted and stored as a design.
 * That write costs nothing at the time and everything later: the editor opens the project and renders an
 * empty tree, every downstream stage reads `components` as undefined, and the layout job eventually fails
 * about a property that was never there — with no trace pointing back at the save that caused it.
 *
 * The rule has two halves and BOTH are tested here, because a guard like this is one keystroke away from
 * being too strict. A working copy is autosaved on a debounce while someone edits, so it is legitimately
 * half-finished most of the time; running the full CircuitJson schema (as POST /layouts does, where
 * correctness genuinely matters) would reject ordinary mid-edit states and make editing impossible.
 *
 * These run the REAL global pipe from main.ts — whitelist + forbidNonWhitelisted + transform — because the
 * strictness is what is under test, and a pipe configured differently here would prove nothing about the
 * deployed API.
 */
import { ValidationPipe, type ArgumentMetadata } from '@nestjs/common';

import { SaveWorkingCopyDto } from './index';

const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
const meta: ArgumentMetadata = { type: 'body', metatype: SaveWorkingCopyDto };

const run = (body: Record<string, unknown>) => pipe.transform(body, meta) as Promise<SaveWorkingCopyDto>;

/**
 * The per-field messages, which is what a client actually receives.
 *
 * `BadRequestException.message` is the generic "Bad Request Exception"; the useful part lives in
 * `.response.message` as an array — and that array IS the contract, since the studio places each message
 * next to its own field. Asserting on `.message` would pass for any rejection at all, including one for the
 * wrong reason.
 */
const rejectionMessages = async (body: Record<string, unknown>): Promise<string> => {
    const err = (await run(body).catch((e: unknown) => e)) as { response?: { message?: string[] } };
    const messages = err.response?.message;
    if (!Array.isArray(messages)) throw new Error(`expected a validation rejection, got ${JSON.stringify(err)}`);
    return messages.join(' ');
};

const circuit = {
    version: '1.0',
    components: [{ id: 'r1', type: 'resistor', designator: 'R1', value: 1000, pins: [] }],
    nets: [{ id: 'n1', name: 'N1' }],
};

describe('SaveWorkingCopyDto — a draft must be a circuit, not finished', () => {
    it('accepts a complete design', async () => {
        const dto = await run({ circuitJson: circuit, uiJson: {} });
        expect(dto.circuitJson).toEqual(circuit);
    });

    it('accepts an EMPTY design — a project that has just been created has one', async () => {
        await expect(run({ circuitJson: { components: [], nets: [] }, uiJson: {} })).resolves.toBeDefined();
    });

    it('accepts a mid-edit design: a component with no value, no pins, and no nets yet', async () => {
        // The state a user is in for most of the time they are working. Rejecting it would mean autosave
        // starts failing the moment someone drops a part on the canvas.
        await expect(
            run({
                circuitJson: { components: [{ id: 'u1', type: 'ic', designator: 'U1' }], nets: [] },
                uiJson: { viewport: { x: 0, y: 0, zoom: 1 } },
            }),
        ).resolves.toBeDefined();
    });

    it('refuses an object that is not a circuit at all', async () => {
        // The regression this exists for. It answered 200 before.
        await expect(rejectionMessages({ circuitJson: { nope: true }, uiJson: {} })).resolves.toMatch(/components/);
    });

    it('refuses a circuit whose components or nets are not arrays', async () => {
        // `{components: {}}` is the shape a client produces by building the design as a keyed map — plausible,
        // and silently wrong everywhere downstream, since every consumer iterates it.
        await expect(rejectionMessages({ circuitJson: { components: {}, nets: [] }, uiJson: {} })).resolves.toMatch(
            /components/,
        );
        await expect(rejectionMessages({ circuitJson: { components: [], nets: {} }, uiJson: {} })).resolves.toMatch(
            /nets/,
        );
    });

    it('names the field in the message, so the editor can say what is wrong', async () => {
        const err = (await run({ circuitJson: { nope: true }, uiJson: {} }).catch((e: unknown) => e)) as {
            response: { message: string[] };
        };
        expect(err.response.message.join(' ')).toContain('circuitJson');
    });

    it('still requires uiJson — omitting it must not silently erase stored editor state', async () => {
        // The save REPLACES the row, so a defaulted `{}` would wipe a user's viewport and selection the first
        // time a client saved "just the circuit".
        await expect(rejectionMessages({ circuitJson: circuit })).resolves.toMatch(/uiJson/);
    });

    it('keeps expectedUpdatedAt optional — omitting it is last-writer-wins, which predates the editor', async () => {
        const dto = await run({ circuitJson: circuit, uiJson: {} });
        expect(dto.expectedUpdatedAt).toBeUndefined();

        const guarded = await run({ circuitJson: circuit, uiJson: {}, expectedUpdatedAt: '2026-08-01T12:00:00.000Z' });
        expect(guarded.expectedUpdatedAt).toBe('2026-08-01T12:00:00.000Z');
    });

    it('rejects an unknown field rather than storing it', async () => {
        await expect(rejectionMessages({ circuitJson: circuit, uiJson: {}, sneaky: 1 })).resolves.toMatch(/sneaky/);
    });
});

/**
 * Browser APIs jsdom does not implement, added once instead of worked around in each test.
 *
 * jsdom has no `PointerEvent`. Testing Library falls back to a plain `Event`, which silently drops every
 * property the initialiser carries — so a simulated drag arrives with `clientX` undefined and the component
 * computes `undefined - 0`, i.e. NaN, and writes NaN coordinates. Nothing throws; the assertion just fails
 * with a number that is not a number, and the obvious conclusion is that the component is wrong.
 *
 * The wrong fixes are both tempting. Making the component read `movementX` instead moves the problem (also
 * absent) and is worse in production, where `movementX` ignores pointer capture and disagrees between
 * browsers. Dispatching mouse events instead tests a code path the product does not use — touch and pen
 * arrive as pointer events, and a tablet user dragging a symbol is the case most likely to be broken and
 * least likely to be noticed.
 *
 * So the environment is fixed rather than the code. This shim is exactly what the spec says a
 * `PointerEvent` is: a `MouseEvent` — which jsdom does implement, coordinates and all — plus the pointer
 * identity fields. Every gesture this editor grows from here is testable because of it.
 */
if (typeof window !== 'undefined' && typeof window.PointerEvent === 'undefined') {
    class PointerEventShim extends MouseEvent {
        readonly pointerId: number;
        readonly pointerType: string;
        readonly isPrimary: boolean;
        readonly width: number;
        readonly height: number;
        readonly pressure: number;

        constructor(type: string, init: PointerEventInit = {}) {
            super(type, init);
            this.pointerId = init.pointerId ?? 0;
            this.pointerType = init.pointerType ?? 'mouse';
            this.isPrimary = init.isPrimary ?? true;
            this.width = init.width ?? 1;
            this.height = init.height ?? 1;
            this.pressure = init.pressure ?? 0.5;
        }
    }
    window.PointerEvent = PointerEventShim as unknown as typeof PointerEvent;

    // Pointer capture is how a drag keeps receiving events after the pointer leaves the element it started
    // on — which is the ordinary case, since a user dragging a symbol to the edge of the sheet moves off it.
    // jsdom implements none of it; the component calls it optionally, and these no-ops keep the shape of the
    // API honest rather than leaving a call that silently does nothing on a real browser too.
    const proto = window.Element.prototype as unknown as Record<string, unknown>;
    proto.setPointerCapture ??= function setPointerCapture() {};
    proto.releasePointerCapture ??= function releasePointerCapture() {};
    proto.hasPointerCapture ??= function hasPointerCapture() {
        return false;
    };
}

export {};

/**
 * A React error printed to the console FAILS the test that printed it.
 *
 * The defect that bought this rule: `key` was being carried inside a props object and spread onto an SVG
 * element. React reads a key off the element, never out of a spread, so every stroke on every symbol was
 * rendered WITHOUT one — re-created on each paint instead of matched to the element before it — and React
 * said so, loudly, on every render. In a browser it filled the console. Here, 191 tests rendered that same
 * component hundreds of times and every one of them passed, because a console error is not an exception.
 *
 * That is the shape this suite keeps finding in itself: a check that cannot fail is not a check. React's
 * warnings are the framework reporting a real defect in terms nothing else will report — a missing key, a
 * state update outside `act`, an invalid prop, an unknown DOM attribute — and a test run that renders the
 * whole editor is exactly where they should be caught.
 *
 * Scoped to React's own diagnostics. A component that deliberately logs — a caught network error, a warning
 * a user should see — is not the framework complaining, and failing on those would push tests to swallow
 * output that belongs on screen.
 */
/**
 * ANCHORED PATTERNS ARE HOW THIS RULE QUIETLY STOPS WORKING.
 *
 * The first version of it listed "a state update outside `act`" among the defects it claimed to catch, and
 * could not match one: React's message begins "An update to X inside a test was not wrapped in act(...)",
 * while every alternative here was anchored at the start of the string. A rule that names what it catches
 * and does not catch it is the same shape as the tests it exists to police.
 *
 * So the distinctive PHRASE is matched wherever it appears, and each entry is one React actually emits.
 */
const REACT_DIAGNOSTIC =
    /(^Warning:|Each child in a list|A props object containing a "key"|not wrapped in act|React (does not|keys)|^Invalid|^Received|^Unknown|You provided a `value` prop|cannot appear as a (child|descendant)|Encountered two children with the same key)/;

beforeEach(() => {
    const complain = (label: 'error' | 'warn', original: (...args: unknown[]) => void) =>
        jest.spyOn(console, label).mockImplementation((...args: unknown[]) => {
            original(...args);
            const first = typeof args[0] === 'string' ? args[0] : '';
            if (REACT_DIAGNOSTIC.test(first)) {
                throw new Error(
                    `React reported a defect and the test would otherwise have passed:\n\n${String(args[0])}`,
                );
            }
        });
    complain('error', console.error.bind(console));
    complain('warn', console.warn.bind(console));
});

afterEach(() => {
    jest.restoreAllMocks();
});

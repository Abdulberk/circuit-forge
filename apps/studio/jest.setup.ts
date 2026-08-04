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

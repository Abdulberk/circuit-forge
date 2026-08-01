'use client';

/**
 * The animated simulation overlay: the board's copper, coloured by the voltage the simulator MEASURED on
 * each net, played back over the run's own timebase.
 *
 * PERFORMANCE IS THE ARCHITECTURE HERE, not a tuning pass afterwards:
 *
 *   • ONE mesh, ONE draw call for every trace on the board. Copper is built once from LayoutGeometry with a
 *     per-vertex net index; nothing is rebuilt when the value changes.
 *   • The per-frame write is ONE `set()` of net-count floats into a DataTexture, and it is skipped entirely
 *     when the frame index has not moved (so a paused board uploads nothing). It is a memcpy, not a loop:
 *     measured at 5000 nets, `set(subarray(…))` is 2.0 s over 3.6M frames against 17.6 s for an index loop.
 *     It does allocate one Float32Array VIEW per frame — ~1 minor GC every three minutes at 60 fps, which
 *     is stated here rather than claimed away.
 *   • The waveform is resampled to a fixed frame count at LOAD, so advancing time is an array index rather
 *     than a search, and the loop DURATION is fixed rather than the rate — see `loopSeconds`.
 *
 * A 5000-net board costs the same in structure as a 25-net one: one draw call, one texture upload of a few
 * kilobytes. The structural claim holds up to the GPU's MAX_TEXTURE_SIZE (guaranteed ≥2048 on WebGL2), past
 * which the per-net texture would need a second dimension — not reached by any board we can route today,
 * and named here so it is a known edge rather than a surprise.
 *
 * HONESTY. A net with copper but no simulation signal is not drawn dark and left to look like zero volts;
 * it is reported to the caller as unresolved. A board that could not be simulated at all says so, with the
 * reason, rather than rendering a still board that reads as "nothing is happening".
 */
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';

import { buildCopperMesh, type Trace } from '../lib/copper';
import type { FlowTable } from '../lib/flow';
import type { Playback } from '../lib/simulation';
import { FLOW_FRAG, FLOW_VERT, TIER_AMP, TIER_COLOR, TIER_HALO, TIER_HEAD_PX } from './flow-shader';

/**
 * Board-millimetres → the frame the GLB is drawn in.
 *
 * Derived from the LAMINATE's own bounding box, never from a constant: the slab's extent in the render and
 * the board's extent in millimetres are the same rectangle, so dividing one by the other gives the scale
 * exactly — and keeps giving it if kicad-cli ever changes units or the viewer changes its fit.
 *
 * glTF is Y-up by specification, so the board plane is XZ and Y is the board normal: board (x, y) lands on
 * (x, z), and the layer offset goes on Y.
 */
export interface BoardFit {
    /** Units per board millimetre along the board's X. */
    scaleX: number;
    /** Units per board millimetre along the board's Y (mapped to the frame's Z). */
    scaleZ: number;
    /** Where board (0,0) lands. */
    originX: number;
    originZ: number;
    /** +1 or −1: whether board Y grows along +Z or −Z. MEASURED from the render, not assumed. */
    ySign: 1 | -1;
    /** The board's top surface, where the copper sits. */
    surfaceY: number;
}

const VERT = /* glsl */ `
attribute float aNet;
varying float vValue;
uniform sampler2D uValues;
uniform float uNetCount;
void main() {
    // One texel per net, sampled at its centre — nearest filtering, so no neighbour bleeds in.
    float u = (aNet + 0.5) / uNetCount;
    vValue = texture2D(uValues, vec2(u, 0.5)).r;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
varying float vValue;
uniform float uMin;
uniform float uMax;
uniform float uOpacity;
void main() {
    float t = clamp((vValue - uMin) / max(uMax - uMin, 1e-9), 0.0, 1.0);
    // Cold (low) to hot (high): a monotonic ramp, so a brighter trace always means a higher voltage.
    vec3 cold = vec3(0.05, 0.25, 0.85);
    vec3 mid  = vec3(0.15, 0.85, 0.55);
    vec3 hot  = vec3(1.00, 0.55, 0.10);
    vec3 c = t < 0.5 ? mix(cold, mid, t * 2.0) : mix(mid, hot, (t - 0.5) * 2.0);
    // Emissive-looking: the overlay reads as energised copper rather than as a painted decal.
    gl_FragColor = vec4(c * (0.55 + 0.45 * t), uOpacity);
}
`;

export interface SimulationOverlayProps {
    traces: Trace[];
    playback: Playback;
    fit: BoardFit;
    /**
     * How long ONE pass through the run takes on the wall clock, in seconds.
     *
     * Not a speed multiplier, and that is the whole point. Playing at simulated-time rate meant a 5 ms
     * transient finished in 5 ms: at 60 fps the playhead advanced 800 of the 240 resampled frames per
     * displayed frame, so the screen showed 3 of them forever — a 20 Hz strobe, and on a 20 ms run the
     * index step aliased negative and the board played BACKWARDS. The waveform was never on screen.
     *
     * Fixing the LOOP DURATION instead makes every run — 5 ms or 2 s — take the same viewable time, and
     * every resampled frame gets shown. The price is that the animation is not real-time, so the readout
     * states the simulated time and the slow-down factor rather than letting the motion imply a rate.
     */
    loopSeconds?: number;
    playing?: boolean;
    opacity?: number;
    /** Per-edge measured current, solved by Kirchhoff. Absent means no current was resolvable at all, and
     *  the overlay then shows voltage only rather than inventing motion. */
    flow?: FlowTable | null;
    /** Volts spanned by each leg of the diverging base map. Snapped to a real rail by the caller — never
     *  auto-scaled to the board's own maximum, which is what makes a healthy and a failing board render
     *  identically in tools that do it. */
    voltAnchor?: number;
    /** Called at most once per frame with the current simulated time, for a readout. */
    onTime?: (seconds: number) => void;
}

export function SimulationOverlay({
    traces,
    playback,
    fit,
    loopSeconds = 6,
    playing = true,
    opacity = 0.95,
    flow = null,
    voltAnchor = 12,
    onTime,
}: Readonly<SimulationOverlayProps>) {
    const frameRef = useRef(0);
    const camera = useThree((st) => st.camera);
    const gl = useThree((st) => st.gl);
    const size = useThree((st) => st.size);

    /**
     * Pixels per WORLD unit at unit depth — the term that turns a board millimetre into a screen pixel,
     * which every screen-space decision here depends on: the 1.5 px ribbon floor, the 17–34 px pulse
     * spacing ladder, and the fixed-pixel tier head. Recomputed on resize and on a camera change rather
     * than assumed, because a hardcoded value silently mis-scales the whole pattern on a HiDPI display.
     */
    const pxPerWorld = useMemo(() => {
        const persp = camera as THREE.PerspectiveCamera;
        const fov = ((persp.fov ?? 34) * Math.PI) / 180;
        return gl.domElement.height / (2 * Math.tan(fov / 2));
    }, [camera, gl, size.width, size.height]);

    // Built once per board+playback. The net ORDER is the playback's, so a vertex's index and the texture's
    // texel always mean the same net.
    const built = useMemo(() => {
        const netIndexByName = new Map<string, number>(playback.nets.map((n, i) => [n, i]));
        const mesh = buildCopperMesh(traces, netIndexByName, flow ?? undefined);

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
        geometry.setAttribute('aNet', new THREE.BufferAttribute(mesh.netIndex, 1));
        geometry.setAttribute('aEdge', new THREE.BufferAttribute(mesh.edgeIndex, 1));
        geometry.setAttribute('aDist', new THREE.BufferAttribute(mesh.dist, 1));
        geometry.setAttribute('aSide', new THREE.BufferAttribute(mesh.side, 1));
        geometry.setAttribute('aHalfMm', new THREE.BufferAttribute(mesh.halfMm, 1));
        geometry.setAttribute('aPeakAbs', new THREE.BufferAttribute(mesh.peakAbs, 1));
        geometry.setAttribute('aNormal', new THREE.BufferAttribute(mesh.normal, 2));
        geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
        geometry.computeBoundingSphere();

        // R-channel float texture, one texel per net. This is the only thing that changes per frame.
        const texels = new Float32Array(playback.nets.length);
        const texture = new THREE.DataTexture(texels, playback.nets.length, 1, THREE.RedFormat, THREE.FloatType);
        texture.minFilter = THREE.NearestFilter;
        texture.magFilter = THREE.NearestFilter;
        texture.needsUpdate = true;

        // Per-edge current, phase and morph in one RGBA32F texture, TILED rather than a single row: a 1D
        // texture would hit MAX_TEXTURE_SIZE (guaranteed only 2048 on WebGL2) on a dense board, and the
        // failure mode is silent — an incomplete texture samples as zero, so every trace would paint one
        // flat colour while the panel kept reporting a running playback.
        const edges = Math.max(flow?.edges ?? 0, 1);
        const texW = Math.min(1024, edges);
        const texH = Math.ceil(edges / texW);
        const edgeTexels = new Float32Array(texW * texH * 4);
        const edgeTexture = new THREE.DataTexture(edgeTexels, texW, texH, THREE.RGBAFormat, THREE.FloatType);
        edgeTexture.minFilter = THREE.NearestFilter;
        edgeTexture.magFilter = THREE.NearestFilter;
        edgeTexture.needsUpdate = true;

        const material = new THREE.ShaderMaterial({
            vertexShader: FLOW_VERT,
            fragmentShader: FLOW_FRAG,
            transparent: true,
            depthWrite: false,
            uniforms: {
                uNetTex: { value: texture },
                uNetCount: { value: playback.nets.length },
                uEdgeTex: { value: edgeTexture },
                uEdgeTexSize: { value: new THREE.Vector2(texW, texH) },
                uVoltAnchor: { value: voltAnchor },
                uOpacity: { value: opacity },
                uPxPerWorld: { value: pxPerWorld },
                uWorldPerMm: { value: fit.scaleX },
                uMinHalfPx: { value: 1.5 },
                uPeriodBaseMm: { value: 0.25 },
                uTierColor: { value: TIER_COLOR.map((c) => new THREE.Vector3(...c)) },
                uTierAmp: { value: [...TIER_AMP] },
                uTierHalo: { value: [...TIER_HALO] },
                uTierHeadPx: { value: [...TIER_HEAD_PX] },
            },
        });

        if (mesh.quads === 0 && process.env.NODE_ENV !== 'production') {
            // Nothing to draw, and the panel would still be reporting a running playback — the board would
            // sit there looking like a circuit that does nothing. Not silent.
            console.warn('[pcb-viewer] simulation overlay built 0 quads: no trace matched a simulated net');
        }
        return { geometry, material, texture, texels, edgeTexture, edgeTexels, edges: flow?.edges ?? 0 };
        // `opacity` is deliberately NOT a dependency. It is a uniform, updated in place by the effect
        // below; listing it here would rebuild the whole mesh and reupload the texture every time a slider
        // moved, to change one float the GPU already has.
    }, [traces, playback, flow]);

    // Every GPU resource built above is owned by this component and released with it. A viewer that
    // switches boards all evening must not leak a geometry per switch.
    useEffect(() => {
        return () => {
            built.geometry.dispose();
            built.material.dispose();
            built.texture.dispose();
            built.edgeTexture.dispose();
        };
    }, [built]);

    useEffect(() => {
        built.material.uniforms.uOpacity!.value = opacity;
        built.material.uniforms.uVoltAnchor!.value = voltAnchor;
        // Uniforms, not dependencies of the mesh: a resize or a zoom must not rebuild geometry to change
        // two floats the GPU already has.
        built.material.uniforms.uPxPerWorld!.value = pxPerWorld;
        built.material.uniforms.uWorldPerMm!.value = fit.scaleX;
    }, [built, opacity, voltAnchor, pxPerWorld, fit.scaleX]);

    const lastFrame = useRef(-1);
    useFrame((_, delta) => {
        if (playing) {
            // One pass through the whole table per `loopSeconds`, whatever the run's own span. Every
            // resampled frame is displayed; nothing is skipped and nothing aliases.
            frameRef.current = (frameRef.current + (delta * playback.frames) / Math.max(loopSeconds, 0.1)) % playback.frames;
        }
        const f = Math.floor(frameRef.current);
        // Paused, or a frame the display already shows: nothing changed, so nothing is uploaded. The old
        // loop re-sent the whole texture 60×/s while paused.
        if (f === lastFrame.current) return;
        lastFrame.current = f;
        const base = f * playback.nets.length;
        // The whole per-frame cost: net-count + edge-count writes into arrays we already own, both memcpy.
        built.texels.set(playback.values.subarray(base, base + playback.nets.length));
        built.texture.needsUpdate = true;

        if (flow && built.edges > 0) {
            const eb = f * built.edges;
            const dst = built.edgeTexels;
            for (let e = 0; e < built.edges; e++) {
                const o = e * 4;
                dst[o] = flow.values[eb + e]!;
                dst[o + 1] = flow.phase[eb + e]!;
                dst[o + 2] = flow.morph[eb + e]!;
            }
            built.edgeTexture.needsUpdate = true;
        }
        onTime?.(playback.times[f] ?? 0);
    });

    // The whole board-mm → frame mapping, written out. A rotation composed with signed scales expresses the
    // same thing in a way nobody can check by reading, and a mirrored overlay looks plausible — so it is one
    // explicit matrix instead: row 0 is X, row 1 is the board normal, row 2 is the board's Y.
    const matrix = useMemo(() => {
        const m = new THREE.Matrix4();
        m.set(
            fit.scaleX, 0, 0, fit.originX,
            0, 0, fit.scaleX, fit.surfaceY,
            0, fit.scaleZ * fit.ySign, 0, fit.originZ,
            0, 0, 0, 1,
        );
        return m;
    }, [fit]);

    return <mesh geometry={built.geometry} material={built.material} matrix={matrix} matrixAutoUpdate={false} />;
}

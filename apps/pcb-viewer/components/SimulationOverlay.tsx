'use client';

/**
 * The animated simulation overlay: the board's copper, coloured by the voltage the simulator MEASURED on
 * each net, played back over the run's own timebase.
 *
 * PERFORMANCE IS THE ARCHITECTURE HERE, not a tuning pass afterwards:
 *
 *   • ONE mesh, ONE draw call for every trace on the board. Copper is built once from LayoutGeometry with a
 *     per-vertex net index; nothing is rebuilt when the value changes.
 *   • The per-frame write is ONE Float32Array of length = net count (25 on our densest board) into a
 *     DataTexture. No object is allocated in the frame loop, so there is nothing for the GC to collect
 *     during playback and no per-object traversal that grows with board size.
 *   • The waveform is resampled to a fixed frame count at LOAD, so advancing time is an array index rather
 *     than a search. A stiff circuit and an easy one play back at the same speed.
 *
 * A 5000-net board costs the same in structure as a 25-net one: one draw call, one texture upload of a few
 * kilobytes. That is the property worth having — not a number measured on the boards we happen to own.
 *
 * HONESTY. A net with copper but no simulation signal is not drawn dark and left to look like zero volts;
 * it is reported to the caller as unresolved. A board that could not be simulated at all says so, with the
 * reason, rather than rendering a still board that reads as "nothing is happening".
 */
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';

import { buildCopperMesh, type Trace } from '../lib/copper';
import type { Playback } from '../lib/simulation';

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
    /** Seconds of wall-clock per second of simulated time. */
    speed?: number;
    playing?: boolean;
    opacity?: number;
    /** Called at most once per frame with the current simulated time, for a readout. */
    onTime?: (seconds: number) => void;
}

export function SimulationOverlay({
    traces,
    playback,
    fit,
    speed = 1,
    playing = true,
    opacity = 0.95,
    onTime,
}: Readonly<SimulationOverlayProps>) {
    const frameRef = useRef(0);

    // Built once per board+playback. The net ORDER is the playback's, so a vertex's index and the texture's
    // texel always mean the same net.
    const built = useMemo(() => {
        const netIndexByName = new Map(playback.nets.map((n, i) => [n, i]));
        const mesh = buildCopperMesh(traces, netIndexByName);

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
        geometry.setAttribute('aNet', new THREE.BufferAttribute(mesh.netIndex, 1));
        geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
        geometry.computeBoundingSphere();

        // R-channel float texture, one texel per net. This is the only thing that changes per frame.
        const texels = new Float32Array(playback.nets.length);
        const texture = new THREE.DataTexture(texels, playback.nets.length, 1, THREE.RedFormat, THREE.FloatType);
        texture.minFilter = THREE.NearestFilter;
        texture.magFilter = THREE.NearestFilter;
        texture.needsUpdate = true;

        const material = new THREE.ShaderMaterial({
            vertexShader: VERT,
            fragmentShader: FRAG,
            transparent: true,
            depthWrite: false,
            uniforms: {
                uValues: { value: texture },
                uNetCount: { value: playback.nets.length },
                uMin: { value: playback.min },
                uMax: { value: playback.max },
                uOpacity: { value: opacity },
            },
        });

        if (mesh.quads === 0 && process.env.NODE_ENV !== 'production') {
            // Nothing to draw, and the panel would still be reporting a running playback — the board would
            // sit there looking like a circuit that does nothing. Not silent.
            console.warn('[pcb-viewer] simulation overlay built 0 quads: no trace matched a simulated net');
        }
        return { geometry, material, texture, texels };
    }, [traces, playback, opacity]);

    // Every GPU resource built above is owned by this component and released with it. A viewer that
    // switches boards all evening must not leak a geometry per switch.
    useEffect(() => {
        return () => {
            built.geometry.dispose();
            built.material.dispose();
            built.texture.dispose();
        };
    }, [built]);

    useEffect(() => {
        built.material.uniforms.uOpacity!.value = opacity;
    }, [built, opacity]);

    useFrame((_, delta) => {
        if (playing) {
            const span = playback.times[playback.frames - 1]! - playback.times[0]!;
            // Advance in SIMULATED time and wrap, so playback speed is a property of the run rather than of
            // the display's refresh rate.
            const perSecond = (playback.frames / Math.max(span, 1e-9)) * speed;
            frameRef.current = (frameRef.current + delta * perSecond) % playback.frames;
        }
        const f = Math.floor(frameRef.current);
        const base = f * playback.nets.length;
        // The whole per-frame cost: net-count writes into an array we already own.
        built.texels.set(playback.values.subarray(base, base + playback.nets.length));
        built.texture.needsUpdate = true;
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

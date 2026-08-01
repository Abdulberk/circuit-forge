'use client';
import { Component, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Canvas, useThree } from '@react-three/fiber';
import { ContactShadows, OrbitControls, useGLTF, Html } from '@react-three/drei';
import { EffectComposer, Bloom, N8AO, SMAA, ToneMapping } from '@react-three/postprocessing';
import { ToneMappingMode, SMAAPreset } from 'postprocessing';

import { SimulationOverlay, type BoardFit } from './SimulationOverlay';
import { SimulationPanel, type SimState } from './SimulationPanel';
import { useBoardSimulation } from '../lib/useBoardSimulation';
import type { FlowTable } from '../lib/flow';
import type { BoardLayout, Playback } from '../lib/simulation';

// Real, DRC-clean board GLBs our pipeline produced (served from /public). Every one is genuine
// pcb-core output: CircuitJson → tscircuit eval → freerouting → KiCad DRC ✔ → 3D bodies whose
// placement is numerically verified (scripts/verify-3d-alignment.mjs, 0.000mm worst offset).
// The two boards whose decks are electrically COMPLETE and whose signals actually move lead the list, so
// the first click on Simulate demonstrates the feature. The rest are built around an IC with no SPICE
// model (a 555, a 4017, a 7805, a '595) and land on the disclosure instead — which is not hidden by the
// ordering: each board still states its own case when you select it.
const BOARDS = [
    { id: 'bridge-rectifier.glb', title: 'Köprü doğrultucu + filtre', cat: 'güç' },
    { id: 'opamp-amp.glb', title: 'Op-amp yükselteç (×11)', cat: 'analog' },
    { id: 'astable-flasher.glb', title: '2-transistör astable flaşör', cat: 'discrete' },
    { id: 'chaser-4017.glb', title: '555+4017 · 10-LED şelale', cat: 'dijital' },
    { id: 'shift-register.glb', title: '74HC595 · 8-LED shift register', cat: 'dijital' },
    { id: 'ne555-blinker.glb', title: 'NE555 · blinker', cat: 'analog' },
    { id: 'mosfet-switch.glb', title: 'MOSFET anahtar + flyback', cat: 'anahtarlama' },
    { id: 'regulator-5v.glb', title: '7805 · 5V regülatör', cat: 'güç' },
];

const TARGET = 40; // world units on largest side
/** Wall-clock seconds for one pass through a run, whatever its own span. See SimulationOverlay.loopSeconds. */
const SIM_LOOP_SECONDS = 6;

/** drei caches by the exact string handed to useGLTF, so the preload and the component have to build
 *  the URL the same way. They did not: the preload asked for a leading-slash path while the component
 *  asked for a bare filename, which made the preload dead code and downloaded every board twice. */
const boardUrl = (id: string): string => `/${id}`;
/** The layout + simulation companions gen-gallery emits beside each GLB, keyed off the same board id. */
const boardDataUrl = (id: string, ext: string): string => `/${id.replace(/\.glb$/, '')}.${ext}`;

// The GLB carries no emitter colour — KiCad's LED_D5.0mm STEP is a neutral epoxy dome — so a colour
// has to be chosen. Red is the modal 5mm indicator LED by a wide margin, so it is the least-wrong
// default, and it is the one that reads against a green board. Varying it per position was an earlier
// choice here; it invented information the file does not carry, and on a board of identical LEDs it is
// simply wrong. One colour, stated as an assumption.
const LED_COLOR = '#e8342a';

/* ------------------------------------------------------------------ */
/* Procedural orange-peel normal map (sprayed LPI lacquer micro-dimple) */
/* ------------------------------------------------------------------ */
function makeOrangePeelNormal(): THREE.CanvasTexture | null {
    if (typeof document === 'undefined') return null;
    const S = 256;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const h = new Float32Array(S * S);
    const rnd = (n: number) => {
        const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
        return x - Math.floor(x);
    };
    const grid = (gx: number, gy: number, g: number) => rnd((gx % g) + (gy % g) * g * 7.13 + g * 131);
    const sample = (x: number, y: number, cell: number) => {
        const g = S / cell;
        const gx = Math.floor(x / cell),
            gy = Math.floor(y / cell);
        const fx = (x % cell) / cell,
            fy = (y % cell) / cell;
        const sx = fx * fx * (3 - 2 * fx),
            sy = fy * fy * (3 - 2 * fy);
        const a = grid(gx, gy, g),
            b = grid(gx + 1, gy, g),
            d = grid(gx, gy + 1, g),
            e = grid(gx + 1, gy + 1, g);
        return a + (b - a) * sx + (d - a) * sy + (a - b - d + e) * sx * sy;
    };
    for (let y = 0; y < S; y++)
        for (let x = 0; x < S; x++) h[y * S + x] = 0.7 * sample(x, y, 8) + 0.3 * sample(x, y, 4);
    const img = ctx.createImageData(S, S);
    const at = (x: number, y: number) => h[((y + S) % S) * S + ((x + S) % S)];
    for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
            const n = new THREE.Vector3(
                (at(x - 1, y) - at(x + 1, y)) * 2,
                (at(x, y - 1) - at(x, y + 1)) * 2,
                1,
            ).normalize();
            const i = (y * S + x) * 4;
            img.data[i] = (n.x * 0.5 + 0.5) * 255;
            img.data[i + 1] = (n.y * 0.5 + 0.5) * 255;
            img.data[i + 2] = (n.z * 0.5 + 0.5) * 255;
            img.data[i + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    // ensurePlanarUV maps whatever it is given across 0..1, so a fixed repeat count stretches the dimple
    // to a different physical size on every board. The mask sheet is re-scaled per board in
    // ensurePlanarUV instead; this stays at 1 so the two are not multiplied.
    t.repeat.set(1, 1);
    return t;
}

/* ------------------------------------------------------------------ */
/* Physically-grounded PCB layer materials (named for the inspector).  */
/* ------------------------------------------------------------------ */
function buildLayerMaterials(peel: THREE.CanvasTexture | null) {
    /**
     * Solder mask is NOT a translucent sheet.
     *
     * It was modelled as one — a dark green plane at opacity 0.5 over the tan laminate — and that is why
     * the board came out khaki. Alpha blending is a lerp toward whatever is behind it, so it can only ever
     * average two colours; it cannot act as a filter. Physically the mask is translucent the way house
     * paint is: a highly-pigmented layer whose own colour dominates. Verified directly in the running
     * viewer — with the laminate temporarily set to magenta the board rendered magenta, proving the mask
     * was contributing almost nothing.
     *
     * So the mask is opaque and carries the board's colour. The copper underneath is a separate mesh at a
     * lower height; a small alpha keeps a hint of it, which is the single strongest cue that this is a
     * real board rather than a green slab.
     */
    const mask = new THREE.MeshPhysicalMaterial({
        color: '#0e6b36', // mask over BARE laminate — the field between traces
        roughness: 0.45,
        metalness: 0,
        // The cured-resin/air interface — what makes the surface read as a PCB rather than as paint.
        // At clearcoat 1.0 / roughness 0.16 grazing Fresnel drove the coat to near-total reflectance and
        // the whole near half of the board rendered as polished aluminium: measured saturation fell 0.88
        // face-on to 0.22 at a shallow angle. Halved and broadened, it keeps the gloss and loses the foil.
        clearcoat: 0.5,
        clearcoatRoughness: 0.3,
        // The orange-peel dimple is a property of the AIR interface, not of the pigment body, so it
        // belongs on the clearcoat normal. On the base lobe it perturbed the diffuse shading instead,
        // which is the wrong surface entirely.
        clearcoatNormalMap: peel ?? undefined,
        clearcoatNormalScale: new THREE.Vector2(0.1, 0.1),
        ior: 1.56,
        transparent: false,
        opacity: 1,
        side: THREE.DoubleSide, // zero-thickness sheet; the exporter's winding is not guaranteed
        envMapIntensity: 0.9,
    });
    /** The underside sheet, which must NOT receive the top sheet's geometric offset. Same look. */
    const maskBottom = mask.clone();
    /**
     * This mesh is not bare copper — it is the SAME solder mask, seen over a brighter backscatterer.
     *
     * With the mask sheet dropped below the copper crowns (see mergeDrawCalls), the copper prisms are
     * what is visible wherever a trace runs, so their material has to be "mask over copper": lighter
     * and slightly warmer than the field, because the coating drains thinner off trace tops and copper
     * bounces back more light than dull laminate. It stays a dielectric at metalness 0 — the mask is a
     * turbid, particle-filled medium and a double pass through it destroys the metal's directionality.
     * The clearcoat must match the field's exactly or every trace edge grows a visible gloss seam.
     */
    const copper = new THREE.MeshPhysicalMaterial({
        color: '#22954b',
        metalness: 0,
        roughness: 0.5,
        clearcoat: 0.5,
        clearcoatRoughness: 0.3, // must match the field exactly, or every trace edge grows a gloss seam
        ior: 1.56,
        envMapIntensity: 0.9,
    });
    /** ENIG: immersion gold over nickel. A real metal — no clearcoat, that is a second stacked lobe. */
    /** ENIG — the only exposed metal on these boards, so it carries a lot of the realism budget. In a
     *  metalness-1 workflow the base colour IS F0, so this must be measured gold reflectance rather than
     *  a palette swatch. Satin, not mirror: the thin electroless nickel never levels the etched copper. */
    const pad = new THREE.MeshPhysicalMaterial({
        color: '#ffe0a0',
        metalness: 1,
        roughness: 0.3,
        envMapIntensity: 1.15,
    });
    /** Silkscreen ink. Opaque: at 0.92 over an opaque green mask the lerp pulled the white toward the
     *  board and turned it a dirty grey-green — the warmth belongs in the base colour instead. Never pure
     *  white, which reads as emissive. */
    const silk = new THREE.MeshPhysicalMaterial({
        color: '#eae7de',
        metalness: 0,
        roughness: 0.82,
        specularIntensity: 0.45, // faint epoxy-binder sheen — dialled here, not with a clearcoat
        transparent: false,
        opacity: 1,
        side: THREE.DoubleSide,
        envMapIntensity: 0.85,
    });
    /** Bare FR4 as seen at the ROUTED EDGE — lighter and warmer than the masked face, and slightly
     *  fibrous. It is never glossy: the router leaves cut glass fibre, not a coated surface. */
    /**
     * Once the mask plane covers the core's top face this is a RIM material: the routed edge, the drill
     * barrels, and the thin bare-laminate rings inside pad openings. That is exactly where tan FR4 is
     * correct. No normal map — ensurePlanarUV runs per PRIMITIVE and board_PCB is eight of them, so each
     * face would get its own arbitrary 0..1 mapping. specularIntensity stays at 1: the grazing Fresnel
     * rim along the 1.6 mm edge is most of what makes it read as a hard material rather than cardboard.
     */
    const pcb = new THREE.MeshPhysicalMaterial({
        color: '#c9b98a',
        metalness: 0,
        roughness: 0.78,
        ior: 1.55,
        envMapIntensity: 0.45,
    });
    mask.name = 'Soldermask (maske)';
    maskBottom.name = 'Soldermask (alt yüz)';
    copper.name = 'Bakır izler (maske altı)';
    pad.name = 'Pad (ENIG altın)';
    silk.name = 'Silkscreen (baskı)';
    pcb.name = 'FR4 (kart gövdesi)';
    return { mask, maskBottom, copper, via: copper, pad, silk, pcb } as const;
}
type LayerMats = ReturnType<typeof buildLayerMaterials>;

type Layer = 'copper' | 'via' | 'pad' | 'soldermask' | 'silkscreen' | 'pcb' | 'part';

/**
 * KiCad names the board's own layer meshes `board_copper`, `board_pad`, `board_via`, `board_silkscreen`,
 * `board_soldermask` and `board_PCB`. Everything else is a component body.
 *
 * The prefix is required, not merely matched. Substring matching over the whole name reads a real KiCad
 * footprint like `TestPoint_Pad_D1.0mm` or `SolderWirePad_1x01` as the board's pad layer and paints the
 * whole part ENIG gold — a component silently rendered as bare copper.
 */
function layerOf(name: string): Layer {
    const m = /^board_(copper|pad|via|silkscreen|soldermask|pcb)$/i.exec(name.trim());
    return m ? (m[1]!.toLowerCase() as Layer) : 'part';
}

/**
 * Recover the mesh name the glTF actually carries.
 *
 * three.js's GLTFLoader OVERWRITES `Object3D.name` with the glTF NODE name whenever the node has one
 * (GLTFLoader `loadNode`: `node.name = nodeName`). KiCad names its board-layer nodes `=>[0:1:1:16]` —
 * internal path tokens — while the descriptive name (`board_soldermask`) lives on the MESH. So reading
 * `mesh.name` gets the path token, every board layer classifies as 'part', and not one of them ever
 * receives its material: the soldermask renders through the component-body resolver, which keeps glTF's
 * default `metalness: 1`, so the board ships as a slab of green metal. That single line is most of why
 * these renders do not look like circuit boards.
 *
 * `parser.associations` is the loader's sanctioned Object3D → glTF-index map; it is how the mesh name is
 * recovered without depending on any loader internal. Falls back to the object's own name so the viewer
 * still works if a future loader version stops populating it.
 */
function meshNames(scene: THREE.Object3D, parser?: GltfParser): Map<THREE.Object3D, string> {
    const names = new Map<THREE.Object3D, string>();
    scene.traverse((o) => {
        const idx = parser?.associations?.get(o)?.meshes;
        const fromGltf = idx === undefined ? undefined : parser?.json?.meshes?.[idx]?.name;
        names.set(o, fromGltf ?? o.name);
    });
    return names;
}

/** The slice of three.js's GLTFParser this file relies on (drei types `gltf.parser` loosely). */
type GltfParser = {
    associations?: Map<THREE.Object3D, { meshes?: number }>;
    json?: { meshes?: Array<{ name?: string }> };
};

/** Component-body materials, decided by color DATA (not per-part rules); cached to keep sharing/merge intact. */
function makePartResolver() {
    const cache = new Map<string, THREE.Material>();
    return (mat: THREE.MeshStandardMaterial): THREE.Material => {
        if (!mat?.isMaterial || !mat.color) return mat;
        const hit = cache.get(mat.uuid);
        if (hit) return hit;
        const { r, g, b } = mat.color;
        const mx = Math.max(r, g, b),
            mn = Math.min(r, g, b);
        const relSat = mx > 0 ? (mx - mn) / mx : 0;
        let out: THREE.Material = mat;
        if (mx < 0.06) {
            out = new THREE.MeshPhysicalMaterial({
                color: '#17171a',
                roughness: 0.5,
                metalness: 0,
                clearcoat: 0.12,
                clearcoatRoughness: 0.5,
                envMapIntensity: 1,
            });
            out.name = 'IC epoksi (mat siyah)';
        } else if (relSat < 0.22 && mx > 0.5) {
            out = new THREE.MeshPhysicalMaterial({
                color: '#c8ccd0',
                metalness: 1,
                roughness: 0.3,
                envMapIntensity: 1.2,
            });
            out.name = 'Metal terminal';
        } else if (mx > 0.55 && r >= g && g > b && relSat < 0.55) {
            // Gold plating is a WARM metal, so it never passes a desaturation test — the header pins were
            // falling through to the generic coloured-part branch and rendering as matte tan sticks, which
            // is the loudest wrong object on the connector boards. Hue order r ≥ g > b with a moderate
            // saturation is what separates gold from an orange plastic.
            out = new THREE.MeshPhysicalMaterial({
                color: '#e8c179',
                metalness: 1,
                roughness: 0.32,
                envMapIntensity: 1.2,
            });
            out.name = 'Altın kaplama pin';
        } else {
            // Coloured bodies: epoxy, plastic housings, LED lenses, capacitor sleeves. None of them are
            // metal — but KiCad's 3D models omit `metallicFactor`, and the glTF spec says an absent factor
            // DEFAULTS TO 1, so the loader hands us fully-metallic plastic. A metal that is neither white
            // nor mirror-smooth renders almost black under image-based lighting, which is why our red LEDs
            // and brown electrolytics came out as dark blobs. Only this branch is corrected: the two above
            // build their own materials and mean the metalness they set.
            mat.metalness = 0;
            if (mat.roughness != null) mat.roughness = Math.min(mat.roughness, 0.6);
            mat.envMapIntensity = Math.max(mat.envMapIntensity ?? 1, 1);
            mat.name = `Parça (#${mat.color.getHexString()})`;
            mat.needsUpdate = true;
        }
        cache.set(mat.uuid, out);
        return out;
    };
}

function attrSig(geo: THREE.BufferGeometry): string {
    return Object.keys(geo.attributes).sort().join(',') + (geo.index ? '+i' : '');
}
/** Board-plan size, in the GLB own units (metres), that one tile of the micro-texture covers. */
const PEEL_TILE_M = 0.006;

function ensurePlanarUV(geo: THREE.BufferGeometry) {
    if (geo.attributes.uv) return;
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    if (!bb) return;
    const size = new THREE.Vector3();
    bb.getSize(size);
    const dims: Array<'x' | 'y' | 'z'> = ['x', 'y', 'z'];
    dims.sort((a, b) => size[b] - size[a]);
    const [u, v] = dims;
    const pos = geo.attributes.position;
    const uv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
        const p = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
        // In TILES of a fixed physical size, not normalised 0..1. Normalising stretched one tile of
        // micro-texture across the whole board, so the dimple was a different physical size on every
        // board — and on the long thin ones it read as crumpled foil rather than sprayed lacquer.
        uv[i * 2] = (p[u] - bb.min[u]) / PEEL_TILE_M;
        uv[i * 2 + 1] = (p[v] - bb.min[v]) / PEEL_TILE_M;
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/**
 * LEDs: the pipeline injects KiCad's REAL 5 mm domed LED body (LED_D5.0mm). The STEP is a neutral
 * epoxy dome, so we tint it as a lit, glassy, colored emitter — color varies by board position for a
 * lively board. This only RESTYLES the real geometry; nothing is synthesized or moved.
 */
function makeLedResolver() {
    const cache = new Map<string, THREE.Material>();
    return (): THREE.Material => {
        const color = LED_COLOR;
        let m = cache.get(color);
        if (!m) {
            m = new THREE.MeshPhysicalMaterial({
                color,
                emissive: color,
                // A lit indicator LED is not a uniformly glowing solid: the epoxy dome still carries a sharp specular
                // highlight from the room. Flooding the surface with emission erases it and the part reads as
                // moulded plastic. Kept just above the bloom threshold so the glow survives, no higher.
                emissiveIntensity: 1.25,
                // No transmission. It routes the material through three's transmission pass, where the
                // dome loses the sharp environment specular that makes it read as moulded epoxy rather
                // than as painted plastic. A lit LED does not need refraction to be convincing; it needs
                // a hard highlight and a glow.
                ior: 1.5,
                roughness: 0.22,
                metalness: 0,
                clearcoat: 1,
                clearcoatRoughness: 0.06,
                envMapIntensity: 1,
                transparent: true,
            });
            m.name = `LED (${color})`;
            cache.set(color, m);
        }
        return m;
    };
}

function assignMaterials(meshes: THREE.Mesh[], layerMats: LayerMats, nameOf: (m: THREE.Object3D) => string) {
    const resolvePart = makePartResolver();
    const resolveLed = makeLedResolver();
    // The board mid-plane in glTF units (metres): the core spans 0 … 1.510 mm.
    const MID_Y = 0.000755;
    const centre = new THREE.Vector3();
    const byLayer: Partial<Record<Layer, THREE.Material>> = {
        soldermask: layerMats.mask,
        copper: layerMats.copper,
        via: layerMats.via,
        pad: layerMats.pad,
        silkscreen: layerMats.silk,
        pcb: layerMats.pcb,
    };
    for (const m of meshes) {
        m.castShadow = true;
        m.receiveShadow = true;
        // The exporter marks solids double-sided, which doubles the fragment work and lets back faces
        // fight the front ones in the depth prepass. The two zero-thickness sheets opt back in via their
        // own materials.
        const src0 = Array.isArray(m.material) ? m.material[0] : m.material;
        if (src0) src0.side = THREE.FrontSide;
        const name = nameOf(m);
        // KiCad footprint names are underscore-delimited (`LED_D5.0mm`, `LED_0603_1608Metric`), so LED is
        // matched as a token. A bare substring test would also claim anything that merely contains the
        // letters and hand it a glowing emissive dome.
        if (/(^|[-_])led([-_]|$)/i.test(name)) {
            // The imported mesh is the whole part — epoxy dome, flange AND metal leads — so handing the
            // emissive material to all of it made the leads glow like hot wire. The epoxy is the coloured
            // sub-material; anything desaturated is metal and goes through the ordinary part path.
            const src = m.userData.__origMat ?? m.material;
            m.userData.__origMat = src;
            const isEpoxy = (mt: THREE.MeshStandardMaterial) => {
                const c = mt?.color;
                if (!c) return true;
                const mx = Math.max(c.r, c.g, c.b);
                const mn = Math.min(c.r, c.g, c.b);
                return mx > 0 && (mx - mn) / mx > 0.25;
            };
            // Non-epoxy sub-materials are the LEAD FRAME, and they must not go through the generic part
            // resolver: its dark branch would paint them as black IC epoxy. A lead is bare tinned metal.
            const lead = layerMats.pad;
            m.material = Array.isArray(src)
                ? src.map((mt) => (isEpoxy(mt as THREE.MeshStandardMaterial) ? resolveLed() : lead))
                : isEpoxy(src as THREE.MeshStandardMaterial)
                  ? resolveLed()
                  : lead;
            continue;
        }
        const layer = layerOf(name);
        // `board_soldermask` is TWO sheets, top and bottom. They must not share a material instance:
        // the top one gets a geometric offset below, and merging is keyed by material identity.
        if (layer === 'soldermask') {
            // By GEOMETRY, not by node origin. KiCad writes both mask sheets as UNTRANSFORMED nodes at
            // the origin and bakes the height into the vertex data, so `getWorldPosition().y` returns 0
            // for both — the earlier test put the top sheet in the bottom bucket, left `layerMats.mask`
            // attached to nothing, and made the 30 µm drop below unreachable. The board rendered with
            // every trace still buried under an opaque sheet, and it read as a plain green plane.
            if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
            m.geometry.boundingBox!.getCenter(centre);
            m.localToWorld(centre);
            m.material = centre.y > MID_Y ? layerMats.mask : layerMats.maskBottom;
            continue;
        }
        const lm = byLayer[layer];
        if (lm) m.material = lm;
        else if (Array.isArray(m.material))
            m.material = m.material.map((mt) => resolvePart(mt as THREE.MeshStandardMaterial));
        else m.material = resolvePart(m.material as THREE.MeshStandardMaterial);
    }
}

/**
 * Layer heights measured in every board GLB (glTF units are metres; identical across all eight):
 *
 *     FR4 core top      1.510 mm
 *     copper top        1.545 mm   (35 µm)
 *     pad top           1.550 mm
 *     soldermask plane  1.560 mm   ← zero thickness, sitting 15 µm ABOVE the copper
 *     silkscreen plane  1.585 mm
 *
 * The mask sheet covering the copper is the whole reason it was drawn at opacity 0.5: transparency was
 * standing in for "let me see the layer underneath". That is a lerp toward the backdrop, and it is why
 * the board rendered khaki over tan laminate.
 *
 * Dropping the sheet 30 µm replaces the trick with the real thing. The copper then stands 15 µm proud
 * of the field, so every trace gets an actual shoulder — the exporter writes closed prisms, side walls
 * included — and that shoulder catches the clearcoat highlight. It is the relief a normal map is
 * usually faked to imitate, except here it is geometry, so it self-shadows and occludes correctly.
 */
const MASK_DROP_M = 0.00003;
const SILK_DROP_M = 0.00002;

function mergeDrawCalls(
    scene: THREE.Group,
    meshes: THREE.Mesh[],
    nameOf: (m: THREE.Object3D) => string,
    layerMats: LayerMats,
) {
    try {
        const buckets = new Map<
            string,
            { geos: THREE.BufferGeometry[]; mat: THREE.Material; layer: string; sources: THREE.Mesh[] }
        >();
        for (const m of meshes) {
            if (Array.isArray(m.material)) continue;
            const geo = m.geometry.clone();
            geo.applyMatrix4(m.matrixWorld);
            const layer = layerOf(nameOf(m));
            if (layer === 'soldermask' || layer === 'pcb') ensurePlanarUV(geo);
            const key = `${m.material.uuid}|${attrSig(geo)}`;
            let b = buckets.get(key);
            if (!b) {
                b = { geos: [], mat: m.material, layer, sources: [] };
                buckets.set(key, b);
            }
            b.geos.push(geo);
            b.sources.push(m);
        }
        const merged: THREE.Mesh[] = [];
        const consumed: THREE.Mesh[] = [];
        for (const { geos, mat, layer, sources } of buckets.values()) {
            const g = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
            if (!g) throw new Error('mergeGeometries returned null');
            const mm = new THREE.Mesh(g, mat);
            mm.name = `merged_${layer}`;
            // Applied to the merged mesh rather than baked into the vertices so it stays legible, and
            // because this lives inside the GLB scene — before the fit-to-view scale — the offset is
            // carried through that scale and stays physically proportional on every board.
            if (mat === layerMats.mask) mm.position.y = -MASK_DROP_M;
            else if (mat === layerMats.silk) mm.position.y = -SILK_DROP_M;
            mm.castShadow = true;
            mm.receiveShadow = true;
            merged.push(mm);
            consumed.push(...sources);
        }
        for (const s of consumed) s.removeFromParent();
        for (const mm of merged) scene.add(mm);
    } catch (e) {
        console.warn('[pcb-viewer] geometry merge skipped:', e);
    }
}

export type MatEntry = { id: string; label: string; mat: THREE.MeshPhysicalMaterial };
function collectMaterials(scene: THREE.Group): MatEntry[] {
    const seen = new Map<string, MatEntry>();
    scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (const raw of mats) {
            const mat = raw as THREE.MeshPhysicalMaterial;
            if (!mat?.isMaterial || seen.has(mat.uuid)) continue;
            const label = mat.name || `#${mat.color?.getHexString?.() ?? 'mat'}`;
            seen.set(mat.uuid, { id: mat.uuid, label, mat });
        }
    });
    return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function processScene(scene: THREE.Group, layerMats: LayerMats, parser?: GltfParser): MatEntry[] {
    if (!scene.userData.__pcbProcessed) {
        scene.userData.__pcbProcessed = true;
        scene.updateWorldMatrix(true, true);
        // Resolved once, before anything mutates the graph — mergeDrawCalls removes the source meshes.
        const names = meshNames(scene, parser);
        const nameOf = (o: THREE.Object3D) => names.get(o) ?? o.name;
        const meshes: THREE.Mesh[] = [];
        scene.traverse((o) => {
            const m = o as THREE.Mesh;
            if (m.isMesh && m.geometry) meshes.push(m);
        });
        assignMaterials(meshes, layerMats, nameOf);
        mergeDrawCalls(scene, meshes, nameOf, layerMats);
    }
    return collectMaterials(scene);
}

function Board({
    url,
    layerMats,
    onMaterials,
    sim,
    playing,
    onTime,
}: Readonly<{
    url: string;
    layerMats: LayerMats;
    onMaterials: (m: MatEntry[]) => void;
    /** The board's own simulation, when one has been loaded. The overlay is a CHILD of the same group as
     *  the GLB, so it inherits the orientation, the fit scale and the seating offset for free — nothing
     *  re-derives the board's placement, and nothing can drift out of alignment with it. */
    sim?: { playback: Playback; layout: BoardLayout; flow: FlowTable | null } | null;
    playing: boolean;
    onTime?: (t: number) => void;
}>) {
    const { scene, parser } = useGLTF(url);
    const camera = useThree((st) => st.camera);
    const controls = useThree((st) => st.controls);
    const size = useThree((st) => st.size);
    const group = useRef<THREE.Group>(null);
    const [slabLocal, setSlabLocal] = useState<THREE.Box3 | null>(null);

    // The board's own rectangle, in the render and in millimetres, is the same rectangle — so the mapping
    // between them is a division, not a constant. Recomputed only when the board or its layout changes.
    const fit = useMemo<BoardFit | null>(
        () => (slabLocal && sim ? fitFromSlab(slabLocal, sim.layout.geometry.board) : null),
        [slabLocal, sim],
    );

    useLayoutEffect(() => {
        const g = group.current;
        if (!g) return;
        const mats = processScene(scene, layerMats, parser as GltfParser | undefined);
        onMaterials(mats);

        g.rotation.set(0, 0, 0);
        g.scale.setScalar(1);
        g.position.set(0, 0, 0);
        g.updateWorldMatrix(true, true);

        // Orientation comes from the LAMINATE, never from the whole scene. The core is 1.510 mm thick
        // against ~25 mm in plan, so its own thinnest axis names the board normal without ambiguity.
        // Inferring it from the scene bounding box let a tall part vote: regulator-5v carries a TO-220
        // whose model spans −8.15 … +20.37 mm, which made the scene taller than it was wide and stood
        // the whole board up on its edge like a wall.
        const slab = boardSlab(g);
        // Captured HERE, while the group is still identity, so it is expressed in the frame the overlay —
        // a sibling of the GLB inside this same group — will be drawn in. Read it after the transforms
        // below and it would be in world space, and the overlay would inherit the fit twice.
        setSlabLocal(slab ? slab.clone() : null);
        const rs = new THREE.Vector3();
        (slab ?? new THREE.Box3().setFromObject(g)).getSize(rs);
        if (rs.z <= rs.x && rs.z <= rs.y) g.rotation.x = -Math.PI / 2;
        else if (rs.x <= rs.y && rs.x <= rs.z) g.rotation.z = Math.PI / 2;

        g.updateWorldMatrix(true, true);
        // Frame the LAMINATE's footprint. Scaling to the whole scene let a tall part decide how big the
        // board is: the 7805's heatsink tab is 20 mm over a 25 mm board, so that one component pushed the
        // board to a third of its proper size and ran off the top of the viewport.
        const plan = boardSlab(g) ?? new THREE.Box3().setFromObject(g);
        const size = new THREE.Vector3();
        plan.getSize(size);
        g.scale.setScalar(TARGET / (Math.max(size.x, size.z) || 1));
        g.updateWorldMatrix(true, true);
        const box2 = new THREE.Box3().setFromObject(g);
        const center = new THREE.Vector3();
        box2.getCenter(center);
        g.position.x -= center.x;
        g.position.z -= center.z;
        // Seat the LAMINATE on the floor, not the whole scene: the scene's lowest point is the tip of a
        // through-hole lead, which was holding every board ~1.4 mm in the air on its own pins.
        const seated = boardSlab(g);
        g.position.y -= (seated ?? box2).min.y;

        // Then move the CAMERA to fit, instead of shrinking the board until its tallest part happens to
        // fit a fixed camera. Every board keeps the same physical presence in frame, and a 20 mm heatsink
        // tab on a 25 mm board simply pushes the camera back rather than making the board tiny.
        g.updateWorldMatrix(true, true);
        const fitted = new THREE.Box3().setFromObject(g);
        const sphere = fitted.getBoundingSphere(new THREE.Sphere());
        // Fit to whichever axis is TIGHTER. Sizing off the vertical field of view alone fits the board
        // top-to-bottom and lets a narrow or portrait window crop it left and right, while every internal
        // measure still reports a perfect fit.
        const persp = camera as THREE.PerspectiveCamera;
        const vFov = ((persp.fov ?? 34) * Math.PI) / 180;
        const hFov = 2 * Math.atan(Math.tan(vFov / 2) * (persp.aspect || 1));
        const dist = (sphere.radius / Math.sin(Math.min(vFov, hFov) / 2)) * 1.06;
        const dir = camera.position.clone().sub(sphere.center).normalize();
        camera.position.copy(sphere.center).addScaledVector(dir, dist);
        camera.lookAt(sphere.center);
        const orbit = controls as { target?: THREE.Vector3; update?: () => void } | null;
        if (orbit?.target) {
            orbit.target.copy(sphere.center);
            orbit.update?.();
        }
        // The viewport is a dependency: without it a resize leaves the camera framing the old aspect.
    }, [scene, parser, layerMats, onMaterials, camera, controls, size.width, size.height]);

    return (
        <group ref={group}>
            <primitive object={scene} />
            {sim && fit && (
                <SimulationOverlay
                    traces={sim.layout.geometry.traces}
                    playback={sim.playback}
                    flow={sim.flow}
                    fit={fit}
                    playing={playing}
                    loopSeconds={SIM_LOOP_SECONDS}
                    voltAnchor={voltAnchorFor(sim.playback)}
                    onTime={onTime}
                />
            )}
        </group>
    );
}

/**
 * Board millimetres → the frame the GLB is drawn in, registered corner-to-corner against the laminate.
 *
 * glTF is Y-up by specification, so KiCad's export puts the board plane on XZ with Y as the normal — the
 * same reason the fit code above tests the slab's thinnest axis. The board OUTLINE and the laminate are
 * the same rectangle expressed in two units, so mapping one onto the other gives scale and origin exactly.
 *
 * The outline is used rather than widthMm/heightMm because the board frame is NOT centred on its origin:
 * shift-register spans x −26.084 … 23.02 on a 49.104 mm board. Centring on width/2 put its copper half a
 * board off, and every trace still landed on the laminate — a wrong answer that looks right.
 *
 * `ySign` is the one bit geometry cannot supply — a rectangle is a rectangle either way round — so it is
 * DERIVED from the pipeline rather than eyeballed, in two measured steps:
 *
 *   1. pcb-core's .kicad_pcb writer negates Y against the LayoutGeometry frame this file consumes. Fitting
 *      the two component sets across every gallery board leaves a pure translation (spread 0.0000 mm) only
 *      when Y is negated; taking Y as-is leaves spreads of 42–80 mm.
 *   2. `scripts/verify-3d-alignment.mjs` resolves the .kicad_pcb → GLB mapping by trying every axis
 *      permutation and flip, and lands on x+/z+ ×0.001 at 0.000 mm worst offset on all eight boards.
 *
 * Composing them: LayoutGeometry +Y → −Z. Step 1 is asserted by that same script, so a writer that ever
 * stops negating Y fails the gate instead of silently mirroring this overlay.
 */
const BOARD_Y_ALONG_Z = -1;
function fitFromSlab(slab: THREE.Box3, board: BoardLayout['geometry']['board']): BoardFit | null {
    const xs = board.outline?.map((p) => p.x) ?? [];
    const ys = board.outline?.map((p) => p.y) ?? [];
    if (xs.length === 0 || ys.length === 0) return null;
    const bx0 = Math.min(...xs);
    const by0 = Math.min(...ys);
    const bw = Math.max(...xs) - bx0;
    const bh = Math.max(...ys) - by0;
    const size = new THREE.Vector3();
    slab.getSize(size);
    if (!(size.x > 0 && size.z > 0 && bw > 0 && bh > 0)) return null;

    const scaleX = size.x / bw;
    const scaleZ = size.z / bh;
    return {
        scaleX,
        scaleZ,
        ySign: BOARD_Y_ALONG_Z,
        // Where board (0,0) lands, having pinned the outline's low corner to the matching slab edge.
        originX: slab.min.x - bx0 * scaleX,
        originZ: BOARD_Y_ALONG_Z > 0 ? slab.min.z - by0 * scaleZ : slab.max.z + by0 * scaleZ,
        // Just clear of the laminate's top face: the overlay is a coat of light ON the copper, and drawing
        // it coplanar would z-fight with the copper layer the GLB already carries.
        surfaceY: slab.max.y + size.y * 0.06,
    };
}

/**
 * The volts each leg of the diverging colour map spans, snapped to a REAL rail.
 *
 * Not auto-scaled to the board's own maximum. Falstad hard-clamps at 5 V and never says so, which renders
 * a 12 V rail and a 400 V rail identically; Altium's percentage-of-max scale is the documented reason a
 * healthy board and a failing one look the same there. Snapping to a standard rail keeps two different
 * boards comparable, and a net beyond the anchor saturates visibly rather than silently rescaling
 * everything else.
 */
const RAILS = [1, 1.8, 3.3, 5, 12, 15, 24, 48];
function voltAnchorFor(playback: Playback): number {
    const peak = Math.max(Math.abs(playback.min), Math.abs(playback.max));
    return RAILS.find((r) => r >= peak) ?? Math.ceil(peak);
}

/** World-space bounds of the laminate alone (the merged board_PCB), or null if it is not there. */
function boardSlab(root: THREE.Object3D): THREE.Box3 | null {
    let found: THREE.Object3D | null = null;
    root.traverse((o) => {
        if (!found && (o as THREE.Mesh).isMesh && o.name === 'merged_pcb') found = o;
    });
    return found ? new THREE.Box3().setFromObject(found) : null;
}

/**
 * three r169 dropped WebGL1 entirely, so on a blocklisted GPU, a locked-down browser or a machine with
 * software rendering disabled, `new WebGLRenderer` throws — and it throws from inside the Canvas, taking
 * the whole React tree down with it. The page went completely blank: no canvas, no message, no board
 * list, just an uncaught error retried in a loop. The chips and the caption are plain DOM siblings and
 * have no reason to die with the renderer.
 */
class CanvasBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
    constructor(props: { children: ReactNode }) {
        super(props);
        this.state = { failed: false };
    }
    static getDerivedStateFromError() {
        return { failed: true };
    }
    render() {
        if (!this.state.failed) return this.props.children;
        return (
            <div
                style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'grid',
                    placeItems: 'center',
                    padding: 32,
                    textAlign: 'center',
                    color: '#9fb3a8',
                    font: '14px/1.7 ui-monospace, monospace',
                }}
            >
                <div>
                    <div style={{ fontSize: 15, color: '#cfe0d6', marginBottom: 8 }}>3B görünüm açılamadı</div>
                    Bu tarayıcıda WebGL 2 kullanılamıyor. Donanım hızlandırmayı açmayı veya güncel bir masaüstü tarayıcı
                    kullanmayı deneyin.
                </div>
            </div>
        );
    }
}

function Floor() {
    return (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} receiveShadow>
            <planeGeometry args={[600, 600]} />
            {/* A black shadow on a black floor carries no information, which is the real reason the board
                looked like it was floating. Lifting the ground gives the contact shadow something to be
                darker THAN. */}
            {/* envMapIntensity 0.15 rendered this at luminance 18 — darker than the sky behind it, so a
                shadow on it had nothing to be darker THAN. */}
            <meshStandardMaterial color="#262b2e" roughness={0.92} metalness={0} envMapIntensity={0.5} />
        </mesh>
    );
}

/* --------- adjustable light rig --------- */
export type LightState = { intensity: number; azimuth: number; elevation: number; color: string; exposure: number };
// A single hard directional source against a clearcoat at roughness 0.10 puts a very tight, very
// intense highlight on the board and blows out whichever corner it lands on. The environment now
// carries most of the illumination, so the key light only has to shape and cast the contact shadow.
const DEFAULT_LIGHT: LightState = { intensity: 2.4, azimuth: 35, elevation: 58, color: '#fff4e6', exposure: 1.05 };

function lightPos(l: LightState): [number, number, number] {
    const el = (l.elevation * Math.PI) / 180,
        az = (l.azimuth * Math.PI) / 180,
        R = 60;
    return [R * Math.cos(el) * Math.cos(az), R * Math.sin(el), R * Math.cos(el) * Math.sin(az)];
}

function Exposure({ value }: Readonly<{ value: number }>) {
    const gl = useThree((s) => s.gl);
    useLayoutEffect(() => {
        gl.toneMappingExposure = value;
    }, [gl, value]);
    return null;
}

/**
 * Development-only inspection hook: publishes the live scene, renderer and camera on `window.__viewer`.
 *
 * This exists because judging a render from its source is unreliable — every realism claim in this
 * viewer that was checked by reading the code rather than by querying the running scene turned out to
 * be wrong about something (a material that was never assigned, a post-processing chain whose shader
 * does not compile). A headless Chrome driving this page can now ask what is actually there.
 *
 * Mounted only outside production (gated at the call site), so a production bundle neither exposes the
 * handle nor pays for the subscription.
 */
function DevInspect() {
    const { scene, gl, camera } = useThree();
    useEffect(() => {
        if (process.env.NODE_ENV === 'production') return;
        (window as unknown as { __viewer?: unknown }).__viewer = { scene, gl, camera, THREE };
        return () => {
            delete (window as unknown as { __viewer?: unknown }).__viewer;
        };
    }, [scene, gl, camera]);
    return null;
}

export type ShadowState = { enabled: boolean; radius: number; intensity: number; bias: number };
const DEFAULT_SHADOW: ShadowState = { enabled: true, radius: 3, intensity: 0.9, bias: -0.0004 };

function Rig({ light, shadow }: Readonly<{ light: LightState; shadow: ShadowState }>) {
    const p = lightPos(light);
    return (
        <>
            <Exposure value={light.exposure} />
            <hemisphereLight intensity={0.12} groundColor="#0a0a08" />
            {/* Key: the only shadow caster. Its frustum reaches ±45 because the board's half-diagonal is
                about 28 world units and ±30 was clipping the shadow at the corners. */}
            <directionalLight
                castShadow={shadow.enabled}
                color={light.color}
                position={p}
                intensity={light.intensity}
                shadow-mapSize={[2048, 2048]}
                shadow-blurSamples={25}
                shadow-radius={shadow.radius}
                shadow-bias={shadow.bias}
                shadow-intensity={shadow.intensity}
                shadow-camera-left={-45}
                shadow-camera-right={45}
                shadow-camera-top={45}
                shadow-camera-bottom={-45}
                shadow-camera-near={1}
                shadow-camera-far={250}
            />
            {/* Fill opens the shadow side without flattening; rim separates the board from the ground.
                Neither casts — one shadow, one direction, is what reads as a real light. */}
            <directionalLight color="#cfe2ff" position={[-52, 26, -18]} intensity={0.7} />
            <directionalLight color="#ffd9a8" position={[8, -6, -54]} intensity={0.9} />
        </>
    );
}

/* --------- adjustable environment (user-supplied EXR) --------- */
export type EnvState = { brightness: number; contrast: number; color: string; strength: number };
const DEFAULT_ENV: EnvState = { brightness: 1, contrast: 1, color: '#ffffff', strength: 0.9 };

/**
 * Hand the environment map to each layer material explicitly.
 *
 * three r169 only honours a material's own `envMapIntensity` when that material has its OWN envMap. If it
 * is null and `scene.environment` is set, the renderer overwrites the uniform from
 * `scene.environmentIntensity` on every frame:
 *
 *     if (material.isMeshStandardMaterial && material.envMap === null && scene.environment !== null)
 *         uniforms.envMapIntensity.value = scene.environmentIntensity;
 *
 * So every per-material weighting authored here — gold pads above the mask, silkscreen pulled down — was
 * being discarded before it reached the shader. Assigning the map is what makes those numbers real.
 */
function BindEnvMap({ mats, url }: Readonly<{ mats: LayerMats; url: string }>) {
    const scene = useThree((st) => st.scene);
    const env = useThree((st) => st.scene.environment);
    const epoch = useContextEpoch();
    useEffect(() => {
        const e = scene.environment;
        if (!e) return;
        const bind = (m: THREE.Material | THREE.Material[] | null) => {
            for (const one of Array.isArray(m) ? m : [m]) {
                const std = one as THREE.MeshStandardMaterial | null;
                if (!std || !('envMapIntensity' in std) || std.envMap === e) continue;
                std.envMap = e;
                std.needsUpdate = true;
            }
        };
        // The layer materials are held outside the scene graph, so they are bound directly; the component
        // bodies come from the GLB and are reached by walking it. Both need it for the same reason — an
        // authored envMapIntensity is discarded unless the material owns an envMap.
        for (const m of Object.values(mats) as THREE.MeshPhysicalMaterial[]) bind(m);
        scene.traverse((o) => {
            const mesh = o as THREE.Mesh;
            if (mesh.isMesh) bind(mesh.material);
        });
    }, [scene, env, mats, url, epoch]);
    return null;
}

/**
 * A studio softbox environment, built rather than downloaded.
 *
 * The pads are metalness 1, so they reflect the environment verbatim, and a clearcoat at roughness 0.16
 * produces nearly all of its visible effect by reflecting discrete bright shapes. An indoor room HDRI
 * gives them a broad, shapeless wash; what reads as a product photograph is a dark surround with a few
 * large, clean rectangular sources. Procedural means it is exactly controllable and costs no asset.
 */
function makeStudioEnvironment(state: EnvState): THREE.Scene {
    const env = new THREE.Scene();
    const surround = new THREE.Mesh(
        new THREE.SphereGeometry(80, 24, 16),
        new THREE.MeshBasicMaterial({
            side: THREE.BackSide,
            // Lifted from near-black: an up-facing pad samples the overhead key and reads gold, but a
            // VERTICAL surface — the TO-220 tab, every header pin — samples this surround. At 0x1b2128
            // they came out darker than the floor and read as matte plastic rather than metal.
            color: new THREE.Color(0x3a434c).multiplyScalar(state.brightness),
        }),
    );
    env.add(surround);
    // The ENIG pads are metalness 1 and face straight up, so whatever sits overhead IS their colour.
    // With a small key and a near-black surround they reflected the void and read as dull olive; the
    // overhead source is now wide enough to cover the angles a flat pad actually samples.
    const panels: Array<[number, number, number, number, number, number, number, number]> = [
        //  w,   h,   x,   y,   z, rotX, rotY, intensity
        [95, 70, 0, 40, 4, -Math.PI / 2, 0, 2.6],
        [34, 30, -48, 22, 12, 0, Math.PI / 2, 1.5],
        [36, 22, 6, 26, -48, 0, 0, 1.1],
        [70, 40, 0, -16, 16, Math.PI / 2, 0, 0.5],
        // Two large side sources at pin height, so a vertical metal face has something to reflect.
        [60, 45, 48, 14, 0, 0, -Math.PI / 2, 1.4],
        [60, 45, 0, 14, 48, 0, Math.PI, 1.2],
    ];
    // The panel intensities carry the tab controls: brightness scales them all, contrast spreads them
    // apart around the key, and the tint colours them. Before this the three sliders were inert — they
    // still drove the EXR pipeline that the procedural studio replaced.
    const tint = new THREE.Color(state.color);
    for (const [w, h, x, y, z, rx, ry, i] of panels) {
        const lit = Math.max(0, (i - 1) * state.contrast + 1) * state.brightness;
        const panel = new THREE.Mesh(
            new THREE.PlaneGeometry(w, h),
            new THREE.MeshBasicMaterial({ color: tint.clone().multiplyScalar(lit) }),
        );
        panel.position.set(x, y, z);
        panel.rotation.set(rx, ry, 0);
        env.add(panel);
    }
    return env;
}

/**
 * A lost-and-restored WebGL context takes the environment with it, permanently and silently.
 *
 * `scene.environment` is a render-target texture with no CPU-side image, so three has nothing to
 * re-upload after a restore — measured, the frame comes back bit-identical to having no environment at
 * all. Neither the PMREM effect nor the envMap binding can notice on their own: their deps are objects
 * that do not change, and a direct mutation of `scene.environment` is invisible to an r3f selector.
 * This counter is the signal both of them subscribe to.
 */
function useContextEpoch(): number {
    const gl = useThree((st) => st.gl);
    const [epoch, setEpoch] = useState(0);
    useEffect(() => {
        const el = gl.domElement;
        const onRestore = () => setEpoch((n) => n + 1);
        el.addEventListener('webglcontextrestored', onRestore);
        return () => el.removeEventListener('webglcontextrestored', onRestore);
    }, [gl]);
    return epoch;
}

/** React StrictMode double-invokes the material and texture factories in development, so a discarded
 *  set is created on every mount. Nothing was releasing them. */
function DisposeOnUnmount({ peel, mats }: Readonly<{ peel: THREE.CanvasTexture | null; mats: LayerMats }>) {
    useEffect(
        () => () => {
            peel?.dispose();
            for (const m of Object.values(mats) as THREE.Material[]) m.dispose();
        },
        [peel, mats],
    );
    return null;
}

function StudioEnvironment({ env }: Readonly<{ env: EnvState }>) {
    const { gl, scene } = useThree();
    const epoch = useContextEpoch();
    useEffect(() => {
        const pmrem = new THREE.PMREMGenerator(gl);
        const src = makeStudioEnvironment(env);
        const rt = pmrem.fromScene(src, 0.04);
        scene.environment = rt.texture;
        pmrem.dispose();
        src.traverse((o) => {
            const m = o as THREE.Mesh;
            if (m.isMesh) {
                m.geometry.dispose();
                (m.material as THREE.Material).dispose();
            }
        });
        return () => {
            rt.dispose();
            scene.environment = null;
        };
    }, [gl, scene, epoch, env.brightness, env.contrast, env.color]);
    useEffect(() => {
        scene.environmentIntensity = env.strength;
    }, [scene, env.strength]);
    return null;
}

/* ------------------------------ Inspector panel (HTML overlay) ------------------------------ */
const NUMS: Array<[string, string, number, number]> = [
    ['metalness', 'metalness', 0, 1],
    ['roughness', 'roughness', 0, 1],
    ['clearcoat', 'clearcoat', 0, 1],
    ['clearcoatRoughness', 'clearcoat rough', 0, 1],
    ['envMapIntensity', 'envMap', 0, 3],
    ['opacity', 'opacity', 0, 1],
];

function Slider({
    label,
    value,
    min,
    max,
    onChange,
    digits = 2,
    step,
}: Readonly<{
    label: string;
    value: number;
    min: number;
    max: number;
    onChange: (v: number) => void;
    digits?: number;
    step?: number;
}>) {
    return (
        <label
            style={{
                display: 'grid',
                gridTemplateColumns: '92px 1fr 46px',
                alignItems: 'center',
                gap: 8,
                fontSize: 11,
                color: '#b9c8bf',
            }}
        >
            <span>{label}</span>
            <input
                type="range"
                min={min}
                max={max}
                step={step ?? (max - min) / 100}
                value={value}
                onChange={(e) => onChange(parseFloat(e.target.value))}
                style={{ accentColor: '#e3b45f' }}
            />
            <span style={{ fontVariantNumeric: 'tabular-nums', textAlign: 'right', color: '#e7efe8' }}>
                {value.toFixed(digits)}
            </span>
        </label>
    );
}

function ColorRow({
    label,
    value,
    onChange,
}: Readonly<{ label: string; value: string; onChange: (v: string) => void }>) {
    return (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: '#b9c8bf' }}>
            <span style={{ width: 96 }}>{label}</span>
            <input
                type="color"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                style={{ width: 40, height: 22, background: 'none', border: 'none' }}
            />
            <span style={{ fontVariantNumeric: 'tabular-nums', color: '#e7efe8' }}>{value}</span>
        </label>
    );
}

function MaterialTab({ materials }: Readonly<{ materials: MatEntry[] }>) {
    const [sel, setSel] = useState(0);
    const [, force] = useState(0);
    if (!materials.length) return <div style={{ fontSize: 12, color: '#8fa79b' }}>yükleniyor…</div>;
    const entry = materials[Math.min(sel, materials.length - 1)];
    const mat = entry.mat;
    const bump = () => force((n) => n + 1);
    const rec = mat as unknown as Record<string, number>;
    return (
        <>
            <div
                style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 3,
                    maxHeight: 180,
                    overflowY: 'auto',
                    marginBottom: 10,
                }}
            >
                {materials.map((e, i) => (
                    <button key={e.id} onClick={() => setSel(i)} style={rowStyle(i === sel)}>
                        <span
                            style={{
                                width: 14,
                                height: 14,
                                borderRadius: 3,
                                background: `#${e.mat.color?.getHexString?.() ?? '888'}`,
                                border: '1px solid rgba(255,255,255,.25)',
                                flex: '0 0 auto',
                            }}
                        />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {e.label}
                        </span>
                    </button>
                ))}
            </div>
            <div
                style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                    borderTop: '1px solid rgba(255,255,255,.1)',
                    paddingTop: 10,
                }}
            >
                <ColorRow
                    label="renk"
                    value={`#${mat.color?.getHexString?.() ?? 'ffffff'}`}
                    onChange={(v) => {
                        mat.color?.set(v);
                        bump();
                    }}
                />
                {NUMS.filter(([k]) => typeof rec[k] === 'number').map(([k, lbl, mn, mx]) => (
                    <Slider
                        key={k}
                        label={lbl}
                        min={mn}
                        max={mx}
                        value={rec[k]}
                        onChange={(v) => {
                            rec[k] = v;
                            if (k === 'opacity' && v < 1) mat.transparent = true;
                            mat.needsUpdate = true;
                            bump();
                        }}
                    />
                ))}
                {mat.normalMap && (
                    <Slider
                        label="doku (normal)"
                        min={0}
                        max={1}
                        value={mat.normalScale?.x ?? 0}
                        onChange={(v) => {
                            mat.normalScale?.set(v, v);
                            bump();
                        }}
                    />
                )}
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: '#b9c8bf' }}>
                    <input
                        type="checkbox"
                        checked={!!mat.transparent}
                        onChange={(e) => {
                            mat.transparent = e.target.checked;
                            mat.needsUpdate = true;
                            bump();
                        }}
                    />
                    <span>saydam (transparent)</span>
                </label>
            </div>
        </>
    );
}

function LightTab({ light, setLight }: Readonly<{ light: LightState; setLight: (p: Partial<LightState>) => void }>) {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Slider
                label="şiddet"
                min={0}
                max={5}
                value={light.intensity}
                onChange={(v) => setLight({ intensity: v })}
            />
            <Slider
                label="azimut °"
                min={0}
                max={360}
                value={light.azimuth}
                onChange={(v) => setLight({ azimuth: v })}
            />
            <Slider
                label="yükseklik °"
                min={5}
                max={90}
                value={light.elevation}
                onChange={(v) => setLight({ elevation: v })}
            />
            <ColorRow label="ışık rengi" value={light.color} onChange={(v) => setLight({ color: v })} />
            <div style={{ borderTop: '1px solid rgba(255,255,255,.1)', paddingTop: 8 }}>
                <Slider
                    label="pozlama"
                    min={0.4}
                    max={2}
                    value={light.exposure}
                    onChange={(v) => setLight({ exposure: v })}
                />
            </div>
        </div>
    );
}

function EnvTab({ env, setEnv }: Readonly<{ env: EnvState; setEnv: (p: Partial<EnvState>) => void }>) {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Slider
                label="parlaklık"
                min={0}
                max={3}
                value={env.brightness}
                onChange={(v) => setEnv({ brightness: v })}
            />
            <Slider
                label="kontrast"
                min={0.2}
                max={2.5}
                value={env.contrast}
                onChange={(v) => setEnv({ contrast: v })}
            />
            <ColorRow label="renk (tint)" value={env.color} onChange={(v) => setEnv({ color: v })} />
            <Slider
                label="güç (strength)"
                min={0}
                max={3}
                value={env.strength}
                onChange={(v) => setEnv({ strength: v })}
            />
            <div style={{ fontSize: 10, color: '#7d938a', lineHeight: 1.5 }}>
                IndoorEnvironmentHDRI003 · yansıma + ortam aydınlatması bu texture'dan gelir
            </div>
        </div>
    );
}

function ShadowTab({
    shadow,
    setShadow,
}: Readonly<{ shadow: ShadowState; setShadow: (p: Partial<ShadowState>) => void }>) {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: '#b9c8bf' }}>
                <input
                    type="checkbox"
                    checked={shadow.enabled}
                    onChange={(e) => setShadow({ enabled: e.target.checked })}
                />
                <span>gölge açık</span>
            </label>
            <Slider
                label="yumuşaklık"
                min={0}
                max={25}
                value={shadow.radius}
                onChange={(v) => setShadow({ radius: v })}
            />
            <Slider
                label="koyuluk"
                min={0}
                max={1}
                value={shadow.intensity}
                onChange={(v) => setShadow({ intensity: v })}
            />
            <Slider
                label="bias"
                min={-0.002}
                max={0.0005}
                step={0.00005}
                digits={4}
                value={shadow.bias}
                onChange={(v) => setShadow({ bias: v })}
            />
            <div style={{ fontSize: 10, color: '#7d938a', lineHeight: 1.5 }}>
                yumuşaklık = penumbra (VSM blur) · koyuluk = shadow.intensity · yüzeyde çizgi/akne olursa bias'ı ayarla
            </div>
        </div>
    );
}

function Panel({
    materials,
    light,
    setLight,
    env,
    setEnv,
    shadow,
    setShadow,
}: Readonly<{
    materials: MatEntry[];
    light: LightState;
    setLight: (p: Partial<LightState>) => void;
    env: EnvState;
    setEnv: (p: Partial<EnvState>) => void;
    shadow: ShadowState;
    setShadow: (p: Partial<ShadowState>) => void;
}>) {
    const [tab, setTab] = useState<'mat' | 'light' | 'shadow' | 'env'>('mat');
    const [toast, setToast] = useState('');
    const copyJson = () => {
        const dump = {
            light,
            shadow,
            env,
            materials: materials.map((e) => {
                const m = e.mat;
                return {
                    name: e.label,
                    color: `#${m.color?.getHexString?.() ?? ''}`,
                    metalness: m.metalness,
                    roughness: m.roughness,
                    clearcoat: m.clearcoat,
                    clearcoatRoughness: m.clearcoatRoughness,
                    opacity: m.opacity,
                    transparent: m.transparent,
                    envMapIntensity: m.envMapIntensity,
                    normalScale: m.normalMap ? m.normalScale?.x : undefined,
                };
            }),
        };
        const txt = JSON.stringify(dump, null, 2);
        console.log('[pcb-viewer] settings:\n' + txt);
        navigator.clipboard?.writeText(txt).then(
            () => {
                setToast('kopyalandı ✓');
                setTimeout(() => setToast(''), 1500);
            },
            () => setToast('konsola yazıldı'),
        );
    };
    const narrow = useNarrow();
    const [open, setOpen] = useState(false);
    if (narrow && !open)
        return (
            <button
                onClick={() => setOpen(true)}
                style={{ ...panelStyle, width: 'auto', padding: '9px 14px', cursor: 'pointer' }}
            >
                ayarlar
            </button>
        );
    return (
        <div style={narrow ? { ...panelStyle, left: 14, right: 14, width: 'auto' } : panelStyle}>
            <div style={{ display: 'flex', gap: 5, marginBottom: 10 }}>
                {narrow && (
                    <button onClick={() => setOpen(false)} style={tabBtn(false)}>
                        ✕
                    </button>
                )}
                <button onClick={() => setTab('mat')} style={tabBtn(tab === 'mat')}>
                    Malzeme
                </button>
                <button onClick={() => setTab('light')} style={tabBtn(tab === 'light')}>
                    Işık
                </button>
                <button onClick={() => setTab('shadow')} style={tabBtn(tab === 'shadow')}>
                    Gölge
                </button>
                <button onClick={() => setTab('env')} style={tabBtn(tab === 'env')}>
                    Ortam
                </button>
            </div>
            {tab === 'mat' && <MaterialTab materials={materials} />}
            {tab === 'light' && <LightTab light={light} setLight={setLight} />}
            {tab === 'shadow' && <ShadowTab shadow={shadow} setShadow={setShadow} />}
            {tab === 'env' && <EnvTab env={env} setEnv={setEnv} />}
            <button onClick={copyJson} style={{ ...chip(false), marginTop: 12, width: '100%' }}>
                {toast || 'JSON kopyala (hepsi)'}
            </button>
        </div>
    );
}

export default function Viewer() {
    const [url, setUrl] = useState(BOARDS[0].id);
    const narrowUi = useNarrow();
    const [spin, setSpin] = useState(false);
    const [materials, setMaterials] = useState<MatEntry[]>([]);
    const [light, setLightState] = useState<LightState>(DEFAULT_LIGHT);
    const setLight = (p: Partial<LightState>) => setLightState((s) => ({ ...s, ...p }));
    const [env, setEnvState] = useState<EnvState>(DEFAULT_ENV);
    const setEnv = (p: Partial<EnvState>) => setEnvState((s) => ({ ...s, ...p }));
    const [shadow, setShadowState] = useState<ShadowState>(DEFAULT_SHADOW);
    const setShadow = (p: Partial<ShadowState>) => setShadowState((s) => ({ ...s, ...p }));
    const peel = useMemo(() => makeOrangePeelNormal(), []);
    const layerMats = useMemo(() => buildLayerMaterials(peel), [peel]);

    const { state: simState, run: runSim, stop: stopSim } = useBoardSimulation(url, boardDataUrl, SIM_LOOP_SECONDS);
    const [playing, setPlaying] = useState(true);
    // The playhead is written every frame from inside the Canvas. It lives in a ref, and a 10 Hz tick
    // copies it into state for the readout: routing 60 fps through React would re-render the whole panel
    // on every frame to move one number.
    const timeRef = useRef(0);
    const [tick, setTick] = useState(0);
    // Stable identity: the 10 Hz readout tick re-renders this component, and an inline arrow here would
    // hand <Board> a new prop on every one of those renders purely to write a ref.
    const onSimTime = useCallback((t: number) => {
        timeRef.current = t;
    }, []);
    useEffect(() => {
        if (simState.kind !== 'ready') return;
        const h = window.setInterval(() => setTick((n) => n + 1), 100);
        return () => window.clearInterval(h);
    }, [simState.kind]);

    const panelState: SimState = useMemo(() => {
        if (simState.kind === 'ready') {
            const p = simState.playback;
            return {
                kind: 'playing',
                nets: p.nets.length,
                unresolved: p.unresolved,
                span: p.times[p.frames - 1]! - p.times[0]!,
                time: timeRef.current,
                min: p.min,
                max: p.max,
                loopSeconds: SIM_LOOP_SECONDS,
                // Threaded through the SUCCESS path on purpose: a board that simulates without its IC is
                // the case where a confident animation misleads most.
                coverage: simState.coverage,
                note: simState.note,
            };
        }
        if (simState.kind === 'unavailable')
            return { kind: 'unavailable', reason: simState.reason, coverage: simState.coverage };
        return { kind: simState.kind === 'running' ? 'running' : 'idle' };
        // `tick` is a dependency on purpose: it is what advances the time readout.
    }, [simState, tick]);

    return (
        <div style={{ position: 'fixed', inset: 0, background: '#080d10' }}>
            <CanvasBoundary>
                <Canvas
                    shadows="variance"
                    // r3f clamps dpr to the display's own devicePixelRatio, so on a 1× monitor this is
                    // exactly 1 and SMAA is the only anti-aliasing in play; on HiDPI it renders native. It is
                    // not supersampling and cannot be — the ceiling only prevents paying for more than 1.75×.
                    dpr={[1, 1.75]}
                    gl={{ antialias: false, stencil: false, powerPreference: 'high-performance' }}
                    // A 0.5 … 400 frustum instead of 0.1 … 3000 buys back depth precision, which matters
                    // when layers are tens of microns apart.
                    camera={{ fov: 34, position: [24, 30, 46], near: 0.5, far: 400 }}
                    // NOTE: tone mapping is deliberately NOT set here. @react-three/postprocessing forces
                    // gl.toneMapping to NoToneMapping whenever an EffectComposer is mounted, so anything set
                    // on the renderer is silently discarded — which is what left this scene rendering with no
                    // tone curve at all. The chain owns it, via <ToneMapping> below.
                    onCreated={({ scene }) => {
                        // Per-material envMapIntensity is overwritten from this every frame, so it has to be
                        // set explicitly rather than left at its default.
                        scene.environmentIntensity = 0.9;
                    }}
                >
                    <color attach="background" args={['#151a1d']} />
                    {/* The 600-unit floor used to end in a hard horizon line across the frame at any low
                    camera angle. Fog dissolves its far edge into the background instead. */}
                    <fogExp2 attach="fog" args={['#151a1d', 0.0034]} />
                    {process.env.NODE_ENV !== 'production' && <DevInspect />}
                    <Rig light={light} shadow={shadow} />

                    <Suspense
                        fallback={
                            <Html center style={{ color: '#cfe0d6', font: '14px ui-monospace, monospace' }}>
                                3D…
                            </Html>
                        }
                    >
                        <Board
                            key={url}
                            url={boardUrl(url)}
                            layerMats={layerMats}
                            onMaterials={setMaterials}
                            sim={simState.kind === 'ready' ? simState : null}
                            playing={playing}
                            onTime={onSimTime}
                        />
                        <DisposeOnUnmount peel={peel} mats={layerMats} />
                        <StudioEnvironment env={env} />
                        <BindEnvMap mats={layerMats} url={url} />
                    </Suspense>
                    <Floor />
                    {/* A single 58° key casts almost nothing under a flat slab, so the board read as floating
                    no matter how the floor was lit. This is the contact cue, rendered once and frozen. */}
                    {/* BELOW the laminate seat (y=0) and above the floor (y=-0.02). At +0.01 it was
                        inside the 2.2-unit-thick slab it was meant to ground, fully occluded — which is
                        why the board still read as floating after the floor was lifted. */}
                    <ContactShadows
                        position={[0, -0.01, 0]}
                        scale={70}
                        far={9}
                        blur={2.4}
                        opacity={0.72}
                        resolution={1024}
                        frames={1}
                        color="#04070a"
                    />

                    <OrbitControls
                        makeDefault
                        autoRotate={spin}
                        autoRotateSpeed={0.6}
                        enableDamping
                        dampingFactor={0.12}
                        rotateSpeed={0.5}
                        zoomSpeed={0.6}
                        panSpeed={0.5}
                        enablePan
                        target={[0, 2.5, 0]}
                        minDistance={12}
                        maxDistance={220}
                        maxPolarAngle={Math.PI * 0.5}
                    />

                    {/* multisampling 0: the composer defaults to 8x MSAA, which on top of SMAA meant the
                    frame was anti-aliased twice and paid for once more in the full-resolution AO pass. */}
                    {/*
                    KNOWN UPSTREAM ISSUE, bisected here: any chain with a SECOND render-target pass makes
                    ANGLE log `GL_INVALID_OPERATION: glBlitFramebuffer: Read and write depth stencil
                    attachments cannot be the same image` once per frame. Measured warning counts over a
                    ten-second run: ToneMapping alone 0 · +Bloom 0 · +SMAA 12 · +MSAA-instead-of-SMAA 11 ·
                    composer removed entirely 0. It survives multisampling 0, stencilBuffer false,
                    stencil:false on the renderer, N8AO removed, VSM swapped for PCF, and SMAA switched to
                    colour edge detection — so it is postprocessing 6.x sharing a depth attachment across
                    its ping-pong buffers on three r169, not something this file can configure away.
                    No visual defect results and Chrome tolerates it; giving up SMAA or AO to silence a log
                    line would cost more than it buys. Revisit on the next postprocessing release.
                */}
                    <EffectComposer multisampling={0} stencilBuffer={false}>
                        {/* Contact darkness where a package meets the laminate — the cue that stops components
                        reading as decals printed on a green plane. */}
                        {/* A world radius, not a screen-space one. Contact occlusion is a fixed physical
                        distance — the gap under a 0603 body — and a screen-space radius grows with zoom,
                        so parts lost their contact darkening exactly when you leaned in to look at it.
                        Every board is fit to the same 40-unit target, so one world radius covers all. */}
                        <N8AO aoRadius={1.1} quality="medium" intensity={2.2} distanceFalloff={0.8} />
                        {/* The buffer here is linear HDR, not display-referred, so a threshold below 1 catches
                        ordinary lit surfaces. Above 1 it catches only genuine emitters — the LED domes. */}
                        {/* The threshold stays 0.82 — the whole palette is authored against that number rather than moving it:
                            the base layer is clamped at luma 0.70 so voltage can never cross it, and the token
                            cores sit at 0.52…8.42 so current crosses it above the first tier. Smoothing was 0.025,
                            a 3%-wide pass/fail band that made an antialiased moving pulse edge pop in and out of
                            bloom every frame — cheap shimmer. 0.10 puts the ramp at 0.82→0.92, with tier 1 fully
                            below and tier 2 fully above, so nothing sits inside it. Intensity 0.65 because the
                            halo is authored as geometry, so bloom is confirmation rather than the source. */}
                        <Bloom luminanceThreshold={0.82} luminanceSmoothing={0.1} intensity={0.65} mipmapBlur />
                        {/* Khronos PBR Neutral, not ACES or AgX: both of those desaturate a saturated green
                        subject hard and pull the small gold details toward grey. Neutral keeps the board
                        green and the ENIG gold while still rolling off the specular highlights. */}
                        <ToneMapping mode={ToneMappingMode.NEUTRAL} />
                        <SMAA preset={SMAAPreset.ULTRA} />
                    </EffectComposer>
                </Canvas>
            </CanvasBoundary>

            {/* Nine chips wrap to seven rows on a narrow window and cover the board they select. */}
            {narrowUi ? (
                <div
                    style={{
                        position: 'absolute',
                        left: 16,
                        top: 16,
                        display: 'flex',
                        gap: 8,
                        alignItems: 'center',
                    }}
                >
                    <select
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                        aria-label="devre"
                        style={{ ...chip(true), padding: 9, maxWidth: 230 }}
                    >
                        {BOARDS.map((b) => (
                            <option key={b.id} value={b.id}>
                                {b.title}
                            </option>
                        ))}
                    </select>
                    <button onClick={() => setSpin((sp) => !sp)} style={chip(spin)}>
                        {spin ? '⏸' : '▶'}
                    </button>
                </div>
            ) : (
                <div
                    style={{
                        position: 'absolute',
                        left: 16,
                        top: 16,
                        display: 'flex',
                        gap: 8,
                        flexWrap: 'wrap',
                        maxWidth: 'calc(100% - 340px)',
                    }}
                >
                    {BOARDS.map((b) => (
                        <button key={b.id} onClick={() => setUrl(b.id)} style={chip(url === b.id)}>
                            <span
                                style={{
                                    opacity: 0.5,
                                    marginRight: 6,
                                    fontSize: 10,
                                    textTransform: 'uppercase',
                                    letterSpacing: 0.4,
                                }}
                            >
                                {b.cat}
                            </span>
                            {b.title}
                        </button>
                    ))}
                    <button onClick={() => setSpin((s) => !s)} style={chip(spin)}>
                        {spin ? '⏸ döndürmeyi durdur' : '▶ otomatik döndür'}
                    </button>
                </div>
            )}

            <Panel
                materials={materials}
                light={light}
                setLight={setLight}
                env={env}
                setEnv={setEnv}
                shadow={shadow}
                setShadow={setShadow}
            />

            {/* Bottom-left, opposite the inspector: the simulation is about the BOARD, so it sits beside it
                rather than inside the material tweaking panel. */}
            <div
                style={{
                    position: 'absolute',
                    left: 16,
                    bottom: 44,
                    width: 320,
                    maxWidth: 'calc(100% - 32px)',
                    padding: 12,
                    background: 'rgba(12,18,22,.92)',
                    backdropFilter: 'blur(8px)',
                    border: '1px solid rgba(255,255,255,.12)',
                    borderRadius: 12,
                    color: '#e7efe8',
                    font: '12px ui-sans-serif, system-ui',
                    boxShadow: '0 12px 40px rgba(0,0,0,.5)',
                }}
            >
                <SimulationPanel
                    state={panelState}
                    onSimulate={runSim}
                    onStop={stopSim}
                    playing={playing}
                    onTogglePlay={() => setPlaying((p) => !p)}
                />
            </div>

            <div
                style={{
                    position: 'absolute',
                    left: 16,
                    bottom: 14,
                    color: '#8fa79b',
                    font: '11px ui-monospace, monospace',
                }}
            >
                malzeme + ışık canlı ayarlanır · gölge ışığı gerçek-zamanlı takip eder · beğenince "JSON kopyala" → bana
                yapıştır
            </div>
        </div>
    );
}

/** Below this width a fixed 320 px inspector is 40% of the window and at 480 px it overflows it, so
 *  it collapses to a toggle instead of covering the board it exists to inspect. */
const PANEL_BREAKPOINT = 900;

function useNarrow(): boolean {
    const [narrow, setNarrow] = useState(false);
    useEffect(() => {
        const mq = window.matchMedia(`(max-width: ${PANEL_BREAKPOINT - 1}px)`);
        const sync = () => setNarrow(mq.matches);
        sync();
        mq.addEventListener('change', sync);
        return () => mq.removeEventListener('change', sync);
    }, []);
    return narrow;
}

const panelStyle: React.CSSProperties = {
    position: 'absolute',
    right: 14,
    top: 14,
    width: 320,
    padding: 14,
    background: 'rgba(12,18,22,.92)',
    backdropFilter: 'blur(8px)',
    border: '1px solid rgba(255,255,255,.12)',
    borderRadius: 14,
    color: '#e7efe8',
    boxShadow: '0 12px 40px rgba(0,0,0,.5)',
    maxHeight: 'calc(100vh - 28px)',
    overflowY: 'auto',
};
const rowStyle = (on: boolean): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    textAlign: 'left',
    background: on ? '#1b2b22' : 'transparent',
    color: '#e7efe8',
    border: `1px solid ${on ? '#e3b45f' : 'transparent'}`,
    borderRadius: 8,
    padding: '6px 8px',
    font: '600 12px ui-sans-serif, system-ui',
    cursor: 'pointer',
});
const tabBtn = (on: boolean): React.CSSProperties => ({
    flex: 1,
    background: on ? '#1b2b22' : '#111a1f',
    color: '#e7efe8',
    border: `1px solid ${on ? '#e3b45f' : 'rgba(255,255,255,.12)'}`,
    borderRadius: 9,
    padding: '7px 10px',
    font: '700 12px ui-sans-serif, system-ui',
    cursor: 'pointer',
});
const chip = (on: boolean): React.CSSProperties => ({
    background: on ? '#1b2b22' : '#111a1f',
    color: '#e7efe8',
    border: `1px solid ${on ? '#e3b45f' : 'rgba(255,255,255,.12)'}`,
    borderRadius: 10,
    padding: '8px 12px',
    font: '600 13px ui-sans-serif, system-ui',
    cursor: 'pointer',
});

BOARDS.forEach((b) => useGLTF.preload(boardUrl(b.id)));

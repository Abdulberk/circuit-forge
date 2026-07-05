'use client';
import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { Canvas, useThree, useLoader } from '@react-three/fiber';
import { OrbitControls, Environment, useGLTF, Html } from '@react-three/drei';
import { EffectComposer, Bloom, N8AO, SMAA } from '@react-three/postprocessing';

// Real, DRC-clean board GLBs our pipeline produced (served from /public). Every one is genuine
// pcb-core output: CircuitJson → tscircuit eval → freerouting → KiCad DRC ✔ → 3D bodies whose
// placement is numerically verified (scripts/verify-3d-alignment.mjs, 0.000mm worst offset).
const BOARDS = [
  { id: 'chaser-4017.glb', title: '555+4017 · 10-LED şelale', cat: 'dijital' },
  { id: 'shift-register.glb', title: '74HC595 · 8-LED shift register', cat: 'dijital' },
  { id: 'opamp-amp.glb', title: 'LM358 · op-amp yükselteç', cat: 'analog' },
  { id: 'ne555-blinker.glb', title: 'NE555 · blinker', cat: 'analog' },
  { id: 'astable-flasher.glb', title: '2-transistör astable flaşör', cat: 'discrete' },
  { id: 'mosfet-switch.glb', title: 'MOSFET anahtar + flyback', cat: 'anahtarlama' },
  { id: 'bridge-rectifier.glb', title: 'Köprü doğrultucu + filtre', cat: 'güç' },
  { id: 'regulator-5v.glb', title: '7805 · 5V regülatör', cat: 'güç' },
];

const TARGET = 40; // world units on largest side

// KiCad's generic LED STEP model is a neutral beige chip — indistinguishable from a resistor/cap and
// carries no emitter color. We make LEDs READ as LEDs: a lit, emissive, colored epoxy dome. The GLB
// has no per-LED color, so we vary color by board position → a lively, colorful, real-looking board.
const LED_COLORS = ['#ff3b30', '#34c759', '#ffd60a', '#0a84ff', '#ff9f0a', '#ff2d55', '#30d0e0', '#bf5af2'];

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
  const rnd = (n: number) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
  const grid = (gx: number, gy: number, g: number) => rnd((gx % g) + (gy % g) * g * 7.13 + g * 131);
  const sample = (x: number, y: number, cell: number) => {
    const g = S / cell;
    const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
    const fx = (x % cell) / cell, fy = (y % cell) / cell;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = grid(gx, gy, g), b = grid(gx + 1, gy, g), d = grid(gx, gy + 1, g), e = grid(gx + 1, gy + 1, g);
    return a + (b - a) * sx + (d - a) * sy + (a - b - d + e) * sx * sy;
  };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) h[y * S + x] = 0.7 * sample(x, y, 8) + 0.3 * sample(x, y, 4);
  const img = ctx.createImageData(S, S);
  const at = (x: number, y: number) => h[((y + S) % S) * S + ((x + S) % S)];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const n = new THREE.Vector3((at(x - 1, y) - at(x + 1, y)) * 2, (at(x, y - 1) - at(x, y + 1)) * 2, 1).normalize();
      const i = (y * S + x) * 4;
      img.data[i] = (n.x * 0.5 + 0.5) * 255; img.data[i + 1] = (n.y * 0.5 + 0.5) * 255;
      img.data[i + 2] = (n.z * 0.5 + 0.5) * 255; img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 3);
  return t;
}

/* ------------------------------------------------------------------ */
/* Physically-grounded PCB layer materials (named for the inspector).  */
/* ------------------------------------------------------------------ */
function buildLayerMaterials(peel: THREE.CanvasTexture | null) {
  const mask = new THREE.MeshPhysicalMaterial({
    color: '#0e4526', roughness: 0.5, metalness: 0, clearcoat: 0.55, clearcoatRoughness: 0.32,
    transparent: true, opacity: 0.5, envMapIntensity: 0.8,
    normalMap: peel ?? undefined, normalScale: new THREE.Vector2(0.15, 0.15),
  });
  const copper = new THREE.MeshPhysicalMaterial({
    color: '#2a9151', metalness: 0.22, roughness: 0.48, clearcoat: 0.35, clearcoatRoughness: 0.4, envMapIntensity: 1.0,
  });
  const pad = new THREE.MeshPhysicalMaterial({ color: '#d9b544', metalness: 1, roughness: 0.38, envMapIntensity: 1.35 });
  const silk = new THREE.MeshPhysicalMaterial({
    color: '#eae8e0', metalness: 0, roughness: 0.88, transparent: true, opacity: 0.92, envMapIntensity: 0.35,
  });
  const pcb = new THREE.MeshPhysicalMaterial({
    color: '#a89a6a', metalness: 0, roughness: 0.7, envMapIntensity: 0.45,
    normalMap: peel ?? undefined, normalScale: new THREE.Vector2(0.08, 0.08),
  });
  mask.name = 'Soldermask (maske)'; copper.name = 'Bakır izler (maske altı)'; pad.name = 'Pad (ENIG altın)';
  silk.name = 'Silkscreen (baskı)'; pcb.name = 'FR4 (kart gövdesi)';
  return { mask, copper, via: copper, pad, silk, pcb } as const;
}
type LayerMats = ReturnType<typeof buildLayerMaterials>;

function layerOf(name: string): 'copper' | 'via' | 'pad' | 'soldermask' | 'silkscreen' | 'pcb' | 'part' {
  const n = name.toLowerCase();
  if (n.includes('copper')) return 'copper';
  if (n.includes('via')) return 'via';
  if (n.includes('pad')) return 'pad';
  if (n.includes('soldermask')) return 'soldermask';
  if (n.includes('silkscreen')) return 'silkscreen';
  if (n.includes('pcb')) return 'pcb';
  return 'part';
}

/** Component-body materials, decided by color DATA (not per-part rules); cached to keep sharing/merge intact. */
function makePartResolver() {
  const cache = new Map<string, THREE.Material>();
  return (mat: THREE.MeshStandardMaterial): THREE.Material => {
    if (!mat?.isMaterial || !mat.color) return mat;
    const hit = cache.get(mat.uuid);
    if (hit) return hit;
    const { r, g, b } = mat.color;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const relSat = mx > 0 ? (mx - mn) / mx : 0;
    let out: THREE.Material = mat;
    if (mx < 0.06) {
      out = new THREE.MeshPhysicalMaterial({ color: '#17171a', roughness: 0.5, metalness: 0, clearcoat: 0.12, clearcoatRoughness: 0.5, envMapIntensity: 1 });
      out.name = 'IC epoksi (mat siyah)';
    } else if (relSat < 0.22 && mx > 0.5) {
      out = new THREE.MeshPhysicalMaterial({ color: '#c8ccd0', metalness: 1, roughness: 0.3, envMapIntensity: 1.2 });
      out.name = 'Metal terminal';
    } else {
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
function ensurePlanarUV(geo: THREE.BufferGeometry) {
  if (geo.attributes.uv) return;
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  if (!bb) return;
  const size = new THREE.Vector3(); bb.getSize(size);
  const dims: Array<'x' | 'y' | 'z'> = ['x', 'y', 'z'];
  dims.sort((a, b) => size[b] - size[a]);
  const [u, v] = dims;
  const pos = geo.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const p = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
    uv[i * 2] = (p[u] - bb.min[u]) / (size[u] || 1);
    uv[i * 2 + 1] = (p[v] - bb.min[v]) / (size[v] || 1);
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
  const tmp = new THREE.Vector3();
  return (mesh: THREE.Mesh): THREE.Material => {
    const p = mesh.getWorldPosition(tmp);
    const color = LED_COLORS[Math.abs(Math.round(p.x * 3.1 + p.z * 7.7)) % LED_COLORS.length];
    let m = cache.get(color);
    if (!m) {
      m = new THREE.MeshPhysicalMaterial({
        color, emissive: color, emissiveIntensity: 0.85,
        transmission: 0.45, thickness: 1.2, ior: 1.5,
        roughness: 0.14, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.06,
        envMapIntensity: 1, transparent: true,
      });
      m.name = `LED (${color})`;
      cache.set(color, m);
    }
    return m;
  };
}

function assignMaterials(meshes: THREE.Mesh[], layerMats: LayerMats) {
  const resolvePart = makePartResolver();
  const resolveLed = makeLedResolver();
  const byLayer: Partial<Record<ReturnType<typeof layerOf>, THREE.Material>> = {
    soldermask: layerMats.mask, copper: layerMats.copper, via: layerMats.via,
    pad: layerMats.pad, silkscreen: layerMats.silk, pcb: layerMats.pcb,
  };
  for (const m of meshes) {
    m.castShadow = true; m.receiveShadow = true;
    if (m.name.toLowerCase().includes('led')) { m.material = resolveLed(m); continue; } // real KiCad dome, tinted
    const lm = byLayer[layerOf(m.name)];
    if (lm) m.material = lm;
    else if (Array.isArray(m.material)) m.material = m.material.map((mt) => resolvePart(mt as THREE.MeshStandardMaterial));
    else m.material = resolvePart(m.material as THREE.MeshStandardMaterial);
  }
}

function mergeDrawCalls(scene: THREE.Group, meshes: THREE.Mesh[]) {
  try {
    const buckets = new Map<string, { geos: THREE.BufferGeometry[]; mat: THREE.Material; layer: string; sources: THREE.Mesh[] }>();
    for (const m of meshes) {
      if (Array.isArray(m.material)) continue;
      const geo = m.geometry.clone();
      geo.applyMatrix4(m.matrixWorld);
      const layer = layerOf(m.name);
      if (layer === 'soldermask' || layer === 'pcb') ensurePlanarUV(geo);
      const key = `${m.material.uuid}|${attrSig(geo)}`;
      let b = buckets.get(key);
      if (!b) { b = { geos: [], mat: m.material, layer, sources: [] }; buckets.set(key, b); }
      b.geos.push(geo); b.sources.push(m);
    }
    const merged: THREE.Mesh[] = []; const consumed: THREE.Mesh[] = [];
    for (const { geos, mat, layer, sources } of buckets.values()) {
      const g = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
      if (!g) throw new Error('mergeGeometries returned null');
      const mm = new THREE.Mesh(g, mat);
      mm.name = `merged_${layer}`; mm.castShadow = true; mm.receiveShadow = true;
      merged.push(mm); consumed.push(...sources);
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
      const label = mat.name || `#${(mat.color?.getHexString?.() ?? 'mat')}`;
      seen.set(mat.uuid, { id: mat.uuid, label, mat });
    }
  });
  return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function processScene(scene: THREE.Group, layerMats: LayerMats): MatEntry[] {
  if (!scene.userData.__pcbProcessed) {
    scene.userData.__pcbProcessed = true;
    scene.updateWorldMatrix(true, true);
    const meshes: THREE.Mesh[] = [];
    scene.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && m.geometry) meshes.push(m); });
    assignMaterials(meshes, layerMats);
    mergeDrawCalls(scene, meshes);
  }
  return collectMaterials(scene);
}

function Board({ url, layerMats, onMaterials }: Readonly<{ url: string; layerMats: LayerMats; onMaterials: (m: MatEntry[]) => void }>) {
  const { scene } = useGLTF(url);
  const group = useRef<THREE.Group>(null);

  useLayoutEffect(() => {
    const g = group.current;
    if (!g) return;
    const mats = processScene(scene, layerMats);
    onMaterials(mats);

    g.rotation.set(0, 0, 0); g.scale.setScalar(1); g.position.set(0, 0, 0);
    g.updateWorldMatrix(true, true);
    const raw = new THREE.Box3().setFromObject(g);
    const rs = new THREE.Vector3(); raw.getSize(rs);
    if (rs.z <= rs.x && rs.z <= rs.y) g.rotation.x = -Math.PI / 2;
    else if (rs.x <= rs.y && rs.x <= rs.z) g.rotation.z = Math.PI / 2;

    g.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(g);
    const size = new THREE.Vector3(); box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    g.scale.setScalar(TARGET / maxDim);
    g.updateWorldMatrix(true, true);
    const box2 = new THREE.Box3().setFromObject(g);
    const center = new THREE.Vector3(); box2.getCenter(center);
    g.position.x -= center.x; g.position.z -= center.z; g.position.y -= box2.min.y;
  }, [scene, layerMats, onMaterials]);

  return <group ref={group}><primitive object={scene} /></group>;
}

function Floor() {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} receiveShadow>
      <planeGeometry args={[600, 600]} />
      <meshStandardMaterial color="#0d1114" roughness={0.92} metalness={0} envMapIntensity={0.15} />
    </mesh>
  );
}

/* --------- adjustable light rig --------- */
export type LightState = { intensity: number; azimuth: number; elevation: number; color: string; exposure: number };
const DEFAULT_LIGHT: LightState = { intensity: 1.5, azimuth: 35, elevation: 55, color: '#fff4e6', exposure: 1.05 };

function lightPos(l: LightState): [number, number, number] {
  const el = (l.elevation * Math.PI) / 180, az = (l.azimuth * Math.PI) / 180, R = 60;
  return [R * Math.cos(el) * Math.cos(az), R * Math.sin(el), R * Math.cos(el) * Math.sin(az)];
}

function Exposure({ value }: Readonly<{ value: number }>) {
  const gl = useThree((s) => s.gl);
  useLayoutEffect(() => { gl.toneMappingExposure = value; }, [gl, value]);
  return null;
}

export type ShadowState = { enabled: boolean; radius: number; intensity: number; bias: number };
const DEFAULT_SHADOW: ShadowState = { enabled: true, radius: 6, intensity: 0.9, bias: -0.0004 };

function Rig({ light, shadow }: Readonly<{ light: LightState; shadow: ShadowState }>) {
  const p = lightPos(light);
  return (
    <>
      <Exposure value={light.exposure} />
      <hemisphereLight intensity={0.15} groundColor="#0a0a08" />
      <directionalLight
        castShadow={shadow.enabled} color={light.color} position={p} intensity={light.intensity}
        shadow-mapSize={[2048, 2048]} shadow-blurSamples={25}
        shadow-radius={shadow.radius} shadow-bias={shadow.bias} shadow-intensity={shadow.intensity}
        shadow-camera-left={-30} shadow-camera-right={30} shadow-camera-top={30} shadow-camera-bottom={-30}
        shadow-camera-near={1} shadow-camera-far={250}
      />
    </>
  );
}

/* --------- adjustable environment (user-supplied EXR) --------- */
export type EnvState = { brightness: number; contrast: number; color: string; strength: number };
const DEFAULT_ENV: EnvState = { brightness: 1, contrast: 1, color: '#ffffff', strength: 0.9 };

/**
 * Load the EXR once as float data, then apply photographic brightness / contrast (pivot at
 * scene-linear 18% gray) / color-tint per pixel into a fresh DataTexture. `strength` maps to the
 * native environmentIntensity (IBL contribution). Reprocess only when a photo control changes.
 */
function AdjustableEnvironment({ url, env }: Readonly<{ url: string; env: EnvState }>) {
  const tex = useLoader(EXRLoader, url, (l) => (l as EXRLoader).setDataType(THREE.FloatType));
  const processed = useMemo(() => {
    const img = tex.image as unknown as { data: Float32Array; width: number; height: number };
    const src = img.data;
    const out = new Float32Array(src.length);
    const c = new THREE.Color(env.color);
    const B = env.brightness, K = env.contrast, P = 0.18;
    for (let i = 0; i < src.length; i += 4) {
      let r = src[i] * c.r, g = src[i + 1] * c.g, b = src[i + 2] * c.b;
      r = (r - P) * K + P; g = (g - P) * K + P; b = (b - P) * K + P;
      r *= B; g *= B; b *= B;
      out[i] = r > 0 ? r : 0; out[i + 1] = g > 0 ? g : 0; out[i + 2] = b > 0 ? b : 0; out[i + 3] = src[i + 3];
    }
    const dt = new THREE.DataTexture(out, img.width, img.height, THREE.RGBAFormat, THREE.FloatType);
    dt.mapping = THREE.EquirectangularReflectionMapping;
    dt.needsUpdate = true;
    return dt;
  }, [tex, env.brightness, env.contrast, env.color]);
  useEffect(() => () => processed.dispose(), [processed]);
  return <Environment map={processed} environmentIntensity={env.strength} />;
}

/* ------------------------------ Inspector panel (HTML overlay) ------------------------------ */
const NUMS: Array<[string, string, number, number]> = [
  ['metalness', 'metalness', 0, 1], ['roughness', 'roughness', 0, 1],
  ['clearcoat', 'clearcoat', 0, 1], ['clearcoatRoughness', 'clearcoat rough', 0, 1],
  ['envMapIntensity', 'envMap', 0, 3], ['opacity', 'opacity', 0, 1],
];

function Slider({ label, value, min, max, onChange, digits = 2, step }: Readonly<{ label: string; value: number; min: number; max: number; onChange: (v: number) => void; digits?: number; step?: number }>) {
  return (
    <label style={{ display: 'grid', gridTemplateColumns: '92px 1fr 46px', alignItems: 'center', gap: 8, fontSize: 11, color: '#b9c8bf' }}>
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step ?? (max - min) / 100} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} style={{ accentColor: '#e3b45f' }} />
      <span style={{ fontVariantNumeric: 'tabular-nums', textAlign: 'right', color: '#e7efe8' }}>{value.toFixed(digits)}</span>
    </label>
  );
}

function ColorRow({ label, value, onChange }: Readonly<{ label: string; value: string; onChange: (v: string) => void }>) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: '#b9c8bf' }}>
      <span style={{ width: 96 }}>{label}</span>
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} style={{ width: 40, height: 22, background: 'none', border: 'none' }} />
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 180, overflowY: 'auto', marginBottom: 10 }}>
        {materials.map((e, i) => (
          <button key={e.id} onClick={() => setSel(i)} style={rowStyle(i === sel)}>
            <span style={{ width: 14, height: 14, borderRadius: 3, background: `#${e.mat.color?.getHexString?.() ?? '888'}`, border: '1px solid rgba(255,255,255,.25)', flex: '0 0 auto' }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.label}</span>
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid rgba(255,255,255,.1)', paddingTop: 10 }}>
        <ColorRow label="renk" value={`#${mat.color?.getHexString?.() ?? 'ffffff'}`} onChange={(v) => { mat.color?.set(v); bump(); }} />
        {NUMS.filter(([k]) => typeof rec[k] === 'number').map(([k, lbl, mn, mx]) => (
          <Slider key={k} label={lbl} min={mn} max={mx} value={rec[k]}
            onChange={(v) => { rec[k] = v; if (k === 'opacity' && v < 1) mat.transparent = true; mat.needsUpdate = true; bump(); }} />
        ))}
        {mat.normalMap && (
          <Slider label="doku (normal)" min={0} max={1} value={mat.normalScale?.x ?? 0} onChange={(v) => { mat.normalScale?.set(v, v); bump(); }} />
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: '#b9c8bf' }}>
          <input type="checkbox" checked={!!mat.transparent} onChange={(e) => { mat.transparent = e.target.checked; mat.needsUpdate = true; bump(); }} />
          <span>saydam (transparent)</span>
        </label>
      </div>
    </>
  );
}

function LightTab({ light, setLight }: Readonly<{ light: LightState; setLight: (p: Partial<LightState>) => void }>) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Slider label="şiddet" min={0} max={5} value={light.intensity} onChange={(v) => setLight({ intensity: v })} />
      <Slider label="azimut °" min={0} max={360} value={light.azimuth} onChange={(v) => setLight({ azimuth: v })} />
      <Slider label="yükseklik °" min={5} max={90} value={light.elevation} onChange={(v) => setLight({ elevation: v })} />
      <ColorRow label="ışık rengi" value={light.color} onChange={(v) => setLight({ color: v })} />
      <div style={{ borderTop: '1px solid rgba(255,255,255,.1)', paddingTop: 8 }}>
        <Slider label="pozlama" min={0.4} max={2} value={light.exposure} onChange={(v) => setLight({ exposure: v })} />
      </div>
    </div>
  );
}

function EnvTab({ env, setEnv }: Readonly<{ env: EnvState; setEnv: (p: Partial<EnvState>) => void }>) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Slider label="parlaklık" min={0} max={3} value={env.brightness} onChange={(v) => setEnv({ brightness: v })} />
      <Slider label="kontrast" min={0.2} max={2.5} value={env.contrast} onChange={(v) => setEnv({ contrast: v })} />
      <ColorRow label="renk (tint)" value={env.color} onChange={(v) => setEnv({ color: v })} />
      <Slider label="güç (strength)" min={0} max={3} value={env.strength} onChange={(v) => setEnv({ strength: v })} />
      <div style={{ fontSize: 10, color: '#7d938a', lineHeight: 1.5 }}>IndoorEnvironmentHDRI003 · yansıma + ortam aydınlatması bu texture'dan gelir</div>
    </div>
  );
}

function ShadowTab({ shadow, setShadow }: Readonly<{ shadow: ShadowState; setShadow: (p: Partial<ShadowState>) => void }>) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: '#b9c8bf' }}>
        <input type="checkbox" checked={shadow.enabled} onChange={(e) => setShadow({ enabled: e.target.checked })} />
        <span>gölge açık</span>
      </label>
      <Slider label="yumuşaklık" min={0} max={25} value={shadow.radius} onChange={(v) => setShadow({ radius: v })} />
      <Slider label="koyuluk" min={0} max={1} value={shadow.intensity} onChange={(v) => setShadow({ intensity: v })} />
      <Slider label="bias" min={-0.002} max={0.0005} step={0.00005} digits={4} value={shadow.bias} onChange={(v) => setShadow({ bias: v })} />
      <div style={{ fontSize: 10, color: '#7d938a', lineHeight: 1.5 }}>yumuşaklık = penumbra (VSM blur) · koyuluk = shadow.intensity · yüzeyde çizgi/akne olursa bias'ı ayarla</div>
    </div>
  );
}

function Panel({ materials, light, setLight, env, setEnv, shadow, setShadow }: Readonly<{ materials: MatEntry[]; light: LightState; setLight: (p: Partial<LightState>) => void; env: EnvState; setEnv: (p: Partial<EnvState>) => void; shadow: ShadowState; setShadow: (p: Partial<ShadowState>) => void }>) {
  const [tab, setTab] = useState<'mat' | 'light' | 'shadow' | 'env'>('mat');
  const [toast, setToast] = useState('');
  const copyJson = () => {
    const dump = {
      light, shadow, env,
      materials: materials.map((e) => {
        const m = e.mat;
        return {
          name: e.label, color: `#${m.color?.getHexString?.() ?? ''}`,
          metalness: m.metalness, roughness: m.roughness, clearcoat: m.clearcoat, clearcoatRoughness: m.clearcoatRoughness,
          opacity: m.opacity, transparent: m.transparent, envMapIntensity: m.envMapIntensity,
          normalScale: m.normalMap ? m.normalScale?.x : undefined,
        };
      }),
    };
    const txt = JSON.stringify(dump, null, 2);
    console.log('[pcb-viewer] settings:\n' + txt);
    navigator.clipboard?.writeText(txt).then(() => { setToast('kopyalandı ✓'); setTimeout(() => setToast(''), 1500); }, () => setToast('konsola yazıldı'));
  };
  return (
    <div style={panelStyle}>
      <div style={{ display: 'flex', gap: 5, marginBottom: 10 }}>
        <button onClick={() => setTab('mat')} style={tabBtn(tab === 'mat')}>Malzeme</button>
        <button onClick={() => setTab('light')} style={tabBtn(tab === 'light')}>Işık</button>
        <button onClick={() => setTab('shadow')} style={tabBtn(tab === 'shadow')}>Gölge</button>
        <button onClick={() => setTab('env')} style={tabBtn(tab === 'env')}>Ortam</button>
      </div>
      {tab === 'mat' && <MaterialTab materials={materials} />}
      {tab === 'light' && <LightTab light={light} setLight={setLight} />}
      {tab === 'shadow' && <ShadowTab shadow={shadow} setShadow={setShadow} />}
      {tab === 'env' && <EnvTab env={env} setEnv={setEnv} />}
      <button onClick={copyJson} style={{ ...chip(false), marginTop: 12, width: '100%' }}>{toast || 'JSON kopyala (hepsi)'}</button>
    </div>
  );
}

export default function Viewer() {
  const [url, setUrl] = useState(BOARDS[0].id);
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

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#080d10' }}>
      <Canvas
        shadows="variance" dpr={[1, 1.5]}
        gl={{ antialias: false, powerPreference: 'high-performance' }}
        camera={{ fov: 34, position: [24, 30, 46], near: 0.1, far: 3000 }}
        onCreated={({ gl }) => { gl.toneMapping = (THREE as unknown as { AgXToneMapping?: THREE.ToneMapping }).AgXToneMapping ?? THREE.ACESFilmicToneMapping; }}
      >
        <color attach="background" args={['#0b1013']} />
        <Rig light={light} shadow={shadow} />

        <Suspense fallback={<Html center style={{ color: '#cfe0d6', font: '14px ui-monospace, monospace' }}>3D…</Html>}>
          <Board key={url} url={url} layerMats={layerMats} onMaterials={setMaterials} />
          <AdjustableEnvironment url="/env.exr" env={env} />
        </Suspense>
        <Floor />

        <OrbitControls
          makeDefault autoRotate={spin} autoRotateSpeed={0.6} enableDamping dampingFactor={0.12}
          rotateSpeed={0.5} zoomSpeed={0.6} panSpeed={0.5} enablePan target={[0, 2.5, 0]}
          minDistance={12} maxDistance={220} maxPolarAngle={Math.PI * 0.5}
        />

        <EffectComposer>
          <N8AO halfRes quality="performance" aoRadius={3} intensity={1.4} distanceFalloff={1} />
          <Bloom luminanceThreshold={0.95} intensity={0.12} mipmapBlur />
          <SMAA />
        </EffectComposer>
      </Canvas>

      <div style={{ position: 'absolute', left: 16, top: 16, display: 'flex', gap: 8, flexWrap: 'wrap', maxWidth: 'calc(100% - 340px)' }}>
        {BOARDS.map((b) => (
          <button key={b.id} onClick={() => setUrl(b.id)} style={chip(url === b.id)}>
            <span style={{ opacity: 0.5, marginRight: 6, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4 }}>{b.cat}</span>{b.title}
          </button>
        ))}
        <button onClick={() => setSpin((s) => !s)} style={chip(spin)}>{spin ? '⏸ döndürmeyi durdur' : '▶ otomatik döndür'}</button>
      </div>

      <Panel materials={materials} light={light} setLight={setLight} env={env} setEnv={setEnv} shadow={shadow} setShadow={setShadow} />

      <div style={{ position: 'absolute', left: 16, bottom: 14, color: '#8fa79b', font: '11px ui-monospace, monospace' }}>
        malzeme + ışık canlı ayarlanır · gölge ışığı gerçek-zamanlı takip eder · beğenince "JSON kopyala" → bana yapıştır
      </div>
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  position: 'absolute', right: 14, top: 14, width: 320, padding: 14,
  background: 'rgba(12,18,22,.92)', backdropFilter: 'blur(8px)',
  border: '1px solid rgba(255,255,255,.12)', borderRadius: 14, color: '#e7efe8',
  boxShadow: '0 12px 40px rgba(0,0,0,.5)', maxHeight: 'calc(100vh - 28px)', overflowY: 'auto',
};
const rowStyle = (on: boolean): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
  background: on ? '#1b2b22' : 'transparent', color: '#e7efe8',
  border: `1px solid ${on ? '#e3b45f' : 'transparent'}`, borderRadius: 8,
  padding: '6px 8px', font: '600 12px ui-sans-serif, system-ui', cursor: 'pointer',
});
const tabBtn = (on: boolean): React.CSSProperties => ({
  flex: 1, background: on ? '#1b2b22' : '#111a1f', color: '#e7efe8',
  border: `1px solid ${on ? '#e3b45f' : 'rgba(255,255,255,.12)'}`, borderRadius: 9,
  padding: '7px 10px', font: '700 12px ui-sans-serif, system-ui', cursor: 'pointer',
});
const chip = (on: boolean): React.CSSProperties => ({
  background: on ? '#1b2b22' : '#111a1f', color: '#e7efe8',
  border: `1px solid ${on ? '#e3b45f' : 'rgba(255,255,255,.12)'}`,
  borderRadius: 10, padding: '8px 12px', font: '600 13px ui-sans-serif, system-ui', cursor: 'pointer',
});

BOARDS.forEach((b) => useGLTF.preload('/' + b.id));

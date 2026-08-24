import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { useDayNightState } from "./DayNight";
import {
  WORLD_SIZE,
  RIVER_HALF_WIDTH,
  BRIDGE_MODERN_X,
  BRIDGE_TRUSS_X,
  BRIDGE_WIDTH,
  NATURE_PALETTE,
  CITY_PALETTE,
  TOWN_PALETTE,
} from "./constants";

/**
 * River — the seam between the Shibuya-style city (south, Z>20) and the quiet
 * town (north, Z<-20). The river runs east-west along Z=0, 40 units deep and
 * 600 wide, with two crossings:
 *
 *  - Modern bridge at X=+60: concrete deck, LED railings, traffic lights.
 *  - Old truss bridge at X=-60: steel truss with cross-beams, sodium lights.
 *
 * City side is a stepped concrete quay with a vertical wall down to the
 * riverbed; town side is a grassy slope scattered with rocks. All static
 * structure is merged into a handful of geometries so the whole river reads
 * in ~10 draw calls. The water is a custom ShaderMaterial: Fresnel sky
 * reflection, a depth gradient (dark centre, light edges), two scrolling
 * ripple normal layers, a sun specular streak, and day/night colour shift
 * driven by uniforms updated every frame. A dark riverbed sits below the
 * semi-transparent surface, and white foam ribbons trace both banks.
 */

/* ------------------------------------------------------------------ *
 *  Layout constants
 * ------------------------------------------------------------------ */

const RIVER_DEPTH = RIVER_HALF_WIDTH * 2; // 40 (Z span)
const WATER_Y = -0.1;
const RIVERBED_Y = -2; // riverbed below the surface for depth
const DECK_Y = 2; // both bridges elevated 2 units above ground
const MODERN_WIDTH = BRIDGE_WIDTH; // 16
const TRUSS_WIDTH = 12; // narrower than the modern bridge
const TRUSS_HALF = TRUSS_WIDTH / 2;
const RAMP_LEN = 8; // approach ramp length (Z) on each bank
const RAMP_ANGLE = Math.atan2(DECK_Y, RAMP_LEN); // rise 2 over 8

/* ------------------------------------------------------------------ *
 *  Colors
 * ------------------------------------------------------------------ */

const CONCRETE = new THREE.Color(CITY_PALETTE.concreteLow);
const STEEL = new THREE.Color("#6a6e74");
const GRASS = new THREE.Color(NATURE_PALETTE.grass);
const ROCK = new THREE.Color("#6a6258");
const RIVERBED = new THREE.Color("#1a140e");
const LED_COLOR = new THREE.Color("#a0e0ff");
const SODIUM_COLOR = new THREE.Color(TOWN_PALETTE.streetlight);

/* ------------------------------------------------------------------ *
 *  Geometry helpers
 * ------------------------------------------------------------------ */

/** Build a transform matrix = Translate * RotateX (rotate-then-translate). */
function tf(x: number, y: number, z: number, angleX = 0): THREE.Matrix4 {
  const m = new THREE.Matrix4().makeTranslation(x, y, z);
  if (angleX !== 0) m.multiply(new THREE.Matrix4().makeRotationX(angleX));
  return m;
}

/** Create a transformed box geometry (for merging). */
function box(w: number, h: number, d: number, m: THREE.Matrix4): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.applyMatrix4(m);
  return g;
}

/** Transformed box with a flat per-vertex colour (for vertex-colour merges). */
function boxColored(
  w: number,
  h: number,
  d: number,
  m: THREE.Matrix4,
  color: THREE.Color,
): THREE.BufferGeometry {
  const g = box(w, h, d, m);
  const colors = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < colors.length; i += 3) {
    colors[i] = color.r;
    colors[i + 1] = color.g;
    colors[i + 2] = color.b;
  }
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return g;
}

/* ------------------------------------------------------------------ *
 *  Procedural textures
 * ------------------------------------------------------------------ */

/**
 * Multi-octave ripple normal map. `phase` offsets the noise so two layers can
 * share the generator but produce distinct patterns. 256x256 with four octaves
 * for organic (non-grid) ripples.
 */
function makeRippleNormalMap(size = 256, phase = 0): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const h = (x: number, y: number) => {
    let v = 0;
    v += Math.sin(x * 0.08 + phase) * Math.cos(y * 0.06 + phase * 1.3) * 1.0;
    v += Math.sin((x + y) * 0.05 + phase * 0.7) * 0.6;
    v += Math.sin(x * 0.15 + phase * 2.1) * Math.cos(y * 0.13) * 0.4;
    v += Math.sin(x * 0.3 + y * 0.2 + phase) * 0.2;
    return v;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = h(x + 1, y) - h(x, y);
      const dy = h(x, y + 1) - h(x, y);
      const nx = -dx;
      const ny = -dy;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      const i = (y * size + x) * 4;
      data[i] = ((nx / len) * 0.5 + 0.5) * 255;
      data[i + 1] = ((ny / len) * 0.5 + 0.5) * 255;
      data[i + 2] = ((nz / len) * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(
    data,
    size,
    size,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 1); // tiling handled in the water shader
  tex.needsUpdate = true;
  return tex;
}

/** Smooth multi-octave value-noise texture (grayscale) for foam / riverbed. */
function makeNoiseTexture(size = 128, octaves = 4): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const n = (x: number, y: number) => {
    let v = 0;
    let amp = 0.5;
    let freq = 1;
    for (let o = 0; o < octaves; o++) {
      v += Math.sin(x * freq * 0.13) * Math.cos(y * freq * 0.11 + 1.7) * amp;
      amp *= 0.5;
      freq *= 2.0;
    }
    return (v + 1) * 0.5; // 0..1
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = Math.max(0, Math.min(1, n(x, y)));
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = Math.floor(v * 255);
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(
    data,
    size,
    size,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** Concrete albedo: cool grey with mottled stains and darker joints. */
function makeConcreteTexture(size = 128): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const base = new THREE.Color(CITY_PALETTE.concreteLow);
  const stain = new THREE.Color("#7d838b");
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Blotchy variation.
      let v = Math.sin(x * 0.21) * Math.cos(y * 0.17) * 0.5;
      v += Math.sin((x + y) * 0.09) * 0.3;
      v = v * 0.5 + 0.5;
      const c = base.clone().lerp(stain, v * 0.6);
      // Darken near tile edges to suggest concrete joints.
      const ex = Math.min(x, size - 1 - x);
      const ey = Math.min(y, size - 1 - y);
      const edge = Math.min(ex, ey);
      const joint = edge < 3 ? 0.7 : 1.0;
      const i = (y * size + x) * 4;
      data[i] = Math.floor(c.r * 255 * joint);
      data[i + 1] = Math.floor(c.g * 255 * joint);
      data[i + 2] = Math.floor(c.b * 255 * joint);
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(
    data,
    size,
    size,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(40, 4); // tile along the long quay
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------------ *
 *  Water shader — Fresnel reflection + depth gradient + sun specular
 * ------------------------------------------------------------------ */

const WATER_VERT = /* glsl */ `
  varying vec3 vWorldPos;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const WATER_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uDayFactor;     // 0 night, 1 day
  uniform vec3  uSunDir;        // unit vector toward the sun
  uniform vec3  uSunColor;
  uniform vec3  uSkyColor;      // horizon colour, reflected at grazing angles
  uniform vec3  uWaterDeep;     // dark centre colour
  uniform vec3  uWaterShallow;  // lighter edge colour
  uniform vec3  uWaterNight;
  uniform sampler2D uNormalMap;
  uniform sampler2D uNormalMap2;
  uniform float uNormalScale;

  varying vec3 vWorldPos;
  varying vec2 vUv;

  void main() {
    // Two scrolling normal layers at different scales + speeds for organic motion.
    vec2 uv1 = vUv * vec2(60.0, 5.0) + vec2(uTime * 0.025, uTime * 0.012);
    vec2 uv2 = vUv * vec2(22.0, 2.5) + vec2(-uTime * 0.018, uTime * 0.03);
    vec3 n1 = texture2D(uNormalMap, uv1).rgb * 2.0 - 1.0;
    vec3 n2 = texture2D(uNormalMap2, uv2).rgb * 2.0 - 1.0;
    vec3 np = normalize(n1 + n2 * 0.7);

    // Perturb the flat up-normal in world space (plane lies in XZ).
    vec3 N = vec3(0.0, 1.0, 0.0);
    N.xz += np.xy * uNormalScale;
    N = normalize(N);

    vec3 V = normalize(cameraPosition - vWorldPos);

    // Fresnel: reflective at grazing angles, transparent when looking down.
    float fres = pow(1.0 - max(dot(V, N), 0.0), 5.0);
    fres = mix(0.04, 1.0, fres);

    // Depth gradient across the river width (Z): 1 at centre, 0 at banks.
    float bankDist = clamp(abs(vWorldPos.z) / 20.0, 0.0, 1.0);
    float depth = 1.0 - bankDist;

    // Water body: deep + dark in the centre, shallow + light at the edges,
    // then crossfade to a near-black night colour.
    vec3 waterDay = mix(uWaterShallow, uWaterDeep, depth);
    vec3 waterCol = mix(uWaterNight, waterDay, uDayFactor);

    // Sun specular streak (only meaningful by day).
    vec3 H = normalize(V + uSunDir);
    float spec = pow(max(dot(N, H), 0.0), 140.0);
    vec3 specular = uSunColor * spec * (0.4 + uDayFactor * 2.6);

    // Blend body colour toward sky reflection via Fresnel.
    vec3 col = mix(waterCol, uSkyColor, fres);
    col += specular;

    // Thin foam lighten right at the banks.
    float foamBand = smoothstep(0.92, 1.0, bankDist);
    col = mix(col, vec3(0.9, 0.95, 1.0), foamBand * 0.5);

    // Edges more transparent (see through to the riverbed), centre opaque;
    // grazing angles become fully reflective/opaque.
    float edgeAlpha = mix(0.32, 0.9, depth);
    float alpha = clamp(mix(edgeAlpha, 1.0, fres), 0.0, 1.0);

    gl_FragColor = vec4(col, alpha);
  }
`;

/* ------------------------------------------------------------------ *
 *  Bank foam shader — frothy white ribbon where water meets the embankment
 * ------------------------------------------------------------------ */

const FOAM_VERT = /* glsl */ `
  varying vec3 vWorldPos;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FOAM_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uFoamIntensity;
  uniform sampler2D uFoamMap;
  varying vec3 vWorldPos;
  varying vec2 vUv;

  void main() {
    // Distance from the nearest bank (Z = +/-20). 0 at the bank, into the water.
    float dist = 20.0 - abs(vWorldPos.z);
    float band = smoothstep(2.6, 0.15, dist); // peak right at the bank
    // Scrolling froth noise.
    float n = texture2D(uFoamMap, vUv * vec2(50.0, 8.0) + vec2(uTime * 0.06, -uTime * 0.03)).r;
    float a = band * (0.35 + 0.65 * n) * uFoamIntensity;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vec3(0.93, 0.97, 1.0), a);
  }
`;

/* ------------------------------------------------------------------ *
 *  Traffic light shader — one mesh, three lenses, a cycling phase
 * ------------------------------------------------------------------ */

const TRAFFIC_VERT = /* glsl */ `
  attribute float aLens;
  varying float vLens;
  void main() {
    vLens = aLens;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const TRAFFIC_FRAG = /* glsl */ `
  uniform float uPhase;
  uniform float uNight;
  varying float vLens;
  void main() {
    vec3 red = vec3(1.0, 0.10, 0.05);
    vec3 yel = vec3(1.0, 0.75, 0.10);
    vec3 grn = vec3(0.10, 1.0, 0.25);
    vec3 col = vLens < 0.5 ? red : (vLens < 1.5 ? yel : grn);
    float lit = 1.0 - step(0.5, abs(vLens - uPhase));
    float intensity = 0.25 + lit * (1.6 + uNight * 1.4);
    gl_FragColor = vec4(col * intensity, 1.0);
  }
`;

/** Build the merged 3-lens traffic-light geometry with an aLens attribute. */
function makeTrafficLightGeometry(
  x: number,
  yBase: number,
  z: number,
): THREE.BufferGeometry {
  const lenses: THREE.BufferGeometry[] = [];
  const lensY = [yBase + 0.5, yBase, yBase - 0.5]; // red, yellow, green
  for (let i = 0; i < 3; i++) {
    const g = new THREE.BoxGeometry(0.35, 0.35, 0.15);
    g.applyMatrix4(tf(x, lensY[i], z + 0.3));
    const aLens = new Float32Array(g.attributes.position.count).fill(i);
    g.setAttribute("aLens", new THREE.BufferAttribute(aLens, 1));
    lenses.push(g);
  }
  return mergeGeometries(lenses, false)!;
}

/* ------------------------------------------------------------------ *
 *  Bridge geometry builders
 * ------------------------------------------------------------------ */

/** Modern concrete bridge: deck, piers, railing posts, top rail, TL pole. */
function buildModernBridge(): THREE.BufferGeometry {
  const x = BRIDGE_MODERN_X;
  const half = MODERN_WIDTH / 2;
  const parts: THREE.BufferGeometry[] = [];

  // Deck spanning the river.
  parts.push(box(MODERN_WIDTH, 0.4, RIVER_DEPTH, tf(x, DECK_Y, 0)));

  // Two piers in the water supporting the deck.
  for (const z of [-10, 10]) {
    parts.push(box(2, 4, 4, tf(x, 0, z)));
  }

  // Railing posts along both sides + concrete top rail.
  for (const side of [-half, half]) {
    for (let z = -RIVER_HALF_WIDTH; z <= RIVER_HALF_WIDTH + 0.01; z += 4) {
      parts.push(box(0.15, 1, 0.15, tf(x + side, DECK_Y + 0.7, z)));
    }
    parts.push(box(0.2, 0.15, RIVER_DEPTH, tf(x + side, DECK_Y + 1.2, 0)));
  }

  // Approach ramps (city side Z>0, town side Z<0).
  parts.push(box(MODERN_WIDTH, 0.3, RAMP_LEN, tf(x, DECK_Y / 2, RIVER_HALF_WIDTH + RAMP_LEN / 2, RAMP_ANGLE)));
  parts.push(box(MODERN_WIDTH, 0.3, RAMP_LEN, tf(x, DECK_Y / 2, -RIVER_HALF_WIDTH - RAMP_LEN / 2, -RAMP_ANGLE)));

  // Traffic-light pole + housing at the city (south) end, beside the railing.
  parts.push(box(0.2, 4, 0.2, tf(x + half, DECK_Y + 2, RIVER_HALF_WIDTH)));
  parts.push(box(0.5, 1.2, 0.5, tf(x + half, DECK_Y + 3.2, RIVER_HALF_WIDTH)));

  return mergeGeometries(parts, false)!;
}

/** Modern bridge LED railing strips (emissive, separate material). */
function buildModernLedRailing(): THREE.BufferGeometry {
  const x = BRIDGE_MODERN_X;
  const half = MODERN_WIDTH / 2;
  const parts: THREE.BufferGeometry[] = [];
  for (const side of [-half, half]) {
    parts.push(box(0.25, 0.2, RIVER_DEPTH, tf(x + side, DECK_Y + 1.3, 0)));
  }
  return mergeGeometries(parts, false)!;
}

/** Old steel truss bridge: deck, chords, verticals, diagonals, cross-beams. */
function buildTrussBridge(): THREE.BufferGeometry {
  const x = BRIDGE_TRUSS_X;
  const parts: THREE.BufferGeometry[] = [];

  // Deck + supporting piers.
  parts.push(box(TRUSS_WIDTH, 0.4, RIVER_DEPTH, tf(x, DECK_Y, 0)));
  for (const z of [-10, 10]) {
    parts.push(box(2, 4, 4, tf(x, 0, z)));
  }

  const topY = DECK_Y + 2.2; // top chord height
  const botY = DECK_Y + 0.3; // bottom chord just above deck
  const midY = (topY + botY) / 2;
  const panelLen = 5;
  const panelAngle = Math.atan2(topY - botY, panelLen);

  for (const side of [-TRUSS_HALF, TRUSS_HALF]) {
    const sx = x + side;
    // Bottom + top chords.
    parts.push(box(0.2, 0.2, RIVER_DEPTH, tf(sx, botY, 0)));
    parts.push(box(0.2, 0.2, RIVER_DEPTH, tf(sx, topY, 0)));

    // Verticals + diagonals per panel.
    for (let z = -RIVER_HALF_WIDTH; z <= RIVER_HALF_WIDTH + 0.01; z += panelLen) {
      parts.push(box(0.2, topY - botY, 0.2, tf(sx, midY, z)));
    }
    for (let i = 0; i < RIVER_DEPTH / panelLen; i++) {
      const z0 = -RIVER_HALF_WIDTH + i * panelLen;
      const zc = z0 + panelLen / 2;
      // Alternate diagonal direction (Warren truss).
      const angle = i % 2 === 0 ? -panelAngle : panelAngle;
      const len = Math.hypot(topY - botY, panelLen);
      parts.push(box(0.15, 0.15, len, tf(sx, midY, zc, angle)));
    }
  }

  // Cross-beams tying the two trusses together (top + bottom), per panel.
  for (let z = -RIVER_HALF_WIDTH; z <= RIVER_HALF_WIDTH + 0.01; z += panelLen) {
    parts.push(box(TRUSS_WIDTH, 0.15, 0.15, tf(x, topY, z)));
    parts.push(box(TRUSS_WIDTH, 0.2, 0.2, tf(x, DECK_Y - 0.1, z)));
  }

  // Approach ramps.
  parts.push(box(TRUSS_WIDTH, 0.3, RAMP_LEN, tf(x, DECK_Y / 2, RIVER_HALF_WIDTH + RAMP_LEN / 2, RAMP_ANGLE)));
  parts.push(box(TRUSS_WIDTH, 0.3, RAMP_LEN, tf(x, DECK_Y / 2, -RIVER_HALF_WIDTH - RAMP_LEN / 2, -RAMP_ANGLE)));

  return mergeGeometries(parts, false)!;
}

/** Truss bridge sodium lights (emissive, separate material). */
function buildTrussSodiumLights(): THREE.BufferGeometry {
  const x = BRIDGE_TRUSS_X;
  const parts: THREE.BufferGeometry[] = [];
  for (const z of [-15, -5, 5, 15]) {
    // Small lamp housing on the deck.
    parts.push(box(0.4, 0.4, 0.4, tf(x, DECK_Y + 0.6, z)));
  }
  return mergeGeometries(parts, false)!;
}

/* ------------------------------------------------------------------ *
 *  Embankment geometry
 * ------------------------------------------------------------------ */

/**
 * City (south) bank: a proper stepped concrete quay — vertical wall from the
 * riverbed up to ground level, a cap, and steps descending into the water.
 */
function buildCityEmbankment(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  // Vertical quay wall from riverbed (Y=-2) up to ground (~Y=0.6).
  parts.push(box(WORLD_SIZE, 2.6, 0.8, tf(0, -0.7, 19.8)));
  // Top cap / footpath edge.
  parts.push(box(WORLD_SIZE, 0.3, 1.2, tf(0, 0.6, 19.4)));
  // Three steps descending into the water on the river side.
  const steps = [
    { z: 18.6, y: 0.1 },
    { z: 17.8, y: -0.3 },
    { z: 17.0, y: -0.7 },
  ];
  for (const s of steps) {
    parts.push(box(WORLD_SIZE, 0.5, 0.9, tf(0, s.y, s.z)));
  }
  return mergeGeometries(parts, false)!;
}

/**
 * Town (north) bank: a grassy slope scattered with rocks. Single merged,
 * vertex-coloured geometry so grass and rocks share one draw call.
 */
function buildTownEmbankment(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  // Grassy slope rising from the waterline up to the town ground.
  const slope = boxColored(WORLD_SIZE, 0.4, 4.5, tf(0, -0.1, -22, -0.13), GRASS);
  parts.push(slope);
  // A darker grass lip right at the waterline.
  parts.push(boxColored(WORLD_SIZE, 0.3, 1.0, tf(0, -0.15, -20.2), new THREE.Color(NATURE_PALETTE.grassDark)));
  // Scattered rocks along the bank (deterministic spacing via a fixed seed).
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < 48; i++) {
    const x = -WORLD_SIZE / 2 + rand() * WORLD_SIZE;
    const z = -20 - rand() * 3.2;
    const r = 0.25 + rand() * 0.55;
    const shade = 0.8 + rand() * 0.4;
    const rockColor = ROCK.clone().multiplyScalar(shade);
    parts.push(boxColored(r * 2, r, r * 1.6, tf(x, -0.3 + rand() * 0.4, z), rockColor));
  }
  return mergeGeometries(parts, false)!;
}

/* ------------------------------------------------------------------ *
 *  Component
 * ------------------------------------------------------------------ */

export function River() {
  const stateRef = useDayNightState();

  // --- Materials (reactive, updated each frame) ---
  const waterMatRef = useRef<THREE.ShaderMaterial>(null);
  const foamMatRef = useRef<THREE.ShaderMaterial>(null);
  const ledMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const sodiumMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const trafficMatRef = useRef<THREE.ShaderMaterial>(null);

  // --- Procedural textures ---
  const normalMap1 = useMemo(() => makeRippleNormalMap(256, 0), []);
  const normalMap2 = useMemo(() => makeRippleNormalMap(256, 3.7), []);
  const foamMap = useMemo(() => makeNoiseTexture(128, 4), []);
  const concreteMap = useMemo(() => makeConcreteTexture(128), []);
  const riverbedMap = useMemo(() => makeNoiseTexture(128, 3), []);

  // --- Water + foam shader uniforms (stable, mutated each frame) ---
  const waterUniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uDayFactor: { value: 1 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color("#fff5e0") },
      uSkyColor: { value: new THREE.Color("#b8d0f0") },
      uWaterDeep: { value: new THREE.Color("#0d2a4a") },
      uWaterShallow: { value: new THREE.Color("#3a6a9a") },
      uWaterNight: { value: new THREE.Color("#040a18") },
      uNormalMap: { value: normalMap1 },
      uNormalMap2: { value: normalMap2 },
      uNormalScale: { value: 0.18 },
    }),
    [normalMap1, normalMap2],
  );

  const foamUniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uFoamIntensity: { value: 1 },
      uFoamMap: { value: foamMap },
    }),
    [foamMap],
  );

  // --- Static merged geometries ---
  const modernBridgeGeo = useMemo(() => buildModernBridge(), []);
  const modernLedGeo = useMemo(() => buildModernLedRailing(), []);
  const trussBridgeGeo = useMemo(() => buildTrussBridge(), []);
  const trussSodiumGeo = useMemo(() => buildTrussSodiumLights(), []);
  const cityEmbankmentGeo = useMemo(() => buildCityEmbankment(), []);
  const townEmbankmentGeo = useMemo(() => buildTownEmbankment(), []);
  const trafficGeo = useMemo(
    () => makeTrafficLightGeometry(BRIDGE_MODERN_X + MODERN_WIDTH / 2, DECK_Y + 3.2, RIVER_HALF_WIDTH),
    [],
  );

  // --- Traffic light cycle state ---
  const cycleRef = useRef(0);

  useFrame((_, delta) => {
    const s = stateRef.current;
    const dayFactor = THREE.MathUtils.clamp(s.sunIntensity / 3, 0, 1);

    // Water shader: time, day/night blend, sun + sky reflection colours.
    if (waterMatRef.current) {
      const u = waterMatRef.current.uniforms;
      u.uTime.value += delta;
      u.uDayFactor.value = dayFactor;
      u.uSunDir.value.copy(s.sunPosition).normalize();
      u.uSunColor.value.copy(s.sunColor);
      u.uSkyColor.value.copy(s.skyHorizon);
    }

    // Foam: scroll time; brighter at night so the banks still read.
    if (foamMatRef.current) {
      foamMatRef.current.uniforms.uTime.value += delta;
      foamMatRef.current.uniforms.uFoamIntensity.value = 0.7 + (1 - dayFactor) * 0.6;
    }

    // Modern LED railing: bright blue-white at night, faint by day.
    if (ledMatRef.current) {
      ledMatRef.current.emissiveIntensity = 0.2 + s.neonIntensity * 2.5;
    }

    // Truss sodium lamps: on with the streetlight schedule.
    if (sodiumMatRef.current) {
      sodiumMatRef.current.emissiveIntensity = s.streetlightIntensity * 2.2;
    }

    // Traffic light cycle: green 5s -> yellow 2s -> red 6s, looping.
    if (trafficMatRef.current) {
      cycleRef.current = (cycleRef.current + delta) % 13;
      const t = cycleRef.current;
      const phase = t < 5 ? 2 : t < 7 ? 1 : 0; // 2=green, 1=yellow, 0=red
      trafficMatRef.current.uniforms.uPhase.value = phase;
      trafficMatRef.current.uniforms.uNight.value = 1 - dayFactor;
    }
  });

  return (
    <group>
      {/* Dark riverbed below the semi-transparent water surface for depth. */}
      <mesh position={[0, RIVERBED_Y, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[WORLD_SIZE, RIVER_DEPTH]} />
        <meshStandardMaterial color={RIVERBED} map={riverbedMap} roughness={1} metalness={0} />
      </mesh>

      {/* Water surface — custom shader: Fresnel, depth gradient, ripples, sun. */}
      <mesh
        position={[0, WATER_Y, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        renderOrder={1}
        receiveShadow
      >
        <planeGeometry args={[WORLD_SIZE, RIVER_DEPTH]} />
        <shaderMaterial
          ref={waterMatRef}
          vertexShader={WATER_VERT}
          fragmentShader={WATER_FRAG}
          uniforms={waterUniforms}
          transparent
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Bank foam ribbons (south + north) — frothy white where water meets land. */}
      <mesh
        position={[0, WATER_Y + 0.03, RIVER_HALF_WIDTH - 1.5]}
        rotation={[-Math.PI / 2, 0, 0]}
        renderOrder={2}
      >
        <planeGeometry args={[WORLD_SIZE, 3]} />
        <shaderMaterial
          ref={foamMatRef}
          vertexShader={FOAM_VERT}
          fragmentShader={FOAM_FRAG}
          uniforms={foamUniforms}
          transparent
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      <mesh
        position={[0, WATER_Y + 0.03, -RIVER_HALF_WIDTH + 1.5]}
        rotation={[-Math.PI / 2, 0, 0]}
        renderOrder={2}
      >
        <planeGeometry args={[WORLD_SIZE, 3]} />
        <shaderMaterial
          vertexShader={FOAM_VERT}
          fragmentShader={FOAM_FRAG}
          uniforms={foamUniforms}
          transparent
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>

      {/* City (south) stepped concrete quay with texture — 1 draw call. */}
      <mesh geometry={cityEmbankmentGeo} castShadow receiveShadow>
        <meshStandardMaterial color={CONCRETE} map={concreteMap} roughness={0.92} metalness={0} />
      </mesh>

      {/* Town (north) grassy slope with rocks (vertex-coloured) — 1 draw call. */}
      <mesh geometry={townEmbankmentGeo} castShadow receiveShadow>
        <meshStandardMaterial color="#ffffff" vertexColors roughness={1} metalness={0} />
      </mesh>

      {/* Modern bridge structure (concrete) — 1 draw call. */}
      <mesh geometry={modernBridgeGeo} castShadow receiveShadow>
        <meshStandardMaterial color={CONCRETE} roughness={0.85} metalness={0} />
      </mesh>

      {/* Modern bridge LED railing (emissive) — 1 draw call. */}
      <mesh geometry={modernLedGeo}>
        <meshStandardMaterial
          ref={ledMatRef}
          color="#000000"
          emissive={LED_COLOR}
          emissiveIntensity={1.5}
          toneMapped={false}
        />
      </mesh>

      {/* Traffic light lenses (cycling shader) — 1 draw call. */}
      <mesh geometry={trafficGeo}>
        <shaderMaterial
          ref={trafficMatRef}
          vertexShader={TRAFFIC_VERT}
          fragmentShader={TRAFFIC_FRAG}
          uniforms={{
            uPhase: { value: 2 },
            uNight: { value: 0 },
          }}
          toneMapped={false}
        />
      </mesh>

      {/* Old truss bridge (steel) — 1 draw call. */}
      <mesh geometry={trussBridgeGeo} castShadow receiveShadow>
        <meshStandardMaterial color={STEEL} roughness={0.5} metalness={0.6} />
      </mesh>

      {/* Truss bridge sodium lights (emissive) — 1 draw call. */}
      <mesh geometry={trussSodiumGeo}>
        <meshStandardMaterial
          ref={sodiumMatRef}
          color="#000000"
          emissive={SODIUM_COLOR}
          emissiveIntensity={2.0}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}

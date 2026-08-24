import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { useDayNightState } from "./DayNight";
import { CITY_NS_ROADS, CITY_EW_ROADS, CITY_PALETTE } from "./constants";

/**
 * StreetFurniture — the small Japanese-city details that make the ParCoar
 * open world read as *Japan* rather than a generic city grid.
 *
 * Six categories, all built once into merged BufferGeometries so the whole
 * layer costs ~10 draw calls:
 *
 *  1. Vending machines   — glowing boxes at intersections, two emissive
 *                          front panels (cyan / warm white) that ramp up at
 *                          night and fake a light pool on the street.
 *  2. Utility poles      — wooden poles with cross-arms along every city
 *                          road, plus catenary wire pairs (TubeGeometry along
 *                          a sagging Catmull-Rom curve) between adjacent
 *                          poles. This overhead-wire grid is the single
 *                          strongest "Japanese city" visual marker.
 *  3. Konbini            — a couple of convenience stores: glazed front,
 *                          bright warm-white interior glow (night beacon),
 *                          red-and-white striped awning.
 *  4. Traffic signals    — Japanese-style horizontal triple-light heads on
 *                          yellow-ish housings, on poles at intersections.
 *  5. Manhole covers     — dark discs set into the asphalt at intersections.
 *
 * Emissive intensities are driven from the shared day/night state every
 * frame (vending panels and konbini glass brighten as neonIntensity rises;
 * signal lamps are always lit but punchier after dark).
 */

/* ------------------------------------------------------------------ *
 *  Layout constants
 * ------------------------------------------------------------------ */

/** Sidewalk offset from a road centerline — where furniture sits. */
const SIDEWALK_OFFSET = 5.5;
/** How far a vending machine is set back from the curb onto the sidewalk. */
const VENDING_OFFSET = 6.0;
/** Pole corner offset from an intersection center — past the road + sidewalk. */
const POLE_OFFSET = 8.0;
/** Pole height. */
const POLE_HEIGHT = 8;
/** Pole top Y (poles are centered at POLE_HEIGHT/2). */
const POLE_TOP_Y = POLE_HEIGHT;
/** Cross-arm length / thickness. */
const CROSS_ARM_LEN = 2;
const CROSS_ARM_THICK = 0.15;
/** Wire attach offset from the pole centerline (cross-arm ends). */
const WIRE_OFFSET = 0.85;
/** Wire sag amount (added to the natural droop from span length). */
const WIRE_SAG = 0.45;
/** Wire tube radius. */
const WIRE_RADIUS = 0.018;

/** Vending machine dimensions (w x h x d). */
const VEND_W = 1.2;
const VEND_H = 2.2;
const VEND_D = 0.8;

/** Signal pole height. */
const SIGNAL_POLE_HEIGHT = 4.5;

/* ------------------------------------------------------------------ *
 *  Geometry transform helper
 * ------------------------------------------------------------------ */

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);

/** Clone a geometry and bake a translation + Y rotation into its vertices. */
function place(
  geo: THREE.BufferGeometry,
  x: number,
  y: number,
  z: number,
  ry = 0,
): THREE.BufferGeometry {
  const g = geo.clone();
  _e.set(0, ry, 0);
  _q.setFromEuler(_e);
  _v.set(x, y, z);
  _m.compose(_v, _q, _s);
  g.applyMatrix4(_m);
  return g;
}

/* ------------------------------------------------------------------ *
 *  Intersection grid
 * ------------------------------------------------------------------ */

/** All city intersections as [x, z] pairs (NS road x EW road). */
const INTERSECTIONS: [number, number][] = [];
for (const x of CITY_NS_ROADS) {
  for (const z of CITY_EW_ROADS) {
    INTERSECTIONS.push([x, z]);
  }
}

/**
 * Deterministic pick of `count` intersections spread across the grid.
 * Uses a stride so the chosen sites are evenly distributed, not clustered.
 */
function pickIntersections(count: number): [number, number][] {
  const step = Math.max(1, Math.floor(INTERSECTIONS.length / count));
  const out: [number, number][] = [];
  for (let i = 0; i < INTERSECTIONS.length && out.length < count; i += step) {
    out.push(INTERSECTIONS[i]);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 *  Wire builder — a sagging catenary tube between two attach points.
 * ------------------------------------------------------------------ */

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _p2 = new THREE.Vector3();

function wireTube(ax: number, ay: number, az: number, bx: number, by: number, bz: number): THREE.BufferGeometry {
  _a.set(ax, ay, az);
  _b.set(bx, by, bz);
  const span = _a.distanceTo(_b);
  const sag = WIRE_SAG + span * 0.015;
  _mid.addVectors(_a, _b).multiplyScalar(0.5);
  _mid.y -= sag;
  _p1.lerpVectors(_a, _mid, 0.5).y -= sag * 0.25;
  _p2.lerpVectors(_mid, _b, 0.5).y -= sag * 0.25;
  const curve = new THREE.CatmullRomCurve3([
    _a.clone(),
    _p1.clone(),
    _mid.clone(),
    _p2.clone(),
    _b.clone(),
  ]);
  return new THREE.TubeGeometry(curve, 12, WIRE_RADIUS, 5, false);
}

/* ------------------------------------------------------------------ *
 *  Striped awning texture (red / white convenience-store awning).
 * ------------------------------------------------------------------ */

function makeStripeTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 32;
  c.height = 8;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#e8e8e8";
  ctx.fillRect(0, 0, 32, 8);
  ctx.fillStyle = "#c83030";
  for (let i = 0; i < 32; i += 8) {
    ctx.fillRect(i, 0, 4, 8);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.repeat.set(10, 1);
  tex.magFilter = THREE.NearestFilter;
  return tex;
}

/* ------------------------------------------------------------------ *
 *  Component
 * ------------------------------------------------------------------ */

export function StreetFurniture() {
  const stateRef = useDayNightState();

  // Material refs whose emissive intensity is animated by the day/night cycle.
  const vendPanelMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const vendPoolMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const signalLampMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const konbiniGlassMatRef = useRef<THREE.MeshStandardMaterial>(null);

  // Build all static merged geometries once.
  const geos = useMemo(() => {
    /* ---- 1. Vending machines (9 sites, offset to sidewalk) ---- */
    const vendBodyParts: THREE.BufferGeometry[] = [];
    const vendPanelParts: THREE.BufferGeometry[] = [];
    const vendPoolParts: THREE.BufferGeometry[] = [];

    const vendSites = pickIntersections(9);
    const bodyGeo = new THREE.BoxGeometry(VEND_W, VEND_H, VEND_D);
    const panelGeo = new THREE.PlaneGeometry(VEND_W * 0.82, 0.7);
    const poolGeo = new THREE.CircleGeometry(1.4, 20);

    vendSites.forEach(([ix, iz], i) => {
      // Alternate which corner of the intersection the machine sits on so
      // they don't all line up on one side.
      const sx = i % 2 === 0 ? 1 : -1;
      const sz = i % 3 === 0 ? 1 : -1;
      const x = ix + sx * VENDING_OFFSET;
      const z = iz + sz * VENDING_OFFSET;
      // Rotate so the front (+Z) faces back toward the intersection center.
      const faceRy = Math.atan2(ix - x, iz - z);

      const frontDist = VEND_D / 2 + 0.01;
      const frontX = x + Math.sin(faceRy) * frontDist;
      const frontZ = z + Math.cos(faceRy) * frontDist;
      // Upper display panel.
      vendPanelParts.push(place(panelGeo, frontX, VEND_H * 0.72, frontZ, faceRy));
      // Lower selection panel.
      vendPanelParts.push(place(panelGeo, frontX, VEND_H * 0.28, frontZ, faceRy));

      // Body.
      vendBodyParts.push(place(bodyGeo, x, VEND_H / 2, z, faceRy));

      // Fake light pool on the ground in front of the machine.
      const poolX = x + Math.sin(faceRy) * 1.2;
      const poolZ = z + Math.cos(faceRy) * 1.2;
      vendPoolParts.push(place(poolGeo, poolX, 0.03, poolZ, faceRy));
    });

    const vendingBody = mergeGeometries(vendBodyParts, false) ?? new THREE.BufferGeometry();
    const vendingPanels = mergeGeometries(vendPanelParts, false) ?? new THREE.BufferGeometry();
    const vendingPools = mergeGeometries(vendPoolParts, false) ?? new THREE.BufferGeometry();

    /* ---- 2. Utility poles + overhead wires ---- */
    const poleParts: THREE.BufferGeometry[] = [];
    const wireParts: THREE.BufferGeometry[] = [];

    const poleGeo = new THREE.CylinderGeometry(0.15, 0.18, POLE_HEIGHT, 8);
    const armGeo = new THREE.BoxGeometry(CROSS_ARM_LEN, CROSS_ARM_THICK, CROSS_ARM_THICK);
    const armGeoT = new THREE.BoxGeometry(CROSS_ARM_THICK, CROSS_ARM_THICK, CROSS_ARM_LEN);

    // Pole base positions: one at each intersection corner.
    const polePos: [number, number][][] = [];
    for (let xi = 0; xi < CITY_NS_ROADS.length; xi++) {
      polePos[xi] = [];
      for (let zi = 0; zi < CITY_EW_ROADS.length; zi++) {
        const px = CITY_NS_ROADS[xi] + POLE_OFFSET;
        const pz = CITY_EW_ROADS[zi] + POLE_OFFSET;
        polePos[xi][zi] = [px, pz];
        // Pole shaft.
        poleParts.push(place(poleGeo, px, POLE_HEIGHT / 2, pz));
        // Two cross-arms: one along X, one along Z (wires run both directions).
        poleParts.push(place(armGeo, px, POLE_TOP_Y - 0.1, pz));
        poleParts.push(place(armGeoT, px, POLE_TOP_Y - 0.45, pz));
      }
    }

    // Wires: parallel pairs between adjacent poles, offset to the cross-arm
    // ends. The pair is the classic Japanese overhead-wire look.
    const wireY = POLE_TOP_Y - 0.1;
    // Along NS roads (varying Z, fixed X) — perpendicular offset is X.
    for (let xi = 0; xi < CITY_NS_ROADS.length; xi++) {
      for (let zi = 0; zi < CITY_EW_ROADS.length - 1; zi++) {
        const [ax, az] = polePos[xi][zi];
        const [bx, bz] = polePos[xi][zi + 1];
        wireParts.push(wireTube(ax + WIRE_OFFSET, wireY, az, bx + WIRE_OFFSET, wireY, bz));
        wireParts.push(wireTube(ax - WIRE_OFFSET, wireY, az, bx - WIRE_OFFSET, wireY, bz));
      }
    }
    // Along EW roads (varying X, fixed Z) — perpendicular offset is Z.
    for (let zi = 0; zi < CITY_EW_ROADS.length; zi++) {
      for (let xi = 0; xi < CITY_NS_ROADS.length - 1; xi++) {
        const [ax, az] = polePos[xi][zi];
        const [bx, bz] = polePos[xi + 1][zi];
        wireParts.push(wireTube(ax, wireY, az + WIRE_OFFSET, bx, wireY, bz + WIRE_OFFSET));
        wireParts.push(wireTube(ax, wireY, az - WIRE_OFFSET, bx, wireY, bz - WIRE_OFFSET));
      }
    }

    const poles = mergeGeometries(poleParts, false) ?? new THREE.BufferGeometry();
    const wires = mergeGeometries(wireParts, false) ?? new THREE.BufferGeometry();

    /* ---- 3. Traffic signal heads (8 intersections) ---- */
    const signalParts: THREE.BufferGeometry[] = [];
    const signalLampParts: THREE.BufferGeometry[] = [];

    const sigPoleGeo = new THREE.CylinderGeometry(0.09, 0.11, SIGNAL_POLE_HEIGHT, 6);
    const housingGeo = new THREE.BoxGeometry(0.8, 0.3, 0.3);
    const lampGeo = new THREE.CircleGeometry(0.1, 16);

    const signalSites = pickIntersections(8);
    signalSites.forEach(([ix, iz], i) => {
      const sx = i % 2 === 0 ? -1 : 1;
      const sz = i % 4 < 2 ? -1 : 1;
      const x = ix + sx * SIDEWALK_OFFSET;
      const z = iz + sz * SIDEWALK_OFFSET;
      // Pole.
      signalParts.push(place(sigPoleGeo, x, SIGNAL_POLE_HEIGHT / 2, z));
      // Horizontal triple-light housing at the top, facing the intersection.
      const faceRy = Math.atan2(ix - x, iz - z);
      const headY = SIGNAL_POLE_HEIGHT + 0.1;
      signalParts.push(place(housingGeo, x, headY, z, faceRy));
      // Three lamps on the front face (red / yellow / green, left to right).
      const frontOffset = 0.16;
      const lx0 = -0.25;
      const lampX0 = x + Math.sin(faceRy) * frontOffset + Math.cos(faceRy) * lx0;
      const lampZ0 = z + Math.cos(faceRy) * frontOffset - Math.sin(faceRy) * lx0;
      const lampX1 = x + Math.sin(faceRy) * frontOffset;
      const lampZ1 = z + Math.cos(faceRy) * frontOffset;
      const lampX2 = x + Math.sin(faceRy) * frontOffset + Math.cos(faceRy) * 0.25;
      const lampZ2 = z + Math.cos(faceRy) * frontOffset - Math.sin(faceRy) * 0.25;
      signalLampParts.push(place(lampGeo, lampX0, headY, lampZ0, faceRy));
      signalLampParts.push(place(lampGeo, lampX1, headY, lampZ1, faceRy));
      signalLampParts.push(place(lampGeo, lampX2, headY, lampZ2, faceRy));
    });

    const signals = mergeGeometries(signalParts, false) ?? new THREE.BufferGeometry();
    const signalLamps = mergeGeometries(signalLampParts, false) ?? new THREE.BufferGeometry();

    /* ---- 4. Manhole covers (6 intersections) ---- */
    const manholeParts: THREE.BufferGeometry[] = [];
    const manholeGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.05, 20);
    const manholeSites = pickIntersections(6);
    manholeSites.forEach(([ix, iz], i) => {
      // Offset slightly from the exact center so they sit in a lane.
      const ox = (i % 2 === 0 ? 1.5 : -1.5);
      const oz = (i % 3 === 0 ? 1.5 : -1.5);
      manholeParts.push(place(manholeGeo, ix + ox, 0.03, iz + oz));
    });
    const manholes = mergeGeometries(manholeParts, false) ?? new THREE.BufferGeometry();

    /* ---- 5. Konbini (3 stores near intersections) ---- */
    const konbiniBodyParts: THREE.BufferGeometry[] = [];
    const konbiniGlassParts: THREE.BufferGeometry[] = [];
    const konbiniAwningParts: THREE.BufferGeometry[] = [];

    const storeBodyGeo = new THREE.BoxGeometry(8, 3, 6);
    const glassGeo = new THREE.PlaneGeometry(8, 2.6);
    const awningGeo = new THREE.BoxGeometry(8.5, 0.3, 2);

    const konbiniSites = pickIntersections(3);
    konbiniSites.forEach(([ix, iz], i) => {
      // Set the store back from the intersection on one corner.
      const sx = i % 2 === 0 ? 1 : -1;
      const sz = 1;
      const x = ix + sx * 10;
      const z = iz + sz * 8;
      const faceRy = sx > 0 ? -Math.PI / 2 : Math.PI / 2;
      // Body.
      konbiniBodyParts.push(place(storeBodyGeo, x, 1.5, z, faceRy));
      // Glazed front (facing the road).
      const frontDist = 3.01;
      const gx = x + Math.sin(faceRy) * frontDist;
      const gz = z + Math.cos(faceRy) * frontDist;
      konbiniGlassParts.push(place(glassGeo, gx, 1.4, gz, faceRy));
      // Striped awning above the front.
      const awX = x + Math.sin(faceRy) * (frontDist + 0.6);
      const awZ = z + Math.cos(faceRy) * (frontDist + 0.6);
      konbiniAwningParts.push(place(awningGeo, awX, 3.0, awZ, faceRy));
    });

    const konbiniBody = mergeGeometries(konbiniBodyParts, false) ?? new THREE.BufferGeometry();
    const konbiniGlass = mergeGeometries(konbiniGlassParts, false) ?? new THREE.BufferGeometry();
    const konbiniAwning = mergeGeometries(konbiniAwningParts, false) ?? new THREE.BufferGeometry();

    return {
      vendingBody,
      vendingPanels,
      vendingPools,
      poles,
      wires,
      signals,
      signalLamps,
      manholes,
      konbiniBody,
      konbiniGlass,
      konbiniAwning,
    };
  }, []);

  // Awning stripe texture (kept in a ref-like memo so it isn't recreated).
  const stripeTex = useMemo(() => makeStripeTexture(), []);

  // Drive emissive intensities from the day/night state.
  useFrame(() => {
    const s = stateRef.current;
    // night: 0 in daylight, 1 after dark (neon ramps in around sunset).
    const night = s.neonIntensity;

    if (vendPanelMatRef.current) {
      // Vending panels: dim but visible by day, glowing at night.
      vendPanelMatRef.current.emissiveIntensity = 0.35 + night * 2.6;
    }
    if (vendPoolMatRef.current) {
      // Light pool on the street only shows at night.
      vendPoolMatRef.current.emissiveIntensity = night * 1.4;
      vendPoolMatRef.current.opacity = 0.15 + night * 0.5;
    }
    if (signalLampMatRef.current) {
      // Signal lamps are always on; punchier after dark.
      signalLampMatRef.current.emissiveIntensity = 1.2 + night * 1.6;
    }
    if (konbiniGlassMatRef.current) {
      // Konbini interior is always lit (daytime too); brighter beacon at night.
      konbiniGlassMatRef.current.emissiveIntensity = 1.1 + night * 2.2;
    }
  });

  return (
    <group>
      {/* Vending machine bodies (merged). */}
      <mesh geometry={geos.vendingBody} castShadow receiveShadow>
        <meshStandardMaterial color="#2a3038" roughness={0.55} metalness={0.2} />
      </mesh>

      {/* Vending glow panels (merged, emissive — animated). */}
      <mesh geometry={geos.vendingPanels}>
        <meshStandardMaterial
          ref={vendPanelMatRef}
          color="#0a1418"
          emissive={CITY_PALETTE.neonCyan}
          emissiveIntensity={0.35}
          roughness={0.3}
          metalness={0}
          toneMapped={false}
        />
      </mesh>

      {/* Fake light pools under vending machines (merged, emissive disc). */}
      <mesh
        geometry={geos.vendingPools}
        rotation={[-Math.PI / 2, 0, 0]}
        renderOrder={2}
      >
        <meshStandardMaterial
          ref={vendPoolMatRef}
          color={CITY_PALETTE.neonCyan}
          emissive={CITY_PALETTE.neonCyan}
          emissiveIntensity={0}
          transparent
          opacity={0.15}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>

      {/* Utility poles + cross-arms (merged). */}
      <mesh geometry={geos.poles} castShadow>
        <meshStandardMaterial color="#6b5640" roughness={0.92} metalness={0} />
      </mesh>

      {/* Overhead catenary wires (merged). */}
      <mesh geometry={geos.wires}>
        <meshStandardMaterial color="#1a1a1e" roughness={0.8} metalness={0.1} />
      </mesh>

      {/* Traffic signal poles + housings (merged). */}
      <mesh geometry={geos.signals} castShadow>
        <meshStandardMaterial color="#c8b060" roughness={0.6} metalness={0.3} />
      </mesh>

      {/* Signal lamps (merged, emissive — animated). */}
      <mesh geometry={geos.signalLamps}>
        <meshStandardMaterial
          ref={signalLampMatRef}
          color="#0a0a0a"
          emissive={CITY_PALETTE.neonWarmWhite}
          emissiveIntensity={1.2}
          toneMapped={false}
        />
      </mesh>

      {/* Manhole covers (merged). */}
      <mesh geometry={geos.manholes} receiveShadow>
        <meshStandardMaterial color="#1c1a18" roughness={0.7} metalness={0.4} />
      </mesh>

      {/* Konbini store body (merged). */}
      <mesh geometry={geos.konbiniBody} castShadow receiveShadow>
        <meshStandardMaterial color="#e8e2d0" roughness={0.8} metalness={0} />
      </mesh>

      {/* Konbini glazed front — bright interior glow (night beacon). */}
      <mesh geometry={geos.konbiniGlass}>
        <meshStandardMaterial
          ref={konbiniGlassMatRef}
          color="#fff5e0"
          emissive="#fff5e0"
          emissiveIntensity={1.1}
          roughness={0.25}
          metalness={0}
          toneMapped={false}
        />
      </mesh>

      {/* Konbini striped awning (merged). */}
      <mesh geometry={geos.konbiniAwning} castShadow>
        <meshStandardMaterial
          map={stripeTex}
          color="#ffffff"
          roughness={0.7}
          metalness={0}
        />
      </mesh>
    </group>
  );
}

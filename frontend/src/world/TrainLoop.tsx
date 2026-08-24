import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { InstancedMesh, MeshBasicMaterial } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { useDayNightState } from "./DayNight";
import { CITY_PALETTE } from "./constants";

/**
 * Elevated JR-style commuter train that loops the city district on a
 * concrete viaduct. Pure atmosphere: visible from the roads below, warm
 * window glow adding motion to the skyline at night.
 *
 * The loop is a rounded rectangle (Catmull-Rom through four corner points)
 * sitting ~6 units above ground. Six blue cars chase each other around it,
 * completing a full lap in ~90 seconds. Geometry is merged/instanced to
 * keep the whole rig at ~4 draw calls (viaduct, track, car bodies, windows).
 */

/* ------------------------------------------------------------------ *
 *  Constants
 * ------------------------------------------------------------------ */

/** Viaduct deck height above ground (center of the beam). */
const VIADUCT_Y = 6;
/** Viaduct beam cross-section (XZ width × Y height). */
const BEAM_WIDTH = 3;
const BEAM_HEIGHT = 1;
/** Dark track ribbon on top of the viaduct beam. */
const TRACK_WIDTH = 2.5;
const TRACK_HEIGHT = 0.12;
/** Number of segments the loop beam is chopped into for merging. */
const SEGMENTS = 240;
/** Arc-length spacing between viaduct support pillars. */
const PILLAR_SPACING = 25;
/** Support pillar cross-section (X × Z, in units). */
const PILLAR_SIZE = 2;
/** Train cars chasing each other around the loop. */
const CAR_COUNT = 6;
/** Car body box: width (X) × height (Y) × length (Z, along track). */
const CAR_W = 2;
const CAR_H = 2.5;
const CAR_L = 5;
/** Real-time seconds for one full lap. */
const LOOP_SECONDS = 90;

const CONCRETE = "#6a6e74";
const TRACK_COLOR = "#1a1a1e";
const CAR_BLUE = "#2a8acf";

/**
 * Catmull-Rom control points — the four corners of a rounded rectangle
 * enclosing the city district. Y is the viaduct deck height. With
 * `closed=true` the curve smooths the corners into broad arcs.
 */
const CURVE_POINTS = [
  new THREE.Vector3(-120, VIADUCT_Y, 30),
  new THREE.Vector3(120, VIADUCT_Y, 30),
  new THREE.Vector3(120, VIADUCT_Y, 180),
  new THREE.Vector3(-120, VIADUCT_Y, 180),
];

/* ------------------------------------------------------------------ *
 *  Geometry builders (run once, merged for low draw-call count)
 * ------------------------------------------------------------------ */

/**
 * Build a merged box-beam that follows the curve. Each segment is a box
 * of `width × height × segmentLength` oriented along the curve tangent,
 * then baked into a single BufferGeometry.
 *
 * `yOffset` shifts the beam above the viaduct deck (used for the track
 * ribbon sitting on top of the concrete beam).
 */
function buildBeamGeometry(
  curve: THREE.CatmullRomCurve3,
  width: number,
  height: number,
  yOffset: number,
  segments: number,
): THREE.BufferGeometry {
  const zAxis = new THREE.Vector3(0, 0, 1);
  const geos: THREE.BufferGeometry[] = [];

  for (let i = 0; i < segments; i++) {
    const t0 = i / segments;
    const t1 = (i + 1) / segments;
    const p0 = curve.getPointAt(t0);
    const p1 = curve.getPointAt(t1);
    const len = p0.distanceTo(p1);

    const mid = p0.clone().add(p1).multiplyScalar(0.5);
    mid.y = VIADUCT_Y + yOffset;

    const tan = curve.getTangentAt(t0).normalize();
    const quat = new THREE.Quaternion().setFromUnitVectors(zAxis, tan);

    const geo = new THREE.BoxGeometry(width, height, len);
    geo.applyMatrix4(
      new THREE.Matrix4().compose(mid, quat, new THREE.Vector3(1, 1, 1)),
    );
    geos.push(geo);
  }

  const merged = mergeGeometries(geos, false);
  // Drop the per-segment boxes; only the merged buffer is kept.
  for (const g of geos) g.dispose();
  return merged;
}

/**
 * Build merged support pillars holding the viaduct deck up. Samples the
 * curve at regular arc-length intervals (~`PILLAR_SPACING` units apart)
 * and drops a box column from the deck (Y=VIADUCT_Y) down to ground
 * (Y=0) at each sample. Pillars sit under the beam, so they never clash
 * with roads or buildings on the ground plane.
 */
function buildPillarGeometry(curve: THREE.CatmullRomCurve3): THREE.BufferGeometry {
  const totalLen = curve.getLength();
  const count = Math.max(1, Math.round(totalLen / PILLAR_SPACING));
  const geos: THREE.BufferGeometry[] = [];

  for (let i = 0; i < count; i++) {
    // getPointAt is arc-length parameterized, so even spacing in t gives
    // even spacing along the curve.
    const p = curve.getPointAt(i / count);
    const geo = new THREE.BoxGeometry(PILLAR_SIZE, VIADUCT_Y, PILLAR_SIZE);
    geo.translate(p.x, VIADUCT_Y / 2, p.z);
    geos.push(geo);
  }

  const merged = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  return merged;
}

/** Car body: a single blue box, instanced across all cars. */
function buildCarBodyGeometry(): THREE.BufferGeometry {
  return new THREE.BoxGeometry(CAR_W, CAR_H, CAR_L);
}

/**
 * Window strip: two emissive planes (one per side) merged into one
 * geometry, instanced across all cars. Rendered with an unlit basic
 * material so the warm glow reads as emission at night.
 */
function buildWindowGeometry(): THREE.BufferGeometry {
  const winW = CAR_L * 0.78;
  const winH = CAR_H * 0.5;
  const sideX = CAR_W / 2 + 0.02;
  // Slight upward bias so windows sit above the car's belt line.
  const winY = CAR_H * 0.12;

  const right = new THREE.PlaneGeometry(winW, winH)
    .rotateY(Math.PI / 2)
    .translate(sideX, winY, 0);
  const left = new THREE.PlaneGeometry(winW, winH)
    .rotateY(Math.PI / 2)
    .translate(-sideX, winY, 0);

  return mergeGeometries([right, left], false);
}

/* ------------------------------------------------------------------ *
 *  Component
 * ------------------------------------------------------------------ */

export function TrainLoop() {
  const stateRef = useDayNightState();

  const bodyInstRef = useRef<InstancedMesh>(null);
  const windowInstRef = useRef<InstancedMesh>(null);
  const windowMatRef = useRef<MeshBasicMaterial>(null);

  // Progress of the lead car around the loop, in [0, 1).
  const baseT = useRef(0);
  // Reusable scratch object for composing instance matrices.
  const dummy = useMemo(() => new THREE.Object3D(), []);

  const curve = useMemo(
    () => new THREE.CatmullRomCurve3(CURVE_POINTS, true),
    [],
  );

  const viaductGeo = useMemo(() => {
    const beam = buildBeamGeometry(curve, BEAM_WIDTH, BEAM_HEIGHT, 0, SEGMENTS);
    const pillars = buildPillarGeometry(curve);
    // Merge deck + pillars into one buffer so the whole viaduct (deck and
    // its supports) renders in a single draw call under the concrete material.
    const merged = mergeGeometries([beam, pillars], false);
    beam.dispose();
    pillars.dispose();
    return merged;
  }, [curve]);
  const trackGeo = useMemo(
    () =>
      buildBeamGeometry(
        curve,
        TRACK_WIDTH,
        TRACK_HEIGHT,
        BEAM_HEIGHT / 2 + TRACK_HEIGHT / 2,
        SEGMENTS,
      ),
    [curve],
  );

  const carBodyGeo = useMemo(() => buildCarBodyGeometry(), []);
  const windowGeo = useMemo(() => buildWindowGeometry(), []);

  // Car body center Y: viaduct deck + track ribbon + half car height.
  const carY = VIADUCT_Y + BEAM_HEIGHT / 2 + TRACK_HEIGHT + CAR_H / 2;

  useFrame((_, delta) => {
    const body = bodyInstRef.current;
    const win = windowInstRef.current;
    if (!body || !win) return;

    // Advance the lead car; clamp delta so a stutter doesn't teleport it.
    baseT.current = (baseT.current + Math.min(delta, 0.1) / LOOP_SECONDS) % 1;

    const zAxis = new THREE.Vector3(0, 0, 1);
    for (let i = 0; i < CAR_COUNT; i++) {
      const t = (baseT.current + i / CAR_COUNT) % 1;
      const p = curve.getPointAt(t);
      const tan = curve.getTangentAt(t).normalize();

      dummy.position.copy(p);
      dummy.position.y = carY;
      dummy.quaternion.setFromUnitVectors(zAxis, tan);
      dummy.updateMatrix();

      body.setMatrixAt(i, dummy.matrix);
      win.setMatrixAt(i, dummy.matrix);
    }
    body.instanceMatrix.needsUpdate = true;
    win.instanceMatrix.needsUpdate = true;

    // Window glow: dim blue-grey by day, warm and bright at night.
    const mat = windowMatRef.current;
    if (mat) {
      const glow = stateRef.current.windowGlow;
      mat.opacity = 0.12 + glow * 0.88;
    }
  });

  return (
    <group>
      {/* Concrete viaduct beam */}
      <mesh geometry={viaductGeo} castShadow receiveShadow>
        <meshStandardMaterial color={CONCRETE} roughness={0.9} />
      </mesh>

      {/* Dark track ribbon on top of the viaduct */}
      <mesh geometry={trackGeo}>
        <meshStandardMaterial color={TRACK_COLOR} roughness={0.95} />
      </mesh>

      {/* Car bodies (instanced, 1 draw call) */}
      <instancedMesh
        ref={bodyInstRef}
        args={[undefined, undefined, CAR_COUNT]}
        geometry={carBodyGeo}
        castShadow
        frustumCulled={false}
      >
        <meshStandardMaterial
          color={CAR_BLUE}
          roughness={0.45}
          metalness={0.3}
        />
      </instancedMesh>

      {/* Window glow strips (instanced, 1 draw call) */}
      <instancedMesh
        ref={windowInstRef}
        args={[undefined, undefined, CAR_COUNT]}
        geometry={windowGeo}
        frustumCulled={false}
      >
        <meshBasicMaterial
          ref={windowMatRef}
          color={CITY_PALETTE.windowGlow}
          transparent
          opacity={0.12}
          toneMapped={false}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </instancedMesh>
    </group>
  );
}

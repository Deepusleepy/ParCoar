import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { useDayNightState } from "./DayNight";
import { TRACK_CENTER, TRACK_SIZE, TRACK_PALETTE } from "./constants";

/**
 * RaceTrack — F1-style circuit on the town outskirts.
 *
 * A closed loop with two straights and two semicircle ends. Kerbs on the
 * inside of corners (red/white checker CanvasTexture), continuous barrier
 * ribbons along the straights, a painted start/finish line, tire walls at
 * the corners, a start/finish gantry, a tiered grandstand with a roof and
 * floodlights, pit lane with trucks and tire stacks, a timing tower,
 * dark tire-mark decals at the apexes, and floodlights that turn on at night.
 *
 * All static geometry is merged into a handful of meshes.
 */

const [CX, CZ] = TRACK_CENTER;
const [TW, TD] = TRACK_SIZE;
const STRAIGHT = TW; // 200
const RADIUS = TD / 2; // 40
const TRACK_WIDTH = 14;
const DECK_Y = 0.05;
const KERB_Y = DECK_Y + 0.05; // kerbs sit just above the track surface
const START_FINISH_Y = DECK_Y + 0.06;
const TIRE_MARK_Y = DECK_Y + 0.02;

/** Build a flat ribbon between two points at a given Y. */
function ribbon(x1: number, z1: number, x2: number, z2: number, width: number, y: number): THREE.BufferGeometry {
  const dx = x2 - x1;
  const dz = z2 - z1;
  const len = Math.hypot(dx, dz);
  const geo = new THREE.PlaneGeometry(width, len, 1, 1);
  geo.rotateX(-Math.PI / 2);
  geo.rotateY(Math.atan2(dx, dz));
  geo.translate((x1 + x2) / 2, y, (z1 + z2) / 2);
  return geo;
}

/** Build a curved ribbon (arc) at a given Y. Normal faces +Y (visible from above). */
function arcRibbon(
  cx: number, cz: number, radius: number, startAngle: number, endAngle: number, width: number, y: number,
): THREE.BufferGeometry {
  const segments = 48;
  const inner = radius - width / 2;
  const outer = radius + width / 2;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = startAngle + (endAngle - startAngle) * (i / segments);
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    positions.push(cx + inner * cos, y, cz + inner * sin);
    positions.push(cx + outer * cos, y, cz + outer * sin);
    uvs.push(0, i / segments, 1, i / segments);
    if (i < segments) {
      const a = i * 2;
      // CCW winding for +Y normal: inner_i, inner_{i+1}, outer_i
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** Build a kerb segment. UVs map 0..1 across width and along the segment so a
 *  repeating checker texture tiles correctly. Winding is rendered DoubleSide
 *  so visibility does not depend on face orientation. */
function kerbSegment(
  cx: number, cz: number, radius: number, startAngle: number, endAngle: number, side: number, y: number,
): THREE.BufferGeometry[] {
  const segments = 24;
  const kerbWidth = 1.0;
  const inner = radius + side * (TRACK_WIDTH / 2);
  const outer = inner + side * kerbWidth;
  const geos: THREE.BufferGeometry[] = [];
  for (let i = 0; i < segments; i++) {
    const t1 = startAngle + (endAngle - startAngle) * (i / segments);
    const t2 = startAngle + (endAngle - startAngle) * ((i + 1) / segments);
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const c1 = Math.cos(t1), s1 = Math.sin(t1);
    const c2 = Math.cos(t2), s2 = Math.sin(t2);
    positions.push(cx + inner * c1, y, cz + inner * s1);
    positions.push(cx + outer * c1, y, cz + outer * s1);
    positions.push(cx + inner * c2, y, cz + inner * s2);
    positions.push(cx + outer * c2, y, cz + outer * s2);
    uvs.push(0, 0, 1, 0, 0, 1, 1, 1);
    // CCW winding for +Y normal (inner/outer are swapped in kerbs vs arcRibbon,
    // so the winding must be reversed to get +Y normals).
    indices.push(0, 1, 2, 1, 3, 2);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    geos.push(geo);
  }
  return geos;
}

function mergeAll(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const valid = geos.filter((g) => g.attributes.position && g.attributes.position.count > 0);
  if (valid.length === 0) return new THREE.BufferGeometry();
  return mergeGeometries(valid, false) ?? new THREE.BufferGeometry();
}

/** A small repeating checker CanvasTexture (red/white or black/white). */
function makeCheckerTexture(colorA: string, colorB: string, cells = 2): THREE.CanvasTexture {
  const cell = 32;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = cell * cells;
  const ctx = canvas.getContext("2d")!;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? colorA : colorB;
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/** White barrier with a red horizontal band — tiles along its length. */
function makeBarrierStripeTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#e8e8e8";
  ctx.fillRect(0, 0, 32, 32);
  ctx.fillStyle = "#cc3333";
  ctx.fillRect(0, 11, 32, 10);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

export function RaceTrack() {
  const dayNightRef = useDayNightState();
  const floodlightMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const scoreboardMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const gantrySignMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const trackMatRef = useRef<THREE.MeshStandardMaterial>(null);

  // Build all static geometry + textures once.
  const {
    trackGeo, kerbGeo, tireWallGeo, gantryGeo,
    grandstandGeo, grandstandDotsGeo, pitGeo, floodlightPoleGeo, floodlightHeadGeo,
    barrierGeo, startFinishGeo, tireMarksGeo,
    kerbTex, barrierTex, startFinishTex,
  } = useMemo(() => {
    const halfS = STRAIGHT / 2;
    // Track surface: two straights + two semicircles
    const straights: THREE.BufferGeometry[] = [
      ribbon(-halfS, -RADIUS, halfS, -RADIUS, TRACK_WIDTH, DECK_Y), // south straight (main/pit straight)
      ribbon(halfS, RADIUS, -halfS, RADIUS, TRACK_WIDTH, DECK_Y), // north straight
    ];
    const arcs: THREE.BufferGeometry[] = [
      arcRibbon(halfS, 0, RADIUS, -Math.PI / 2, Math.PI / 2, TRACK_WIDTH, DECK_Y), // east arc
      arcRibbon(-halfS, 0, RADIUS, Math.PI / 2, (3 * Math.PI) / 2, TRACK_WIDTH, DECK_Y), // west arc
    ];
    const trackGeo = mergeAll([...straights, ...arcs]);

    // Kerbs on inside of corners — single merged geometry with a checker map.
    const kerbGeos: THREE.BufferGeometry[] = [
      ...kerbSegment(halfS, 0, RADIUS, -Math.PI / 2, Math.PI / 2, -1, KERB_Y),
      ...kerbSegment(-halfS, 0, RADIUS, Math.PI / 2, (3 * Math.PI) / 2, -1, KERB_Y),
    ];
    const kerbGeo = mergeAll(kerbGeos);

    // Tire walls: instanced cylinders at corners
    const tireGeos: THREE.BufferGeometry[] = [];
    const tireRadius = 0.35;
    const tireHeight = 0.3;
    const corners = [
      { cx: halfS, cz: -RADIUS, angle: -Math.PI / 2 },
      { cx: halfS, cz: RADIUS, angle: 0 },
      { cx: -halfS, cz: RADIUS, angle: Math.PI / 2 },
      { cx: -halfS, cz: -RADIUS, angle: Math.PI },
    ];
    for (const c of corners) {
      for (let row = 0; row < 3; row++) {
        for (let i = 0; i < 12; i++) {
          const t = c.angle + (i / 12) * (Math.PI / 2);
          const r = RADIUS + TRACK_WIDTH / 2 + 1.5;
          const x = c.cx + Math.cos(t) * r;
          const z = c.cz + Math.sin(t) * r;
          const geo = new THREE.CylinderGeometry(tireRadius, tireRadius, tireHeight, 8);
          geo.rotateX(Math.PI / 2);
          geo.translate(x, DECK_Y + tireHeight / 2 + row * tireHeight * 0.9, z);
          tireGeos.push(geo);
        }
      }
    }
    const tireWallGeo = mergeAll(tireGeos);

    // Continuous barrier ribbons along both sides of both straights.
    // Low walls (0.8 high) just outside the track edge, merged into one mesh.
    const barrierGeos: THREE.BufferGeometry[] = [];
    const barrierH = 0.8;
    const edgeOffsets = [
      -RADIUS - TRACK_WIDTH / 2, // south outer
      -RADIUS + TRACK_WIDTH / 2, // south inner (infield)
      RADIUS - TRACK_WIDTH / 2, // north inner (infield)
      RADIUS + TRACK_WIDTH / 2, // north outer
    ];
    for (const zEdge of edgeOffsets) {
      const wall = new THREE.BoxGeometry(STRAIGHT, barrierH, 0.3);
      wall.translate(0, barrierH / 2, zEdge);
      barrierGeos.push(wall);
    }
    const barrierGeo = mergeAll(barrierGeos);

    // Start/finish line: a thin checker strip across the main straight,
    // sitting under the gantry at X=0, Z=-RADIUS.
    const startFinishGeo = ribbon(-1.5, -RADIUS, 1.5, -RADIUS, TRACK_WIDTH, START_FINISH_Y);

    // Tire marks: dark semi-transparent decals near the apex of each end.
    // Placed on the inner racing line of the two semicircle ends.
    const apexRadius = RADIUS - TRACK_WIDTH / 2 + 1.5;
    const tireMarksGeo = mergeAll([
      arcRibbon(halfS, 0, apexRadius, -Math.PI / 6, Math.PI / 6, 3, TIRE_MARK_Y),
      arcRibbon(-halfS, 0, apexRadius, Math.PI - Math.PI / 6, Math.PI + Math.PI / 6, 3, TIRE_MARK_Y),
    ]);

    // Start/finish gantry: two posts + overhead beam, spanning the main
    // straight at Z=-RADIUS (aligned with the start/finish line + grandstand).
    const gantryParts: THREE.BufferGeometry[] = [];
    const postGeo = new THREE.BoxGeometry(0.8, 8, 0.8);
    const post1 = postGeo.clone();
    post1.translate(-TRACK_WIDTH / 2 - 1, 4, -RADIUS);
    const post2 = postGeo.clone();
    post2.translate(TRACK_WIDTH / 2 + 1, 4, -RADIUS);
    const beam = new THREE.BoxGeometry(TRACK_WIDTH + 4, 1.5, 0.8);
    beam.translate(0, 8, -RADIUS);
    gantryParts.push(post1, post2, beam);
    const gantryGeo = mergeAll(gantryParts);

    // Grandstand along the main straight — tiered seating rising from the
    // track-side front to the back, with a roof on posts.
    const grandstandParts: THREE.BufferGeometry[] = [];
    const rows = 6;
    const rowDepth = 2.2;
    const rowRise = 1.1;
    const gsWidth = 60;
    const frontZ = -RADIUS - 9; // closest row to the track
    for (let i = 0; i < rows; i++) {
      const row = new THREE.BoxGeometry(gsWidth, 1.2, rowDepth);
      row.translate(0, 0.6 + i * rowRise, frontZ - i * rowDepth);
      grandstandParts.push(row);
    }
    // Roof spanning the stepped rows, supported by posts.
    const roofY = 0.6 + rows * rowRise + 1.2;
    const roofBackZ = frontZ - (rows - 1) * rowDepth;
    const roofCenterZ = (frontZ + roofBackZ) / 2;
    const roof = new THREE.BoxGeometry(gsWidth + 4, 0.4, (rows - 1) * rowDepth + 4);
    roof.translate(0, roofY, roofCenterZ);
    grandstandParts.push(roof);
    // Support posts at the front and back corners.
    const postXs = [-gsWidth / 2 - 1, gsWidth / 2 + 1];
    for (const px of postXs) {
      for (const pz of [frontZ, roofBackZ]) {
        const p = new THREE.BoxGeometry(0.5, roofY, 0.5);
        p.translate(px, roofY / 2, pz);
        grandstandParts.push(p);
      }
    }
    const grandstandGeo = mergeAll(grandstandParts);

    // Grandstand floodlights — small emissive boxes mounted under the roof
    // front edge, illuminating the seating.
    const grandstandDotParts: THREE.BufferGeometry[] = [];
    const lightCount = 12;
    for (let i = 0; i < lightCount; i++) {
      const dot = new THREE.BoxGeometry(0.5, 0.3, 0.4);
      const x = -gsWidth / 2 + 4 + (i / (lightCount - 1)) * (gsWidth - 8);
      dot.translate(x, roofY - 0.4, frontZ);
      grandstandDotParts.push(dot);
    }
    const grandstandDotsGeo = mergeAll(grandstandDotParts);

    // Pit lane: trucks, tire stacks, timing tower
    const pitParts: THREE.BufferGeometry[] = [];
    // Transport trucks (3)
    for (let i = 0; i < 3; i++) {
      const truck = new THREE.BoxGeometry(8, 4, 3);
      truck.translate(-30 + i * 20, 2, RADIUS + 15);
      pitParts.push(truck);
    }
    // Tire stacks (instanced-ish: merged cylinders)
    for (let i = 0; i < 6; i++) {
      for (let row = 0; row < 4; row++) {
        const tire = new THREE.CylinderGeometry(0.5, 0.5, 0.4, 8);
        tire.rotateX(Math.PI / 2);
        tire.translate(20 + i * 2, 0.2 + row * 0.42, RADIUS + 12);
        pitParts.push(tire);
      }
    }
    // Timing tower
    const tower = new THREE.BoxGeometry(4, 12, 4);
    tower.translate(40, 6, RADIUS + 15);
    pitParts.push(tower);
    const towerTop = new THREE.BoxGeometry(5, 2, 5);
    towerTop.translate(40, 13, RADIUS + 15);
    pitParts.push(towerTop);
    const pitGeo = mergeAll(pitParts);

    // Floodlight poles (4 around track)
    const poleGeos: THREE.BufferGeometry[] = [];
    const headGeos: THREE.BufferGeometry[] = [];
    const floodPositions = [
      { x: 0, z: -RADIUS - 8 },
      { x: 0, z: RADIUS + 8 },
      { x: halfS + 8, z: 0 },
      { x: -halfS - 8, z: 0 },
    ];
    for (const p of floodPositions) {
      const pole = new THREE.CylinderGeometry(0.3, 0.3, 12, 8);
      pole.translate(p.x, 6, p.z);
      poleGeos.push(pole);
      const head = new THREE.BoxGeometry(3, 0.5, 2);
      head.translate(p.x, 12.5, p.z);
      headGeos.push(head);
    }
    const floodlightPoleGeo = mergeAll(poleGeos);
    const floodlightHeadGeo = mergeAll(headGeos);

    // Textures
    const kerbTex = makeCheckerTexture("#cc3333", "#e8e8e8", 2);
    kerbTex.repeat.set(1, 4); // tile the checker along each kerb segment
    const barrierTex = makeBarrierStripeTexture();
    barrierTex.repeat.set(50, 1); // ~50 stripe repeats along the 200-unit straights
    const startFinishTex = makeCheckerTexture("#101010", "#e8e8e8", 2);
    startFinishTex.repeat.set(1, 7); // checker cells across the track width

    return {
      trackGeo, kerbGeo, tireWallGeo, gantryGeo,
      grandstandGeo, grandstandDotsGeo, pitGeo, floodlightPoleGeo, floodlightHeadGeo,
      barrierGeo, startFinishGeo, tireMarksGeo,
      kerbTex, barrierTex, startFinishTex,
    };
  }, []);

  // Animate emissive materials based on day/night
  useFrame(() => {
    const s = dayNightRef.current;
    const night = s.sunIntensity < 0.15;
    const lightLevel = night ? 1.0 : Math.max(0, 1 - s.sunIntensity / 1.5);

    if (floodlightMatRef.current) {
      floodlightMatRef.current.emissiveIntensity = lightLevel * 3.0;
    }
    if (scoreboardMatRef.current) {
      scoreboardMatRef.current.emissiveIntensity = 1.5;
    }
    if (gantrySignMatRef.current) {
      gantrySignMatRef.current.emissiveIntensity = 1.0 + lightLevel * 1.5;
    }
    if (trackMatRef.current) {
      // Track surface goes slightly glossy at night (lower roughness)
      trackMatRef.current.roughness = night ? 0.4 : 0.7;
    }
  });

  return (
    <group position={[CX, 0, CZ]}>
      {/* Track surface */}
      <mesh geometry={trackGeo} castShadow receiveShadow>
        <meshStandardMaterial ref={trackMatRef} color={TRACK_PALETTE.surface} roughness={0.7} metalness={0.1} />
      </mesh>

      {/* Tire-mark decals at the apexes (dark, semi-transparent, flat) */}
      <mesh geometry={tireMarksGeo} renderOrder={1}>
        <meshStandardMaterial
          color="#161616"
          transparent
          opacity={0.55}
          depthWrite={false}
          roughness={0.9}
        />
      </mesh>

      {/* Start/finish checker strip across the main straight */}
      <mesh geometry={startFinishGeo} renderOrder={2}>
        <meshStandardMaterial map={startFinishTex} roughness={0.6} metalness={0} />
      </mesh>

      {/* Kerbs — red/white checker CanvasTexture, DoubleSide so they always read */}
      <mesh geometry={kerbGeo}>
        <meshStandardMaterial map={kerbTex} side={THREE.DoubleSide} roughness={0.6} />
      </mesh>

      {/* Continuous barrier ribbons along the straights */}
      <mesh geometry={barrierGeo} castShadow receiveShadow>
        <meshStandardMaterial map={barrierTex} roughness={0.6} metalness={0.1} />
      </mesh>

      {/* Tire walls */}
      <mesh geometry={tireWallGeo}>
        <meshStandardMaterial color="#0a0a0a" roughness={0.9} />
      </mesh>

      {/* Gantry structure (spans the main straight at the start/finish line) */}
      <mesh geometry={gantryGeo} castShadow>
        <meshStandardMaterial color="#3a3a3e" roughness={0.6} metalness={0.5} />
      </mesh>
      {/* Gantry sign (emissive panel on beam) */}
      <mesh position={[0, 8, -RADIUS]}>
        <boxGeometry args={[TRACK_WIDTH, 1.2, 0.1]} />
        <meshStandardMaterial
          ref={gantrySignMatRef}
          color="#ff3b3b"
          emissive="#ff3b3b"
          emissiveIntensity={1.5}
          toneMapped={false}
        />
      </mesh>

      {/* Grandstand tiered seating + roof */}
      <mesh geometry={grandstandGeo} castShadow receiveShadow>
        <meshStandardMaterial color={TRACK_PALETTE.grandstand} roughness={0.8} />
      </mesh>
      {/* Grandstand roof floodlights (emissive, separate geometry) */}
      <mesh geometry={grandstandDotsGeo}>
        <meshStandardMaterial
          color="#fff5e0"
          emissive="#fff5e0"
          emissiveIntensity={0.8}
          toneMapped={false}
        />
      </mesh>

      {/* Pit lane */}
      <mesh geometry={pitGeo} castShadow receiveShadow>
        <meshStandardMaterial color="#2a2a30" roughness={0.7} />
      </mesh>
      {/* Timing tower scoreboard */}
      <mesh position={[40, 13, RADIUS + 15]}>
        <boxGeometry args={[4.2, 1.5, 0.1]} />
        <meshStandardMaterial
          ref={scoreboardMatRef}
          color="#00e5ff"
          emissive="#00e5ff"
          emissiveIntensity={1.5}
          toneMapped={false}
        />
      </mesh>

      {/* Floodlight poles */}
      <mesh geometry={floodlightPoleGeo} castShadow>
        <meshStandardMaterial color="#4a4a4e" roughness={0.6} metalness={0.4} />
      </mesh>
      {/* Floodlight heads (emissive) */}
      <mesh geometry={floodlightHeadGeo}>
        <meshStandardMaterial
          ref={floodlightMatRef}
          color="#fff5e0"
          emissive="#fff5e0"
          emissiveIntensity={0}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}

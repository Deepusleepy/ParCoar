import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { useDayNightState } from "./DayNight";
import { TRACK_CENTER, TRACK_SIZE, TRACK_PALETTE } from "./constants";

/**
 * RaceTrack — F1-style circuit on the town outskirts.
 *
 * A closed loop with two straights and two semicircle ends. Striped red/
 * white kerbs line the inside of both corner apexes, continuous barrier
 * ribbons run along the straights, and the dark slightly-glossy surface
 * picks up the additive floodlight pools at night. Tire walls (mostly
 * black, a few painted) guard the corners, a start/finish gantry carries
 * a checker strip and an emissive PARCOAR CIRCUIT sign, and a tiered
 * grandstand reads as seat blocks via three alternating row colors.
 *
 * All static geometry is merged into a handful of meshes; no real lights.
 */

const [CX, CZ] = TRACK_CENTER;
const [TW, TD] = TRACK_SIZE;
const STRAIGHT = TW; // 200
const RADIUS = TD / 2; // 40
const TRACK_WIDTH = 14;
const DECK_Y = 0.05;
const START_FINISH_Y = DECK_Y + 0.06;
const TIRE_MARK_Y = DECK_Y + 0.02;

/** Slightly darker than road asphalt; low roughness so light pools read. */
const SURFACE_COLOR = "#202024";

/** Grandstand seat-block colors, cycled per row. */
const SEAT_COLORS = [
  new THREE.Color("#96323a"), // crimson
  new THREE.Color("#d8d2c4"), // cream
  new THREE.Color("#3c4c6e"), // navy
];

/** Floodlights: pole position + the point on the track it aims at. */
function floodLayout(): Array<{ px: number; pz: number; lx: number; lz: number }> {
  const out: Array<{ px: number; pz: number; lx: number; lz: number }> = [];
  for (const x of [-70, 0, 70]) {
    out.push({ px: x, pz: -RADIUS - 7, lx: x, lz: -RADIUS });
    out.push({ px: x, pz: RADIUS + 7, lx: x, lz: RADIUS });
  }
  out.push({ px: STRAIGHT / 2 + RADIUS + 8, pz: 0, lx: STRAIGHT / 2 + RADIUS, lz: 0 });
  out.push({ px: -(STRAIGHT / 2 + RADIUS + 8), pz: 0, lx: -(STRAIGHT / 2 + RADIUS), lz: 0 });
  return out;
}

/* ------------------------------------------------------------------ *
 *  Seeded rng (deterministic scatter for tire walls)
 * ------------------------------------------------------------------ */

function hashSeed(a: number, b: number): number {
  let h = (Math.imul(a, 73856093) ^ Math.imul(b, 19349663)) >>> 0;
  if (h === 0) h = 0x9e3779b9;
  return h;
}

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ *
 *  Geometry helpers
 * ------------------------------------------------------------------ */

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

/**
 * Kerb run along an arc: thin raised boxes placed tangentially just inside
 * the track edge. UVs stay default so the striped texture shows one red +
 * one white band per segment (u runs along the kerb).
 */
function kerbRun(
  cx: number, cz: number, radius: number, startAngle: number, endAngle: number,
): THREE.BufferGeometry[] {
  const segments = 26;
  const kw = 1.05;
  const kh = 0.1;
  const midRadius = radius - TRACK_WIDTH / 2 + kw / 2;
  const geos: THREE.BufferGeometry[] = [];
  for (let i = 0; i < segments; i++) {
    const t1 = startAngle + (endAngle - startAngle) * (i / segments);
    const t2 = startAngle + (endAngle - startAngle) * ((i + 1) / segments);
    const tm = (t1 + t2) / 2;
    const len = midRadius * (t2 - t1) + 0.06;
    const g = new THREE.BoxGeometry(len, kh, kw);
    // Local X must follow the tangent (-sin t, cos t): rotateY(-(t + PI/2)).
    g.rotateY(-(tm + Math.PI / 2));
    g.translate(
      cx + midRadius * Math.cos(tm),
      DECK_Y + 0.02 + kh / 2,
      cz + midRadius * Math.sin(tm),
    );
    geos.push(g);
  }
  return geos;
}

/** Bake a uniform color into a geometry's vertices (for multi-color merges). */
function vcolor(geo: THREE.BufferGeometry, color: THREE.Color): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const pos = g.attributes.position;
  const arr = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    arr[i * 3] = color.r;
    arr[i * 3 + 1] = color.g;
    arr[i * 3 + 2] = color.b;
  }
  g.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  return g;
}

function mergeAll(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const valid = geos.filter((g) => g.attributes.position && g.attributes.position.count > 0);
  if (valid.length === 0) return new THREE.BufferGeometry();
  return mergeGeometries(valid, false) ?? new THREE.BufferGeometry();
}

/* ------------------------------------------------------------------ *
 *  Canvas textures
 * ------------------------------------------------------------------ */

/** Red/white stripes perpendicular to U (along the kerb direction). */
function makeKerbStripeTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 16;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#d03030";
  ctx.fillRect(0, 0, 32, 16);
  ctx.fillStyle = "#ececec";
  ctx.fillRect(32, 0, 32, 16);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
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

/** Radial falloff blob for floodlight ground pools (additive blending). */
function makeFloodPoolTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 4, size / 2, size / 2, size / 2);
  grad.addColorStop(0, "rgba(255, 240, 214, 0.95)");
  grad.addColorStop(0.35, "rgba(255, 232, 190, 0.45)");
  grad.addColorStop(1, "rgba(255, 224, 170, 0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Start/finish gantry sign: PARCOAR CIRCUIT + katakana, checker ends. */
function makeGantrySignTexture(): THREE.CanvasTexture {
  const w = 1024;
  const h = 200;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#0c0c10";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#d03030";
  ctx.fillRect(0, 0, w, 8);
  ctx.fillRect(0, h - 8, w, 8);
  // Checker blocks at each end.
  const cell = 23;
  for (let cx = 0; cx < 3; cx++) {
    for (let cy = 0; cy < Math.floor(h / cell); cy++) {
      ctx.fillStyle = (cx + cy) % 2 === 0 ? "#e8e8e8" : "#111111";
      ctx.fillRect(cx * cell, cy * cell, cell, cell);
      ctx.fillStyle = (cx + cy) % 2 === 0 ? "#111111" : "#e8e8e8";
      ctx.fillRect(w - (cx + 1) * cell, cy * cell, cell, cell);
    }
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#f2f2f2";
  ctx.font = "900 88px 'Helvetica Neue', Arial, sans-serif";
  ctx.fillText("PARCOAR CIRCUIT", w / 2 + 34, 108);
  ctx.fillStyle = "#8f96a2";
  ctx.font = "700 40px 'Hiragino Sans', 'Yu Gothic', sans-serif";
  ctx.fillText("パルコーア・サーキット", w / 2 + 34, 168);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

export function RaceTrack() {
  const dayNightRef = useDayNightState();
  const floodMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const scoreboardMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const gantrySignMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const standLightMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const poolMatRef = useRef<THREE.MeshBasicMaterial>(null);

  // Build all static geometry + textures once.
  const {
    trackGeo, kerbGeo, tireWallGeo, gantryGeo, checkerStripGeo, signGeo,
    grandstandGeo, seatGeo, grandstandDotsGeo, pitGeo,
    floodlightPoleGeo, floodlightHeadGeo, floodPoolGeo,
    barrierGeo, startFinishGeo, tireMarksGeo,
    kerbTex, barrierTex, startFinishTex, checkerTex, signTex, floodPoolTex,
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

    // Striped kerbs on the inside of both corner apexes.
    const kerbGeo = mergeAll([
      ...kerbRun(halfS, 0, RADIUS, -Math.PI / 2, Math.PI / 2),
      ...kerbRun(-halfS, 0, RADIUS, Math.PI / 2, (3 * Math.PI) / 2),
    ]);

    // Tire walls: stacked cylinders hugging three corners. Mostly black
    // rubber with a few red/white painted ones scattered in.
    const trng = mulberry32(hashSeed(1337, 42));
    const tires: THREE.BufferGeometry[] = [];
    const tireRadius = 0.35;
    const tireHeight = 0.3;
    const corners = [
      { cx: halfS, cz: -RADIUS, angle: -Math.PI / 2 },
      { cx: halfS, cz: RADIUS, angle: 0 },
      { cx: -halfS, cz: -RADIUS, angle: Math.PI },
    ];
    for (const c of corners) {
      for (let row = 0; row < 2; row++) {
        for (let i = 0; i < 16; i++) {
          const t = c.angle + (i / 15) * (Math.PI / 2) + (trng() - 0.5) * 0.015;
          const r = RADIUS + TRACK_WIDTH / 2 + 1.0 + row * 0.75 + (trng() - 0.5) * 0.12;
          const x = c.cx + Math.cos(t) * r;
          const z = c.cz + Math.sin(t) * r;
          const geo = new THREE.CylinderGeometry(tireRadius, tireRadius, tireHeight, 8);
          geo.rotateX(Math.PI / 2);
          geo.rotateY(trng() * Math.PI);
          geo.translate(x, DECK_Y + tireHeight / 2 + row * tireHeight * 0.9, z);
          const roll = trng();
          const col =
            roll < 0.82 ? new THREE.Color("#141414")
            : roll < 0.91 ? new THREE.Color("#c0392b")
            : new THREE.Color("#e0e0e0");
          tires.push(vcolor(geo, col));
        }
      }
    }
    const tireWallGeo = mergeAll(tires);

    // Continuous barrier ribbons along both sides of both straights.
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
    const apexRadius = RADIUS - TRACK_WIDTH / 2 + 1.5;
    const tireMarksGeo = mergeAll([
      arcRibbon(halfS, 0, apexRadius, -Math.PI / 6, Math.PI / 6, 3, TIRE_MARK_Y),
      arcRibbon(-halfS, 0, apexRadius, Math.PI - Math.PI / 6, Math.PI + Math.PI / 6, 3, TIRE_MARK_Y),
    ]);

    // Start/finish gantry: posts + overhead beam + a checker strip under it.
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

    const checkerW = TRACK_WIDTH + 3.6;
    const checkerStripGeo = new THREE.BoxGeometry(checkerW, 0.35, 0.5);
    checkerStripGeo.translate(0, 7.1, -RADIUS);

    // Sign panels hang off both faces of the beam so the name reads from
    // either side of the circuit.
    const signFront = new THREE.PlaneGeometry(9.5, 1.85);
    signFront.rotateY(Math.PI); // face -Z (grandstand side)
    signFront.translate(0, 8, -RADIUS - 0.46);
    const signBack = new THREE.PlaneGeometry(9.5, 1.85);
    signBack.translate(0, 8, -RADIUS + 0.46);
    const signGeo = mergeAll([signFront, signBack]);

    // Grandstand along the main straight: stepped rows cycling through
    // three seat colors under one dark roof on posts.
    const rows = 6;
    const rowDepth = 2.2;
    const rowRise = 1.1;
    const gsWidth = 60;
    const frontZ = -RADIUS - 9;
    const seatParts: THREE.BufferGeometry[] = [];
    const structureParts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < rows; i++) {
      const row = new THREE.BoxGeometry(gsWidth, 1.2, rowDepth);
      row.translate(0, 0.6 + i * rowRise, frontZ - i * rowDepth);
      seatParts.push(vcolor(row, SEAT_COLORS[i % SEAT_COLORS.length]));
    }
    // Rear wall closing the tiers.
    const backWall = new THREE.BoxGeometry(gsWidth, 7.2, 0.5);
    backWall.translate(0, 3.6, frontZ - (rows - 1) * rowDepth - rowDepth / 2 - 0.25);
    structureParts.push(backWall);
    // Roof spanning the stepped rows, supported by posts.
    const roofY = 0.6 + rows * rowRise + 1.2;
    const roofBackZ = frontZ - (rows - 1) * rowDepth;
    const roofCenterZ = (frontZ + roofBackZ) / 2;
    const roof = new THREE.BoxGeometry(gsWidth + 4, 0.4, (rows - 1) * rowDepth + 4);
    roof.translate(0, roofY, roofCenterZ);
    structureParts.push(roof);
    const postXs = [-gsWidth / 2 - 1, gsWidth / 2 + 1];
    for (const px of postXs) {
      for (const pz of [frontZ, roofBackZ]) {
        const p = new THREE.BoxGeometry(0.5, roofY, 0.5);
        p.translate(px, roofY / 2, pz);
        structureParts.push(p);
      }
    }
    const grandstandGeo = mergeAll(structureParts);
    const seatGeo = mergeAll(seatParts);

    // Grandstand floodlights — small emissive boxes mounted under the roof.
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
    for (let i = 0; i < 3; i++) {
      const truck = new THREE.BoxGeometry(8, 4, 3);
      truck.translate(-30 + i * 20, 2, RADIUS + 15);
      pitParts.push(truck);
    }
    for (let i = 0; i < 6; i++) {
      for (let row = 0; row < 4; row++) {
        const tire = new THREE.CylinderGeometry(0.5, 0.5, 0.4, 8);
        tire.rotateX(Math.PI / 2);
        tire.translate(20 + i * 2, 0.2 + row * 0.42, RADIUS + 12);
        pitParts.push(tire);
      }
    }
    const tower = new THREE.BoxGeometry(4, 12, 4);
    tower.translate(40, 6, RADIUS + 15);
    pitParts.push(tower);
    const towerTop = new THREE.BoxGeometry(5, 2, 5);
    towerTop.translate(40, 13, RADIUS + 15);
    pitParts.push(towerTop);
    const pitGeo = mergeAll(pitParts);

    // Floodlight poles (8 around the circuit) with heads aimed at their
    // ground point, plus additive pool quads on the track beneath each.
    const poleGeos: THREE.BufferGeometry[] = [];
    const headGeos: THREE.BufferGeometry[] = [];
    const poolGeos: THREE.BufferGeometry[] = [];
    const _aim = new THREE.Matrix4();
    for (const f of floodLayout()) {
      const pole = new THREE.CylinderGeometry(0.22, 0.3, 12, 8);
      pole.translate(f.px, 6, f.pz);
      poleGeos.push(pole);
      // Crossbar the head sits on.
      const arm = new THREE.BoxGeometry(0.35, 0.35, 2.2);
      const dx0 = f.lx - f.px;
      const dz0 = f.lz - f.pz;
      const yaw0 = Math.atan2(dx0, dz0);
      arm.rotateY(yaw0);
      arm.translate(f.px + dx0 * 0.18, 11.85, f.pz + dz0 * 0.18);
      poleGeos.push(arm);
      // Head panel tilted down toward its pool point.
      const head = new THREE.BoxGeometry(2.6, 0.35, 1.5);
      const pitch = 0.62;
      const yaw = Math.atan2(f.lx - f.px, f.lz - f.pz);
      _aim.makeRotationFromEuler(new THREE.Euler(pitch, yaw, 0, "YXZ"));
      _aim.setPosition(f.px + (f.lx - f.px) * 0.28, 11.55, f.pz + (f.lz - f.pz) * 0.28);
      head.applyMatrix4(_aim);
      headGeos.push(head);
      // Additive light pool on the track surface.
      const pool = new THREE.PlaneGeometry(13, 13);
      pool.rotateX(-Math.PI / 2);
      pool.translate(f.lx, DECK_Y + 0.03, f.lz);
      poolGeos.push(pool);
    }
    const floodlightPoleGeo = mergeAll(poleGeos);
    const floodlightHeadGeo = mergeAll(headGeos);
    const floodPoolGeo = mergeAll(poolGeos);

    // Textures
    const kerbTex = makeKerbStripeTexture();
    const barrierTex = makeBarrierStripeTexture();
    barrierTex.repeat.set(50, 1);
    const startFinishTex = makeCheckerTexture("#101010", "#e8e8e8", 2);
    startFinishTex.repeat.set(1, 7);
    const checkerTex = makeCheckerTexture("#101010", "#e8e8e8", 2);
    checkerTex.repeat.set(Math.round(checkerW / 1.6), 1);
    const signTex = makeGantrySignTexture();
    const floodPoolTex = makeFloodPoolTexture();

    return {
      trackGeo, kerbGeo, tireWallGeo, gantryGeo, checkerStripGeo, signGeo,
      grandstandGeo, seatGeo, grandstandDotsGeo, pitGeo,
      floodlightPoleGeo, floodlightHeadGeo, floodPoolGeo,
      barrierGeo, startFinishGeo, tireMarksGeo,
      kerbTex, barrierTex, startFinishTex, checkerTex, signTex, floodPoolTex,
    };
  }, []);

  // Animate emissive materials based on day/night.
  useFrame(() => {
    const s = dayNightRef.current;
    const night = s.streetlightIntensity;
    if (floodMatRef.current) {
      floodMatRef.current.emissiveIntensity = night * 4.5;
    }
    if (poolMatRef.current) {
      poolMatRef.current.opacity = night * 0.45;
    }
    if (gantrySignMatRef.current) {
      gantrySignMatRef.current.emissiveIntensity = 0.12 + night * 2.2;
    }
    if (scoreboardMatRef.current) {
      scoreboardMatRef.current.emissiveIntensity = 0.4 + s.neonIntensity * 1.8;
    }
    if (standLightMatRef.current) {
      standLightMatRef.current.emissiveIntensity = 0.15 + night * 1.6;
    }
  });

  return (
    <group position={[CX, 0, CZ]}>
      {/* Track surface — darker asphalt, slightly glossy */}
      <mesh geometry={trackGeo} receiveShadow>
        <meshStandardMaterial
          color={SURFACE_COLOR}
          roughness={0.5}
          metalness={0.06}
        />
      </mesh>

      {/* Tire-mark decals at the apexes */}
      <mesh geometry={tireMarksGeo} renderOrder={1}>
        <meshStandardMaterial
          color="#161616"
          transparent
          opacity={0.55}
          depthWrite={false}
          roughness={0.9}
        />
      </mesh>

      {/* Start/finish checker strip */}
      <mesh geometry={startFinishGeo} renderOrder={2}>
        <meshStandardMaterial map={startFinishTex} roughness={0.6} metalness={0} />
      </mesh>

      {/* Floodlight pools — additive radial gradients, night only */}
      <mesh geometry={floodPoolGeo} renderOrder={3}>
        <meshBasicMaterial
          ref={poolMatRef}
          map={floodPoolTex}
          color="#ffe9c4"
          transparent
          opacity={0}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>

      {/* Kerbs — striped red/white raised boxes */}
      <mesh geometry={kerbGeo}>
        <meshStandardMaterial map={kerbTex} roughness={0.65} />
      </mesh>

      {/* Barrier ribbons along the straights */}
      <mesh geometry={barrierGeo} castShadow receiveShadow>
        <meshStandardMaterial map={barrierTex} roughness={0.6} metalness={0.1} />
      </mesh>

      {/* Tire walls — mostly black with a few painted tires (vertex colors) */}
      <mesh geometry={tireWallGeo}>
        <meshStandardMaterial vertexColors roughness={0.9} />
      </mesh>

      {/* Gantry structure + checker strip */}
      <mesh geometry={gantryGeo} castShadow>
        <meshStandardMaterial color="#3a3a3e" roughness={0.6} metalness={0.5} />
      </mesh>
      <mesh geometry={checkerStripGeo}>
        <meshStandardMaterial map={checkerTex} roughness={0.6} />
      </mesh>
      {/* Gantry sign panel (PARCOAR CIRCUIT) */}
      <mesh geometry={signGeo}>
        <meshStandardMaterial
          ref={gantrySignMatRef}
          map={signTex}
          emissive="#ffffff"
          emissiveMap={signTex}
          emissiveIntensity={0.12}
          toneMapped
        />
      </mesh>

      {/* Grandstand: dark structure + tri-color seat rows */}
      <mesh geometry={grandstandGeo} castShadow receiveShadow>
        <meshStandardMaterial color={TRACK_PALETTE.grandstand} roughness={0.8} />
      </mesh>
      <mesh geometry={seatGeo} castShadow receiveShadow>
        <meshStandardMaterial vertexColors roughness={0.85} />
      </mesh>
      <mesh geometry={grandstandDotsGeo}>
        <meshStandardMaterial
          ref={standLightMatRef}
          color="#fff5e0"
          emissive="#fff5e0"
          emissiveIntensity={0.15}
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
          emissiveIntensity={0.4}
          toneMapped={false}
        />
      </mesh>

      {/* Floodlight poles */}
      <mesh geometry={floodlightPoleGeo} castShadow>
        <meshStandardMaterial color="#4a4a4e" roughness={0.6} metalness={0.4} />
      </mesh>
      {/* Floodlight heads (emissive panels aimed at the track) */}
      <mesh geometry={floodlightHeadGeo}>
        <meshStandardMaterial
          ref={floodMatRef}
          color="#fff5e0"
          emissive="#fff5e0"
          emissiveIntensity={0}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}

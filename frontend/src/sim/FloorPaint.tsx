import { useEffect, useMemo } from "react";
import * as THREE from "three";
import type { JSX } from "react";
import type { LotData } from "../types";
import {
  AISLE_SPACING,
  CENTER_LINE_COLOR,
  FLOOR_HEIGHT,
  LANE_COLOR,
  LANE_WIDTH,
  MARKING_WHITE,
  ROAD_WIDTH,
  SLOT_DEPTH,
  SLOT_OUTLINE_HEX,
  SLOT_WIDTH,
} from "./constants";

/* FloorPaint
 *
 * Bakes every flat, static floor marking on one garage floor (road surface,
 * edge/centre lines, parking-bay outlines, bay numbers, direction arrows)
 * into a single CanvasTexture on a single horizontal plane. Replaces the
 * per-bay / per-aisle / per-arrow meshes that dominated the scene's draw
 * count.
 *
 * Coordinate convention
 * ---------------------
 * `bounds` and every node's (x, y) are lot coordinates, and with SCALE = 1
 * they map directly to three.js world X and world Z (see `toWorld`). So
 * throughout this file: worldX === lot x, worldZ === lot y. The plane is
 * rotated [-PI/2, 0, 0] and CanvasTexture defaults to flipY = true, which
 * together map the canvas as: canvas +X -> world +X, canvas +Y (downward)
 * -> world -Z. The world-to-canvas helper below encodes exactly that.
 */

/** Parsed junction id "J{floor}_{aisle}_{n}" -> aisle index (same regex as
 *  ParkingLot's `aisleOf`). Returns null for non-junction / malformed ids. */
function aisleOf(id: string): number | null {
  const m = id.match(/^J\d+_(\d+)_\d+$/);
  return m ? Number(m[1]) : null;
}

export function FloorPaint({
  lot,
  floor,
  bounds,
}: {
  lot: LotData;
  floor: number;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}): JSX.Element | null {
  // Stable key so the memo rebuilds only when the actual footprint changes,
  // not when the parent hands us a fresh bounds object each render.
  const boundsKey = `${bounds.minX},${bounds.maxX},${bounds.minZ},${bounds.maxZ}`;

  const { texture, material, plane } = useMemo(() => {
    const w = bounds.maxX - bounds.minX;
    const h = bounds.maxZ - bounds.minZ;

    // Target ~40 px per world unit, clamped so neither side exceeds 4096.
    const px = Math.min(40, 4096 / w, 4096 / h);
    const canvasW = Math.max(1, Math.ceil(w * px));
    const canvasH = Math.max(1, Math.ceil(h * px));

    const canvas = document.createElement("canvas");
    canvas.width = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext("2d")!;

    // --- World (lot) -> canvas pixel mapping ---------------------------
    // canvas +X follows world +X; canvas +Y (down) follows world -Z because
    // the plane is rotated -90deg about X and the CanvasTexture is flipped
    // vertically (flipY = true). Every draw call below goes through `w2c`,
    // so this is the only place that knows the mapping.
    const maxZ = bounds.maxZ;
    const w2c = (wx: number, wz: number): [number, number] => [
      (wx - bounds.minX) * px,
      (maxZ - wz) * px,
    ];

    // 1. Transparent background: the concrete slab shows through where we
    //    paint nothing.
    ctx.clearRect(0, 0, canvasW, canvasH);

    // Group this floor's junctions by aisle index to recover each aisle's
    // centreline (y) and x extent.
    const aisleMap = new Map<number, { y: number; xs: number[] }>();
    for (const [id, node] of Object.entries(lot.nodes)) {
      if (node.floor !== floor || node.type !== "junction") continue;
      const idx = aisleOf(id);
      if (idx === null) continue;
      const entry = aisleMap.get(idx) ?? { y: node.y, xs: [] };
      entry.xs.push(node.x);
      aisleMap.set(idx, entry);
    }
    const aisles = [...aisleMap.entries()]
      .map(([idx, { y, xs }]) => ({
        index: idx,
        y,
        x0: Math.min(...xs),
        x1: Math.max(...xs),
      }))
      .sort((a, b) => a.index - b.index);

    const half = ROAD_WIDTH / 2;

    // Helper: stroke a world-space line of a given world width.
    const lineWorld = (
      x1: number,
      z1: number,
      x2: number,
      z2: number,
      widthWorld: number,
      color: string,
    ) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = widthWorld * px;
      ctx.lineCap = "butt";
      const [a, b] = w2c(x1, z1);
      const [c, d] = w2c(x2, z2);
      ctx.beginPath();
      ctx.moveTo(a, b);
      ctx.lineTo(c, d);
      ctx.stroke();
    };

    // Helper: fill a world-space axis-aligned rect.
    const rectWorld = (
      x1: number,
      z1: number,
      x2: number,
      z2: number,
      color: string,
    ) => {
      const [ax, ay] = w2c(x1, z1);
      const [bx, by] = w2c(x2, z2);
      ctx.fillStyle = color;
      ctx.fillRect(
        Math.min(ax, bx),
        Math.min(ay, by),
        Math.abs(bx - ax),
        Math.abs(by - ay),
      );
    };

    // 2. Road surface: one filled rect per aisle, ROAD_WIDTH wide, centred
    //    on the aisle y, spanning that aisle's x range.
    for (const a of aisles) {
      rectWorld(a.x0, a.y - half, a.x1, a.y + half, LANE_COLOR);
    }

    // 3. White road edge lines (0.15 wide) on both outer edges of each aisle.
    for (const a of aisles) {
      lineWorld(a.x0, a.y - half, a.x1, a.y - half, 0.15, MARKING_WHITE);
      lineWorld(a.x0, a.y + half, a.x1, a.y + half, 0.15, MARKING_WHITE);
    }

    // 4. Double yellow centre line: two 0.08-wide lines at y +/- 0.1.
    for (const a of aisles) {
      lineWorld(a.x0, a.y - 0.1, a.x1, a.y - 0.1, 0.08, CENTER_LINE_COLOR);
      lineWorld(a.x0, a.y + 0.1, a.x1, a.y + 0.1, 0.08, CENTER_LINE_COLOR);
    }

    // 5 + 6. Parking bays: side lines + closed back line in white, and a
    //        crisp colour-coded bar on the aisle-facing edge.
    const slots = Object.entries(lot.nodes).filter(
      ([, n]) => n.floor === floor && n.type === "slot" && n.size != null,
    );
    for (const [, node] of slots) {
      const size = node.size!;
      // Nearest aisle centreline: determines which bay edge faces the aisle.
      const aisleY = Math.round(node.y / AISLE_SPACING) * AISLE_SPACING;
      const side = node.y < aisleY ? -1 : 1; // -1: bay on -y side, +1: +y side
      const xL = node.x - SLOT_WIDTH / 2;
      const xR = node.x + SLOT_WIDTH / 2;
      const backZ = node.y - side * (SLOT_DEPTH / 2);
      const aisleZ = node.y + side * (SLOT_DEPTH / 2);

      // Two side lines (full bay depth) + closed back line. Aisle-facing
      // edge is left open.
      lineWorld(xL, backZ, xL, aisleZ, 0.15, MARKING_WHITE);
      lineWorld(xR, backZ, xR, aisleZ, 0.15, MARKING_WHITE);
      lineWorld(xL, backZ, xR, backZ, 0.15, MARKING_WHITE);

      // Colour-coded bar on the aisle-facing edge: the outer 0.2 of the bay
      // (just inside the opening), so it reads as the bay-size cue.
      const barInner = aisleZ - side * 0.2;
      rectWorld(
        xL,
        barInner,
        xR,
        aisleZ,
        SLOT_OUTLINE_HEX[size],
      );
    }

    // 7. Bay numbers. "S0_42" -> "A42" (floor 0=A, 1=B, 2=C, ...). Bold
    //    sans-serif, white fill, dark outline, auto-sized to fit within
    //    SLOT_WIDTH without touching the side lines. Bays on opposite sides
    //    of an aisle are rotated 180deg so each reads for its own traffic.
    const floorLetter = String.fromCharCode(65 + floor);
    const maxTextWidthWorld = SLOT_WIDTH - 2 * 0.15 - 0.1;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";

    for (const [id, node] of slots) {
      const num = id.replace(/^S\d+_/, "");
      const label = `${floorLetter}${num}`;
      const aisleY = Math.round(node.y / AISLE_SPACING) * AISLE_SPACING;
      const side = node.y < aisleY ? -1 : 1;
      // -y side bay: driver looks toward -z, text top must point to -z
      // (back), so rotate 180deg. +y side bay: no rotation. The two differ
      // by 180deg as required.
      const rotDeg = side === -1 ? 180 : 0;

      // Fit font to the bay width.
      let fontWorld = 1.4;
      ctx.font = `bold ${fontWorld * px}px sans-serif`;
      const measuredWorld = ctx.measureText(label).width / px;
      if (measuredWorld > maxTextWidthWorld) {
        fontWorld *= maxTextWidthWorld / measuredWorld;
        ctx.font = `bold ${fontWorld * px}px sans-serif`;
      }

      const [cx, cy] = w2c(node.x, node.y);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate((rotDeg * Math.PI) / 180);
      ctx.lineWidth = 0.08 * px;
      ctx.strokeStyle = "#000000";
      ctx.strokeText(label, 0, 0);
      ctx.fillStyle = MARKING_WHITE;
      ctx.fillText(label, 0, 0);
      ctx.restore();
    }

    // 8. Direction arrows in both driving lanes. Even aisle index flows +x,
    //    odd flows -x. Simple filled chevron ~1.4 long, every 6 units.
    for (const a of aisles) {
      const dir = a.index % 2 === 0 ? 1 : -1;
      const laneZs = [a.y - LANE_WIDTH / 2, a.y + LANE_WIDTH / 2];
      for (const laneZ of laneZs) {
        for (let x = a.x0 + 3; x <= a.x1 - 3; x += 6) {
          const [tipX, tipY] = w2c(x + 0.7 * dir, laneZ);
          const [topX, topY] = w2c(x - 0.7 * dir, laneZ - 0.3);
          const [innX, innY] = w2c(x - 0.2 * dir, laneZ);
          const [botX, botY] = w2c(x - 0.7 * dir, laneZ + 0.3);
          ctx.fillStyle = MARKING_WHITE;
          ctx.beginPath();
          ctx.moveTo(tipX, tipY);
          ctx.lineTo(topX, topY);
          ctx.lineTo(innX, innY);
          ctx.lineTo(botX, botY);
          ctx.closePath();
          ctx.fill();
        }
      }
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.anisotropy = 8;
    tex.colorSpace = THREE.SRGBColorSpace;

    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      transparent: true,
      roughness: 0.85,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      depthWrite: false,
    });

    const geo = new THREE.PlaneGeometry(w, h);

    return { texture: tex, material: mat, plane: geo };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lot, floor, boundsKey]);

  // Dispose GPU resources when the floor texture rebuilds or unmounts.
  useEffect(() => {
    return () => {
      texture.dispose();
      material.dispose();
      plane.dispose();
    };
  }, [texture, material, plane]);

  // Nothing to paint on this floor.
  const hasNodes = useMemo(
    () => Object.values(lot.nodes).some((n) => n.floor === floor),
    [lot, floor],
  );
  if (!hasNodes) return null;

  const cx = (bounds.minX + bounds.maxX) / 2;
  const cz = (bounds.minZ + bounds.maxZ) / 2;
  const y = floor * FLOOR_HEIGHT + 0.16;

  return (
    <mesh position={[cx, y, cz]} rotation={[-Math.PI / 2, 0, 0]}>
      <primitive object={plane} attach="geometry" />
      <primitive object={material} attach="material" />
    </mesh>
  );
}

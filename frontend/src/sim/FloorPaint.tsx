import { useEffect, useMemo } from "react";
import * as THREE from "three";
import type { JSX } from "react";
import type { LotData } from "../types";
import {
  AISLE_SPACING,
  FLOOR_HEIGHT,
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
 * rotated [-PI/2, 0, 0] and CanvasTexture defaults to flipY = true. See the
 * w2c helper for what that actually works out to; it is not what you would
 * guess, and guessing it mirrored every marking in the garage.
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
    // Every draw call below goes through `w2c`, so this is the only place
    // that knows the mapping.
    // The plane is rotated -PI/2 about X, so its local +Y maps to world -Z.
    // CanvasTexture has flipY = true, which maps v=1 (local +Y, i.e. world
    // -Z) to canvas row 0. So world minZ is canvas top, NOT world maxZ.
    //
    // Getting this backwards mirrored the ENTIRE floor about z = 25.5: every
    // bay number named a bay on the far side of the garage (a driver sent to
    // C104 would have parked in C24) and every direction chevron pointed
    // against the traffic. The road, edge lines and bay outlines hid it,
    // because the aisles at z = 0, 17, 34, 51 happen to be symmetric about
    // that centreline.
    const minZ = bounds.minZ;
    const w2c = (wx: number, wz: number): [number, number] => [
      (wx - bounds.minX) * px,
      (wz - minZ) * px,
    ];

    // 1. Transparent background: the concrete slab shows through where we
    //    paint nothing.
    ctx.clearRect(0, 0, canvasW, canvasH);

    // Group this floor's junctions by aisle index to recover each aisle's
    // centreline (y) and x extent. `bayX0/bayX1` is the junction-only span
    // (where the bays and arrows live); `x0/x1` also covers the entry, exit
    // and ramp nodes at x = 0, which is how far the tarmac actually runs.
    const aisleMap = new Map<number, { y: number; xs: number[]; bayXs: number[] }>();
    for (const [id, node] of Object.entries(lot.nodes)) {
      if (node.floor !== floor || node.type !== "junction") continue;
      const idx = aisleOf(id);
      if (idx === null) continue;
      const entry = aisleMap.get(idx) ?? { y: node.y, xs: [], bayXs: [] };
      entry.xs.push(node.x);
      entry.bayXs.push(node.x);
      aisleMap.set(idx, entry);
    }
    const CONNECTIONS = new Set(["entry", "exit", "ramp_up", "ramp_in"]);
    for (const node of Object.values(lot.nodes)) {
      if (node.floor !== floor || !CONNECTIONS.has(node.type)) continue;
      const idx = Math.round(node.y / AISLE_SPACING);
      aisleMap.get(idx)?.xs.push(node.x);
    }
    const aisles = [...aisleMap.entries()]
      .map(([idx, { y, xs, bayXs }]) => ({
        index: idx,
        y,
        x0: Math.min(...xs),
        x1: Math.max(...xs),
        bayX0: Math.min(...bayXs),
        bayX1: Math.max(...bayXs),
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

    // Helper: stroke a dashed world-space line.
    const dashedLineWorld = (
      x1: number,
      z1: number,
      x2: number,
      z2: number,
      widthWorld: number,
      dashWorld: number,
      gapWorld: number,
      color: string,
    ) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = widthWorld * px;
      ctx.lineCap = "butt";
      ctx.setLineDash([dashWorld * px, gapWorld * px]);
      const [a, b] = w2c(x1, z1);
      const [c, d] = w2c(x2, z2);
      ctx.beginPath();
      ctx.moveTo(a, b);
      ctx.lineTo(c, d);
      ctx.stroke();
      ctx.setLineDash([]);
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

    // 2. No road surface is painted here.
    //
    //    The tarmac is real geometry: AisleRoad's raised box, TurnRoad's and
    //    RampRoad's ribbons, all sharing one asphalt material. Filling the
    //    aisles again on this canvas layered a second, differently-shaded
    //    surface on top of the first — a transparent MeshStandardMaterial at
    //    y = 0.16 over an opaque one at y = 0.15 — so a straight aisle, the
    //    turn at the end of it and the ramp beyond that were three visibly
    //    different greys. The fill also stopped at the outermost junction
    //    (x = 2.6) while the asphalt box runs to x = 0, putting a hard colour
    //    seam right at every entry, exit and ramp mouth.

    // 3. White road edge lines (0.15 wide) on both outer edges of each aisle,
    //    running the full length of the tarmac including the approach to the
    //    entry / exit / ramp node.
    for (const a of aisles) {
      lineWorld(a.x0, a.y - half, a.x1, a.y - half, 0.15, MARKING_WHITE);
      lineWorld(a.x0, a.y + half, a.x1, a.y + half, 0.15, MARKING_WHITE);
    }

    // 4. Broken white centre line. Aisles have parking on both sides, so the
    //    divider must stay crossable when a car needs a bay across the road.
    for (const a of aisles) {
      dashedLineWorld(a.x0, a.y, a.x1, a.y, 0.12, 1.2, 1.2, MARKING_WHITE);
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
      // `side` is +1 when the bay lies on the +y side of its aisle, so the
      // edge NEAREST the aisle is the one at node.y - side*depth/2. These two
      // were swapped, which painted the solid "closed back" line across the
      // bay's entrance and put the coloured size bar against the rear wall.
      // Two rows of bays back to back then placed their bars a unit apart,
      // which is the continuous multicoloured band running down the middle.
      const aisleZ = node.y - side * (SLOT_DEPTH / 2);
      const backZ = node.y + side * (SLOT_DEPTH / 2);

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
      // A bay number is read side-on, by a driver in the aisle looking across
      // at the bay, so the top of the lettering has to point AWAY from the
      // aisle and into the bay. That depends on which SIDE of the aisle the
      // bay is on, not on which way the aisle runs.
      //
      // Rotation was keyed off the aisle index instead, which gave both rows
      // of an aisle the same rotation — so on every single aisle in the
      // garage one of the two rows was printed upside down to the only people
      // who ever read it.
      //
      // Canvas +y maps to world +z here (see w2c), and canvas text stands
      // with its top toward -y, so an unrotated label points its top at -z.
      // That is correct for the row on the -z side; the +z row needs 180.
      const bayAisleY = Math.round(node.y / AISLE_SPACING) * AISLE_SPACING;
      const baySide = node.y < bayAisleY ? -1 : 1;
      const rotDeg = baySide < 0 ? 0 : 180;

      // Fit font to the bay width.
      let fontWorld = 1.4;
      ctx.font = `bold ${fontWorld * px}px sans-serif`;
      const measuredWorld = ctx.measureText(label).width / px;
      if (measuredWorld > maxTextWidthWorld) {
        fontWorld *= maxTextWidthWorld / measuredWorld;
        ctx.font = `bold ${fontWorld * px}px sans-serif`;
      }

      // Nudge the number toward the mouth of the bay. Painted dead centre it
      // sits under the parked car and only empty bays were ever legible.
      const labelZ = node.y - baySide * (SLOT_DEPTH / 2 - 0.55);
      const [cx, cy] = w2c(node.x, labelZ);
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

    // 8. One arrow row per lane. Traffic keeps left: +x uses the -z lane and
    //    -x uses the +z lane. The rows are staggered by half the 6-unit pitch.
    for (const a of aisles) {
      const rows = [
        { z: a.y - LANE_WIDTH / 2, dir: 1, start: a.x0 + 3 },
        { z: a.y + LANE_WIDTH / 2, dir: -1, start: a.x0 + 6 },
      ] as const;
      for (const row of rows) {
        for (let x = row.start; x <= a.x1 - 3; x += 6) {
          const [tipX, tipY] = w2c(x + 0.7 * row.dir, row.z);
          const [topX, topY] = w2c(x - 0.7 * row.dir, row.z - 0.3);
          const [innX, innY] = w2c(x - 0.2 * row.dir, row.z);
          const [botX, botY] = w2c(x - 0.7 * row.dir, row.z + 0.3);
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

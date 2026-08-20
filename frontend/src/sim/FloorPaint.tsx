import { useEffect, useMemo } from "react";
import * as THREE from "three";
import type { JSX } from "react";
import type { LotData } from "../types";
import { aisleOf } from "./geometry";
import {
  AISLE_SPACING,
  EDGE_LINE_OFFSET,
  EDGE_LINE_WIDTH,
  FLOOR_HEIGHT,
  LANE_WIDTH,
  MARKING_WHITE,
  SLOT_DEPTH,
  SLOT_WIDTH,
} from "./constants";

/* FloorPaint
 *
 * Bakes every flat, static floor marking on one garage floor (road surface,
 * edge/centre lines, parking-bay outlines, bay numbers, direction arrows)
 * into a single CanvasTexture on a single horizontal plane.
 */

export function FloorPaint({
  lot,
  floor,
  bounds,
}: {
  lot: LotData;
  floor: number;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}): JSX.Element | null {
  const boundsKey = `${bounds.minX},${bounds.maxX},${bounds.minZ},${bounds.maxZ}`;

  const { texture, material, plane } = useMemo(() => {
    const w = bounds.maxX - bounds.minX;
    const h = bounds.maxZ - bounds.minZ;
    const px = Math.min(50, 4096 / w, 4096 / h);
    const canvasW = Math.max(1, Math.ceil(w * px));
    const canvasH = Math.max(1, Math.ceil(h * px));

    const canvas = document.createElement("canvas");
    canvas.width = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext("2d")!;

    const minZ = bounds.minZ;
    const w2c = (wx: number, wz: number): [number, number] => [
      (wx - bounds.minX) * px,
      (wz - minZ) * px,
    ];

    ctx.clearRect(0, 0, canvasW, canvasH);

    const aisleMap = new Map<number, { y: number; xs: number[]; bayXs: number[] }>();
    for (const [id, node] of Object.entries(lot.nodes)) {
      if (node.floor !== floor || node.type !== "junction") continue;
      const index = aisleOf(id);
      if (index === null) continue;
      const entry = aisleMap.get(index) ?? { y: node.y, xs: [], bayXs: [] };
      entry.xs.push(node.x);
      entry.bayXs.push(node.x);
      aisleMap.set(index, entry);
    }
    const connections = new Set(["entry", "exit", "ramp_up", "ramp_in"]);
    for (const node of Object.values(lot.nodes)) {
      if (node.floor !== floor || !connections.has(node.type)) continue;
      const index = Math.round(node.y / AISLE_SPACING);
      aisleMap.get(index)?.xs.push(node.x);
    }
    const aisles = [...aisleMap.entries()]
      .map(([index, { y, xs, bayXs }]) => ({
        index,
        y,
        x0: Math.min(...xs),
        x1: Math.max(...xs),
        bayX0: Math.min(...bayXs),
        bayX1: Math.max(...bayXs),
      }))
      .sort((a, b) => a.index - b.index);

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

    for (const aisle of aisles) {
      lineWorld(
        aisle.x0,
        aisle.y - EDGE_LINE_OFFSET,
        aisle.x1,
        aisle.y - EDGE_LINE_OFFSET,
        EDGE_LINE_WIDTH,
        MARKING_WHITE,
      );
      lineWorld(
        aisle.x0,
        aisle.y + EDGE_LINE_OFFSET,
        aisle.x1,
        aisle.y + EDGE_LINE_OFFSET,
        EDGE_LINE_WIDTH,
        MARKING_WHITE,
      );
      dashedLineWorld(aisle.x0, aisle.y, aisle.x1, aisle.y, 0.12, 1.2, 1.2, MARKING_WHITE);
    }

    // Every bay is identical: three white sides, with the aisle-facing edge
    // left open. There are no size colours or category bars.
    const slots = Object.entries(lot.nodes).filter(
      ([, node]) => node.floor === floor && node.type === "slot",
    );
    for (const [, node] of slots) {
      const aisleY = Math.round(node.y / AISLE_SPACING) * AISLE_SPACING;
      const side = node.y < aisleY ? -1 : 1;
      const xL = node.x - SLOT_WIDTH / 2;
      const xR = node.x + SLOT_WIDTH / 2;
      const aisleZ = node.y - side * (SLOT_DEPTH / 2);
      const backZ = node.y + side * (SLOT_DEPTH / 2);

      lineWorld(xL, backZ, xL, aisleZ, 0.15, MARKING_WHITE);
      lineWorld(xR, backZ, xR, aisleZ, 0.15, MARKING_WHITE);
      lineWorld(xL, backZ, xR, backZ, 0.15, MARKING_WHITE);
    }

    const floorLetter = String.fromCharCode(65 + floor);
    const maxTextWidthWorld = SLOT_WIDTH - 2 * 0.15 - 0.1;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";

    for (const [id, node] of slots) {
      const number = id.replace(/^S\d+_/, "");
      const label = `${floorLetter}${number}`;
      const aisleY = Math.round(node.y / AISLE_SPACING) * AISLE_SPACING;
      const side = node.y < aisleY ? -1 : 1;
      const rotation = side < 0 ? 0 : Math.PI;

      let fontWorld = 1.4;
      ctx.font = `bold ${fontWorld * px}px sans-serif`;
      const measuredWorld = ctx.measureText(label).width / px;
      if (measuredWorld > maxTextWidthWorld) {
        fontWorld *= maxTextWidthWorld / measuredWorld;
        ctx.font = `bold ${fontWorld * px}px sans-serif`;
      }

      const labelZ = node.y - side * (SLOT_DEPTH / 2 - 0.55);
      const [cx, cy] = w2c(node.x, labelZ);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rotation);
      ctx.lineWidth = 0.08 * px;
      ctx.strokeStyle = "#000000";
      ctx.strokeText(label, 0, 0);
      ctx.fillStyle = MARKING_WHITE;
      ctx.fillText(label, 0, 0);
      ctx.restore();
    }

    for (const aisle of aisles) {
      const rows = [
        { z: aisle.y - LANE_WIDTH / 2, dir: 1, start: aisle.x0 + 3 },
        { z: aisle.y + LANE_WIDTH / 2, dir: -1, start: aisle.x0 + 6 },
      ] as const;
      for (const row of rows) {
        for (let x = row.start; x <= aisle.x1 - 3; x += 6) {
          const [tipX, tipY] = w2c(x + 0.7 * row.dir, row.z);
          const [topX, topY] = w2c(x - 0.7 * row.dir, row.z - 0.3);
          const [innerX, innerY] = w2c(x - 0.2 * row.dir, row.z);
          const [bottomX, bottomY] = w2c(x - 0.7 * row.dir, row.z + 0.3);
          ctx.fillStyle = MARKING_WHITE;
          ctx.beginPath();
          ctx.moveTo(tipX, tipY);
          ctx.lineTo(topX, topY);
          ctx.lineTo(innerX, innerY);
          ctx.lineTo(bottomX, bottomY);
          ctx.closePath();
          ctx.fill();
        }
      }
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.anisotropy = 8;
    texture.colorSpace = THREE.SRGBColorSpace;

    const material = new THREE.MeshStandardMaterial({
      map: texture,
      transparent: true,
      roughness: 0.85,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      depthWrite: false,
    });
    const plane = new THREE.PlaneGeometry(w, h);
    return { texture, material, plane };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lot, floor, boundsKey]);

  useEffect(() => {
    return () => {
      texture.dispose();
      material.dispose();
      plane.dispose();
    };
  }, [texture, material, plane]);

  const hasNodes = useMemo(
    () => Object.values(lot.nodes).some((node) => node.floor === floor),
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

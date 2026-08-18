import { Html } from "@react-three/drei";
import type { CarColor, Direction } from "../types";
import { COLOR_HEX, toWorld } from "./constants";

interface SignboardProps {
  nodeX: number;
  nodeY: number;
  floor: number;
  carId: string;
  color: CarColor;
  plate: string;
  direction: Direction;
  slot: string;
  slotFloor: number;
}

const ARROW: Record<Direction, string> = {
  left: "◀",
  right: "▶",
  straight: "▲",
  up: "⬆",
  arrived: "◉",
};

const DIR_LABEL: Record<Direction, string> = {
  left: "LEFT",
  right: "RIGHT",
  straight: "STRAIGHT",
  up: "RAMP UP",
  arrived: "ARRIVED",
};

/** An electronic signboard on a pole at a junction, rendered via Html overlay. */
export function Signboard({
  nodeX,
  nodeY,
  floor,
  carId,
  color,
  plate,
  direction,
  slot,
  slotFloor,
}: SignboardProps) {
  const [wx, wy, wz] = toWorld(nodeX, nodeY, floor);
  const hex = COLOR_HEX[color];

  return (
    <group position={[wx, wy, wz]}>
      {/* Pole */}
      <mesh position={[0, 2.2, 0]}>
        <cylinderGeometry args={[0.08, 0.08, 4.4, 8]} />
        <meshStandardMaterial color="#1a1c22" roughness={0.8} />
      </mesh>
      {/* Panel backing */}
      <mesh position={[0, 4.6, 0]}>
        <boxGeometry args={[3.4, 1.7, 0.12]} />
        <meshStandardMaterial
          color="#08090c"
          roughness={0.5}
          metalness={0.3}
          emissive="#000000"
        />
      </mesh>
      <Html
        position={[0, 4.6, 0.08]}
        center
        distanceFactor={9}
        zIndexRange={[20, 0]}
        style={{ pointerEvents: "none" }}
      >
        <div
          style={{
            width: 230,
            background: "#000",
            border: `1px solid ${hex}`,
            borderLeft: `6px solid ${hex}`,
            color: "#fff",
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            fontSize: 12,
            lineHeight: 1.25,
            padding: "6px 9px",
            boxSizing: "border-box",
            userSelect: "none",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                display: "inline-block",
                width: 12,
                height: 12,
                background: hex,
                border: "1px solid rgba(255,255,255,0.4)",
                flexShrink: 0,
              }}
            />
            <span style={{ fontWeight: 700, letterSpacing: 0.5 }}>{plate}</span>
            <span style={{ color: "#6b7280", marginLeft: "auto" }}>{carId}</span>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginTop: 4,
            }}
          >
            <span
              style={{
                fontSize: 22,
                color: hex,
                fontWeight: 700,
                lineHeight: 1,
              }}
            >
              {ARROW[direction]}
            </span>
            <span style={{ fontSize: 11, color: "#e5e7eb" }}>
              {DIR_LABEL[direction]}
            </span>
            <span
              style={{
                marginLeft: "auto",
                fontSize: 10,
                color: "#9ca3af",
              }}
            >
              {direction === "arrived" ? slot : `${slot} F${slotFloor}`}
            </span>
          </div>
        </div>
      </Html>
    </group>
  );
}

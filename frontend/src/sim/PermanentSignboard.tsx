import { memo } from "react";
import { Text } from "@react-three/drei";
import * as THREE from "three";
import type { BoardCar, Direction, NodeSign } from "../types";
import { COLOR_HEX, FLOOR_HEIGHT } from "./constants";

export interface PermanentSignboardProps {
  position: [number, number, number];
  rotY: number;
  /** What this junction permanently is, e.g. "U-TURN" or "RAMP UP → B". */
  label: string;
  /** When true the board is on the top floor (no ceiling slab above), so it
   *  stands on posts instead of hanging from rods. */
  isTopFloor?: boolean;
  /** Floor the board sits on. */
  floor: number;
  /** The queue of cars heading for this node, nearest first. */
  dynamic?: NodeSign;
}

/** Convert a bay node id ("S2_5") into a display label ("C5"). The floor is
 *  encoded in the id itself as S{floor}_{number}. */
function bayLabel(slot: string): string {
  const m = slot.match(/^S(\d+)_(\d+)$/);
  return m ? `${String.fromCharCode(65 + Number(m[1]))}${m[2]}` : slot;
}

/** Where a car is ultimately going, as the board should print it. */
function destinationLabel(car: BoardCar): string {
  return car.leaving ? "EXIT" : bayLabel(car.slot);
}

/** The word a driver reads for the move they must make at this board. */
function directionWord(dir: Direction): string {
  switch (dir) {
    case "left":
      return "LEFT";
    case "right":
      return "RIGHT";
    case "straight":
      return "AHEAD";
    case "up":
      return "UP";
    case "down":
      return "DOWN";
    default:
      return "";
  }
}

/** Z rotation for the chevron. The arrow shape points up (+y) by default. */
function directionToRotation(dir: Direction): number {
  switch (dir) {
    case "left":
      return Math.PI / 2;
    case "right":
      return -Math.PI / 2;
    case "up":
      return -Math.PI / 4;
    case "down":
      return (-Math.PI * 3) / 4;
    default:
      return 0;
  }
}

/** How far off a car is, in words a driver can act on. */
function distanceWord(distance: number): string {
  return distance < 5 ? "NOW" : `${Math.round(distance)} m`;
}

/* --- Dark LED highway-sign palette --- */
const SCREEN_COLOR = "#000000";
const SCREEN_EMISSIVE = "#0a1622";
/** Bright sky-blue accent for the leading car and the header. */
const ACCENT = "#38bdf8";
/** Off-white body text for the leading row. */
const BODY_TEXT = "#f1f5f9";
/** Slate grey for the cars queued behind. */
const DIM_TEXT = "#7c8698";

/* --- Board dimensions.
 *
 * The board grew from 8 x 3.5 to 10 x 4.6 because it now carries a queue
 * rather than a single instruction. With four cars nose to tail in one aisle
 * only the leader's instruction used to appear, so the three behind it had
 * nothing to act on. --- */
const BOARD_W = 10;
const BOARD_H = 4.6;
const SCREEN_W = BOARD_W - 0.6;
const SCREEN_H = BOARD_H - 0.5;
const SCREEN_HALF_W = SCREEN_W / 2;
const SCREEN_HALF_H = SCREEN_H / 2;
const BOARD_CENTER_Y = 5.6;
const BOARD_TOP_Y = BOARD_CENTER_Y + BOARD_H / 2;
const ROD_LENGTH = FLOOR_HEIGHT - BOARD_TOP_Y;
const ROD_CENTER_Y = (FLOOR_HEIGHT + BOARD_TOP_Y) / 2;

/* --- Screen layout.
 *
 * The car being instructed right now owns the top of the board at a size
 * that reads from the far end of an aisle; everyone behind it gets a small
 * row underneath, in order. When the leader clears the junction it drops off
 * its own route and the car below is promoted into the hero block, with no
 * extra bookkeeping anywhere. --- */
/** Thin strip at the very top naming the junction. */
const LABEL_Y = SCREEN_HALF_H - 0.24;
/** Hero block: the car at the front of the queue. */
const HERO_TOP = SCREEN_HALF_H - 0.5;
const HERO_H = 1.45;
const HERO_CENTER_Y = HERO_TOP - HERO_H / 2;
const HERO_LINE1_Y = HERO_CENTER_Y + 0.36;
const HERO_LINE2_Y = HERO_CENTER_Y - 0.36;
/** Queue block: everyone else, nearest first. */
const RULE_Y = HERO_TOP - HERO_H - 0.1;
const QUEUE_TOP_Y = RULE_Y - 0.42;
const QUEUE_PITCH = 0.6;
const QUEUE_ROWS = 3;

/* --- Shared geometry: one of each, reused across all eleven boards. --- */
const ARROW_SHAPE = (() => {
  const s = new THREE.Shape();
  s.moveTo(0, 0.75);
  s.lineTo(-0.5, 0);
  s.lineTo(-0.2, 0);
  s.lineTo(-0.2, -0.75);
  s.lineTo(0.2, -0.75);
  s.lineTo(0.2, 0);
  s.lineTo(0.5, 0);
  s.closePath();
  return s;
})();
const ARROW_GEOMETRY = new THREE.ShapeGeometry(ARROW_SHAPE);
const BOARD_BODY_GEO = new THREE.BoxGeometry(BOARD_W, BOARD_H, 0.2);
const BOARD_RIM_GEO = new THREE.BoxGeometry(BOARD_W + 0.14, BOARD_H + 0.14, 0.16);
const SCREEN_GEO = new THREE.PlaneGeometry(SCREEN_W, SCREEN_H);
const ROD_GEO = new THREE.CylinderGeometry(0.12, 0.12, ROD_LENGTH, 8);
/** Ground-standing posts for the open top deck, where there is no slab.
 *  They sit at +/-4.1, outside the 7-wide road (+/-3.5). At the old board
 *  width they landed at +/-3.1, i.e. inside the carriageway, so cars drove
 *  straight through them on every top-floor turn. */
const POST_X = BOARD_W / 2 - 0.9;
const POST_H = BOARD_CENTER_Y - BOARD_H / 2;
const POST_CENTER_Y = POST_H / 2;
const POST_GEO = new THREE.CylinderGeometry(0.15, 0.18, POST_H, 10);
/** Full-width band behind the hero car, tinted in that car's colour. */
const HERO_BAND_GEO = new THREE.PlaneGeometry(SCREEN_W - 0.1, HERO_H);
/** Full-height colour bar down the left edge of the hero block. The band
 *  itself is only faintly tinted: painting the whole block in the car's own
 *  colour looked striking but left white text on saturated cyan or yellow,
 *  which is unreadable at the distance this board is actually read from. The
 *  bar carries the colour identity at full strength instead. */
const HERO_BAR_GEO = new THREE.PlaneGeometry(0.34, HERO_H - 0.12);
const QUEUE_SWATCH_GEO = new THREE.PlaneGeometry(0.3, 0.3);
const RULE_GEO = new THREE.PlaneGeometry(SCREEN_W - 0.1, 0.03);

/* --- Shared materials: eleven boards share these. --- */
const FRAME_MATERIAL = new THREE.MeshStandardMaterial({
  color: "#1b1f29",
  metalness: 0.35,
  roughness: 0.55,
});
const EDGE_MATERIAL = new THREE.MeshStandardMaterial({
  color: "#2b323f",
  emissive: ACCENT,
  emissiveIntensity: 0.07,
  metalness: 0.3,
  roughness: 0.5,
});
/** Rear skin, so a board seen from behind is a sign and not a hole. */
const BACK_MATERIAL = new THREE.MeshStandardMaterial({
  color: "#333b49",
  metalness: 0.55,
  roughness: 0.45,
});
const ROD_MATERIAL = new THREE.MeshStandardMaterial({
  color: "#080a10",
  metalness: 0.6,
  roughness: 0.4,
});
const SCREEN_MATERIAL = new THREE.MeshStandardMaterial({
  color: SCREEN_COLOR,
  emissive: SCREEN_EMISSIVE,
  emissiveIntensity: 0.4,
  roughness: 0.5,
  metalness: 0.1,
});
const RULE_MATERIAL = new THREE.MeshStandardMaterial({
  color: "#1e2836",
  emissive: ACCENT,
  emissiveIntensity: 0.12,
  roughness: 0.6,
});
/** Hero chevron. White, not the sky-blue accent: the hero band is tinted in
 *  the car's own colour, and a cyan arrow on a red or purple band was the
 *  least legible thing on the board. */
const ARROW_BRIGHT_MATERIAL = new THREE.MeshStandardMaterial({
  color: BODY_TEXT,
  emissive: BODY_TEXT,
  emissiveIntensity: 0.7,
  roughness: 0.4,
});
const ARROW_DIM_MATERIAL = new THREE.MeshStandardMaterial({
  color: DIM_TEXT,
  emissive: DIM_TEXT,
  emissiveIntensity: 0.12,
  roughness: 0.6,
});

/** The car at the front of the queue, printed large across the top of the
 *  board: colour block, plate, the move to make here, where it is going, and
 *  how far off it still is. */
function HeroCar({ car }: { car: BoardCar }) {
  const hex = COLOR_HEX[car.color];
  return (
    <group>
      <mesh position={[0, HERO_CENTER_Y, -0.01]} geometry={HERO_BAND_GEO}>
        <meshStandardMaterial color="#0d1422" emissive={hex} emissiveIntensity={0.09} roughness={0.5} />
      </mesh>
      <mesh position={[-SCREEN_HALF_W + 0.22, HERO_CENTER_Y, 0.01]} geometry={HERO_BAR_GEO}>
        <meshStandardMaterial color={hex} emissive={hex} emissiveIntensity={0.95} roughness={0.4} />
      </mesh>
      <Text
        position={[-SCREEN_HALF_W + 0.62, HERO_LINE1_Y, 0.02]}
        fontSize={0.6}
        color={BODY_TEXT}
        anchorX="left"
        anchorY="middle"
        outlineWidth={0.03}
        outlineColor="#000000"
      >
        {car.plate}
      </Text>
      <Text
        position={[SCREEN_HALF_W - 0.15, HERO_LINE1_Y, 0.02]}
        fontSize={0.46}
        color={BODY_TEXT}
        anchorX="right"
        anchorY="middle"
        outlineWidth={0.03}
        outlineColor="#000000"
      >
        {distanceWord(car.distance)}
      </Text>
      <mesh
        position={[-SCREEN_HALF_W + 0.85, HERO_LINE2_Y, 0.02]}
        scale={[0.62, 0.62, 0.62]}
        rotation={[0, 0, directionToRotation(car.direction)]}
        geometry={ARROW_GEOMETRY}
        material={ARROW_BRIGHT_MATERIAL}
      />
      <Text
        position={[-SCREEN_HALF_W + 1.25, HERO_LINE2_Y, 0.02]}
        fontSize={0.72}
        color={BODY_TEXT}
        anchorX="left"
        anchorY="middle"
        outlineWidth={0.03}
        outlineColor="#000000"
      >
        {directionWord(car.direction)}
      </Text>
      <Text
        position={[SCREEN_HALF_W - 0.15, HERO_LINE2_Y, 0.02]}
        fontSize={0.62}
        color={BODY_TEXT}
        anchorX="right"
        anchorY="middle"
        outlineWidth={0.03}
        outlineColor="#000000"
      >
        {destinationLabel(car)}
      </Text>
    </group>
  );
}

/** One waiting car, small, under the rule. Same five facts as the hero row so
 *  a driver three back can read their own instruction and act on it. */
function QueuedCar({ car, index }: { car: BoardCar; index: number }) {
  const y = QUEUE_TOP_Y - index * QUEUE_PITCH;
  const hex = COLOR_HEX[car.color];
  return (
    <group position={[0, y, 0]}>
      <mesh position={[-SCREEN_HALF_W + 0.35, 0, 0.01]} geometry={QUEUE_SWATCH_GEO}>
        <meshStandardMaterial color={hex} emissive={hex} emissiveIntensity={0.5} roughness={0.45} />
      </mesh>
      <Text
        position={[-SCREEN_HALF_W + 0.65, 0, 0.02]}
        fontSize={0.34}
        color={DIM_TEXT}
        anchorX="left"
        anchorY="middle"
        outlineWidth={0.02}
        outlineColor="#000000"
      >
        {car.plate}
      </Text>
      <mesh
        position={[-1.5, 0, 0.02]}
        scale={[0.3, 0.3, 0.3]}
        rotation={[0, 0, directionToRotation(car.direction)]}
        geometry={ARROW_GEOMETRY}
        material={ARROW_DIM_MATERIAL}
      />
      <Text
        position={[-1.25, 0, 0.02]}
        fontSize={0.34}
        color={DIM_TEXT}
        anchorX="left"
        anchorY="middle"
        outlineWidth={0.02}
        outlineColor="#000000"
      >
        {directionWord(car.direction)}
      </Text>
      <Text
        position={[1.1, 0, 0.02]}
        fontSize={0.34}
        color={DIM_TEXT}
        anchorX="left"
        anchorY="middle"
        outlineWidth={0.02}
        outlineColor="#000000"
      >
        {destinationLabel(car)}
      </Text>
      <Text
        position={[SCREEN_HALF_W - 0.15, 0, 0.02]}
        fontSize={0.3}
        color={DIM_TEXT}
        anchorX="right"
        anchorY="middle"
        outlineWidth={0.02}
        outlineColor="#000000"
      >
        {distanceWord(car.distance)}
      </Text>
    </group>
  );
}

/**
 * A permanent ceiling-hung direction board at a turn or at the foot of a ramp.
 *
 * The top of the board belongs to the car being instructed right now, printed
 * large. Under a rule, the cars behind it are listed small in the order they
 * will arrive. As the leader clears the junction it falls off its own route,
 * the next car becomes nearest, and the board promotes it into the hero block
 * on the following tick.
 *
 * Memoised on the values that actually reach the screen (see `propsEqual`),
 * so a 5 Hz tick does not re-layout eleven boards' worth of text.
 */
function PermanentSignboardImpl({
  position,
  rotY,
  label,
  isTopFloor = false,
  dynamic,
}: PermanentSignboardProps) {
  const queue = dynamic?.cars ?? [];
  const hero = queue[0];
  const waiting = queue.slice(1, 1 + QUEUE_ROWS);

  return (
    <group position={position} rotation={[0, rotY, 0]}>
      {isTopFloor ? (
        <>
          <mesh position={[-POST_X, POST_CENTER_Y, 0]} geometry={POST_GEO} material={FRAME_MATERIAL} castShadow />
          <mesh position={[POST_X, POST_CENTER_Y, 0]} geometry={POST_GEO} material={FRAME_MATERIAL} castShadow />
        </>
      ) : (
        <>
          <mesh position={[-POST_X, ROD_CENTER_Y, 0]} geometry={ROD_GEO} material={ROD_MATERIAL} />
          <mesh position={[POST_X, ROD_CENTER_Y, 0]} geometry={ROD_GEO} material={ROD_MATERIAL} />
        </>
      )}

      {/* Board face, tilted down toward the road. */}
      <group position={[0, BOARD_CENTER_Y, 0]} rotation={[0.3, 0, 0]}>
        <mesh castShadow geometry={BOARD_BODY_GEO} material={FRAME_MATERIAL} />
        <mesh geometry={BOARD_RIM_GEO} material={EDGE_MATERIAL} />
        <mesh position={[0, 0, -0.11]} rotation={[0, Math.PI, 0]} geometry={SCREEN_GEO} material={BACK_MATERIAL} />
        <mesh position={[0, 0, 0.11]} geometry={SCREEN_GEO} material={SCREEN_MATERIAL} />

        <group position={[0, 0, 0.13]}>
          {/* What this junction is. Always present, so the board still works
              as a permanent sign when no car is routed through it. */}
          <Text
            position={[-SCREEN_HALF_W + 0.15, LABEL_Y, 0]}
            fontSize={0.34}
            color={ACCENT}
            anchorX="left"
            anchorY="middle"
            outlineWidth={0.02}
            outlineColor="#000000"
          >
            {label}
          </Text>

          {hero ? (
            <>
              <HeroCar car={hero} />
              <mesh position={[0, RULE_Y, 0]} geometry={RULE_GEO} material={RULE_MATERIAL} />
              {waiting.map((car, i) => (
                <QueuedCar key={car.carId} car={car} index={i} />
              ))}
            </>
          ) : (
            <Text
              position={[0, -0.1, 0]}
              fontSize={0.5}
              color={DIM_TEXT}
              anchorX="center"
              anchorY="middle"
              outlineWidth={0.02}
              outlineColor="#000000"
            >
              NO CARS ROUTED
            </Text>
          )}
        </group>
      </group>
    </group>
  );
}

export const PermanentSignboard = memo(PermanentSignboardImpl, propsEqual);

/* --- Memo comparator. The parent hands us a fresh `dynamic` object on every
 *     car-movement tick; compare only the fields that reach the screen. --- */

function queueKey(sign: NodeSign | undefined): string {
  if (!sign) return "";
  return sign.cars
    .map((c) => `${c.plate}|${c.color}|${c.direction}|${c.slot}|${c.leaving}|${distanceWord(c.distance)}`)
    .join(",");
}

function propsEqual(prev: PermanentSignboardProps, next: PermanentSignboardProps): boolean {
  if (prev.label !== next.label) return false;
  if (prev.rotY !== next.rotY) return false;
  if (prev.floor !== next.floor) return false;
  if (prev.isTopFloor !== next.isTopFloor) return false;
  const pp = prev.position;
  const np = next.position;
  if (pp[0] !== np[0] || pp[1] !== np[1] || pp[2] !== np[2]) return false;
  return queueKey(prev.dynamic) === queueKey(next.dynamic);
}

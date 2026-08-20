import { memo, useMemo, type JSX } from "react";
import type { DestinationType, LotData, LotNode, NodeType } from "../types";
import { bayLabel } from "../sim/constants";

export interface RoutePanelCar {
  carId: string;
  plate: string;
  color: string;
  slot: string | null;
  path: string[];
  floor: number;
  routeDistance: number;
  estimatedSeconds: number;
  destinationType: DestinationType;
}

const VIEW_W = 360;
const VIEW_H = 232;
const MARGIN = 10;
const FLOOR_LABEL = ["A", "B", "C"];

const NODE_STYLE: Record<NodeType, { r: number; fill: string; opacity: number }> = {
  slot: { r: 1.1, fill: "#52525b", opacity: 0.55 },
  junction: { r: 1.6, fill: "#a1a1aa", opacity: 0.7 },
  turn: { r: 2.4, fill: "#d4d4d8", opacity: 0.85 },
  ramp_up: { r: 2.6, fill: "#d4d4d8", opacity: 0.85 },
  ramp_in: { r: 2.6, fill: "#d4d4d8", opacity: 0.85 },
  entry: { r: 2.8, fill: "#f4f4f5", opacity: 0.95 },
  exit: { r: 2.8, fill: "#f4f4f5", opacity: 0.95 },
  approach: { r: 2.2, fill: "#d4d4d8", opacity: 0.85 },
};

function destinationName(car: RoutePanelCar): string {
  if (car.destinationType === "exit") return "Exit";
  return car.slot ? bayLabel(car.slot) : "No bay";
}

function makeProjection(nodes: LotNode[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x);
    maxY = Math.max(maxY, node.y);
  }
  const spanX = Math.max(maxX - minX, 1);
  const spanY = Math.max(maxY - minY, 1);
  const scale = Math.min(
    (VIEW_W - 2 * MARGIN) / spanX,
    (VIEW_H - 2 * MARGIN) / spanY,
  );
  const offX = MARGIN + ((VIEW_W - 2 * MARGIN) - spanX * scale) / 2;
  const offY = MARGIN + ((VIEW_H - 2 * MARGIN) - spanY * scale) / 2;
  return (x: number, y: number): [number, number] => [
    offX + (x - minX) * scale,
    offY + (y - minY) * scale,
  ];
}

export const RoutePanel = memo(function RoutePanel({
  lot,
  cars,
  selectedCarId,
  onSelectCar,
}: {
  lot: LotData;
  cars: RoutePanelCar[];
  selectedCarId: string | null;
  onSelectCar: (id: string | null) => void;
}): JSX.Element | null {
  if (Object.keys(lot.nodes).length === 0) return null;
  const selected = selectedCarId
    ? cars.find((car) => car.carId === selectedCarId) ?? null
    : null;
  const floor = selected?.floor ?? 0;

  return (
    <div className="pointer-events-auto absolute bottom-14 left-4 w-[360px] rounded-lg border border-neutral-800 bg-black/80 p-3 backdrop-blur-sm">
      <CarChips cars={cars} selectedCarId={selectedCarId} onSelectCar={onSelectCar} />
      <Schematic
        lot={lot}
        floor={floor}
        floorLabel={FLOOR_LABEL[floor] ?? String(floor)}
        car={selected}
      />
      <Readout car={selected} />
    </div>
  );
});

function CarChips({
  cars,
  selectedCarId,
  onSelectCar,
}: {
  cars: RoutePanelCar[];
  selectedCarId: string | null;
  onSelectCar: (id: string | null) => void;
}) {
  if (cars.length === 0) {
    return <div className="mb-2 text-[11px] text-neutral-500">No active cars</div>;
  }
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {cars.map((car) => {
        const active = car.carId === selectedCarId;
        return (
          <button
            key={car.carId}
            type="button"
            onClick={() => onSelectCar(active ? null : car.carId)}
            className={
              "flex items-center gap-1.5 rounded border px-1.5 py-0.5 text-[11px] font-medium tabular-nums transition-colors " +
              (active
                ? "border-white/40 bg-white/15 text-white"
                : "border-neutral-700 text-neutral-300 hover:border-neutral-500 hover:text-white")
            }
          >
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: car.color }} />
            <span>{car.plate}</span>
            <span className="text-neutral-500">·</span>
            <span className="text-neutral-400">{destinationName(car)}</span>
          </button>
        );
      })}
    </div>
  );
}

function Schematic({
  lot,
  floor,
  floorLabel,
  car,
}: {
  lot: LotData;
  floor: number;
  floorLabel: string;
  car: RoutePanelCar | null;
}) {
  const base = useMemo(() => {
    const nodeIds = Object.keys(lot.nodes).filter((id) => lot.nodes[id]?.floor === floor);
    const nodes = nodeIds.map((id) => lot.nodes[id]);
    const project = makeProjection(nodes);
    const seen = new Set<string>();
    const edges: JSX.Element[] = [];

    for (const id of nodeIds) {
      const from = lot.nodes[id];
      for (const edge of lot.edges[id] ?? []) {
        const to = lot.nodes[edge.to];
        if (!to || to.floor !== floor) continue;
        const key = id < edge.to ? `${id}|${edge.to}` : `${edge.to}|${id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const [x1, y1] = project(from.x, from.y);
        const [x2, y2] = project(to.x, to.y);
        edges.push(
          <line key={key} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#4b5566" strokeWidth={1.1} />,
        );
      }
    }

    const circles = nodeIds.map((id) => {
      const node = lot.nodes[id];
      const [x, y] = project(node.x, node.y);
      const style = NODE_STYLE[node.type];
      return <circle key={id} cx={x} cy={y} r={style.r} fill={style.fill} opacity={style.opacity} />;
    });
    return { project, edges, circles };
  }, [lot, floor]);

  const routeElements: JSX.Element[] = [];
  let continuesElsewhere = false;
  if (car && car.path.length > 0) {
    const points: [number, number][] = [];
    for (const id of car.path) {
      const node = lot.nodes[id];
      if (!node) continue;
      if (node.floor !== floor) {
        continuesElsewhere = true;
        break;
      }
      points.push(base.project(node.x, node.y));
    }

    if (points.length >= 2) {
      const serialized = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
      routeElements.push(
        <polyline
          key="route-casing"
          points={serialized}
          fill="none"
          stroke="#09090b"
          strokeWidth={5.2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />,
        <polyline
          key="route"
          points={serialized}
          fill="none"
          stroke={car.color}
          strokeWidth={2.6}
          strokeLinejoin="round"
          strokeLinecap="round"
        />,
      );
    }

    if (points.length > 0) {
      const [x, y] = points[0];
      routeElements.push(
        <circle key="current" cx={x} cy={y} r={3.2} fill={car.color} stroke="#000" strokeWidth={0.6} />,
      );
    }

    const destinationId = car.path.at(-1);
    const destination = destinationId ? lot.nodes[destinationId] : undefined;
    if (destination?.floor === floor && points.length > 0) {
      const [x, y] = points.at(-1)!;
      routeElements.push(
        <g key="destination">
          <circle cx={x} cy={y} r={4} fill="none" stroke={car.color} strokeWidth={1.2} />
          <circle cx={x} cy={y} r={1.2} fill={car.color} />
        </g>,
      );
    }
  }

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="block w-full rounded border border-neutral-800 bg-[#08090c]"
        shapeRendering="geometricPrecision"
      >
        {base.edges}
        {base.circles}
        {routeElements}
      </svg>
      <div className="pointer-events-none absolute left-2 top-1.5 text-[11px] font-semibold tracking-[0.18em] text-neutral-400">
        FLOOR {floorLabel}
      </div>
      {continuesElsewhere && (
        <div className="pointer-events-none absolute bottom-1.5 left-2 text-[10px] text-neutral-400">
          Route continues on another floor
        </div>
      )}
    </div>
  );
}

function Readout({ car }: { car: RoutePanelCar | null }) {
  if (!car) {
    return <div className="mt-2 text-[11px] text-neutral-500">Select a car to see its route</div>;
  }
  return (
    <div className="mt-2 flex items-center justify-between gap-3 text-[11px]">
      <span className="text-neutral-400">
        {car.destinationType === "exit" ? "Destination" : "Bay"}{" "}
        <span className="font-semibold text-neutral-100">{destinationName(car)}</span>
      </span>
      <span className="text-right text-neutral-400">
        <span className="font-semibold tabular-nums text-neutral-100">
          {car.routeDistance.toFixed(1)}
        </span>{" "}
        units · ~{car.estimatedSeconds.toFixed(1)}s
      </span>
    </div>
  );
}

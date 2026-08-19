import { memo, useMemo, type JSX } from "react";
import type { LotData, LotNode, NodeType } from "../types";

/** One car's view-model for the route panel. `color` is already a hex string. */
export interface RoutePanelCar {
  carId: string;
  plate: string;
  color: string;
  slot: string | null;
  path: string[];
  /** Floor the car is on right now. */
  floor: number;
}

const VIEW_W = 360;
const VIEW_H = 232;
const MARGIN = 10;

const FLOOR_LABEL = ["A", "B", "C"];

/** Node id to the label painted on the floor and shown on every board:
 *  "S0_4" -> "A4". Anything that is not a bay (the exit, say) is passed
 *  through unchanged so it still reads sensibly. */
function bayLabel(id: string | null): string {
  if (!id) return "no bay";
  const m = id.match(/^S(\d+)_(\d+)$/);
  return m ? `${String.fromCharCode(65 + Number(m[1]))}${m[2]}` : id;
}

/** Radius and opacity per node type, tuned so 160 bays per floor do not
 *  overwhelm the schematic. Bays are tiny and dim; structure nodes are
 *  larger and brighter. */
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

/** Linear fit from lot (x, y) to SVG coordinates. Uses a uniform scale so
 *  the garage keeps its real proportions, centered in the viewBox. */
function makeProjection(nodesOnFloor: LotNode[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodesOnFloor) {
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x > maxX) maxX = n.x;
    if (n.y > maxY) maxY = n.y;
  }
  const spanX = Math.max(maxX - minX, 1);
  const spanY = Math.max(maxY - minY, 1);
  const scale = Math.min((VIEW_W - 2 * MARGIN) / spanX, (VIEW_H - 2 * MARGIN) / spanY);
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
  if (!lot || !lot.nodes || Object.keys(lot.nodes).length === 0) return null;

  const selectedCar = selectedCarId
    ? cars.find((c) => c.carId === selectedCarId) ?? null
    : null;
  const floor = selectedCar ? selectedCar.floor : 0;
  const floorLabel = FLOOR_LABEL[floor] ?? String(floor);

  return (
    <div className="pointer-events-auto absolute bottom-14 left-4 w-[360px] rounded-lg border border-neutral-800 bg-black/80 p-3 backdrop-blur-sm">
      <CarChips
        cars={cars}
        selectedCarId={selectedCarId}
        onSelectCar={onSelectCar}
      />
      <Schematic lot={lot} floor={floor} floorLabel={floorLabel} car={selectedCar} />
      <Readout car={selectedCar} />
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
      {cars.map((c) => {
        const active = c.carId === selectedCarId;
        return (
          <button
            key={c.carId}
            type="button"
            onClick={() => onSelectCar(active ? null : c.carId)}
            className={
              "flex items-center gap-1.5 rounded border px-1.5 py-0.5 text-[11px] font-medium tabular-nums transition-colors " +
              (active
                ? "border-white/40 bg-white/15 text-white"
                : "border-neutral-700 text-neutral-300 hover:border-neutral-500 hover:text-white")
            }
          >
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: c.color }}
            />
            <span>{c.plate}</span>
            <span className="text-neutral-500">·</span>
            <span className="text-neutral-400">{bayLabel(c.slot)}</span>
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
  // Base graph (edges + nodes) for this floor. Memoised on lot + floor so
  // only the highlighted route re-renders on a sim tick.
  const base = useMemo(() => {
    const nodeIdsOnFloor: string[] = [];
    const nodesOnFloor: LotNode[] = [];
    for (const id of Object.keys(lot.nodes)) {
      const n = lot.nodes[id];
      if (n && n.floor === floor) {
        nodeIdsOnFloor.push(id);
        nodesOnFloor.push(n);
      }
    }
    const project = makeProjection(nodesOnFloor);

    const edgeEls: JSX.Element[] = [];
    const seen = new Set<string>();
    for (const id of nodeIdsOnFloor) {
      const outs = lot.edges[id];
      if (!outs) continue;
      const a = lot.nodes[id];
      for (const e of outs) {
        const b = lot.nodes[e.to];
        if (!b || b.floor !== floor) continue;
        // Undirected dedupe so each segment draws once.
        const key = id < e.to ? `${id}|${e.to}` : `${e.to}|${id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const [ax, ay] = project(a.x, a.y);
        const [bx, by] = project(b.x, b.y);
        edgeEls.push(
          <line
            key={key}
            x1={ax} y1={ay} x2={bx} y2={by}
            stroke="#4b5566" strokeWidth={1.1}
          />
        );
      }
    }

    const nodeEls: JSX.Element[] = nodeIdsOnFloor.map((id) => {
      const n = lot.nodes[id];
      const [x, y] = project(n.x, n.y);
      const s = NODE_STYLE[n.type];
      return (
        <circle
          key={id}
          cx={x} cy={y} r={s.r}
          fill={s.fill} opacity={s.opacity}
        />
      );
    });

    return { project, nodeIdsOnFloor, edgeEls, nodeEls };
  }, [lot, floor]);

  // Highlighted route for the selected car. Recomputed each render (cheap:
  // a handful of segments), so a sim tick only touches this layer.
  const routeEls: JSX.Element[] = [];
  let continuesElsewhere = false;
  if (car && car.path.length > 0) {
    const { project } = base;
    const pts: [number, number][] = [];
    for (const id of car.path) {
      const n = lot.nodes[id];
      if (!n) continue;
      if (n.floor !== floor) {
        continuesElsewhere = true;
        // Stop the polyline at the first node that leaves this floor; the
        // rest is described in text instead of drawn.
        break;
      }
      pts.push(project(n.x, n.y));
    }
    if (pts.length >= 2) {
      routeEls.push(
        <polyline
          key="route"
          points={pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")}
          fill="none"
          stroke={car.color}
          strokeWidth={1.8}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      );
    }
    // Current position marker (path[0]) if it is on this floor.
    if (pts.length > 0) {
      const [cx, cy] = pts[0];
      routeEls.push(
        <circle key="cur" cx={cx} cy={cy} r={3.2} fill={car.color} stroke="#000" strokeWidth={0.6} />
      );
    }
    // Destination marker (last path element) if it is on this floor.
    const lastId = car.path[car.path.length - 1];
    const lastNode = lastId ? lot.nodes[lastId] : undefined;
    if (lastNode && lastNode.floor === floor && pts.length > 0) {
      const last = pts[pts.length - 1];
      routeEls.push(
        <g key="dest">
          <circle cx={last[0]} cy={last[1]} r={4} fill="none" stroke={car.color} strokeWidth={1.2} />
          <circle cx={last[0]} cy={last[1]} r={1.2} fill={car.color} />
        </g>
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
        {base.edgeEls}
        {base.nodeEls}
        {routeEls}
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
    return (
      <div className="mt-2 text-[11px] text-neutral-500">
        Select a car to see its route
      </div>
    );
  }
  const hops = Math.max(car.path.length - 1, 0);
  return (
    <div className="mt-2 flex items-center justify-between text-[11px]">
      <span className="text-neutral-400">
        Bay <span className="font-semibold text-neutral-100">{bayLabel(car.slot)}</span>
      </span>
      <span className="text-neutral-400">
        <span className="font-semibold tabular-nums text-neutral-100">{hops}</span> {hops === 1 ? "hop" : "hops"} left
      </span>
    </div>
  );
}

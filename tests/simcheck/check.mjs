/**
 * ParCoar movement gate.
 *
 * Drives the running simulator in a real browser, watches every car for a
 * while, and fails if any of the movement invariants below is broken. Run it
 * after touching anything that moves a car: the queueing rules, the path
 * resolution, the curve generators, or the backend graph.
 *
 *   node tests/simcheck/check.mjs [url] [seconds]
 *
 * SIMCHECK_DURATION_MS sets the soak length in milliseconds without needing
 * the positional argument (CI uses it for a shorter run than a human would
 * sit through); the positional seconds still override it.
 *
 * Exit code 0 means every invariant held. Non-zero means at least one broke,
 * and the offending samples are printed.
 *
 * A note on thresholds, because getting one wrong hid a real bug for days.
 * The first version of this only reported a car as stuck after it had been
 * motionless for FIVE seconds. The actual defect — cars halting under the
 * overhead boards — produced halts of up to 3.4 seconds, so the check
 * reported a clean garage for ten minutes straight while the bug was fully
 * present and plainly visible on screen. A threshold set above the failure
 * magnitude is not a test. MAX_PAUSE_MS is deliberately just above normal
 * following behaviour, not above "obviously broken".
 */
import { chromium } from "playwright";

const URL = process.argv[2] ?? "http://localhost:5180/";
/** Soak length. SIMCHECK_DURATION_MS replaces the 180s default; a garbage or
 *  zero value falls back to the default rather than sampling for NaN ms. */
const ENV_MS = Number(process.env.SIMCHECK_DURATION_MS ?? 180000);
const SECONDS = Number(process.argv[3] ?? (Number.isFinite(ENV_MS) && ENV_MS > 0 ? ENV_MS / 1000 : 180));

/* --- Invariants ---------------------------------------------------- */

/** Longest a car may sit still WITH CLEAR ROAD AHEAD. Waiting behind another
 *  car is ordinary traffic and is not a failure however long it lasts; what a
 *  viewer calls a bug is a car stopping with nothing in front of it. The
 *  check below only counts a pause against you when no other car occupied
 *  either of the next two nodes on its route at any point during the wait.
 *  Normal following and the websocket handshake both settle inside a second. */
const MAX_PAUSE_MS = 1500;
/* Two cars are interpenetrating when they are close along BOTH axes of one of
 * them, which is not the same thing as their centres being close: opposing
 * lanes sit 3.5 apart and pass each other safely all day. A single
 * centre-to-centre threshold cannot express that, so this projects the offset
 * onto each car's own axes and uses the real body sizes, which differ by car.
 *
 * Mirrors CAR_DIMS in frontend/src/sim/constants.ts. */
const BODY = {
  small: { length: 3.4, width: 1.55 },
  medium: { length: 4.1, width: 1.68 },
  large: { length: 4.5, width: 1.8 },
};
/** How much bumper overlap to tolerate before calling it a collision. Models
 *  are boxes and the real bodies are rounded, so a few centimetres of box
 *  intersection is not visible. */
const OVERLAP_TOLERANCE = 0.35;
/** Top speed is 7 units/s. Anything this fast over a real distance is a jump,
 *  not driving. Both conditions are needed: two animation frames a couple of
 *  milliseconds apart give a huge apparent speed off a 7cm step. */
const MAX_SPEED = 25;
const MIN_JUMP_DISTANCE = 1.0;
/** A car may not climb or drop this much between frames. */
const MAX_VERTICAL_STEP = 1.5;
/** Every car on the road should pass at least one guidance board, or the
 *  garage is not demonstrating anything. */
const MIN_CARS_WITH_GUIDANCE_FRACTION = 0.9;
/** Vacuous-pass guard. Car detection depends on /wheel/i still matching a mesh
 *  inside every car group. If that ever stops matching, every frame comes back
 *  empty and all of the physical checks pass without having looked at a single
 *  car — the same "clean garage, bug fully present" lie the pause threshold
 *  once told. The sim state publishes independently of the scene graph, so it
 *  can witness whether cars actually existed: when the sim says the road was
 *  busy for most of the run and the sampler saw poses in fewer than this
 *  fraction of frames, the gate was blind and must say so. */
const MIN_FRAMES_WITH_CARS_FRACTION = 0.2;

const browser = await chromium.launch({
  headless: true,
  args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message.slice(0, 200)));

await page.goto(URL, { waitUntil: "load" });
await page.waitForFunction(() => window.__parcoarSim && window.__parcoarScene, { timeout: 30000 });
const lot = await page.evaluate(async () => (await fetch("/lot.json")).json());
await page.waitForTimeout(4000);

// Two samplers. The scene graph one catches physical problems (overlap,
// jumps); the sim-state one catches decision problems (pauses, routing).
await page.evaluate((secs) => {
  window.__frames = [];
  window.__states = [];
  const scene = window.__parcoarScene;
  const isCar = (o) => {
    if (!o.isGroup || o.parent !== scene) return false;
    let hit = false;
    o.traverse((c) => { if (c.isMesh && /wheel/i.test(c.name)) hit = true; });
    return hit;
  };
  const tick = () => {
    const frame = [];
    for (const child of scene.children) {
      if (!isCar(child)) continue;
      frame.push({
        id: child.name || child.uuid.slice(0, 8),
        x: child.position.x, y: child.position.y, z: child.position.z,
        yaw: child.rotation.y,
      });
    }
    window.__frames.push({ t: performance.now(), frame });
    window.__raf = requestAnimationFrame(tick);
  };
  tick();
  window.__stateId = setInterval(() => {
    const s = window.__parcoarSim;
    if (s) window.__states.push({ t: Date.now(), cars: JSON.parse(JSON.stringify(s.cars)), signs: s.signs.map((x) => ({ id: x.id, path: x.path })) });
    // The page refreshes __parcoarSim every 50ms. Sample at that rate and no
    // faster: sampling more often than the source updates only invents
    // duplicate readings, and every measured duration comes out a multiple of
    // the publish interval regardless.
  }, 50);
  setTimeout(() => { cancelAnimationFrame(window.__raf); clearInterval(window.__stateId); }, secs * 1000);
}, SECONDS);

await page.waitForTimeout(SECONDS * 1000 + 1500);
const { frames, states } = await page.evaluate(() => ({ frames: window.__frames, states: window.__states }));
await browser.close();

/* --- Analysis ------------------------------------------------------- */

const failures = [];
const note = (name, detail) => failures.push({ name, detail });

// Blind-run guard. The scene graph and the sim state come from different code
// paths, so one going quiet does not mean the other did. A run with no frames
// at all checked nothing; a run where the sim kept reporting cars but the
// frames stayed empty means the /wheel/i matcher no longer finds the car
// meshes, and every physical check below would pass without seeing anything.
if (frames.length === 0) {
  note("no frames were captured", "the scene sampler never ran; nothing physical was checked");
} else {
  const withCars = frames.filter((f) => f.frame.length > 0).length;
  const activeStates = states.filter((s) => s.cars.length > 0).length;
  const simBusy = states.length > 0 && activeStates / states.length > 0.5;
  if (simBusy && withCars / frames.length < MIN_FRAMES_WITH_CARS_FRACTION) {
    note("the sampler saw no car poses while the sim reported active cars",
      `${withCars}/${frames.length} frames had any pose across ` +
      `${activeStates}/${states.length} car-occupied state samples; ` +
      "no mesh in any car group matches /wheel/i anymore, most likely a rename");
  }
}

// Physical: per-car motion between frames.
const byCar = new Map();
for (const { t, frame } of frames) {
  for (const c of frame) {
    if (!byCar.has(c.id)) byCar.set(c.id, []);
    byCar.get(c.id).push({ t, ...c });
  }
}
const jumps = [];
const verticals = [];
const reversals = [];
for (const [id, pts] of byCar) {
  let reverseRun = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const dt = (b.t - a.t) / 1000;
    if (dt <= 0 || dt > 0.2) continue;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const dist = Math.hypot(dx, dz);
    if (dist / dt > MAX_SPEED && dist > MIN_JUMP_DISTANCE) {
      jumps.push({ id, dist: +dist.toFixed(2), at: [+b.x.toFixed(1), +b.z.toFixed(1)] });
    }
    if (Math.abs(b.y - a.y) > MAX_VERTICAL_STEP) {
      verticals.push({ id, dy: +(b.y - a.y).toFixed(2) });
    }
    if (dist > 0.01) {
      const along = (dx * Math.cos(b.yaw) + dz * -Math.sin(b.yaw)) / dist;
      reverseRun = along < -0.5 ? reverseRun + 1 : 0;
      if (reverseRun === 12) reversals.push({ id, at: [+b.x.toFixed(1), +b.z.toFixed(1)] });
    }
  }
}

// Which size is each car? The scene groups are named after their car id, and
// the sim state carries the size, so the two join up without guessing.
const carSize = new Map();
for (const { cars } of states) for (const c of cars) if (c.size) carSize.set(c.id, c.size);

// Physical: two car bodies occupying the same space.
//
// Project the vector between the two centres onto one car's own heading and
// onto the axis across it. If both fall inside the body, the other car is
// inside this one. Checked both ways round, so a car being T-boned counts as
// well as one being rear-ended.
const overlaps = [];
const seenPair = new Set();
const sizeOf = (id) => BODY[carSize.get(id) ?? "large"];
const insideBody = (a, b) => {
  const A = sizeOf(a.id);
  const B = sizeOf(b.id);
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const fx = Math.cos(a.yaw);
  const fz = -Math.sin(a.yaw);
  const along = Math.abs(dx * fx + dz * fz);
  const across = Math.abs(dx * -fz + dz * fx);
  return (
    along < (A.length + B.length) / 2 - OVERLAP_TOLERANCE &&
    across < (A.width + B.width) / 2 - OVERLAP_TOLERANCE
  );
};
for (const { frame } of frames) {
  for (let i = 0; i < frame.length; i++) {
    for (let j = i + 1; j < frame.length; j++) {
      const a = frame[i];
      const b = frame[j];
      if (Math.abs(a.y - b.y) > 2) continue;
      if (!insideBody(a, b) && !insideBody(b, a)) continue;
      const key = [a.id, b.id].sort().join("|");
      if (seenPair.has(key)) continue;
      seenPair.add(key);
      overlaps.push({
        pair: key,
        gap: +Math.hypot(a.x - b.x, a.z - b.z).toFixed(2),
        at: [+a.x.toFixed(1), +a.z.toFixed(1)],
      });
    }
  }
}

// Decisions: how long each car sat still, where, and whether anything was
// actually in front of it.
const held = new Map();
const pauses = [];
for (const { t, cars, signs } of states) {
  for (const c of cars) {
    const prev = held.get(c.id);
    const still = c.from === c.to;
    const isNew = !prev || prev.node !== c.from || prev.still !== still;
    if (isNew) {
      if (prev && prev.still) {
        pauses.push({ id: c.id, node: prev.node, ms: t - prev.since, blocked: prev.blocked });
      }
      held.set(c.id, { node: c.from, still, since: t, blocked: false });
    }
    if (!still) continue;
    // Was anything occupying the road immediately ahead at this instant?
    const entry = held.get(c.id);
    if (entry.blocked) continue;
    const route = signs.find((x) => x.id === c.id)?.path ?? [];
    const ahead = route.slice(1, 3);
    entry.blocked = cars.some(
      (o) => o.id !== c.id && (ahead.includes(o.from) || ahead.includes(o.toNode ?? o.to)),
    );
  }
  for (const id of [...held.keys()]) if (!cars.some((c) => c.id === id)) held.delete(id);
}
/** Only pauses with clear road ahead count as failures. */
const longPauses = pauses.filter((p) => p.ms > MAX_PAUSE_MS && !p.blocked);
const queuedPauses = pauses.filter((p) => p.ms > MAX_PAUSE_MS && p.blocked);

// Decisions: routing stability and guidance coverage.
const boardNodes = new Set(
  Object.entries(lot.nodes)
    .filter(([, n]) => n.type === "turn" || n.type === "ramp_up")
    .map(([id]) => id),
);
const slotsPerCar = new Map();
const carsSeen = new Set();
const carsWithGuidance = new Set();
for (const { cars, signs } of states) {
  for (const c of cars) {
    carsSeen.add(c.id);
    if (c.slot && !c.leaving) {
      if (!slotsPerCar.has(c.id)) slotsPerCar.set(c.id, new Set());
      slotsPerCar.get(c.id).add(c.slot);
    }
  }
  for (const s of signs) {
    if ((s.path ?? []).some((n) => boardNodes.has(n))) carsWithGuidance.add(s.id);
  }
}
const reTargeted = [...slotsPerCar].filter(([, set]) => set.size > 1).map(([id]) => id);
const guidanceFraction = carsSeen.size ? carsWithGuidance.size / carsSeen.size : 1;

if (longPauses.length) {
  const worst = longPauses.reduce((a, b) => (a.ms > b.ms ? a : b));
  note(`cars stopped longer than ${MAX_PAUSE_MS}ms with clear road ahead`,
    `${longPauses.length} times, worst ${worst.ms}ms at ${worst.node}` +
    (boardNodes.has(worst.node) ? " (a guidance board node)" : ""));
}
if (overlaps.length) note("car bodies overlapped", `${overlaps.length} pairs, closest centres ${Math.min(...overlaps.map((o) => o.gap))}`);
if (jumps.length) note("cars jumped", `${jumps.length} times, furthest ${Math.max(...jumps.map((j) => j.dist))}`);
if (verticals.length) note("cars changed height abruptly", `${verticals.length} times`);
if (reversals.length) note("cars drove backwards on the road", `${reversals.length} times`);
if (reTargeted.length) note("cars were re-assigned a bay mid-journey", reTargeted.join(", "));
if (guidanceFraction < MIN_CARS_WITH_GUIDANCE_FRACTION) {
  note("cars never passed a guidance board",
    `only ${(guidanceFraction * 100).toFixed(0)}% of ${carsSeen.size} cars had one on their route`);
}
if (pageErrors.length) note("the page threw errors", pageErrors.slice(0, 3).join(" | "));

const pauseMs = pauses.map((p) => p.ms).sort((a, b) => a - b);
console.log(JSON.stringify({
  url: URL,
  seconds: SECONDS,
  carsSeen: carsSeen.size,
  frames: frames.length,
  framesWithCarPoses: frames.filter((f) => f.frame.length > 0).length,
  longestPauseMs: pauseMs.length ? pauseMs[pauseMs.length - 1] : 0,
  medianPauseMs: pauseMs.length ? pauseMs[Math.floor(pauseMs.length / 2)] : 0,
  pausesOverThresholdWithClearRoad: longPauses.length,
  pausesOverThresholdQueuedBehindAnother: queuedPauses.length,
  overlappingPairs: overlaps.length,
  carsWithGuidancePercent: +(guidanceFraction * 100).toFixed(0),
}, null, 2));

if (failures.length === 0) {
  console.log("\nPASS — every movement invariant held.");
  process.exit(0);
}
console.log("\nFAIL");
for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
if (longPauses.length) {
  console.log("\n  longest pauses:");
  for (const p of longPauses.sort((a, b) => b.ms - a.ms).slice(0, 8)) {
    console.log(`    ${p.id} ${p.ms}ms at ${p.node}${boardNodes.has(p.node) ? "  [board]" : ""}`);
  }
}
process.exit(1);

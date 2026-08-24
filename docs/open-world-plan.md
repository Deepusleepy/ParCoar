# ParCoar Open-World Plan

> The consolidated vision, architecture, and build plan for pivoting ParCoar from a parking guidance simulator into a GTA-style pure-freeroam open-world driving game set in a Shibuya-inspired region of Tokyo.
>
> Synthesized from 12 sub-agent assessments across 3 rounds covering world design, gameplay, visuals, audio, UI/UX, creative features, and critical technical review.

---

## 1. Vision

### Elevator pitch

ParCoar is a GTA-style pure-freeroam driving game set across a Shibuya-style city district and a quiet Japanese town, split by a river with Mt. Fuji on the horizon. Drive anywhere, any time, under a day/night cycle that is the living spine of the world. Your home base is a multi-storey parking garage with a real AI guidance system. An F1-style track sits on the town outskirts. No missions, no objectives — the driving, the world, and the atmosphere are the game.

### Design philosophy

- **Pure freeroam.** No missions, no objectives, no progression. The player drives where they want, when they want. Think GTA V freeroam, Forza Horizon freeroam, Burnout Paradise's open world.
- **Atmosphere is load-bearing.** The world is 80% atmosphere by volume. Day/night, weather, audio, neon, the crossing chirp, the train pass-by — these are not polish, they are the product.
- **The driving is the game.** With no missions, the act of driving must feel exceptional. Driving feel is the single most important thing to get right.
- **The world remembers you.** The ghost commute feature — recording your driving lines and replaying them — makes the freeroam feel personal. The world is not a diorama; it's a place you live in.
- **Parametric first, heroes second.** Buildings, roads, street furniture are generated in code. 2-3 Blender hero assets (torii gate, a hero tower, maybe a distinctive bridge) provide visual anchors.

### What it is NOT

- Not a racing game (the track is a drivable structure, not a competitive system — for now).
- Not a mission game (no delivery, no taxi, no story).
- Not a car collectathon (no progression, no unlocks — all cars available from the start).
- Not a tech demo (the interest hooks — discoverables, photo mode, physics toys, ghost commute — prevent the 20-minute drop-off).

---

## 2. World Design

### 2.1 Geography

The world is a region split by a river running roughly east-west:

```
                    Mt. Fuji (billboard, far north of town)
                    ~~~~~~~~~~~~
                    [rice paddies]
                    [town outskirts]
   ┌─────────────────────────────────────────────────┐
   │  TOWN SIDE              │  CITY SIDE            │
   │  (quiet, residential,   │  (Shibuya-style,      │
   │   pitched roofs,        │   dense towers, neon, │
   │   shrine, JR station,   │   Scramble Crossing,  │
   │   race track on outskirts)│  garage as home base)│
   │                         │                       │
   │         BRIDGE 1        │                       │
   │  ──────modern────────── ┼ ──────────────────    │
   │         BRIDGE 2        │                       │
   │  ──────old truss────────┼ ──────────────────    │
   │                         │                       │
   └─────────────────────────────────────────────────┘
                  RIVER (reflective water)
```

- **City side (south):** A Shibuya-style district. Dense, vertical, electric. The existing parking garage is embedded in a building here as the player's home base and spawn point. The Scramble Crossing is the landmark intersection. Towers line the main streets, side streets have low-rise shop facades.
- **Town side (north):** A quieter Japanese town. Low, horizontal, residential-commercial mix. Pitched roofs, a JR-style train station with a level crossing, a shrine on a hill with a torii gate and a viewpoint back across the river to the neon city. Rice paddies on the outskirts toward Fuji. The F1 race track sits on the town outskirts.
- **The river:** Runs between the two sides. Reflective water plane (neon reflections at night). Two contrasting bridges: a modern urban bridge (concrete, LED railings) on the city side, an older steel truss bridge (warm sodium lights) into the town. Stepped concrete embankments on the city side, grassy banks on the town side.
- **Mt. Fuji:** A billboard/skybox element on the town side, visible over the rice paddies. Time-of-day snow-cap glow (pink-orange at sunset, near-black silhouette at night). A lenticular cap cloud. Small on the horizon — powerful because of symmetry, not size.
- **Transition zone:** A tunnel on the road between city and town (hides district pop-in, headlight moment at night). A riverside expressway ramp. A gradient of building density (towers step down to town houses along the approach).

### 2.2 Zone identities

#### City district (Shibuya-style)

**Mood:** Dense, vertical, electric, slightly oppressive in a thrilling way. The eye is pulled up — towers fill the frame, signs crowd every surface, the sky is a narrow strip between rooftops.

**Color palette:**
- Base concrete: cool neutral grey, slightly blue-cast (`#9aa0a8` to `#b8bdc4`)
- Neon accent set: cyan `#00e5ff`, magenta `#ff2d95`, warm white `#ffd28a`, red `#ff3b3b`, green `#39ff14` — assign 2-3 dominant hues per block so blocks have personality
- Streets: dark warm-grey asphalt (`#2a2622`), not pure black

**Lighting:**
- Day: hard directional sun, deep blue sky, strong canyon shadow contrast between towers
- Night: the city becomes the light source. Tower windows glow warm (`#ffcf8a`), neon dominates, sky goes deep navy `#0a1026` with orange sodium glow band at horizon

**Building style (parametric):**
- Slab towers with repetitive window grids (one texture/instanced panel, varied by height/footprint/tint)
- A few feature towers with full-glass curtain walls (high metalness, low roughness, reflecting the sky)
- 1-2 story podiums with shop fronts at street level (the Tokyo tower-on-podium form)
- Utility rooftop clutter: water tanks, AC units, antenna masts (cheap boxes, huge readability)

**What makes it readable:** verticality + neon + warm window glow + overhead utility wires

#### Town

**Mood:** Horizontal, low, quiet, residential-commercial mix. The eye stays at street level. Slower, warmer, more human-scaled. Think Setagaya/Kichijoji, not Ginza.

**Color palette:**
- Base: warmer, earthier. Rendered walls in cream/sage/terracotta (`#d8c9a8`, `#c2b89e`, `#b8a888`)
- Tile roofs in dark grey-blue (`#3a4252`)
- Accent: muted. Warm sodium streetlight `#ffb066`, soft shop signage. Almost no saturated neon. A single konbini sign is the loudest thing on the street — and that contrast is the point.

**Building style:**
- 2-3 story pitched-roof houses (the key differentiator from the city — a gable/hip roof prism variant)
- Low commercial strips with roll-down shutters
- Gaps between buildings (the city is wall-to-wall; the town has side yards, hedges, low walls — this negative space is a zone signal)
- Narrower roads, no lane markings, gutters on both sides

**What makes it readable:** low rise + pitched roofs + warm muted tones + greenery + the near-absence of neon. The contrast with the city across the river does half the work.

#### The river as seam

From the town you see the city as a glowing wall across the water. From the city you see the town as a quiet dark band. Bridges (lit at night) are the transition moments. This is the single most powerful "two different places" device — both banks must be visible from the other.

### 2.3 Landmarks & destinations

Ranked by coolness-per-effort (from sub-agent assessments):

#### Tier 1 — Essential destinations

| Landmark | Side | Description | Effort |
|----------|------|-------------|--------|
| **Parking garage (home base)** | City | The existing 3-floor, 480-bay garage embedded in a building. Player spawn point. Transparent-reveal mode showing the guidance system inside. Rooftop deck as a panoramic viewpoint (geometry already exists). | Exists |
| **Scramble Crossing** | City | The Shibuya landmark. Diagonal crosswalk markings. Traffic signal cycle. Instanced capsule pedestrians flood the crossing on the signal cycle. The crossing chirp audio. | Medium |
| **Rooftop vista** | City | The garage's open top deck (floor 2). Drive up the ramp for a panoramic view of the whole world — towers, river, Fuji. Add a railing + rooftop lights. First destination / tutorial viewpoint. | Trivial |
| **Hilltop overlook** | Town | A winding road climbs a low hill behind the town. At the top: a parking pull-off, a torii gate silhouette, and a clear sightline back across the river to the neon city. Pairs with the shrine. Best at dusk. | Low-medium |
| **Mt. Fuji viewpoint** | Town | A specific spot where Fuji is framed over the rice paddies. The golden-hour photo spot. | Trivial (it's a location, not geometry) |

#### Tier 2 — Japan authenticity (cheap, high payoff)

| Element | Description | Effort |
|---------|-------------|--------|
| **Vending machines** | The single highest Japan-signal per polygon. Glowing box with two emissive panels. Scatter 8-10 on city streets. At night they become pools of light. Instanced. | Very low |
| **Overhead utility wires + poles** | The visual marker that separates "generic city" from "Japanese city." Catenary wires between poles using the existing `meshline` dependency. | Low |
| **Konbini (convenience store)** | Ground-floor retail unit with fully glazed front, bright white interior light, striped awning. Night beacon. Building variant. | Low |
| **Covered shotengai arcade** | Narrow street with glass-and-steel barrel-vault canopy, lined with shop fronts (emissive signage panels). Great shadow/light play. | Low-medium |
| **Pachinko parlor facade** | Dense wall of small colored lights — instanced emissive dots on a facade. Loud, unmistakably Japan. | Low |
| **Elevated pedestrian walkways** | Box bridges on stilts crossing over streets. Vertical layering, great framing for driving shots. | Low |
| **Manhole covers** | Dark circle with subtle colored pattern on the road. Tiny detail, huge "this is Japan" signal. | Very low |
| **Traffic signal heads** | Japanese-style signal heads (yellow-ish housing, horizontal triple-light) on far-side poles. | Low |

#### Tier 3 — Town-specific landmarks

| Element | Description | Effort |
|---------|-------------|--------|
| **JR-style train station** | Small elevated platform, station building with gable roof. The level crossing is a driving event — barriers drop when the train passes. | Medium |
| **Small shrine** | A clearing with a vermilion torii gate, stone lanterns, wooded backdrop. Pairs with the hilltop overlook. Torii is a candidate Blender hero asset. | Low-medium |
| **Rice paddy strips** | Flat textured planes in green/gold strips with low earthen borders, between the town and Fuji. Frames the mountain. | Very low |
| **Race track** | F1-style circuit on the town outskirts. Closed loop with kerbs, tire walls, start/finish gantry, grandstands. Physical structure only for v1 — no timing, no AI. | Medium |

#### Tier 4 — River & bridges

| Element | Description | Effort |
|---------|-------------|--------|
| **Modern urban bridge** | City side. Concrete, blue/white LED railings at night, traffic lights, pedestrian sidewalk. | Low-medium |
| **Old steel truss bridge** | Town side. Steel truss, warm sodium lights, narrower. The contrast reinforces the two-sides theme. | Low-medium |
| **Stepped concrete embankments** | City side. Japanese urban river banks (kawara). Where the hidden under-bridge spot lives. | Low |
| **Riverfront promenade** | City side. Walkway along the bank with vending machines, benches, railing lights. | Low |
| **Hidden under-bridge spot** | Under one bridge: small concrete embankment, parked cars, vending machine glow, graffiti-style emissive panels. Not on any map — you find it by driving down to the riverbank. | Low |

#### Tier 5 — Transition zones

| Element | Description | Effort |
|---------|-------------|--------|
| **Tunnel** | A short tunnel on the road between city and town. Light cuts to black, then you emerge into the town side. Hides district pop-in. Headlight moment at night. Reuses ceiling strip pattern. | Low |
| **Riverside expressway ramp** | The transition road runs along the river for a stretch before crossing the bridge. Towers on one side, open river on the other. Cinematic. | Zero new art (road routing) |
| **Building density gradient** | Along the transition road, step the building generator down: 8-floor → 5-floor → 3-floor → 2-floor. Parameter ramp, not new art. | Zero new art |
| **Guardrail-lined sweepers** | Curved sections lined with guardrails (existing `GUARDRAIL_COLOR` constant). Reads as "highway" instantly. | Low |

### 2.4 The race track (v1: physical structure only)

A closed-loop F1-style circuit on the town outskirts. For v1, this is drivable geometry only — no lap timing, no ghost car, no racing AI. Those systems come in a later version.

**Geometry:**
- Track surface (flat ribbon, reusing `buildRibbon` from ParkingLot.tsx — no banking for v1)
- Red-and-white kerbs on the inside edges of corners (alternating striped textured geometry)
- Tire walls (instanced stacked cylinders) behind barriers at key corners
- Start/finish gantry (structural overhead element with emissive signage)
- Grandstands (dark textured mass with scattered warm emissive dots — don't model seats)
- Pit lane / paddock area with parked transport trucks (big boxes), tire stacks (instanced cylinders), a timing tower with a glowing scoreboard

**Visual identity:** Engineered and clean, in deliberate contrast to the organic messiness of the city and town. Straight lines, consistent materials, no clutter.

**Night mode:** Floodlights on poles (a few real spotlights near start/finish, fake the rest with emissive pole tops + bright track patches). Track surface goes glossy/wet-looking (lower roughness) so it reflects the floodlight pools.

---

## 3. Architecture

### 3.1 Stack overview

```
┌─────────────────────────────────────────────────┐
│  Frontend (React 19 / TypeScript / Three.js r185 / R3F 9 / Vite)  │
│                                                                   │
│  ┌─────────────┐  ┌─────────────┐  ┌───────────┐  ┌───────────┐ │
│  │  Garage      │  │  City World │  │  UI/HUD   │  │  Audio    │ │
│  │  (R3F)       │  │  (raw       │  │  (React   │  │  (Web     │ │
│  │  Python-     │  │  Three.js + │  │  overlay) │  │  Audio    │ │
│  │  linked)     │  │  R3F hybrid)│  │           │  │  API)     │ │
│  └──────┬───────┘  └──────┬──────┘  └───────────┘  └───────────┘ │
│         │                 │                                      │
│         └────────┬────────┘                                      │
│                  │  Portal transition (gate + speed-blur)        │
│                  │  Physics swap during blur window              │
│         ┌────────┴────────┐                                     │
│         │  Player Car      │  Two physics contexts:              │
│         │  (one entity,    │  - GarageContext (existing)         │
│         │   two physics)   │  - CityContext (new)                │
│         └──────────────────┘                                     │
└─────────────────────────────────────────────────┘
         │ WebSocket (shared/spec.md)
┌────────┴────────────────────────────────────────┐
│  Backend (Python)                                │
│  - server.py: Dijkstra routing, bay reservation  │
│  - generate_lot.py: 480-bay garage graph         │
│  Scoped to garage ONLY. City is frontend-only.   │
└─────────────────────────────────────────────────┘
```

### 3.2 Physics: two systems, one player car

**The critical-path refactor (Phase 0).**

`DrivableCar.tsx` (2333 lines) is welded to the garage in six independent ways:
1. Position clamping to slab bounds (lines 1913-1916) — the car cannot leave the building footprint
2. Road-edge clamping to garage-only segments (lines 2047-2178) — `roadSegmentsByFloor` only knows garage junctions
3. Height sampling is garage-only (lines 1790-1882) — flat garage floor or sampled ramp curve, no terrain
4. Node reporting scans garage graph nodes (lines 2238-2291) — no nodes outside the garage
5. Spawn is hardcoded to `ENTRY_ROAD` (line 1575)
6. Physics tuning is parking-speed (lines 71-99) — `MAX_SPEED = 9`, `ACCEL_RATE = 14`, `TURN_RATE = 3.0`

**The refactor:** Abstract the world context behind interfaces:

```typescript
interface WorldContext {
  groundHeight(x: number, z: number): number;        // terrain/street/bridge/floor
  roadCorridor(x: number, z: number): CorridorClamp; // keep car on road
  collision(x: number, z: number, r: number): CollisionResult; // AABB or capsule
  nearestNode(x: number, z: number): NodeRef | null;  // for guidance reporting
  spawnPoint(): Vec3;
  physicsProfile: PhysicsProfile;  // max speed, accel, grip, turn rate
}
```

Two implementations:
- `GarageContext` — wraps the existing slab bounds, road segments, floor height, garage graph nodes, parking-speed tuning
- `CityContext` — flat ground height, city road corridors, AABB collision against building boxes, no graph nodes, city-speed tuning

The `useFrame` loop in DrivableCar calls through the interface and doesn't know which world it's in. The active context is swapped at the portal boundary during the speed-blur window.

**City physics profile (new `CityCar.tsx`):**
- `MAX_SPEED`: 28-40 u/s (city-scale, ~100-144 km/h feel)
- Bicycle-model steering (kinematic bicycle model with front/rear axles)
- Friction-circle grip (lateral + longitudinal grip budget, not independent)
- AABB collision against building bounding boxes (cheap, no per-poly)
- Weather-multiplied grip (rain drops grip from 0.86 to ~0.72)

**Garage physics profile (existing, unchanged):**
- `MAX_SPEED = 9`, `ACCEL_RATE = 14`, `TURN_RATE = 3.0`
- Capsule collider, lateral-grip drift basis, steering fade
- Node-graph-coupled road corridors, ramp projection

**Driving-feel reference:** GTA V's arcade driving feel — responsive, forgiving, fun at speed, not a sim. The car should be easy to control but reward smooth inputs. Drift is possible but not default.

### 3.3 Portal transition (garage ↔ city)

**The transition:** Diegetic gate + 200-400ms speed-blur/FOV punch at the threshold + audio swap. No fade-to-black.

- **Leaving the garage (tight → open):** The player drives through a real gate (boom barrier lifts, sign lights up). A brief FOV widen + speed-blur as they cross the threshold. The physics swaps from GarageContext to CityContext during the blur frame window. The camera does a slight acceleration push. Audio: tire-roar change, engine-note shift (echoey concrete → open air), one-shot whoosh on the gate pass.
- **Entering the garage (open → tight):** A slight slow, the gate closes behind, the echoey reverb kicks in. Physics swaps from CityContext to GarageContext. Audio: reverb send ramps up, ambient bed shifts to enclosed.
- **Asymmetric:** The two directions are not the same animation reversed. Leaving feels like release; entering feels like arrival.
- **AI cars:** Despawn at the boundary (frustum + occlusion check so the player doesn't see them pop). Fresh AI cars spawn on the other side. No physics continuity for AI.

### 3.4 Rendering: hybrid R3F + raw Three.js

- **R3F** for the garage (existing `ParkingLot.tsx` works), UI overlays, and declarative scene elements
- **Raw Three.js** for the city world (buildings, roads, river, track) — merged geometry and InstancedMeshes for performance
- **One shared renderer**, one scene graph, one camera
- **Hybrid approach:** the city world is built imperatively (like ParkingLot's merged geometry) and added to the same scene

### 3.5 Python scope

Python stays scoped to the garage guidance AI only:
- `server.py`: Dijkstra routing, bay reservations, WebSocket protocol
- `generate_lot.py`: 480-bay garage graph generation
- The city, town, track, and all city-driving are pure frontend TypeScript
- When the player is in the city, Python may be idle (the WebSocket reconnects when the player approaches the garage)
- The frontend handles "no backend" gracefully: the garage is visually present but dormant, with a UI indicator. Pre-parked cars render (client-side). No routing, no boards, no guidance until Python connects.

### 3.6 Performance budget

The current scene is tuned for one ~100-unit building (pixel budget, shadow frustum 112×112, fog 80-220, 3 real lights, ~40-60 draw calls). The open world is 10-50× the geometry.

**Draw call targets:**
- City buildings: aggressive instancing/merging by material. Target: 50-100 draw calls for 100-200 buildings (InstancedMesh per building type per material, or merged mega-meshes by material)
- City road network: 10-20 draw calls (merged ribbons, like the garage)
- River: 1-2 draw calls (flat plane + normal map)
- Track: 10-30 draw calls
- Town: 30-80 draw calls (simpler buildings, fewer of them)
- AI traffic: instanced, 20-50 cars × 4 draw calls = 80-200 (or instanced to reduce)
- Mt. Fuji: 1 draw call (billboard)
- Total target: 300-600 draw calls (vs. 400-1500 unbatched)

**Shadow maps:** Cascaded Shadow Maps (CSM) or a large 4096² shadow map for the expanded world. The current 1024² over 112×112 units gives ~0.5m resolution over a city — everything shimmers. CSM is 3-4× the shadow render cost but necessary.

**Camera far plane:** 2000-5000 units (vs. current 500). Distance-based fog that doesn't hide the city at 220 units.

**Pixel budget:** Keep the existing DPR cap, add a quality toggle (Low/Medium/High) that adjusts shadow map size, render scale, and postprocessing.

**First thing that will jank:** Unbatched parametric buildings. If buildings are generated as individual meshes, 200 buildings × 5 materials = 1000 draw calls → 20fps on mid-range laptops. The fix is instancing/merging from day one.

### 3.7 Asset pipeline

**Current state:** 3 Quaternius CC0 car GLBs, no Blender source files, no texture pipeline, no LODs, no compression, no postprocessing.

**What's needed for 2-3 Blender hero assets:**
1. Blender source files committed to the repo (`assets/blender/`)
2. GLB export pipeline with Draco compression (build script, not manual export)
3. Day/night emissive maps (emissive node setup in Blender, runtime emissive intensity control)
4. LODs (2-3 levels per hero asset, or distance-based culling)
5. KTX2/Basis texture compression for web (build step via `gltf-transform` or `toktx`)
6. `@react-three/postprocessing` for Bloom (gated behind quality toggle)

**Hero asset candidates (2-3 max):**
1. Torii gate (for the shrine / hilltop overlook)
2. A hero Shibuya tower with baked neon signage
3. Maybe a distinctive bridge

Everything else is parametric — generated in code from layout data, matching the existing `ParkingLot.tsx` pattern.

---

## 4. Day/Night Cycle

### 4.1 The spine

The day/night cycle is the living spine of the world. Everything keys off one normalized `timeOfDay` parameter (0-1):

- Sun direction (arc across the sky)
- Sun color and intensity
- Sky gradient (top color, horizon color)
- Ambient/hemisphere intensity and color
- Fog color and density
- Window emissive intensity (per-window phase offset)
- Neon sign emissive intensity (crossfade from "barely visible" to "dominant")
- Streetlight state (staggered on/off)
- Exposure (rises slightly at night so neon doesn't clip — counterintuitive but correct)
- Audio bed swap (day → night crossfade)
- AI traffic density (rush hour multipliers)

### 4.2 The sunset sequence (the money shot)

In order, over ~30 in-game minutes:

1. **Sky gradient warms (t-30min).** Top stays blue, horizon goes: pale yellow `#ffe9b0` → orange `#ff9a4a` → pink `#ff6a8a` → deep magenta `#7a3a6a` → navy. One shader/texture, lerped by time.
2. **Tower windows ramp on (t-20min).** Office windows go from dark to warm glow on a per-window random offset (0-15 minute phase) so it doesn't switch in unison — that's the detail that sells "real place."
3. **Neon signs cross-fade (t-15min).** In daylight neon is washed out (low emissiveIntensity). As ambient drops, emissive ramps up and neon takes over. This is the moment the city changes identity.
4. **Streetlights flicker/stagger on (t-10min).** Not all at once. A wave over 2-3 seconds, with a few that flicker once before settling.
5. **Blue hour (t+10min).** Sky is deep blue, neon is fully on, city isn't fully dark — you can still see building silhouettes. The most photogenic state of the cycle.
6. **Full night.** Sky near-black with horizon glow dome, neon + windows + streetlights carry everything, fog tightens.

Sunrise is the reverse but subtler and cooler: neon fades before windows (city looks half-asleep), windows ramp down as ambient rises, streetlights cut off in a stagger.

### 4.3 Environment map

The current `RoomEnvironment` PMREM is for indoor reflections. The city needs a time-of-day sky environment (a gradient cube render or procedural shader fed to PMREM) so every reflective surface — glass, wet road, car paint, water — shows the correct sky. Get this right and 40% of the "real place" feeling appears for free.

### 4.4 Day/night as gameplay

- **Night garage aesthetic:** Lower the ambient, let the overhead boards and bay indicator lights become the primary visual language. "Neon parking garage at 2am" is a vibe people screenshot.
- **Night track:** Floodlights, lit kerbs, glossy track surface reflecting light pools. A distinct mood.
- **Traffic density shift:** Quieter town at night, busier Shibuya side at night (the reverse of day). Gives the player a reason to choose when to go where.
- **Headlights at night:** A spotlight attached to the car. Visibility = braking points. Changes the driving feel without changing geometry.
- **Night-only events:** The "midnight club" rendezvous (AI cars with neon underglow idling under a bridge at 2am). The night market (shotengai stalls light up after 8pm).

---

## 5. Weather

A weather cycle on top of the day/night cycle. States: Clear → Cloudy → Fog → Rain → (Snow, stretch/rare).

| State | Visual | Driving impact | Effort |
|-------|--------|----------------|--------|
| **Clear** | Baseline | Baseline | — |
| **Cloudy** | Lower directional intensity, warmer hemisphere tint, softer shadows | None | Low (light params) |
| **Fog** | Tighten `scene.fog` (near ~20, far ~80), blue-gray tint. River mist planes at dawn/dusk. | Reduced visibility | Very low (one line + mist planes) |
| **Rain** | Wet asphalt (roughness drops to ~0.3, sky reflection smear). Rain particles (GPU points field). Puddle reflection planes in low spots. Wipers on POV camera. | Grip drops from 0.86 to ~0.72 — car slides more, drifts initiate easier, braking distance grows. `GRIP`, `MAX_SPEED`, `FRICTION` weather-multiplied. | Medium |
| **Snow** (stretch) | Particle field + white ground tint + snow on Fuji's cap | Reduced grip (~0.60), slower everything | Medium-high |

**The key insight:** weather changes driving feel via config multipliers on existing constants (`GRIP`, `FRICTION`), not a new system. The existing lateral-velocity/grip model is literally built for this.

**Rain onset is a spectacle:** clouds darken the directional light over ~30s, fog tightens, drops start, puddle planes appear. The transition is the wow, not the state.

---

## 6. Audio

### 6.1 Architecture

The project has zero audio. The world is 80% atmosphere — audio is load-bearing, not polish.

```
AudioListener (on camera)
   ↓
Listener input ← Master bus
                  ↑
   ┌─────────────┼──────────────┬─────────────┐
Master Gain    Reverb Send    Zone EQ       Ambient bus
               (algorithmic)  (garage LP)   (stereo, non-positional)
                  ↑                              ↑
           per-source send                   city/town/river beds
                  ↑
         Positional sources (engine, chirp, train, vending, etc.)
```

- One `AudioListener` attached to the camera
- `PositionalAudio` for world-located sources (crossing chirp, train, vending machines, river, konbini)
- Non-positional stereo for ambient beds and engine (in POV)
- Algorithmic reverb send bus (Schroeder reverb: ~4 comb filters + 2 allpass, ~80 lines) for the garage zone
- Zone EQ (low-pass on master) when inside the garage for cabin/interior filtering
- Distance-gating: only the nearest 2-3 spot sources are active at any time. Muted sources still cost graph nodes — stop them, don't mute them.
- **Autoplay policy:** `AudioContext` starts suspended. Resume on first keypress in `useKeyboard`.

**Budget:** ~8-12 active sources at once. Trivial for any browser.

### 6.2 MVP audio (all synthesis, no licensed assets)

| Element | Description | Effort |
|---------|-------------|--------|
| **Player engine (synth)** | 3 sawtooth oscillators + sub-oscillator + low-pass filter. Base frequency maps to RPM via a fake 4-gear curve off `speedRef.speed`. Throttle opens the filter cutoff and adds gain + noise. The gear-shift pitch drop is what sells it. ~150 lines. | Low |
| **Crossing chirp** | Tied to the traffic signal state machine. On green: a short original melody (3-5 notes, triangle/sine, ~2s). During flashing green: looping "piyo-piyo" two-tone chirp (~1kHz + ~1.3kHz alternating, 8Hz). Positional at the signal head. Audible ~30m, inaudible past ~60m. ~50 lines. | Low |
| **Tire/wind speed bed** | Filtered noise, bandpass opens with speed. Wind = pink noise, high-passed, volume tied to speed squared. At high speed, wind dominates the engine (counterintuitive but real). | Low |
| **City ambient bed (day)** | One stereo loop or synth pad (traffic murmur + diffuse low pad). Kills the silence. | Low |
| **Collision/scrape transient** | One-shot noise burst. Feedback for the existing capsule collider. | Low |
| **Night ambient swap** | Gain ramps on existing beds. City bed drops ~6-9dB, pedestrian murmur drops ~12dB, neon buzz enters (~6dB), cicada bed on town side. Crossfade over ~10s. | Low-medium |

### 6.3 Next-tier audio

| Element | Description | Effort |
|---------|-------------|--------|
| **Garage reverb zone** | Algorithmic reverb, zone-driven send (0=open city, 1=deep garage). Engine and tire squeal reverb more in the garage. Decay ~0.8-1.2s, slightly metallic. | Medium |
| **Train pass-by** | One positional source on the elevated track, heavily low-passed (cutoff ~800Hz-1kHz). 30-40s swell envelope. Looped filtered noise burst at ~8Hz (car passing rate) during hold. Triggered every 3-6 min when player is on the town side. | Medium |
| **Neon buzz at night** | One 12kHz tone + noise loop. Almost free, big night mood. | Low |
| **River bed** | Broadband water hiss + low gurgle loop. Positional, only when near the bridge. | Low |
| **Konbini chime** | Generic two-tone one-shot (NOT the real FamilyMart/7-Eleven jingles — trademarked). Triggered on proximity. | Low |

### 6.4 Audio traps to avoid

- **Don't render engine audio for every AI car.** One diffuse low-rumble bed that rises with nearby traffic density.
- **Don't use real konbini jingles, train melodies, or crossing melodies.** Write originals in the same style. This is a real legal landmine.
- **Don't hard-swap ambient beds.** Crossfade over seconds.
- **Don't let the engine be the loudest thing at speed.** Wind/tire should dominate at high speed.
- **Don't loop a single engine sample and pitch it with playbackRate.** Synthesize.
- **Don't create `AudioBufferSourceNode`s per frame.** Pool them.
- **Don't leave distant sources running (muted).** Stop them to free graph nodes.
- **Don't build a radio/station system.** Ambient sound is the soundtrack. A generative ambient pad is the fallback if silence reads wrong.

---

## 7. UI/UX

### 7.1 What dies, what survives, what's new

The current UI is a parking-guidance operations console. The pivot is a UI rebuild.

| Current element | Verdict | Reason |
|----------------|---------|--------|
| Brand badge "ParCoar / Parking guidance simulator" | **Dies** | An open-world game doesn't label itself on screen |
| Status panel (Backend/Active/Parked) | **Dies as HUD, becomes debug overlay (F3)** | Simulator telemetry |
| Controls drawer (C key) | **Dies as-is, reborn as Settings/Pause menu (Esc)** | Traffic/fill/sim-speed levers are garage-sim controls |
| Route map (M key, SVG garage graph) | **Dies as garage schematic, M becomes world map** | The SVG garage graph is irrelevant outside the garage |
| Sim settings (target cars, spawn rate, fill) | **Mostly dies** | Becomes a "traffic density" setting (quiet/normal/busy) |
| Board guidance overlay | **Dies** | Garage feature. The open world has street signs and GPS |
| PlayerGuidance strip | **Survives, content changes** | Pattern (top-center, next direction + distance) → GPS turn guidance |
| SpeedHud | **Survives, reskinned** | Switch `u/s` to km/h. Reposition to bottom-right. |
| Camera mode button bar | **Dies, replaced by key cycle (V)** | 8-button bar is a simulator control |
| Reset View button | **Dies** | Free-fly is a debug/photo mode |
| LoadingScreen / ErrorOverlay | **Survives** | Reskin copy |

### 7.2 The HUD (minimal, atmospheric)

| Element | Position | When shown | Notes |
|---------|----------|------------|-------|
| **Minimap** | Bottom-left | Always | GTA-style, player-rotates. ~150-220px. Nearby streets, river, bridges, POI icons, player arrow with heading. GPS line when waypoint set. |
| **Speedometer** | Bottom-right | Always while driving | km/h. Clean digital or analog readout. |
| **Current location name** | Top-left, subtle | Fades in on change | District/street name, GTA-style. Appears briefly when entering a new area, then fades. |
| **Time of day** | Top-right, small | Always or toggle | A clock. Reinforces the day/night cycle. Settings toggle for clean screen. |
| **Waypoint guidance** | Top-center | When waypoint set | Next turn + distance + destination name. Reuses PlayerGuidance pattern. |
| **Camera indicator** | None or transient | On change only | Brief label when switching views, then hide. |

At night, the HUD dims / shifts to a less bright color so it doesn't blow out the atmosphere.

### 7.3 The world map (M key)

**Full-screen, toggles over the game.** The whole region: city district, river, bridges, town, Fuji backdrop, race track, garage (home base).

- **Streets** as a vector graph (major roads thicker, side streets thinner)
- **Water** as a distinct color
- **Parks/shrines** in desaturated green
- **Track** as a distinct red/white-bordered loop
- **POI icons** for landmarks (garage, Scramble, track, Fuji viewpoint, shrines, bridges)
- **Interactivity:** pan (drag), zoom (scroll), click a POI to set as waypoint, click anywhere on a street to drop a custom waypoint
- **Styling:** dark base (matches `#0a0b0e` aesthetic), roads in warm off-white, water in muted blue. Japanese district labels (渋谷, etc.) alongside romaji.
- **Discovered vs. undiscovered:** optional layer — undiscovered POIs show as "?", resolve to their icon when the player drives within sight. Settings toggle.

### 7.4 Navigation / directions

In pure freeroam with no missions, directions go to:

1. **Player-set waypoints** (primary). Open the map, click a point or POI, GPS route draws to it.
2. **Landmarks / POIs** (secondary). Select from the map or a quick-menu.
3. **Back to home base** (always available). One-key "route to garage."

**GPS line** on both minimap and full-screen map, drawn along the road graph (not a straight line — follows streets, GTA-style). Requires a city road-network graph and pathfinder (frontend Dijkstra, porting the pattern from the garage backend).

**On-screen turn guidance:** "MEIJI-DORI · 120 m · LEFT" or "FUJI VIEWPOINT · 1.2 km". Reuses the `PlayerGuidance` pattern.

**No auto-destination.** The game never sets a waypoint for you. The player is always in control.

### 7.5 Camera / view controls

Single key (V) cycles driving views: far chase → near chase → hood → cockpit. A separate key for photo/spectator mode.

| View | Notes |
|------|-------|
| **Far chase** | Default. GTA's standard driving view. Slightly higher and further than current. |
| **Near chase** | Closer, lower, more visceral. |
| **Hood/bonnet** | Camera on the hood, looking forward. No cockpit interior. |
| **Cockpit/POV** | Already well-tuned (head-look, recentering, FOV). Keep. |
| **Cinematic** | Add later. Dramatic angles, cuts. Low priority. |
| **Photo/spectator** | Free-fly, gated behind a key. Not a gameplay view. |

**New city chase cam:** ~0.3s position lag, speed-scaled look distance, speed-based FOV. The current `CameraRig.tsx` (726 lines) is lot-bounds-coupled (`LOT_CENTER_X/Z`, floor presets) — city needs a new chase cam.

### 7.6 Pause / settings menu (Esc)

1. **Resume**
2. **Map** (opens full-screen map)
3. **Car** — car selection. Grid of available cars (3 models × colors × liveries). Select to spawn in that car.
4. **Time of Day** — presets (Dawn, Day, Sunset, Night) + "real-time cycle" toggle with speed. Replaces sim-speed chips.
5. **Settings:**
   - Display: graphics quality (Low/Medium/High), resolution scale, vsync
   - HUD: toggle minimap, speedometer, location name, clock, waypoint guidance
   - Audio: master, engine, SFX, ambient
   - Controls: key rebinding, invert Y, look sensitivity
   - Camera: default view, FOV, chase-cam distance/height
6. **Quit**

### 7.7 Onboarding

First-launch only: a short, non-diegetic overlay sequence (not a scripted mission). Step 1: "W/S — accelerate/brake." Step 2: "A/D — steer." Step 3: "V — change camera." Step 4: "M — open map, click to set a waypoint." Step 5: "Esc — pause menu." Each step waits for the player to do the thing, then advances. 60 seconds, then never again.

Contextual prompts afterward: "Home Base — park here to switch cars" when first approaching the garage. "Town District" when first crossing a bridge. One-shot location intros.

---

## 8. Features (non-mission interest hooks)

### 8.1 Driving feel

The single most important thing to get right. In a game with no objectives, the act of driving IS the entire game.

- **Reference:** GTA V's arcade driving feel — responsive, forgiving, fun at speed, not a sim
- **Per-car handling:** Tune `ACCEL_RATE`, `MAX_SPEED`, `GRIP`, `TURN_RATE` per model. Sportscar = twitchy and fast. SUV = boaty and grippy. Sedan = middle. A per-size config object.
- **Weather-multiplied grip:** Rain drops grip, snow drops grip more. The car slides differently in different conditions.

### 8.2 Car variety & customization

3 Quaternius CC0 models with a per-mesh material system. Realistic roadmap:

- **Color picker:** Expand the existing 9 presets to a full HSV picker. Cheapest customization, most-used.
- **Procedural liveries:** A `canvasTexture` generated in JS (racing stripes, numbers, kanji) applied as an overlay on the body mesh. No DCC tool needed. A livery editor that draws on a 2D canvas and wraps onto the car.
- **Rim color + tinted windows:** The material system already separates `Windows`/`Black`/`Grey` meshes — expose as customizable.
- **Per-car driving feel:** Different config per model (above).
- **Car selection UI:** A corner of the parking garage (or a dedicated scene) where cars are displayed on a turntable and you pick one.

**Perceived variety:** 3 cars × 20 liveries × 3 rim styles × distinct handling = a game that feels like it has a fleet.

### 8.3 Photo mode

The highest-leverage feature for a beautiful Tokyo world. People will share screenshots; that's marketing.

- **Free camera with DOF + FOV:** Detach from the car, fly anywhere, adjust focal length (35mm-85mm) and aperture (fake DOF via `DepthOfField` from drei). Pauses world time.
- **Time-of-day scrubber:** A slider scrubs the sun angle. Catch golden hour at the Fuji viewpoint without waiting. This single slider makes the mode addictive.
- **Filters / film looks:** LUT-style color grades (Cyberpunk neon-boost, Fuji pastel, noir B&W, warm film). Post-processing color lookup.
- **Rule-of-thirds grid:** Toggleable composition guide.
- **Location stamp:** Auto-stamp the screenshot with the in-world location name + time ("Shibuya Crossing — 19:42").
- **Replay buffer (ambitious):** Record the last ~10s of car transforms (position/heading/speed) into a ring buffer (300 samples at 30Hz, trivial memory). Photo mode can scrub time and orbit the car mid-drift.

### 8.4 Physics toys

- **Destructible cones / barriers:** Instanced cones with impulse response — hit one, it flies (velocity + spin + gravity), settles, respawns after N seconds. Cap at ~30 active. The most fun-per-line in the game.
- **Ramps and jumps:** A few placed ramps (loading dock, construction dirt pile, garage exit ramp that launches onto a lower roof). Small upward impulse at the lip when cresting at speed.
- **Drift zones:** Painted zones that score your slide (lateral velocity × duration) and pop a score floattext. No leaderboard — the score is the reward.
- **Tire-mark / skid trail:** When lateral velocity exceeds a threshold, paint into a ground-plane render target that persists and fades. The technical centerpiece of the drift spot. One RTTexture + a brush shader.
- **Swing barriers at parking exits:** The striped arm-bar that swings up when you drive through and clacks back down. Hinged prop with spring return.

### 8.5 The ghost commute (signature feature)

Record the player's driving line (transform samples) whenever they're on a road, into a persistent ring buffer. After the first session, their own ghost car appears on the roads at the same time of day, driving the route they drove — a translucent, emissive-outlined version of their car, looping.

- **Why this is the one:** It's personal. Every player's world is subtly different because it's built from their own behavior. It makes the freeroam meaningful without a mission: the world remembers you.
- **Cheap:** Already sampling the player transform every frame for the camera/HUD. Storing 60s is ~3600 floats. Replaying is a lerp along the buffer.
- **Scales:** Over days, you accumulate a handful of ghost routes. The roads feel used.
- **Stretch:** Let players share a ghost with a friend via a JSON string (export/import). Viral, zero backend.

### 8.6 Discoverables & viewpoints

- **Discovered-roads map fill:** Driving down a road "collects" it; the map fills in like fog-of-war reveal. Turns the map into a progress bar. Cheap (a set of road segments flagged driven).
- **Viewpoints / photo spots:** Marked spots that, when reached, give a framed camera shot of a vista (Fuji from the town bridge, the Scramble from above, the garage rooftop at sunset). The Assassin's Creed sync point pattern adapted to driving.
- **Manhole cover hunt:** Each district has a distinct manhole cover design. Finding all stamps a "collection" in the garage — low-pressure completionist hook with no UI nagging.
- **Hidden spots:** The under-bridge riverside spot. A drift spot in an empty parking lot. A hidden underground garage with one special car. A rooftop reachable by a specific jump. The "midnight club" rendezvous at 2am. A vending machine at the end of a mountain road dead-end.

### 8.7 Dynamic world events (life without missions)

Things that happen on a schedule whether you're there or not:

- **Train arrival at JR station:** A scheduled train slides in every N minutes, doors open, a crowd-billboard appears on the platform, then it departs. Level crossing gates sync to this.
- **Rush hour traffic density wave:** 7-9am and 5-7pm, roads get denser. Midday is quiet. A time-of-day multiplier on AI traffic spawn rate. Zero new systems.
- **Construction zone that moves:** A stretch of road with cones, a barrier, a "men at work" sign. Every few in-game hours it relocates.
- **Festival / matsuri pop-up:** At a recurring night, a shotengai section gains hanging lantern strings, yatai food stalls, warmer ambient lighting.
- **Rain onset:** Clouds darken over ~30s, fog tightens, drops start, puddles appear. The transition is the wow.
- **Delivery truck doing a job:** An AI truck slowly backs into a konbini loading bay, pauses, drives off. Implies a world of work.
- **Neon sign flicker cycles:** Individual neon signs occasionally flicker or half-fail. Tiny, but alive.
- **Last train:** Around midnight, the JR train makes a final run and the station goes quiet/dark after. The world changes regime at a known time.
- **Konbini restock:** A truck at the konbini at 6am, unloading.

### 8.8 Pedestrian life (minimum viable)

Billboards, not rigs. No skeletal animation, no crowd sim.

- **Crossing crowds at intersections:** 8-12 flat billboarded sprites that walk across on a timer, then despawn. Scatter (lerp away) if you approach fast. ~2 draw calls.
- **Platform crowd at train arrival:** Same technique, synced to the train schedule.
- **Night-life density:** More billboards near izakaya/shotsengai at night, fewer in the residential town.
- **Never on the road you're driving.** Pedestrians stay on sidewalks and crossings only.
- **One hero pedestrian interaction:** A "drunk salaryman" who wobbles across a crossing slowly at 11pm and bows apologetically if you honk. One animated billboard, one trigger.

### 8.9 Interactive elements

- **Car wash (drive-through):** A box tunnel with rotating brush strips, colored foam spray. A trigger volume plays a "wash complete" sound + swaps your car material to a higher-clearcoat, lower-roughness variant so it visibly gets shinier.
- **Petrol/charging station (visual):** A konbini-branded ENEOS-style station canopy. Pull up, a nozzle arm raises. No gameplay consequence — the animation is the reward.
- **Vending machine you can ram:** Knocking one over spills can sprites that scatter with simple impulse physics and roll. Satisfying, cheap.
- **Drive-through konbini window:** A window that slides open when you stop adjacent for >2s, with a steam particle puff.
- **Level crossing gate:** Drive onto the crossing and the bells ring + gates descend toward you. If a train is coming, the train physically pushes you off. Comic and tense.

---

## 9. Staged Build Plan

### Phase 0 — DrivableCar refactor (critical path, no visible change)

**The foundation. Everything depends on the car being able to leave the garage.**

1. Extract the ~150-line physics core from `DrivableCar.tsx` into a pure `CarKinematics` module (quadratic drag, lateral-grip drift basis, heading-basis composition/decomposition, two-disc capsule)
2. Abstract the world context behind interfaces (`WorldContext`: groundHeight, roadCorridor, collision, nearestNode, spawnPoint, physicsProfile)
3. Implement `GarageContext` wrapping the existing garage logic
4. `DrivableCar` becomes a thin wrapper calling through the interface
5. Verify all existing garage tests pass: `constants.test.ts`, `geometry.test.ts`, `roadSegments.test.ts`, `spawnGuard.test.ts`, `standstillDeparture.test.ts`

**Exit criteria:** The garage works identically. The car can theoretically exist outside the garage (the interface allows it, even if no city context exists yet).

### Phase 1 — Minimal drivable world + portal proof

**The thinnest thing that proves the vision end-to-end.**

1. `CityContext` implementation: flat ground height, city road corridors (a loop road around the garage building), AABB collision against building boxes, city-speed physics profile (`MAX_SPEED=28-40`, bicycle steering, friction-circle grip)
2. Ground plane, gradient sky, Mt. Fuji billboard, day/night on the directional light (basic sun arc + sky color lerp)
3. New city chase cam (~0.3s lag, speed-scaled look distance, speed-based FOV)
4. The portal handoff: diegetic gate + 200-400ms speed-blur/FOV punch, physics swap during blur, audio swap
5. Transparent-building reveal: toggle the building shell opacity, garage visible inside
6. MVP audio: synth engine, crossing chirp, tire/wind bed, city ambient bed, collision transient

**Exit criteria:** You can drive out of the garage, around a block, back in, seamlessly. The car feels good at city speed. The portal transition sells "new place" without feeling like a loading screen.

### Phase 2 — The alive spine

**The three highest-leverage atmosphere elements, all cheap.**

1. **Day/night fully wired:** The sunset sequence (sky gradient → window glow ramp → neon crossfade → streetlight stagger → blue hour). Environment map that reflects the actual sky. Per-window phase offset. Fog tuned per zone and per time-of-day.
2. **Animated neon signage + Bloom:** Emissive facade panels on towers. `@react-three/postprocessing` Bloom, gated behind quality toggle.
3. **Elevated Yamanote-style train loop:** One Catmull-Rom spline around the city perimeter, instanced train cars, lit windows at night. Train pass-by audio.
4. **Traffic-light cycles:** Visual signal state machine. The crossing chirp tied to it.
5. **The cheap Japan-signal layer:** Vending machines (instanced), overhead utility wires + poles (`meshline`), konbini glow, manhole covers, traffic signal heads.
6. **Night ambient swap + neon buzz audio.**
7. **Weather system v1:** Clear, cloudy, fog. Rain with wet asphalt + grip change.

**Exit criteria:** The world feels like a place at any time of day. Night is dramatically different from day. The crossing chirp and train pass-by make it feel alive.

### Phase 3 — The city district

**Grow the Shibuya side into a real district.**

1. **Parametric building system:** The `Building(footprint, floors, windowGrid, color, emissiveMask)` function. Slab towers, glass curtain-wall towers, podiums with shop fronts, rooftop clutter. Aggressive instancing/merging by material.
2. **The Scramble Crossing:** Diagonal crosswalk markings, signal cycle, instanced capsule pedestrians, the crossing chirp.
3. **Side streets:** Low-rise shop facades, shotengai arcade, pachinko parlor, elevated walkways.
4. **The river:** Reflective water plane (env-map reflection + scrolling normal map). Stepped concrete embankments. Riverfront promenade. Two contrasting bridges (modern + old truss). Hidden under-bridge spot.
5. **2-3 Blender hero assets:** Torii gate, hero tower with neon, maybe a distinctive bridge. Asset pipeline (Draco, KTX2, LODs).
6. **City AI traffic:** Waypoint-following cars on the city road network. Frontend-only. Distance-culled, no collision. Rush-hour density wave.
7. **The map UI:** Minimap (player-rotates, bottom-left) + full-screen map (M key) with POIs and waypoint setting. GPS line on road graph. Turn guidance.
8. **Photo mode:** Free camera, time-of-day scrubber, filters, location stamp.
9. **Discoverables:** Discovered-roads map fill, viewpoints, hidden spots.
10. **Physics toys:** Destructible cones, ramps/jumps, drift zones with skid trail.
11. **The ghost commute:** Transform recording + replay.
12. **Car variety:** Color picker, procedural liveries, per-car handling, car selection UI.
13. **Interactive elements:** Car wash, petrol station, ramable vending machines.

**Exit criteria:** The city is a dense, drivable, alive Shibuya-style district. You can navigate with the map, take photos, find hidden spots, drift, smash cones, see your ghost, and the world feels lived-in.

### Phase 4 — The town

**The quieter side, contrasting with the city.**

1. **Town building system:** Pitched-roof variant (gable/hip prism). 2-3 story houses, low commercial strips. Warmer palette, muted tones. Gaps between buildings, greenery.
2. **JR-style train station:** Elevated platform, station building with gable roof. Level crossing with dropping barriers (driving event, synced to train pass).
3. **The shrine on the hill:** Torii gate (Blender hero), stone lanterns, wooded backdrop. The hilltop overlook with a sightline back across the river to the neon city.
4. **Rice paddy strips:** Textured flat planes framing Fuji.
5. **The transition tunnel:** On the road between city and town. Headlight moment at night.
6. **Town-specific atmosphere:** Cicada bed at night, quieter ambient, sodium streetlight pools, narrower roads without lane markings.
7. **Town AI traffic:** Sparse, slower.
8. **Town on the map:** POIs (shrine, station, viewpoint), streets, the track.

**Exit criteria:** Driving from the city through the tunnel to the town feels like arriving in a different place. The shrine overlook at dusk is a postcard.

### Phase 5 — The race track (physical structure)

**A drivable F1-style circuit on the town outskirts.**

1. **Track surface:** Flat loop ribbon (reusing `buildRibbon`). No banking for v1.
2. **Kerbs:** Red-and-white alternating striped geometry on inside edges of corners.
3. **Tire walls:** Instanced stacked cylinders behind barriers at key corners.
4. **Start/finish gantry:** Structural overhead element with emissive signage.
5. **Grandstands:** Dark textured mass with scattered warm emissive dots.
6. **Pit lane / paddock:** Parked transport trucks, tire stacks, timing tower with glowing scoreboard.
7. **Night mode:** Floodlights (few real spotlights + fake emissive pole tops), glossy track surface.
8. **On the map:** The track loop visible as a red/white-bordered loop. POI for the entrance/paddock.

**Exit criteria:** You can drive a full lap on a track that looks like an F1 circuit. No timing, no AI — just the geometry. (Timers and racing systems come in a later version.)

### Phase 6 — Polish & depth

**Everything that makes the world feel complete.**

1. **Weather v2:** Rain with puddle reflection planes, wipers on POV. Snow (stretch).
2. **Dynamic world events:** Train arrival at JR station, construction zone that moves, festival/matsuri pop-up, rain onset spectacle, delivery truck, neon flicker, last train, konbini restock.
3. **Pedestrian billboards:** Crossing crowds, platform crowd, night-life density, the drunk salaryman.
4. **More interactive elements:** Drive-through konbini window, level crossing gate event, pay-and-display parking machine, tire shop.
5. **Photo mode v2:** Replay buffer (ring buffer of car transforms), cinematic camera rails.
6. **Ghost commute v2:** Multiple ghost routes accumulated over sessions. Share via JSON export/import.
7. **Audio polish:** Garage reverb zone, river bed, konbini chimes, vending machine hums, generative ambient pad (optional).
8. **Onboarding:** First-launch overlay sequence + contextual prompts.
9. **Settings menu:** Full pause menu with car selection, time-of-day control, graphics quality, HUD toggles, audio mix, controls, camera.
10. **More Easter eggs:** Hidden underground garage, rooftop reachable by jump, midnight club, vending machine at the end of nowhere, the Fuji road.

---

## 10. Technical Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| **DrivableCar refactor breaks the garage** | Critical | Phase 0 is no-visible-change. All existing tests must pass before proceeding. The refactor abstracts behind interfaces; the garage implementation wraps existing logic unchanged. |
| **Driving feel is not fun** | Critical | Pick a reference (GTA V arcade). Iterate with human judgment. The city physics is a from-scratch build — expect multiple tuning passes. Per-car handling profiles help variety. |
| **Map too sparse for pure freeroam** | High | The interest hooks (discoverables, photo mode, physics toys, ghost commute, weather, dynamic events) are specifically designed to prevent the 20-minute drop-off. Build them in Phase 3, not deferred. |
| **Performance: unbatched buildings jank** | High | Aggressive instancing/merging from day one. Target 300-600 draw calls. CSM or 4096² shadow map. Quality toggle. |
| **Two-physics portal transition pops/teleports** | Medium | Physics swap during the 200-400ms speed-blur window. The player never sees two cars or a pop. Asymmetric transition animations. |
| **Python offline when player approaches garage** | Medium | Frontend handles "no backend" gracefully. Garage is visually present but dormant with a UI indicator. WebSocket reconnects. Pre-parked cars render client-side. |
| **Asset pipeline gap (Blender → GLB → web)** | Medium | Build the pipeline before the first hero asset. Draco compression, KTX2 textures, LODs, emissive node setup. Commit Blender source files. |
| **City AI traffic is a new system** | Medium | Waypoint-following on city road network. Distance-culled. No collision (visual only). Start simple, add density wave later. |
| **Audio autoplay blocked** | Low | Resume `AudioContext` on first keypress in `useKeyboard`. |
| **Legal: real konbini/train/crossing sounds** | Low | Write original equivalents in the same style. No real jingles, melodies, or recordings. |

---

## 11. Decisions Log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Game type | Pure freeroam, GTA-style, no missions | User explicit. The driving, world, and atmosphere are the game. |
| World layout | River-split city + town, Fuji on town side, race track on town outskirts | User explicit. Varied regional layout. |
| Garage | Keep Python + two physics systems + portal | User explicit. The garage is a working parking guidance demo with real routing AI. |
| Race track (v1) | Physical structure only — no timing, no AI | User explicit. Timers and racing systems come later. |
| Interest hooks | All of them — discoverables, photo mode, physics toys, ghost commute, weather, dynamic events | User explicit: "Do everything. Full freedom." |
| Geometry approach | Parametric + few heroes | User explicit. Hand-authored layout, code-generated buildings. 2-3 Blender heroes. |
| Physics transition | Only player car transitions; AI cars despawn/respawn | User explicit. Brief transition acceptable. |
| Python scope | Garage only | User explicit. City is pure frontend. |
| Audio | Synthesized, no licensed assets | Sub-agent recommendation. Legal safety + zero asset budget. |
| Map UI | GTA-style minimap + full-screen map | User referenced GTA. Sub-agent detailed the design. |
| Driving-feel reference | GTA V arcade | Sub-agent recommendation. Responsive, forgiving, fun at speed. |

---

## 12. File Structure (proposed)

```
ParCoar/
├── backend/                    # Python (garage only, unchanged)
│   ├── server.py
│   └── generate_lot.py
├── shared/
│   └── spec.md                 # WebSocket protocol (garage only)
├── frontend/
│   ├── src/
│   │   ├── sim/
│   │   │   ├── DrivableCar.tsx        # Refactored: thin wrapper over WorldContext
│   │   │   ├── CarKinematics.ts       # NEW: extracted physics core
│   │   │   ├── WorldContext.ts        # NEW: world context interface
│   │   │   ├── GarageContext.ts       # NEW: garage implementation
│   │   │   ├── CityContext.ts         # NEW: city implementation
│   │   │   ├── CityCar.tsx            # NEW: city physics profile
│   │   │   ├── ParkingLot.tsx         # Garage renderer (unchanged)
│   │   │   ├── Scene.tsx              # Scene shell (expanded for open world)
│   │   │   ├── CameraRig.tsx          # Expanded: city chase cam
│   │   │   ├── constants.ts           # Expanded: city/town/track constants
│   │   │   ├── city/                  # NEW: city world
│   │   │   │   ├── Buildings.ts       # Parametric building system
│   │   │   │   ├── Roads.ts           # City road network
│   │   │   │   ├── River.ts           # Water + bridges + embankments
│   │   │   │   ├── Track.ts           # Race track geometry
│   │   │   │   ├── StreetFurniture.ts # Vending machines, poles, wires, etc.
│   │   │   │   ├── Neon.ts            # Emissive signage system
│   │   │   │   ├── Train.ts           # Elevated train loop
│   │   │   │   ├── TrafficLights.ts   # Signal state machine
│   │   │   │   ├── Pedestrians.ts     # Billboard crowds
│   │   │   │   ├── Weather.ts         # Weather system
│   │   │   │   └── DayNight.ts        # Day/night cycle driver
│   │   │   ├── town/                  # NEW: town world
│   │   │   │   ├── TownBuildings.ts   # Pitched-roof buildings
│   │   │   │   ├── Station.ts         # JR station + level crossing
│   │   │   │   ├── Shrine.ts          # Torii + lanterns
│   │   │   │   └── RicePaddies.ts     # Field strips
│   │   │   ├── audio/                 # NEW: audio system
│   │   │   │   ├── Engine.ts          # Synth engine
│   │   │   │   ├── CrossingChirp.ts   # Signal-tied chirp
│   │   │   │   ├── Ambient.ts         # Day/night ambient beds
│   │   │   │   ├── Reverb.ts          # Algorithmic reverb
│   │   │   │   └── AudioBus.ts        # Master bus architecture
│   │   │   ├── features/              # NEW: interest hooks
│   │   │   │   ├── PhotoMode.ts       # Free cam + time scrub
│   │   │   │   ├── GhostCommute.ts    # Transform recording + replay
│   │   │   │   ├── Destructibles.ts   # Cones, barriers
│   │   │   │   ├── DriftZones.ts      # Scored drift + skid trail
│   │   │   │   ├── Discoverables.ts   # Road fill + viewpoints
│   │   │   │   └── CarWash.ts         # Material swap trigger
│   │   │   └── ...
│   │   ├── ui/                        # NEW: open-world UI
│   │   │   ├── Minimap.tsx
│   │   │   ├── WorldMap.tsx
│   │   │   ├── HUD.tsx
│   │   │   ├── PauseMenu.tsx
│   │   │   ├── CarSelect.tsx
│   │   │   └── Onboarding.tsx
│   │   └── hooks/
│   │       └── useSimulation.ts       # Garage sim state (unchanged scope)
│   ├── public/
│   │   └── models/                    # Car GLBs + hero assets
│   └── assets/
│       └── blender/                   # NEW: Blender source files
└── docs/
    └── open-world-plan.md             # This document
```

---

## 13. Sub-Agent Assessment Index

This plan synthesizes 12 sub-agent assessments across 3 rounds:

### Round 1 (world design fundamentals)
1. **Topology & Scale** — graph scaling challenges, single EXIT_NODE limitation
2. **Routing & Traffic Intelligence** — Dijkstra inefficiency, interchangeable bays
3. **Rendering & Performance** — draw call budget, FloorPaint baking, signboard bottleneck
4. **Open-World Pivot Architecture** — hybrid rendering, two physics, portal boundaries

### Round 2 (creative expansion)
5. **World Landmarks & Destinations** — vending machines, shotengai, hilltop overlook, hidden spots, ranked coolness-per-effort
6. **Driving Experience & Gameplay Loops** — the two-loops problem, race track loop, portal transition feel, day/night as gameplay
7. **Visual & Atmosphere Details** — zone palettes, sunset sequence, materials, river, Fuji, ranked visual payoff
8. **Critical Technical Review** — DrivableCar monolith, two-physics assessment, Python offline, performance reality, asset pipeline gap, cut order

### Round 3 (final coverage)
9. **Audio & Sound Design** — synth engine, crossing chirp, Web Audio architecture, day/night audio shift, garage reverb, legal landmines
10. **Map, Navigation & Game UI** — minimap, full-screen map, GPS waypoints, HUD, camera views, pause menu, onboarding, what dies/survives
11. **Creative Features & Wow Moments** — car wash, destructible cones, photo mode, ghost commute, weather, dynamic events, pedestrian billboards
12. **Final Plan Review** — pure freeroam sustainability, race track assessment, garage role, two-physics critique, scope reality, missing items

Full sub-agent outputs are preserved in the conversation history.

# Tests

## Backend and graph

```bash
python -m unittest discover -s tests -t . -v
```

These tests cover weighted edge costs, distance-based bay selection, identical
bays, reservations, reconnect recovery, departures, stale-car cleanup and
explicit `no_path` handling.

## Frontend

```bash
cd frontend
npm run build
npm test
```

The frontend tests cover layout geometry and the manually driven car's road
centerlines.

## Movement soak test

With both servers running:

```bash
node tests/simcheck/check.mjs
```

This opens the simulator in a real browser and checks for stuck cars, overlaps,
jumps, unexpected reversals, mid-route reassignment and missing guidance. It
needs the frontend dev server rather than `vite preview`: the sim-state
publisher it reads only runs in dev builds. See [simcheck](simcheck) for the
invariants, the `SIMCHECK_DURATION_MS` override and the blind-run guard.

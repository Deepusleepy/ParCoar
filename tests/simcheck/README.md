# simcheck

A gate for car movement. It drives the running simulator in a real browser,
watches every car for a few minutes, and fails if anything a viewer would call
broken happened.

## Running it

Both servers must already be up: the Python backend, and the frontend (dev or
preview).

```
python3 backend/server.py &          # or backend/.venv/bin/python
cd frontend && npm run dev &
node tests/simcheck/check.mjs                                 # 180s, localhost:5180
node tests/simcheck/check.mjs http://localhost:5180/ 300      # longer run
```

Exit code 0 means every invariant held. Non-zero prints what broke.

Playwright is the only dependency: `npx playwright install chromium` once.

## What it checks

| Invariant | Why |
|---|---|
| No car sits still longer than 1.5s | A car stopping for no reason is the first thing anyone notices |
| No two cars come within 2.8 units | Bodies are 4.5 long, so closer than this is interpenetration |
| No car moves faster than 25 u/s over a real distance | Top speed is 7; anything faster is a teleport |
| No car changes height by more than 1.5 in a frame | Falling through or popping up a floor |
| No car drives backwards on the road for 12 straight frames | Reversing out of a bay is fine; reversing down an aisle is not |
| No car is re-assigned a different bay mid-journey | It reads as the car changing its mind |
| At least 90% of cars pass a guidance board | Otherwise the garage is not demonstrating anything |
| The page throws no errors | |

## About the pause threshold

The first version of this only flagged a car after **five** seconds of not
moving. The bug it was written to catch — cars halting under the overhead
direction boards — produced halts of up to **3.4 seconds**. So it reported a
clean garage for ten minutes at a stretch while the fault was fully present
and obvious on screen.

A threshold set above the failure magnitude is not a test. 1.5s is just above
normal following behaviour and the websocket handshake, both of which settle
inside a second. If you find yourself raising it to make the run pass, the run
is telling you something.

## What it deliberately does not check

Frame rate and draw calls. Those are stable and are covered separately; mixing
them in here would make the gate fail for reasons that have nothing to do with
how the cars behave.

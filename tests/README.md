# Tests

Two suites, because there are two kinds of thing that can break.

## `test_lot_graph.py`

Checks the garage graph and the search that runs over it. Fast, no servers
needed.

```bash
backend/.venv/bin/python -m unittest discover -s tests -t .
```

It asserts that every road can be driven both ways, that turns are labelled
left and right correctly in both directions, that the search never routes
*through* a parking bay on its way somewhere else, that a departing car can
still reach the exit, and that bays get handed out on all three floors rather
than piling onto the nearest one.

## `simcheck/`

Checks how the cars behave. It opens the running simulator in a real browser,
watches every car for a few minutes, and fails if anything a person would call
broken happened. Slow, and both servers have to be up.

```bash
node tests/simcheck/check.mjs
```

See [simcheck/README.md](simcheck/README.md) for what it looks for and why the
pause threshold is set where it is.

## Which one to run

Change the graph, the generator, or the search: run the Python tests.

Change anything that moves a car (the queueing rules, path resolution, the
curve generators): run simcheck. The Python tests will not notice, because a
car can follow a perfectly valid route and still drive through a wall.

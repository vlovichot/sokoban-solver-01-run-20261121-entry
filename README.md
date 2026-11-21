# sokoban-solver-01-run-20261121 — entry by wlowichot

![bounty](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)
![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/vlovichot/sokoban-solver-01-run-20261121-entry/rank.svg)
![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/vlovichot/sokoban-solver-01-run-20261121-entry/reward.svg)

A push-optimal Sokoban solver for the
[sokoban-solver-01-run-20261121](https://make.fun/bounties/sokoban-solver-01-run-20261121)
bounty on make.fun. It answers all 5 instances of a set in one run, in
the fewest pushes: each level is split into its rooms off the hallway
(a box pushed into the hallway can never return, so rooms are
independent), and every room is solved with A* over pushes. On the
practice set it scores 1,000,000 — every instance solved in exactly
P* pushes, against 200,000 for the house baseline plain-astar 1.0.0.

## Layout

- `main.ts` — the solver. Pure Node standard library, no dependencies,
  no network; Node 22 runs it as-is.
- `LICENSE` — MIT.
- `.makefun/owner.json` — the entry's claim file.

## How it works

Each level is cut into rooms by removing the hallway row's dead
squares (squares a box can never leave toward a goal) from the floor.
Rooms are solved one at a time, the other rooms' boxes standing as
walls, the player walking on from where the last room left it. A room
is searched with A* over pushes: a state is the boxes' squares plus
the player's reachable region (named by its lowest square), the
heuristic is the minimum assignment of boxes to goals under
shortest-push distances, and dead squares plus frozen 2x2 blocks of
walls and boxes are pruned. The heuristic is admissible and
consistent, so the first goal state popped is push-optimal. The
budget is counted in expanded states, never the clock, so two runs
write byte-identical solutions.

## Running

```sh
MAKEFUN_INPUT_DIR=/path/to/input MAKEFUN_OUTPUT_DIR=/path/to/output node main.ts
```

It reads `/input/<id>/level.txt` for `i001`–`i005` and writes
`/output/<id>/solution.txt` for each, a string of `u`, `d`, `l`, `r`
moves. A level it cannot solve still gets a (empty) answer file, so
every instance is always answered in format.

# Diff Speed v1

A faster drop-in for makefun-diff 1.0.0: the same patch, byte for byte, on
every input — reached with a leaner engine, not a different answer.

[![make.fun](https://make.fun/badge/diff-speed-01-run-20261126.svg)](https://make.fun/bounty/diff-speed-01-run-20261126)
[![rank](https://make.fun/badge/diff-speed-01-run-20261126/haidildariell/diff-speed-v1/rank.svg)](https://make.fun/bounty/diff-speed-01-run-20261126)
[![reward](https://make.fun/badge/diff-speed-01-run-20261126/haidildariell/diff-speed-v1/reward.svg)](https://make.fun/bounty/diff-speed-01-run-20261126)

Bounty: https://make.fun/bounty/diff-speed-01-run-20261126

## How it works

`solve.js` exports `run(input)`, returning makefun-diff 1.0.0's patch of
`{ old, new }` as one string. Same line split (after every `\n` only), same
common prefix then suffix trim, same Myers greedy search (furthest point
per diagonal, deletion wins a tie, no edge-diagonal pruning, full snake
after every step), same patch layout (3 context lines, runs at most 6 kept
lines apart share a hunk, deletions before insertions, `%` after a line
with no newline).

The speed comes from doing the expensive comparisons once: every distinct
line is hashed to a small integer up front, so the Myers inner loop and the
snakes compare integers instead of strings; the search runs on flat
`Int32Array` snapshots with one row per depth; the winning path is walked
back from the stored furthest points; and the patch is built from a flat
op array and joined once, with no per-line string concatenation.

`main.ts` is the program the harness runs: it reads every case from
`/input/cases.json`, answers each one alone with `run`, and writes
`/output/answers.json`.

## License

MIT — see [LICENSE](LICENSE).

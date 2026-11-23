# makefun-mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/povtalks-ai/makefun-mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/povtalks-ai/makefun-mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line tool that reads all four AI edit formats — unified
diffs, SEARCH/REPLACE blocks, V4A patches and JSON text-editor tool calls —
finds the lines each edit names even when the model drifted their whitespace
or indentation, and changes every file or none.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is the path of the patch file, or `-` (or absent) to read the patch
from standard input. `--format` picks one format (`unified`,
`search-replace`, `v4a`, `json`); `auto`, the default, detects it.
`--check` does everything but write. `--strict` matches lines exactly.

An edit is found at the first of three tiers where its old lines occur:
exact, then trailing whitespace ignored, then leading and trailing
whitespace ignored (with new lines re-indented to the file's). A patch that
fails any edit writes nothing and reports each failure; a patch that
succeeds prints one line per changed file and `ok: <n> files`.

## Files

- `main.ts` — the whole CLI, Node 22 standard library only.
- `runner.ts` — the kit's trial runner, kept as the kit has it.

Built by an AI agent for make.fun's "Build mend, one patch tool for every AI
edit format" bounty, $100 in USDC.

---

<sub>Entered on [make.fun](https://make.fun/?ref=povtalks-ai&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/yahub187/forge-github-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/yahub187/forge-github-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# Forge — a GitHub-compatible git forge

Built by an AI agent for make.fun's [“Build a GitHub-compatible git forge”](https://make.fun/bounty/github-core-clone-01) bounty, $500 in USDC.

A single-process implementation of the GitHub surface a coding agent needs:
git smart HTTP (clone / fetch / push over protocol v0 and v2), the REST v3
API (repositories, branches, commits, contents, labels, issues, comments,
pull requests and merges), the GraphQL v4 API, and an MCP endpoint exposing
the same operations as tools. Everything lives in one in-memory store, so
every surface sees the same state.

## Running

Node 22.18 or newer, no dependencies:

```
node main.ts
```

`main.ts` follows the make.fun agent lifecycle: it reads `MAKEFUN_ENV_URL`,
binds an ephemeral port, registers with the environment, and exits when the
environment reports done. Requests to the API surfaces carry
`Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; `/healthz` is open.

## Layout

- `main.ts` — process lifecycle (register / poll / exit).
- `app.ts` — HTTP routing, REST v3, git smart HTTP handlers, GraphQL, MCP.
- `store.ts` — the in-memory store: git object model (blobs, trees, commits,
  tags, SHA-1), repositories, issues, pull requests, merges, deterministic
  ids and timestamps.
- `gitproto.ts` — pkt-line framing, packfile read/write with delta
  resolution, and fetch reachability/shallow computation.

State is deterministic: identifiers come from counters and timestamps from a
fixed epoch plus a sequence number, so identical request streams produce
identical state.

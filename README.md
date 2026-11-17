# github-core-clone-02

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/AhmadTurki182/github-core-clone-02/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/AhmadTurki182/github-core-clone-02/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node.js process, standard library
only, no UI, no outside service. It serves all four surfaces from its own
in-memory store: clone and push over smart HTTP (protocol v2 and v0),
repositories/issues/pull requests/contents over the REST v3 API, queries and
mutations over GraphQL, and tools over MCP. It binds an ephemeral port of
its own and registers it with the grading suite.

## Run it

```sh
node --experimental-strip-types main.ts
```

The forge prints the port it bound, then serves until stopped. Node 22+ is
required (type stripping, no build step).

---

<sub>Entered on [make.fun](https://make.fun/?ref=rqn4ywrm&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

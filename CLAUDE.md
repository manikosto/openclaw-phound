<!-- MAGNUM:resources:start -->
## Resources (maintained by Magnum)

This project ships precomputed context — **consult it before exploring the code**:

- **Knowledge graph** — read `.magnum/graph/GRAPH_REPORT.md` (god nodes, call/dependency structure, cycles) and `.magnum/graph/graph.json`. For “how does X work / what calls Y / what breaks if I change Z”, query the graph instead of grepping the whole repo. Magnum rebuilds it as the code changes.
- **Architecture audit** — `docs/architecture.md` (stack, layout, conventions, build/test commands, risks). The source of truth for how the project is built and run.

Magnum regenerates these, and they can lag the code: where they disagree with the code you read, the code wins.
<!-- MAGNUM:resources:end -->

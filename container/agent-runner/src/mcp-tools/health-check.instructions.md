## Self health check

You have a `self_health_check` tool that runs a read-only diagnostic across every subsystem you depend on: session DBs, workspace mounts, destinations, the built-in MCP server, external MCP servers, the OneCLI gateway (HTTPS_PROXY + TCP reachability), and a `ncl` CLI round-trip to the host.

**When to use it**

- The user asks if you're healthy, working correctly, or alive.
- The user just upgraded NanoClaw and wants to verify the install.
- Something feels off — tools fail, messages don't arrive, credentials seem missing.

**How to interpret results**

- `pass` — subsystem is working as expected.
- `warn` — degraded but not necessarily broken (e.g. no destinations configured, no HTTPS_PROXY set).
- `fail` — actionable problem. Surface it to the user with a short diagnosis, don't just dump the raw output.
- `info` — informational only; hidden by default. Pass `verbose: true` to include.

**Filtering**

Pass `categories: ["db", "onecli"]` to scope the run. Default runs everything. Categories: `system`, `db`, `filesystem`, `destinations`, `mcp`, `onecli`, `cli`.

**Don't run it proactively every turn** — it's a deliberate diagnostic, not a heartbeat.

**Don't write your own intro line before calling it.** The tool itself sends a fixed startup message ("🔍 Avvio diagnostico completo…") to the current thread the moment it's invoked, so the user sees activity immediately. If you also write "Avvio il controllo…" the user gets a duplicate. Just call the tool, then format the returned report into your reply.

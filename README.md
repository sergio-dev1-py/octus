# Octus

**The local-first multi-agent coding harness (desktop).**

[![Bun](https://img.shields.io/badge/Bun-1.4-fbf0df?style=flat-square&logo=bun)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript)](https://www.typescriptlang.org)
[![Electron](https://img.shields.io/badge/Electron-desktop-47848f?style=flat-square&logo=electron)](https://www.electronjs.org)
[![SolidJS](https://img.shields.io/badge/SolidJS-renderer-2c4f7c?style=flat-square&logo=solid)](https://www.solidjs.com)
[![SQLite](https://img.shields.io/badge/SQLite-ledger-003b57?style=flat-square&logo=sqlite)](https://www.sqlite.org)
[![Status](https://img.shields.io/badge/status-in_development-orange?style=flat-square)](https://github.com/sergio-dev1-py/octus)
[![License](https://img.shields.io/badge/license-UNLICENSED-lightgrey?style=flat-square)](./LICENSE)

**English** | [Español](./README.es.md)

> 🏆 Built during the **Meta Global AI Developer Hackathon 2026** as a development project in the **Push the Frontier** track, **individual** modality.

---

Octus is a desktop harness for delegating real coding work to specialized AI subagents under a single coordinator — with human-only approvals, per-call usage ledger, and deterministic orchestration. It runs providers live (Meta Responses API, OpenCode Go per-model native protocols) and ships a governed path from **plan → approved revision → task DAG → parallel workers → review → integrated branch → validated preview → SHA-pinned approval → safe promotion**.

On top of the harness, Octus ships a professional desktop workbench — welcome flow, virtualized conversation, Agent Manager, a real Skills system, a trust-gated MCP client, and a persistent PTY terminal.

The workbench is functional end to end (welcome, chat, agents, Skills/MCP managers, terminal); screenshots land with the release notes.

## Why Octus

- **Local-first.** SQLite (worker thread) is the source of truth: sessions, runs, instances, plans, tasks, usage. No silent fallbacks, no hidden state.
- **One coordinator, two profiles.** A single coordinator works in `plan` (read-only analysis) or `build` (execution) over one continuous session; four worker profiles (`explorer`, `researcher`, `implementer`, `reviewer`) do the work.
- **Approvals are human-only.** Plans advance only on explicit user approval pinned to exact `(plan_id, revision_id)`. Models can request approval; they can never grant it.
- **Every provider call is billed on the ledger.** `usage_records` rows per call (tokens, reasoning, cache, cost) plus run/session budgets with warn/block gates. Unconfigured paid calls are refused before leaving the router.
- **Deterministic scheduler.** Task DAG with cycle detection, dependency ready-gates (`needsReview`), role/session/project concurrency limits with persisted fairness cursor, atomic scope reservations, retries with backoff, and crash reconciliation. Writers work in harness-managed Git worktrees; multi-writer dependents build on integrated work bases.
- **Professional workbench.** VS Code-inspired layout (activity bar, sidebar, central conversation, inspector, terminal panel) with persistent themes, sizes, and densities.
- **Real Skills.** Agent Skills discovery, validation, install, per-project activation, and progressive runtime loading with per-run usage records.
- **Real MCP client.** Trust-gated STDIO + Streamable HTTP client (no legacy SSE) with per-server namespaced tools, approved resources/prompts, and OS-store secrets.

## Project status

Work proceeds in gated stages (ADR-016): a stage only starts after the previous one is validated and documented. Evidence lives in [`.harness/implementation/`](./.harness/implementation/).

| Stage | Scope | Status |
|---|---|---|
| 0 — Audit & plan | OpenOrch audit, Meta docs verification, safe baseline, ADRs 001–016 | ✅ Done |
| 1 — Core, persistence, providers, runtime | Single streaming agent, basic tools, SQLite ledger, Meta + Go adapters, budgets | ✅ **Closed 2026-10-31** — 14/14 live checks, 56 core + 1 shared tests green |
| 2 — Agents, permissions, Plan Manager | Plan/build profiles, 4 worker profiles, foreground/background delegation, isolated dirs, test allowlist, trusted instructions, user-pinned approvals | ✅ Implemented — 110 core + 1 shared green, 15 new live checks after `MODEL_API_KEY` |
| 3 — Scheduler, tasks, DAG, parallelism | `tasks`/`task_dependencies` migration, TaskGraph, TaskPlanner (internal service), deterministic scheduler, retry/recover, review verdicts, minimal DAG UI | ✅ Implemented — 140 core + 1 shared green; **live matrix A 35/35 PASS** (Meta contributor/xhigh, real plan→DAG→parallel→review→done, per-instance model+usage verified); matrix B **BLOCKED** by model (deepseek-v4.1-flash/max won't emit the planner contract after 12 attempts — product-side transports fixed and verified) |
| 4 — Git worktrees | Isolated worktree per writer task, base→produced commit traceability, harness-managed branches | ✅ **Done 2026-10-31** — live matrix A 35/35 PASS (worktree auto-provisioned, reviewer in target worktree, `produced_commit` recorded); `worktrees.test.ts` 21/21; suite 162 core + 1 shared green |
| 5 — Integration, validation, preview, approval | Sequential integration, assisted conflict resolution, per-SHA validation gates, detached previews, SHA-pinned approval, CAS/fast-forward promotion, no push | ✅ **Done 2026-10-31** — 9/9 feature branches pushed green-gated (`feat/stage5-0-contracts-migration` … `feat/stage5-8-acceptance-docs`); suite 197 core + 1 shared green (`integration.test.ts` 37/37); **live matrix A 45/45 PASS** (auto-build→review→preview reachable→pinned approval→FF promote, run done, no remote) |
| 6 — Memory, recovery (+IPC/UI) | Project/session/run/task/instance memory with user-governed promotion, contextual selection, coordinated recovery | ✅ **Done 2026-10-31** — 7/7 feature branches pushed green-gated (`feat/stage6-0-migracion-contratos` … `feat/stage6-6-live-docs`); suite 235 core + 1 shared green (`memory.test.ts` 30, `memory-e2e.test.ts` 7); **live A 54/54 PASS** (Meta) and **live B 56/56 PASS** (Go/GLM-5.3-flash high + controlled `max` probe: valid 3-task DAG, reasoning traced) |
| 7 — UX/UI design | Information architecture, navigation, screen inventory, flows, design system, themes, contracts, performance budgets | ✅ **Done 2026-11-02** — approved design docs + contracts, verified by read-checks and ref scripts |
| 8 — Frontend foundations | CSS design tokens, light/dark/system themes, sizes 12–18px, densities, shared components, resizable workbench, App/store modularization | ✅ **Done 2026-11-02** — persisted prefs, Playwright layout QA, typecheck + suite green |
| 9 — Welcome, projects, sessions | Drag-and-drop welcome, native picker, recents, visual session recovery | ✅ **Done 2026-11-02** — verified over real IPC with fixed fixtures |
| 10 — Conversation | Virtualized chat timeline, streaming, cancel, tool calls, approvals, questions, agent activity | ✅ **Done 2026-11-02** — Playwright 41/41 over the built bundle |
| 11 — Agent Manager | Agents/tasks/DAG views, worktree diffs (new `worktrees.diff` channel), previews, conflicts, history | ✅ **Done 2026-11-02** — 31/31 agents verify + 5/5 task-graph |
| 12 — Real Skills system | Agent Skills discovery/validation/install/scopes, progressive loading into the runtime, Skills Manager UI | ✅ **Done 2026-11-02** — 21/21 skills suites + 72/72 UI verify |
| 13 — Real MCP client | MCP SDK 1.32.2 conformance, trust-gated client manager, namespaced tools, resources/prompts, server hardening, MCP Manager UI | ✅ **Done 2026-11-02** — 46/46 MCP suites + 15/15 conformance |
| 14 — Terminal, files, results | Persistent PTY terminal in main, explorer, diffs, test results, diagnostics | ✅ **Done 2026-11-02** — PTY QA + 16/16 explorer verify |
| 15 — Performance, security, distribution | Budget gates 49/49, Electron security audit 68/68, secret scan, Windows packaging | ✅ **Done 2026-11-02** — build + smoke green, final verification F1–F4 APPROVED |

Details: [`IMPLEMENTATION_ROADMAP.md`](./.harness/implementation/IMPLEMENTATION_ROADMAP.md) · [`STAGE4_ACCEPTANCE_REPORT.md`](./.harness/implementation/STAGE4_ACCEPTANCE_REPORT.md) · [`STAGE5_ACCEPTANCE_REPORT.md`](./.harness/implementation/STAGE5_ACCEPTANCE_REPORT.md) (appended by the live runner) · [`STAGE6_ACCEPTANCE_REPORT.md`](./.harness/implementation/STAGE6_ACCEPTANCE_REPORT.md) (appended by the live runner) · [`DECISIONS.md`](./.harness/implementation/DECISIONS.md) (ADRs 001–069 + implementation findings, incl. real bugs found by tests/live and fixed).

## Repository layout

```
octus/
├── packages/
│   ├── shared/     # Domain contracts: sessions, messages, events, IPC, models, costs
│   ├── core/       # Providers, router, runtime, agents, plans, tasks/scheduler,
│   │               # permissions, tools, persistence, budgets, live harnesses
│   └── ...         # (workspaces: packages/*, apps/*)
├── apps/
│   └── desktop/    # Electron + SolidJS shell (main/preload/renderer), acceptance runner
└── .harness/
    └── implementation/  # Audit, architecture, ADRs, roadmap, acceptance reports
```

## Quickstart

Prerequisites: **Bun ≥ 1.4** (package manager + test runner) and **Node ≥ 22.5**.

```bash
bun install

# Typecheck everything (shared + core + desktop node/web)
bun run typecheck

# Unit + integration tests (fake providers by default — no keys needed)
bun run test
# On slow machines the full core suite needs a raised timeout
# (default 5 s timeouts flake on an i3): run from packages/core as
# bun test --timeout 60000

# Build the desktop app
bun run build

# Headless smoke test (boots core in the Electron main process)
bun run smoke

# Dev shell (Electron + SolidJS renderer)
bun run dev
```

## Live validation (real providers, real spend)

Unit tests run on fake providers. The `check:live` harnesses hit the real APIs and are **bounded by budgets** (warn/block gates). Keys are never stored in the repo — they come from `MODEL_API_KEY` / `OPENCODE_API_KEY` env vars (or the OS secure store in the desktop acceptance runner).

```bash
# Stages 1–2: 14 core checks + delegation/plans matrix
MODEL_API_KEY=... OPENCODE_API_KEY=... bun --cwd packages/core run check:live

# Stage 3: TaskGraph/Planner/Scheduler matrices (A: Meta contributor/xhigh, B: Go deepseek/max)
MODEL_API_KEY=... OPENCODE_API_KEY=... bun --cwd packages/core run check:live:stage3
```

Desktop end-to-end (acceptance runner inside Electron, keys from the OS store, report appended to `.harness/implementation/`):

```bash
bun run build
bunx electron ./apps/desktop/out/main/index.js \
  --user-data-dir="$APPDATA/@octus/desktop" \
  --octus-acceptance-3
# Filter: OCTUS_ACCEPT_MATRIX=a|b|both
```

## Security model

- API keys live in the **OS secure store** (`safeStorage`) or env vars at runtime. The repo contains **zero secrets** — verified before every push.
- Tools run behind `PermissionManager` (default-deny for writes/shell) with per-project isolated directories, path-scope containment (`realpath` + UNC rejection), and a test-command allowlist executed in disposable copies.
- Human-only gates: plan approvals, and (from stage 5) SHA-pinned integration promotion. The harness auto-approves only inside clearly-marked **test/simulated-user** code paths.
- Skills run least-privilege: skill content is untrusted, only authorized scopes reach a run, and enabling a skill never grants tool permissions.
- MCP is a trust-gated client: unknown servers never execute, workspace trust is explicit, tool names are namespaced per server, sensitive resources/prompts need approval, and secrets live only in the OS store with redaction in logs.
- The integrated PTY terminal reuses the shell policy (ask-per-turn, guardrails, timeouts, whole-tree kill); agents have no path to it.

## Contributing

The project is in active development (pre-release, `0.1.0`, private). External contributions aren't open yet — issues and discussion live on the [tracker](https://github.com/sergio-dev1-py/octus/issues). If you build something related and reuse the name, please note it isn't affiliated, same courtesy [opencode asks of its ecosystem](https://github.com/anomalyco/opencode#building-on-opencode).

## License

All rights reserved for now (`UNLICENSED`, see [LICENSE](./LICENSE)). License terms will be defined before any public release.

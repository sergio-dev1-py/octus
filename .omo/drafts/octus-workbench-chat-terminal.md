---
slug: octus-workbench-chat-terminal
status: drafting
intent: clear
review_required: true
plan_path: .omo/plans/octus-workbench-chat-terminal.md
plan_sha256: null
review_round_id: null
review_round_limit: 5
pending-action: write and review .omo/plans/octus-workbench-chat-terminal.md
review:
  plan_reviewer:
    status: pending
    workspace_root: null
    runtime_home: null
    target: .omo/plans/octus-workbench-chat-terminal.md
    round_id: null
    plan_sha256: null
    launch_id: null
    session: null
    result: null
approach: Sidebar estilo screenshot (proyectos+sesiones con punto verde, Nueva sesion, Tareas programadas, MCP dot); chat opencode (secciones ocultas en sesion vacia, burbujas usuario gris, actividad agente colapsable con subagentes, footer tiempo+tokens, modelo+esfuerzo bajo input); terminal xterm como pestana inferior; fix carpeta vacia como proyecto; feature Tareas programadas (core+IPC+UI).
---

# Draft: octus-workbench-chat-terminal

## Affected user and ideal state
<!-- Who this output touches (a customer, another programmer, a program or agent consuming it - often more than one) and how each uses it today and will use it after. -->
<!-- IS-n | property of the ideal state: nothing snags, feels odd, regresses, or degrades for them | reason -->
<!-- GAP-n | difference between IS-n and today | reason | closed by todo(s) -->

## Components (topology ledger)
<!-- Lock the SHAPE before depth. One row per top-level component that can succeed or fail independently. -->
<!-- id | outcome (one line) | status: active|deferred | evidence path -->

## Open assumptions (announced defaults)
<!-- Record any default you adopt instead of asking, so the user can veto it at the gate. -->
<!-- assumption | adopted default | rationale | reversible? -->

## Findings (cited - path:lines)

## Decisions (with rationale)

## Scope IN

## Scope OUT (Must NOT have)

## Open questions

## Decisions
- Intent: CLEAR, review_required: true. Stance: batch (usuario decide por defecto recomendado).
- Tests: tests-despues + QA de agente (adoptado del patron del usuario, no preguntado).
- Tema: FORK ABIERTO (navy ejecutado vs claro del screenshot).
- Tareas programadas: base `C:\Users\UserPy` + carpeta auto `scheduled_tasks` (ingles) creada al primer uso; cada tarea corre como sesion nueva de esa carpeta; si existe se reutiliza.
- Tema: mantener navy (usuario). Terminal: xterm.js (usuario). Topologia: 5 confirmada.
- Terminal: FORK ABIERTO (xterm vs pre mejorado).

## Approval gate
status: approved (chat limpio: subagentes/herramientas solo visibles mientras el agente trabaja, jamas en sesion nueva)
next: escribir .omo/plans/octus-workbench-chat-terminal.md solo tras okay; luego plan-reviewer high-accuracy.
<!-- When exploration is exhausted and unknowns are answered, set status: awaiting-approval. -->
<!-- That durable record is the loop guard: on a later turn read it and resume at the gate instead of re-running exploration. -->

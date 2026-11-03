---
slug: octus-welcome-settings-theme
status: drafting
intent: clear
review_required: true
plan_path: .omo/plans/octus-welcome-settings-theme.md
plan_sha256: null
review_round_id: null
review_round_limit: 5
pending-action: write and review .omo/plans/octus-welcome-settings-theme.md
review:
  plan_reviewer:
    status: approved-notes-only st_01a19d04 (orden 8-antes-que-1 como nota, no bloquea)
    workspace_root: null
    runtime_home: null
    target: .omo/plans/octus-welcome-settings-theme.md
    round_id: null
    plan_sha256: null
    launch_id: null
    session: null
    result: null
approach: Redisenar bienvenida Octus azul-oscuro con logo pulpo + workspaces; activar toggles laterales/inferior solo con workspace y terminal ligada al proyecto; permitir drag de directorios vacios como workspace normal; ventana Ajustes modal por secciones (Proveedores, Agentes) con X, sin Presupuesto, botones compactos y sin overflow; aplicar tema azul oscuro a todo el harness via tokens.css; default de modelo barato auto con memoria por sesion/workspace.
---

# Draft: octus-welcome-settings-theme

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

## Affected user and ideal state (recorded)
- Usuario harness (dueno de workspaces): abre inicio Octus azul oscuro con pulpo, Abrir Carpeta + Ajustes, Workspaces recientes; nada confuso ni tema mixto.
- Usuario de sesion: toggles laterales/inferior desactivados sin workspace, activos con workspace; terminal inferior ligada al proyecto.
- Usuario de ajustes: modal con X superior, secciones seleccionables (Proveedores / Agentes), sin Presupuesto, botones compactos, sin overflow ni bordes tocados.
- Agentes/modelos: con API cargada hay un barato por defecto igual en todos; si hubo sesion previa se restaura el ultimo modelo de esa sesion/workspace.
- GAPs vs hoy: bienvenida sin diseno objetivo; toggles sin gating claro; vacios rechazados en drop (files vacio); ajustes en vista unica sin X y con Presupuesto; tema claro/calido en tokens.css; sin default barato ni memoria por sesion.

## Components (topology lock, confirmado por usuario)
- C1 inicio+workspaces (incluye drag de vacios como workspace normal) | active | views/welcome.tsx, store/welcome.ts, main/validate-directory.ts
- C2 toggles+terminal ligada | active | views/workbench.tsx, views/terminal-panel.tsx, shared/layout.ts
- C3 ajustes modal por secciones sin presupuesto | active | views/settings.tsx, views/sections.tsx
- C4 tema azul oscuro global + botones | active | design/tokens.css, styles.css, components/oc-components.css
- C5 default modelo barato + memoria sesion | active | core/providers/*, core/agents/*, shared/model.ts

## Decisions (respuestas usuario)
- Topologia: 4 componentes + vacios plegado en C1 (el vacio carga normal como workspace).
- Presupuesto: ELIMINAR TODO (UI + enforcement core). Riesgo: llamadas pagadas quedan sin bloqueo; se planifica retiro completo y aviso.
- Modelo: mas barato auto (toolCall, segun pricing) + memoria: ultimo modelo por sesion/workspace prevalece al reabrir.
- Pruebas: tests-despues + QA de agente en cada todo.
- Intent: CLEAR, review_required: true. Stance: batch (usuario decide por defecto recomendado).

## Scope IN
- Inicio, toggles, terminal ligada, vacios, ajustes modal, tema global, default barato+memoria, quitar presupuesto completo.

## Scope OUT (Must NOT have)
- No nuevos proveedores ni endpoints; no migracion de datos fuera de prefs/sesion; no faseo MVP reducido.

## Approval gate
status: awaiting-approval
next: escribir .omo/plans/octus-welcome-settings-theme.md solo tras okay explícito; luego plan-reviewer high-accuracy.

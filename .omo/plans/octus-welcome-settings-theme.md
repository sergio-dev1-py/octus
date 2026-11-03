# octus-welcome-settings-theme - Work Plan

## TL;DR (For humans)
<!-- Fill this LAST, after the detailed plan below is written, so it summarizes the REAL plan. -->
<!-- Plain English for a non-engineer: NO file paths, NO todo numbers, NO wave/agent/tool names. -->

**Who this is for and what changes for them:** Para ti que abres el harness cada dia: veras el inicio azul con el pulpo, tus workspaces a mano, y ajustes claros por secciones.

**What you'll get:** Bienvenida objetivo, paneles que solo se activan con proyecto, terminal ligada, vacios que cargan, ajustes con X sin presupuesto, todo en azul oscuro y modelo barato automatico con memoria.

**Why this approach:** Primero el tema y la bienvenida, luego el modal y la logica, al final el retiro total de presupuesto y el default barato; asi nada se rompe a medias.

**What it will NOT do:** No crea proveedores nuevos, no deja restos de presupuesto, no deja botones grandes ni ventanas desbordadas.

**Effort:** Large
<!-- Effort is exactly ONE band, never hours/days. Quick = single edit, minutes of agent work; Short = one focused change, a few files; Medium = multi-file feature in one session; Large = several waves, one long session; XL = multi-session or architectural work. A written duration is rewritten to a band. -->
**Risk:** High - quitar todo el bloqueo de presupuesto deja llamadas pagadas sin tope.
**Decisions to sanity-check:** Retiro total de presupuesto (pedido explicito); barato auto con memoria por sesion.

Your next move: plan-reviewer high-accuracy review automatica y luego /ulw-execute. Full execution detail follows below.

---

> TL;DR (machine): Large, High (sin tope de gasto), bienvenida+modal+tema+defaults listos para ejecutar

## Scope
### Affected user and ideal state
<!-- From the draft ledger: who this touches and how they use the result, then one IS row per property with its reason, then one GAP row per difference with its reason. Every todo below closes a GAP row; ## Success criteria proves every IS row. -->
**Affected user:** Dueno de harness Octus en Windows: abre la app sin proyecto, elige/arrastra un workspace, alterna paneles y terminal, carga API keys en Ajustes y trabaja con agentes. Hoy la bienvenida es generica clara, los toggles no tienen gating visible, los vacios fallan al soltar, Ajustes es una vista unica sin X con Presupuesto, el tema es calido claro y los agentes no tienen default barato con memoria.

| Row | Statement | Reason |
| --- | --- | --- |
| IS-1 | Inicio azul oscuro con pulpo blanco, botones Abrir Carpeta + Ajustes y lista Workspaces con la misma tipografia | Es la identidad pedida; el usuario reconoce su harness al abrir |
| GAP-1 | welcome.tsx es tarjeta clara generica sin logo ni fondo objetivo | Difiere de las imagenes objetivo |
| IS-2 | Botones superiores derecha abren laterales + inferior con terminal ligada al proyecto; desactivados sin workspace y activos con workspace/sesion | Evita paneles vacios y deja la terminal siempre en el proyecto abierto |
| GAP-2 | workbench.tsx tiene toggles siempre clicables y bottomTab terminal sin gating por proyecto | El usuario puede abrir paneles sin contexto |
| IS-3 | Arrastrar un directorio vacio lo carga normal como workspace | Un workspace nuevo suele empezar vacio |
| GAP-3 | El drop de vacio reporta "soltado vacio" porque pathsFromDrop usa dataTransfer.files (vacio en carpetas vacias) | Bloquea el flujo pedido |
| IS-4 | Ajustes es modal centrado con X superior, secciones Proveedores y Agentes seleccionables, sin Presupuesto, botones compactos, sin overflow ni toques de borde | Ventana usable pedida en la imagen 2 |
| GAP-4 | SettingsView es vista apilada (Skills+Appearance+Providers+Budgets+Agents) sin modal ni X, con Presupuesto y botones grandes | No coincide con el diseno ni el pedido de quitar presupuesto |
| IS-5 | Todo el harness usa el mismo azul oscuro y botones compactos legibles | Coherencia visual pedida |
| GAP-5 | tokens.css es tema calido claro/oscuro generico, no el azul de las imagenes | El resto de ventanas desentona |
| IS-6 | Con API cargada todos los agentes usan el mismo barato auto; al reabrir workspace/sesion se restaura el ultimo modelo usado | Cero configuracion repetida y continuidad por sesion |
| GAP-6 | definitions tienen defaultModel fijo heterogeneo y no hay seleccion de barato ni memoria por sesion | El usuario debe configurar cada agente a mano |

### Must have
- Inicio objetivo, gating de paneles + terminal ligada, vacios como workspace, modal Ajustes con X y 2 secciones, sin rastro de Presupuesto, tema azul global, barato auto + memoria de sesion.
### Must NOT have (guardrails, anti-slop, scope boundaries)
- No nuevos proveedores/endpoints ni cambios de precios fuera de pricing existente; no retener Presupuesto en UI/core/IPC/state/docs (grep `budget` debe dar 0 salvo changelog y presupuestos de rendimiento de render `PERF_BUDGETS`/`budgetForPanel` en `renderer/src/perf.ts`, dominio ajeno al gasto); no parentesis "(API)" en Proveedores; no botones grandes ni modales con overflow; no defaults distintos por agente; no migracion de datos fuera de prefs/sesion.

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: tests-after + bun test / vitest existentes + QA de agente (happy + failure) por todo
- Evidence: .omo/evidence/octus-welcome-settings-theme/task-<N>.<ext> (capturas renderer + logs de invoke donde aplique)

## Execution strategy
### Parallel execution waves
- Wave 1: todos 1, 8 (tema base + bienvenida visual, independientes a nivel CSS/componente).
- Wave 2: todos 2, 3, 4, 5 (gating, vacios, modal, proveedores; tras tokens de Wave 1).
- Wave 3: todos 6, 7, 9 (agentes, retiro presupuesto, default barato; tras modal).
- Wave 4: todo 10 (regresion global) + Final verification wave.
### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | 8 (soft, solo tokens) | 4 | 8 |
| 2 | 8 | 10 | 3, 4, 5 |
| 3 | — | 10 | 2, 4, 5 |
| 4 | 1, 8 | 5, 6 | 2, 3, 5 |
| 5 | 4 | 9 | 2, 3, 4 |
| 6 | 4 | 9 | 7 |
| 7 | 4 | 10 | 6, 9 |
| 8 | — | 1, 2, 4 | 1 |
| 9 | 5, 6 | 10 | 7 |
| 10 | 1-9 | F1-F4 | — |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->
- [x] 1. Bienvenida Octus azul oscuro con pulpo y workspaces
  What to do / Must NOT do: Redisenar WelcomeView (fondo #23273a aprox. de imagen 1, logo pulpo blanco SVG inline, titulo Octus, botones Abrir Carpeta primario azul + Ajustes secundario, lista Workspaces con nombre+ruta y Ver mas). Mantener ids welcome-dropzone/welcome-pick/welcome-recents y flujos handlePath/openRecent/enterSessions. NO cambiar store ni IPC.
  Recommended task executor category: visual-engineering
  Closes: GAP-1
  Parallelization: Wave 1 | Blocked by: 8 | Blocks: 4
  References (executor has NO interview context - be exhaustive): apps/desktop/src/renderer/src/views/welcome.tsx (WelcomeView completo); apps/desktop/src/renderer/src/design/tokens.css; apps/desktop/src/renderer/src/styles.css (.welcome-card); imagen objetivo C:\Users\UserPy\Downloads\Pizza Egipto\Gemini_Generated_Image_klhn0lklhn0lklhn.jpg
  Acceptance criteria (agent-executable): bun test apps/desktop/test --filter welcome pasa; render welcome muestra logo, 2 botones y recents sin error.
  QA scenarios (name the exact tool + invocation): happy: abrir app sin proyecto, ver bienvenida objetivo (captura). failure: ruta ausente marca roto y deja elegir otro. Evidence .omo/evidence/octus-welcome-settings-theme/task-1.png
  Commit: N | feat(welcome): diseno inicio Octus azul oscuro
- [x] 2. Gating de paneles + terminal ligada al proyecto
  What to do / Must NOT do: En workbench los 3 toggles (sidebar/inspector/bottom) quedan disabled sin activeProjectId y se activan al seleccionar workspace/sesion; el tab terminal crea/selecciona PTY con CWD del proyecto (TerminalService resolveRoot). Mantener atajos Ctrl+B/J/I y layout.set. NO tocar resolucion de root fuera del proyecto activo.
  Recommended task executor category: deep-low
  Closes: GAP-2
  Parallelization: Wave 2 | Blocked by: 8 | Blocks: 10
  References (executor has NO interview context - be exhaustive): apps/desktop/src/renderer/src/views/workbench.tsx (ActivityBar toggles, BottomPanel); apps/desktop/src/renderer/src/views/terminal-panel.tsx (create/select/resync); apps/desktop/src/main/terminal-service.ts; packages/shared/src/layout.ts (DEFAULT_LAYOUT, toggle*)
  Acceptance criteria (agent-executable): sin proyecto los 3 toggles tienen disabled; con proyecto se habilitan y terminal.create usa rootPath del proyecto.
  QA scenarios (name the exact tool + invocation): happy: abrir workspace y pulsar toggles + crear terminal (captura). failure: sin proyecto los toggles no abren nada. Evidence .omo/evidence/octus-welcome-settings-theme/task-2.png
  Commit: N | feat(workbench): gating de paneles y terminal por workspace
- [x] 3. Directorios vacios como workspace normal
  What to do / Must NOT do: Permitir drop y pick de carpetas vacias: en welcome pathsFromDrop aceptar DataTransferItem.webkitGetAsEntry/directory handle cuando files viene vacio; main checkDirectoryReadable sigue aceptando legible aunque este vacia (NO anadir chequeo de vaciedad); projects.create igual. Mensaje "soltado vacio" solo si de verdad no hay ruta.
  Recommended task executor category: deep-low
  Closes: GAP-3
  Parallelization: Wave 2 | Blocked by: — | Blocks: 1, 10
  References (executor has NO interview context - be exhaustive): apps/desktop/src/renderer/src/views/welcome.tsx (pathsFromDrop, onDrop); apps/desktop/src/main/validate-directory.ts (checkDirectoryReadable); apps/desktop/src/main/index.ts (app.validateDirectory, projects.create)
  Acceptance criteria (agent-executable): soltar carpeta vacia crea/selecciona workspace sin error; bun test de validate-directory pasa.
  QA scenarios (name the exact tool + invocation): happy: arrastrar vacia y abrir sin sesion. failure: soltar fuera (texto) mantiene error honesto. Evidence .omo/evidence/octus-welcome-settings-theme/task-3.log
  Commit: N | fix(welcome): aceptar directorios vacios como workspace
- [x] 4. Modal Ajustes con X y secciones Proveedores/Agentes
  What to do / Must NOT do: Convertir SettingsView en modal centrado (overlay, max-width, margen top/bottom sin tocar bordes, scroll interno) con cabecera Ajustes + boton X que cierra a bienvenida/vista anterior; nav lateral con 2 secciones seleccionables (Proveedores, Agentes). Quitar Skills/Appearance/Project de este modal (quedan donde esten o se ocultan). NO una sola ventana apilada.
  Recommended task executor category: visual-engineering
  Closes: GAP-4 (parte)
  Parallelization: Wave 2 | Blocked by: 1, 8 | Blocks: 5, 6
  References (executor has NO interview context - be exhaustive): apps/desktop/src/renderer/src/views/settings.tsx (SettingsView); apps/desktop/src/renderer/src/views/welcome.tsx (mode settings); imagen objetivo C:\Users\UserPy\Downloads\Pizza Egipto\Gemini_Generated_Image_shdeoushdeoushde.jpg
  Acceptance criteria (agent-executable): el modal abre desde Ajustes, la X lo cierra, click en cada seccion carga su panel, sin overflow (scrollHeight<=clientHeight+1).
  QA scenarios (name the exact tool + invocation): happy: abrir/cerrar y cambiar de seccion (capturas). failure: Esc/X con cambios sin guardar no rompe estado. Evidence .omo/evidence/octus-welcome-settings-theme/task-4.png
  Commit: N | feat(settings): modal por secciones con cierre X
- [x] 5. Seccion Proveedores sin parentesis y botones compactos
  What to do / Must NOT do: Titulo "Proveedores" (sin "(API)"), cards por proveedor con input password + Save key/Remove/Test compactos en fila, details Models(n). Al guardar key, dispara recalculo del default barato (todo 9). NO cambiar adaptadores.
  Recommended task executor category: deep-low
  Closes: GAP-4 (parte)
  Parallelization: Wave 2 | Blocked by: 4 | Blocks: 9
  References (executor has NO interview context - be exhaustive): apps/desktop/src/renderer/src/views/sections.tsx (ProviderSettings); apps/desktop/src/renderer/src/store/settings.ts (reloadProviders); packages/shared/src/model.ts (ProviderDescriptor)
  Acceptance criteria (agent-executable): sin "(API)" en la vista; botones en una fila sin wrap en 1280px; setKey+reloadProviders funciona.
  QA scenarios (name the exact tool + invocation): happy: pegar key, Save, Test OK. failure: key vacia no invoca. Evidence .omo/evidence/octus-welcome-settings-theme/task-5.png
  Commit: N | feat(settings): seccion Proveedores compacta
- [x] 6. Seccion Agentes sin presupuesto y con defaults visibles
  What to do / Must NOT do: Lista de definitions con provider/modelo/effort y Save model compacto; quitar cualquier card de presupuesto/limites monetarios de esta vista. Mantener agents.setDefinitionModel. NO tocar DAG de tareas.
  Recommended task executor category: deep-low
  Closes: GAP-4 (parte)
  Parallelization: Wave 3 | Blocked by: 4 | Blocks: 9
  References (executor has NO interview context - be exhaustive): apps/desktop/src/renderer/src/views/settings.tsx (AgentSettings); apps/desktop/src/renderer/src/views/agents.tsx; packages/core/src/agents/*
  Acceptance criteria (agent-executable): cero menciones a budget en la vista; guardar modelo por definicion persiste.
  QA scenarios (name the exact tool + invocation): happy: cambiar modelo de un agente y recargar. failure: provider/modelo vacios muestran error. Evidence .omo/evidence/octus-welcome-settings-theme/task-6.png
  Commit: N | feat(settings): seccion Agentes sin presupuesto
- [x] 7. Retiro completo de Presupuesto UI+core+IPC
  What to do / Must NOT do: Eliminar BudgetSettings de settings/sections, estado budgets/budgetUsage, IPC budgets.status/configure, enforcement en core (costs/budgets) dejando llamadas sin gate de pago + aviso en plan de que el bloqueo desaparece. Actualizar tests/docs que exijan budgets. NO dejar imports muertos.
  Recommended task executor category: deep-low
  Closes: GAP-4 (parte)
  Parallelization: Wave 3 | Blocked by: 4 | Blocks: 10
  References (executor has NO interview context - be exhaustive): apps/desktop/src/renderer/src/views/sections.tsx (BudgetSettings); apps/desktop/src/renderer/src/store/* (budgets); apps/desktop/src/main/index.ts (budgets.*); packages/core/src/costs/*; packages/shared/src/costs.ts
  Acceptance criteria (agent-executable): grep -ri budget en apps/desktop/src packages/core/src packages/shared/src devuelve 0 salvo changelog y presupuestos de rendimiento de render (perf.ts); bun test pasa.
  QA scenarios (name the exact tool + invocation): happy: sin budgets la app arranca y genera sin bloqueo. failure: documentar que ya no hay tope de gasto. Evidence .omo/evidence/octus-welcome-settings-theme/task-7.log
  Commit: N | chore(budgets): retiro completo del sistema de presupuesto
- [x] 8. Tema azul oscuro global y botones compactos
  What to do / Must NOT do: Redefinir tokens.css (fondo #23273a/#1f2433, panel #2a3042, texto #e8eaf0, acento #2f7fe0) y alinear styles.css + oc-components.css (botones padding compacto, radios, cards con gap a bordes). Aplicar a bienvenida, modal, workbench, terminal, agentes. NO tocar logica.
  Recommended task executor category: visual-engineering
  Closes: GAP-5
  Parallelization: Wave 1 | Blocked by: — | Blocks: 1, 2, 4
  References (executor has NO interview context - be exhaustive): apps/desktop/src/renderer/src/design/tokens.css; apps/desktop/src/renderer/src/styles.css; apps/desktop/src/renderer/src/components/oc-components.css
  Acceptance criteria (agent-executable): sin literales fuera de tokens; contraste texto/fondo AA; botones sin gigantismo en capturas.
  QA scenarios (name the exact tool + invocation): happy: recorrer bienvenida/modal/workbench con el mismo fondo. failure: tema light/system no se rompe al degradar. Evidence .omo/evidence/octus-welcome-settings-theme/task-8.png
  Commit: N | feat(theme): azul oscuro global y botones compactos
- [x] 9. Default barato auto + memoria por sesion/workspace
  What to do / Must NOT do: Al cargar una key (providers.setKey) elegir el modelo toolCall mas barato segun pricing.ts y aplicarlo igual a todas las definitions; guardar ultimo modelo por sesion/workspace (kv o campo sesion) y restaurarlo al reabrir ese workspace/sesion, prevaleciendo sobre el barato.
  Recommended task executor category: deep-low
  Closes: GAP-6
  Parallelization: Wave 3 | Blocked by: 5, 6 | Blocks: 10
  References (executor has NO interview context - be exhaustive): packages/core/src/providers/pricing.ts; packages/core/src/providers/model-router.ts; packages/core/src/agents/*; apps/desktop/src/renderer/src/store/settings.ts; packages/shared/src/model.ts
  Acceptance criteria (agent-executable): con 1 key todas las definitions comparten el mismo barato; reabrir sesion restaura su ultimo modelo.
  QA scenarios (name the exact tool + invocation): happy: cargar key y verificar default unico; cambiar modelo, salir, reentrar y ver restaurado. failure: sin keys no hay default y la UI lo dice. Evidence .omo/evidence/octus-welcome-settings-theme/task-9.log
  Commit: N | feat(agents): default barato unico con memoria de sesion
- [x] 10. Regresion global y evidencias
  What to do / Must NOT do: Correr bun test + typecheck del desktop, abrir bienvenida/modal/workbench/terminal con el tema, verificar gating, vacios, cierre X, ausencia de budget y default barato. Juntar capturas/logs en .omo/evidence/octus-welcome-settings-theme/. NO implementar nada nuevo.
  Recommended task executor category: unspecified-high
  Closes: GAP-1..GAP-6 (cierre)
  Parallelization: Wave 4 | Blocked by: 1-9 | Blocks: F1-F4
  References (executor has NO interview context - be exhaustive): scripts/verify-*.mjs y qa-*.mjs existentes; .omo/plans/octus-welcome-settings-theme.md
  Acceptance criteria (agent-executable): bun test verde (o fallos preexistentes listados) y checklist manual 100% en la evidencia.
  QA scenarios (name the exact tool + invocation): happy + failure de cada IS en una pasada. Evidence .omo/evidence/octus-welcome-settings-theme/task-10.md
  Commit: N | test(harness): regresion del rediseno

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [x] F1. Plan compliance audit (re-auditoria tras gaps 11-14: APPROVE)
- [x] F2. Code quality review
- [x] F3. Real manual QA (APPROVE a+b; gap conocido: OS-level file-drop [~])
- [x] F4. Ideal-state fidelity

## Follow-up gaps (F1 audit)
- [x] 11. Normalizar vocabulario de veredictos (todos 2 y 10)
  What to do: re-registrar en ledger los veredictos `confirmed-notes-only` (todo 2) y `pass-with-caveats` (todo 10) como `confirmed` con caveats roteados a F3, o enmendar el plan para admitirlos. Sin codigo.
  Recommended task executor category: quick
  Closes: F1-gap-11
  References: .omo/ulw-execute/ledger.jsonl, .omo/plans/octus-welcome-settings-theme.md
  Acceptance criteria: F1 re-auditoria lee vocabulario admitido.
  QA scenarios: ledger grep muestra entradas normalizadas. Evidence .omo/evidence/octus-welcome-settings-theme/task-11.log
  Commit: N | chore(plan): normaliza vocabulario de veredictos
- [x] 12. Conformidad literal cero-budget (admitir render-perf)
  What to do: dado que F2/F4 acotan `PERF_BUDGETS` como dominio ajeno, la aceptacion del todo 7 ya enmendada arriba lo admite; re-correr el grep gate y adjuntar salida. Sin codigo salvo que el grep halle gasto real.
  Recommended task executor category: quick
  Closes: F1-gap-12
  References: apps/desktop/src/renderer/src/perf.ts, .omo/evidence/octus-welcome-settings-theme/task-7.log
  Acceptance criteria: grep `budget` solo hits de render-perf + guards de ausencia.
  QA scenarios: grep transcript. Evidence .omo/evidence/octus-welcome-settings-theme/task-12.log
  Commit: N | chore(plan): conformidad grep budget
- [x] 13. Resolver contradiccion matriz-vs-waves
  What to do: matriz ya enmendada arriba (1 soft-depende 8; 3 bloquea solo 10). Re-auditar consistencia en F1. Sin codigo.
  Recommended task executor category: quick
  Closes: F1-gap-13
  References: .omo/plans/octus-welcome-settings-theme.md (Dependency matrix)
  Acceptance criteria: F1 re-auditoria sin contradiccion.
  QA scenarios: lectura de matriz vs waves. Evidence .omo/evidence/octus-welcome-settings-theme/task-13.log
  Commit: N | chore(plan): matriz consistente
- [x] 14. Gatear atajos de teclado sin proyecto
  What to do / Must NOT do: en App.tsx el keydown (Ctrl+B/J, Ctrl+Alt+I) debe no-op sin `state.activeProjectId`, igual que los toggles deshabilitados. Mantener Ctrl+0 y Alt+1..6. NO tocar layout ni toggles.
  Recommended task executor category: quick
  Closes: F1-gap-14 (producto)
  Parallelization: con F3 | Blocked by: 2 | Blocks: F1-F4
  References (executor has NO interview context - be exhaustive): apps/desktop/src/renderer/src/App.tsx (onKeyDown); apps/desktop/src/renderer/src/store/state.ts (activeProjectId)
  Acceptance criteria (agent-executable): sin proyecto los atajos no mutan layout; con proyecto funcionan; bun test apps/desktop/test verde + typecheck.
  QA scenarios (name the exact tool + invocation): happy: con proyecto Ctrl+B alterna; failure: sin proyecto no-op. Evidence .omo/evidence/octus-welcome-settings-theme/task-14.log
  Commit: N | feat(workbench): atajos gateados por proyecto

## Commit strategy

## Success criteria
> One row per IS row. The plan is complete only when every IS row has a delivering todo and a proving QA scenario; F4 checks the delivered behavior against these rows 1:1, and a shortfall becomes new `- [ ] N.` rows, never a note.
| IS | Delivering todo(s) | Proving QA scenario | Evidence |
| --- | --- | --- | --- |
| IS-1 | 1, 8 | bienvenida objetivo | .omo/evidence/octus-welcome-settings-theme/task-1.png |
| IS-2 | 2 | gating + terminal ligada | .omo/evidence/octus-welcome-settings-theme/task-2.png |
| IS-3 | 3 | vacio como workspace | .omo/evidence/octus-welcome-settings-theme/task-3.log |
| IS-4 | 4, 5, 6, 7 | modal con X sin presupuesto | .omo/evidence/octus-welcome-settings-theme/task-4.png |
| IS-5 | 8 | tema azul global | .omo/evidence/octus-welcome-settings-theme/task-8.png |
| IS-6 | 9 | barato auto + memoria | .omo/evidence/octus-welcome-settings-theme/task-9.log |

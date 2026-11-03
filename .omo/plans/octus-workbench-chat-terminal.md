# octus-workbench-chat-terminal - Work Plan

## TL;DR (For humans)
<!-- Fill this LAST, after the detailed plan below is written, so it summarizes the REAL plan. -->
<!-- Plain English for a non-engineer: NO file paths, NO todo numbers, NO wave/agent/tool names. -->

**Who this is for and what changes for them:** Para ti operando el harness: abrirás cualquier carpeta como proyecto, navegarás sesiones por proyecto, y verás un chat limpio con terminal real debajo.

**What you'll get:** Alta de vacías cerrada, sidebar estilo screenshot, chat opencode con footers de tiempo+tokens, terminal xterm y tareas programadas con su ventana.

**Why this approach:** Todo renderer-local salvo programadas (único backend nuevo aislado) y footer (link aditivo); contrato IPC de terminal intacto y TaskScheduler sin tocar.

**What it will NOT do:** No reescribe el chat, no toca el scheduler DAG, no mete secretos al renderer, no cambia el tema navy.

**Effort:** XL
<!-- Effort is exactly ONE band, never hours/days. Quick = single edit, minutes of agent work; Short = one focused change, a few files; Medium = multi-file feature in one session; Large = several waves, one long session; XL = multi-session or architectural work. A written duration is rewritten to a band. -->
**Risk:** High - programadas es backend nuevo (timers, timezones, missed-runs) + xterm suma dependencia pesada.
**Decisions to sanity-check:** Base auto `scheduled_tasks` en dir usuario; link `message_id` aditivo; xterm con contrato congelado.

Your next move: high-accuracy review (plan-reviewer) y luego /ulw-execute. Full execution detail follows below.

---

> TL;DR (machine): XL, High (cron nuevo + xterm), sidebar+chat+terminal+programadas listos para ejecutar

## Scope
### Affected user and ideal state
<!-- From the draft ledger: who this touches and how they use the result, then one IS row per property with its reason, then one GAP row per difference with its reason. Every todo below closes a GAP row; ## Success criteria proves every IS row. -->
**Affected user:** Dueno del harness Octus que abre carpetas como proyectos, trabaja con sesiones de agentes plan/build, usa terminal y MCP, y quiere programar tareas. Hoy el alta de carpetas falla en algun path, el chat muestra cuadros aun vacio, la terminal es pre+botones y no hay programadas.

| Row | Statement | Reason |
| --- | --- | --- |
| IS-1 | Carpeta (vacia o no) via drop/picker/reciente abre proyecto funcional con sesiones y explorador | El flujo base no puede fallar |
| GAP-1 | Algun path de alta reporta proyecto vacio o no agrega; drop de vacias ya tocado pero el flujo completo no esta cerrado | Bloquea arrancar |
| IS-2 | Sidebar con proyectos, sesiones por proyecto (verde la activa/trabajando), Nueva sesion, Tareas programadas y MCP dot verde si hay activo (click abre MCP) | Navegacion estilo screenshot |
| GAP-2 | ExplorerPanel es plano (proyectos + sesiones del proyecto activo), sin programadas ni MCP dot | Falta el panel pedido |
| IS-3 | Chat limpio en sesion nueva (cero cuadros); burbuja usuario gris, agente normal; subagentes/herramientas aparecen SOLO mientras el agente trabaja, colapsables | Exigencia explicita del usuario |
| GAP-3 | ChatView pinta 11 secciones incondicionales aun vacia; tool calls sin agrupacion por subagente | Ruido desde el inicio |
| IS-4 | Cada respuesta del agente muestra fuera del mensaje tiempo y tokens totales de la peticion | Control de coste/tiempo por respuesta |
| GAP-4 | UsageRecord existe pero sin vista por mensaje (solo details global) | Dato sin mostrar |
| IS-5 | Modelo y esfuerzo bajo el input; esfuerzo solo si el modelo lo soporta | Como el screenshot |
| GAP-5 | Composer con provider+modelo arriba del Send, sin esfuerzo | Falta el picker pedido |
| IS-6 | Terminal real (xterm, cmd/PowerShell) como pestana bajo el centro, sin botones Enviar/Cancelar | Como Antigravity/cualquier terminal |
| GAP-6 | TerminalPanel es pre + input + Enviar/Cancelar | No es una terminal real |
| IS-7 | Tareas programadas con ventana de configuracion; base auto `scheduled_tasks` (ingles) en dir usuario; cada tarea = sesion nueva de esa carpeta | Feature pedida con semantica exacta |
| GAP-7 | No existe nada de programadas (solo DAG interno, otro concepto) | Feature nueva completa |

### Must have
- Vacios como proyecto en los 3 paths, sidebar pedida, chat limpio con actividad solo-en-trabajo, footer tiempo+tokens, picker modelo+esfuerzo, xterm inferior, programadas con base auto y sesion por tarea.
### Must NOT have (guardrails, anti-slop, scope boundaries)
- No reescribir el chat (extender ToolCallCard/timeline); no tocar contrato IPC de terminal ni TaskScheduler/tablas DAG; no secretos en renderer; no shell-guard en keystrokes de usuario; no migrar layouts; no tema claro (se mantiene navy por decision).

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: tests-after + bun test / vitest existentes + QA de agente (happy + failure) por todo
- Evidence: .omo/evidence/octus-workbench-chat-terminal/task-<N>.<ext> (capturas renderer + logs de invoke donde aplique)

## Execution strategy
### Parallel execution waves
- Wave 1: todo 1 (fix vacios, cierra el alta antes de todo lo demas).
- Wave 2: todos 2 (sidebar), 6 (xterm) — archivos disjuntos.
- Wave 3: todos 4 (footer tiempo+tokens), 7 (programadas core) — capas distintas.
- Wave 4: todos 3 (chat limpio+subagentes), 5 (picker bajo input), 8 (ventana programadas) — hunks disjuntos en chat.tsx con rebase; 8 tras canales del 7.
- Wave 5: todo 9 (regresion) + Final verification wave.
### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | — | 2, 9 | — |
| 2 | 1 | 9 | 6 |
| 3 | 4, 5 | 9 | 5, 8 (rebase) |
| 4 | — | 3, 9 | 7 |
| 5 | — | 3, 9 | 3, 8 (rebase) |
| 6 | — | 9 | 2 |
| 7 | — | 8, 9 | 4 |
| 8 | 7 | 9 | 3, 5 |
| 9 | 1-8 | F1-F4 | — |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->
- [x] 1. Carpeta vacia abre proyecto funcional en los 3 paths
  What to do / Must NOT do: Diagnosticar y cerrar el alta completa: drop, picker nativo y recientes deben crear/abrir proyecto con sesiones y explorador aunque la carpeta este vacia. Distinguir empty-drop (sin ruta: error honesto) de empty-folder (ruta valida: aceptar). Extender el fix previo de pathsFromDrop si el fallo esta en pickNative/openRecent/createProject. NO anadir chequeos de vaciedad en main.
  Recommended task executor category: deep-low
  Closes: GAP-1
  Parallelization: Wave 1 | Blocked by: — | Blocks: 2, 9
  References: apps/desktop/src/renderer/src/views/welcome.tsx (pathsFromDrop/handlePath/pickNative/openRecent); apps/desktop/src/main/validate-directory.ts; apps/desktop/src/main/index.ts (app.validateDirectory/projects.create); apps/desktop/test/validate-directory.test.ts
  Acceptance criteria: carpeta vacia por drop, picker y reciente abre proyecto con explorador; texto soltado sigue con error honesto; bun test apps/desktop/test verde.
  QA scenarios: happy: alta vacia por los 3 paths (log). failure: ruta ausente marca roto. Evidence .omo/evidence/octus-workbench-chat-terminal/task-1.log
  Commit: N | fix(welcome): vacias como proyecto en todos los paths
- [x] 2. Sidebar proyectos, sesiones, programadas y MCP dot
  What to do / Must NOT do: Rehacer ExplorerPanel: secciones por proyecto con sus sesiones (punto verde en la sesion activa o con agente trabajando), boton Nueva sesion (crea sesion del proyecto seleccionado), seccion Tareas programadas (abre ventana del todo 8; contador), fila MCP con dot verde si hay servidor activo (click abre vista MCP). Mantener ids session-list/session-new y selectProject/selectSession/createSession. NO tocar store de MCP salvo lectura.
  Recommended task executor category: visual-engineering
  Closes: GAP-2
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 9
  References: apps/desktop/src/renderer/src/views/workbench.tsx (ExplorerPanel, ThreadsPanel, SkillsMcpPanel); apps/desktop/src/renderer/src/store/projects.ts; apps/desktop/src/renderer/src/store/mcp.ts (McPServerSummary connection); apps/desktop/src/renderer/src/views/mcp.tsx; tokens navy vigentes
  Acceptance criteria: sidebar como screenshot en navy; verde solo activa/trabajando; MCP dot refleja estado real; tests + typecheck verdes.
  QA scenarios: happy: navegar proyectos/sesiones, crear sesion, click MCP (capturas). failure: sin proyecto, Nueva sesion deshabilitada. Evidence .omo/evidence/octus-workbench-chat-terminal/task-2.png
  Commit: N | feat(sidebar): sesiones por proyecto, programadas y MCP dot
- [x] 3. Chat limpio con subagentes colapsables solo en trabajo
  What to do / Must NOT do: Ocultar las 11 secciones (Plans/Tasks/Worktrees/Integrations/Dag/Diff/History/Memory/Agents/RunErrors/ModifiedFiles) cuando la sesion esta vacia (sin mensajes ni runs): no pintar ni siquiera el details; al haber actividad, colapsadas por defecto. Burbuja usuario fondo gris claro, agente normal. Agrupar tool calls por subagente (buildSubagentTree sobre parentInstanceId, colapsado depth>=1, pill de estado rollup) reutilizando ToolCallCard. REGLA DURA: en sesion nueva, cero cuadros; la actividad aparece SOLO mientras el agente trabaja. Hunk en chat.tsx limitado a secciones/MessageView; rebase sobre 4/5 si aterrizan antes.
  Recommended task executor category: visual-engineering
  Closes: GAP-3
  Parallelization: Wave 4 | Blocked by: 4, 5 | Blocks: 9
  References: apps/desktop/src/renderer/src/views/chat.tsx (ChatView secciones, MessageView); apps/desktop/src/renderer/src/toolcall-widgets.tsx (ToolCallCard); packages/shared/src/conversation-widgets.ts; C:\Users\UserPy\Desktop\Screenshot_3.png
  Acceptance criteria: sesion nueva = timeline vacio + composer, 0 details; con trabajo, grupos colapsables por subagente; tests (incl. settings-modal) verdes.
  QA scenarios: happy: sesion nueva limpia + sesion con trabajo colapsable (capturas). failure: run fallido muestra grupo en tono error sin romper. Evidence .omo/evidence/octus-workbench-chat-terminal/task-3.png
  Commit: N | feat(chat): limpio con subagentes colapsables
- [x] 4. Footer tiempo y tokens por respuesta del agente
  What to do / Must NOT do: Anadir `messageId?` nullable a UsageRecord (migracion aditiva, NULL = sin footer), threadearlo desde appendMessageWithId hasta ModelRouter.generateStream/recordUsage; helper puro footerForMessage(messageId, records) con totales + duracion + estado + coste o "unpriced"; footer bajo cada MessageView assistant (fuera de la burbuja) estilo screenshot (7.3s 224.2k tok). JAMAS sumar todo el run en una burbuja. Reutilizar runs.usage, sin canal nuevo.
  Recommended task executor category: deep-low
  Closes: GAP-4
  Parallelization: Wave 3 | Blocked by: — | Blocks: 3, 9
  References: packages/shared/src/costs.ts (UsageRecord); packages/core/src/costs/usage.ts; packages/core/src/providers/model-router.ts; packages/core/src/runtime/agent-runtime.ts (appendMessageWithId); apps/desktop/src/renderer/src/views/chat.tsx (MessageView); packages/shared/src/ipc.ts (runs.usage)
  Acceptance criteria: footer exacto por mensaje (multi-attempt suma filas del mensaje); legacy NULL sin footer; unit test del helper + flujo; suites verdes.
  QA scenarios: happy: respuesta con footer correcto (captura+log). failure: fila cancelled muestra tono + pricingMissing dice unpriced. Evidence .omo/evidence/octus-workbench-chat-terminal/task-4.log
  Commit: N | feat(chat): footer tiempo+tokens por respuesta
- [x] 5. Modelo y esfuerzo bajo el input
  What to do / Must NOT do: Extraer ModelPicker bajo el Composer: chips/selector de perfil (plan/build), provider, modelo y esfuerzo (select de esfuerzo SOLO si el modelo publica reasoningEfforts no vacios). Reutilizar providerId/providerModels/loadModels/setSessionModel/setProfile y defaults baratos del plan anterior. Hunk limitado al Composer; rebase sobre 3/4 si hace falta.
  Recommended task executor category: deep-low
  Closes: GAP-5
  Parallelization: Wave 4 | Blocked by: — | Blocks: 3, 9
  References: apps/desktop/src/renderer/src/views/chat.tsx (Composer); apps/desktop/src/renderer/src/store/projects.ts (loadModels/setSessionModel); packages/shared/src/model.ts (reasoningEfforts)
  Acceptance criteria: picker bajo input como screenshot; esfuerzo oculto si el modelo no lo soporta; cambio persiste por sesion; tests verdes.
  QA scenarios: happy: cambiar modelo+esfuerzo (captura). failure: modelo sin efforts no muestra select. Evidence .omo/evidence/octus-workbench-chat-terminal/task-5.png
  Commit: N | feat(chat): picker modelo+esfuerzo bajo input
- [x] 6. Terminal xterm como pestana inferior
  What to do / Must NOT do: Sustituir el render `<pre>` de TerminalPanel por xterm.js + FitAddon manteniendo BYTE-IDENTICO el contrato IPC (create/list/write/read/resize/kill/close/select + TERMINAL_DATA_CHANNEL) y la politica PTY en main (cwd pineado, killTree, shell cmd/PowerShell por plataforma). Mapear appendChunk/noteSeen/resync/gap-append-only sobre term.write; resize con debounce; scrollback 2000; quitar botones Enviar/Cancelar por entrada directa de teclado; tabs por terminal. NO tocar terminal-service.ts salvo bug probado.
  Recommended task executor category: visual-engineering
  Closes: GAP-6
  Parallelization: Wave 2 | Blocked by: — | Blocks: 9
  References: apps/desktop/src/renderer/src/views/terminal-panel.tsx; apps/desktop/src/main/terminal-service.ts; packages/shared/src/ipc.ts (terminal.*); apps/desktop/src/renderer/src/design/pty-weight-note.md; panel inferior workbench.tsx
  Acceptance criteria: terminal interactiva real (eco, comandos, ANSI, resize, kill+reinicio con marcador); pestana bajo el centro; typecheck + tests verdes.
  QA scenarios: happy: sesion de shell real con prompt del proyecto (captura). failure: kill muestra marcador y re-spawnea; write en exited avisa. Evidence .omo/evidence/octus-workbench-chat-terminal/task-6.png
  Commit: N | feat(terminal): xterm real bajo el centro
- [x] 7. Tareas programadas: core, IPC y base auto
  What to do / Must NOT do: Nuevo ScheduledTasksManager (NO tocar TaskScheduler ni tablas DAG): migracion con `scheduled_tasks` + `scheduled_runs` (FKs cascade, next_run_at solo-escritura del manager), validacion cron 5 campos, tickDue mutex con overlap=skipped_overlap + auto-disable tras 5 fallos, timer en main (30s + al arrancar), canales `schedules.list/create/setEnabled/remove` (+ due en tasks.scheduler), eventos schedule.*. Base: dir usuario + carpeta auto `scheduled_tasks` (ingles) creada al primer uso; cada tarea corre como sesion nueva (sessions.prompt equivalente) de esa carpeta. NO catch-up en espiral (max 1 disparo por tick).
  Recommended task executor category: deep-low
  Closes: GAP-7 (parte)
  Parallelization: Wave 3 | Blocked by: — | Blocks: 8, 9
  References: packages/core/src/persistence/schema.ts; packages/core/src/tasks/task-scheduler.ts (patron tick, NO reutilizar); packages/core/src/sessions/octus-core.ts; packages/shared/src/ipc.ts; apps/desktop/src/main/index.ts
  Acceptance criteria: CRUD + disparo por cron con fake clock en tests; overlap salta; dir auto creado; suites core verdes.
  QA scenarios: happy: crear tarea cada minuto y ver run disparado (log). failure: cron invalido rechazado; overlap registra skipped. Evidence .omo/evidence/octus-workbench-chat-terminal/task-7.log
  Commit: N | feat(schedules): programadas con base auto
- [x] 8. Ventana de programadas y seccion sidebar
  What to do / Must NOT do: Store schedules.ts + seccion sidebar (lista, enabled toggle, proxima ejecucion) + ventana/modal de configuracion (nombre, prompt, perfil, cron, timezone, enabled) + historial de disparos; reutilizar patrones TasksSection/RunErrorsSection. Depende de los canales del 7; si el 7 no aterrizo, mockear IPC con tipos exactos y marcar pendiente.
  Recommended task executor category: visual-engineering
  Closes: GAP-7 (parte)
  Parallelization: Wave 4 | Blocked by: 7 | Blocks: 9
  References: apps/desktop/src/renderer/src/views/workbench.tsx; apps/desktop/src/renderer/src/store/tasks.ts (patron); canales schedules.* del todo 7
  Acceptance criteria: CRUD completo desde UI contra canales reales; validacion visible de cron; tests verdes.
  QA scenarios: happy: crear/editar/deshabilitar + ver historial (capturas). failure: cron invalido muestra error sin guardar. Evidence .omo/evidence/octus-workbench-chat-terminal/task-8.png
  Commit: N | feat(schedules): ventana de configuracion
- [x] 9. Regresion global y evidencias
  What to do / Must NOT do: bun test + typechecks + build, checklist IS-1..IS-7 con prueba por item (incl. intento Electron en vivo para welcome/modal/workbench/terminal), grep budget conforme a la regla vigente, cero `(API)`. Juntar todo en task-9.md. NO implementar nada nuevo.
  Recommended task executor category: unspecified-high
  Closes: GAP-1..GAP-7 (cierre)
  Parallelization: Wave 5 | Blocked by: 1-8 | Blocks: F1-F4
  References: scripts/verify-*.mjs y qa-*.mjs; .omo/evidence/octus-workbench-chat-terminal/
  Acceptance criteria: suites verdes (o preexistentes listados) y checklist 100% en evidencia.
  QA scenarios: happy + failure por IS. Evidence .omo/evidence/octus-workbench-chat-terminal/task-9.md
  Commit: N | test(harness): regresion workbench-chat-terminal

- [x] 10. Fix carga de ajustes MCP (handlers mcp.* ausentes en main)
  What to do / Must NOT do: Diagnosticar y reparar el error al cargar ajustes MCP: el renderer invoca `mcp.list/add/verify/connect/...` por el puente dinamico pero `apps/desktop/src/main/` tiene CERO referencias MCP (sin handlers). Cablear canales `mcp.*` en main/index.ts (CHANNELS + handlers con validacion de emisor y carga) delegando a `packages/core/src/mcp/mcp-client-manager.ts` y `mcp-server-management.ts`. Anadir canales tipados solo si el contrato lo exige; si el puente dinamico es el patron vigente, documentarlo. NO exponer secretos al renderer (solo hasSecret). NO romper skills.* ni terminal.*.
  Recommended task executor category: deep-low
  Closes: ajuste pedido en ejecucion (fuera del plan original)
  Parallelization: Wave 1 | Blocked by: — | Blocks: 2 (MCP dot)
  References: apps/desktop/src/renderer/src/store/mcp.ts (createIpcMcpClient); apps/desktop/src/renderer/src/views/mcp.tsx; apps/desktop/src/main/index.ts (CHANNELS/handlers); apps/desktop/src/main/skills-service.ts (patron); packages/core/src/mcp/mcp-client-manager.ts; packages/core/src/mcp/mcp-server-management.ts
  Acceptance criteria: abrir ajustes MCP carga lista sin error; verify/connect contra test-double verde; suites afectadas verdes.
  QA scenarios: happy: MCP carga y lista (captura+log). failure: backend caido muestra aviso con reintento, sin inventar datos. Evidence .omo/evidence/octus-workbench-chat-terminal/task-10.log
  Commit: N | fix(mcp): cablear handlers mcp.* en main

- [x] 11. Fix persist de layout tras drag-resize (structured clone)
  What to do / Must NOT do: Tras drag-resize aparece `An object could not be cloned`: saveWorkbenchLayout/persistLayout envia el proxy del store Solid por contextBridge en `layout.set`. Serializar a POJO (structured-clone-safe) antes del invoke en prefsLayout.ts (o punto equivalente), manteniendo redimension en memoria. NO cambiar comportamiento de layout.
  Recommended task executor category: quick
  Closes: hallazgo F3-1
  References: apps/desktop/src/renderer/src/store/prefsLayout.ts (persistLayout/saveWorkbenchLayout); apps/desktop/src/renderer/src/views/workbench.tsx (ResizeHandle); .omo/evidence/octus-workbench-chat-terminal/task-F3-e-terminal.png
  Acceptance criteria: drag-resize persiste sin banner rojo tras reload; tests + typecheck verdes.
  QA scenarios: happy: resize + reload conserva (log). failure: payload siempre clonable. Evidence .omo/evidence/octus-workbench-chat-terminal/task-11.log
  Commit: N | fix(layout): persist clonable tras resize

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [x] F1. Plan compliance audit
- [x] F2. Code quality review
- [x] F3. Real manual QA
- [x] F4. Ideal-state fidelity

## Commit strategy

## Success criteria
> One row per IS row. The plan is complete only when every IS row has a delivering todo and a proving QA scenario; F4 checks the delivered behavior against these rows 1:1, and a shortfall becomes new `- [ ] N.` rows, never a note.
| IS | Delivering todo(s) | Proving QA scenario | Evidence |
| --- | --- | --- | --- |
| IS-1 | 1 | alta vacia 3 paths | .omo/evidence/octus-workbench-chat-terminal/task-1.log |
| IS-2 | 2 | sidebar screenshot | .omo/evidence/octus-workbench-chat-terminal/task-2.png |
| IS-3 | 3 | chat limpio + grupos | .omo/evidence/octus-workbench-chat-terminal/task-3.png |
| IS-4 | 4 | footer por mensaje | .omo/evidence/octus-workbench-chat-terminal/task-4.log |
| IS-5 | 5 | picker bajo input | .omo/evidence/octus-workbench-chat-terminal/task-5.png |
| IS-6 | 6 | xterm real | .omo/evidence/octus-workbench-chat-terminal/task-6.png |
| IS-7 | 7, 8 | tarea disparada + ventana | .omo/evidence/octus-workbench-chat-terminal/task-7.log |

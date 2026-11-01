# Especificación UX: conversación, Agent Manager, Skills y MCP (Todo 4)

- **Plan:** `.omo/plans/octus-ux-skills-mcp.md`, Todo 4, ola 7 (diseño)
- **Rama:** `feat/ux-skills-mcp-w7-design` · worktree `octus-wt-octus-ux-skills-mcp-w7`
- **Fecha:** 2026-11-01 · **Cierra:** GAP-6 y GAP-7 (mitad UX), base de IS-3, IS-4, IS-5, IS-6
- **Regla:** cada widget traza a un evento o servicio real existente o a un contrato nuevo nombrado. Un widget sin respaldo se marca como contrato nuevo obligatorio. No se acepta ningún widget sin respaldo.
- **No implementa servicios.** Los contratos nuevos se detallan en el Todo 5.

## Fuentes leídas (prosa verificada por lectura)

`packages/shared/src/events.ts` (StreamEvent, CoreEvent, PersistedEventType),
`packages/shared/src/domain.ts` (Message, ToolCallRecord, Artifact, Plan, PlanRevision,
ApprovalRequest, Task, TaskAttempt, Run, AgentInstance, Worktree, Integration, Preview,
UsageRecord), `packages/shared/src/ipc.ts` (canales OctusIPC),
`packages/shared/src/permissions.ts` (PermissionRequest/Reply, QuestionRequest/Reply),
`apps/desktop/src/renderer/src/App.tsx` (vistas actuales: chat, planes, aprobaciones,
preguntas, permisos, agentes, tareas, integraciones, presupuestos),
`apps/desktop/src/renderer/src/store.ts` (refresh de pendientes y eventos),
`packages/core/src/questions/question-service.ts` (flujo ask con timeout y cancelación),
`.harness/implementation/QUARANTINE.md` y `TREE_AUTHORITY.md` (qué existe y qué no).

Ausencias vigentes que condicionan esta especificación: no hay SkillManager (GAP-2),
no hay MCP Client Manager (GAP-3), no hay canal IPC para diffs ni para artifacts.
Todo widget que los necesite lleva contrato nuevo N-*.

## Convención de datos fijos

Todos los ejemplos usan el mismo fixture determinista. Nada aquí es un agente
ficticio en el sentido prohibido: son valores de ejemplo para pantallas, y la
sección 6 dice qué dato viene de un servicio real y cuál exige contrato nuevo.

- Proyecto `prj_qa` ("octus-qa", raíz `C:\tmp\octus-qa-proj`)
- Sesión `ses_qa01` ("Añadir validación de email", perfil `build`, modelo `meta/qa-chat-01`)
- Run `run_qa01` (`executing`, prompt "Añade validación de email al formulario de alta")
- Coordinador `ins_qa_coord`, implementador `ins_qa_impl` (tarea `tsk_qa02`, worktree `wt_qa01`)
- Skill `qa-skill@1.0.0`; servidor STDIO `mcp-qa-stdio`, servidor HTTP `mcp-qa-http`

## 1. Conversación (IS-3)

### W-C1 Mensaje de usuario
Burbuja con texto y hora. Respaldo: `Message` (`role: user`) vía `sessions.messages`.
Dato fijo: `msg_qa01`, "Añade validación de email al formulario de alta", seq 1.
Existe hoy en App.tsx.

### W-C2 Mensaje del asistente (markdown y código)
Bloques `TextPart` con markdown, código con lenguaje y botón de copiar.
Respaldo: `Message` (`role: assistant`, `trust: system`) vía `sessions.messages`.
Dato fijo: `msg_qa02` con "Voy a añadir la validación con zod…" más bloque
```ts pick(result, ["email"])```. Existe hoy en App.tsx.

### W-C3 Streaming en curso
Texto que crece por deltas, indicador "assistant (streaming)", y reinicio limpio
del mensaje parcial ante `step.retry`. Respaldo: `PartDeltaEvent` (`part.delta`),
`PartDoneEvent` (`part.done`), `StepRetryEvent` (`step.retry`) del bus en memoria e
IPC. Dato fijo: deltas "Claro," + " empiezo por `src/form.ts`…" sobre `msg_qa02`;
reintento `attempt: 2, reason: "provider timeout, reintento 1 de 3"`.
Existe hoy parcial (vista live en App.tsx líneas 1048 a 1063). La cancelación a
mitad de stream usa `sessions.interrupt` (botón Interrupt ya existe, línea 182).

### W-C4 Resumen de razonamiento
Bloque colapsado "Pensamiento" con el resumen, nunca el estado opaco del proveedor.
Respaldo: `ReasoningSummaryPart` en `Message` más deltas `part: reasoning_summary`.
`Message.providerState` no se muestra ni se registra. Dato fijo: "Reviso `form.ts`
y elijo zod porque ya es dependencia del proyecto". No existe hoy como bloque
propio: CONTRATO NUEVO OBLIGATORIO N-C-01 (render de `ReasoningSummaryPart`).

### W-C5 Tool call expandible
Fila con nombre, estado y duración; al expandir, argumentos JSON y resultado.
Estados: los seis de `ToolCallRecord.status`
(`pending | running | completed | failed | denied | cancelled`).
Respaldo: eventos `tool_call.requested | started | completed | failed` más
`runs.get` (incluye `toolCalls`). Dato fijo: `tc_qa01`, herramienta `read`,
args `{"path": "src/form.ts"}`, `completed` en 320 ms. Existe hoy básico
(`.toolcall` en App.tsx líneas 75 a 82); el expandible con args completos y
duración es N-C-02.

### W-C6 Resultado de herramienta (inline frente a archivo)
Resultado corto inline; si excede el tope, enlace al contenido completo.
Respaldo parcial: `ToolCallRecord.resultText` (resumen truncado) existe;
el contenido completo (`Artifact.kind: tool_output`) NO tiene canal IPC.
CONTRATO NUEVO OBLIGATORIO N-C-03 (lectura de artifact por `artifactId`).
Dato fijo: `tc_qa01` → "42 líneas, exporta `validateForm`" inline; log de 800
líneas de `bun test` → artifact `art_qa01`.

### W-C7 Planes y revisiones
Tarjeta de plan con objetivo, pasos, criterios de aceptación, revisión actual y
estado (`presented`, `approved`, `rejected`, `orphaned`).
Respaldo: `plans.list | plans.get`, eventos
`plan.created | plan.revision_created | plan.revision_presented |
plan.revision_orphaned | plan.approved | plan.rejected | plan.archived`.
Dato fijo: `plan_qa01`, revisión `rev_qa03` presentada y pendiente,
3 pasos ("leer form.ts", "añadir esquema zod", "probar con bun test").
Existe hoy en App.tsx (líneas 441 a 489).

### W-C8 Aprobaciones de plan (solo humanas)
Diálogo con aprobar y rechazar, idempotente (doble clic no duplica).
Respaldo: `ApprovalRequest` vía `approvals.pending` y `approvals.decide`;
eventos `approval.requested | granted | rejected | invalidated`.
Ningún modelo concede aprobaciones. Dato fijo: `apr_qa01` sobre `rev_qa03`,
decisión `approved` una sola vez. Existe hoy (líneas 443 a 455).

### W-C9 Preguntas del modelo al usuario
Diálogo con opciones (radio o checkbox) más respuesta libre, con timeout visible
y cancelación por interrupción de la sesión. Respaldo: `QuestionService.ask/reply`
(`question.asked | question.replied`), canales `questions.pending | questions.reply`.
Timeout 300 s por defecto, error `timeout` o `aborted`. Dato fijo: `que_qa01`,
"¿Con qué librería valido?", opciones `zod` (recomendada) y `yup`, respuesta `zod`.
Existe hoy (`QuestionDialogs`, líneas 226 a 262).

### W-C10 Actividad de agentes
Lista de subagentes con definición, estado y cancelación individual.
Estados visibles: `created | running | waiting_permission | waiting_input |
completed | failed | cancelled`. Respaldo: `agents.instances | agents.cancel`,
eventos `agent_instance.created | started | status_changed | completed |
failed | cancelled`. Dato fijo: `ins_qa_impl` (`implementer`, `running`,
tarea `tsk_qa02`); botón Cancel llama `agents.cancel`. Existe hoy
(`AgentsSection`, líneas 985 a 1008).

### W-C11 Errores
Banda de error con causa, alcance (run, tarea, instancia) y acción siguiente
(reintentar, cancelar, ver logs). Respaldo: evento `error.raised`,
`run.failed` con `run.error`, `budget.exceeded`, estados `failed` de tarea e
instancia. Dato fijo: `run_qa02` → `failed`, "provider timeout tras 30 s",
acción "Reintentar run". Existe hoy parcial (textos de error por entidad);
la banda unificada con acción es N-C-04.

### W-C12 Resúmenes y uso
Desplegable "Usage of the last run" con llamadas, tokens y coste; presupuestos
con avisos. Respaldo: `runs.usage` (`UsageRecord`), `budgets.status`,
eventos `provider.usage_recorded | budget.warning | budget.exceeded`.
Dato fijo: 3 llamadas, 12 400 tokens, $0.0311, presupuesto `month:$20`
al 31 por ciento. Existe hoy (líneas 422 a 428 y 1081 a 1083).

### W-C13 Archivos modificados
Lista de archivos tocados por el run con enlace al diff. Respaldo parcial:
`TaskAttempt.artifacts` y `Artifact.kind: diff` existen como tipos, pero sin
canal de lectura ni de diff. CONTRATO NUEVO OBLIGATORIO N-C-05
(artifact + diff unificado por `artifactId` o `worktreeId + path`).
Dato fijo: `src/form.ts` (+38, -4), `src/form.test.ts` (+25, -0).

### W-C14 Conversación extensa sin jank
Lista virtualizada: solo renderiza lo visible; el historial se pagina por `seq`.
Respaldo parcial: `sessions.messages` (sin paginación) existe.
CONTRATO NUEVO OBLIGATORIO N-C-06 (paginación de mensajes por `seq` y `runId`).
Criterio: 2 000 mensajes sin caída de cuadros (cifra para el presupuesto del Todo 5).

### W-C15 Composer con adjuntos y selector de modelo
Caja con texto, adjuntar archivos, perfil plan o build y modelo.
Respaldo: `sessions.prompt` (solo texto) y `sessions.setModel | sessions.setProfile`
existen; los adjuntos no viajan. CONTRATO NUEVO OBLIGATORIO N-C-07
(adjuntos en el prompt: imágenes solo si el modelo declara `supportsImages`).
Existe hoy básico (`Composer`, líneas 156 a 165); adjuntos y modelo, no.

## 2. Agent Manager (IS-4): datos reales, nada inventado

### W-A1 Agentes
Tabla de definiciones (nombre, kind, modelo, límites) y de instancias por sesión
con estado y cancelación. Respaldo: `agents.definitions | agents.instances |
agents.cancel | agents.setDefinitionModel`, eventos de instancia.
Dato fijo: `explorer`/`implementer`/`reviewer` más `ins_qa_impl` en `running`.
Existe hoy (líneas 985 y 1152).

### W-A2 Tareas
Lista con estado, rol, bloqueos con motivo (`TaskBlockedReason`: `waiting-deps`,
`no-capacity`, `needs-approval`…), intentos y reintento.
Respaldo: `tasks.list | tasks.get | tasks.cancel | tasks.retry`,
eventos `task.created | status_changed | progress`,
`task_attempt.created | status_changed`. Dato fijo: `tsk_qa01` `completed`,
`tsk_qa02` `running` (intento 1), `tsk_qa03` `draft` (espera a `tsk_qa02`).
Existe hoy (líneas 533 a 577).

### W-A3 Grafo de dependencias (DAG)
Nodos y aristas, camino crítico, ciclo con ruta explícita si lo hay.
Respaldo: `tasks.get` (`dependencies`) más funciones puras existentes de
`tasks/task-graph.ts` (`adjacency`, `detectCycle`, `orderTasks`,
`isDependencySatisfied`). El layout se calcula en el renderer; no pide contrato
nuevo. Dato fijo: `tsk_qa01 → tsk_qa02 → tsk_qa03`; ciclo de ejemplo rechazado
`[tsk_qa02, tsk_qa01, tsk_qa02]`. Selector `#agent-dag`. No existe hoy la vista.

### W-A4 Runs
Ficha de run con estado (`planning | executing | integrating |
awaiting_approval | promoting | done | rejected | failed | cancelled`),
instancias y tool calls. Respaldo: `runs.get | runs.usage`,
eventos `run.created | started | status_changed | completed | failed | cancelled`.
Un run cancelado muestra su estado final real, nunca progreso congelado.
Dato fijo: `run_qa01` en `executing` con 2 instancias y 5 tool calls.
Existe hoy parcial (uso y mensajes; falta ficha unificada: N-A-01).

### W-A5 Worktrees
Lista por proyecto con estado (`active | suspended | orphaned`…), operaciones y
limpieza. Respaldo: `worktrees.list | worktrees.get | worktrees.cleanup`,
eventos `worktree.created | released | status_changed | removed`.
Dato fijo: `wt_qa01`, rama `wt/tsk-qa02`, `active`, 3 operaciones `ok`.
Existe hoy parcial (líneas 633 a 634 muestran error; falta vista: N-A-01).

### W-A6 Revisiones, validaciones, previews, conflictos, promoción
- Revisiones de integración: `validations.list` (`Validation` + `IntegrationReview`).
- Preview: `previews.create | list | start | stop | restart | inspect | logs | cleanup`
  con `reachable` y `shaMatchesHead`.
- Conflictos con resolución asistida: `conflicts.list | get | requestResolution |
  finalize | incorporate | abort | cleanup`, eventos `integration.conflict_opened |
  conflict_resolved`.
- Aprobación de integración fijada a SHA: `approvals.approve | reject | status`
  (idempotente, `duplicate: true` ante doble clic).
- Promoción solo con aprobación vigente: `promotions.promote | promotions.status`.
- Diffs: el manager `worktree-manager.getWorktreeDiff` existe pero SIN canal IPC.
  CONTRATO NUEVO OBLIGATORIO N-A-DIFF-1 (`worktrees.diff`: `worktreeId + path →
  diff unificado`).
Dato fijo: `int_qa01` en `validating`; conflicto `cfl_qa01` en `src/form.ts`
(resolución `res_qa01`, SHA `9f3c1a2b` reutilizada); preview `prv_qa01`
`running` en `http://127.0.0.1:4311`, `shaMatchesHead: true`; aprobación
pendiente sobre `9f3c1a2b`; promoción bloqueada hasta aprobar. Existe hoy
parcial (líneas 695 a 816); diffs y ficha unificada faltan.

## 3. Skills (IS-5): instalada no es lo mismo que habilitada

No existe SkillManager (GAP-2). Toda pantalla de Skills traza a contratos nuevos
N-SK-*, obligatorios para la ola 12. La fuente de validación del formato
Agent Skills la fija el Todo 18; esta especificación no inventa formato propio.

### Estados (siempre visibles y distintos)
- **Instalada:** presente en disco en uno de los tres ámbitos
  (`global | proyecto | Octus`), con `id, nombre, versión, origen, alcance`.
- **Habilitada:** instalada Y activada para un proyecto. Una skill instalada pero
  deshabilitada nunca llega al contexto de los runs de ese proyecto.
- **Con error:** falla validación (falta `SKILL.md`, `name` inválido, duplicada);
  muestra el error y bloquea habilitar.

### W-S1 Catálogo
Las tres procedencias en una lista con origen visible.
Respaldo: N-SK-01 (descubrimiento en tres ámbitos).
Dato fijo: `qa-skill@1.0.0` (proyecto), `old-helper@0.2.0` (global),
`octus-review@1.3.0` (Octus).

### W-S2 Instaladas y W-S3 Habilitadas
Dos filtros excluyentes sobre la misma lista; el contador lo deja claro
("2 instaladas, 1 habilitada"). Respaldo: N-SK-01 + N-SK-02 (activación por
proyecto con persistencia). Dato fijo: `qa-skill` instalada y habilitada;
`old-helper` instalada pero deshabilitada (nunca aparece en sus runs).

### W-S4 Detalle
Descripción, versión, alcance, recursos, procedencia (carpeta, zip o git con
fuente explícita) y errores de validación. Respaldo: N-SK-01 + N-SK-03
(inspección). Dato fijo: `qa-skill` ← carpeta `C:\tmp\qa-skill`, alcance
proyecto, validación `ok`; `broken-skill` ← error "`SKILL.md` sin campo `name`",
habilitar bloqueado.

### W-S5 Instalar e importar
Carpeta local, zip compatible y git con fuente explícita; rechaza duplicados y
zips con rutas fuera de la skill sin escribir nada. Respaldo: N-SK-04
(instalar/importar/desinstalar). Dato fijo: instalar `qa-skill@1.0.0` desde
carpeta → `ok`; reinstalar → `duplicate`, se rechaza.

### W-S6 Historial de uso por run
Qué runs usaron qué skill (carga progresiva: metadatos siempre, instrucciones
completas solo de la relevante). Respaldo: N-SK-05 (registro por run).
Dato fijo: `run_qa01` → `qa-skill@1.0.0` (instrucciones completas),
`old-helper` solo metadatos y sin uso.

### W-S7 Configuración y vista contextual
Sección en configuración más vista contextual en el workbench con lo mismo:
nada de pantallas gemelas. Respaldo: los mismos N-SK-*. La UI final no muestra
pantallas contra simulados como si fueran reales (los datos `qa-*` son de
diseño y se retiran en la ola 12).

## 4. MCP (IS-6): configurado no es conectado, conectado no es autorizado

No hay MCP Client Manager (GAP-3). Toda pantalla MCP traza a contratos nuevos
N-MCP-*, obligatorios para la ola 13. Transporte vigente: STDIO local y
Streamable HTTP; nada de HTTP+SSE legado. Secretos solo en el almacén del SO
(`packages/core/src/secrets/secret-store.ts`, patrón ya existente).

### Estados de servidor (siempre visibles y distintos)
- **Configurado:** existe la configuración (comando + args, o URL + auth).
  Configurar un remoto nunca se llama instalar.
- **Conectado:** handshake y capacidades negociadas; reconexión con backoff.
- **Autorizado:** confianza explícita global o por workspace. Un servidor no
  confiable nunca se conecta al abrir su workspace; la puerta de confianza
  precede a cualquier conexión.

### W-M1 Lista de servidores
Nombre, transporte (`stdio | http`), estado de conexión, capacidades negociadas.
Respaldo: N-MCP-01 (gestión de configuraciones y conexiones).
Dato fijo: `mcp-qa-stdio` (STDIO, conectado), `mcp-qa-http` (HTTP, conectado),
`mcp-qa-new` (configurado, nunca conectado).

### W-M2 Agregar e importar
Formulario y JSON compatible; STDIO con comando y argumentos separados (sin
shell); HTTP con URL y autenticación; edición, verificación y reintento sin
bloquear la lista. Respaldo: N-MCP-01 + N-MCP-02 (verificación y seguridad:
SSRF, HTTPS, timeouts, cancelación). Dato fijo: agregar `mcp-qa-new` por JSON
→ `verificación ok, pendiente de confianza`.

### W-M3 Confianza por workspace y permisos
Interruptor de confianza (global o por workspace) y permisos por perfil;
revocar corta la conexión con auditoría. Respaldo: N-MCP-03.
Dato fijo: `mcp-qa-http` conectado pero NO autorizado en `prj_qa` → sus
herramientas no aparecen; al autorizar, aparecen con etiqueta de servidor.

### W-M4 Herramientas aisladas por servidor
Descubrimiento por protocolo, nombres aislados (`servidor:herramienta`), uso
solo con servidor autorizado + herramienta disponible + perfil con permiso +
aprobación cumplida. Resultados marcados como contenido no confiable con
servidor y herramienta registrados. Respaldo: N-MCP-04 (vía ToolGateway,
sin colisiones, sin eludir PermissionManager). Dato fijo:
`mcp-qa-stdio:read_log` (`ok`, 12 líneas); `mcp-qa-http:read_log` denegada
por falta de autorización.

### W-M5 Recursos y prompts con aprobación
Listar y leer recursos (con plantillas), obtener prompts, suscripciones cuando
el protocolo las anuncie; lo sensible pide aprobación antes de inyectarse al
contexto. Nada no negociado se anuncia. Respaldo: N-MCP-05.
Dato fijo: recurso `qa://logs/build.log` (sensible → aprobado antes de leer);
prompt `qa-review` obtenido con 2 argumentos.

### W-M6 Credenciales, logs y errores
Token solo en el almacén del SO, redactado en logs; URL a rango privado
rechazada; timeout con cancelación; error de protocolo visible con reintento.
Respaldo: N-MCP-02 + N-MCP-03. Dato fijo: token revocado → conexión cortada
y auditada; `http://169.254.169.254/` → rechazada por SSRF.

## 5. Tabla de trazabilidad (toda la especificación)

EXISTE = evento, servicio o canal IPC real leído en el árbol.
NUEVO = contrato nuevo obligatorio (detalle y productores en el Todo 5).

| Widget | Respaldo | Tipo |
|---|---|---|
| W-C1 mensaje usuario | `Message`, `sessions.messages` | EXISTE |
| W-C2 markdown y código | `Message`, `sessions.messages` | EXISTE |
| W-C3 streaming y reintento | `part.delta`, `part.done`, `step.retry`, `sessions.interrupt` | EXISTE |
| W-C4 resumen de razonamiento | `ReasoningSummaryPart` | N-C-01 NUEVO |
| W-C5 tool call expandible | `ToolCallRecord`, `tool_call.*`, `runs.get` | EXISTE + N-C-02 NUEVO (args y duración) |
| W-C6 artifact completo | `Artifact`, `ToolCallRecord.artifactId` | N-C-03 NUEVO (lectura) |
| W-C7 planes y revisiones | `Plan`, `PlanRevision`, `plan.*`, `plans.*` | EXISTE |
| W-C8 aprobaciones de plan | `ApprovalRequest`, `approvals.pending/decide`, `approval.*` | EXISTE |
| W-C9 preguntas | `QuestionService`, `question.asked/replied`, `questions.*` | EXISTE |
| W-C10 actividad de agentes | `AgentInstance`, `agent_instance.*`, `agents.instances/cancel` | EXISTE |
| W-C11 banda de error unificada | `error.raised`, `run.failed`, `budget.exceeded` | EXISTE + N-C-04 NUEVO (banda) |
| W-C12 uso y presupuestos | `UsageRecord`, `runs.usage`, `budgets.status`, `provider.usage_recorded` | EXISTE |
| W-C13 archivos modificados | `TaskAttempt.artifacts`, `Artifact(diff)` | N-C-05 NUEVO |
| W-C14 lista virtualizada | `sessions.messages` (sin paginar) | N-C-06 NUEVO (paginación) |
| W-C15 composer con adjuntos | `sessions.prompt`, `sessions.setModel/setProfile` | EXISTE + N-C-07 NUEVO (adjuntos) |
| W-A1 agentes | `agents.*`, `agent_instance.*` | EXISTE |
| W-A2 tareas | `tasks.list/get/cancel/retry`, `task.*`, `task_attempt.*` | EXISTE |
| W-A3 DAG | `tasks.get` dependencias + `task-graph.ts` (`adjacency`, `detectCycle`, `orderTasks`) | EXISTE |
| W-A4 ficha de run | `runs.get/usage`, `run.*` | EXISTE + N-A-01 NUEVO (ficha) |
| W-A5 worktrees | `worktrees.list/get/cleanup`, `worktree.*` | EXISTE + N-A-01 NUEVO (vista) |
| W-A6 revisiones, previews, conflictos, promoción | `validations.*`, `previews.*`, `conflicts.*`, `approvals.approve/reject/status`, `promotions.*` | EXISTE |
| W-A6 diffs | `worktree-manager.getWorktreeDiff` (sin IPC) | N-A-DIFF-1 NUEVO (canal) |
| W-S1 a W-S7 Skills | sin SkillManager (GAP-2) | N-SK-01 a N-SK-05 NUEVOS |
| W-M1 a W-M6 MCP | sin Client Manager (GAP-3) | N-MCP-01 a N-MCP-05 NUEVOS |

Ningún widget quedó sin respaldo: la tabla no tiene filas vacías.

## 6. Contratos nuevos nombrados (obligatorios, los detalla el Todo 5)

Conversación: N-C-01 (render de razonamiento), N-C-02 (tool call expandida),
N-C-03 (lectura de artifacts), N-C-04 (banda de error), N-C-05 (archivos y diff),
N-C-06 (paginación de mensajes), N-C-07 (adjuntos del prompt).
Agent Manager: N-A-01 (ficha unificada de run y worktrees), N-A-DIFF-1
(`worktrees.diff`, productor existente `worktree-manager.getWorktreeDiff`).
Skills: N-SK-01 (descubrimiento en tres ámbitos), N-SK-02 (activación por
proyecto), N-SK-03 (inspección), N-SK-04 (instalar/importar/desinstalar),
N-SK-05 (registro de uso por run).
MCP: N-MCP-01 (configuraciones y conexiones), N-MCP-02 (verificación y
seguridad), N-MCP-03 (confianza y credenciales en almacén del SO), N-MCP-04
(herramientas aisladas vía ToolGateway), N-MCP-05 (recursos y prompts con
aprobación).

## 7. Checklist de lectura contra IS-3, IS-4, IS-5 e IS-6

IS-3: W-C1 a W-C15 cubren markdown, código, streaming, tool calls expandibles,
planes (W-C7), aprobaciones (W-C8), preguntas (W-C9), actividad de agentes
(W-C10) y errores (W-C11); W-C14 fija el criterio anti-jank. PASS.
IS-4: W-A1 a W-A6 usan TaskManager, Scheduler, worktrees e integraciones reales
(`agents.*`, `tasks.*`, `runs.*`, `worktrees.*`, `validations.*`, `previews.*`,
`conflicts.*`, `promotions.*`); sin agentes ficticios ni progreso inventado
(un run cancelado muestra su estado final). PASS.
IS-5: W-S1 a W-S7 distinguen instalada frente a habilitada y fijan errores que
bloquean habilitar; la carga progresiva y los scopes van a N-SK-05 y al Todo 5.
Nada de formato propietario. PASS.
IS-6: W-M1 a W-M6 distinguen configurado frente a conectado frente a autorizado,
con confianza por workspace que precede a la conexión, aislamiento por servidor
y secretos solo en el almacén del SO; sin SSE legado. PASS.

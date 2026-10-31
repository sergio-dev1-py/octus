# TARGET_ARCHITECTURE.md — Arquitectura objetivo de Octus

- **Fecha:** 2026-10-30
- **Estado:** diseño aprobado para guiar las Etapas 1–6. No es código: define componentes, responsabilidades, contratos conceptuales y flujos que se implementarán desde cero.
- **Reglas rectoras:** `MASTER_SPEC.md` y `DECISIONS.md` (ADR-001…016). La referencia OpenOrch aporta conceptos verificados según `REUSE_MATRIX.md`.

## 1. Principios de diseño

1. **Los modelos razonan; el sistema gobierna.** Runtime, Scheduler, Worktree/Integration Managers, Memory y Tool Gateway son componentes deterministas; no se convierte cada operación determinista en un agente (PROMPT MASTER §3).
2. **Un único coordinador por sesión**, con perfiles `plan`/`build` (ADR-006).
3. **Seguridad en el runtime**, nunca solo en prompts (ADR-008); por defecto, denegar.
4. **Proveedor aislado:** el dominio (sesiones, tareas, herramientas) no conoce formatos de Meta ni de OpenCode Go; todo pasa por el `ModelRouter`.
5. **Local-first:** datos y ejecución en la máquina del usuario; la única red saliente del núcleo es hacia los dos proveedores de modelos y las herramientas web explícitas.
6. **Todo trabajador autónomo deja artefactos verificables:** plan, commits, resultados de pruebas, revisión y registro de integración.

## 2. Vista lógica

```text
┌─ apps/desktop ────────────────────────────────────────────────────┐
│ Renderer SolidJS: Sesiones · Orquestación (DAG) · Worktrees ·     │
│ Integración/Preview · Ajustes        ▲ eventos tipados            │
│ Preload mínimo (superficie IPC cerrada)                           │
│ Main Electron: ventana/tray/diálogos/terminal de usuario          │
└──────────────────────────────┬────────────────────────────────────┘
                    IPC tipado (packages/shared)
┌──────────────────────────────▼────────────────────────────────────┐
│ packages/core                                                     │
│  Application: SessionManager · ProjectManager · ApprovalService   │
│  Coordination: TaskPlanner · TaskGraph(DAG) · Scheduler ·         │
│                AgentManager · AgentMessaging                      │
│  Agents: AgentRegistry · Perfiles (plan/build + 4 subagentes) ·   │
│          ContextBuilder · PromptComposer                          │
│  Runtime: AgentRuntime (pasos, streaming, cancelación,            │
│           compactación) ──► ModelRouter ─► Meta / OpenCode Go     │
│  Tools: ToolGateway ─► PermissionManager ─► herramientas          │
│  Git: RepositoryManager · WorktreeManager · IntegrationManager ·  │
│       ValidationService · PreviewManager · PromotionManager       │
│  Support: MemoryService · PersistenceService · LogService         │
└───────────────────────────────────────────────────────────────────┘
```

## 3. Estructura de repositorio propuesta (a crear en etapas, no ahora)

```text
apps/desktop/            Electron main + preload + renderer SolidJS
packages/shared/         Contratos: dominio, eventos e IPC (única fuente)
packages/core/           Motor sin dependencias de Electron
  src/agents/            Definiciones y registro de perfiles
  src/prompts/           Textos versionados y composición
  src/runtime/           AgentRuntime y servicios internos (título, compactación)
  src/providers/         ModelRouter + adaptador Meta + adaptador OpenCode Go
  src/tools/             Definiciones de herramientas y ToolGateway
  src/permissions/       PermissionManager
  src/orchestration/     Planner, TaskGraph, Scheduler, AgentManager, mensajería
  src/git/               Repository, Worktree, Integration, Validation, Preview, Promotion
  src/memory/            MemoryService
  src/persistence/       SQLite en worker dedicado, migraciones (Etapa 1 solo núcleo)
scripts/                 Checks y mocks propios de Octus
.harness/implementation/ Esta documentación viva
```

El core no debe importar Electron: el escritorio inyecta servicios de plataforma (diálogos, terminal de usuario, notificaciones, credenciales del SO) mediante interfaces, patrón observado en la referencia con `BrowserService`/`ToolServices` y generalizado aquí.

## 4. Modelo de dominio

| Entidad | Significado | Relaciones |
|---|---|---|
| `Project` | Workspace/repositorio abierto | 1—N sesiones |
| `Session` | Conversación persistente del usuario con un coordinador y un perfil activo | 1—N runs |
| `Run` | Ejecución originada por una solicitud del usuario dentro de la sesión | 1—N tasks |
| `Task` | Trabajo concreto con objetivo, dependencias, ámbito, criterios de aceptación y entregable | N—M dependencias (DAG); 0..1 instancia activa |
| `AgentDefinition` | Perfil reutilizable (plan, build, explorer, researcher, implementer, reviewer + utilidades internas) | 1—N instancias |
| `AgentInstance` | Ejecución individual de un perfil para una task (o el coordinador de la sesión) | Conversación propia; 0..1 worktree |
| `Worktree` | Entorno Git independiente asignado a una instancia escritora | Registra repo, rama, commit base/producido |
| `Integration` | Conjunto ordenado de commits de tasks integrados en rama intermedia | 1—N tasks; produce un SHA candidato |
| `Preview` | Ejecución verificable de una integración | 1 por integración validada |
| `Approval` | Decisión humana ligada a un SHA exacto de integración y a la rama destino observada | Invalida si cambia el SHA o la destino |
| `MemoryItem` | Hecho registrado con fuente, ámbito (proyecto/sesión/run/task) y estado (provisional/aprobado) | Referencia artefactos |
| `ToolCall` | Registro auditable de una llamada: instancia, herramienta, ámbito, permiso aplicado, resultado | N por instancia |
| `Plan` | Propuesta de solución para un objetivo dentro de una sesión (fuente de verdad en SQLite) | 1—N revisiones; referencia a revisión actual y aprobada |
| `PlanRevision` | Versión concreta e inmutable de una propuesta (contenido estructurado + Markdown) | Pertenece a un plan; ciclo de presentación y aprobación independientes |

### 4.1 Ciclos de vida (estados normativos)

- **Task:** `draft → ready → assigned → running → (blocked|failed) → completed → reviewed → integrated`, con `cancelled` desde cualquier estado activo. Una task `ready` solo pasa a `assigned` cuando todas sus dependencias están `completed` (o estado superior acordado) y el Scheduler verifica recursos y ámbitos (§6).
- **AgentInstance:** `created → running → (waiting_permission|waiting_input) → (completed|failed|cancelled)`. Toda espera tiene timeout configurable; la cancelación se propaga en cascada por el árbol de instancias.
- **Run:** `planning → executing → integrating → awaiting_approval → (promoting → done | rejected | failed)`. Un nuevo mensaje del usuario crea un nuevo Run sin reiniciar la Session.
- **PlanRevision:** presentación `unpresented → presented | orphaned` y aprobación `pending → approved | rejected`, ejes independientes con fechas y eventos (ADR-023). Solo una revisión presentada es aprobable; `runs.plan_revision_id` fija la revisión aprobada que ejecuta Build.
- **Integration:** `building → validating → preview_ready → (approved → promoted | invalidated)`. Cualquier cambio del SHA candidato o de la rama destino mueve a `invalidated`.

Las transiciones se persisten y se emiten como eventos; ningún estado vive solo en memoria.

## 5. Agentes: definiciones, comportamiento y prompts

### 5.1 Perfiles

| Perfil | Tipo | Modelo por defecto | Escritura | Herramientas (concepto) | Entrega |
|---|---|---|---|---|---|
| Coordinador `plan` | Perfil del coordinador | `muse-wonder-1.0` | Prohibida en filesystem y terminal; planes vía `plan.*` internos | Lectura, preguntas, delegación a explorer/researcher, plan.create/update/get/list | Respuesta conversacional + revisión de plan |
| Coordinador `build` | Perfil del coordinador | `muse-wonder-1.0` | Directa solo en tareas pequeñas no delegadas, con permisos plenos del perfil | Todas las del coordinador + delegate, agent_*, plan.get/list | Resultado integrado y resumen verificado |
| `explorer` | Subagente | `muse-spark-1.3` | Prohibida en runtime (sin shell) | read/glob/grep, git_status/git_diff | Informe: hallazgos con rutas, dependencias, riesgos |
| `researcher` | Subagente | `muse-spark-1.3` | Prohibida | websearch/webfetch (SSRF), lectura de docs del proyecto | Pregunta, fuentes, hallazgos, alternativas, compatibilidad, recomendación, incertidumbres |
| `implementer` | Subagente | `muse-spark-1.3` (Wonder si se pide) | Solo su directorio/worktree asignado | read/glob/grep, write/edit, shell aprobado, git_status/git_diff, git_stage/git_commit controlados | Resumen, cambios, commit, pruebas, riesgos |
| `reviewer` | Subagente | `muse-spark-1.3` (Wonder opcional) | Prohibida; pruebas en copia desechable | Lectura, diff, test_run con allowlist | Observaciones por prioridad con archivo:línea |
| Utilidades internas | Ocultos | Spark | Sin herramientas | — | Título de sesión, compactación (con coste registrado) |

Se pueden crear múltiples instancias de cada perfil; no se crean perfiles por trabajador (ADR-007). Definiciones builtin declarativas en YAML versionado con validación Zod; cada instancia conserva el snapshot exacto de su definición (ADR-028). Coordinador único por sesión con perfiles plan/build sobre una misma conversación cronológica (ADR-006, ADR-024).

### 5.2 Composición de prompt (capas, en orden)

1. **Prompt base de Octus por familia de modelo** (textos propios versionados; variantes Meta/genérica).
2. **System del perfil** (responsabilidad, límites, formato de entrega).
3. **Instrucciones de proyecto aprobadas explícitamente**, etiquetadas con su ruta (ADR-027).
4. **Contexto de tarea**: objetivo, dependencias y sus resúmenes, scope, criterios de aceptación, memoria relevante (proyecto/sesión/run) seleccionada por el `ContextBuilder` — nunca el historial completo de otros agentes.
5. **Guidance de herramientas ofrecidas** (generada desde el set efectivo).
6. **Recordatorios de estado** como mensajes del sistema de corta vida (perfil plan/build, worktree asignado, estado de planes de la sesión), cerca del final del contexto.

Contenido de repositorios no aprobados, páginas web, skills de terceros y servidores MCP se entrega **etiquetado como no confiable** y nunca dentro del system prompt (ADR-015.12, ADR-027). El esfuerzo de razonamiento viaja como parámetro del proveedor (§8), no como texto; los resúmenes de razonamiento visibles son opcionales y no sustituyen al plan de trabajo registrado en Tasks.

## 6. Orquestación: Planner, DAG y Scheduler

- **TaskPlanner** (capacidad del coordinador Build, apoyada por Plan): convierte un Run en Tasks con objetivo, perfil sugerido, dependencias, ámbito de escritura (rutas), criterios de aceptación y modelo/esfuerzo. El usuario puede inspeccionar el plan antes de ejecutar (en perfil plan, siempre; en build, según configuración).
- **TaskGraph** mantiene el DAG, detecta ciclos y calcula el conjunto ejecutable.
- **Scheduler** (determinista): en cada tick corre hasta 4 oleadas asignar→supervisar (mismo orden/equidad por oleada) para despertar dependientes sin esperar ticks externos. Despierta tasks `ready` si se cumplen: dependencias satisfechas, cupo de concurrencia global/por perfil/por proveedor, **ámbitos de escritura disjuntos** entre implementers concurrentes (dos tasks con scopes solapados se serializan), worktree disponible (auto-aprovisionado por el WorktreeManager para implementers en repos git; camino legacy con directorios aislados si no hay repo) y presupuesto del run no agotado. Reviewers se spawnean sobre el worktree del target. No lanza agentes indiscriminadamente.
- **AgentManager** crea/detiene instancias, aplica timeouts y cancelación en cascada, recoge entregas (commit, resumen, pruebas) y marca la task en consecuencia.
- **AgentMessaging:** mensajería estructurada y persistida: entrega de task (del coordinador a la instancia), resultado (instancia → coordinador), aviso de subagente en segundo plano y preguntas al usuario. No hay conversación libre entre workers: toda comunicación relevante queda registrada y asociada a Run/Task.
- La primitiva conversacional tipo "subagent" de la referencia queda como mecanismo interno del AgentManager; la delegación planificada siempre pasa por Tasks.

## 7. Runtime de agente

Un solo `AgentRuntime` ejecuta instancias (coordinador y subagentes) con el mismo bucle endurecido:

1. Cola por instancia con prioridades (input del usuario, continuación, avisos).
2. Un paso = una llamada al `ModelRouter` en streaming; el runtime ejecuta las herramientas solicitadas a través del ToolGateway y reinyecta resultados reconstruyendo el contexto.
3. **Idempotencia de paso:** cada tool call lleva identidad persistida; un reintento de streaming no duplica texto confirmado ni re-ejecuta herramientas con efectos ya aplicados (ADR-015.7).
4. Límites: pasos por perfil, timeout total e inactividad por instancia, presupuesto de tokens/coste por run; al agotar pasos, cierre solo-texto con resumen de estado (concepto conservado de la referencia).
5. Cancelación: aborta stream y herramientas en curso y **propaga** a instancias hijas; las herramientas a medias se liquidan como interrumpidas al reanudar.
6. Steering: mensajes del usuario durante un run se incorporan en fronteras de paso del coordinador (concepto conservado), sin perder inyecciones asociadas.
7. Compactación: estimación que incluye sistema, herramientas e historial; checkpoint estructurado; el tramo reciente declarado permanece ante el modelo (ADR-015.6); coste de compactación/títulos registrado en la sesión.

## 8. Proveedores: ModelRouter, Meta y OpenCode Go

### 8.1 Contrato del router

El dominio pide: generar en streaming con (modelo, esfuerzo, herramientas, contexto) y recibe eventos normalizados (texto, llamada a herramienta con argumentos en streaming, fin con uso/coste, error tipado reintentable o no). Los formatos de cada proveedor viven solo en su adaptador (PROMPT MASTER §2.4).

### 8.2 Adaptador Meta (verificado contra documentación oficial, 2026-10-30)

| Aspecto | Decisión basada en evidencia |
|---|---|
| Base / auth | `https://api.meta.ai/v1`; `Authorization: Bearer <clave>`; clave desde almacén seguro o `MODEL_API_KEY` pasada explícitamente al cliente |
| Modelos | `muse-wonder-1.0` (coordinador), `muse-spark-1.3` (subagentes); contexto 1.048.576; solo Standard (ADR-005) |
| Superficie | Responses `POST /v1/responses` (ADR-004); `instructions` y herramientas se reenvían en cada petición |
| Reasoning | `reasoning: {effort}` con `minimal…max` según modelo (`none` prohibido: devuelve 400); resúmenes `reasoning.summary` opcionales; tokens de razonamiento presupuestados como salida |
| Continuidad | Replay stateless con `store:false` + `include:["reasoning.encrypted_content"]`; el blob cifrado es estado opaco ligado al proveedor (sin logs ni visualización); prohibido combinarlo con `previous_response_id` en la misma petición; cada item de razonamiento reproducido va seguido de mensaje assistant o `function_call` |
| Tool calling | Herramientas `function` con campos planos; nombres válidos `^[a-zA-Z0-9_.-]+$` con ≤1 punto (los namespaces internos de Octus se aplanan a un punto como máximo); `tool_choice` solo `"auto"`; `parallel_tool_calls` configurable; `call_id` 1–64; resultados como `function_call_output` emparejados; **validación local de argumentos siempre** (la API no la garantiza) |
| Streaming | Eventos Responses tipados; terminal `response.completed/failed/incomplete` o evento `error`; argumentos de herramienta por `response.function_call_arguments.delta/done`; no se descartan items antes de su estado completado |
| Errores | Sobre `{error:{message,type,param,code}}`; reintentar 429/500/503 con backoff + jitter honrando `Retry-After`; no reintentar 400/401/402/403/404/413 sin corregir; 504 → preferir streaming/background, no reintento ciego; ojo: 404 de ruta desconocida puede no traer cuerpo |
| Límites/coste | 3.000 RPM y 4M TPM por equipo/modelo; cabeceras `x-ratelimit-*` para frenado proactivo; el registro de uso alimenta presupuestos por run |
| SDK | **Resuelto (Hito 0, P-02): SDK oficial `openai`** |

Fuentes: `https://dev.meta.ai/docs/protocols/responses`, `/docs/reasoning`, `/docs/tool-calling`, `/docs/error-handling`, `/docs/models`, `/docs/pricing-rate-limits`, `/docs/authentication`, `/docs/sdks`, `/docs/coding-agents` (consultadas 2026-10-30; detalle en AUDIT §11).

Nota de alcance: el modo servidor `background:true` de Responses **no** es el mecanismo de "subagentes en segundo plano" de Octus; el paralelismo lo gobierna el Scheduler local. Solo se evaluará para generaciones individuales muy largas (504).

### 8.3 Adaptador OpenCode Go (verificado en el Hito 0, P-03; ver DECISIONS y ADR-021)

- Base `https://opencode.ai/inference/go` con rutas por API (`/openai/v1/responses`, `/openai/v1/chat/completions`, `/anthropic/v1/messages`, `/google/v1beta/models/<model>:generateContent`); clave Bearer `OPENCODE_API_KEY`.
- **Encaminamiento por protocolo nativo de cada modelo** según el bloque `api` del catálogo público `GET /v1/models` (28 modelos el 2026-10-30: 17 chat-completions, 5 responses, 5 messages, 1 generate-content). La Etapa 1 implementa las rutas `responses` y `chat-completions` con el SDK oficial `openai`; el resto solo si la shortlist las incluye.
- Cabecera `x-opencode-session` estable por conversación en **todas** las peticiones (Go la exige; 400 `MissingSessionID` sin ella, verificado). Sin acoplamiento a OpenCode Console.
- Modelos `-contributor` excluidos por defecto (ADR-005). Shortlist inicial para verificación live: `glm-5.3-flash` (defecto) y `deepseek-v4.1-flash`.
- El envoltorio de error de Go difiere del de Meta (verificado sin clave): el adaptador normaliza ambos al error tipado del router.
- Rol: proveedor alternativo seleccionable (sesión/perfil); el routing Wonder/Spark de ADR-005 aplica al proveedor Meta.

## 9. Herramientas y permisos

- **ToolGateway:** único camino de ejecución. Por llamada: resuelve definición → valida esquema → comprueba perfil y permisos efectivos (agente + sesión + run/task + instancia + guardados) → comprueba ámbito (worktree/scope/rutas reales) → ejecuta con timeout y señal de cancelación → registra `ToolCall` con resultado truncado según política.
- **PermissionManager:** reglas `allow|deny|ask` con semántica última-regla-gana (concepto de la referencia), evaluación central, flujo `ask` hacia la UI con timeout y cancelación al interrumpir, "siempre" guardados por proyecto con revocación individual, y prohibición estructural: un prompt nunca eleva permisos; un worker nunca obtiene acciones de merge/push/promoción.
- **Catálogo inicial:** read, write, edit, glob, grep, shell (con política ADR-018 y directorio de trabajo confinado), webfetch, websearch, question, skill, gestión de sesión (coordinador), worktree (solo vía managers, no como herramienta libre del worker). MCP y navegador se incorporan en su etapa con las mismas puertas; Code Mode queda fuera (ADR-013).
- **Shell (ADR-018):** aprobación previa por comando (sin "siempre permitir" en la Etapa 1); el modelo solo aporta comando y timeout acotado; entorno construido desde allowlist mínima sin secretos heredados; timeout con tope y terminación del árbol de procesos; sin shell en segundo plano en la Etapa 1. El `cwd` confinado es el directorio inicial, **no** un sandbox: así se declara en UI y docs.

## 10. Git: repositorio, worktrees, integración, preview y promoción

- **RepositoryManager (Etapa 4, implementado):** inspección de solo lectura (raíz, rama, HEAD, staged/unstaged/untracked, ramas, worktrees, git-common-dir, operaciones incompletas MERGE/CHERRY_PICK/REBASE). `validateRepository` exige repo con HEAD y sin operación incompleta; nunca modifica el repo.
- **WorktreeManager, único creador/destructor (Etapa 4, implementado):** un worktree por task (`UNIQUE(task_id)`, reintentos reutilizan); ramas `harness/run-<runId>/task-<taskId>` (+`-rN` ante colisión ajena); paths `<worktrees_root>/<taskId>/` con ruta canónica; raíz por defecto `<dataDir>/../octus-worktrees/<projectId>`, configurable por proyecto (absoluta, no UNC, fuera del repo y de dataDir, sin activos al cambiar). Base: HEAD o `produced_commit` del único writer-predecesor; ≥2 writers → `blocked/deps-unavailable` (sin merges). Repo sucio → construye desde HEAD con `dirty_excluded` + resumen visible, sin tocar cambios del usuario. Commit harness con identidad fija al completar el implementer (`produced_commit`; árbol limpio → `produced=base`); reintento reutiliza el mismo worktree. Reviewer lee el worktree del target sin tomarlo (estados intactos incl. `finished`). Limpieza solo explícita del usuario (sin agentes activos, árbol limpio; rama conservada por defecto); `reconcile()` post-reinicio resuelve ops, suspende asignados/en ejecución y barre huérfanos en ambas direcciones (ramas con trabajo se conservan para Etapa 5).
- **IntegrationManager, único creador/destructor (Etapa 5, implementado):** un espacio por run (`harness/integration/run-<runId>` + worktree) con journal y reconciliación; incorpora `produced_commit` verificados (13 checks: procedencia, historial, scopes, secretos, `.git`, orden topológico) con estrategia contenido→skip, FF→`merge --ff-only`, resto→`merge --no-ff` (identidad harness); conflicto→`merge --abort` + fila abierta, nunca MERGE_HEAD en la rama. Idempotente por (integration, task, attempt). Auto-build P1: crear + incorporar + suite al completar escritores revisados.
- **WorkBase (Etapa 5, implementado):** `harness/workbase/run-<R>/task-<T>` fusiona los produced de ≥2 predecesores escritores revisados; el worktree del dependiente deriva de su tip; conflictos por el flujo §C; reconcile marca stale sin físico.
- **ConflictManager, resolución asistida (Etapa 5, implementado):** worktree de resolución con el merge a medias (MERGE_HEAD solo ahí); implementer con scope estricto (solo ficheros del conflicto; el harness commitea, padres intactos); validación de scope/secretos; incorporación con verificación de padres; reutilización por misma pareja verificada. Sin perfiles nuevos.
- **ValidationService (Etapa 5, implementado):** suite por SHA (unión de validationCommands en copia desechable + allowlist; fuera → blocked; vacía → skipped explícito); gate (cero failed/blocked/pending/running + review accept) antes de aprobar; review registrada por acción explícita con instancia reviewer dentro del worktree.
- **Reviewer** revisa la integración (instancia `reviewer` sobre el worktree de integración, sin escritura; selector `integrationId` validado por el harness).
- **PreviewManager (Etapa 5, implementado; cierra P-06):** worktree detached en el SHA exacto; fases install/start de allowlist por proyecto (sin autodetección); env por allowlist + `OCTUS_PREVIEW_*` con assert anti-secretos; DB de prueba separada; localhost por convención; puertos dinámicos con sonda; kill del árbol; logs acotados; reconcile marca huérfanos sin matar. Declaración honesta: no es un sandbox.
- **ApprovalService (Etapa 5, implementado):** aprobación inmutable del usuario pinneada a (integration, head, preview|waiver, destino+base observados, hash de validaciones); re-verificación en vivo; duplicado idéntico idempotente; rechazo terminal; waiver prohibido si hay preview aplicable.
- **PromotionManager (Etapa 5, implementado):** pre-cheques (aprobación vigente, destino inmóvil, checkout limpio sin ops pendientes, preview/validaciones); destino con checkout → `merge --ff-only` allí; sin checkout → `update-ref` CAS; nunca stash ni push; journal + reconcile que determina (completado/no-iniciado/divergido); stale + rebuild explícito ante destino movido.

## 11. Memoria

| Ámbito | Contenido | Fuente de verdad |
|---|---|---|
| Permanente de proyecto | Arquitectura, stack, convenciones, decisiones aprobadas, contratos | Archivos del proyecto + `MemoryItem` aprobados |
| Sesión | Resumen vivo, decisiones de la conversación, perfil y modelos usados | SQLite + checkpoints |
| Run/Task | Objetivo, plan, resúmenes de entrega, resultados de investigación, dependencias | SQLite + artefactos (commits, informes) |
| Instancia | Su conversación completa | Mensajes persistidos por instancia |

El `ContextBuilder` selecciona memoria relevante por task (no vuelca historiales ajenos completos). Un hallazgo nace `provisional`; solo una aprobación (usuario o coordinador con registro) lo convierte en permanente. Sin base vectorial (ADR-010).

## 12. Persistencia

SQLite (`node:sqlite`, WAL) con migraciones versionadas, transacciones con SQL explícito y claves foráneas. **Todo acceso SQLite vive en un hilo worker dedicado** propietario de la única conexión; el hilo principal y el renderer usan el protocolo asíncrono del `PersistenceService` (ADR-020). **Migración 0001 (Etapa 1, solo tablas del núcleo):** `schema_migrations`, `projects`, `agent_definitions`, `sessions`, `runs`, `agent_instances` (sin `task_id`/`worktree_id`), `messages`, `tool_invocations` (con `idempotency_key` y `provider_call_id` únicos), `events`, `artifacts`, `provider_configs` (sin secretos), `permission_rules`, `usage_records`, `budgets`. Migraciones posteriores: `tasks`+`task_dependencies`+`plannings`+reservas/equidad (Etapa 3), `repositories`+`worktrees`+`managed_branches`+`worktree_ops` con `agent_instances.worktree_id` y triggers de anclaje inmutable (Etapa 4), `integrations`+`integration_commits`+`integration_ops`+`work_bases`+`integration_conflicts`+`conflict_resolutions`+`validations`+`integration_reviews`+`previews`+`integration_approvals`+`promotions`+`promotion_ops` con triggers de anclaje/inmutabilidad (Etapa 5, migración 0005; 0006 añade task/attempt/instance a conflictos) y `memory_entries` con triggers de anclaje/transiciones blancas (Etapa 6, migración 0007). Sin fallback JSON en la Etapa 1 (ADR-017). Al arrancar, estados `running` huérfanos se liquidan como interrumpidos. Logs con redacción de secretos y de contenido cifrado de razonamiento.

## 13. Eventos, IPC e interfaz

- **Eventos del core** (tipados en shared): `session.*`, `run.*` (incl. `run.status_changed`), `task.*`, `planning.*`, `review.*`, `scheduler.*`, `worktree.*` (`created/released/status_changed/removed`), `workbase.created/status_changed`, `integration.*` (`created/conflict_opened/conflict_resolved/validated/reviewed/status_changed/completed`), `resolution.requested/completed`, `preview.created/ready/started/stopped`, `approval.requested/granted/rejected/invalidated`, `promotion.started/failed/completed`, `instance.*`, `message.*`, `part.*`, `permission.*`, `question.*`, `memory.*`, `config/providers`, `error`. El renderer filtra por sesión/run visibles (patrón de rendimiento conservado de la referencia).
- **IPC:** contrato único en shared consumido por main/preload/renderer, con validación de emisor y de cargas; preload mínimo sin `invoke` genérico; `sandbox:true` como meta (ADR-014).
- **Vistas:** chat de sesión con el coordinador; panel de orquestación (DAG de tasks con estados, instancias y entregas); worktrees e integración (diff, validación, preview, aprobación por SHA); ajustes de proveedores (solo Meta/OpenCode Go, estado de credencial sin mostrarla), perfiles y permisos.
- **Markdown** con sanitizador reconocido; todo contenido de modelo/páginas/herramientas se trata como no confiable.

## 14. Observabilidad y costes

Log estructurado local (sin secretos ni prompts completos por defecto), con correlación session/run/task/instance/toolCall; **registro de uso y coste por llamada** (`usage_records`: input/output/reasoning/cached tokens + coste en micro-USD con snapshot de tarifas; coste `NULL`+`pricing_missing` sin tarifa verificada) agregado por instancia, run y sesión, y **presupuestos** (`budgets`) con aviso idempotente y bloqueo previo a la generación, comprobados por el Router (ADR-019). Límite de tokens por run como guarda independiente del precio.

## 15. Estrategia de verificación de la arquitectura

- Proveedores falsos propios (Responses de Meta y compatible de Go) para pruebas sin claves, inspirados en los mocks de la referencia pero escritos para Octus.
- Pruebas unitarias por componente (DAG, permisos, contención de rutas, integración Git con repos temporales), de integración del runtime con proveedor falso, y e2e de escritorio en etapas avanzadas.
- Puertas por etapa en IMPLEMENTATION_ROADMAP: ninguna funcionalidad se declara hecha sin comportamiento real verificado (ADR-016).

## 16. No-objetivos del diseño inicial

Sin nube ni cuentas, sin bases vectoriales, sin proveedores adicionales, sin extensión de navegador, sin automatizaciones por horario, sin push/publicación automática, sin empaquetado/instalador y sin extracción ni almacenamiento de cadenas privadas de razonamiento.

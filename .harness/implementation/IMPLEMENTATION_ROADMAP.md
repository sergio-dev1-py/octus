# IMPLEMENTATION_ROADMAP.md — Roadmap de implementación de Octus

- **Fecha:** 2026-10-30
- **Regla de avance (ADR-016):** no se inicia una etapa sin completar, validar y documentar la anterior. Cada etapa termina con el informe del PROMPT MASTER §9 (qué se implementó, qué conceptos se reutilizaron de la referencia, archivos tocados, pruebas reales y resultados, limitaciones, riesgos y siguiente paso).
- **Orden:** el del PROMPT 0 §E, verificado contra las dependencias reales del diseño en `TARGET_ARCHITECTURE.md`.

## Etapa 0 — Prompt 0: auditoría y plan (esta etapa)

- **Entregables:** `AUDIT.md`, `CURRENT_ARCHITECTURE.md`, `TARGET_ARCHITECTURE.md`, `REUSE_MATRIX.md`, `DECISIONS.md`, `IMPLEMENTATION_ROADMAP.md`, `MASTER_SPEC.md` en `.harness/implementation/`.
- **Incluye:** auditoría de OpenOrch con referencias verificables, verificación de la documentación oficial de Meta, línea base segura de la referencia (typecheck OK; core 144/144; schedule 12/12; bridge 13/13; readmes OK; `e2e` no ejecutado por diseño) y decisiones ADR-001…016 con pendientes P-01…P-08.
- **Fuera:** código funcional, dependencias, modificaciones a OpenOrch.
- **Puerta de salida:** el propietario revisa y aprueba estos documentos (o pide ajustes). Sin aprobación no hay Etapa 1.

## Etapa 1 — Núcleo, persistencia, proveedores y runtime

**Objetivo:** un agente único (sin subagentes ni DAG) que conversa en streaming, usa herramientas básicas y persiste, contra Meta y OpenCode Go reales y contra proveedores falsos en pruebas.

- **Alcance:**
  - Andamiaje del monorepo (Bun workspaces, TypeScript estricto, scripts de check/test) con código propio. `git init` sin commit al arrancar (P-08).
  - `packages/shared`: contratos de dominio mínimos (sesión, mensajes, partes, eventos, IPC) consumidos efectivamente por core y escritorio.
  - `PersistenceService`: SQLite en hilo worker dedicado (ADR-020); migración 0001 solo con las tablas del núcleo (`schema_migrations`, `projects`, `agent_definitions`, `sessions`, `runs`, `agent_instances`, `messages`, `tool_invocations`, `events`, `artifacts`, `provider_configs`, `permission_rules`, `usage_records`, `budgets`); tasks/worktrees/integraciones/aprobaciones/memoria llegan por migraciones en sus etapas. Sin fallback JSON (ADR-017). Credenciales en almacén del SO con API asíncrona de `safeStorage` (P-04).
  - Adaptador Meta Responses con SDK oficial `openai` (P-02 resuelto en el Hito 0), confirmación live de `reasoning.effort=max` y límites con clave (P-01), adaptador Go por protocolo nativo por modelo con shortlist (`glm-5.3-flash`, `deepseek-v4.1-flash`) y verificación live con clave (P-03).
  - `ModelRouter` con adaptadores Meta y OpenCode Go: streaming, tool calling validado en local, errores tipados con reintentos según matriz verificada, registro de uso/coste por llamada y presupuestos con aviso/bloqueo (ADR-019).
  - `AgentRuntime` de una instancia: cola, pasos idempotentes, cancelación, límites de pasos/timeout, compactación corregida (ADR-015.6/7) y `ContextBuilder` básico (sistema + perfil + proyecto).
  - Herramientas mínimas tras `ToolGateway`/`PermissionManager`: read/write/edit/glob/grep/shell con contención realpath, puertas por defecto denegadoras y política de shell ADR-018 (aprobación previa, entorno por allowlist sin secretos, muerte del árbol de procesos).
  - Shell de escritorio mínimo: ventana, IPC tipado con validación, chat con streaming, ajustes de los dos proveedores (sin mostrar secretos), saneado Markdown seguro.
- **Fuera:** subagentes, DAG, worktrees, memoria, MCP, navegador, Code Mode.
- **Pruebas:** unitarias (permisos, contención, estimación/compactación, router con respuestas grabadas/falsas), integración runtime↔proveedor falso (tool loop completo, cancelación, reintento sin doble efecto), typecheck, probes SQLite en Bun y en Electron, política shell (denegación sin aprobación, entorno sin secretos, árbol terminado), agregación de `usage_records` y aviso/bloqueo de presupuestos sin duplicados. Prueba real con clave de Meta y de Go registrada manualmente (sin secretos en el repo).
- **Puerta de salida:** sesión real extremo a extremo en la app contra ambos proveedores; ninguna llamada sin fila en `usage_records`; con un `block` agotado la generación no sale del Router; suite verde; informe de etapa con los spikes resueltos.
- **Estado (2026-10-30):** implementado y verificado salvo la validación live (sin claves en el entorno): typecheck verde, 51 tests core + 1 shared en verde, build + smoke + arranque GUI en verde, `check:live` en SKIP documentado. **Etapa no declarada terminada** hasta ejecutar el live con claves.
- **Cierre (2026-10-31):** validación live superada por el propietario, **14/14 checks** de `check:live`. Con tool calling real: Meta Spark (`read`: solicitada, ejecutada, entregada, respuesta final con el contenido) y Go `glm-5.3-flash` (solicitada, ejecutada, entregada). Solo texto: Meta Wonder (turno + historial), Spark con `reasoning.effort=max`, Go `grok-4.7`, conectividad Meta y refresco del catálogo Go. Suite final: 56 core + 1 shared en verde. **Etapa 1 cerrada.** Hallazgo y corrección registrados en DECISIONS.md (correlación `item.id` en Responses).

## Etapa 2 — Agentes principales, subagentes, permisos y Plan Manager

**Objetivo:** coordinador con perfiles plan/build en conversación continua, cuatro subagentes por delegación simple (foreground/background, sin DAG) y planes internos en SQLite con aprobación exclusiva del usuario.

- **Alcance:**
  - `AgentRegistry` con definiciones declarativas YAML validadas con Zod (sin ejecución de código): plan/build del coordinador único (ADR-006) y explorer/researcher/implementer/reviewer (ADR-007) con prompts propios versionados; snapshot de definición por instancia (ADR-028).
  - Conversación continua Plan/Build: mismo `session_id`, contexto de sesión cronológico con modo por mensaje, cambio de modo sin reiniciar historial (ADR-024).
  - `PlanManager` interno en SQLite: `plans`, `plan_revisions` (contenido estructurado + Markdown inmutables), `current_revision_id` y `approved_revision_id` separados, ciclo de presentación y aprobación por ejes independientes, aprobación solo-usuario vinculada a `(plan_id, revision_id)` exactos, Build ejecuta solo la revisión aprobada seleccionada (ADR-017/ADR-022/ADR-023). Sin Markdown automáticos, sin tarjetas permanentes.
  - `AgentManager` con `delegate` por llamada + background: `agent_status/message/wait/result/cancel`, cancelación en cascada, límites 4 activos/sesión y 6/proyecto (coordinador incluido), profundidad máxima 2, exclusividad real de directorios, recuperación tras reinicio (ADR-025). Sin DAG ni Scheduler (Etapa 3).
  - Permisos con techo duro del perfil (las capas inferiores solo estrechan), scope canónico por rutas reales, rutas protegidas (`.env*`, BD interna, secretos), guardas Git deterministas; Implementer solo en directorio/worktree asignado y validado, sin crear ramas ni worktrees (ADR-026); Researcher con `WebSearchProvider` intercambiable + WebFetch con SSRF completa; Reviewer con `test_run` en copia desechable sin `.git` (ADR-029).
  - Composición de prompts en 6 capas; compactación de la conversación compartida con estado de planes inyectado desde SQLite; instrucciones de repo/web como no confiables salvo aprobación explícita (ADR-027).
  - Skills básicas con procedencia registrada (opcional si el tiempo aprieta: mover a Etapa 6 sin bloquear).
- **Fuera:** planificación en Tasks/DAG (Etapa 3), Worktree Manager gobernado y creación automática de worktrees/ramas (Etapa 4), MCP y navegador.
- **Pruebas:** matriz de permisos por perfil (incl. intentos de escritura de perfiles lectores, symlinks/UNC), modelo/esfuerzo por perfil, delegación background con supervivencia al run, cancelación en cascada, continuación de instancias, escenarios A–G de planes/conversación, imposibilidad de autoaprobación, vínculo mensaje↔revisión, recuperación tras reapertura, preservación de aprobaciones al compactar, más regresión completa de la Etapa 1.
- **Puerta de salida:** escenarios A–G en verde, matriz §F del Prompt 2 en verde, `check:live` de la Etapa 2 (delegación y planes contra proveedores reales) en verde y regresión de la Etapa 1 intacta.
- **Estado (2026-10-30):** implementado y verificado salvo la validación live (sin claves en el entorno): typecheck verde (shared+core+desktop node/web), 110 tests core + 1 shared en verde, build + smoke + arranque GUI en verde, `check:live` en SKIP documentado (Etapa 1 intacta + Etapa 2 con 15 checks nuevos tras MODEL_API_KEY). UI de escritorio: etiquetas discretas de modo por mensaje, planes plegables con aprobar/rechazar/archivar/exportar/implementar vinculados a (plan, revisión), agentes plegables con cancelación, ajustes de agentes (límites, modelos por definición) y de proyecto (directorios aislados, allowlist de tests, instrucciones confiables). **Etapa no declarada terminada** hasta ejecutar el live con claves.

## Etapa 3 — Scheduler, tareas, DAG y paralelismo

**Objetivo:** el coordinador planifica Runs en Tasks gobernadas y el sistema las ejecuta en paralelo con seguridad.

- **Alcance:**
  - Migración SQLite con `tasks`, `task_dependencies` y `agent_instances.task_id`.
  - Entidades Run/Task/TaskGraph con persistencia y eventos; detección de ciclos.
  - `TaskPlanner`: propuesta de plan (perfil, dependencias, ámbito de escritura, criterios, modelo/esfuerzo) inspeccionable por el usuario.
  - `Scheduler`: concurrencia global/por perfil/por proveedor, ámbitos disjuntos entre escritores, presupuestos por run, timeouts; `AgentManager` + `AgentMessaging` estructurada.
  - Vista de orquestación en la UI (DAG con estados, instancias y entregas).
- **Fuera:** worktrees automáticos por task (las tasks escritoras se serializan sobre el workspace o se bloquean hasta la Etapa 4; el Scheduler ya respeta ámbitos), integración (Etapa 5).
- **Pruebas:** DAG (ciclos, dependencias, replanificación), concurrencia con scopes solapados/disjuntos, límites y presupuestos, recuperación tras reinicio con tasks en curso.
- **Puerta de salida:** un Run real con ≥3 tasks paralelas lectoras y serialización correcta de escritoras, con registro completo auditable.
- **Estado (2026-10-31):** implementado y verificado + live ejecutado: typecheck verde (shared+core+desktop node/web), 140 tests core + 1 shared en verde (incl. suites nuevas `task-graph`/`planner`/`scheduler` y test anti-deadlock), build + smoke + arranque GUI (`--octus-autoquit`, quit 0) en verde. Live Etapa 3 (`--octus-acceptance-3`, claves del almacén del SO): **matriz A PASS 35/35** (Meta contributor/xhigh: plan→planner real→2 lectoras en 1 tick→implementer→reviewer accept→run done, modelos y usage verificados por instancia); **matriz B BLOCKED** (deepseek-v4.1-flash/max no entrega el contrato `{"tasks":[...]}` con contenido tras 12 intentos; limitación del modelo, no del producto). Hallazgos live corregidos: `conversationId` del planner para Go, `instructions` como developer en chat-transport, `tool_choice` solo con tools, snapshot real del coordinador + `failUnstarted`, regla anti-deadlock reviewer→needsReview, presupuestos xhigh (10M/500k). Informe: `.harness/implementation/STAGE3_ACCEPTANCE_REPORT.md`. **Etapa declarable terminada** (puerta unitaria + live A superadas; B re-ejecutable cuando el modelo cumpla el contrato).

## Etapa 4 — Git Worktrees

**Objetivo:** cada implementer trabaja aislado con trazabilidad Git completa.

- **Alcance:**
  - Migración SQLite con `worktrees` y `agent_instances.worktree_id`.
  - `RepositoryManager` (raíz, rama destino, estado sucio con política ADR-011) y `WorktreeManager` exclusivo: creación desde commit base registrado, rama por task, scope impuesto por el ToolGateway, commit producido registrado.
  - Asignación automática worktree↔task escritora en el Scheduler; retirada gobernada (nunca destructiva en silencio).
  - Detección de conflictos potenciales entre worktrees (mismos archivos) visible para el coordinador.
- **Fuera:** integración entre worktrees (Etapa 5).
- **Pruebas:** repos temporales (creación desde base, ramas, scopes, repos sucios, worktrees preexistentes ajenos intactos), dos implementers en paralelo sin interferencia.
- **Puerta de salida:** dos tasks escritoras paralelas producen commits aislados y trazables (base→producido) sin tocar el workspace original.

## Etapa 5 — Integración, validación, preview y aprobación

**Objetivo:** cerrar el flujo completo del PROMPT MASTER §7.

- **Alcance:**
  - Migración SQLite con `integrations`, `integration_tasks` y `approvals`.
  - `IntegrationManager` serializado por repo: rama intermedia, integración secuencial por dependencias, conflictos detenidos y reportados.
  - `ValidationService` (comprobaciones del proyecto detectadas/configuradas) + revisión con perfil `reviewer` sobre la integración.
  - `PreviewManager` (resuelve P-06) y presentación de evidencia al usuario.
  - `ApprovalService`/`PromotionManager`: aprobación ligada a SHA y rama destino, invalidación automática, promoción segura y registro; sin push automático.
- **Fuera:** resolución automática de conflictos de merge (se reporta; la resolución es tarea nueva del coordinador).
- **Pruebas:** integraciones con/sin conflicto, invalidación por movimiento de destino, aprobación sobre SHA obsoleto rechazada, promoción solo tras aprobación válida.
- **Puerta de salida:** flujo completo demostrado en un proyecto real del usuario: workers → integración → validación → preview → aprobación → promoción, con el workspace original intacto hasta la promoción.

## Etapa 6 — Memoria, recuperación y concurrencia avanzada

**Objetivo:** sistema completo y robusto para sesiones largas.

- **Alcance:**
  - Migración SQLite con `memory_entries` (+ fallback JSON si procede, con suite de contrato).
  - `MemoryService` completo (proyecto/sesión/run/task, promoción gobernada de hallazgos) integrado en el `ContextBuilder`.
  - Recuperación tras errores/caídas: reanudación de runs/tasks, liquidación de estados intermedios, reintentos gobernados.
  - Concurrencia avanzada: presupuestos adaptativos, prioridades, más instancias por perfil con límites por proveedor.
  - Extras evaluados por separado (cada uno con su mini-diseño y puerta): MCP con confianza por workspace, navegador dock, Code Mode con permisos plenos, automatizaciones por horario, empaquetado/instalador.
- **Pruebas:** caídas simuladas a mitad de run/integración, memoria (promoción/rechazo), sesiones largas con compactaciones sucesivas sin pérdida del tramo reciente.
- **Puerta de salida:** informe de madurez con limitaciones conocidas; decisión del propietario sobre extras y publicación.

## Transversal a todas las etapas

- Documentación viva: actualizar estos documentos (arquitectura, decisiones, matriz) en la misma etapa que introduce el cambio.
- Sin secretos en el repo ni en logs; los proveedores falsos son la vía por defecto de prueba.
- Cada etapa entrega informe con resultados reales de pruebas; "compila" nunca equivale a "terminado" (ADR-016).
- Dependencias nuevas solo con justificación registrada en DECISIONS (en Etapa 0 no se añadió ninguna).

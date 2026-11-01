# Todo 5. Contratos nuevos, mapa de integracion, matriz de permisos y presupuestos

- Plan: `.omo/plans/octus-ux-skills-mcp.md`, Todo 5, ola 7 (diseno).
- Rama: `feat/ux-skills-mcp-w7-design`, worktree `octus-wt-octus-ux-skills-mcp-w7`.
- Regla de trabajo: diseno solamente. No se programa ningun servicio. Todo contrato
  que llegue sin consumidor, sin canal o sin persistencia se rechaza como incompleto
  y vuelve a redactarse. No se reabren contratos de las etapas 1 a 6.
- Rutas: este documento solo cita rutas vivas verificadas en el arbol del worktree
  (comprobadas el 2026-11-01). Los documentos de linaje anteriores al arbol vivo
  quedan en cuarentena total como referencia de integracion, segun la nota del
  Todo 1; aqui no se citan como prueba de nada.

Fuentes leidas para este diseno (todas existen en el arbol):

- `packages/core/src/tools/tool-gateway.ts` (puerta unica de ejecucion, ADR-008)
- `packages/core/src/permissions/permission-manager.ts` (denegar por defecto, ADR-008/018)
- `packages/core/src/orchestration/agent-manager.ts` (ciclo de vida de subagentes, ADR-025)
- `packages/core/src/runtime/context-builder.ts` (capas de instrucciones, ADR-015.6/027)
- `packages/shared/src/ipc.ts` (contrato IPC unico, ADR-014)
- `packages/shared/src/tools.ts`, `packages/shared/src/permissions.ts`, `packages/shared/src/domain.ts`
- `packages/core/src/persistence/persistence-service.ts` y `packages/core/src/persistence/schema.ts`
- `packages/core/src/secrets/secret-store.ts` (secretos en almacen del SO, ADR-009)
- Notas del Todo 1 (cuarentena y autoridad del arbol vivo)

## 1. Contratos nuevos de interfaz y backend

Convenciones de la tabla: `NUEVO` = pieza que crean las olas 8 a 15; `EXISTENTE` =
pieza de las etapas 1 a 6 que se reutiliza sin cambios. `Canal` es siempre un canal
de `packages/shared/src/ipc.ts`, el bus `octus:event`, o llamada in-process dentro
de core con su evento IPC visible. `Persistencia` es siempre tabla SQLite existente
o nueva (misma base, nueva migracion) o clave `kv` o secreto en el almacen del SO.
Ningun secreto va a SQLite ni a JSON plano.

### C-01. Preferencias de UI (tema, tamano, densidad, layout)

- Productor: pantalla de trabajo del renderer (conmutadores de tema, tamano y densidad).
- Consumidor: manejador `main` de preferencias, que valida y guarda.
- Canal IPC: `prefs.get` / `prefs.set` (NUEVO, a declarar en `packages/shared/src/ipc.ts`).
- Persistencia: clave `kv` `ui.prefs.v1` (EXISTENTE mecanismo `kv`, NUEVA clave).
- Sirve a: olas 8 (Todos 6, 7, 8). Si la clave llega corrupta, se usa el valor por
  defecto y la app arranca igual (caso failure del Todo 6).

### C-02. Bienvenida con recientes, selector nativo y soltar carpeta

- Productor: proceso `main` (dialogo nativo y zona de soltar de `apps/desktop/src/main/index.ts`).
- Consumidor: pantalla de bienvenida del renderer (sin proyecto auto-seleccionado).
- Canal IPC: `app.pickDirectory` (EXISTENTE) mas `projects.list`, `sessions.list`,
  `projects.create`, `sessions.create` (EXISTENTES).
- Persistencia: tablas `projects` y `sessions` (EXISTENTES) mas clave `kv`
  `welcome.recents.<projectId>` con fecha de ultimo acceso (NUEVA clave).
- Sirve a: olas 9 (Todos 10, 11). Carpeta inexistente o sin permiso: error visible,
  sin crear proyecto.

### C-03. Linea de tiempo de chat con streaming y cancelacion

- Productor: nucleo (`OctusCore` en `packages/core/src/sessions/octus-core.ts` con
  `AgentRuntime` en `packages/core/src/runtime/agent-runtime.ts`).
- Consumidor: linea de tiempo del renderer (`.message-timeline`, `#composer`).
- Canal IPC: `sessions.prompt`, `sessions.messages`, `sessions.interrupt`, `runs.get`
  (EXISTENTES) mas bus `octus:event` con `CoreEvent` de `packages/shared/src/events.ts`
  (EXISTENTE).
- Persistencia: tabla `messages` (EXISTENTE); linea de corte de compactacion en
  `kv` `compaction.session.<sessionId>` y `compaction.<instanceId>` (EXISTENTE).
- Sirve a: ola 10 (Todos 12, 13, 14). Cancelar a mitad de stream detiene el run sin
  mensaje fantasma ni duplicado.

### C-04. Aprobaciones, preguntas y permisos desde el chat

- Productor: renderer (dialogos de aprobacion, preguntas y permisos).
- Consumidor: manejadores `main` de aprobaciones, preguntas y permisos.
- Canal IPC: `approvals.pending`, `approvals.decide`, `questions.pending`,
  `questions.reply`, `permissions.pending`, `permissions.reply`, `permissions.saved`,
  `permissions.revokeSaved` (todos EXISTENTES).
- Persistencia: tablas `approval_requests`, `permission_rules`, `events`
  (EXISTENTES). Las solicitudes pendientes viven en memoria del manager y en el
  bus; lo durable es el evento `permission.asked` / `permission.replied` y la regla
  guardada.
- Sirve a: ola 10 (Todo 14). Una aprobacion duplicada o fuera de revision se
  rechaza por idempotencia.

### C-05. Vista de agentes, tareas, runs y worktrees

- Productor: renderer (vista del Agent Manager).
- Consumidor: manejadores `main` sobre `TaskManager`, `Scheduler`, `AgentManager`
  y `WorktreeManager`.
- Canal IPC: `agents.definitions`, `agents.instances`, `agents.cancel`,
  `agents.limits`, `agents.setLimits`, `agents.setDefinitionModel`, `tasks.list`,
  `tasks.get`, `tasks.cancel`, `tasks.retry`, `tasks.review`, `tasks.scheduler`,
  `worktrees.list`, `worktrees.get`, `worktrees.cleanup` (todos EXISTENTES).
- Persistencia: tablas `agent_definitions`, `agent_instances`, `tasks`,
  `task_dependencies`, `task_attempts`, `task_review_verdicts`,
  `scheduler_reservations`, `worktrees`, `worktree_ops` (EXISTENTES) mas
  `kv` `delivery.seen.<instanceId>` para entregas ya consumidas (EXISTENTE).
- Sirve a: ola 11 (Todos 15, 16). Sin agentes ficticios: todo estado viene de
  estas tablas. Un run cancelado muestra su estado final real.

### C-06. DAG, integraciones, conflictos, validaciones y promocion

- Productor: renderer (grafo, previews, diffs, revisiones).
- Consumidor: manejadores `main` sobre `IntegrationManager`, `ConflictManager`,
  `ValidationService`, `PreviewManager`, `ApprovalService`, `PromotionManager` y
  `RepositoryManager`.
- Canal IPC: `integrations.*`, `conflicts.*`, `validations.*`, `previews.*`,
  `approvals.approve/reject/status`, `promotions.*`, `repos.inspect`,
  `repos.setWorktreesRoot` (todos EXISTENTES).
- Persistencia: tablas `integrations`, `integration_commits`, `integration_ops`,
  `work_bases`, `integration_conflicts`, `conflict_resolutions`, `validations`,
  `integration_reviews`, `previews`, `integration_approvals`, `promotions`,
  `promotion_ops`, `repositories`, `managed_branches` (EXISTENTES).
- Sirve a: ola 11 (Todo 17). Sin promocion sin SHA fijado ni aprobacion previa.

### C-07. Registro de Skills en tres ambitos (NUEVO servicio)

- Productor: `SkillManager` nuevo en core (nombre propio de Octus; ola 12).
- Consumidor: renderer (catalogo e instaladas) y `ContextBuilder` (carga progresiva).
- Canal IPC: `skills.list`, `skills.get` (NUEVOS, a declarar en
  `packages/shared/src/ipc.ts`).
- Persistencia: tablas NUEVAS `skills` (id, nombre, descripcion, origen, ruta,
  alcance, version, estado de validacion, error) y `skill_states` (skill, proyecto,
  habilitada, procedencia) en la misma SQLite con migracion nueva. Nada de
  ejecucion de scripts al descubrir.
- Sirve a: ola 12 (Todos 18, 19, 20). Directorio sin `SKILL.md` valido se registra
  como error, nunca como skill.

### C-08. Instalacion, importacion y administracion de Skills (NUEVO)

- Productor: renderer (catalogo, detalle, importar, instalar).
- Consumidor: `SkillManager` via manejadores `main`.
- Canal IPC: `skills.install`, `skills.uninstall`, `skills.enable`,
  `skills.disable`, `skills.inspect` (NUEVOS).
- Persistencia: tablas `skills` y `skill_states` (NUEVAS, ver C-07). La fuente
  (carpeta local, zip o git con origen explicito) queda registrada en cada fila.
  Zip con ruta fuera de la skill: se rechaza sin escribir nada.
- Sirve a: ola 12 (Todos 21, 22). `installed` frente a `enabled` siempre distintos;
  activar no otorga permisos de herramientas.

### C-09. Carga progresiva de Skills en el runtime (NUEVO, in-process)

- Productor: `SkillManager`.
- Consumidor: `ContextBuilder`, coordinador, `AgentManager`, `ToolGateway` y
  `PermissionManager` (todos en `packages/core/src`).
- Canal IPC: llamada in-process dentro de core (sin IPC nuevo, justificado: es
  composicion interna) con efecto visible en `octus:event` (`tool_call.*` con la
  skill usada registrada) que el renderer ya consume.
- Persistencia: tablas `skills` / `skill_states` (NUEVAS) mas clave `kv`
  `run.skills.<runId>` con el registro de skills usadas por run (NUEVA clave).
- Sirve a: ola 12 (Todo 23). El prompt solo lleva metadatos mas la skill relevante
  completa; una skill nunca autoriza una herramienta prohibida (puerta en
  `PermissionManager`, sin via de evasion).

### C-10. Servidores MCP con confianza por workspace (NUEVO servicio)

- Productor: `MCP Client Manager` nuevo en core (nombre propio de Octus; ola 13),
  sobre el SDK fijado en el Todo 25 (STDIO y Streamable HTTP vigentes, sin SSE
  legado).
- Consumidor: renderer (gestor de servidores MCP) via manejadores `main`.
- Canal IPC: `mcp.list`, `mcp.add`, `mcp.update`, `mcp.remove`, `mcp.connect`,
  `mcp.disconnect`, `mcp.trust` (NUEVOS).
- Persistencia: tabla NUEVA `mcp_servers` (configuracion SIN secretos) en la misma
  SQLite; secretos solo en el almacen del SO con referencia
  `octus.mcp.<serverId>` via `packages/core/src/secrets/secret-store.ts`
  (EXISTENTE patron); confianza por workspace en `kv` `mcp.trust.<projectId>`
  (NUEVA clave). Ningun servidor desconocido conecta solo al abrir su workspace.
- Sirve a: ola 13 (Todos 25, 26, 29). URL hacia rango privado (p. ej. SSRF) se
  rechaza; token revocado corta la conexion con auditoria.

### C-11. Herramientas MCP aisladas por servidor via ToolGateway (NUEVO)

- Productor: cada servidor MCP, a traves del `MCP Client Manager`.
- Consumidor: `ToolGateway` (`packages/core/src/tools/tool-gateway.ts`), que las
  registra con nombre aislado `<server>.<tool>`.
- Canal IPC: registro in-process en el gateway (sin IPC nuevo, justificado) con
  ejecucion y auditoria visibles en `octus:event` (`tool_call.requested`,
  `started`, `completed`, `failed`, EXISTENTES).
- Persistencia: tablas `tool_invocations` y `artifacts` (EXISTENTES); cada fila
  guarda servidor y herramienta de origen. Resultados MCP: contenido no confiable.
- Sirve a: ola 13 (Todo 27). Solo con servidor autorizado, herramienta disponible,
  perfil con permiso y aprobacion cumplida. Dos servidores con la misma herramienta
  no colisionan.

### C-12. Recursos y prompts MCP con aprobacion (NUEVO)

- Productor: `MCP Client Manager` (listado, lectura, plantillas, suscripciones).
- Consumidor: `ContextBuilder` (punto de inyeccion) via manejadores `main`, con
  aprobacion previa para lo sensible.
- Canal IPC: `mcp.resources.list`, `mcp.resources.read`, `mcp.prompts.list`,
  `mcp.prompts.get` (NUEVOS) apoyados en `approvals.*` y `permissions.*`
  (EXISTENTES) para la puerta.
- Persistencia: tabla `artifacts` (EXISTENTE) para contenido leido mas clave `kv`
  `mcp.resource_cache.<serverId>` con tope de tamano (NUEVA clave). Nada no
  negociado por protocolo se anuncia.
- Sirve a: ola 13 (Todo 28). Recurso sensible sin aprobacion: se niega antes de
  inyectarse al contexto.

### C-13. Terminal persistente con PTY en main (NUEVO)

- Productor: anfitrion PTY en `apps/desktop/src/main` (decision PTY-directo del
  Todo 3; sin `node-pty` en `packages/core`, el PTY vive solo en desktop).
- Consumidor: panel de terminal del renderer (varias terminales, redimension,
  cancelacion).
- Canal IPC: `terminal.create`, `terminal.input`, `terminal.resize`,
  `terminal.kill`, `terminal.list` (NUEVOS) con salida por streaming en
  `octus:event` como `terminal.output` (NUEVO tipo de evento, mismo bus).
- Persistencia: clave `kv` `terminal.state.<terminalId>` (cwd, columnas, filas
  para restaurar; NUEVA clave). La salida del PTY no se persiste por diseno.
  Toda entrada pasa por la politica de ejecucion (sonda del Todo 31); comando
  fuera de politica: se niega.
- Sirve a: ola 14 (Todo 32). Proceso que ignora la senal: lo termina el harness y
  la terminal queda reutilizable.

### C-14. Explorador, diffs, pruebas y panel de problemas (NUEVO UI)

- Productor: renderer (explorador y panel de problemas) sobre `RepositoryManager`,
  `WorktreeManager` y el corredor de pruebas existente.
- Consumidor: manejadores `main` de repositorios, worktrees y pruebas.
- Canal IPC: `repos.inspect`, `worktrees.list`, `worktrees.get`,
  `previews.logs` (EXISTENTES) mas `diagnostics.summary` (NUEVO, resume pruebas y
  validaciones para el panel de problemas).
- Persistencia: tablas `artifacts` (salidas de prueba), `validations` y
  `integration_reviews` (EXISTENTES). Proyectos grandes: arbol paginado, sin
  bloquear la UI.
- Sirve a: ola 14 (Todo 33).

## 2. Mapa de integracion

### 2.1 Diagrama (flujo de una accion de usuario hasta persistencia)

```text
Renderer (pantallas ola 8-11, 12-14)
  |  canales packages/shared/src/ipc.ts (EXISTENTES + C-01, C-07, C-08, C-10, C-12, C-13, C-14 nuevos)
  v
Main (apps/desktop/src/main/index.ts: valida remitente y carga util)
  |  delega a OctusCore (packages/core/src/sessions/octus-core.ts)
  v
OctusCore -> PermissionManager.decide()  (puerta previa a todo efecto)
          -> ToolGateway.execute()        (definicion, validacion, permiso, ejecucion, registro)
          -> AgentManager                (spawn, directorios, cancelacion en cascada)
          -> ContextBuilder              (capas: base + perfil + proyecto aprobado + memoria + planes + tools)
          -> PersistenceService          (worker SQLite, misma base, tablas §4)
          -> EventStore + bus octus:event (auditoria y streaming al renderer)
Secretos: solo SecretStore -> almacen del SO (packages/core/src/secrets/secret-store.ts
          y apps/desktop/src/main/secret-store.ts). Nunca SQLite, JSON ni logs.
```

### 2.2 Tabla de integracion por subsistema

| Subsistema vivo | Consume de | Aporta a | Contratos que lo tocan |
| --- | --- | --- | --- |
| ToolGateway | PermissionManager (veredicto), PersistenceService (`tool_invocations`, `artifacts`), EventStore | Ejecucion idempotente con auditoria de origen | C-09, C-11, C-03, C-04 |
| PermissionManager | AgentDefinition (`tools`, `deniedTools`, reglas), `permission_rules`, `kv` | Techo duro del perfil; `shell` nunca `always` | C-04, C-08, C-09, C-11, C-12, matriz §3 |
| AgentManager | AgentRegistry, DirectoryRegistry, WorktreeManager, Integration/Resolution ports | Spawn con directorio asignado; implementer sin directorio queda en solo lectura | C-05, C-09 |
| ContextBuilder | `trusted_instructions.<project>`, `memory_entries`, planes, entregas, Skills (C-09), recursos MCP (C-12) | Instrucciones por capas; sin scopes ajenos | C-03, C-09, C-12 |
| IPC (`packages/shared/src/ipc.ts`) | Main valida; preload minimo; renderer sin `invoke` generico | 100+ canales existentes mas 20 nuevos de este mapa | Todos los C |
| Persistencia | Worker SQLite unico; migraciones versionadas | Tablas §4; `kv` para estado; `events` para auditoria | Todos los C |

### 2.3 Reglas de borde (no negociables)

1. Ninguna herramienta corre sin pasar por `ToolGateway.execute` (ADR-008).
2. Ninguna skill otorga permisos; solo `PermissionManager` decide (C-09, C-11).
3. Ningun secreto sale del almacen del SO (C-10; escaneo del Todo 36 como gate).
4. Ningun servidor MCP conecta sin confianza explicita del workspace (C-10).
5. Ninguna promocion sin SHA fijado y aprobacion (C-06).
6. Ninguna ruta de linaje en cuarentena se usa como referencia de integracion.

## 3. Matriz de permisos por perfil y scope

Lectura: `Efecto base` = `DEFAULT_POLICY` en `permission-manager.ts` cuando el
perfil incluye la herramienta; si el perfil no la incluye, el veredicto es `deny`
sin excepcion (techo duro). `Alcances` = ambitos donde la herramienta tiene
sentido: P proyecto, S sesion, R run, T tarea, I instancia. Perfiles Kind:
coordinator (plan/build), explorer, researcher, implementer, reviewer, utility.

| Herramienta | Efecto base | Scopes | Notas de perfil |
| --- | --- | --- | --- |
| read | allow | P,S,R,T,I | Todos los kinds de lectura; implementer acotado a su directorio asignado |
| glob | allow | P,S,R,T,I | Igual que read |
| grep | allow | P,S,R,T,I | Igual que read |
| question | allow | S,R,I | Solo coordinator; abre pregunta al usuario |
| git_status | allow | P,S,R,T | Lectura; reviewer e implementer |
| git_diff | allow | P,S,R,T | Lectura; reviewer e implementer |
| websearch | allow | S,R | Coordinator, researcher, explorer;salida no confiable, nunca como sistema |
| webfetch | allow | S,R | Igual que websearch, con guardas SSRF existentes |
| delegate | allow | S,R,I | Solo kinds con `canDelegateTo` no vacio; techo de profundidad y concurrencia |
| agent_status | allow | S,R,I | Coordinator y supervisores |
| agent_message | allow | S,R,I | Igual que agent_status |
| agent_wait | allow | S,R,I | Igual que agent_status |
| agent_result | allow | S,R,I | Igual que agent_status |
| agent_cancel | allow | S,R,I | Igual que agent_status; cascada |
| plan.create | allow | S,R | Coordinator en perfil plan (y build con plan aprobado) |
| plan.update | allow | S,R | Igual que plan.create |
| plan.get | allow | S,R | Todos los kinds de planificacion |
| plan.list | allow | S,R | Igual que plan.get |
| plan.request_approval | allow | S,R | Coordinator; el modelo nunca se auto-aprueba |
| plan_tasks | allow | S,R,T | Coordinator y TaskPlanner |
| record_review | allow | T,R | Reviewer; veredicto sobre tarea objetivo |
| write | ask | P,S,R,T,I | Implementer con directorio asignado; sin directorio: deny (regla auditable) |
| edit | ask | P,S,R,T,I | Igual que write |
| shell | ask, nunca always | P,S,R,T,I | Permiso por comando; guardas `shell-guard`; timeout y cancelacion |
| git_stage | ask | P,S,R,T | Implementer en su ambito; nunca fuera del proyecto |
| git_commit | ask | P,S,R,T | Igual que git_stage, con mensaje validado |
| test_run | ask | P,S,R,T | Implementer y coordinator; solo entradas del allowlist del proyecto |
| memory_propose | ask | P,S,R,T,I | Coordinator y workers; la propuesta no es escritura hasta validar/decidir |
| memory_validate | ask | P,S,R,T,I | Solo actores con rol validador; ningun worker valida lo propio |

Reglas transversales: `deniedTools` del perfil gana sobre todo; `shell` jamas admite
`always` (ADR-018); scope desconocido se niega por defecto; la implementacion sin
directorio asignado recibe denegacion explicita de escritura (verificado en
`agent-manager.ts`, `resolveDirectory`).

Cobertura: 29 herramientas (todas las del gateway: 7 de `tool-definitions.ts`,
4 de `git-tools.ts`, 2 de `web-tools.ts`, 1 de `test-tools.ts`, 1 `delegate` mas
5 `agent_*` de `agent-tools.ts`, 5 `plan.*` de `plan-tools.ts`, 2 de
`task-tools.ts`, 2 de `memory-tools.ts`) por 5 scopes. Ninguna herramienta queda
sin fila y ningun scope queda sin columna.

## 4. Estrategia de persistencia

- Una sola base SQLite via `PersistenceService` (worker dedicado; el hilo
  principal nunca toca `node:sqlite`). Sin segunda base de datos.
- Tablas EXISTENTES reutilizadas: `projects`, `sessions`, `runs`,
  `agent_definitions`, `agent_instances`, `messages`, `tool_invocations`,
  `artifacts`, `events`, `permission_rules`, `usage_records`, `budgets`, `kv`,
  `plans`, `plan_revisions`, `approval_requests`, `tasks`, `task_dependencies`,
  `task_attempts`, `task_review_verdicts`, `isolated_directories`, `repositories`,
  `worktrees`, `worktree_ops`, `integrations`, `integration_commits`,
  `integration_ops`, `work_bases`, `integration_conflicts`, `conflict_resolutions`,
  `validations`, `integration_reviews`, `previews`, `integration_approvals`,
  `promotions`, `promotion_ops`, `memory_entries`.
- Tablas NUEVAS (misma base, migracion versionada en `schema.ts`, olas 12-13):
  `skills`, `skill_states`, `mcp_servers` (configuracion sin secretos).
- Claves `kv` NUEVAS: `ui.prefs.v1`, `welcome.recents.<projectId>`,
  `run.skills.<runId>`, `mcp.trust.<projectId>`, `mcp.resource_cache.<serverId>`
  (con tope), `terminal.state.<terminalId>`. Claves EXISTENTES reutilizadas:
  `trusted_instructions.<project>`, `compaction.*`, `delivery.seen.*`.
- Secretos: solo almacen del SO (`secretRefForProvider`, `octus.mcp.<serverId>`);
  redaccion en logs y evidencia; escaneo como gate del Todo 36. Rotacion de las
  claves externas existentes antes de cualquier verificacion live (pre-gate del
  usuario, fuera de este diseno).
- Migraciones: cada tabla nueva entra con migracion numerada y reversible en
  `MIGRATIONS`; ningun servicio nuevo lee la base sin pasar por `PersistenceService`.

## 5. Estrategia de seguridad

1. Electron: context isolation activado, node integration desactivado, preload
   minimo, IPC validado por canal (tabla `OctusIPC`), sin `invoke` generico,
   navegacion y enlaces externos controlados (auditoria Todo 35).
2. Puerta de herramientas: definicion, esquema zod, `PermissionManager.decide`,
   ejecucion, registro idempotente. Resultados MCP y web como contenido no
   confiable, con servidor y herramienta registrados.
3. Shell: `shell-guard` mas allowlist por proyecto, cwd acotado al directorio
   asignado, raices protegidas, timeout y arbol de procesos con `killTree`.
4. MCP: confianza por workspace primero (C-10), STDIO con comando y argumentos
   separados sin shell, HTTP con HTTPS y controles SSRF, limites de tamano,
   timeouts y cancelacion; secretos solo en almacen del SO.
5. Skills: validacion contra la fuente fijada del Todo 18; nada de ejecucion de
   scripts al descubrir, instalar o activar; procedencia siempre visible.
6. Memoria y proyectos: solo instrucciones de proyecto aprobadas entran como
   sistema (ADR-027); la web y el repo no aprobado nunca entran como sistema.
7. Evidencia sin secretos: la verificacion live exige confirmacion explicita y
   claves ya rotadas; por defecto todo se prueba con simulados locales
   (`C:\tmp\octus-qa-proj`, servidor `mcp-qa-stdio`, skill `qa-skill@1.0.0`).

## 6. Estrategia de pruebas

- Por ola: `bun test` para servicios y Playwright o smoke del harness con
  selectores fijos para UI (`#welcome-dropzone`, `.message-timeline`,
  `#composer`, `#agent-dag`). Sin revision manual como prueba.
- Determinismo: datos fijos (`qa-skill@1.0.0`, `mcp-qa-stdio` simulado STDIO y
  HTTP, proyecto en `C:\tmp\octus-qa-proj`); sin temporizadores fragiles, las
  esperas son por evento o estado con tope.
- Regresion: `bun run test` en raiz en verde antes de cerrar cada ola; ninguna
  ola se acepta con la suite de las etapas 1 a 6 en rojo.
- Failure primero: cada contrato C-01..C-14 trae su caso de rechazo (ver §1);
  cada ola trae guion rojo (permiso denegado, colision de nombres, secreto en
  plano, promocion sin SHA) ademas del happy path.
- Escaneo de secretos como gate del Todo 36; evidencia por todo en
  `.omo/evidence/octus-ux-skills-mcp/task-<N>.txt` con salida del comando.

## 7. Presupuesto de rendimiento (cifras objetivo, verifica el Todo 34)

Medido en Windows 10, CPU i3 de 2 nucleos, 4 GB libres, proyecto mediano
(2.000 archivos, historial de 500 mensajes). Metodo: script de presupuesto con
marcas de tiempo del harness mas contadores de render del renderer.

| Dimension | Objetivo | Como se mide |
| --- | --- | --- |
| Arranque frio hasta bienvenida visible | max 2,5 s | Marca main-listop mas primer paint; sin auto-seleccion de proyecto |
| Bienvenida a workbench interactivo | max 1,5 s adicionales | Tras abrir `C:\tmp\octus-qa-proj`; paneles diferidos |
| Memoria total (main + renderer + worker) en reposo | max 450 MB | Contadores del SO con proyecto mediano abierto |
| Memoria worker SQLite bajo carga de chat | max 100 MB | 500 mensajes con artefactos; tope `maxInlineChars`, resto a `artifacts` |
| Memoria por terminal PTY abierta | max 25 MB | Buffer de salida acotado; salida persistida: cero |
| Scroll de conversacion larga (5.000 mensajes) | 60 fps, ventana virtualizada | `.message-timeline` con virtualizacion; marcos contados en renderer |
| Primer token tras prompt (simulado local) | max 800 ms | Del `sessions.prompt` al primer evento de stream |
| Cancelacion de stream | max 300 ms hasta estado final | `sessions.interrupt` mas `agent.cancel` en cascada |
| Apertura de vista Agent Manager (100 tareas) | max 1 s | DAG paginado; `#agent-dag` con 100 nodos |
| Arranque con preferencias corruptas | max 3 s, con defecto aplicado | Caso failure del Todo 6 |
| Crecimiento de `events` por run tipico | max 2.000 filas | Auditoria completa sin retencion infinita (poda por politica) |

Si una medida supera el objetivo, la ola 15 la corrige (carga diferida de
paneles, paginacion, topes de buffer) antes del empaquetado. Ninguna correccion
puede relajar una puerta de seguridad.

## 8. Trazabilidad a olas y verificacion de este Todo

| Ola | Todos | Contratos que consume |
| --- | --- | --- |
| 8 | 6, 7, 8, 9 | C-01, C-02 |
| 9 | 10, 11 | C-02 |
| 10 | 12, 13, 14 | C-03, C-04 |
| 11 | 15, 16, 17 | C-05, C-06 |
| 12 | 18-24 | C-07, C-08, C-09 |
| 13 | 25-30 | C-10, C-11, C-12 |
| 14 | 31, 32, 33 | C-13, C-14 |
| 15 | 34, 35, 36 | Presupuesto §7, seguridad §5, gates §6 |

Verificacion de este Todo (agent-ejecutable, sin intervencion del usuario):
`node scripts/verify-task-5-map.mjs` afirma que cada contrato C-01..C-14 trae
productor, consumidor, canal y persistencia no vacios; que la matriz cubre las
29 herramientas y los 5 scopes; y que el presupuesto trae cifras. Su salida mas
`bun scripts/check-doc-refs.ts` quedan volcadas en
`.omo/evidence/octus-ux-skills-mcp/task-5.txt`. Contrato sin consumidor nombrado:
se rechaza como incompleto (caso failure del plan).

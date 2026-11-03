---
slug: octus-ux-skills-mcp
status: approved
approved: 2026-11-01 (Approve; terminal=PTY directo; catalogo=solo local/git/zip; imagenes=textual)
intent: clear
review_required: true
plan_path: .omo/plans/octus-ux-skills-mcp.md
plan_sha256: null
review_round_id: null
review_round_limit: 5
pending-action: write and review .omo/plans/octus-ux-skills-mcp.md
review:
  plan_reviewer:
    status: approved
    workspace_root: C:/Users/UserPy/Documents/octus
    runtime_home: null
    target: .omo/plans/octus-ux-skills-mcp.md
    round_id: rr-20261101-01
    plan_sha256: eb88c5f2331d86505b55792a9d16a30be1045e8510f80d64c7cd37cf3f956ab1
    launch_id: st_01a19894
    session: st_01a19894
    result: OKAY (approval; nota no bloqueante: rutas de intrucion.txt sin absoluta)
review_round_limit: 5
round_status: active
pending-action: review .omo/plans/octus-ux-skills-mcp.md
approach: Etapas 7-15 del intrucion.txt en un solo plan por olas (7 diseno -> 8 fundamentos -> 9 welcome/proyectos -> 10 conversacion -> 11 Agent Manager -> 12 Skills real -> 13 MCP real -> 14 terminal/archivos -> 15 optimizacion/distribucion), sin reabrir etapas 1-6, con skills frontend-design/ui-ux-pro-max/visual-qa solo como guia del ejecutor y specs externas citadas (Agent Skills 2026-08-09, MCP 2026-07-28).
---

# Draft: octus-ux-skills-mcp

## Affected user and ideal state
<!-- IS: programador intensivo usando Octus a diario + agentes que consumen Skills/MCP. Hoy: UI funcional monolitica, sin Skills/MCP/terminal reales. Ideal: workbench VS Code-like, temas persistentes, Skills y MCP usables desde agentes con permisos. -->
- IS-1 | Al abrir Octus ve una bienvenida que permite arrastrar carpeta o elegirla nativa, ver recientes con fecha, crear/continuar proyecto o sesion; nunca auto-selecciona proyecto | razon: punto de entrada predecible y seguro (intrucion 5)
- IS-2 | Trabaja en un workbench (activity bar, sidebar, conversacion central, inspector, panel inferior) con paneles ocultables/redimensionables/restaurables y preferencias persistentes | razon: entorno de programacion intensivo (intrucion 4-5)
- IS-3 | Lee/escribe chat con markdown, codigo, streaming, tool calls expandibles, planes, aprobaciones, preguntas, actividad de agentes y errores sin jank en conversaciones largas | razon: uso diario del harness (intrucion 10)
- IS-4 | Gestiona agentes/tareas/DAG/runs/worktrees/diffs/revisiones desde el Agent Manager reutilizando servicios existentes, sin agentes ficticios ni progreso inventado | razon: confianza en orquestacion real (intrucion 11)
- IS-5 | Instala/administra Skills (global/proyecto/Octus) y los agentes las usan con carga progresiva, scopes respetados y uso registrado por run | razon: extensibilidad real, no solo pantallas (intrucion 12)
- IS-6 | Conecta servidores MCP (STDIO local + Streamable HTTP remoto), descubre herramientas/recursos/prompts y los usa solo con servidor autorizado + permisos + aprobacion | razon: capacidad cliente MCP segura (intrucion 13)
- IS-7 | Usa terminal persistente, explorador, diffs, resultados de pruebas y diagnosticos bajo las politicas de ejecucion existentes | razon: ciclo completo sin salir del workbench (intrucion 14)
- IS-8 | Cambia tema claro/oscuro/sistema, paletas neutrales, tamano 12-18px y densidad compacta/normal/comoda con persistencia y CSS variables | razon: personalizacion ligera y profesional (intrucion 4)
- GAP-1 | Hoy App.tsx/store.ts monoliticos, sin welcome, sin workbench redimensionable, sin tokens CSS -> cerrar con olas 7/8/9
- GAP-2 | Hoy sin SkillManager ni integracion ContextBuilder/ToolGateway/PermissionManager -> cerrar con ola 12
- GAP-3 | Hoy sin MCP Client Manager, sin herramientas MCP aisladas por servidor, sin secretos en OS store -> cerrar con ola 13
- GAP-4 | Hoy sin terminal PTY ni panel de problemas/diagnosticos -> cerrar con ola 14
- GAP-5 | Hoy sin presupuesto de rendimiento ni distribucion Windows endurecida -> cerrar con ola 15

## Components (topology ledger)
- c1-ux-design | Sistema de diseno + arquitectura de informacion aprobados antes de codificar | status: active | evidencia: intrucion 5; App.tsx/store.ts por modularizar
- c2-frontend-core | Tokens, temas, layout workbench y persistencia de preferencias | status: active | evidencia: apps/desktop/src/renderer/src/App.tsx, store.ts, styles.css
- c3-welcome-projects | Bienvenida, drag-drop, recientes, sesiones/proyectos reutilizando servicios | status: active | evidencia: packages/core/src/sessions/octus-core.ts
- c4-conversation | Chat completo con streaming, tool calls, aprobaciones, composer | status: active | evidencia: App.tsx, shared/ipc.ts, shared/events.ts
- c5-agent-manager-ui | Vista agentes/tareas/DAG/worktrees/diffs reutilizando TaskManager/Scheduler | status: active | evidencia: tasks/task-manager.ts, task-graph.ts, worktrees/worktree-manager.ts
- c6-skills | SkillManager real + integracion runtime + UI catologo/instaladas | status: active | evidencia: falta packages/core/src/skills*; spec agentskills.io 2026-08-09
- c7-mcp | MCP Client Manager (STDIO+Streamable HTTP) + ToolGateway/PermissionManager + UI | status: active | evidencia: falta packages/core/src/mcp*; spec MCP 2026-07-28
- c8-terminal-files | Terminal persistente + explorador/diff/tests/diagnosticos | status: active | evidencia: TARGET_ARCHITECTURE terminal PTY en main (no implementado)
- c9-perf-dist | Rendimiento, seguridad Electron, build/distribucion Windows | status: active | evidencia: main/index.ts, preload, worker SQLite

## Open assumptions (announced defaults)
- Imagenes de referencia | No hay imagenes en PromtHack (solo 4 txt + k.txt con secretos); se planifica desde la direccion textual (VS Code patterns, monocromo, sin emojis) y la ola 7 absorbe imagenes si el usuario las adjunta luego | reversible: si (tokens/componentes no dependen de una captura)
- Skills instaladas que usan este plan | frontend-design, ui-ux-pro-max, visual-qa, programming, debugging, git-master como guia del ejecutor, no como dependencia de runtime | reversible: si
- Terminal en Windows | PTY en proceso main via node-pty o conpty directo, canal IPC con streaming; si la evaluacion demuestra peso excesivo se documenta alternativa ligera en ola 7 antes de implementar | reversible: si (decision tecnica con evidencia)
- Secretos MCP | OS credential store via Electron safeStorage, nunca SQLite/JSON plano; claves en k.txt quedan fuera del plan y deben rotarse | reversible: no (seguridad, requiere accion del usuario)
- Alcance | Se planifica el estado ideal completo 7-15, no un MVP recortado; cada etapa aceptable por separado | reversible: n/a

## Findings (cited - path:lines)
- intrucion.txt leido completo (etapas 7-15 + restricciones + estrategia de pruebas + limites plan mode) | path: C:/Users/UserPy/Desktop/PromtHack/intrucion.txt
- PromtHack contiene intrucion.txt, k.txt, promt comeplo.txt, Promt0.txt, promt1.txt y CERO imagenes; Desktop tiene ruta muse.png, Screenshot_1/2.png sin vinculo declarado al plan | verificado por listado
- k.txt contiene MODEL_API_KEY y OPENCODE_API_KEY en claro -> riesgo; el plan exigira rotacion y jamas citarlos | path: C:/Users/UserPy/Desktop/PromtHack/k.txt
- Repo octus: Bun+Electron45+SolidJS1.9+TS, etapas 1-6 cerradas (235 core + 1 shared green, live A/B PASS), sin Skills/MCP/terminal | paths: package.json, README.md, .harness/implementation/*
- Existe: ToolGateway (tools/tool-gateway.ts), PermissionManager (permissions/permission-manager.ts), AgentManager (orchestration/agent-manager.ts), ContextBuilder (runtime/context-builder.ts), IPC cerrado ~100 canales (shared/ipc.ts, main/index.ts), SQLite en worker (persistence-service.ts + schema migs 0001-0007)
- Falta: packages/core/src/skills*, mcp*, terminal/pty; sin canales IPC para skills/mcp/terminal; TARGET_ARCHITECTURE difiere MCP/browser y terminal PTY en main nunca implementado
- Specs externas verificadas por librarian: Agent Skills (agentskills.io/specification.md, dateModified 2026-08-09; SKILL.md + frontmatter name/description, disclosure 3 niveles, validacion skills-ref) y MCP 2026-07-28 (STDIO + Streamable HTTP, tools/list-call, resources, prompts, OAuth2.1, Origin/SSRF/secretos)
- skills instaladas aplicables: frontend-design, ui-ux-pro-max, visual-qa (diseno/QA), programming, debugging, git-master (ejecucion) | solo guia del ejecutor

## Decisions (with rationale)
- Intent CLEAR: el usuario entrega outcome detallado (etapas 7-15 con restricciones y criterios); solo quedan forks de preferencia -> se pregunta, no se adopta en silencio
- review_required: true por defecto (politica ulw-plan default-on; usuario no declino)
- Un plan unico con olas por etapa 7-15, cada ola aceptable por separado, rama por funcionalidad, gate verde antes de avanzar (intrucion 15)
- Skills formato Agent Skills estandar, no propietario (intrucion 12.1 + spec 2026-08-09)
- MCP solo cliente (STDIO + Streamable HTTP vigente); nada de HTTP+SSE legado ni MCP server salvo necesidad justificada (intrucion 13 + spec 2026-07-28)
- Carga progresiva de Skills (metadatos -> relevantes -> completas -> recursos), registro por run, scopes proyecto/sesion/run/tarea/instancia (intrucion 12.5)
- Seguridad MCP critica: confianza explicita global/workspace, safeStorage, comandos STDIO separados sin shell, SSRF/redirect/timeout/redaccion, PermissionManager como autoridad (intrucion 13.6)

## Scope IN
- Olas 7-15 del intrucion.txt: diseno integral, fundamentos frontend, welcome/proyectos/sesiones, conversacion, Agent Manager, Skills real, MCP real, terminal/archivos/resultados, optimizacion/distribucion Windows, estrategia de pruebas y roadmap/arquitectura/documentacion

## Scope OUT (Must NOT have)
- Reabrir o modificar innecesariamente contratos de etapas 1-6; sustituir motor de agentes/sesiones/ToolGateway/PermissionManager/AgentManager/Scheduler; segunda base de datos; cambiar garantias Electron; dependencias pesadas sin justificacion; romper aislamiento proyecto/sesion/run/worktree; ejecutar migraciones/instalar paquetes/conectar MCP/instalar skills de terceros/consumir creditos live en modo plan (intrucion 3, 17)

## Open questions
- Q1 densidad de entrega: un plan unico por olas 7-15 vs planes separados por etapa (recomendado: unico por olas, aceptacion por etapa)
- Q2 terminal Windows: node-pty/conpty desde el inicio vs evaluacion ligera primero en ola 7 (recomendado: evaluar y decidir con evidencia en ola 7)
- Q3 catologo de Skills: solo local/git/zip vs incluir catalogo remoto configurable (recomendado: local+git+zip primero; remoto solo con fuente real y segura)
- Q4 secretos MCP: confirmar safeStorage del SO como unico almacen (recomendado: si, sin excepcion)
- Q5 confirmacion de imagenes: adjuntar las referencias visuales o autorizar disenar desde la direccion textual (recomendado: autorizar textual + absorber imagenes en ola 7)

## Approval gate
status: awaiting-approval
approach: Plan unico por olas 7-15 con diseno-primero (ola 7), integracion real Skills/MCP al runtime y QA determinista por ola; alta precision despues de aprobar.
next: presentar brief una vez y pedir okay explicito via pregunta Approval (required:true); con okay, scaffold plan + consultant + todos + review plan-reviewer.

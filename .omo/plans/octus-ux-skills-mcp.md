# octus-ux-skills-mcp - Work Plan

## TL;DR (For humans)

**Who this is for and what changes for them:** Para el programador que vive en Octus y los agentes que hacen el trabajo: al terminar, abre una bienvenida clara, trabaja en un escritorio ordenado estilo VS Code con sus temas y tamaños, y sus agentes usan Skills y conectores MCP reales bajo permisos estrictos.

**What you'll get:** Diseño completo primero y después, por olas aceptables una a una: base visual con temas, bienvenida y proyectos, chat pulido, panel de agentes, sistema de Skills de verdad, cliente MCP de verdad, terminal integrada y paquete final para Windows con auditoría de seguridad.

**Why this approach:** Diseñar antes de codificar evita rehacer pantallas; cada ola cierra contra lo que ya existe (etapas 1–6 no se reabren) y cada capacidad nueva trae su prueba determinista, sin gastar créditos en pruebas en vivo salvo confirmación tuya.

**What it will NOT do:** No toca el motor de agentes ni los contratos de las etapas 1–6; no crea otra base de datos ni otro sistema de sesiones; no instala Skills de terceros ni conecta servidores MCP reales durante el desarrollo; no guarda secretos en texto plano.

**Effort:** XL
**Risk:** High - Skills y MCP son servicios nuevos de runtime apoyados en puntos de integración aún no verificados, más documentos internos desactualizados que hay que poner en cuarentena primero
**Decisions to sanity-check:** Terminal con PTY directo en el proceso main; catálogo de Skills solo local/git/zip (sin catálogo remoto); secretos solo en el almacén del sistema operativo; imágenes de referencia absorbidas en la ola de diseño sin bloquearla.

Your next move: approve, or run a high-accuracy review. Full execution detail follows below.

---

> TL;DR (machine): XL effort, High risk, waves 7-15 design-first workbench plus real Skills and MCP client with deterministic QA per wave

## Scope
### Affected user and ideal state
**Affected user:** (a) el programador intensivo que usa Octus a diario como harness de delegación; hoy opera una UI funcional monolítica sin bienvenida, sin terminal, sin Skills ni MCP. (b) los agentes/workers (explorer, researcher, implementer, reviewer) que consumirán Skills y herramientas MCP bajo scopes. (c) el operador que corre las verificaciones live con claves y presupuesto reales.

| Row | Statement | Reason |
| --- | --- | --- |
| IS-1 | Al abrir Octus ve una bienvenida con arrastrar-soltar carpeta, selector nativo, recientes con fecha, crear/continuar proyecto o sesión; nunca auto-selecciona proyecto | Entrada predecible y segura; lo exige intrucion 5 |
| IS-2 | Trabaja en un workbench (activity bar, sidebar, conversación central, inspector, panel inferior) con paneles ocultables, redimensionables y restaurables, preferencias persistentes | Entorno de programación intensivo sin fricción |
| IS-3 | Lee y escribe chat con markdown, código, streaming, tool calls expandibles, planes, aprobaciones, preguntas, actividad de agentes y errores, sin jank en conversaciones largas | Uso diario del harness; el volumen no debe degradar la UI |
| IS-4 | Gestiona agentes, tareas, DAG, runs, worktrees, diffs, revisiones e historial desde el Agent Manager con datos reales, sin agentes ficticios ni progreso inventado | Confianza en la orquestación real de etapas 1–6 |
| IS-5 | Instala y administra Skills (global, proyecto, Octus) y los agentes las usan con carga progresiva, scopes respetados y uso registrado por run | Extensibilidad real, no solo pantallas |
| IS-6 | Conecta servidores MCP (STDIO local y Streamable HTTP remoto), descubre herramientas, recursos y prompts, y los usa solo con servidor autorizado, herramienta disponible, perfil con permiso y reglas de aprobación cumplidas | Cliente MCP seguro y útil |
| IS-7 | Usa terminal persistente, explorador de archivos, diffs, resultados de pruebas y diagnósticos bajo las políticas de ejecución existentes | Ciclo completo sin salir del workbench |
| IS-8 | Cambia tema claro, oscuro y de sistema, paletas neutrales, tamaño 12–18px y densidad compacta, normal o cómoda, con persistencia y variables CSS compartidas | Personalización ligera y profesional |
| IS-9 | Ejecuta verificaciones live con presupuesto y alcance anunciados, sin que claves aparezcan en logs ni evidencia y sin gasto sorpresa | intrucion 17 limita créditos live; ya existen dos claves en claro fuera del repo |
| GAP-1 | Hoy App.tsx y store.ts son monolíticos, sin bienvenida, sin workbench redimensionable, sin sistema de tokens | Cierra con olas 7, 8, 9 |
| GAP-2 | Hoy no existe SkillManager ni integración con ContextBuilder, ToolGateway y PermissionManager | Cierra con ola 12 |
| GAP-3 | Hoy no existe MCP Client Manager, ni herramientas MCP aisladas por servidor, ni secretos en almacén del SO | Cierra con ola 13 |
| GAP-4 | Hoy no hay terminal PTY ni panel de problemas y diagnósticos | Cierra con ola 14 |
| GAP-5 | Hoy no hay presupuesto de rendimiento ni distribución Windows endurecida | Cierra con ola 15 |
| GAP-6 | Hoy el chat es un monolito sin virtualización ni modelo de línea de tiempo para streaming y tool calls | Cierra con ola 10; sirve a IS-3 |
| GAP-7 | Hoy no hay UI de Agent Manager; TaskManager y Scheduler existen solo headless | Cierra con ola 11; sirve a IS-4 |
| GAP-8 | Hoy styles.css no tiene sistema de tokens y las preferencias no persisten por clave | Cierra con ola 8; sirve a IS-8 |

### Must have
- Ola 7 de diseño aprobada antes de codificar pantallas: arquitectura de información, navegación, inventario, flujos, wireframes, sistema de diseño, especificación de conversaciones, Agent Manager, Skills, MCP, contratos interfaz-backend y presupuesto de rendimiento
- Bienvenida con drag-and-drop, selector nativo, recientes, crear y continuar; workbench con paneles ocultables, redimensionables y restaurables
- Conversación completa con streaming, cancelación, virtualización, tool calls, aprobaciones y composer con adjuntos
- Agent Manager real sobre TaskManager, Scheduler, worktrees e integraciones existentes
- Skills en formato estándar Agent Skills con descubrimiento en tres ámbitos, instalación local, zip y git explícito, validación nombrada, carga progresiva, scopes y registro por run
- Cliente MCP con STDIO y Streamable HTTP vigente, aislamiento de nombres por servidor, recursos y prompts con aprobación, confianza por workspace, secretos solo en safeStorage
- Terminal persistente con PTY en main, explorador, diffs, resultados de pruebas y diagnósticos
- Temas claro, oscuro y sistema, paletas neutrales, tamaños 12–18px, tres densidades, todo persistente por usuario
- Pruebas deterministas por ola con servidores MCP simulados locales; regresiones de etapas 1–6 en verde; escaneo de secretos y redacción de evidencia

### Must NOT have (guardrails, anti-slop, scope boundaries)
- No reabrir ni renegociar contratos de etapas 1–6; no sustituir motor de agentes, sesiones, ToolGateway, PermissionManager, AgentManager ni Scheduler; no segunda base de datos
- No cambiar garantías de seguridad de Electron; no dependencias pesadas sin justificación escrita; no romper aislamiento proyecto, sesión, run y worktree
- No formato propietario de Skills; no transporte HTTP+SSE legado; no construir MCP Server salvo necesidad justificada y separada
- No instalar Skills de terceros, no conectar servidores MCP reales, no ejecutar código externo, no consumir créditos live sin confirmación explícita del usuario en modo plan y en cada gate live
- No citar claves ni pegarlas en código, logs o evidencia; no guardar secretos en SQLite ni JSON plano; rotar las dos claves de k.txt antes de cualquier verificación live
- No agentes ficticios ni progreso inventado; no llamar instalar a configurar un servidor remoto; no documentación duplicada cuando exista un documento equivalente

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: tests-after + framework: `bun test` para servicios y `Playwright` para UI de escritorio (el ejecutor confirma disponibilidad en la ola 8; si falta, la prueba UI se ejecuta como script de smoke del harness con selectores concretos, nunca como revisión manual)
- Evidence: `.omo/evidence/octus-ux-skills-mcp/task-<N>.<ext>` (un archivo por todo, con salida del comando y aserciones nombradas)
- Regresión: `bun run test` en raíz antes de cerrar cada ola; ninguna ola se acepta con la suite de etapas 1–6 en rojo
- Live: solo con confirmación explícita del usuario y claves ya rotadas; por defecto todo se prueba con simulados locales y datos fijos (`C:\tmp\octus-qa-proj`, servidor `mcp-qa-stdio`, skill `qa-skill@1.0.0`)

## Execution strategy
### Parallel execution waves
> Target 5-8 todos per wave. Fewer than 3 (except the final) means you under-split.
- Ola 7 (todos 1–5): diseño integral, primero el Todo 1 de cuarentena documental; el resto en paralelo tras el 1
- Ola 8 (todos 6–9): fundamentos frontend; el 6 abre, 7 y 8 en paralelo tras el 6, el 9 al final
- Ola 9 (todos 10–11): bienvenida y sesiones, en paralelo entre sí
- Ola 10 (todos 12–14): conversación; el 12 abre, 13 y 14 en paralelo tras el 12
- Ola 11 (todos 15–17): Agent Manager; el 15 abre, 16 y 17 en paralelo tras el 15
- Ola 12 (todos 18–24): Skills; 18 y 19 abren en paralelo, 20–22 en secuencia tras el 19, 23 y 24 en paralelo al cierre
- Ola 13 (todos 25–30): MCP; el 25 abre, 26–28 en secuencia, 29 y 30 en paralelo al cierre
- Ola 14 (todos 31–33): terminal y archivos; el 31 abre, 32 y 33 en paralelo tras el 31
- Ola 15 (todos 34–36): rendimiento, seguridad y distribución; en secuencia corta

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | — | 2, 3, 4, 5 | — |
| 2, 3, 4, 5 | 1 | olas 8–15 | entre sí |
| 6 | 3 | 7, 8 | — |
| 7, 8 | 6 | 9 | entre sí |
| 9 | 7, 8 | — | — |
| 10, 11 | 2, 6 | — | entre sí |
| 12 | 4 | 13, 14 | — |
| 13, 14 | 12 | — | entre sí |
| 15 | 4 | 16, 17 | — |
| 16, 17 | 15 | — | entre sí |
| 18, 19 | 4 | 20 | entre sí |
| 20 | 19 | 21, 22 | — |
| 21, 22 | 20 | 23, 24 | entre sí tras 20 |
| 23, 24 | 21, 22 | — | entre sí |
| 25 | 4 | 26 | — |
| 26 | 25 | 27, 28 | — |
| 27, 28 | 26 | 29, 30 | entre sí tras 26 |
| 29, 30 | 27, 28 | — | entre sí |
| 31 | 6 | 32, 33 | — |
| 32, 33 | 31 | — | entre sí |
| 34 | 32 | 35, 36 | — |
| 35, 36 | 34 | — | entre sí tras 34 |

## Todos
- [x] 1. Cuarentena de documentos desactualizados y autoridad del repo vivo
  What to do / Must NOT do: Conciliar `.harness/implementation/` con el árbol real; marcar como obsoleto lo que describa módulos inexistentes (engine.ts, mcp.ts, skills.ts, codemode.ts, tools/browser.ts) y declarar el árbol vivo como única autoridad de referencias. Hacerlo con notas y archivo de cuarentena, sin reescribir historia. Must NOT reabrir etapas 1–6 ni cambiar contratos.
  Closes: GAP-1 (base de referencias)
  Parallelization: Ola 7, primero | Blocked by: — | Blocks: 2, 3, 4, 5
  References (executor has NO interview context - be exhaustive): C:/Users/UserPy/Documents/octus/.harness/implementation/AUDIT.md, CURRENT_ARCHITECTURE.md, TARGET_ARCHITECTURE.md, IMPLEMENTATION_ROADMAP.md, DECISIONS.md; C:/Users/UserPy/Documents/octus/packages/core/src (árbol real); C:/Users/UserPy/Documents/octus/packages/core/package.json (dependencias reales: sin SDK MCP, sin node-pty)
  Acceptance criteria (agent-executable): existe un archivo de cuarentena que lista cada documento o sección obsoleta con su motivo y existe una nota de autoridad del árbol vivo; comando `bun scripts/check-doc-refs.ts` o inventario por script que afirma cero referencias de integración a módulos inexistentes en el plan de cada ola (exit 0)
  QA scenarios (name the exact tool + invocation): happy con `bun test` del inventario de referencias (exit 0, evidencia `.omo/evidence/octus-ux-skills-mcp/task-1.txt`); failure: introducir una referencia ficticia a un modulo fantasma (p. ej. `packages/core/src/<modulo-inexistente>.ts`) y afirmar que el chequeo la rechaza (exit distinto de 0)
  Commit: Y | docs(harness): quarantine stale lineage docs, declare live tree authority
  Recommended task executor category: writing (decisión documental con verificación por script, un solo hilo de criterio)
- [x] 2. Arquitectura de información, navegación, inventario y flujos
  What to do / Must NOT do: Definir actividad, sidebar, conversación central, inspector y panel inferior; inventario de pantallas; flujos de bienvenida, proyecto, sesión, plan, build, aprobación y recuperación; estados de interfaz. Must NOT codificar pantallas todavía.
  Closes: GAP-1
  Parallelization: Ola 7 | Blocked by: 1 | Blocks: olas 8–15
  References (executor has NO interview context - be exhaustive): C:/Users/UserPy/Documents/octus/apps/desktop/src/renderer/src/App.tsx (vistas actuales); C:/Users/UserPy/Documents/octus/apps/desktop/src/renderer/src/store.ts; C:/Users/UserPy/Documents/octus/.omo/evidence — n/a; intrucion.txt secciones 4 y 5
  Acceptance criteria (agent-executable): documentos de arquitectura e inventario existen y cada pantalla del inventario traza a un flujo con estados; revisión de lectura contra IS-1 e IS-2 registrada como checklist firmado por el agente en `.omo/evidence/octus-ux-skills-mcp/task-2.txt`
  QA scenarios (name the exact tool + invocation): happy: lectura agente del inventario y afirmación de que cada flujo nombra pantalla, actor y estado final; failure: flujo sin estado de error definido se marca incompleto y vuelve a redactarse
  Commit: Y | docs(ux): information architecture, inventory and flows
  Recommended task executor category: writing (prosa de diseño verificada por lectura, sin código)
- [x] 3. Sistema de diseño y prototipos visuales
  What to do / Must NOT do: Tokens CSS y variables compartidas; temas claro, oscuro y sistema; paletas neutrales con acentos discretos y semánticos reservados; tamaños 12–18px; tres densidades; componentes reutilizables; wireframes y prototipos de bienvenida, workbench, conversación, Agent Manager, Skills y MCP; nota de peso de terminal PTY como criterio de aceptación. Usar skills frontend-design y ui-ux-pro-max como guía. Must NOT copiar identidad de VS Code ni usar emojis o iconos multicolor.
  Closes: GAP-8 y base de IS-2 e IS-8
  Parallelization: Ola 7 | Blocked by: 1 | Blocks: olas 8–15
  References (executor has NO interview context - be exhaustive): C:/Users/UserPy/Documents/octus/apps/desktop/src/renderer/src/styles.css (actual, sin tokens); C:/Users/UserPy/Documents/octus/apps/desktop/src/renderer/src/App.tsx; intrucion.txt sección 4
  Acceptance criteria (agent-executable): existen tokens con variables y una sonda de estilo computado que afirma presencia de variables y aplicación de tema y densidad sobre selectores fijos (`#workbench`, `.message-timeline`); la nota de peso de PTY existe con cifras y decisión PTY-directo confirmada o refutada por escrito
  QA scenarios (name the exact tool + invocation): happy con Playwright o sonda de estilos sobre prototipo (tema claro, oscuro y sistema aplicados, exit 0, evidencia `.omo/evidence/octus-ux-skills-mcp/task-3.txt`); failure: token duplicado en un componente fuera del sistema se detecta por búsqueda de valores literales y se rechaza
  Commit: Y | docs(ux): design system tokens, themes and prototypes
  Recommended task executor category: visual-engineering (sistema visual y prototipos en el renderer)
- [x] 4. Especificación de conversaciones, Agent Manager, Skills y MCP a nivel UX
  What to do / Must NOT do: Especificar visualmente mensajes, streaming, tool calls, resultados, planes, aprobaciones, preguntas, actividad de agentes, errores, resúmenes y archivos; vistas de agentes, tareas, DAG, runs, worktrees, revisiones; catálogos e instaladas de Skills y MCP con estados instalado frente a habilitado y configurado frente a conectado frente a autorizado. Must NOT implementar servicios todavía.
  Closes: GAP-6, GAP-7 (mitad UX) y base de IS-3, IS-4, IS-5, IS-6
  Parallelization: Ola 7 | Blocked by: 1 | Blocks: olas 10–13
  References (executor has NO interview context - be exhaustive): C:/Users/UserPy/Documents/octus/packages/shared/src/events.ts (StreamEvent y CoreEvent); C:/Users/UserPy/Documents/octus/apps/desktop/src/renderer/src/App.tsx; intrucion.txt secciones 5, 10.2 y 11.7
  Acceptance criteria (agent-executable): cada estado de interfaz tiene su especificación con datos de ejemplo fijos y cada pantalla de Skills y MCP distingue los estados exigidos; checklist de lectura contra IS-3, IS-4, IS-5 e IS-6 en `.omo/evidence/octus-ux-skills-mcp/task-4.txt`
  QA scenarios (name the exact tool + invocation): happy: lectura que traza cada widget a un evento o servicio real existente o a un contrato nuevo nombrado; failure: widget que requiera un evento inexistente se marca con contrato nuevo obligatorio en vez de aceptarse
  Commit: Y | docs(ux): conversation, agent manager, skills and mcp specs
  Recommended task executor category: writing (especificación verificada por lectura contra eventos reales)
- [x] 5. Contratos nuevos, mapa de integración, matriz de permisos y presupuestos
  What to do / Must NOT do: Contratos nuevos de interfaz y backend; mapa de integración con ToolGateway, PermissionManager, AgentManager, ContextBuilder, IPC y persistencia; matriz de permisos por perfil y scope; estrategia de persistencia, seguridad y pruebas; presupuesto de rendimiento con cifras. Must NOT programar los servicios.
  Closes: GAP-1 (cierre de diseño)
  Parallelization: Ola 7 | Blocked by: 1 | Blocks: olas 8–15
  References (executor has NO interview context - be exhaustive): C:/Users/UserPy/Documents/octus/packages/core/src/tools/tool-gateway.ts; C:/Users/UserPy/Documents/octus/packages/core/src/permissions/permission-manager.ts; C:/Users/UserPy/Documents/octus/packages/core/src/orchestration/agent-manager.ts; C:/Users/UserPy/Documents/octus/packages/core/src/runtime/context-builder.ts (línea 50+, capas); C:/Users/UserPy/Documents/octus/packages/shared/src/ipc.ts; C:/Users/UserPy/Documents/octus/packages/core/src/persistence/persistence-service.ts
  Acceptance criteria (agent-executable): cada contrato nuevo nombra productor, consumidor, canal IPC y tabla o clave de persistencia; la matriz cubre cada herramienta y scope; el presupuesto fija cifras de arranque, memoria y render; checklist en `.omo/evidence/octus-ux-skills-mcp/task-5.txt`
  QA scenarios (name the exact tool + invocation): happy: verificación por script de que cada contrato del mapa existe como entrada con los cuatro campos; failure: contrato sin consumidor nombrado se rechaza como incompleto
  Commit: Y | docs(ux): contracts, integration map, permission matrix, budgets
  Recommended task executor category: writing (arquitectura verificada por integridad del mapa)
- [x] 6. Tokens, temas, densidades y persistencia de preferencias
  What to do / Must NOT do: Implementar el sistema aprobado del Todo 3: variables CSS compartidas, tres temas, paletas, tamaños y densidades, persistencia por usuario con supervivencia al reinicio. Auditar App.tsx, store.ts y styles.css. Must NOT duplicar valores de diseño en componentes ni fragmentar en exceso.
  Closes: GAP-8
  Parallelization: Ola 8, abre | Blocked by: 3 | Blocks: 7, 8
  References (executor has NO interview context - be exhaustive): C:/Users/UserPy/Documents/octus/apps/desktop/src/renderer/src/styles.css; C:/Users/UserPy/Documents/octus/apps/desktop/src/renderer/src/store.ts; C:/Users/UserPy/Documents/octus/apps/desktop/src/renderer/src/App.tsx; contrato del Todo 5
  Acceptance criteria (agent-executable): `bun test` con ida y vuelta de preferencias (cambiar tema, tamaño y densidad, reiniciar estado, afirmar valores) en verde; sonda de estilo computado afirma variables aplicadas
  QA scenarios (name the exact tool + invocation): happy con `bun test` de persistencia de preferencias (exit 0, evidencia `.omo/evidence/octus-ux-skills-mcp/task-6.txt`); failure: preferencia corrupta en disco se degrada al valor por defecto sin romper el arranque
  Commit: Y | feat(frontend): design tokens, themes, sizes, density and persisted prefs
  Recommended task executor category: visual-engineering (sistema visual del renderer con pruebas)
- [x] 7. Componentes compartidos del workbench
  What to do / Must NOT do: Construir botones, diálogos, menús, iconografía monocromática, tablas, estados vacíos y de error sobre los tokens del Todo 6. Must NOT tarjetas decorativas ni emojis.
  Closes: GAP-1
  Parallelization: Ola 8 | Blocked by: 6 | Blocks: 9
  References (executor has NO interview context - be exhaustive): Todo 3 (sistema aprobado); Todo 6 (tokens implementados); C:/Users/UserPy/Documents/octus/apps/desktop/src/renderer/src/App.tsx
  Acceptance criteria (agent-executable): catálogo de componentes renderizado con cada variante; `bunx playwright test` del catálogo o smoke con selectores fijos en verde
  QA scenarios (name the exact tool + invocation): happy con Playwright sobre el catálogo (exit 0, evidencia `.omo/evidence/octus-ux-skills-mcp/task-7.txt`); failure: componente fuera de tokens se detecta y se rechaza
  Commit: Y | feat(frontend): shared workbench components
  Recommended task executor category: visual-engineering (componentes visuales con prueba de render)
- [x] 8. Navegación principal y layout con paneles redimensionables
  What to do / Must NOT do: Activity bar, sidebar, conversación central, inspector y panel inferior con ocultar, redimensionar y restaurar; estado de layout persistente. Must NOT romper atajos ni navegación existentes.
  Closes: GAP-1
  Parallelization: Ola 8 | Blocked by: 6 | Blocks: 9
  References (executor has NO interview context - be exhaustive): Todo 2 (arquitectura aprobada); C:/Users/UserPy/Documents/octus/apps/desktop/src/renderer/src/App.tsx; C:/Users/UserPy/Documents/octus/apps/desktop/src/renderer/src/store.ts
  Acceptance criteria (agent-executable): Playwright afirma ocultar, redimensionar y restaurar cada panel con estado persistido tras reinicio
  QA scenarios (name the exact tool + invocation): happy con Playwright de layout (exit 0, evidencia `.omo/evidence/octus-ux-skills-mcp/task-8.txt`); failure: layout corrupto se restaura al defecto sin pantalla en blanco
  Commit: Y | feat(frontend): workbench navigation and resizable layout
  Recommended task executor category: visual-engineering (layout interactivo con prueba por script)
- [x] 9. Modularización de App.tsx y store.ts por responsabilidades
  What to do / Must NOT do: Dividir el monolito por responsabilidades con límites razonables, manteniendo SolidJS y reactividad; cada módulo con dueño claro. Must NOT cambiar comportamiento ni APIs de eventos.
  Closes: GAP-1
  Parallelization: Ola 8, cierra | Blocked by: 7, 8 | Blocks: —
  References (executor has NO interview context - be exhaustive): C:/Users/UserPy/Documents/octus/apps/desktop/src/renderer/src/App.tsx; C:/Users/UserPy/Documents/octus/apps/desktop/src/renderer/src/store.ts; C:/Users/UserPy/Documents/octus/apps/desktop/src/renderer/src/api.ts
  Acceptance criteria (agent-executable): `bun run typecheck` en verde y `bun run test` en raíz en verde con paridad de comportamiento afirmada por la suite existente
  QA scenarios (name the exact tool + invocation): happy con typecheck más suite en verde (evidencia `.omo/evidence/octus-ux-skills-mcp/task-9.txt`); failure: import circular nuevo detectado por chequeo de módulos y revertido
  Commit: Y | refactor(frontend): split App and store by responsibility
  Recommended task executor category: deep-low (refactor transversal que el ejecutor dirime leyendo el código, sin decisión de diseño abierta)
- [x] 10. Bienvenida con drag-and-drop, selector nativo y recientes
  What to do / Must NOT do: Pantalla inicial con arrastrar carpeta desde Windows por mecanismos seguros del proceso principal, abrir por explorador nativo, recientes con fecha, crear y abrir proyectos, continuar sesión, acceso a configuración; sin auto-selección. Must NOT ejecutar código del proyecto abierto.
  Closes: GAP-1
  Parallelization: Ola 9 | Blocked by: 2, 6 | Blocks: —
  References (executor has NO interview context - be exhaustive): Todo 2 (flujo de bienvenida); C:/Users/UserPy/Documents/octus/apps/desktop/src/main/index.ts (canales IPC y validación); C:/Users/UserPy/Documents/octus/packages/core/src/sessions/octus-core.ts (proyectos y sesiones); C:/Users/UserPy/Documents/octus/apps/desktop/src/preload/index.ts
  Acceptance criteria (agent-executable): Playwright o smoke afirma soltar carpeta, diálogo nativo, reciente con fecha, crear, abrir y continuar; sin proyecto auto-seleccionado al arrancar
  QA scenarios (name the exact tool + invocation): happy con Playwright de bienvenida sobre `C:\tmp\octus-qa-proj` con selector `#welcome-dropzone` (exit 0, evidencia `.omo/evidence/octus-ux-skills-mcp/task-10.txt`); failure: carpeta inexistente o sin permiso muestra error sin crear proyecto
  Commit: Y | feat(frontend): welcome with drag-drop, native picker and recents
  Recommended task executor category: visual-engineering (pantalla inicial con IPC seguro)
- [x] 11. Gestión visual de proyectos y sesiones con recuperación
  What to do / Must NOT do: Crear, cambiar, continuar y recuperar sesiones reutilizando servicios existentes; navegación de proyectos sin segunda jerarquía de persistencia. Must NOT duplicar SessionManager ni stores.
  Closes: GAP-1
  Parallelization: Ola 9 | Blocked by: 2, 6 | Blocks: —
  References (executor has NO interview context - be exhaustive): C:/Users/UserPy/Documents/octus/packages/core/src/sessions/octus-core.ts; C:/Users/UserPy/Documents/octus/packages/core/src/persistence/persistence-service.ts; Todo 5 (mapa de persistencia)
  Acceptance criteria (agent-executable): `bun test` de ciclo crear, cambiar, cerrar, recuperar con aislamiento por proyecto en verde
  QA scenarios (name the exact tool + invocation): happy con `bun test` del ciclo de sesión (exit 0, evidencia `.omo/evidence/octus-ux-skills-mcp/task-11.txt`); failure: recuperación con evento corrupto se degrada a sesión vacía registrada, sin pérdida silenciosa
  Commit: Y | feat(frontend): visual project and session management with recovery
  Recommended task executor category: unspecified-high (funcionalidad estándar multiarchivo sobre servicios existentes)
- [x] 12. Sonda del modelo de conversación y streaming actuales
  What to do / Must NOT do: Verificar con lectura y sonda el modelo de mensajes, eventos de streaming, tool calls y cancelación en el código vivo; registrar qué existe y qué falta para los Todos 13 y 14. Solo lectura más sonda mínima. Must NOT cambiar comportamiento.
  Closes: GAP-6 (verificación previa)
  Parallelization: Ola 10, abre | Blocked by: 4 | Blocks: 13, 14
  References (executor has NO interview context - be exhaustive): C:/Users/UserPy/Documents/octus/packages/shared/src/events.ts; C:/Users/UserPy/Documents/octus/packages/core/src/runtime/agent-runtime.ts; C:/Users/UserPy/Documents/octus/apps/desktop/src/renderer/src/store.ts
  Acceptance criteria (agent-executable): informe de sonda con cada capacidad (streaming, tool call, cancelación, paginación) marcada existe o falta, con ruta y línea; `bun run typecheck` en verde
  QA scenarios (name the exact tool + invocation): happy con sonda que recorre un run simulado y lista eventos recibidos (evidencia `.omo/evidence/octus-ux-skills-mcp/task-12.txt`); failure: evento sin consumidor se reporta como contrato nuevo obligatorio
  Commit: N | docs: conversation seam probe (informe, sin código productivo)
  Recommended task executor category: quick (sonda de lectura contenida en pocos archivos)
- [x] 13. Línea de tiempo de chat con streaming, virtualización y cancelación
  What to do / Must NOT do: Mensajes de usuario y coordinador, markdown, código, streaming con cancelación, razonamiento, composer con adjuntos, selector de modelos y virtualización de conversaciones extensas manteniendo APIs y eventos. Must NOT cambiar semántica plan y build de la sesión.
  Closes: GAP-6
  Parallelization: Ola 10 | Blocked by: 12 | Blocks: —
  References (executor has NO interview context - be exhaustive): Todo 4 (especificación); Todo 12 (sonda); C:/Users/UserPy/Documents/octus/apps/desktop/src/renderer/src/App.tsx; C:/Users/UserPy/Documents/octus/packages/core/src/runtime/agent-runtime.ts
  Acceptance criteria (agent-executable): Playwright con conversación larga afirma scroll virtualizado, marcos de streaming y cancelación efectiva con selectores `.message-timeline` y `#composer`
  QA scenarios (name the exact tool + invocation): happy con Playwright de conversación extensa (exit 0, evidencia `.omo/evidence/octus-ux-skills-mcp/task-13.txt`); failure: cancelar a mitad de stream detiene el run sin mensaje fantasma ni duplicado
  Commit: Y | feat(frontend): chat timeline with streaming, virtualization and cancel
  Recommended task executor category: visual-engineering (UI de conversación con prueba de rendimiento)
- [x] 14. Tool calls, aprobaciones, preguntas y actividad de agentes
  What to do / Must NOT do: Tool calls expandibles con resultados, planes, aprobaciones humanas, preguntas, actividad de agentes, errores, resúmenes y archivos modificados sobre eventos reales. Must NOT permitir que un modelo conceda aprobaciones.
  Closes: GAP-6
  Parallelization: Ola 10 | Blocked by: 12 | Blocks: —
  References (executor has NO interview context - be exhaustive): Todo 4 (especificación); C:/Users/UserPy/Documents/octus/packages/shared/src/events.ts; C:/Users/UserPy/Documents/octus/packages/core/src/questions/question-service.ts; C:/Users/UserPy/Documents/octus/packages/core/src/tools/tool-gateway.ts
  Acceptance criteria (agent-executable): Playwright o smoke afirma expandir tool call, aprobar, responder pregunta y ver actividad con datos fijos de run simulado
  QA scenarios (name the exact tool + invocation): happy con Playwright de aprobaciones y preguntas (exit 0, evidencia `.omo/evidence/octus-ux-skills-mcp/task-14.txt`); failure: aprobación duplicada o fuera de revisión se rechaza por idempotencia
  Commit: Y | feat(frontend): tool calls, approvals, questions and agent activity
  Recommended task executor category: visual-engineering (widgets de conversación con prueba por script)
- [x] 15. Sonda de TaskManager, Scheduler y AgentManager reutilizables
  What to do / Must NOT do: Verificar con lectura y sonda las APIs de tareas, DAG, dependencias, runs, worktrees e integraciones que consumirán los Todos 16 y 17; registrar firmas exactas. Solo lectura más sonda mínima. Must NOT cambiar servicios.
  Closes: GAP-7 (verificación previa)
  Parallelization: Ola 11, abre | Blocked by: 4 | Blocks: 16, 17
  References (executor has NO interview context - be exhaustive): C:/Users/UserPy/Documents/octus/packages/core/src/tasks/task-manager.ts; C:/Users/UserPy/Documents/octus/packages/core/src/tasks/task-graph.ts; C:/Users/UserPy/Documents/octus/packages/core/src/tasks/task-scheduler.ts; C:/Users/UserPy/Documents/octus/packages/core/src/orchestration/agent-manager.ts; C:/Users/UserPy/Documents/octus/packages/core/src/worktrees/worktree-manager.ts
  Acceptance criteria (agent-executable): informe con cada firma necesaria (tareas, DAG, runs, worktrees, previews, conflictos) marcada existe o falta; `bun run typecheck` en verde
  QA scenarios (name the exact tool + invocation): happy con sonda que lista un DAG y estados de run simulados (evidencia `.omo/evidence/octus-ux-skills-mcp/task-15.txt`); failure: API ausente se convierte en subtodo aditivo nombrado en la misma ola
  Commit: N | docs: agent manager seam probe (informe, sin código productivo)
  Recommended task executor category: quick (sonda de lectura contenida)
- [x] 16. Vista de agentes, tareas, runs y worktrees
  What to do / Must NOT do: Agentes con estado, tareas con dependencias, estado de runs y worktrees reutilizando servicios; sin agentes ficticios. Must NOT inventar progreso visual.
  Closes: GAP-7
  Parallelization: Ola 11 | Blocked by: 15 | Blocks: —
  References (executor has NO interview context - be exhaustive): Todo 15 (sonda); C:/Users/UserPy/Documents/octus/packages/core/src/tasks/task-manager.ts; C:/Users/UserPy/Documents/octus/packages/core/src/orchestration/agent-manager.ts; C:/Users/UserPy/Documents/octus/packages/core/src/worktrees/worktree-manager.ts
  Acceptance criteria (agent-executable): Playwright o smoke afirma lista de agentes, tareas con estado y worktree con datos de run simulado y selector `#agent-dag` presente
  QA scenarios (name the exact tool + invocation): happy con Playwright de la vista (exit 0, evidencia `.omo/evidence/octus-ux-skills-mcp/task-16.txt`); failure: run cancelado muestra estado final real, nunca progreso congelado
  Commit: Y | feat(frontend): agents, tasks, runs and worktrees views
  Recommended task executor category: visual-engineering (vistas sobre servicios reales)
- [x] 17. DAG, integraciones, previews, conflictos, diffs y revisiones
  What to do / Must NOT do: Grafo de dependencias, integraciones, previews, conflictos con resolución asistida, diff de archivos, resultados de revisión e historial de ejecución. Must NOT mezclar ramas ni promocionar sin SHA fijado.
  Closes: GAP-7
  Parallelization: Ola 11 | Blocked by: 15 | Blocks: —
  References (executor has NO interview context - be exhaustive): Todo 15 (sonda); C:/Users/UserPy/Documents/octus/packages/core/src/tasks/task-graph.ts; C:/Users/UserPy/Documents/octus/packages/core/src/repositories/repository-manager.ts; C:/Users/UserPy/Documents/octus/packages/core/src/integration (manager, validation, preview, approval, promotion, conflict)
  Acceptance criteria (agent-executable): Playwright o smoke afirma DAG con dependencia, preview alcanzable, conflicto visible y diff con datos simulados
  QA scenarios (name the exact tool + invocation): happy con Playwright del DAG y diff (exit 0, evidencia `.omo/evidence/octus-ux-skills-mcp/task-17.txt`); failure: promoción sin aprobación fijada a SHA se rechaza
  Commit: Y | feat(frontend): dag, integrations, previews, conflicts and diffs
  Recommended task executor category: visual-engineering (vistas de integración con prueba por script)
- [x] 18. Fuente de validación de Skills fijada
  What to do / Must NOT do: Fijar la fuente exacta de validación del formato Agent Skills (versión de `skills-ref` o lista de cláusulas verificable de la especificación 2026-08-09: nombre, descripción, estructura, rutas). Must NOT inventar formato propietario.
  Closes: GAP-2 (base verificable)
  Parallelization: Ola 12, abre | Blocked by: 4 | Blocks: 20
  References (executor has NO interview context - be exhaustive): https://agentskills.io/specification.md (dateModified 2026-08-09); https://github.com/agentskills/agentskills (validador skills-ref)
  Acceptance criteria (agent-executable): versión o lista fijada por escrito y script que valida `qa-skill@1.0.0` correcta y rechaza frontal con nombre inválido y descripción vacía
  QA scenarios (name the exact tool + invocation): happy con script de validación sobre skill correcta (exit 0, evidencia `.omo/evidence/octus-ux-skills-mcp/task-18.txt`); failure: SKILL.md con directorio que no coincide con `name` se rechaza
  Commit: Y | feat(skills): pinned agent skills validation source
  Recommended task executor category: quick (fijar versión y guionizar su comprobación)
- [x] 19. Sonda del modelo de scopes en PermissionManager
  What to do / Must NOT do: Verificar si PermissionManager modela scopes de proyecto, sesión, run, tarea e instancia y qué falta para que los workers solo reciban Skills autorizadas; registrar el modelo exacto. Solo lectura más sonda. Must NOT relajar permisos.
  Closes: GAP-2 (supuesto de carga)
  Parallelization: Ola 12, abre | Blocked by: 4 | Blocks: 20
  References (executor has NO interview context - be exhaustive): C:/Users/UserPy/Documents/octus/packages/core/src/permissions/permission-manager.ts; C:/Users/UserPy/Documents/octus/packages/core/src/runtime/context-builder.ts (InstructionExtras con ids de run, tarea e instancia); Todo 5 (matriz de permisos)
  Acceptance criteria (agent-executable): informe del modelo de scopes con brechas nombradas; `bun run typecheck` en verde; cada brecha se convierte en subtodo aditivo en esta ola
  QA scenarios (name the exact tool + invocation): happy con sonda que pide una decisión de permiso por scope y registra el resultado (evidencia `.omo/evidence/octus-ux-skills-mcp/task-19.txt`); failure: scope desconocido se niega por defecto
  Commit: N | docs: permission scope probe (informe, sin relajar nada)
  Recommended task executor category: deep-low (lectura transversal de permisos que el ejecutor dirime en el código)
- [x] 20. SkillManager con descubrimiento en tres ámbitos
  What to do / Must NOT do: Descubrimiento global, de proyecto y gestionado por Octus con registro de id, nombre, descripción, origen, ruta, alcance, versión, activación, compatibilidad y errores; evita duplicados y cargas múltiples. Must NOT ejecutar scripts al descubrir.
  Closes: GAP-2
  Parallelization: Ola 12 | Blocked by: 18, 19 | Blocks: 21, 22
  References (executor has NO interview context - be exhaustive): Todo 18 (validación); Todo 19 (scopes); C:/Users/UserPy/Documents/octus/packages/core/src/agents/agent-registry.ts (patrón de registro); C:/Users/UserPy/Documents/octus/packages/core/src/persistence/persistence-service.ts (persistencia en worker)
  Acceptance criteria (agent-executable): `bun test` afirma descubrir la misma skill en dos ámbitos sin duplicar registro y con errores de validación visibles
  QA scenarios (name the exact tool + invocation): happy con `bun test` de descubrimiento (exit 0, evidencia `.omo/evidence/octus-ux-skills-mcp/task-20.txt`); failure: directorio sin SKILL.md se registra como error, no como skill
  Commit: Y | feat(skills): skill manager with three-scope discovery
  Recommended task executor category: unspecified-high (servicio nuevo estándar sobre patrones del repo)
- [x] 21. Instalación, importación, desinstalación e inspección
  What to do / Must NOT do: Importar carpeta local y zip compatible, instalar desde git con fuente explícita mostrando procedencia, validar estructura, frontal, rutas y duplicados, desinstalar e inspeccionar. Must NOT ejecutar scripts ni descargar sin autorización explícita.
  Closes: GAP-2
  Parallelization: Ola 12 | Blocked by: 20 | Blocks: 23, 24
  References (executor has NO interview context - be exhaustive): Todo 20 (registro); C:/Users/UserPy/Documents/octus/packages/core/src/tools/tool-gateway.ts (puerta de ejecución, no usada aquí); intrucion.txt 10.3
  Acceptance criteria (agent-executable): `bun test` afirma instalar `qa-skill@1.0.0` desde carpeta y zip, rechaza duplicado y desinstala limpio con procedencia visible
  QA scenarios (name the exact tool + invocation): happy con `bun test` de instalación (exit 0, evidencia `.omo/evidence/octus-ux-skills-mcp/task-21.txt`); failure: zip con ruta fuera de la skill se rechaza sin escribir nada
  Commit: Y | feat(skills): install, import, uninstall and inspect
  Recommended task executor category: unspecified-high (servicio nuevo estándar con validación)
- [x] 22. Activación, administración, alcances y persistencia
  What to do / Must NOT do: Habilitar, deshabilitar, cambiar alcance, detectar actualizaciones y revisar procedencia con installed frente a enabled siempre distintos; aislamiento por proyecto y persistencia con recuperación. Must NOT otorgar permisos de herramientas por activar.
  Closes: GAP-2
  Parallelization: Ola 12 | Blocked by: 20 | Blocks: 23, 24
  References (executor has NO interview context - be exhaustive): Todo 20 (registro); C:/Users/UserPy/Documents/octus/packages/core/src/persistence/persistence-service.ts; C:/Users/UserPy/Documents/octus/packages/core/src/permissions/permission-manager.ts
  Acceptance criteria (agent-executable): `bun test` afirma matriz habilitar frente a deshabilitar por proyecto con persistencia tras reinicio simulado
  QA scenarios (name the exact tool + invocation): happy con `bun test` de administración (exit 0, evidencia `.omo/evidence/octus-ux-skills-mcp/task-22.txt`); failure: skill deshabilitada en proyecto nunca llega al contexto de sus runs
  Commit: Y | feat(skills): activation, scopes and persistence
  Recommended task executor category: unspecified-high (administración con persistencia)
- [x] 23. Integración de Skills con runtime y agentes
  What to do / Must NOT do: Carga progresiva en ContextBuilder, Coordinator, AgentManager, ToolGateway y PermissionManager (metadatos, selección por tarea, instrucciones completas, recursos bajo demanda); registro de Skills por run; respeto de scopes; workers solo con autorizadas; sin vía de evasión de permisos. Must NOT cargar todas completas en cada llamada.
  Closes: GAP-2
  Parallelization: Ola 12 | Blocked by: 21, 22 | Blocks: —
  References (executor has NO interview context - be exhaustive): C:/Users/UserPy/Documents/octus/packages/core/src/runtime/context-builder.ts; C:/Users/UserPy/Documents/octus/packages/core/src/tools/tool-gateway.ts; C:/Users/UserPy/Documents/octus/packages/core/src/permissions/permission-manager.ts; C:/Users/UserPy/Documents/octus/packages/core/src/orchestration/agent-manager.ts; C:/Users/UserPy/Documents/octus/packages/core/src/runtime/agent-runtime.ts
  Acceptance criteria (agent-executable): `bun test` con guion rojo afirma que el prompt solo lleva metadatos más la skill relevante completa, que el run registra la skill usada y que una skill no autoriza herramienta prohibida
  QA scenarios (name the exact tool + invocation): happy con `bun test` de carga progresiva y registro (exit 0, evidencia `.omo/evidence/octus-ux-skills-mcp/task-23.txt`); failure: intento de usar skill como evasión de permiso se niega y queda auditado
  Commit: Y | feat(skills): runtime integration with progressive loading
  Recommended task executor category: deep-high (contrato transversal entre cinco servicios que exige una sola decisión coherente)
- [x] 24. Skills Manager UI, configuración y vista contextual
  What to do / Must NOT do: Catálogo, instaladas, habilitadas, importar e instalar, detalles, origen, alcance, recursos, errores e historial de uso; sección en configuración y vista contextual en el workbench. Must NOT confundir instalado con habilitado.
  Closes: GAP-2
  Parallelization: Ola 12 | Blocked by: 21, 22 | Blocks: —
  References (executor has NO interview context - be exhaustive): Todo 4 (especificación UX); Todo 20 (registro); C:/Users/UserPy/Documents/octus/apps/desktop/src/renderer/src/App.tsx
  Acceptance criteria (agent-executable): Playwright o smoke afirma catálogo, detalle con origen y alcance, importar, habilitar y historial con `qa-skill@1.0.0`
  QA scenarios (name the exact tool + invocation): happy con Playwright del manager (exit 0, evidencia `.omo/evidence/octus-ux-skills-mcp/task-24.txt`); failure: skill con error de validación muestra el error y bloquea habilitar
  Commit: Y | feat(frontend): skills manager ui and settings
  Recommended task executor category: visual-engineering (pantallas sobre el servicio real)
- [x] 25. Selección de SDK MCP y matriz de conformidad
  What to do / Must NOT do: Elegir y fijar el SDK con matriz de conformidad a la especificación 2026-07-28 (STDIO y Streamable HTTP verificados, SSE legado ausente), compatible con Bun, Electron y Windows. Must NOT adoptar HTTP+SSE legado.
  Closes: GAP-3 (base verificable)
  Parallelization: Ola 13, abre | Blocked by: 4 | Blocks: 26
  References (executor has NO interview context - be exhaustive): https://modelcontextprotocol.io/specification/2026-07-28/basic/transports.md; https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md; https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http.md; C:/Users/UserPy/Documents/octus/packages/core/package.json
  Acceptance criteria (agent-executable): SDK fijado con versión y matriz que afirma STDIO y Streamable HTTP operativos y SSE legado ausente contra servidores simulados
  QA scenarios (name the exact tool + invocation): happy con script de conformidad sobre simulados (exit 0, evidencia `.omo/evidence/octus-ux-skills-mcp/task-25.txt`); failure: SDK sin Streamable HTTP se descarta por escrito con alternativa (JSON-RPC propio) nombrada
  Commit: Y | feat(mcp): pinned sdk with spec conformance matrix
  Recommended task executor category: deep-low (decisión técnica que el ejecutor dirime con pruebas de transporte)
- [x] 26. MCP Client Manager con confianza por workspace
  What to do / Must NOT do: Servicio central de configuraciones, servidores, conexiones, handshake, capacidades, reconexión controlada, timeouts y cancelación; ningún servidor desconocido con confianza automática; proyecto recién abierto nunca ejecuta servidores no autorizados; confianza global o por workspace explícita. La puerta de confianza precede a cualquier conexión. Must NOT exponer Octus como servidor.
  Closes: GAP-3
  Parallelization: Ola 13 | Blocked by: 25 | Blocks: 27, 28
  References (executor has NO interview context - be exhaustive): Todo 25 (SDK); C:/Users/UserPy/Documents/octus/packages/core/src/persistence/persistence-service.ts; C:/Users/UserPy/Documents/octus/packages/core/src/permissions/permission-manager.ts; intrucion.txt 13.2 y 13.6
  Acceptance criteria (agent-executable): `bun test` afirma que un servidor no confiable se niega a conectar al abrir su workspace y que la confianza explícita permite conectar y reconectar con backoff
  QA scenarios (name the exact tool + invocation): happy con `bun test` de confianza y reconexión (exit 0, evidencia `.omo/evidence/octus-ux-skills-mcp/task-26.txt`); failure: escenario de auto-conexión al arranque se niega y queda auditado
  Commit: Y | feat(mcp): client manager with per-workspace trust
  Recommended task executor category: deep-high (servicio nuevo con decisión de seguridad transversal)
- [x] 27. Herramientas MCP aisladas por servidor vía ToolGateway
  What to do / Must NOT do: Descubrimiento de herramientas por protocolo, nombres aislados por servidor, registro por ToolGateway y uso solo con servidor autorizado, herramienta disponible, perfil con permiso y aprobación cumplida; resultados como contenido no confiable con servidor y herramienta registrados. Must NOT colisiones de nombres ni elusión de PermissionManager.
  Closes: GAP-3 (mitad de herramientas de IS-6)
  Parallelization: Ola 13 | Blocked by: 26 | Blocks: 29, 30
  References (executor has NO interview context - be exhaustive): https://modelcontextprotocol.io/specification/2026-07-28/server/tools.md; C:/Users/UserPy/Documents/octus/packages/core/src/tools/tool-gateway.ts; C:/Users/UserPy/Documents/octus/packages/core/src/permissions/permission-manager.ts; C:/Users/UserPy/Documents/octus/packages/core/src/tools/tool-definitions.ts
  Acceptance criteria (agent-executable): `bun test` contra simulado STDIO y HTTP afirma descubrimiento, llamada con nombre aislado y denegación sin permiso, con auditoría de origen
  QA scenarios (name the exact tool + invocation): happy con `bun test` de herramientas (exit 0, evidencia `.omo/evidence/octus-ux-skills-mcp/task-27.txt`); failure: dos servidores con la misma herramienta no colisionan y el no autorizado se niega
  Commit: Y | feat(mcp): namespaced tools through tool gateway
  Recommended task executor category: deep-high (puerta de ejecución transversal con la autoridad de permisos)
- [x] 28. Recursos y prompts MCP con aprobación
  What to do / Must NOT do: Listado y lectura de recursos con plantillas, listado y obtención de prompts y suscripciones cuando el protocolo las soporte; nada no negociado; contenido no confiable con aprobación para lo sensible. Must NOT anunciar capacidades no negociadas.
  Closes: GAP-3 (mitad restante de IS-6)
  Parallelization: Ola 13 | Blocked by: 26 | Blocks: 29, 30
  References (executor has NO interview context - be exhaustive): https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture.md (primitivas); Todo 26 (conexión); C:/Users/UserPy/Documents/octus/packages/core/src/runtime/context-builder.ts (punto de inyección)
  Acceptance criteria (agent-executable): `bun test` contra simulado afirma listar, leer y obtener prompt con aprobación para recurso sensible y actualización por suscripción cuando aplique
  QA scenarios (name the exact tool + invocation): happy con `bun test` de recursos y prompts (exit 0, evidencia `.omo/evidence/octus-ux-skills-mcp/task-28.txt`); failure: recurso sensible sin aprobación se niega antes de inyectarse al contexto
  Commit: Y | feat(mcp): resources and prompts with approval
  Recommended task executor category: unspecified-high (capacidad estándar sobre el manager)
- [x] 29. Gestión de servidores, credenciales y seguridad MCP
  What to do / Must NOT do: Añadir por formulario y JSON compatible, comando y argumentos separados sin shell para STDIO, URL con autenticación para HTTP, editar, verificar, consultar herramientas, recursos, prompts y logs, cambiar permisos; secretos solo en safeStorage con redacción en logs; controles SSRF, HTTPS, límites de tamaño, timeouts y cancelación. Must NOT secretos en SQLite o JSON ni shell insegura.
  Closes: GAP-3
  Parallelization: Ola 13 | Blocked by: 27, 28 | Blocks: —
  References (executor has NO interview context - be exhaustive): C:/Users/UserPy/Documents/octus/packages/core/src/secrets/secret-store.ts (patrón SO-primero); C:/Users/UserPy/Documents/octus/apps/desktop/src/main/secret-store.ts; C:/Users/UserPy/Documents/octus/packages/core/src/tools/web-tools.ts (guardas SSRF existentes); https://modelcontextprotocol.io/specification/2026-07-28/basic/security_best_practices.md; https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization.md
  Acceptance criteria (agent-executable): `bun test` afirma secreto guardado solo en almacén del SO, redacción en logs, rechazo SSRF a rango privado y cancelación por timeout contra simulado lento
  QA scenarios (name the exact tool + invocation): happy con `bun test` de seguridad (exit 0, evidencia `.omo/evidence/octus-ux-skills-mcp/task-29.txt`); failure: URL a 169.254.169.254 se rechaza y token revocado corta la conexión con auditoría
  Commit: Y | feat(mcp): server management, credentials and hardening
  Recommended task executor category: deep-high (superficie de seguridad crítica con una sola decisión coherente)
- [x] 30. MCP Manager UI con estados distinguibles
  What to do / Must NOT do: Lista de servidores, agregar, importar configuración, estado de conexión, transporte, herramientas, recursos, prompts, credenciales, confianza por workspace, permisos, logs y errores; configurado, conectado y autorizado siempre distintos; configurar remoto nunca se llama instalar. Must NOT pantallas contra simulados como si fueran reales en la UI final.
  Closes: GAP-3
  Parallelization: Ola 13 | Blocked by: 27, 28 | Blocks: —
  References (executor has NO interview context - be exhaustive): Todo 4 (especificación UX); Todo 26 (estados de conexión); C:/Users/UserPy/Documents/octus/apps/desktop/src/renderer/src/App.tsx
  Acceptance criteria (agent-executable): Playwright o smoke afirma agregar servidor, importar JSON, conectar, ver herramientas y revocar confianza con `mcp-qa-stdio`
  QA scenarios (name the exact tool + invocation): happy con Playwright del manager (exit 0, evidencia `.omo/evidence/octus-ux-skills-mcp/task-30.txt`); failure: servidor con error de protocolo muestra el error y permite reintentar sin bloquear la lista
  Commit: Y | feat(frontend): mcp manager ui
  Recommended task executor category: visual-engineering (pantallas sobre el servicio real)
- [x] 31. Sonda de políticas de ejecución para la terminal
  What to do / Must NOT do: Verificar con lectura qué políticas de ejecución, permisos de shell y límites aplican a una terminal de usuario y registrar el modelo exacto que consumirá el Todo 32. Solo lectura. Must NOT relajar la política de shell.
  Closes: GAP-4 (verificación previa)
  Parallelization: Ola 14, abre | Blocked by: 6 | Blocks: 32, 33
  References (executor has NO interview context - be exhaustive): C:/Users/UserPy/Documents/octus/packages/core/src/permissions/permission-manager.ts (shell nunca siempre-permitir); C:/Users/UserPy/Documents/octus/packages/core/src/tools/tool-definitions.ts (herramienta shell); C:/Users/UserPy/Documents/octus/.harness/implementation/TARGET_ARCHITECTURE.md (terminal PTY en main)
  Acceptance criteria (agent-executable): informe del modelo de ejecución aplicable con `bun run typecheck` en verde
  QA scenarios (name the exact tool + invocation): happy con sonda que resuelve tres comandos de ejemplo contra la política y registra decisiones (evidencia `.omo/evidence/octus-ux-skills-mcp/task-31.txt`); failure: comando fuera de política se niega en la sonda
  Commit: N | docs: terminal execution policy probe (informe)
  Recommended task executor category: quick (sonda de lectura contenida)
- [x] 32. Terminal persistente con PTY en main y streaming IPC
  What to do / Must NOT do: PTY en el proceso principal con decisión PTY-directo y nota de peso del Todo 3, crear terminal, ejecutar, consultar salida, cancelar, cerrar y elegir entre varias, respetando políticas; canales IPC nuevos con streaming. Must NOT terminal pesada si la nota demuestra alternativa suficiente, y nunca shell sin validación.
  Closes: GAP-4
  Parallelization: Ola 14 | Blocked by: 31 | Blocks: —
  References (executor has NO interview context - be exhaustive): Todo 31 (políticas); Todo 3 (nota de peso); C:/Users/UserPy/Documents/octus/apps/desktop/src/main/index.ts (tabla de canales); C:/Users/UserPy/Documents/octus/packages/shared/src/ipc.ts (contrato); C:/Users/UserPy/Documents/octus/apps/desktop/src/preload/index.ts
  Acceptance criteria (agent-executable): script que abre terminal, ejecuta eco, redimensiona, cancela proceso largo y cierra, con salida por streaming afirmada en Windows
  QA scenarios (name the exact tool + invocation): happy con script de ciclo PTY (exit 0, evidencia `.omo/evidence/octus-ux-skills-mcp/task-32.txt`); failure: proceso que ignora la señal se termina por el harness y la terminal queda reutilizable
  Commit: Y | feat(desktop): persistent pty terminal with ipc streaming
  Recommended task executor category: deep-high (PTY nativo en Windows con IPC y políticas, una sola pieza dura)
- [x] 33. Explorador, diffs, pruebas, problemas y diagnósticos
  What to do / Must NOT do: Explorador de archivos, diferencias de código, archivos modificados, resultados de pruebas y panel de problemas sobre repositorios y worktrees existentes. Must NOT bloquear la UI en proyectos grandes.
  Closes: GAP-4
  Parallelization: Ola 14 | Blocked by: 31 | Blocks: —
  References (executor has NO interview context - be exhaustive): C:/Users/UserPy/Documents/octus/packages/core/src/repositories/repository-manager.ts; C:/Users/UserPy/Documents/octus/packages/core/src/worktrees/worktree-manager.ts; C:/Users/UserPy/Documents/octus/apps/desktop/src/renderer/src/App.tsx
  Acceptance criteria (agent-executable): Playwright o smoke afirma explorar, ver diff, listar modificados y ver resultado de prueba con proyecto `C:\tmp\octus-qa-proj`
  QA scenarios (name the exact tool + invocation): happy con Playwright del explorador y diff (exit 0, evidencia `.omo/evidence/octus-ux-skills-mcp/task-33.txt`); failure: proyecto grande pagina el árbol sin congelar el panel
  Commit: Y | feat(frontend): explorer, diffs, test results and diagnostics
  Recommended task executor category: unspecified-high (vistas estándar con virtualización)
- [x] 34. Rendimiento, arranque y memoria bajo presupuesto
  What to do / Must NOT do: Medir contra el presupuesto del Todo 5 y corregir arranque, memoria, renders, carga diferida de paneles, virtualización, conversaciones extensas, exploración de proyectos grandes, dependencias y filesystem asíncrono con SQLite en su worker. Must NOT regresiones de las etapas anteriores.
  Closes: GAP-5
  Parallelization: Ola 15 | Blocked by: 32 | Blocks: 35, 36
  References (executor has NO interview context - be exhaustive): Todo 5 (presupuesto con cifras); C:/Users/UserPy/Documents/octus/apps/desktop/src/main/index.ts; C:/Users/UserPy/Documents/octus/packages/core/src/persistence/persistence-service.ts
  Acceptance criteria (agent-executable): script de presupuesto que afirma arranque, memoria y render bajo cifras en Windows con `bun run test` en verde
  QA scenarios (name the exact tool + invocation): happy con script de presupuesto (exit 0, evidencia `.omo/evidence/octus-ux-skills-mcp/task-34.txt`); failure: panel que renderiza de más se detecta por conteo y se difiere
  Commit: Y | perf(desktop): budgets for startup, memory and rendering
  Recommended task executor category: deep-low (medición y corrección transversal que el ejecutor dirime leyendo perfiles)
- [x] 35. Auditoría de seguridad de Electron y credenciales
  What to do / Must NOT do: Revisar context isolation, node integration desactivado, preload mínimo, IPC validado, permisos de navegación, ventanas, enlaces externos y gestión de credenciales; migrar restos a safeStorage. Must NOT relajar ninguna garantía.
  Closes: GAP-3 y GAP-5 (cierre de seguridad)
  Parallelization: Ola 15 | Blocked by: 34 | Blocks: —
  References (executor has NO interview context - be exhaustive): C:/Users/UserPy/Documents/octus/apps/desktop/src/main/index.ts; C:/Users/UserPy/Documents/octus/apps/desktop/src/preload/index.ts; C:/Users/UserPy/Documents/octus/apps/desktop/src/main/secret-store.ts; C:/Users/UserPy/Documents/octus/packages/core/src/secrets/secret-store.ts
  Acceptance criteria (agent-executable): checklist ejecutable que afirma cada garantía con prueba (aislamiento, IPC, navegación, enlaces, secretos fuera de disco plano) en verde
  QA scenarios (name the exact tool + invocation): happy con script de auditoría (exit 0, evidencia `.omo/evidence/octus-ux-skills-mcp/task-35.txt`); failure: secreto en JSON plano se detecta por escaneo y bloquea el cierre
  Commit: Y | feat(desktop): electron security audit and credential migration
  Recommended task executor category: deep-low (auditoría transversal con pruebas concretas)
- [x] 36. Distribución Windows, escaneo de secretos y documentación final
  What to do / Must NOT do: Compilación y distribución inicial para Windows; escaneo de secretos y redacción de evidencia como gate; roadmap integral, arquitecturas, inventarios, diseños, contratos, mapa de integración, matriz de permisos, persistencia, seguridad, pruebas y criterios por etapa actualizando documentos existentes sin duplicar. Registrar la rotación de las claves de k.txt como pre-gate del usuario para live. Must NOT push sin autorización ni mezclar funcionalidades incompletas.
  Closes: GAP-5 e IS-9
  Parallelization: Ola 15, cierra | Blocked by: 34 | Blocks: —
  References (executor has NO interview context - be exhaustive): C:/Users/UserPy/Documents/octus/apps/desktop (build con electron-vite); C:/Users/UserPy/Documents/octus/.harness/implementation/IMPLEMENTATION_ROADMAP.md; intrucion.txt secciones 15, 16 y 18
  Acceptance criteria (agent-executable): instalador o paquete portable generado, escaneo de secretos en verde, documentos finales existentes y trazables a cada ola, `bun run test` en verde
  QA scenarios (name the exact tool + invocation): happy con build más escaneo (exit 0, evidencia `.omo/evidence/octus-ux-skills-mcp/task-36.txt`); failure: clave o token en evidencia se detecta, se redacta y se bloquea el empaquetado
  Commit: Y | feat(desktop): windows distribution, secret scan and final docs
  Recommended task executor category: unspecified-low (empaquetado y documentación con gates por script)

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [x] F1. Plan compliance audit
  Ejecuta `bun scripts/plan-compliance.ts --plan .omo/plans/octus-ux-skills-mcp.md` o revisión equivalente por script que afirma cada todo con referencias, aceptación, QA y commit; afirma matriz de dependencias consistente. Evidencia `.omo/evidence/octus-ux-skills-mcp/f1.txt`.
- [x] F2. Code quality review
  Ejecuta `bun run typecheck` y `bun run test` en raíz más revisión de calidad del diff por ola (sin duplicar valores de diseño, sin secretos, sin referencias a módulos inexistentes). Evidencia `.omo/evidence/octus-ux-skills-mcp/f2.txt`.
- [x] F3. Real manual QA
  Ejecuta la batería Playwright o smoke de bienvenida, layout, conversación extensa, Agent Manager, Skills, MCP, terminal y temas con datos fijos (`C:\tmp\octus-qa-proj`, `mcp-qa-stdio`, `qa-skill@1.0.0`); toda interacción la ejecuta el agente, ninguna la hace el usuario. Evidencia `.omo/evidence/octus-ux-skills-mcp/f3.txt`.
- [x] F4. Ideal-state fidelity
  Recorre IS-1 a IS-9 contra el comportamiento entregado uno a uno con su escenario probatorio; cada faltante se convierte en nuevos `- [ ] N.` numerados, nunca en nota. Evidencia `.omo/evidence/octus-ux-skills-mcp/f4.txt`.

## Commit strategy
- Una rama por funcionalidad y ola con la base correcta; gate verde (`bun run test` más la aceptación del todo) antes de continuar; commits trazables con el formato de cada todo; sin mezclar funcionalidades incompletas; sin push sin autorización del usuario; la convención de ramas y gates sigue el flujo Git ya usado en etapas 1–6.

## Success criteria
| IS | Delivering todo(s) | Proving QA scenario | Evidence |
| --- | --- | --- | --- |
| IS-1 | 10, 11 | Bienvenida con dropzone y recientes; ciclo de sesión con recuperación | .omo/evidence/octus-ux-skills-mcp/task-10.txt, task-11.txt |
| IS-2 | 8, 9 | Layout con ocultar, redimensionar y restaurar persistido | .omo/evidence/octus-ux-skills-mcp/task-8.txt |
| IS-3 | 13, 14 | Conversación extensa virtualizada con streaming y cancelación; aprobaciones y preguntas | .omo/evidence/octus-ux-skills-mcp/task-13.txt, task-14.txt |
| IS-4 | 16, 17 | Vistas de agentes y DAG con datos reales; diff y promoción con SHA | .omo/evidence/octus-ux-skills-mcp/task-16.txt, task-17.txt |
| IS-5 | 20, 21, 22, 23, 24 | Descubrimiento sin duplicados; carga progresiva con registro por run; manager UI | .omo/evidence/octus-ux-skills-mcp/task-23.txt, task-24.txt |
| IS-6 | 26, 27, 28, 29, 30 | Confianza por workspace; herramientas aisladas; recursos con aprobación; secretos en SO | .omo/evidence/octus-ux-skills-mcp/task-27.txt, task-29.txt |
| IS-7 | 32, 33 | Ciclo PTY con cancelación; explorador con diff y diagnósticos | .omo/evidence/octus-ux-skills-mcp/task-32.txt, task-33.txt |
| IS-8 | 6, 7 | Persistencia de tema, tamaño y densidad; catálogo sobre tokens | .omo/evidence/octus-ux-skills-mcp/task-6.txt |
| IS-9 | 36 | Build con escaneo de secretos y sin gasto live no autorizado | .omo/evidence/octus-ux-skills-mcp/task-36.txt |

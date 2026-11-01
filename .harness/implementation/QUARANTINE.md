# Cuarentena documental: linaje OpenOrch frente a árbol vivo de Octus

- **Fecha:** 2026-11-01
- **Tarea del plan:** Todo 1 de `.omo/plans/octus-ux-skills-mcp.md` (ola 7, diseño)
- **Rama:** `feat/ux-skills-mcp-w7-design`, worktree `octus-wt-octus-ux-skills-mcp-w7`
- **Regla de trabajo:** los documentos de linaje se conservan tal cual. Esta cuarentena no reescribe historia: solo dice qué partes valen como historia y qué partes nadie debe usar como referencia de integración en las olas 7 a 15. No reabre ni renegocia contratos de las etapas 1 a 6.

La autoridad sobre qué existe está en `TREE_AUTHORITY.md` (misma carpeta). Ante cualquier duda entre un documento y el árbol, gana el árbol.

## Cómo leer este archivo

Cada fila nombra un documento o sección, dice si queda en cuarentena total o parcial, y da el motivo en una línea. "Cuarentena" significa: lectura permitida como contexto histórico, prohibido citarlo como prueba de que un módulo existe o como contrato para codificar encima. Los tests y documentos existentes son la conducta de registro: una contradicción con el plan es un hallazgo y se anota, nunca se edita para que pase.

## Hallazgos previos (verificación contra el árbol real, 2026-11-01)

Módulos citados por el plan como inexistentes, todos confirmados ausentes en el árbol vivo:

| Ruta citada | Estado en el árbol vivo |
|---|---|
| `packages/core/src/engine.ts` | Ausente. El runtime real es `packages/core/src/runtime/agent-runtime.ts`. |
| `packages/core/src/mcp.ts` | Ausente. No hay Client Manager MCP todavía (GAP-3 del plan). |
| `packages/core/src/skills.ts` | Ausente. No hay SkillManager todavía (GAP-2 del plan). |
| `packages/core/src/codemode.ts` | Ausente. Code Mode quedó fuera del núcleo (ADR-013). |
| `packages/core/src/tools/browser.ts` | Ausente. En `tools/` solo hay `git-tools`, `path-scope`, `process-tree`, `shell-guard`, `test-runner`, `test-tools`, `tool-definitions`, `tool-gateway`, `tool-services`, `web-tools`. |
| `packages/core/src/mcp-auth` (y `mcp-auth.json` en claro) | Ausente. Patrón vigente: secretos en almacén del SO (`packages/core/src/secrets/secret-store.ts` y `apps/desktop/src/main/secret-store.ts`, ambos existen). |

Dependencias reales en `packages/core/package.json`: `openai`, `yaml`, `zod` (más `@octus/shared` del workspace). Sin SDK MCP y sin `node-pty`. Eso confirma las notas del plan sobre dependencias.

Referencias del plan verificadas como existentes (31 de 32): `packages/shared/src/{events,ipc,domain}.ts`, `runtime/{context-builder,agent-runtime}.ts`, `tools/{tool-gateway,web-tools}.ts`, `permissions/permission-manager.ts`, `orchestration/agent-manager.ts`, `persistence/persistence-service.ts`, `secrets/secret-store.ts`, `tasks/{task-manager,task-graph,task-scheduler}.ts`, `integration/{integration-manager,preview-manager,approval-service,promotion-manager,conflict-manager,validation-service}.ts`, `sessions/octus-core.ts`, `questions/question-service.ts`, `repositories/repository-manager.ts`, `apps/desktop/src/{renderer/{App,store,api},main/index,main/secret-store,preload/index}`.

**HALLAZGO 1 (deriva de nombre en el plan, no se edita):** el Todo 17 del plan agrupa `integration (manager, validation, preview, approval, promotion, conflict)`. Los cinco primeros y el último resuelven a archivos reales (`integration-manager`, `validation-service`, `preview-manager`, `approval-service`, `conflict-manager`). El quinto resuelve a `promotion-manager.ts`; no existe ningún `promotion-service.ts`. Es solo una abreviatura del plan, no un contrato roto: la ola 11 debe importar `promotion-manager.ts`.

## Tabla de cuarentena por documento

| Documento / sección | Alcance de cuarentena | Motivo |
|---|---|---|
| `AUDIT.md` completo (§§1-13) | Total como referencia de integración; válido como historia | Describe el repositorio OpenOrch (`engine.ts`, `mcp.ts`, `skills.ts`, `codemode.ts`, `tools/browser.ts`, `tools/opencode.ts`, `session/store.ts`, `worktree.ts`, `schedule.ts`, catálogo de 214 proveedores). Ninguna de esas rutas existe en Octus. Sirve para entender de dónde vienen los requisitos negativos (ADR-015), no para codificar encima. |
| `CURRENT_ARCHITECTURE.md` completo (§§1-10) | Total como referencia de integración; válido como historia | Mapa del sistema OpenOrch (Engine en proceso main, `McpManager` en `mcp.ts`, `CodeMode`, `WorktreeManager` básico, `schedule.ts`). Octus tiene otra arquitectura (etapas 1-6). |
| `TARGET_ARCHITECTURE.md` §3 (estructura de repositorio propuesta) | Parcial: esquema válido, rutas no vinculantes | El esquema general coincide con el árbol vivo, salvo `src/git/`, que en el árbol real son `src/repositories/` + `src/worktrees/`. Las rutas de §3 son un boceto previo; ante una diferencia, vale el árbol. |
| `TARGET_ARCHITECTURE.md` §§8-10 (adaptadores, herramientas, Git, memoria) | Parcial: diseño vigente de etapas 1-6, no catálogo de archivos | Describe decisiones y contratos, no garantiza nombres de archivo. Los nombres reales se comprueban en el árbol (p. ej. secretos en `secrets/secret-store.ts`, no en `config.json`). |
| `TARGET_ARCHITECTURE.md` resto (§§1, 2, 4-7, 11-16) | Sin cuarentena | Principios, modelo de dominio, ciclos de vida y estrategia de verificación siguen vigentes para las olas 7-15. |
| `IMPLEMENTATION_ROADMAP.md` etapas 0-6 | Sin cuarentena, lectura de puertas | Registro de etapas cerradas con sus informes. Las olas 7-15 lo usan para saber qué está cerrado, no para reabrirlo. Puertas de salida ya superadas, no se revalidan. |
| `DECISIONS.md` ADR-001 a ADR-069 | Sin cuarentena | Decisiones vinculantes, incluidas las de seguridad (ADR-008, ADR-015, ADR-018, ADR-026) que las olas 12 y 13 deben cumplir. Las menciones a rutas OpenOrch dentro de ADRs son contexto histórico. |
| `DECISIONS.md` pendientes P-05, P-06, P-07 | Sin cuarentena, abiertos | P-06 (preview) se cerró en la Etapa 5; P-05 y P-07 siguen abiertos y pertenecen a la Etapa 6, fuera de este plan. |
| `REUSE_MATRIX.md`, `MASTER_SPEC.md`, `STAGE2-6_ACCEPTANCE_REPORT.md` | Total como referencia de integración; válidos como historia | Hablan de componentes OpenOrch (`mcp.ts`, `tools/mcp.ts`, `skills.ts`, `codemode.ts`, `tools/browser.ts`, navegador dock, schedule). Conceptos reutilizables sí; rutas no. |

## Reglas para las olas 7 a 15

1. Ningún diseño, contrato o prueba de las olas 7-15 cita una ruta de la tabla como existente. Si la necesita, primero comprueba el árbol.
2. Todo módulo nuevo (Skills, MCP, terminal) usa nombres propios de Octus. Queda prohibido recrear los nombres en cuarentena (`mcp.ts`, `skills.ts`, `codemode.ts`, `engine.ts`, `tools/browser.ts`) para no resucitar la confusión.
3. El script `scripts/check-doc-refs.ts` (ejecutable con `bun`, salida 0) vigila estas reglas. Si un módulo en cuarentena llegara a crearse a propósito, se actualiza esta tabla antes de tocar el script.
4. Formato Agent Skills solo como referencia futura. Nada de este plan instala Skills de terceros ni conecta servidores MCP reales.
5. Secretos: este archivo no cita ni copia el contenido de `C:/Users/UserPy/Desktop/PromtHack/k.txt`. Las dos claves en claro que menciona el plan se rotan antes de cualquier verificación live, fuera de esta tarea.

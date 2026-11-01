# Nota de autoridad: el árbol vivo manda

- **Fecha:** 2026-11-01
- **Ámbito:** olas 7 a 15 del plan `octus-ux-skills-mcp`, rama `feat/ux-skills-mcp-w7-design`

## Declaración

La única fuente que dice qué módulos existen en Octus es el árbol vivo de este worktree:

- `packages/core/src` (motor sin dependencias de Electron)
- `packages/shared/src` (contratos de dominio, eventos e IPC)
- `apps/desktop/src` (main, preload, renderer)

Ningún documento de `.harness/implementation/` anterior a esta nota crea, renombra ni mueve un módulo. Si un documento dice que un archivo existe y el árbol dice que no, el documento es historia y el árbol tiene razón. El detalle de qué quedó en cuarentena está en `QUARANTINE.md`.

## Anclas verificadas (existen hoy, comprobadas 2026-11-01)

Runtime y gobierno: `runtime/agent-runtime.ts`, `tools/tool-gateway.ts`, `permissions/permission-manager.ts`, `runtime/context-builder.ts`, `orchestration/agent-manager.ts`, `tasks/task-scheduler.ts`, `tasks/task-graph.ts`, `tasks/task-manager.ts`.

Persistencia y secretos: `persistence/persistence-service.ts`, `secrets/secret-store.ts`, `apps/desktop/src/main/secret-store.ts`. Los secretos viven en el almacén del sistema operativo, nunca en SQLite ni en JSON plano.

Contratos compartidos: `packages/shared/src/domain.ts`, `events.ts`, `ipc.ts`, `tools.ts`, `permissions.ts`, `model.ts`, `costs.ts`.

Integración Git: `repositories/repository-manager.ts`, `worktrees/worktree-manager.ts`, `integration/{integration-manager,conflict-manager,validation-service,preview-manager,approval-service,promotion-manager}.ts`.

Escritorio: `apps/desktop/src/main/index.ts`, `preload/index.ts`, `renderer/src/{App.tsx,store.ts,api.ts}`.

## Ausencias vigentes (no existen hoy, comprobadas 2026-11-01)

`packages/core/src/engine.ts`, `mcp.ts`, `skills.ts`, `codemode.ts`, `tools/browser.ts` y cualquier `mcp-auth` en claro. Tampoco hay SDK MCP ni `node-pty` en `packages/core/package.json` (dependencias: `openai`, `yaml`, `zod`). Estas ausencias son los GAP-2, GAP-3 y GAP-4 que las olas 12, 13 y 14 vienen a cerrar con nombres nuevos, nunca resucitando los nombres en cuarentena.

## Cómo se vigila

El script `scripts/check-doc-refs.ts` (salida 0 con `bun`) afirma en cada pasada que las ausencias siguen ausentes, que ningún `.ts` del árbol importa rutas fantasma, que ningún `.md` nuevo fuera de `.harness` las cita como existentes, y que las anclas de esta nota siguen en su sitio.

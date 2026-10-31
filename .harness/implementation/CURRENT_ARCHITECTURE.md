# CURRENT_ARCHITECTURE.md — Arquitectura actual de la referencia (OpenOrch)

- **Fecha:** 2026-10-30
- **Objeto:** describir cómo funciona hoy `C:\Users\UserPy\Documents\OpenOrch`, que actúa **solo como referencia** para construir Octus desde cero.
- **Nota de nomenclatura:** en este documento "el sistema" es OpenOrch. Octus aún no tiene arquitectura actual: su estado inicial es un directorio vacío más esta carpeta de implementación.

## 1. Vista general

```text
┌──────────────────────────── apps/desktop ────────────────────────────┐
│  Renderer SolidJS ── window.openorch.invoke("openorch:<método>") ──┐ │
│        ▲ eventos "engine:event" / terminal / browser / schedule    │ │
│  Preload (contextBridge, invoke genérico tipado débilmente)        │ │
│  Main Electron: Engine en el proceso principal, IPC, ventanas,     │ │
│  tray, DockBrowser (webview+CDP), ExtensionBridge (WS 127.0.0.1),  │ │
│  TerminalManager (PTY), diálogos nativos                           │ │
└──────────────────────────────────┬─────────────────────────────────┘
                                   │ importa directamente
┌──────────────────────────────────▼──────────── packages/core ──────┐
│  Engine ── AgentRegistry ── PermissionEngine ── McpManager         │
│    │  ├─ Providers (AI SDK + catálogo)                             │
│    │  ├─ Tools (builtin + MCP + browser vía ToolServices)          │
│    │  ├─ SessionStore (SQLite node:sqlite / fallback JSON)         │
│    │  ├─ WorktreeManager (git worktree básico)                     │
│    │  ├─ Skills, WebSearch, CodeMode (node:vm), ScheduleManager   │
│    └─ ConfigStore (config.json) + ModelPrefs (model.json)          │
└────────────────────────────────────────────────────────────────────┘
        packages/shared: tipos del contrato (parcialmente efectivos)
```

Decisión estructural dominante: el motor vive **dentro del proceso main** de Electron y se importa como fuente TypeScript (electron-vite lo resuelve al workspace). No hay proceso de servicio separado, ni API local por red, ni worker. `apps/desktop/src/main/index.ts:6,688-702`, `apps/desktop/electron.vite.config.ts:10-22`

## 2. Componentes y responsabilidades

| Componente | Responsabilidad | Ubicación |
|---|---|---|
| `Engine` | Orquesta sesiones, turnos, streaming, herramientas, permisos, subagentes, compactación, títulos, MCP, modelos y eventos. Monolito de ~118 KB | `packages/core/src/engine.ts:216` |
| `AgentRegistry` | Registro de agentes builtin + Markdown (`.opencode/agent`) + overrides de config; resolución y listados por modo | `packages/core/src/agents/index.ts:343-413` |
| Composición de prompts | Prompt base por modelo, sistema por agente, contexto inicial (entorno, AGENTS.md, skills, MCP, navegador, Code Mode) | `packages/core/src/agents/index.ts:434-502`, `packages/core/src/engine.ts:1999-2054` |
| `PermissionEngine` | Evaluación última-regla-gana, flujo ask con promesas pendientes, reglas guardadas en SQLite/JSON | `packages/core/src/permissions.ts:67-209` |
| Herramientas builtin | FS, shell, búsqueda, web, agentes (subagent/question/skill), opencode (sesión/worktree/models), MCP, navegador | `packages/core/src/tools/*.ts`; construcción en `tools/index.ts:44-76` |
| `McpManager` | Conexión stdio/remota, OAuth, reconexión con backoff, exposición de tools/recursos | `packages/core/src/mcp.ts:52` |
| `CodeMode` | Runtime JS confinado (`node:vm`) que permite componer herramientas desde código generado | `packages/core/src/codemode.ts:15-301` |
| Providers | Catálogo híbrido, runtimes, creación de `LanguageModel` (AI SDK), variantes de razonamiento, small/cheap | `packages/core/src/providers/index.ts:158-479` |
| `SessionStore` | Persistencia de sesiones/mensajes en SQLite o JSON, caché en memoria | `packages/core/src/session/store.ts:17-226` |
| Almacenamiento SQLite | Apertura de `openorch.db`, esquema, migración desde JSON, store de permisos guardados | `packages/core/src/storage.ts:27-203` |
| `WorktreeManager` | `git worktree` list/create/remove | `packages/core/src/worktree.ts:21-137` |
| `ScheduleManager` | Tareas programadas locales de un agente (no scheduler multiagente) | `packages/core/src/schedule.ts:311-727` |
| Skills | Descubrimiento multi-raíz, anuncio al modelo, carga bajo demanda, CRUD desde UI | `packages/core/src/skills.ts` |
| Desktop main | Ventana, IPC, tray, navegador dock/extensión, terminal PTY, notificaciones, login item | `apps/desktop/src/main/index.ts`, `browser.ts`, `browser-bridge.ts`, `extension-browser.ts` |
| Renderer | Store Solid central, timeline, composer, docks, settings, diálogos | `apps/desktop/src/renderer/src/store.ts`, `App.tsx`, `components/*` |

## 3. Flujo de datos principal

### 3.1 Petición/respuesta (renderer → core)

`api.ts` (fachada con casts) → `window.openorch.invoke(método)` → preload antepone `openorch:` → `ipcMain.handle` → método del Engine o servicio del main (diálogos, terminal, browser, schedule, app). `apps/desktop/src/renderer/src/api.ts:37-167`, `apps/desktop/src/preload/index.ts:5-72`, `apps/desktop/src/main/index.ts:463-646`

El tipo `EngineIPC` de shared declara gran parte de esta superficie pero no se usa como contrato efectivo; los canales reales incluyen varios no declarados y alguna firma difiere de la declarada. Ver AUDIT.md §9.3.

### 3.2 Eventos (core → renderer)

El constructor del Engine recibe un callback: el main primero procesa efectos (notificaciones, sincronización de fondo) y luego reenvía `engine:event` al renderer, suprimiendo `message.*`/`part.*` de sesiones no visibles (`sessions.watch`). Canales push adicionales: `terminal:data/exit`, `browser:openTab/closeTab/focusTab`, `schedule:open`, `session:open`, `dock:shortcut`. El store del renderer aplica cada evento con `applyEvent` (cast sin validación runtime). `apps/desktop/src/main/index.ts:154-183,487-489,691-697`, `apps/desktop/src/renderer/src/store.ts:581-715`, `apps/desktop/src/renderer/src/App.tsx:59-94`

Tipos de evento (22 variantes): sesión creada/actualizada/borrada/estado, mensaje creado/actualizado/borrado, parte creada/delta/actualizada, permiso preguntado/respondido, pregunta pedida/respondida, schedule actualizado/borrado/run, config/agentes/proveedores/MCP actualizados y error. `packages/shared/src/index.ts:595-617`

### 3.3 Turno de agente (flujo interno)

Descrito paso a paso en AUDIT.md §5.1. En síntesis: cola por sesión → un paso = una llamada `streamText` de un step → el engine ejecuta las herramientas → reconstruye el historial → siguiente paso, hasta respuesta final, límite de pasos o abort. La persistencia es incremental en SQLite (inserción al crear, mutaciones `dirty`) y los eventos de parte alimentan la UI en vivo.

## 4. Ciclo de vida

### 4.1 Sesión

`createSession` (directorio, agente, modelo por defecto resuelto en cascada: config → por directorio → recientes → más barato) → prompts encolados → estados `busy/idle` → borrado manual con cascada manual sobre mensajes. Las sesiones hijas fijan `parentID`; borrar un padre no cascada sobre hijas en esta capa. `packages/core/src/engine.ts:792-853`, `packages/core/src/session/store.ts:217-225`

### 4.2 Agente (definición e instancia)

No existe distinción definición/instancia como entidades: la "instancia" es una sesión cuyo `info.agent` apunta a una definición del registro. Cambiar el agente de una sesión muta esa referencia; continuar un subagente reutiliza su sesión hija. `packages/core/src/engine.ts:854-873,2109-2140`

### 4.3 Tarea

No existe el concepto: hay mensajes, turnos y sesiones. Las tareas programadas (`ScheduledTask`) son otra entidad, de automatización temporal, con runs secuenciales de un solo agente. `packages/shared/src/index.ts:498-589`, `packages/core/src/schedule.ts:580-627`

## 5. Persistencia

| Dato | Dónde | Mecanismo |
|---|---|---|
| Sesiones y mensajes | `openorch.db` (SQLite WAL) o `sessions/*.json` | `SessionStore`, blob JSON por mensaje |
| Permisos guardados ("siempre") | Tabla `permission` o `permissions.json` | Por directorio exacto, solo `allow` |
| Configuración | `config.json` | `deepMerge` sobre defaults, escritura atómica, watcher de recarga |
| Credenciales de proveedores | Dentro de `config.json` (texto claro) o variables de entorno del catálogo | `config.providers[id].apiKey` |
| Preferencias de modelo | `model.json` | recientes (≤10), por directorio, variante por modelo |
| Cachés de catálogo/consola | `models-catalog.json`, `console-config.json` | TTL 24 h / 1 h; sin credenciales |
| Tokens OAuth MCP / puente navegador | `mcp-auth.json`, `browser-bridge.json` | JSON en claro |
| Tareas programadas | Tablas `schedule_task`/`schedule_run` o `schedules.json` | Historial de runs acotado a 50 |
| Estado UI | `localStorage` del renderer | Layout de dock, sidebar, terminal |

Directorio de datos: `OPENORCH_DATA_DIR` o `userData/data` de Electron. `apps/desktop/src/main/index.ts:23-26`, `packages/core/src/storage.ts:72-89`

Esquema SQLite: `session`, `message` (+índice por sesión/secuencia), `permission`, `kv` (sin uso), `schedule_task`, `schedule_run` (+índice). Sin claves foráneas reales pese a `PRAGMA foreign_keys=ON`. `packages/core/src/storage.ts:27-70`

## 6. Modelos y proveedores (estado actual)

- Fuentes de modelos: catálogo embebido models.dev (snapshot), caché live con merge, descubiertos vía `/models` (persistidos en config), custom definidos por el usuario. `packages/core/src/providers/index.ts:145-148,246-306`, `packages/core/src/engine.ts:551-607`
- `resolveModel` por sesión: modelo de sesión validado contra runtimes disponibles; si desaparece, cae al por defecto, reescribe la sesión y avisa con mensaje sintético. `packages/core/src/engine.ts:1833-1860`
- Reasoning: variantes declaradas por el catálogo y traducidas por `variantOptions(kind, model, variant)`; sin declaración no hay variantes seleccionables. `packages/core/src/providers/index.ts:103-122,391-479`
- Coste: calculado por mensaje desde el catálogo y agregado a la sesión; títulos y compactación no registran su coste. `packages/core/src/engine.ts:1418-1443,2451-2501,2699-2713`

## 7. Interfaz de escritorio

Componentes principales del renderer y su rol:

| Componente | Rol |
|---|---|
| `WorkspacePicker` | Elegir/abrir workspace (también drag & drop) |
| `Sidebar` | Árbol de workspaces/sesiones, buscador, estado MCP |
| `Composer` | Prompt, adjuntos, skills `@`, modelo/variante, comandos |
| `MessageParts` / `ToolParts` / `Diff` | Render de mensajes, tarjetas de herramienta y parches |
| `Markdown` | Markdown + resaltado (Shiki) vía `innerHTML` |
| `Docks` / `Dock` | Preguntas/permisos al usuario y panel derecho redimensionable |
| `BrowserTab` / `DockGuide` | Pestañas del navegador dock y lanzador |
| `TerminalPanel` | xterm enlazado al PTY del main |
| `Settings` / `ScheduleDialog` / `SkillDialog` / `ModelCatalog` | Configuración, tareas programadas, skills, modelos |
| `store.ts` (~1.027 líneas) | Estado global Solid: config, sesiones, mensajes (≤6 transcripciones), busy, permisos, preguntas, layout |

El main aporta además: ventana única 1480×940 con `contextIsolation:true`, `nodeIntegration:false`, `webviewTag:true`, `sandbox:false`; recuperación del renderer (2 recargas, luego relanzamiento); apagado con tiempo para cerrar MCP; tray/notificaciones y login item si hay tareas en fondo. `apps/desktop/src/main/index.ts:205-270,326-408,726-752`

El navegador tiene dos backends tras una misma interfaz (`BrowserService`): dock Electron (`<webview>` + CDP, partición `persist:openorch-web*`) y extensión MV3 vía WebSocket en `127.0.0.1` con código de emparejamiento; `auto` prefiere la extensión. `packages/core/src/tools/types.ts:43-63`, `apps/desktop/src/main/browser.ts`, `extension-browser.ts:127-158`

## 8. Configuración y extensibilidad actual

- Agentes custom en Markdown (`.opencode/agent/*.md`, global y de proyecto) y por `config.agents`.
- Skills descubiertas en raíces globales/de proyecto/configuradas (`SKILL.md` con frontmatter propio).
- MCP global + de proyecto (`.opencode/mcp.json`, `.openorch/mcp.json`; el de proyecto sobrescribe por nombre) con watcher y reconexión en vivo.
- Proveedores custom `openai-compatible` y de catálogo.
- Code Mode activo por defecto: las herramientas marcadas salen del set directo y se componen desde `execute`.

## 9. Verificación actual

| Suite | Cobertura | Naturaleza |
|---|---|---|
| `typecheck` | shared, core, desktop (2 tsconfig) | `tsc --noEmit` encadenado |
| `check:core` | Skills, replay de historial, AI SDK, variantes/catálogo/consola, shell, subagentes, permisos/plan, MCP stdio/remoto/OAuth, websearch, retos de navegador (144 checks) | Script propio sin Electron; escribe `.data/core-check`; red solo para websearch (con SKIP) |
| `check:schedule` | Zonas horarias, repeticiones, store, interrupción (12 checks) | Sin Electron |
| `check:bridge` | Protocolo puente↔extensión con extensión falsa (13 checks) | WS local, sin navegador |
| `check:readmes` | 22 READMEs consistentes (388 comprobaciones) | Solo lectura |
| `e2e` | >200 checks UI completos con proveedor y MCP falsos | Electron + Playwright-core, Windows, instancia única |

Mocks: proveedor OpenAI-compatible SSE con disparadores por palabra clave, MCP stdio y MCP remoto con OAuth completo. `scripts/mock-provider.ts`, `scripts/mock-mcp.ts`, `scripts/mock-mcp-remote.ts`

No hay CI ni unit tests con runner; `CONTRIBUTING.md:20-36` define la puerta manual de PR.

## 10. Limitaciones arquitectónicas (para el diseño de Octus)

1. `Engine` monolítico en el proceso main: un fallo o bloqueo afecta a toda la app; difícil de probar por partes.
2. Sin entidades Run/Task/DAG: la orquestación multiagente no tiene dónde apoyarse sin refactor profundo.
3. Contrato IPC declarado pero no efectivo: deriva silenciosa entre shared, preload, main y renderer.
4. Seguridad apoyada en capas desiguales: permisos fuertes en el núcleo de evaluación, débiles en puertas por herramienta y en contención de rutas (AUDIT.md §7, §10).
5. Credenciales y tokens en claro, con el `Config` íntegro accesible al renderer.
6. Subagentes sin gobernanza (timeout, cancelación en cascada, conflictos de escritura, límites de concurrencia).
7. Compactación con pérdida potencial del tramo reciente y reintentos con posible doble efecto (AUDIT.md §10).
8. Worktrees sin integración: el salto de "worker termina" a "cambio aprobado" no existe como sistema.

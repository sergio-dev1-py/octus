# AUDIT.md — Auditoría de OpenOrch como referencia para Octus

- **Fecha:** 2026-10-30
- **Etapa:** Prompt 0 (solo auditoría y diseño; sin código funcional)
- **Proyecto auditado (referencia):** `C:\Users\UserPy\Documents\OpenOrch`
- **Proyecto destino:** `C:\Users\UserPy\Documents\octus` (vacío al inicio de esta etapa)
- **Especificación rectora:** `C:\Users\UserPy\Desktop\PromtHack\Promt0.txt` (PROMPT MASTER + PROMPT 0), adaptada por las decisiones registradas en `DECISIONS.md`

## 0. Método, alcance y límites

Método seguido:

1. Inspección de la estructura, manifiestos y documentación propia del repositorio (`README.md`, `CONTRIBUTING.md`, `package.json`).
2. Seguimiento del flujo real de ejecución en el código: entrada del usuario → composición de prompt → llamada al modelo → streaming → ejecución de herramientas → persistencia → eventos hacia la UI.
3. Auditorías especializadas en paralelo de cuatro áreas: (a) agentes y runtime, (b) herramientas, permisos, MCP, navegador y worktrees, (c) proveedores, persistencia, sesiones y configuración, (d) aplicación de escritorio, IPC/eventos y verificación.
4. Verificación de la documentación oficial vigente de Meta Model API (ver §11; páginas consultadas el 2026-10-30).
5. Ejecución de la línea base segura de comprobaciones (§12). No se ejecutó la suite `e2e`: lanza Electron, exige cerrar cualquier instancia previa por el bloqueo de instancia única, es Windows-only y siembra datos en `.data/`.

Alcance excluido deliberadamente, conforme al PROMPT 0: contenido de `node_modules`, `.git`, binarios, salidas de compilación y el volcado completo del catálogo de modelos embebido (solo se auditaron sus metadatos y su código de consumo). No se leyó ni reprodujo ningún secreto; las claves se mencionan solo por el mecanismo donde residen.

Resultado de integridad: tras ejecutar la línea base, `git status --porcelain` en OpenOrch devolvió salida vacía (sin modificaciones; los artefactos de las comprobaciones van a `.data/`, ignorado por Git). Rama auditada: `main`, commit `1134a77`.

**Advertencia de interpretación.** OpenOrch es la *referencia arquitectónica y de comportamiento*. Por decisión del propietario (ADR-001), Octus se construye desde cero: de esta auditoría se extraen conceptos, contratos, comportamientos verificados y defectos a evitar. No se copia código.

## 1. Resumen ejecutivo

OpenOrch es un harness de escritorio local-first para agentes de programación, inspirado en OpenCode, con un motor de agente propio y funcional: bucle de pasos controlado por el propio engine, composición de prompts por capas, subagentes como sesiones hijas persistidas, herramientas con validación de esquemas, permisos evaluados en runtime, persistencia SQLite y una UI Electron/SolidJS completa. Las comprobaciones seguras pasan (144/144 en el núcleo).

Frente al objetivo del PROMPT MASTER, OpenOrch ya resuelve bien la *mitad inferior* del sistema (runtime de un agente, herramientas, permisos, sesiones) y no contiene la *mitad superior* de orquestación multiagente: no hay Task DAG, Scheduler de tareas, Integration/Preview/Promotion Manager ni Memory Service. Sus subagentes son delegación conversacional (una herramienta más), no trabajadores gobernados por un plan con dependencias, aislamiento Git y criterios de aceptación.

Los defectos más relevantes detectados no son de funcionalidad ausente sino de seguridad y corrección, y constituyen requisitos negativos obligados para Octus (ver §10 y ADR-015):

- Los perfiles "de solo lectura" (Plan, Explore) conservan `shell` completo: su contención es instruccional, no de runtime.
- Los servidores MCP de proyecto se conectan (y ejecutan) al abrir un workspace, sin puerta de confianza.
- Varias herramientas carecen de puerta de permiso en runtime (`session_move`, `worktree_create`, recursos MCP, `fetch` de Code Mode): un `ask` configurado para ellas nunca se aplica.
- Las credenciales viven en texto claro en `config.json` y el `Config` completo se devuelve al renderer por IPC.
- La ventana de "contexto reciente" de la compactación puede quedar fuera del contexto del modelo de forma permanente.
- Los reintentos de streaming pueden duplicar texto y re-ejecutar tool calls ya emitidas.

## 2. Inventario del repositorio

| Ruta | Rol auditado |
|---|---|
| `package.json` | Monorepo Bun (workspaces `packages/*`, `apps/*`), scripts de dev/check/e2e, `packageManager: bun@1.4.2` |
| `apps/desktop` | App Electron: proceso main, preload, renderer SolidJS, puente de navegador y extensión |
| `packages/core` | Motor: engine de agente, agentes/prompts, proveedores, herramientas, permisos, MCP, sesiones, SQLite, worktrees, skills, tareas programadas |
| `packages/shared` | Tipos compartidos core↔UI: modelos, sesiones, mensajes, permisos, eventos e IPC declarados |
| `extensions/openorch-browser` | Extensión MV3 (Edge/Chrome) para controlar pestañas del grupo "OpenOrch" |
| `scripts` | Checks artesanales (`check-core`, `check-schedule`, `check-bridge`, `check-readmes`, `check-zen`, `check-search`, `check-extension-live`), `e2e`, mocks de proveedor/MCP y generadores de catálogo/prompts |
| `docs` | Solo capturas de pantalla; no hay documentación técnica de arquitectura |
| `.data` | Datos locales de ejecución/checks (ignorado por Git) |

Tamaños que condicionan cualquier reutilización conceptual: `packages/core/src/engine.ts` ≈ 118 KB (el componente dominante), `packages/core/src/providers/catalog.json` ≈ 2,9 MB (214 proveedores / 7.261 modelos en el snapshot), UI con monolitos como `store.ts` (~1.027 líneas) e `index.css` (~3.597 líneas).

## 3. Lenguajes, frameworks y dependencias

| Capa | Tecnología verificada | Referencia |
|---|---|---|
| Lenguaje/toolchain | TypeScript 5.6 estricto, Bun 1.4.2, Node ≥ 20 | `package.json:29-34,58-62` |
| Escritorio | Electron 44.4.5, electron-vite 4, Vite 7 | `apps/desktop/package.json:9-13,24-34` |
| UI | SolidJS 1.9.15, xterm 6, marked 18, shiki 4.4 | `apps/desktop/package.json:19,25-31` |
| Motor de modelos | Vercel AI SDK `ai` 7 + adaptadores `@ai-sdk/*` por proveedor | `packages/core/package.json:18-36` |
| MCP | `@modelcontextprotocol/sdk` 1.32 | `packages/core/package.json:29` |
| Validación | Zod 4.6 en las herramientas builtin | `packages/core/package.json:36` |
| Persistencia | `node:sqlite` (módulo builtin de Node 22.5+/Electron), sin dependencias nativas | `packages/core/src/storage.ts:7-11,72-89` |
| Terminal | `@lydell/node-pty`, `ws` para el puente de extensión | `packages/core/package.json:28`, `apps/desktop/package.json:18` |

No hay empaquetado/instalador configurado (solo salida `out/` de electron-vite), ni CI visible, ni test runner: la verificación son scripts propios PASS/FAIL. Las normas del proyecto están en `CONTRIBUTING.md:20-36` (checks antes de PR) y `CONTRIBUTING.md:72-81` (TypeScript estricto, i18n es/en, sin secretos en commits).

## 4. Arquitectura general (síntesis; detalle en CURRENT_ARCHITECTURE.md)

- **Main de Electron** instancia `Engine` directamente en el proceso principal (sin worker), registra IPC genérico y reenvía eventos al renderer. `apps/desktop/src/main/index.ts:6,463-466,688-714`
- **Core** posee sesiones, el bucle del agente, proveedores, herramientas, permisos, MCP, navegador (vía servicio inyectado), worktrees y tareas programadas.
- **Shared** declara los tipos del contrato, aunque el contrato IPC declarado no es el que realmente se usa (ver §9.3).
- **Renderer** SolidJS con un store central que aplica los eventos del engine; la persistencia de sesiones/mensajes/config vive en el core, no en la UI.

## 5. Sistema de agentes y runtime (PROMPT 0 §B)

### 5.1 Flujo real de un turno

1. `Engine.prompt()` valida adjuntos contra el modelo y encola un `InboxItem` (`steer` por defecto, o `queue`) en el `RunState` de la sesión; `kick()` arranca `drain()` si no está corriendo. `packages/core/src/engine.ts:1034-1060,1130-1169`
2. `drain()` procesa la cola secuencialmente por sesión, con un único `AbortController`, emite `session.status` busy/idle y liquida como "interrumpidas" las tool calls que un proceso anterior dejó a medias. `packages/core/src/engine.ts:982-1005,1140-1169`
3. `runTurn()` repite `runStep()` mientras haya continuación. Cada paso: resuelve agente y modelo, evalúa compactación automática, descubre skills, calcula el set de herramientas, crea y persiste un mensaje assistant vacío, compone el system prompt, reconstruye el historial completo con `toModelMessages()` y llama a `streamText()` con `stopWhen: stepCountIs(1)`. Es decir: el SDK genera **un** paso; el engine ejecuta las herramientas y vuelve a llamar. `packages/core/src/engine.ts:1271-1378`, `packages/core/src/session/history.ts:40-204`
4. `consumeStream()` muta el mensaje assistant en curso (texto, reasoning, entradas y llamadas de herramientas), con coalescencia de deltas (40 ms texto, 120 ms inputs) y eventos `part.*` hacia la UI. Conserva `providerMetadata` para replay solo contra el mismo modelo. `packages/core/src/engine.ts:1446-1676`
5. Al cerrar el stream, el engine ejecuta las tool calls en paralelo (`Promise.allSettled`): valida con Zod, construye `ToolContext` (sesión, agente, directorio, señal de abort, `permission()`, servicios) y deja cada parte en `completed` o `error`. Los resultados no vuelven en la misma llamada: el siguiente paso reconstruye el historial y los presenta como mensajes de herramienta (recortados a 30.000 caracteres por defecto). `packages/core/src/engine.ts:1665-1792`, `packages/core/src/session/history.ts:154-204`
6. Reintentos por paso (máx. 3, sin reintentos internos del SDK): overflow de contexto → compacta y reintenta; error de esquema del historial → un reintento con historial saneado; errores transitorios (429/5xx/red/timeout) → espera `attempt × 1500` ms. `packages/core/src/engine.ts:1365-1416,2872-2902`
7. Persistencia: en SQLite el mensaje se inserta al crearse y las mutaciones se marcan `dirty` para el siguiente `save()` (debounce de 400 ms durante el streaming, inmediato al final); sin SQLite, JSON completo por sesión con escritura tmp+rename. `packages/core/src/engine.ts:957-971,1016-1028`, `packages/core/src/session/store.ts:132-215`

### 5.2 Composición del system prompt

- `composeSystemPrompt()` une dos bloques: prompt del agente (o base por modelo) + contexto inicial dinámico. `packages/core/src/agents/index.ts:485-502`, `packages/core/src/engine.ts:1339-1345`
- Si el agente no define `system`, se parte de `prompts/system.txt` y `optimizePrompt()` sustituye o añade una variante según el id del modelo (`gpt`, `gpt-astra`, `claude`, `kimi`, `trinity`, `muse` → `prompts/meta.txt` con `{{MODEL_NAME}}`). Si el agente define `system`, no hay optimización por modelo. `packages/core/src/agents/index.ts:456-483`
- `renderSystemPrompt()` sustituye el marcador de guidance de herramientas según las herramientas ofrecidas. `packages/core/src/agents/index.ts:434-458`
- El contexto inicial incluye entorno (directorio, raíz Git, plataforma, fecha), `AGENTS.md` global y de proyecto, catálogo de skills (id + descripción), instrucciones MCP, protocolo de navegador e instrucciones de Code Mode. Todo ello entra con privilegio de system prompt. `packages/core/src/engine.ts:1999-2054`
- Los prompts builtin viven en `agents/prompts/*.txt` y se compilan a `prompts.generated.ts` con `scripts/build-prompts.ts:13-28` (ejecución manual). Deriva detectada: la constante generada `patch` no se usa en la composición; varios textos aún nombran "OpenCode"/CLI pese a ser una app de escritorio OpenOrch; el agente builtin `summary` está registrado sin uso en el runtime.

### 5.3 Agentes definidos

`AgentDef` = id, descripción, `mode` (`primary|subagent|all`), `hidden`, color, `system`, `steps`, `model`, permisos y origen. `packages/core/src/agents/index.ts:109-121`

| Agente | Modo | Comportamiento verificado |
|---|---|---|
| `build` | primary | Permisos por defecto + `question: allow`; sin system propio |
| `plan` | primary | Deniega `edit` salvo en `~/.openorch/plan`, deniega `subagent` salvo `explore`, con recordatorios sintéticos de entrada/salida de modo Plan |
| `general` | subagent | Deniega `question` y `subagent` |
| `explore` | subagent | System propio de búsqueda; permisos deniegan todo y re-permiten shell/grep/glob/webfetch/websearch/read |
| `compaction`, `title`, `summary` | primary ocultos | Utilidades internas; `summary` sin uso localizado |

Registro (`AgentRegistry`): builtin → Markdown global `~/.config/opencode/agent/**` → Markdown de proyecto `.opencode/agent/**` → overrides de `config.agents` → eliminados los deshabilitados. El frontmatter Markdown se parsea con un parser propio línea a línea (sin YAML completo); los permisos no vienen del Markdown, parten del set por defecto. `resolve()` cae en silencio a `build` ante un id desconocido. `packages/core/src/agents/index.ts:270-413`

Limitación relevante: en el turno principal el modelo se resuelve **solo desde la sesión**; el `model` de un agente primario (frontmatter o config) no se aplica. Solo se usa al lanzarlo como subagente y parcialmente en title/compaction. `packages/core/src/engine.ts:1302-1303,2178-2187`

### 5.4 Subagentes

- La herramienta `subagent` exige agente/descripción/prompt, acepta `model` (`providerID/modelID#variant`), `sessionID` para continuar y `background`; pide permiso `subagent` sobre el agente. `packages/core/src/tools/agent.ts:20-80`
- `spawnSubagent()` crea una **sesión hija real** (`parentID`) en el mismo directorio que el padre, con contexto nuevo (solo el prompt dado) y título = descripción de la tarea. Profundidad limitada por `experimental.subagentDepth` (defecto 1). `packages/core/src/engine.ts:2081-2151`, `packages/core/src/config.ts:22`
- Herencia de modelo: override → modelo global de subagente (`experimental.subagentModel`) → `agent.model` → modelo del padre; después se degrada la variante a la mínima salvo inherit o variante fijada explícitamente. `packages/core/src/engine.ts:2173-2218`
- Foreground: espera con polling cada 250 ms hasta idle y devuelve el último texto assistant del hijo. Background: devuelve de inmediato y al terminar inyecta en el padre un mensaje sintético con la salida y `resume: true`. `packages/core/src/engine.ts:2153-2164,2245-2271`
- No hay timeout de espera, ni cancelación en cascada (interrumpir al padre no aborta a los hijos), ni noción de tarea/dependencia/entregable: es delegación conversacional.

### 5.5 Compactación, títulos, límites, cancelación y steering

- Compactación automática por umbral de tokens estimados (`keep` defecto 15.000), manual (`/compact`) o por overflow con ventana decreciente; genera un checkpoint estructurado (Objective/Requirements/Decisions/Work State/Next Move/Relevant Files) que sustituye al historial anterior ante el modelo, sin borrarlo del disco. `packages/core/src/engine.ts:159-183,2281-2502`, `packages/core/src/session/history.ts:82-100`
- Títulos: generación asíncrona una sola vez con el modelo pequeño y variante mínima. `packages/core/src/engine.ts:2534-2589`
- Límites: `agent.steps` (al agotarse, última llamada sin herramientas con `MAX_STEPS_PROMPT`) y techo de seguridad de 500 pasos por turno. `packages/core/src/engine.ts:93-103,1326-1358`, `packages/core/src/agents/index.ts:88-103`
- Cancelación: `interrupt()` cancela permisos y preguntas pendientes, aborta el stream y purga la cola conservando mensajes `queue`. Continuar = enviar otro prompt a la sesión persistida; no existe reanudación de un turno como operación. `packages/core/src/engine.ts:1062-1112`
- Steering: los mensajes `steer` se incorporan en las fronteras entre pasos y fuerzan continuación; los `queue` esperan al final del turno. `packages/core/src/engine.ts:1275-1293`

## 6. Prompts e instrucciones: qué conservar como concepto

El mecanismo de capas (base por modelo, sistema por agente, instrucciones de proyecto, contexto inicial dinámico, descripción de herramientas como parte del comportamiento) es sólido y coincide con lo que pide el PROMPT MASTER §2.2. También lo son: prompts como archivos de texto versionables compilados al bundle, recordatorios de modo Plan/Build como mensajes sintéticos cercanos al final del historial, y prompts-utilidad separados (título, compactación) con agente oculto y sin herramientas. Octus adopta estos conceptos con redacción propia (ADR-006, REUSE_MATRIX).

Lo que no se adopta: contenidos de proyecto/MCP con privilegio de sistema sin separación de confianza, clasificación de prompt por subcadena del id de modelo, y generación manual sin orden determinista.

## 7. Herramientas y permisos

### 7.1 Contrato de herramienta

`ToolDefinition` (nombre, descripción, esquema Zod o JSON Schema, acción de permiso, namespace, marca Code Mode, `execute(input, ctx)`) y `ToolContext` (sesión, agente, directorio, abort, progreso, `permission()`, servicios inyectados). `packages/core/src/tools/types.ts:65-175`

Inventario builtin construido por `buildTools()`: shell, read, glob, grep, webfetch siempre; `patch` (modelos GPT) o `edit`+`write`; subagent; skill si hay skills; question; namespace opencode (session rename/move, worktree create/list/remove, models); mcp y recursos MCP; 21 herramientas de navegador si hay backend; websearch si hay proveedor; herramientas MCP externas. El motor añade `execute` (Code Mode) fuera de `buildTools`. `packages/core/src/tools/index.ts:44-76`, `packages/core/src/engine.ts:1866-1900`

El filtrado en construcción solo oculta una herramienta si la **última** regla coincidente es `deny` sobre `*`; un `deny` por recurso o un `ask` no la ocultan. `packages/core/src/tools/index.ts:16-22,65-74`

### 7.2 Permisos: evaluación real en runtime

- `PermissionEngine.evaluate`: gana la última regla coincidente (wildcards, normalización Windows); sin coincidencia → `ask`. Orden: agente → config global → sesión (la interfaz lo admite, pero el engine pasa `undefined`: **los permisos por sesión no están implementados**) → reglas gestionadas por la app. `packages/core/src/permissions.ts:53-65,122-148`, `packages/core/src/engine.ts:1735,1873`
- `assert`: un `deny` configurado bloquea antes que los guardados y que la auto-aprobación; los "siempre" guardados (SQLite por directorio exacto, solo `allow`) solo resuelven un `ask`. Sin timeout de espera. `packages/core/src/permissions.ts:127-208`, `packages/core/src/storage.ts:178-202`
- Set por defecto: `allow * *` con `ask` para directorios externos, navegador y lectura de `.env*`. Es un modelo **permisivo por defecto**.

### 7.3 Brechas de autorización verificadas (útiles como requisitos negativos)

1. La autorización es *opt-in* por herramienta: el engine valida el esquema y ejecuta; el permiso solo ocurre si la herramienta llama a `ctx.permission()`. Sin puerta: `session_rename`, `session_move`, `worktree_create`, `worktree_list`, `models`, `mcp_list_resources`, `mcp_read_resource`, `browser tabs_list` y el propio `execute`. `packages/core/src/tools/opencode.ts:19-69,104-133`, `packages/core/src/tools/mcp.ts:130-152`, `packages/core/src/tools/browser.ts:261-273`
2. Plan y Explore conservan `shell` completo: su "solo lectura" es de prompt, no de runtime. `packages/core/src/agents/index.ts:172-231`
3. Code Mode (`node:vm`): su `fetch` no pasa por permiso (SSRF potencial, límite de 5 MB comprobado tras descargar) y `execute` se inyecta incluso a agentes con `deny *`. `packages/core/src/codemode.ts:200-221,272-290`, `packages/core/src/engine.ts:1894-1900`
4. Contención de rutas léxica (`isInside` sin `realpath`): un symlink dentro del proyecto permite salir del workspace y eludir `external_directory` y el `ask` de `.env`; `glob`/`grep` autorizan por patrón, no por rutas resultantes. `packages/core/src/util.ts:47-50`, `packages/core/src/tools/helpers.ts:26-43`, `packages/core/src/tools/search.ts:22-70`
5. `webfetch` sigue redirecciones sin re-autorizar el destino ni bloquear IPs privadas. `packages/core/src/tools/web.ts:12-26,79-100`
6. Shell con entorno completo heredado, timeout 120 s por defecto y, en sesiones programadas, auto-aprobación de todo `ask` con solo una denylist de comandos catastróficos. `packages/core/src/tools/shell.ts:23-62,279-439`, `packages/core/src/engine.ts:1742`
7. MCP: los servidores de proyecto habilitados se conectan al arrancar el engine; un MCP local de proyecto ejecuta comandos arbitrarios al abrir el workspace sin puerta de confianza. Tokens OAuth y token del puente de navegador en JSON en claro. `packages/core/src/engine.ts:454-461`, `packages/core/src/mcp.ts:394-447,671-727`
8. Navegador: diseño comparativamente cuidadoso (gate por origen, handoff humano ante CAPTCHA/login/pago, grupo de pestañas aislado, puente solo en `127.0.0.1` con token), pero `evaluate` ejecuta JS arbitrario en páginas con la sesión del usuario bajo el mismo gate genérico. `packages/core/src/tools/browser.ts:68-247`, `apps/desktop/src/main/browser-bridge.ts:240-353`

## 8. Modelos y API

- 11 `ProviderKind` con factories del AI SDK; `createLanguageModel(kind, modelID)` con `{apiKey, baseURL, headers}`. Sin clave se usa `apiKey=""` y el fallo llega en la primera llamada. `packages/shared/src/index.ts:10-21`, `packages/core/src/providers/index.ts:351-383`
- Catálogo híbrido: snapshot embebido (models.dev, 214 proveedores) + caché en disco + refresco live con TTL 24 h y merge no destructivo; OpenCode Console puede dictar los modelos activos de la cuenta para `opencode`/`opencode-go`. `packages/core/src/providers/models-dev.ts:69-234`, `packages/core/src/providers/console-config.ts:1-104`, `packages/core/src/engine.ts:439-533`
- Variantes de razonamiento derivadas del catálogo (`toggle|effort|budget_tokens`) y traducidas por proveedor en `variantOptions()` (thinking budgets de Anthropic, `reasoningEffort` OpenAI/Groq, thinking de Google/DeepSeek y overlays por familia en compatibles). Huecos: xAI/Mistral/Cerebras/Together/OpenRouter no traducen la variante. `packages/core/src/providers/index.ts:103-122,391-479`
- Selección auxiliar: `pickSmallModel` (títulos/compactación; puede caer a `models[0]`) y `pickCheapModel` (defecto; prefiere gratuitos). Preferencias recientes/por directorio en `model.json`. `packages/core/src/providers/index.ts:312-345`, `packages/core/src/model-prefs.ts:9-66`
- **Meta/Muse en OpenOrch hoy:** no hay adaptador Meta. En el catálogo, `meta` es un proveedor `kind:"openai"` con base `https://api.meta.ai/v1` y env `META_MODEL_API_KEY`, 6 modelos Muse (incl. `muse-spark-1.3` y `muse-wonder-1.0`); se instancia con el factory OpenAI del AI SDK y el único trato especial es el prompt `meta.txt` cuando el id contiene `muse`. Es decir: funciona "por compatibilidad OpenAI", sin superficie Responses ni replay de razonamiento cifrado. `packages/core/src/providers/index.ts:356`, `packages/core/src/agents/index.ts:479-482`
- **OpenCode Go en OpenOrch hoy:** proveedor `opencode-go`, `kind:"openai-compatible"` forzado, base `https://opencode.ai/inference/go/openai/v1`, env `OPENCODE_API_KEY` (compartida con Zen), 34 modelos en el snapshot, lista visible dictada por la cuenta Console si está conectada. `packages/core/src/providers/models-dev.ts:84-87`, `packages/core/src/providers/index.ts:42-88`
- Credenciales: en texto claro en `<dataDir>/config.json` (con fallback a variables de entorno del catálogo solo para proveedores de catálogo); `config.get` devuelve el `Config` completo al renderer. Sin keychain ni cifrado en todo el repo. `packages/core/src/config.ts:26-79`, `packages/shared/src/index.ts:401-409,632`, `apps/desktop/src/main/index.ts:23-26`

## 9. Persistencia, sesiones, eventos e interfaz

### 9.1 Persistencia y sesiones

SQLite vía `node:sqlite` (`openorch.db`, WAL, `busy_timeout=5000`) con tablas `session`, `message`, `permission`, `kv` (sin uso), `schedule_task`, `schedule_run`; migración automática desde el formato JSON anterior y fallback JSON funcional si el módulo no existe. `packages/core/src/storage.ts:27-161`

`SessionStore` cachea en memoria, inserta mensajes al crearse en SQLite, marca mutaciones `dirty` y reescribe completo solo tras compactación. Debilidades: sin transacciones en reescrituras multi-fila, sin claves foráneas reales (borrado en cascada manual), mensajes como blob JSON no consultable y set `dirty` global compartido entre sesiones (un rewrite puede descartar marcas de otra sesión). `packages/core/src/session/store.ts:17-226`

La sesión (`SessionInfo`) guarda directorio, agente, modelo y `parentID` (subagentes = sesiones hijas), sin permisos propios ni noción de run/task. `packages/shared/src/index.ts:108-189`

### 9.2 Memoria

No existe Memory Service. Lo único parecido: historial por sesión, checkpoints de compactación, preferencias de modelo, instrucciones `AGENTS.md` descubiertas y reglas de permiso guardadas. No hay memoria de proyecto/run/tarea diferenciada ni promoción gobernada de hallazgos a reglas permanentes (objetivo §8 del PROMPT MASTER): en Octus es un componente **Nuevo**.

### 9.3 Eventos e IPC

`EngineEvent` declara 22 variantes (sesión, mensaje, parte, permiso, pregunta, schedule, config/agentes/proveedores/MCP, error) y `EngineIPC` declara la superficie petición/respuesta. `packages/shared/src/index.ts:595-682`

Verificado: `EngineIPC` **no se usa** como contrato efectivo. El preload expone un `invoke(method: string, ...)` genérico, el renderer y el main hacen casts manuales y el main registra canales no declarados (`clipboard.*`, `sessions.watch/busy`, `mcp.*`, `browser.*`, `schedule.*`, `app.paths`, …). Hay deriva real de firmas (p. ej. `files.pick`). `apps/desktop/src/preload/index.ts:5-72`, `apps/desktop/src/renderer/src/api.ts:27-167`, `apps/desktop/src/main/index.ts:463-646`

El flujo de eventos sí está cuidado en rendimiento: el main filtra partes de sesiones no visibles, el renderer mantiene como máximo 6 transcripciones en memoria y recarga las marcadas obsoletas. `apps/desktop/src/main/index.ts:154-183,691-697`, `apps/desktop/src/renderer/src/store.ts:279-341,581-715`

### 9.4 Escritorio y UI

Electron con `contextIsolation: true`, `nodeIntegration: false`, `webviewTag: true`, **`sandbox: false`**; Engine ejecutándose en el proceso main; instancia única; modo gráfico seguro ante GPUs legacy o arranque sucio previo; tray y login item gobernados por tareas en segundo plano. `apps/desktop/src/main/index.ts:63-141,205-270,343-408,652-662,688-752`

Riesgo principal de la capa: el Markdown se renderiza con `innerHTML` tras un sanitizador por expresiones regulares propio que no cubre todos los vectores (URLs `javascript:`/`data:`, SVG, atributos sin comillas); combinado con `sandbox:false` y un IPC genérico sin validación de emisor, un XSS en el renderer alcanzaría toda la superficie del engine. `apps/desktop/src/renderer/src/components/Markdown.tsx:7-13,88,121`, `apps/desktop/src/main/index.ts:463-466`

Componentes y roles completos en CURRENT_ARCHITECTURE.md §7. La UI está en español/inglés vía `i18n.ts`, pero el main (tray, notificaciones) tiene textos fijos en español. `apps/desktop/src/main/index.ts:211-224,296-320`

### 9.5 Tareas programadas (no es un Scheduler multiagente)

`schedule.ts` es un planificador local de prompts: un único timer de 30 s, una ejecución a la vez, sesiones normales de un solo agente `build`, repeticiones `once|daily|weekdays|weekly|monthly|hourly`, gracia de 24 h para ejecuciones perdidas. No tiene DAG, paralelismo ni coordinación entre agentes. Su nombre no debe migrar a Octus como "Scheduler": en Octus ese término es el distribuidor de tareas del DAG (ADR-007). `packages/core/src/schedule.ts:31-33,311-727`

### 9.6 Worktrees hoy

`WorktreeManager` con `gitRoot/list/create/remove` vía `execFile` (sin shell): base configurable o `<root>/.openorch/worktrees`, rama = slug del nombre desde el `HEAD` actual (si la rama existe se reutiliza), exclusión en `.git/info/exclude`. `remove` exige worktree registrado y no actual, pero no limita a la base gestionada ni borra la rama. **No registra commit base/producido, no aplica scope de escritura, no integra**: integrar exige mover la sesión y usar shell. `packages/core/src/worktree.ts:21-137`, `packages/core/src/engine.ts:1979-1997`

## 10. Hallazgos priorizados (defectos a no reproducir)

Prioridad alta (seguridad/corrección; requisitos negativos en ADR-015):

1. Perfiles "solo lectura" con shell completo (contención por prompt). §7.3-2
2. MCP de proyecto auto-ejecutable al abrir el workspace. §7.3-7
3. Herramientas sin puerta de runtime y `fetch` de Code Mode sin permiso. §7.3-1, §7.3-3
4. Contención de rutas léxica sin resolver symlinks. §7.3-4
5. Credenciales en texto claro, expuestas íntegras al renderer; tokens OAuth/puente en claro. §8, §7.3-7
6. Compactación: el tramo "reciente" reservado puede quedar fuera del contexto para siempre (el checkpoint se anexa al final y la reconstrucción corta en el checkpoint). `packages/core/src/engine.ts:2372-2405,2485-2491`, `packages/core/src/session/history.ts:84-100`
7. Reintentos que reutilizan el mismo mensaje assistant sin limpiar partes: texto duplicado y posible doble ejecución de herramientas con efectos. `packages/core/src/engine.ts:1365-1415,1510-1674`
8. Subagentes sin timeout ni cancelación en cascada; esperas por polling indefinido; títulos/compactación sin señal de aborto. §5.4, `packages/core/src/engine.ts:2267-2271,2504-2528`
9. `SessionStore.dirty` global entre sesiones concurrentes. `packages/core/src/session/store.ts:18-20,194-214`
10. Cadena XSS→IPC en el renderer (Markdown + `innerHTML`, `sandbox:false`, invoke genérico). §9.4

Prioridad media:

11. Modelo del agente primario ignorado; fallbacks silenciosos de `resolve()` a `build`. §5.3
12. Tool calls del mismo paso en paralelo sin serialización ni detección de conflictos sobre el mismo archivo. `packages/core/src/engine.ts:1668-1674`
13. Contenido no confiable (proyecto, skills, MCP) concatenado en el system prompt sin separación de confianza. §5.2
14. Estimación de compactación que ignora system prompt y esquemas de herramientas. `packages/core/src/engine.ts:2332-2370`
15. Contrato IPC declarado pero no usado; deriva de canales y firmas. §9.3
16. Catálogo remoto sin firma ni validación fuerte: una fuente comprometida podría redefinir bases/env de proveedores; snapshot embebido de 2,9 MB. §8
17. `isConfigured` y proveedores custom marcados configurados sin credencial real; fallo diferido a mitad de sesión. `packages/core/src/providers/index.ts:199-242,352`
18. En background, cualquier error histórico de un hijo marca el resultado como error; en foreground, la "salida" puede ser un texto anterior al último paso de herramientas. `packages/core/src/engine.ts:2245-2261`

## 11. Meta Model API: verificación oficial (resumen)

Consulta realizada el 2026-10-30 sobre la documentación pública en `https://dev.meta.ai/docs/`. El detalle normativo que regirá el adaptador está en TARGET_ARCHITECTURE.md §8 y DECISIONS.md (ADR-004, ADR-005). Hechos verificados:

- **Base y auth:** `https://api.meta.ai/v1`; token Bearer con la clave de Model API (variable convencional `MODEL_API_KEY`; las claves empiezan por `LLM_`). Ningún SDK lee `MODEL_API_KEY` por sí mismo: hay que pasarlo explícitamente. (Overview, Authentication, SDKs)
- **Modelos:** `muse-wonder-1.0` (preview; solo Standard) y `muse-spark-1.3` (recomendado; también `-contributor`), contexto 1.048.576 tokens, entrada texto/imagen/vídeo/audio/PDF, salida texto. Wonder y Spark aceptan las mismas peticiones: cambiar de modelo es cambiar el ID. (Models)
- **Tres superficies, mismo precio por token:** Responses `POST /v1/responses` (recomendada para agentes; única con replay de razonamiento entre turnos), Chat Completions `POST /v1/chat/completions` (sin continuidad de razonamiento para claves externas) y Messages `POST /v1/messages` (formato Anthropic, base host sin `/v1`, stateless). (Choosing an API, Responses, Chat Completions, Messages)
- **Reasoning:** `reasoning.effort` (Responses) o `reasoning_effort` (Chat Completions) con `minimal|low|medium|high|xhigh|max`; `none` devuelve HTTP 400 en Wonder/Spark; `max` solo en `muse-wonder-1.0` y `muse-spark-1.3` (no en `-contributor`). La cadena de razonamiento cruda nunca se expone: solo resúmenes opcionales (`reasoning.summary`) y, en Responses, contenido cifrado para replay (`include: ["reasoning.encrypted_content"]`, con `store:false` recomendado para agentes stateless; incompatible con `previous_response_id` en la misma petición). Los tokens de razonamiento cuentan como salida. (Reasoning, Responses)
- **Tool calling:** herramientas `function` (Responses: campos planos; Chat Completions: anidados bajo `function`) y `custom` (solo Responses). Nombres `^[a-zA-Z0-9_.-]+$` con como máximo un punto; `call_id` de 1–64 caracteres; `tool_choice` solo admite `"auto"`; `parallel_tool_calls` por defecto true; `max_tool_calls` solo limita herramientas builtin del servidor. Los argumentos generados **no** están garantizados contra el esquema: hay que validarlos siempre en cliente. Streaming de argumentos por eventos tipados en ambas superficies. (Tool calling)
- **Streaming Responses:** eventos `response.*` tipados; el terminal es `response.completed`/`failed`/`incomplete` o un evento `error`; con `store=true` la respuesta persiste aunque el cliente se desconecte; existe modo `background:true` (tope de cuerpo 1 MiB, 600 envíos/min/equipo) con cancelación y recuperación. (Responses, Error handling)
- **Errores:** envoltorio `{error:{message,type,param,code}}`; 400/401/402/403/404/413/429/500/503/504 con códigos máquina conocidos (`invalid_api_key`, `model_not_found`, `rate_limit_exceeded`, `service_overloaded`, `backend_unavailable`, `server_shutting_down`, `gateway_timeout`, `payload_too_large`, `content_policy_violation`). Reintentables: 429 y 5xx transitorios honrando `Retry-After`; no reintentar 400/401/402/403/404/413 sin corregir. Un 404 a ruta desconocida puede venir **sin cuerpo**. (Error handling)
- **Costes y límites (pay-as-you-go, Standard):** Wonder $4,00 entrada / $20,00 salida por 1M (caché $0,20); Spark $1,25 / $4,25 por 1M (caché $0,15); Contributor abarata Spark a cambio de permitir usar el contenido para entrenamiento (no disponible para Wonder). Límites por equipo: 3.000 RPM y 4.000.000 TPM en `muse-wonder-1.0` y `muse-spark-1.3`. Cabeceras `x-ratelimit-*` en respuestas. (Pricing and rate limits)
- **SDKs:** no hay SDK propio obligatorio: OpenAI SDK (Responses/Chat Completions), Anthropic SDK (Messages) o clientes OpenAI-compatibles (p. ej. Vercel AI SDK citado expresamente). Para agentes tipo OpenCode, la propia guía de Meta recomienda el adaptador de Responses (`@ai-sdk/openai`) precisamente por el replay cifrado de razonamiento, con salida `output 131072` de ejemplo y modalidades declaradas. (SDKs, Coding agents, Quickstart)
- **Discrepancia documental detectada:** la página de Responses lista los valores aceptados de `reasoning.effort` sin `max`, mientras Models y Reasoning afirman que `max` está soportado en `muse-wonder-1.0` y `muse-spark-1.3`. Se registra como punto a confirmar con prueba real en la Etapa 1 (no se resuelve por suposición). (Responses §"Reasoning effort" vs. Reasoning, Models)

Nada de lo anterior procede del catálogo de OpenOrch: todo se verificó contra la documentación oficial, como exige el PROMPT MASTER §2.4.

## 12. Línea base ejecutada (2026-10-30, OpenOrch sin modificar)

| Comando | Resultado |
|---|---|
| `bun run typecheck` (shared → core → desktop) | OK (exit 0) |
| `bun run check:core` | **144/144** checks superados |
| `bun run check:schedule` | **12/12** checks superados |
| `bun run check:bridge` | **13/13** checks superados |
| `bun run check:readmes` | OK (22 READMEs, 388 comprobaciones) |
| `bun run e2e` | No ejecutado (Electron, instancia única, Windows-only, siembra `.data/`) — decisión registrada en el plan del Prompt 0 |
| `check:zen`, `check:search`, `check:extension` | No usados como puerta: red externa / Edge real con ventana |

Tras las comprobaciones, `git status --porcelain` en OpenOrch: limpio. Las suites de checks escriben solo en `.data/` (ignorado).

## 13. Lo que OpenOrch no tiene frente al objetivo (mapa rápido)

| Objetivo PROMPT MASTER | Estado en OpenOrch |
|---|---|
| Runtime de agente con streaming, herramientas y cancelación | Existe y funciona (§5) |
| Plan/Build como perfiles de un único coordinador | Parcial: dos agentes primarios seleccionables; Plan no es "solo lectura" en runtime |
| Subagentes Explorer/Researcher/Implementer/Reviewer | Parcial: explore/general conversacionales; sin Researcher ni Reviewer/QA; Implementer sin worktree propio gobernado |
| Task Planner / DAG / Scheduler multiagente | **No existe** |
| Múltiples instancias por perfil con concurrencia gobernada | Parcial: sesiones hijas en background sin scheduler, límites ni control de conflictos |
| Worktrees por trabajador con commit base/producido y scope | Solo create/list/remove básico (§9.6) |
| Integración en rama intermedia, validación, preview, aprobación por SHA, promoción segura | **No existe** |
| Memoria diferenciada proyecto/sesión/run/tarea | **No existe** |
| Proveedor Meta verificado (Responses, reasoning, Spark/Wonder) | Solo compatibilidad OpenAI genérica (§8) |
| Permisos en runtime | Existe con brechas (§7) |
| Persistencia local de sesiones | Existe (SQLite + fallback JSON) |
| UI de escritorio con eventos | Existe, con riesgos §9.4 |

La matriz de decisión componente a componente está en `REUSE_MATRIX.md`; la arquitectura actual detallada, en `CURRENT_ARCHITECTURE.md`; el diseño de Octus, en `TARGET_ARCHITECTURE.md`.

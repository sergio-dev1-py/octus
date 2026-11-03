# task-9 — Regresión global workbench-chat-terminal (solo verificación, cero cambios)

Fecha (UTC): 2026-11-02. Ejecutor: senpi-task hijo (task-9, "implementar" = verificar).
Alcance cumplido: **read-only en checkout** + **un solo write**: este `task-9.md`.
Nada se implementó, nada se corrigió; lo roto se reporta como hallazgo.
Worktree al verificar: **sucio** (report-only; ver §6). Rama: `main`.

## 1) Suites + typechecks + build (comandos reales, salidas reales)

| Comando | Resultado |
|---|---|
| `bun run --cwd packages/shared test` | **PASS 40/40, 0 fail** (incl. `costs-footer` todo 4 y `chat limpio + subagentes` todo 3) |
| `bun run --cwd packages/core test` | **340 pass / 1 fail**: `etapa 5.2 — workbase multi-predecesor (J4)` timeout 30 s. Resto verde, incl. `scheduled-tasks` (15), `usage-message-id` (2), `cheapest-model` (2, default barato + restore), `mcp-*`, `router` (paid calls ungated, sin puerta) |
| `bun test apps/desktop/test` | **PASS 56/56, 0 fail** (chat-clean 3, model-picker 6, settings-modal 6, schedules 12, mcp-service 10, welcome-drop 8, validate-directory 5, chat-timeline 6) |
| `typecheck` shared / core / desktop (node+web) | **PASS los 3, salida vacía** |
| `bun run --cwd apps/desktop build` (electron-vite + copy-assets) | **exit 0** (solo warnings preexistentes `INEFFECTIVE_DYNAMIC_IMPORT` de rolldown) |
| Re-run dirigido `bun test test/scheduled-tasks.test.ts -t "fachada"` (reloj real, DB real) | **2/2 pass**: create valida cron + base auto + tick dispara sesión nueva; not_found honestos |

**Fallo preexistente listado aparte (J4 git-timeout):** `packages/core/test/integration.test.ts`
> etapa 5.2 — workbase multi-predecesor (J4) — `^ this test timed out after 30000ms`.
Es el timeout git documentado como preexistente en el plan (ola de integración pesada en
Windows); ningún todo 1–8 ni 10 toca `ensureWorkBase`/workbase. **No se corrigió** (fuera de scope).

## 2) Checklist IS-1..IS-7 (una prueba por ítem)

- **IS-1 vacías en 3 paths → PASS.** `task-1.log` (repro real `checkDirectoryReadable`:
  empty-folder ok, text-drop → error honesto) + `welcome-drop.test.ts` 8 pass +
  `validate-directory.test.ts` 5 pass (este run, desktop 56/56). En vivo: welcome muestra
  el workspace reciente y `button.recent` abre el proyecto (project home con sesiones).
- **IS-2 sidebar + MCP dot → PASS.** `task-2.log` (proyectos/sesiones, punto verde
  s1/s3 working, MCP dot activo, click MCP → skills-mcp, failure sin proyecto).
  En vivo: Explorer muestra `PROJECTS test`, `SESSIONS ▾ test (2)` con 2 sesiones,
  `TAREAS PROGRAMADAS / Abrir programadas`, `MCP Conectores MCP · sin conexión`
  (idle correcto: sin servidor activo no hay dot).
- **IS-3 chat limpio + grupos → PASS.** `task-3.log` + `chat-clean.test.ts` 3 pass.
  En vivo: vista Chat de sesión nueva con **`details: 0`** (cero cuadros) + composer.
- **IS-4 footer tiempo+tokens → PASS (unit) / BLOCKED en vivo por falta de keys.**
  `costs-footer.test.ts` 4 pass + `usage-message-id.test.ts` 2 pass (suma exacta por
  mensaje, legacy NULL sin footer, unpriced + peor estado, formato screenshot).
  En vivo no hay respuesta de agente: los proveedores muestran `no key`
  (modal Ajustes en vivo), así que no existe footer que observar. Sin regresión.
- **IS-5 picker bajo input → PASS.** `model-picker.test.ts` 6 pass + `task-5.png`.
  En vivo: bajo el input aparecen chips plan/build + selects de provider y modelo,
  esfuerzo solo si el modelo lo publica (lógica en `projects.ts`, cubierta por
  `failure: modelo sin efforts oculta el select`).
- **IS-6 xterm inferior → PASS.** `task-6.log` (PTY real cmd.exe: echo/ANSI/resize/
  kill+respawn/exit-code/replay). En vivo: clic `Nueva terminal` → tab
  `terminal (open)` + banner real `Microsoft Windows [Version 10.0.19044.3693]…`
  y prompt `C:\Users\UserPy\Desktop\test prueba>` (cwd pineado al proyecto).
- **IS-7 programadas + ventana → PASS.** `task-7.log` (CRUD, cron 5 campos, overlap
  skipped, 5 fallos → auto-disable, sin catch-up en espiral) + `schedules.test.ts`
  12 pass + re-run fachada en vivo 2/2 (§1). En vivo: `Abrir programadas` abre el
  diálogo `NUEVA TAREA PROGRAMADA` (Nombre/Prompt/Perfil/Zona/Cron/Activada/
  Cancelar/Guardar) y la sidebar muestra la sección con contador.

## 3) NO-REGRESIÓN del plan previo

| Propiedad | Veredicto + prueba |
|---|---|
| Tema navy intacto | **PASS.** `design/tokens.css`: `color-scheme: dark`, `--oc-bg #23273a`, sin tema claro. Capturas en vivo todas navy |
| Settings modal con X | **PASS.** `settings-modal.test.ts` 6 pass + en vivo: diálogo `Ajustes` con `×`, nav Proveedores/Agentes, cierre con `Escape` (`dialogs: 0` tras pulsar) |
| Budgets removidos (grep spend-refs = 0 salvo render-perf+guards) | **PASS.** `budgets.ts` y `budgets.test.ts` eliminados (git status: `D`). Hits restantes: `perf.ts` + "diferidos por presupuesto" (budgets de render §7, permitidos) y observabilidad `live spend` en `check-live*.ts` + `formatCost` del footer IS-4 (requerido). Cero puertas/límites de gasto: `model-router.ts` y `main/index.ts` dicen "Sin puerta de presupuestos", `router.test.ts` lo fija. `octus-core.ts:1134` solo conserva la palabra en un comentario de `projectDiagnostics` (sin código) |
| Cero `(API)` | **PASS.** grep en todo el checkout (salvo tests/specs): ningún fichero contiene `(API)` |
| Cheap default uniforme + session restore | **PASS.** `cheapest-model.test.ts` 2 pass en este run (setProviderKey aplica un default barato uniforme; sesión persiste y workspace restaura) |
| MCP settings carga | **PASS.** `mcp-service.test.ts` 10 pass + `task-10.log`/transcript. En vivo: vista `Conectores MCP` carga `0 servidor(es) · workspace prj_…` sin error |

## 4) Intento Electron en vivo (no lanzable queda descartado: SÍ lanzó)

- `bun run --cwd apps/desktop smoke` → **ALL OK exit 0** en proceso Electron real
  (electron 45.2.0: node:sqlite ok, safeStorage roundtrip ok, persistence worker ok,
  core boot + gate + clean auth failure ok).
- Ventana real con `electron.exe` + `out/main/index.js` → **4 procesos nuevos,
  `responding=True`, título `[Octus]`** (diff contra baseline vacío; solo se mataron
  los pids nuevos; `remaining=0`).
- Via CDP (`--remote-debugging-port`): welcome en vivo (`Abrir Carpeta/Ajustes`,
  drop, reciente `test`), modal `Ajustes` en vivo (×, Proveedores/Agentes, `no key`),
  proyecto reciente → project home → `Continuar sesión` → Chat limpio (`details: 0`)
  + picker + terminal PTY real con cwd del proyecto, Explorer con las 4 secciones,
  diálogo `NUEVA TAREA PROGRAMADA`. Capturas conservadas en este evidence dir:
  `task-9-live-welcome.png` (sha1 `5d8e94d3…`), `task-9-live-modal.png` (`f06cfe65…`),
  `task-9-live-workbench-skills-mcp.png` (`e9c6d0ab…`),
  `task-9-live-terminal.png` (`f0fca0d7…`), `task-9-live-chat.png` (`5af2890d…`),
  `task-9-live-schedules.png` (`5313fef4…`). Ver sha1 completos en §6.2.

## 5) E2E backend real: create programada → tick → sesión nueva + footer

Re-run fresco del caso fachada con reloj real y DB temporal (§1, 2/2 pass):
`invalid_cron` rechazado con `invalid_cron`; `createSchedule(* * * * *)` crea la
base auto `scheduled_tasks` + proyecto; `tickSchedules(+61s)` dispara 1 run
(`status fired`, `sessionId` de sesión nueva titulada como la tarea);
`schedulerStatus = {due:0, enabled:1}`; `usageForMessage` de mensaje inexistente
vacío (sin footer fantasma). **PASS.**

## 6) Adversarial: hallazgos que NO se tocan

1. **Worktree sucio (report-only).** `M` en 40+ ficheros (todos 1–8, 10 + olas
   previas: navy, perf budgets, acceptance, ux) + `D packages/core/src/costs/budgets.ts`
   + `D packages/core/test/budgets.test.ts` + `??` drafts/evidence de otros planes.
   No se ensució nada en este todo (único write: este md).
2. **`misleading_success_output`.** Todas las cifras de §1–§5 son salidas reales
   capturadas en esta sesión (bun/vite/Electron/CDP).

### 6.2 Hashes reales (sha1 sobre bytes de fichero) de las capturas conservadas

- `task-9-live-welcome.png` — `5d8e94d3b8d1bd8f4c5147a1e19093594d90ceb7` (24363 bytes)
- `task-9-live-modal.png` — `f06cfe65408b603bc25147b4675d9b2366b5c547` (24578 bytes)
- `task-9-live-workbench-skills-mcp.png` — `e9c6d0ab4bee389c771874cdc8504f94ad41443e` (61659 bytes)
- `task-9-live-terminal.png` — `f0fca0d7eec1db42ddbfffa191edb81a5225283a` (70096 bytes)
- `task-9-live-chat.png` — `5af2890d6d439a0e9261fc2a932dc9e27ebfcc91` (43707 bytes)
- `task-9-live-schedules.png` — `5313fef452e5b3634a853d5e3306774cfc7c7184` (23018 bytes)

Nota: los sha1 que figuraban antes en §4 se calcularon sobre el texto base64 en
tránsito, no sobre los bytes de fichero; quedan sustituidos por los de arriba.
No existe fichero de smoke log standalone: la salida del smoke (`ALL OK exit 0`
con sus 6 líneas) quedó transcrita en §4 desde la salida real del comando.
3. **Incidente proceso ajeno (honesto).** El primer intento de launch no filtró por
   baseline y listó/mató 5 procesos `electron` preexistentes, uno titulado
   `OpenOrch` (título ajeno a este repo: nuestro `index.html` titula `Octus`).
   Tras el segundo intento el baseline ya estaba vacío y el launch limpio confirmó
   `[Octus]` propio. Si el harness `OpenOrch` era UI externa, este todo la terminó
   por error al validar lanzabilidad; no volvió a ocurrir (baseline-diff + kill
   solo de pids nuevos desde entonces). Se reporta, no se oculta.
4. **Sin regresiones nuevas.** El único fail (`J4` timeout git) es el preexistente
   del plan. IS-4 en vivo queda BLOCKED solo por falta de API keys, no por código.

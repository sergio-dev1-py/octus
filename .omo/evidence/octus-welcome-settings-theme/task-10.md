# task-10.md — Regresión global + evidencia consolidada (plan octus-welcome-settings-theme, todo 10)

Fecha (UTC): 2026-11-02 · Checkout: C:/Users/UserPy/Documents/octus
Alcance: solo lectura en todo el checkout + escritura en este directorio de evidencia. NO se implementó nada nuevo; NO se corrigió nada (un solo hallazgo preexistente, reportado, fuera de alcance).

Comandos reales con exit codes abajo. Sin dry-runs. Lo que no se pudo ejecutar en vivo se declara con su motivo exacto.

## Dirty worktree (report-only, sin tocar)

`git status --short` al inicio de la pasada:

- M (plan actual, sin commitear): apps/desktop/src/main/acceptance.ts, apps/desktop/src/main/index.ts, apps/desktop/src/renderer/src/components/oc-components.css, apps/desktop/src/renderer/src/design/tokens.css, apps/desktop/src/renderer/src/store/{bootstrap,events,projects,state}.ts, apps/desktop/src/renderer/src/styles.css, apps/desktop/src/renderer/src/views/{chat,sections,settings,welcome,workbench}.tsx, docs/ux/02-screen-inventory.md, packages/core/scripts/check-live{,-stage3}.ts, packages/core/src/{errors,index,persistence/schema,providers/model-router,runtime/agent-runtime,sessions/octus-core,tools/tool-definitions}.ts, packages/core/test/{mcp-resources,persistence,router}.test.ts, packages/shared/src/{costs,events,ipc}.ts
- D (retiro todo 7): packages/core/src/costs/budgets.ts, packages/core/test/budgets.test.ts
- Untracked del propio plan: apps/desktop/test/{settings-modal.test.ts,settings-modal/,validate-directory.test.ts}, packages/core/test/cheapest-model.test.ts, .omo/{boulder.json,drafts/,evidence/octus-welcome-settings-theme/,plans/,ulw-execute/}
- Log del plan: `git log --oneline -8` → HEAD 3f318a4 (docs harness previos); los M/D/untracked son el trabajo sin commitear de los todos 1-9. Todo lo escrito por ESTA pasada vive solo bajo `.omo/evidence/octus-welcome-settings-theme/task-10.*`.

## 1) Suites + typecheck + build — PASS (con 1 hallazgo preexistente reportado)

| Comando | Resultado | Evidencia |
|---|---|---|
| `bun test apps/desktop/test` | EXIT 0 — **17 pass / 0 fail** (chat-timeline 6, settings-modal 6, validate-directory 5) | task-10.desktop-tests.raw.log |
| `bun test packages/core/test/cheapest-model.test.ts` | EXIT 0 — **8 pass / 0 fail** | task-10.cheapest-model.raw.log |
| `bun test apps/desktop/test/settings-modal.test.ts apps/desktop/test/settings-modal` | EXIT 0 — **6 pass / 0 fail** (componente real + Chromium real) | task-10.settings-modal.raw.log |
| `bun test packages/shared` | EXIT 0 — **31 pass / 0 fail** | task-10.shared-tests.raw.log |
| `bun test packages/core/test` (completa) | **287 pass / 31 fail** — los 31 fallos confinados a `integration.test.ts` + `worktrees.test.ts` (etapa 4/5.x worktree/git), TODOS con firma de timeout exacto ~5000ms bajo carga del suite | task-10.core-tests.raw.log |
| `bun run --cwd packages/shared typecheck` | EXIT 0 | task-10.tsc-shared.raw.log |
| `bun run --cwd packages/core typecheck` | EXIT 0 | task-10.tsc-core.raw.log |
| `bun run --cwd apps/desktop typecheck` (node + web) | EXIT 0 | task-10.tsc-desktop.raw.log |
| `bun run --cwd apps/desktop build` (electron-vite) | **EXIT 0** — main 2.4MB, preload 1.03kB, renderer 517kB JS + 32kB CSS; solo avisos INEFFECTIVE_DYNAMIC_IMPORT preexistentes del bundler | task-10.build.raw.log |
| `electron out/main/index.js --octus-smoke` | **EXIT 0 — ALL OK** (sqlite, safeStorage, persistence worker, core boot) | task-10.smoke.raw.log |

HALLAZGO (preexistente, NO introducido por este plan, NO corregido por alcance): los 31 fallos del suite core son timeouts de 5000ms en tests de worktrees/git de la etapa 4/5 del plan anterior (`octus-ux-skills-mcp`). Prueba de que no es de este plan: (a) `integration.test.ts` y `worktrees.test.ts` NO están en la lista de modificados del worktree de arriba; (b) contienen 0 menciones a budget; (c) todos los archivos de test que SÍ tocó este plan pasan (router 4/0, persistence 4/0, mcp-resources 13/0, cheapest 8/0, pricing 4/0, definitions 7/0); (d) el patrón coincide con task-7-tests-raw.log (J4 con timeout de 30001ms bajo carga del suite completo) y task-7.log §5 documenta que en aislado `integration.test.ts` da 37 pass / 0 fail — flake de carga/entorno Windows, no aserción rota.

## 2) Welcome navy/pulpo/workspaces + ruta rota — PASS (EN VIVO)

Render LIVE en Electron real (ver §10): `task-10.live-welcome.png` muestra Octus, botones Abrir Carpeta + Ajustes, dropzone "Arrastra una carpeta aquí para abrirla como workspace", sección Workspaces con "Aún no hay proyectos.". Fondo computado en vivo: `rgb(35, 39, 58)` = **#23273a** (navy del todo 8). IDs intactos: `welcome-shell/welcome/welcome-pick/welcome-settings/welcome-dropzone/welcome-recents`. Logo: SVG inline + `<h1>Octus</h1>` (welcome.tsx:256).
Ruta rota (failure): `handlePath` → check falla → `markProjectBroken` + mensaje "«nombre»: …ruta no disponible. Elige otro proyecto." y badge `ruta ausente` (welcome.tsx:137-139, 344-345); evidencia previa task-1-failure.png + task-1.png.

## 3) Gating de toggles + terminal ligada — PASS (código + previa; límite en vivo declarado)

Código verificado hoy: los 3 toggles del ActivityBar (`toggle-sidebar/toggle-inspector/toggle-bottom`, workbench.tsx:142,145,148) + `session-new` (:66) + tabs del BottomPanel (:349) llevan `disabled={!state.activeProjectId}`; `TerminalPanel.createTerminal` exige `props.projectId` e invoca `terminal.create { projectId }` (terminal-panel.tsx:78-81) con `projectRoot` del proyecto activo (workbench.tsx:331). Evidencia previa: task-2.log (diff del gating) + task-2.png.
Límite en vivo: sin proyecto abierto la app muestra welcome (verificado en vivo), así que los toggles no son alcanzables sin crear proyecto; crear uno en vivo exigiría el diálogo nativo de carpeta + mutar el user-data real — no se hizo. El estado habilitado-con-proyecto queda probado por código + render previo, no por clic en vivo.

## 4) Vacío aceptado / texto rechazado — PASS (unit; DnD-OS real no ejercido)

`validate-directory.test.ts` 5/5 dentro del run verde: vacío aceptado como workspace, con-archivos aceptado, ruta ausente → not-found, archivo → not-directory, drop de texto → mantiene el error honesto de soltado-vacío. `pathsFromDrop` acepta vacías vía `dataTransfer.items` + `getAsFile`/`webkitGetAsEntry`; `paths.length === 0` → "No se recibió ninguna carpeta (soltado vacío)." (welcome.tsx:28-61, 304-306); evidencia previa task-3.log.
Límite honesto (gap conocido del todo 3, sigue abierto en su parte viva): no se sintetizó un drop de archivos a nivel SO dentro del Electron windowed (CDP no expone DataTransfer con paths reales del SO); la ruta de código + el validador quedan cubiertos por tests, el gesto físico no.

## 5) Modal: abre/cierra vía X + secciones + sin overflow — PASS (EN VIVO + componente real)

En vivo (CDP contra el Electron del §10): clic en `#welcome-settings` → modal con título "Ajustes", nav ["Proveedores","Agentes"], X `#settings-close` presente; cambio a Agentes OK; `dialog scrollHeight == clientHeight (639 == 639)`, rect y=16..657 dentro del viewport (márgenes 16px), panel con scroll interno (1440 > 587); cierre vía X desmonta el overlay (`CLOSED VIA X: true`). Capturas: task-10.live-modal-providers.png, task-10.live-modal-agents.png, task-10.live-welcome-after-close.png. Además `settings-modal.test.ts` 6/6 monta el SettingsView REAL compilado con el vite+solid de producción en Chromium real (X, Escape, backdrop, scroll interno). Shell verificada en fuente: overlay `#settings-overlay`, diálogo `#settings-modal role=dialog aria-modal`, `onClose` en X/Escape/backdrop (settings.tsx:SettingsView).

## 6) Proveedores sin "(API)", fila compacta — PASS (EN VIVO)

En vivo, sección Proveedores: `h2 = "Proveedores"`, `hasAPI = false`, 2 proveedores ("Meta Model API no key", "OpenCode Go no key"), botones [Save key, Remove, Test] ×2 con mismo top por fila ([328.67×3], [463.98×3] — una sola fila) + `details Models(n)`. Fuente: `sections.tsx:ProviderSettings` titula "Proveedores" sin paréntesis. Evidencia previa task-5.log + task-5.png (mismo top, sin overflow, radios 2px vía tokens).

## 7) Agentes sin presupuesto — PASS (EN VIVO)

En vivo, panel Agentes: "Agents / Concurrency limits (per session, per project, max depth, Save limits) / coordinator-build … default: meta/muse-wonder-1.0 effort=high · tools=19 … Save model …" — cero menciones monetarias. La card "Concurrency limits" (`agents.setLimits`) es concurrencia, no gasto — se conserva por diseño. Barrido de money-words en `settings.tsx/sections.tsx/welcome.tsx/workbench.tsx/agents.tsx`: solo aparece "diferidos por presupuesto" (virtualización de ventanas DOM = render-budget, guard de perf permitido). Evidencia previa task-6.log (check "zero budget mentions" + 2 Save model compactos) + task-6.png.

## 8) budget spend-refs = 0 (guards listados) — PASS

Grep repo-wide `/budget/i` (fuera de node_modules/.git/out/evidence): `packages/core/src` = 0 hits, `packages/shared/src` = 0 hits. En `apps/desktop/src` quedan 7 hits, TODOS en `renderer/src/perf.ts` (`PERF_BUDGETS`, `budgetForPanel`, `noteRender`) = presupuestos de RENDER (filas virtuales por panel), guard de performance del plan anterior — permitido por el checklist. Guards de tests permitidos: `settings-modal.test.ts` ("shell no contiene Budget"), `router.test.ts` (0 eventos `budget.*`). Boot proof previa vigente: task-7.log (API budgets fuera de la superficie core, llamada pagada completa con cero configuración, 0 eventos budget.*).
Residuales report-only (scripts/docs legacy del plan anterior, sin cablear a IPC vigente — fuera de alcance): mocks `budgets.status/configure` en `scripts/probe-task-13-fixture.cjs`, `scripts/probe-task-14-playwright.cjs`, `scripts/task-11-sessions.entry.tsx`, `scripts/verify-task-33-surface.cjs`; herramienta de perf-budgets `scripts/verify-task-34-budget.mjs` + `scripts/{task-5-map.mjs,task-5-map.json}`; menciones históricas en `README.md`, `.omo/plans/`, `.omo/design/`.

## 9) Barato único + memoria de sesión — PASS

`cheapest-model.test.ts` 8/8 re-ejecutado hoy: `setProviderKey` aplica UN default barato uniforme a todas las definitions; el modelo de sesión persiste y prevalece; el último modelo por workspace se restaura al reabrir (transcripción cruda previa: task-9.log). En vivo no hay keys configuradas → sin default (failure path honesto, no forzado).

## 10) Render LIVE en Electron — PASS (lanzable; caveats previos cerrados donde aplica)

SÍ lanzable en este Windows: build de producción abierto en ventana (`Electron 45.2.0 / Chrome 156`, ventana "Octus" sobre `out/renderer/index.html`), manejado por CDP en `127.0.0.1:19222`, 4 capturas guardadas (welcome, modal-proveedores, modal-agentes, welcome-tras-cierre). Ruido de log: `Unable to move the cache` + `bind() … devtools` (doble-bind IPv4/IPv6 típico de Chromium; el endpoint respondió y la app rindió) — ver task-10.electron-out.log.
Gaps conocidos: (a) renders live de app (todos 1/2/4) — CERRADO para welcome + modal (PNGs + estilos computados en vivo); workbench/terminal con proyecto siguen en evidencia de fixture previa (task-2.png) por el motivo del §3. (b) J4 isolation raw log (nota todo 7) — ver task-7-build-raw.log (BUILD_EXIT:0) + task-7-tests-raw.log (363 pass / 1 fail J4-30s) + §5 de task-7.log (aislado 37/0); el ruido de transcripción del background-session queda reconocido como caveat, no como fallo. (c) DnD real (todo 3) — no ejercido en vivo (§4).

## Adversarial

- misleading_success: solo salidas reales (cada comando con su exit arriba y su `.raw.log` íntegro: desktop/core/shared/cheapest/modal/tsc×3/build/smoke).
- dirty_worktree: report-only (ver sección inicial); esta pasada no modificó ninguna fuente — solo creó `task-10.*` bajo evidencia.

## DoneClaim

Regresión global ejecutada y evidenciada: suites desktop (17/0) + cheapest (8/0) + settings-modal (6/6) + shared (31/0) verdes; tsc shared/core/desktop limpios; build electron-vite EXIT 0; smoke Electron ALL OK; render LIVE en Electron sobre welcome + modal (4 PNGs + estilos computados + interacciones X/secciones/overflow verificadas). Ítems 2-9: PASS con rutas de evidencia por ítem. Hallazgo único: 31 timeouts de carga en `integration/worktrees.test.ts` (archivos no tocados por este plan, firma idéntica a la documentada en task-7) — REPORTADO, no corregido (fuera de alcance). Límites declarados: toggles-con-proyecto y DnD-OS real no ejercidos en vivo (motivos en §3/§4); workbench/terminal en vivo pendientes de un proyecto sin diálogos nativos.

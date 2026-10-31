# STAGE5_ACCEPTANCE_REPORT.md — Aceptación funcional Etapa 5

## Fase 5 live — IntegrationManager/Preview/Approval/Promotion (modelos reales)

- **Comando:** `bunx electron ./apps/desktop/out/main/index.js --user-data-dir="$env:APPDATA\@octus\desktop" --octus-acceptance-5` con `OCTUS_ACCEPT_MATRIX=a` (claves del SO; mismo requisito de user-data real que Etapas 3–4).
- **Matriz:** A meta/muse-spark-1.3-contributor/xhigh (planner + workers con mismo modelo/effort del coordinador). Matriz B no re-ejecutada (limitación del modelo documentada en Etapa 3).
- **Flujo por matriz:** plan → planner real → 2 lectoras en paralelo → implementer en worktree auto-aprovisionado con commit harness → reviewer en el worktree del target → veredicto accept → auto-build (integración creada e incorporada, run → integrating) → reviewer de integración (spawn explícito sobre el worktree de integración) → gate de validación → preview real reachable sobre el SHA exacto → aprobación pinneada al SHA → promoción fast-forward a main (run → done), sin remoto.

- **Resultado final live (matriz A): PASS 45/45, FAIL 0** — dos ejecuciones previas 44/45 por `A3-meta-rundone5` (vía idempotente de promote no convergía; fix + test de regresión "promote idempotente converge", veredicto `reused=true` → run `done`). Secciones brutas anexadas abajo por el corredor (44/45 y 45/45); evidencia cruda en `C:\Users\Public\octus-accept5-live.log`.

## Evidencia unitaria (Etapa 5, git real + fakes)

- `packages/core/test/integration.test.ts` (J1–J27 + ciclo de vida, 37 tests en verde):
  - J1: dos writers independientes → FF + merge, ambos ficheros presentes, tasks a `integrated`.
  - J2: mismo archivo sin solape → merge limpio.
  - J3: cadena writer→writer → FF + FF por `produced_commit`.
  - J4 (§B): dependiente con 2 predecesores escritores usa workbase (base = tip, hereda ambos ficheros); bloqueado `deps-unavailable` mientras falta un reviewed; incorpora A, B y C (merge).
  - J5/J6 (§C): conflicto detectado (abort + fila abierta, rama preservada, sin MERGE_HEAD en integración); resolución asistida sin tocar la rama (el harness commitea, padres verificados); incorporación FF con kind resolution; idempotencia.
  - Reutilización: misma pareja (ours, theirs) ya resuelta no spawnea otro agente.
  - Negativos: agente que commitea por su cuenta → rechazo (sin MERGE_HEAD); escritura fuera del scope → rechazo.
  - J7: origen no registrado / task sin revisión → rechazo.
  - J8: commit de otro proyecto/repositorio → rechazo.
  - J9: intento ya integrado idempotente (sin duplicar filas).
  - J10: suite distingue passed/failed; gate bloquea con fallos.
  - J11: comando fuera de allowlist → blocked (nunca se ejecuta); suite vacía → skipped explícito; gate exige review accept.
  - J12: preview que no arranca → failed (sin excepción).
  - J13: preview sirve el SHA exacto; stop mata el árbol (pid muerto).
  - J14: aislamiento de entorno y DB (sin secretos; `OCTUS_PREVIEW_*` presentes); sin `.git` real en el preview.
  - J15: reconcile marca huérfanos sin matar; cleanup retira el espacio.
  - J16: URL y SHA corresponden al registrado; reachable.
  - J17: aprobación pinneada al SHA con actor y hash (validations hash SHA-256).
  - J18: cambio del SHA tras aprobar invalida; promover se niega.
  - J19: destino movido bloquea la promoción (stale + diverged) y el rebuild continúa (attempt+1, supersede, base fresca).
  - J20: aprobación duplicada idempotente; decisión distinta exige rebuild.
  - J21: interrupción durante la integración resuelve ops sin duplicar.
  - J22: interrupción durante la promoción recuperable sin duplicar (tip==new → completed; tip==old → failed reintentable; otro → diverged + stale).
  - J24a: update-ref CAS sin checkout (destino no usado en ningún worktree).
  - J24b/c: destino checked-out limpio → merge --ff-only; sucio → bloqueo sin tocar nada (J25: cambios del usuario intactos).
  - J26: sin push (grep estático en `src/integration/` + `git remote -v` vacío en fixtures).
  - Dependiente deriva de predecesor `integrated` (regresión del gate `reviewed`-only).
  - spawnIntegrationReview + record accept cierra el gate.
  - promote idempotente converge aunque el destino ya esté en el head (regresión A3-meta-rundone5: converge promotion/integration/run; segundo promote es no-op puro).
  - settle: el reinicio conserva runs con integración abierta (building) e interrumpe el resto.
- `packages/core/test/persistence.test.ts`: migración 0005 (12 tablas) + 0006 (task_id/attempt/resolution_instance_id en conflictos); etapas futuras (`memory_entries`) ausentes.
- Regresión completa: suite core + shared en verde (incl. invariante `integrated` en ready-gates y cascadas).

## Verificación de escritorio

- `typecheck` verde: `packages/shared`, `packages/core`, `apps/desktop` (node + web).
- `bun run build` + `bun run smoke` en verde.
- Arranque GUI `--octus-autoquit`: quit 0 sin errores de consola.
- IPC/UI Etapa 5: 37 canales tipados; sección plegable Integrations (commits, validaciones, reviews, conflictos con solicitar/finalizar/incorporar/abortar/limpiar, preview con start/stop/logs/cleanup, aprobación con waiver o preview, promoción, rebuild).

## Alcance y límites

- Sin push a remotos, sin despliegue, sin memoria (Etapa 6), sin nuevos coordinadores/perfiles.
- Promoción solo fast-forward (merge --ff-only o update-ref CAS); sin merges de integración en la rama destino.
- Preview ligado a localhost por convención; no es un sandbox (misma declaración que ADR-018).
- Limpieza de workspaces de resolución/preview: explícita del usuario.

## Fase 5 live — IntegrationManager/Preview/Approval/Promotion (modelos reales)

- **Resultado fase 5 live:** PASS=44 FAIL=1 BLOCKED=0 SKIP=0 — 140s
- **Matrices:** A meta/muse-spark-1.3-contributor/xhigh (planner + workers con mismo modelo/effort del coordinador), B opencode-go/deepseek-v4.1-flash/max (ID exacto del catálogo real, sin fallback)

| instanceId | parentInstanceId | definition | provider | modelId | effort |
|---|---|---|---|---|---|
| ins_accept3_A3-meta_6e5iez | — | coordinator-build | meta | muse-spark-1.3-contributor | xhigh |
| ins_48c46fba23f7 | ins_accept3_A3-meta_6e5iez | explorer | meta | muse-spark-1.3-contributor | xhigh |
| ins_8e1b715fbe23 | ins_accept3_A3-meta_6e5iez | explorer | meta | muse-spark-1.3-contributor | xhigh |
| ins_e04fe1f34b25 | ins_accept3_A3-meta_6e5iez | implementer | meta | muse-spark-1.3-contributor | xhigh |
| ins_101894f53d76 | ins_accept3_A3-meta_6e5iez | reviewer | meta | muse-spark-1.3-contributor | xhigh |
| ins_e7d7f8aaea3e | ins_accept3_A3-meta_6e5iez | reviewer | meta | muse-spark-1.3-contributor | xhigh |

- [PASS] **A3-meta-approve** approved revision pins (plan, revision) — prev_485aebedc10f
- [PASS] **A3-meta-plan** TaskPlanner creates DAG from approved revision — planning pln_028b51a86a79
- [PASS] **A3-meta-planmodel** planner generation used meta/muse-spark-1.3-contributor — 1 planner usage rows
- [PASS] **A3-meta-persistplan** planning persisted as valid — valid
- [PASS] **A3-meta-persisttasks** 4 tasks persisted — 4 tasks
- [PASS] **A3-meta-persistdeps** dependencies persisted (implementer→readers) — tsk_02c19af8e0ee,tsk_285962aae0e9
- [PASS] **A3-meta-persistlink** review linkage persisted — tsk_c0b9a5850ab4
- [PASS] **A3-meta-parallel** scheduler assigns both readers in one tick — aae0e9,f8e0ee
- [PASS] **A3-meta-gatedeps** implementer still draft while readers incomplete — draft
- [PASS] **A3-meta-gaterev** reviewer still draft while target incomplete — draft
- [PASS] **A3-meta-limits** role/session limits respected during parallel readers — {"coordinator":1,"explorer":2}
- [PASS] **A3-meta-readers** both readers completed in parallel — 2/2 completed
- [PASS] **A3-meta-implunblock** scheduler unblocks implementer after readers — running
- [PASS] **A3-meta-impldone** implementer completed — completed
- [PASS] **A3-meta-implfile** worktree/work-impl/result.txt with combined marker — marker present in harness/run-run_accept3_A3-meta_69bwfy/task-tsk_c0b9a5850ab4
- [PASS] **A3-meta-implwt** implementer worktree provisioned with base commit — harness/run-run_accept3_A3-meta_69bwfy/task-tsk_c0b9a5850ab4 @ dc09fea00672
- [PASS] **A3-meta-implcommit** harness recorded produced_commit — dc09fea00672
- [PASS] **A3-meta-revunblock** reviewer unblocked after implementer — running
- [PASS] **A3-meta-revdone** reviewer completed — completed
- [PASS] **A3-meta-revwt** reviewer runs inside target worktree — wt_0f7c217ff246 @ ktrees\prj_7b276ffd5903\tsk_c0b9a5850ab4
- [PASS] **A3-meta-revidence** review delivery quotes the combined marker — ## Review Report — `work-impl/result.txt` verification — PASS

Verified content matches acceptance criteria containing `combined:alpha-42+beta-84`.

### Finding
- [PASS] **A3-meta-verdict** accept verdict marks implementer reviewed — reviewed
- [PASS] **A3-meta-rundone** run auto-builds into integrating — integrating
- [PASS] **A3-meta-autoint** integration auto-created with produced commit — harness/integration/run-run_accept3_A3-meta_69bwfy @ dc09fea00672
- [PASS] **A3-meta-deliver** reader aae0e9 delivery recorded — ## Structured Findings Report

### 1. Summary of what was asked and found
- **As
- [PASS] **A3-meta-deliver** reader f8e0ee delivery recorded — ## Structured findings report

### 1. Summary of what was asked and found
Task w
- [PASS] **A3-meta-model** explorer ba23f7 runs meta/muse-spark-1.3-contributor/xhigh — meta/muse-spark-1.3-contributor/xhigh
- [PASS] **A3-meta-usage** explorer ba23f7 billed usage matches model — 4 usage rows
- [PASS] **A3-meta-model** explorer 5fbe23 runs meta/muse-spark-1.3-contributor/xhigh — meta/muse-spark-1.3-contributor/xhigh
- [PASS] **A3-meta-usage** explorer 5fbe23 billed usage matches model — 8 usage rows
- [PASS] **A3-meta-model** implementer f34b25 runs meta/muse-spark-1.3-contributor/xhigh — meta/muse-spark-1.3-contributor/xhigh
- [PASS] **A3-meta-usage** implementer f34b25 billed usage matches model — 15 usage rows
- [PASS] **A3-meta-model** reviewer f53d76 runs meta/muse-spark-1.3-contributor/xhigh — meta/muse-spark-1.3-contributor/xhigh
- [PASS] **A3-meta-usage** reviewer f53d76 billed usage matches model — 4 usage rows
- [PASS] **A3-meta-autowt** scheduler auto-provisioned exactly one worktree, no isolated dirs — 1 worktrees, 0 isolated dirs
- [PASS] **A3-meta-wtbranch** worktree branch follows harness naming — harness/run-run_accept3_A3-meta_69bwfy/task-tsk_c0b9a5850ab4
- [PASS] **A3-meta-autoint** integration auto-created with produced commit — harness/integration/run-run_accept3_A3-meta_69bwfy @ dc09fea00672
- [PASS] **A3-meta-intrevdone** integration reviewer completed — aaea3e
- [PASS] **A3-meta-gate** validation gate passes (suite + accept review) — clear
- [PASS] **A3-meta-pvcreate** preview workspace provisioned at head — dc09fea00672
- [PASS] **A3-meta-preview** preview reachable on exact SHA — reachable http://127.0.0.1:54870
- [PASS] **A3-meta-approve** approval pinned to exact SHA — dc09fea00672
- [PASS] **A3-meta-promote** promotion fast-forwards main to approved SHA — main=dc09fea00672 reused=true
- [FAIL] **A3-meta-rundone5** run finishes done after promotion — integrating
- [PASS] **A3-meta-nopush** no remote configured (nothing to push to) — remote -v empty

| matrix | provider | model | calls | in | out | reasoning | cached | cost |
|---|---|---|---|---|---|---|---|---|
| A3-meta | meta | muse-spark-1.3-contributor | 45 | 132689 | 10955 | 6315 | 106197 | cost unknown |

## Fase 5 live — IntegrationManager/Preview/Approval/Promotion (modelos reales)

- **Resultado fase 5 live:** PASS=45 FAIL=0 BLOCKED=0 SKIP=0 — 127s
- **Matrices:** A meta/muse-spark-1.3-contributor/xhigh (planner + workers con mismo modelo/effort del coordinador), B opencode-go/deepseek-v4.1-flash/max (ID exacto del catálogo real, sin fallback)

| instanceId | parentInstanceId | definition | provider | modelId | effort |
|---|---|---|---|---|---|
| ins_accept3_A3-meta_osno5i | — | coordinator-build | meta | muse-spark-1.3-contributor | xhigh |
| ins_977717d3dcbf | ins_accept3_A3-meta_osno5i | explorer | meta | muse-spark-1.3-contributor | xhigh |
| ins_cc71d746db4d | ins_accept3_A3-meta_osno5i | explorer | meta | muse-spark-1.3-contributor | xhigh |
| ins_20e95bf1d4fc | ins_accept3_A3-meta_osno5i | implementer | meta | muse-spark-1.3-contributor | xhigh |
| ins_dd062697d5e1 | ins_accept3_A3-meta_osno5i | reviewer | meta | muse-spark-1.3-contributor | xhigh |
| ins_c7d66ffee838 | ins_accept3_A3-meta_osno5i | reviewer | meta | muse-spark-1.3-contributor | xhigh |

- [PASS] **A3-meta-approve** approved revision pins (plan, revision) — prev_9380c4ac1715
- [PASS] **A3-meta-plan** TaskPlanner creates DAG from approved revision — planning pln_396e8f0d9e09
- [PASS] **A3-meta-planmodel** planner generation used meta/muse-spark-1.3-contributor — 2 planner usage rows
- [PASS] **A3-meta-persistplan** planning persisted as valid — valid
- [PASS] **A3-meta-persisttasks** 4 tasks persisted — 4 tasks
- [PASS] **A3-meta-persistdeps** dependencies persisted (implementer→readers) — tsk_26c0dfeff056,tsk_95826e33dad7
- [PASS] **A3-meta-persistlink** review linkage persisted — tsk_84bf45bc5d07
- [PASS] **A3-meta-parallel** scheduler assigns both readers in one tick — eff056,33dad7
- [PASS] **A3-meta-gatedeps** implementer still draft while readers incomplete — draft
- [PASS] **A3-meta-gaterev** reviewer still draft while target incomplete — draft
- [PASS] **A3-meta-limits** role/session limits respected during parallel readers — {"coordinator":1,"explorer":2}
- [PASS] **A3-meta-readers** both readers completed in parallel — 2/2 completed
- [PASS] **A3-meta-implunblock** scheduler unblocks implementer after readers — running
- [PASS] **A3-meta-impldone** implementer completed — completed
- [PASS] **A3-meta-implfile** worktree/work-impl/result.txt with combined marker — marker present in harness/run-run_accept3_A3-meta_sxvk3u/task-tsk_84bf45bc5d07
- [PASS] **A3-meta-implwt** implementer worktree provisioned with base commit — harness/run-run_accept3_A3-meta_sxvk3u/task-tsk_84bf45bc5d07 @ 5d0a6b9e43a9
- [PASS] **A3-meta-implcommit** harness recorded produced_commit — 5d0a6b9e43a9
- [PASS] **A3-meta-revunblock** reviewer unblocked after implementer — running
- [PASS] **A3-meta-revdone** reviewer completed — completed
- [PASS] **A3-meta-revwt** reviewer runs inside target worktree — wt_9ed1ee975cb2 @ ktrees\prj_b44ee3790997\tsk_84bf45bc5d07
- [PASS] **A3-meta-revidence** review delivery quotes the combined marker — ## Review Report — `work-impl/result.txt` combined marker

**Task:** Verify `work-impl/result.txt` contains `combined:alpha-42+beta-84`
**Acceptance criteria:**
- [PASS] **A3-meta-verdict** accept verdict marks implementer reviewed — reviewed
- [PASS] **A3-meta-rundone** run auto-builds into integrating — integrating
- [PASS] **A3-meta-autoint** integration auto-created with produced commit — harness/integration/run-run_accept3_A3-meta_sxvk3u @ 5d0a6b9e43a9
- [PASS] **A3-meta-deliver** reader eff056 delivery recorded — ## Structured findings report

### 1. Summary of what was asked and found
- **As
- [PASS] **A3-meta-deliver** reader 33dad7 delivery recorded — ## Structured Findings Report

### 1. Summary of what was asked and found
- **As
- [PASS] **A3-meta-model** explorer d3dcbf runs meta/muse-spark-1.3-contributor/xhigh — meta/muse-spark-1.3-contributor/xhigh
- [PASS] **A3-meta-usage** explorer d3dcbf billed usage matches model — 4 usage rows
- [PASS] **A3-meta-model** explorer 46db4d runs meta/muse-spark-1.3-contributor/xhigh — meta/muse-spark-1.3-contributor/xhigh
- [PASS] **A3-meta-usage** explorer 46db4d billed usage matches model — 4 usage rows
- [PASS] **A3-meta-model** implementer f1d4fc runs meta/muse-spark-1.3-contributor/xhigh — meta/muse-spark-1.3-contributor/xhigh
- [PASS] **A3-meta-usage** implementer f1d4fc billed usage matches model — 11 usage rows
- [PASS] **A3-meta-model** reviewer 97d5e1 runs meta/muse-spark-1.3-contributor/xhigh — meta/muse-spark-1.3-contributor/xhigh
- [PASS] **A3-meta-usage** reviewer 97d5e1 billed usage matches model — 2 usage rows
- [PASS] **A3-meta-autowt** scheduler auto-provisioned exactly one worktree, no isolated dirs — 1 worktrees, 0 isolated dirs
- [PASS] **A3-meta-wtbranch** worktree branch follows harness naming — harness/run-run_accept3_A3-meta_sxvk3u/task-tsk_84bf45bc5d07
- [PASS] **A3-meta-autoint** integration auto-created with produced commit — harness/integration/run-run_accept3_A3-meta_sxvk3u @ 5d0a6b9e43a9
- [PASS] **A3-meta-intrevdone** integration reviewer completed — fee838
- [PASS] **A3-meta-gate** validation gate passes (suite + accept review) — clear
- [PASS] **A3-meta-pvcreate** preview workspace provisioned at head — 5d0a6b9e43a9
- [PASS] **A3-meta-preview** preview reachable on exact SHA — reachable http://127.0.0.1:55299
- [PASS] **A3-meta-approve** approval pinned to exact SHA — 5d0a6b9e43a9
- [PASS] **A3-meta-promote** promotion fast-forwards main to approved SHA — main=5d0a6b9e43a9 reused=true
- [PASS] **A3-meta-rundone5** run finishes done after promotion — done
- [PASS] **A3-meta-nopush** no remote configured (nothing to push to) — remote -v empty

| matrix | provider | model | calls | in | out | reasoning | cached | cost |
|---|---|---|---|---|---|---|---|---|
| A3-meta | meta | muse-spark-1.3-contributor | 33 | 88614 | 13761 | 10274 | 62729 | cost unknown |

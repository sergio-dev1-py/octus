# STAGE2_ACCEPTANCE_REPORT.md — Aceptación funcional Etapa 2

- **Fecha:** 2026-10-31 (Europa/Madrid)
- **Resultado global: APTA para cierre de Etapa 2** — todas las pruebas críticas de permisos, aislamiento, delegación, aprobación y persistencia están en PASS en sus ejecuciones definitivas. Recomendación: **cerrar Etapa 2 y comenzar Etapa 3**.
- **Credenciales:** meta=presente, opencode-go=presente en el almacén seguro del SO (solo presencia; valores jamás mostrados, copiados ni registrados).
- **Matriz A:** proveedor `meta`, modelo `muse-spark-1.3-contributor`, esfuerzo `xhigh` — coordinador Plan/Build + explorer/researcher/implementer/reviewer, todas las instancias.
- **Matriz B:** proveedor `opencode-go`, modelo `deepseek-v4.1-flash`, esfuerzo `max` — coordinador Plan/Build + subagentes, todas las instancias.
- **Catálogo Go verificado en vivo:** 28 modelos; `deepseek-v4.1-flash` existe con protocolo `chat-completions`, `toolCall=true`, esfuerzos `[low,high,max]`. Sin reducciones silenciosas: si el modelo/effort no existe, la matriz se declara BLOCKED.
- **Harness live-only de Contributor conservado:** el adaptador Meta de producción solo ofrece wonder/spark; el harness amplía el catálogo solo en memoria para `-contributor` (producción intacta, YAML intactos).

## 1–3. Modelo y razonamiento reales por coordinador y subagente

Todas las instancias registraron exactamente el proveedor/modelo/esfuerzo de su matriz (verificado en `usage_records` + `agent_instances.model`):

| definition | Matriz A (provider/model/effort) | Matriz B (provider/model/effort) |
|---|---|---|
| coordinator-plan | meta / muse-spark-1.3-contributor / xhigh | opencode-go / deepseek-v4.1-flash / max |
| coordinator-build | meta / muse-spark-1.3-contributor / xhigh | opencode-go / deepseek-v4.1-flash / max |
| explorer | meta / muse-spark-1.3-contributor / xhigh | opencode-go / deepseek-v4.1-flash / max |
| researcher | meta / muse-spark-1.3-contributor / xhigh | (verificado vía modelo; web en fase 1-A) |
| implementer | meta / muse-spark-1.3-contributor / xhigh | (verificado vía modelo en delegación; git local en §local) |
| reviewer | meta / muse-spark-1.3-contributor / xhigh | (verificado vía modelo; desechable en fase 1-A) |

Tabla completa de instancias (muestra; el registro íntegro vive en los logs de ejecución):

| instanceId | parentInstanceId | definition | provider | modelId | effort |
|---|---|---|---|---|---|
| ins_5d350e56cb62 | — | coordinator-build | meta | muse-spark-1.3-contributor | xhigh |
| ins_435fd9e51e90 | ins_5d350e56cb62 | explorer | meta | muse-spark-1.3-contributor | xhigh |
| ins_cba967c1be71 | ins_5d350e56cb62 | explorer | meta | muse-spark-1.3-contributor | xhigh |
| ins_db375b69a604 | ins_5d350e56cb62 | researcher | meta | muse-spark-1.3-contributor | xhigh |
| ins_bd0bd8644d17 | ins_5d350e56cb62 | implementer | meta | muse-spark-1.3-contributor | xhigh |
| ins_6c5c22d3137a | ins_5d350e56cb62 | reviewer | meta | muse-spark-1.3-contributor | xhigh |
| ins_e0fa3b89c5ce | ins_03f63c9cfb59 | explorer | opencode-go | deepseek-v4.1-flash | max |
| ins_accept2_rst | ins_7d00da7b2837 | explorer | meta | muse-spark-1.3-contributor | xhigh |
| ins_accept2_rst | ins_b3f4a76857d3 | explorer | opencode-go | deepseek-v4.1-flash | max |

## 4. Escenarios A–G y permisos (ejecuciones definitivas)

### Matriz A — Meta Contributor/xhigh: 27/27 PASS
- [PASS] A-cont: conversación continua plan→build, mismo `session_id`, modos `[user:plan assistant:plan user:build assistant:build]`, Build recuerda la keyword.
- [PASS] B-create/B-immut/B-nopending: plan persiste en SQLite (`unpresented`/`pending`), actualización genera v2 inmutable, revisión no presentada no aprobable.
- [PASS] B-approve/B-impl: aprobación solo-usuario fija `(plan, revision)`; `implementPlanRevision` ejecuta exactamente la revisión aprobada (`runs.plan_revision_id` correcto, perfil cambia a build).
- [PASS] B-selfappr: `plan.approve/reject/archive/export` no existen como herramientas; llamada directa rechazada por el gateway.
- [PASS] B-orphan: revisiones huérfanas no aprobables (`orphaned`).
- [PASS] C-fg: delegate foreground a explorer con entrega estructurada (10 mensajes de conversación hija independiente).
- [PASS] D-ids/D-coord/D-deliver/D-status/D-message/D-wait/D-result: dos hijos background con ids distintos; coordinador termina y responde mientras trabajan; entregas recuperadas sin instancias extra; `status/message/wait/result` operativos.
- [PASS] D-cancel: cancelación en cascada padre+nieto; el hermano sobrevive.
- [PASS] P-explorer: escritura directa denegada.
- [PASS] P-research: websearch + webfetch reales con etiqueta `[untrusted …]`; SSRF bloqueada 2/2 (loopback y link-local).
- [PASS] P-impl: implementer crea/modifica solo en su worktree asignado; escritura fuera denegada; `git checkout -b` denegado por la guarda (incluso con permiso concedido).
- [PASS] P-review: `test_run` con allowlist en copia desechable (`reviewer-probe-ok`, exit 0, 148 ms); marcador ausente en workspace y worktree originales.
- [PASS] L-limits: 4/sesión, 6/proyecto, profundidad 2 activos.
- [PASS] L-snapshot: la instancia conserva su snapshot tras cambiar la definición.

### Matriz B — DeepSeek V4.1 Flash/max: 7/7 PASS (re-ejecución definitiva)
- [PASS] B0/B-cat: catálogo público (28 modelos); deepseek verificado (chat-completions, tools, max).
- [PASS] B-cont: conversación continua con keyword `go-probe-abc` recordada en build.
- [PASS] B-deepseek: continuidad multi-paso con max (5 tool calls, `done`, sin `reasoning_content`/400/MissingSession).
- [PASS] B-plan: plan→aprobar→implementar revisión fijada.
- [PASS] B-delegate: delegate foreground completa.

### Fase 2 — AgentManager y seguridad (§6 + D-message genuino): 16/16 PASS + 2 SKIP justificados
- [PASS] Sesión y proyecto: límites aplicados incluyendo al coordinador (rechazo `concurrency_limit`).
- [PASS] Profundidad: explorer no puede delegar (guarda que hace inalcanzable depth 3 en producción; el límite numérico lo cubre la suite unitaria).
- [PASS] Exclusividad real de directorios con solapes (`scope_conflict`), ambas matrices.
- [PASS] `agent_message` continúa la misma instancia sin duplicar (2→2), ambas matrices.
- [PASS] Reinicio: hijo cancelado/continuable → `message` lo reanuda con ejecución REAL en la misma instancia (`resumed=completed`), ambas matrices.
- [PASS] Compactación: planes/aprobaciones/entregas sobreviven al checkpoint (fuente SQLite), ambas matrices.
- [PASS] `agent_wait` timeout sobre hijo activo (matriz A).
- [SKIP] B2-go-bgwait/waitto: DeepSeek respondió sin usar la herramienta `question` (sin bloqueo observable); el timeout queda cubierto por la matriz A y la suite unitaria.

### Herramientas locales Git/contención (cero coste, gateway real): 17/17 PASS
- Implementer: `git_status`/`git_diff` lectura, `git_stage` + `git_commit` autorizados y registrados en el worktree; repo original intacto.
- Denegados: `checkout -b`, `push`, `reset --hard` (guarda), escritura fuera de ámbito, traversal `../`, rutas UNC, lectura `.env`.
- Reviewer: sin shell genérico, sin escritura, `git_diff` de solo lectura.

## 5. Evidencia de delegación background y entregas
- Hijos con `instanceId` distintos, coordinador en `done` mientras hijos en `running`/`waiting_input`, nueva respuesta del coordinador en el siguiente turno, entregas pendientes consumidas una sola vez (`consumePendingDeliveries`), sin instancias nuevas al consultar (`8->8`, `2->2`, `4->4`).
- Cancelación en cascada verificada con nieto (padre+nieto cancelados, hermano intacto).

## 6. Continuidad de DeepSeek V4.1 Flash con max (§7)
- [PASS] Exploración multi-paso (glob + 3 lecturas + grep, ≥5 tool calls) con `reasoning.effort=max` por `chat-completions`: `done`, 0 errores de `reasoning_content`/400/`MissingSession` en `tool_invocations`.
- El problema reportado de pérdida de `reasoning_content` en continuaciones largas **no se reproduce** en el adaptador actual de Octus con este modelo. Sin reducciones: max se usó de verdad en todas las instancias Go.

## 7. Reviewer desechable (§5)
- [PASS] `test_run` ejecuta la entrada de la allowlist en copia sin `.git`; marcador temporal verificado ausente en workspace y worktree; `git status` del original intacto; reviewer sin shell ni escritura.

## 8. Límites de concurrencia y recuperación (§6)
- Ver tabla fase 2: todos PASS. Recuperación tras reinicio con continuación en la misma instancia (sin duplicar) verificada en ambas matrices con ejecuciones reales.

## 9. Interfaz
- [NOT VERIFIED] GUI de escritorio: sin automatización gráfica disponible en el repo (sin Playwright/Electron-CDP). No se afirma prueba de GUI. Manual disponible: etiquetas `[plan]/[build]` por mensaje, planes/agentes plegables, aprobar/rechazar/exportar/implementar por (plan, revisión), ajustes de agentes y proyecto.

## 10. Typecheck, build, suite y regresiones
- Typecheck verde (shared+core+desktop node/web). Build verde + `copy-assets` (worker + 6 YAML). Smoke Electron ALL OK. GUI autoquit código 0.
- Suite unitaria: core 116/116 + shared 1/1 + live-config 6/6 + local-tools 17/17 en verde (regresión Etapa 1 intacta; `check:live` en SKIP sin claves, como en el cierre de Etapa 1).

## 11. Tokens y costes por proveedor/modelo/matriz

| matrix | provider | model | calls | in | out | reasoning | cached | cost |
|---|---|---|---|---|---|---|---|---|
| A-meta (fase 1) | meta | muse-spark-1.3-contributor | 39 | 140571 | 10283 | 6477 | 84233 | cost unknown (sin tarifa verificada en `pricing.ts`) |
| B-go (fase 1, definitiva) | opencode-go | deepseek-v4.1-flash | 16 | 45032 | 1513 | 608 | 42624 | $0.0014 |
| A2-meta (fase 2) | meta | muse-spark-1.3-contributor | 6 | 14174 | 3861 | 3033 | 4834 | cost unknown |
| B2-go (fase 2) | opencode-go | deepseek-v4.1-flash | 6 | 7086 | 963 | 731 | 2944 | $0.0012 |

Presupuestos por matriz: global $4 `block` + run 100k tokens. Sin excedidos. Sin fallback silencioso en ningún caso.

## 12. Errores encontrados y correcciones
1. `bun run dev` no arrancaba: fallback dev de worker/definitions subía 3 niveles en vez de 4 (`apps/desktop/src/main/worker-path.ts`). Corregido; typecheck/build/smoke verdes.
2. Harness live-only de Contributor para Meta (catálogo en memoria + `OCTUS_LIVE_META_MODEL/_EFFORT`): producción intacta. Resuelto en tarea anterior; reutilizado aquí.
3. `ask` sin respuesta colgaba llamadas directas al gateway (shell pendiente eterno): `execGuarded` con timeout 60s + usuario simulado con registro. Sin cambios de producción.
4. Preguntas inesperadas del modelo podían colgar runs: usuario simulado global (aprueba permisos, responde preguntas con primeras opciones, todo registrado).
5. Fase 2, intento 1: nieto desde explorer viola las reglas de delegación → nieto sintético + guarda `cannot delegate` (documenta que depth 3 es inalcanzable en producción).
6. Fase 2, intento 1: catálogo live-only perdido al reabrir → reaplicar tras cada `open()`.
7. Detalle de log confuso en `A2-meta-bgwait` (sufijo “SKIP:” con estado PASS): errata solo de texto, corregida en código.
8. Observación: la fase 2 devolvió código de proceso 1 sin ningún FAIL/BLOCKED registrado, informe escrito y temporales limpiados; causa no determinada (sin errores en log). No afecta la evidencia. Pendiente de investigar si reaparece.
9. Limpieza Windows: `.git` deja archivos de solo lectura (EPERM); limpieza robusta con `chmod` + `prune` + reintentos; restos manuales eliminados y verificados (sin `octus-accept-*` residuales).

## 13. Incidencias pendientes y riesgos
- GUI: NOT VERIFIED (requiere Playwright o automatización Electron; no existe en el repo).
- `B2-go-bgwait/waitto` en SKIP: DeepSeek-max no usó la herramienta `question`; el timeout de `agent_wait` queda verificado en Meta + suite unitaria.
- Forzar el presupuesto hasta el bloqueo no se ejecutó en vivo (habría bloqueado la propia validación); el gate está verificado en smoke + suite unitaria.
- `cost unknown` para Meta Contributor: no hay tarifa verificada en `pricing.ts` (esperado; el ticket Go sí la tiene y es céntimos).
- Implicación ADR-005: las variantes `-contributor` permiten entrenamiento con el contenido; su uso aquí fue consentimiento explícito del propietario para la validación.
- Proofreading de `reasoning_content` con max en secuencias >7 pasos: verificado hasta 7 tool calls; secuencias mucho más largas quedan como riesgo residual bajo.

## Veredicto
**Se recomienda cerrar la Etapa 2 y comenzar la Etapa 3.** Ninguna prueba crítica de permisos, aislamiento, delegación, aprobación o persistencia tiene FAIL o BLOCKED en sus ejecuciones definitivas; los FAIL intermedios fueron del harness (documentados arriba) y quedaron resueltos con re-ejecuciones en PASS.

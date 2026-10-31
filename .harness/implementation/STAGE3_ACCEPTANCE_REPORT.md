# STAGE3_ACCEPTANCE_REPORT.md — Aceptación funcional Etapa 3

- **Fecha:** 2026-10-31 (Europa/Madrid)
- **Resultado global: APTA con matiz live** — typecheck verde (shared+core+desktop node/web), 140 tests core + 1 shared en verde, build + smoke + arranque GUI en verde, live Etapa 3: **matriz A PASS (35/35)**, matriz B **BLOCKED** (el modelo no sigue el contrato de salida del planner; evidencia abajo, no es bug de producto). Recomendación: **declarar cerrada la Etapa 3** (puerta de salida unitaria + live A superadas; B re-ejecutable cuando el modelo cumpla el contrato).
- **Credenciales:** presentes en el almacén seguro del SO (solo presencia; valores jamás mostrados, copiados ni registrados).
- **Alcance respetado:** sin worktrees automáticos, sin ramas, sin merge/promoción, sin mensajería worker→worker, sin rol integrador, sin panel lateral ni editor visual de DAG (Etapas 4–5 intactas).

## Verificación ejecutada (esta sesión)

| Check | Resultado |
|---|---|
| `bun run typecheck` (shared + core + desktop node/web) | PASS |
| `packages/core`: 140 tests / 23 ficheros | 140 pass, 0 fail (incl. test anti-deadlock reviewer→needsReview) |
| `packages/shared`: 1 test | PASS |
| Nuevas suites Etapa 3: `task-graph` (5), `planner` (7), `scheduler` (11) | 23/23 PASS |
| Regresión Etapas 1–2 (incl. `persistence`, `delegation`, `plans`, `permissions-matrix`) | PASS (1 expectativa actualizada: `tasks` ya no es "tabla futura") |
| `bun run build` (desktop) | PASS |
| `bun run smoke` (main + core + worker + gate) | ALL OK |
| GUI `--octus-autoquit=8000` | quit code 0 (aviso benigno de GPU cache ajeno al producto) |
| `bun scripts/check-live.ts` sin claves | SKIP explícito (exit 0) |
| Live Etapa 3 matriz A (Meta contributor/xhigh, proceso Electron + claves OS) | PASS 35/35 (ver sección Fase 3 live) |
| Live Etapa 3 matriz B (Go deepseek-v4.1-flash/max) | BLOCKED — el modelo no sigue el contrato del planner (ver sección Fase 3 live) |

## Criterios de aceptación (puerta de salida de la Etapa 3)

- [PASS] **Run con ≥3 tasks paralelas lectoras y serialización de escritoras:** H3+H4 (2 explorer en paralelo + dependiente que espera, 1 intento por tarea, run `done` sin duplicados); H5 (scopes solapados `work` serializados: 1 activa + 1 `blocked/no-capacity`, al cancelar la activa la bloqueada avanza).
- [PASS] **Registro completo auditable:** eventos `task.created/status_changed/progress`, `task_attempt.created/status_changed`, `planning.created/rejected`, `review.recorded`, `scheduler.assigned`, `reservation.released`; entregas y veredictos vinculados persistidos.
- [PASS] **Planificación gobernada:** validación bilingüe con motivos accionables; idempotencia por `request_hash` (reintento devuelve el DAG, `created:false`); rechazo auditado que exige `nonce`; anclaje exacto a revisión aprobada (sin aprobación → `needs-approval`; run fijado a otra revisión → `plan_conflict`); planner end-to-end con modelo falso + idempotencia; sin auto-selección de revisión.
- [PASS] **DAG correcto:** ciclos (incl. auto-dependencia) rechazados con camino explícito; clausuras transitivas; ready-gate con `needsReview`; cascada que preserva `completed`/`reviewed` e independientes; orden determinista.
- [PASS] **Límites y equidad:** sesión/proyecto/rol bloquean con `no-capacity`; fairness round-robin r1→r2→r3 con cursor persistido verificado tras cada asignación.
- [PASS] **Reintentos y recuperación:** fallo → backoff rechaza reintento inmediato sin duplicar → retry crea instancia nueva (attempt 2, `instanceId` distinto) → completa; `request-changes` deja `failed/changes-requested` reintentable; reconcile interrumpe lo activo, libera huérfanas y `recoverInstance` continúa la misma instancia/intento; `retryTask` imposible con intento activo.
- [PASS] **Multi-run:** steering al run único; `asNewRequest` crea segundo run; ambigüedad con 2+ activos exige `runId`; ambos runs terminan `done` con cronología compartida.
- [PASS] **Triggers persistentes:** kind inválido (INSERT+UPDATE), cross-run, re-anclaje de tasks/plannings, `review_target` fuera de reviewer, `reviewed` sin veredicto, doble intento activo — todos rechazados por la DB.
- [PASS] **UI mínima:** sección plegable con estados, dependencias, bloqueos, intentos y acciones (cancelar/reintentar/aceptar/solicitar-cambios); IPC `tasks.*` validado; `busy` multi-run correcto.
- [PASS] **Live A con modelos reales** (matriz Meta contributor/xhigh): plan→`plan_tasks` real→2 lectoras en paralelo en un tick→implementer desbloqueado por dependencias→fichero con marcador→reviewer desbloqueado por target→veredicto accept→run done; modelo+effort verificados por instancia en `agent_instances.model` + `usage_records`.
- [BLOCKED] **Live B con modelos reales** (Go deepseek-v4.1-flash/max): catálogo exacto resuelto sin fallback; el planner completa la llamada pero el modelo no entrega el contrato `{"tasks":[...]}` con contenido (12 intentos: `task_dag` inventado, luego `{"tasks":[]}`). Limitación del modelo, no del producto; re-ejecutable cuando lo cumpla.

## Bugs reales encontrados por los tests (corregidos)

1. `sameOrInside` mezclaba `\` y `/` en Windows y rompía la contención de scopes (H5). Fix: normalización previa en `path-scope.ts`.
2. `PersistenceService.close()` marcaba `closed=true` antes de enviar el op `close`; el worker nunca cerraba la DB y Windows retenía locks (EBUSY en `cleanup`). Fix: enviar el op antes de marcar cerrado.
3. Orden de equidad empataba con `created_at` iguales; ahora usa `rowid` como secuencia determinista.
4. `TaskPlanner` no enviaba `conversationId` → el backend Go rechazaba (`x-opencode-session required`). Fix: `run.session_id` como `conversationId` (igual que el runtime).
5. `chat-transport` descartaba `input.instructions` → los modelos chat-completions no veían las reglas (el planner recibía DAGs genéricos). Fix: mensaje `developer` antepuesto (paridad con responses-transport).
6. `tool_choice:"auto"` incondicional en ambos transports → 400 del upstream sin tools. Fix: solo con tools presentes.
7. Seed de coordinador con snapshot `'{}'` → `delegation_denied` y tasks atascadas en `assigned`. Fix harness: snapshot real + `TaskManager.failUnstarted` (marca `failed`, no atasca).
8. Reviewer con dependencia en task con `needsReview` = deadlock (solo `reviewed` la satisface, y `reviewed` exige ese veredicto). Fix: regla de validación + test + aviso en el prompt del planner.
9. Presupuesto live insuficiente para xhigh (100k tokens/run bloqueó al implementer). Subido a 10M micro / 500k tokens (acotado, registrado); el gate funcionó como diseñado.

## Estado de etapas anteriores

- Etapa 1 y Etapa 2 intactas: sus suites pasan sin cambios salvo la expectativa documentada de `persistence.test.ts` (`tasks` y tablas Etapa 3 ya existen en latest).

## Fase 3 live — TaskGraph/Planner/Scheduler (modelos reales)

- **Fecha runs:** 2026-10-30/31. Harness: `apps/desktop --octus-acceptance-3` (proceso Electron, claves del almacén del SO, jamás impresas) + variante env `packages/core check:live:stage3`. Sesión y proyecto temporales propios por matriz; sin worktrees automáticos, sin ramas, sin cambiar defaults de producción (solo override de sesión + defaults en DB temporal, precedente de fase 2).
- **Resultado:** matriz A **PASS** (35/35 checks), matriz B **BLOCKED** (el modelo no sigue el contrato de salida del planner tras 12 intentos; evidencia abajo). Exit global 1 por el BLOCKED.

### Matriz A — meta/muse-spark-1.3-contributor/xhigh: PASS (35/35)

Flujo completo con modelos reales: plan → revisión aprobada (decisión simulada) → DAG vía TaskPlanner real → persistencia → 2 lectoras en paralelo en un tick → implementer desbloqueado por dependencias → fichero con marcador → reviewer desbloqueado por target → veredicto accept → run done.

| instanceId | parentInstanceId | definition | provider | modelId | effort |
|---|---|---|---|---|---|
| ins_accept3_A3-meta_1gtg5t | — | coordinator-build | meta | muse-spark-1.3-contributor | xhigh |
| ins_ea33d7b1fec3 | ins_accept3_A3-meta_1gtg5t | explorer | meta | muse-spark-1.3-contributor | xhigh |
| ins_530c3a55b65d | ins_accept3_A3-meta_1gtg5t | explorer | meta | muse-spark-1.3-contributor | xhigh |
| ins_ae8b5047c292 | ins_accept3_A3-meta_1gtg5t | implementer | meta | muse-spark-1.3-contributor | xhigh |
| ins_012fab6b2d09 | ins_accept3_A3-meta_1gtg5t | reviewer | meta | muse-spark-1.3-contributor | xhigh |

Checks (resumen): approve/plan/planmodel/persist(plan,tasks,deps,link) PASS; parallel (2 lectoras en 1 tick) PASS; gatedeps/gaterev (draft mientras corresponde) PASS; limits ({"coordinator":1,"explorer":2}) PASS; readers 2/2 PASS; implunblock/impldone/implfile (marker present) PASS; revunblock/revdone/revidence (review quotes marker, Outcome PASS) PASS; verdict reviewed PASS; rundone done PASS; deliver ×2 PASS; model ×4 (contributor/xhigh) PASS; usage ×4 (2/7/16/3 rows) PASS; nowt (1 isolated dir) PASS.

| matrix | provider | model | calls | in | out | reasoning | cached | cost |
|---|---|---|---|---|---|---|---|---|
| A3-meta | meta | muse-spark-1.3-contributor | 30 | 89738 | 11865 | 9009 | 60726 | cost unknown (sin tarifa live para -contributor) |

Gasto total live (ambas matrices + intentos): ver filas por run en el log; acotado por presupuestos del harness (global $10, 500k tokens/run).

### Matriz B — opencode-go/deepseek-v4.1-flash/max: BLOCKED (contrato del planner)

- Catálogo real refrescado: `deepseek-v4.1-flash` existe (chat-completions, toolCall true, reasoning incluye max). Sin fallback: ID exacto o BLOCKED. **El ID resolvió OK.**
- El planner completó la llamada al modelo en todos los intentos (sin errores de transporte tras los fixes), pero el modelo no entrega el contrato `{"tasks": [...]}` con contenido:
  - Runs 1–2 (sin/con developer-role): `{"dag_id": "generic-...-v1", ...}` inventado + nota "No task-specific requirements were supplied" (falso: brief completo en instructions).
  - Runs 3–4 (con recordatorio de formato en user-message + mandato "no devolver []"): `{"tasks":[]}` — envelope correcto, cero tareas, 3/3 intentos.
  - Total: 12 generaciones del planner, 0 DAGs válidos. No es un bug de transporte ni de validación: el formato llega (el envelope converge run a run), el modelo decide no proponer tareas.
- **Veredicto: BLOCKED por limitación del modelo** (no sigue el contrato de salida del TaskPlanner con effort max). Reintentar cuando el modelo cumpla el contrato, o con otro modelo Go que lo cumpla. No se construyó DAG a mano para no falsear el paso 1 del flujo mandatorio.

### Bugs reales encontrados por el live (todos corregidos salvo B-modelo)

4. `TaskPlanner` no enviaba `conversationId` → el backend Go rechazaba con `x-opencode-session header is required but empty`. El planner nunca podía usar Go. Fix: `run.session_id` como `conversationId` (igual que el runtime).
5. `chat-transport` descartaba `input.instructions` (nunca lo añadía como mensaje developer) → en modelos chat-completions el modelo no veía las reglas del planner (evidencia: "No task-specific requirements were supplied"). Fix: anteponer mensaje developer (paridad con responses-transport, que sí envía instructions).
6. `chat-transport` y `responses-transport` enviaban `tool_choice:"auto"` incondicional → el upstream devuelve 400 sin tools (caso del planner). Fix: solo con tools presentes.
7. Seed del coordinador con snapshot `'{}'` → `delegation_denied` y tasks atascadas en `assigned` (el spawn fallaba y `completeAttempt` no tenía intento que completar). Fix harness: snapshot real vía `snapshotOf` (nuevo export aditivo del índice del core) + endurecimiento del producto: `TaskManager.failUnstarted` marca `failed` en vez de atascarse (con reservas ya liberadas).
8. Un reviewer con dependencia en una task con `needsReview` es un deadlock (la dependencia solo se satisface con `reviewed`, que exige el veredicto de ese mismo reviewer). Fix: regla de validación que lo rechaza + test unitario + frase en el system prompt del planner + chequeo en el harness.
9. Presupuesto del harness insuficiente para xhigh (100k tokens/run bloqueó al implementer a mitad). Subido a 10M micro / 500k tokens por run (acotado y registrado). El bloqueo funcionó como diseñado (Budget gate real ejercitado en vivo).

### Regresión tras los fixes

- Typecheck shared+core+desktop(node/web): PASS. Core: 140/140 tests (incl. nuevo test anti-deadlock). Desktop build + smoke intactos.
- Etapa 1–2: suites verdes; `acceptance.ts` de fase 1–2 sin tocar (solo se añadió fase 3 + flag).

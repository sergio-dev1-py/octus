# DECISIONS.md — Registro de decisiones arquitectónicas (ADR) de Octus

- **Fecha de apertura:** 2026-10-30
- **Convención:** cada decisión tiene estado (`Aceptada`, `Propuesta` = regirá salvo que la etapa indicada la invalide con evidencia), contexto, decisión y consecuencias. Las decisiones del propietario en la sesión del Prompt 0 prevalecen sobre el texto literal del PROMPT MASTER cuando ambos difieren; esas desviaciones quedan registradas aquí, no silenciadas.

## Decisiones del propietario (sesión Prompt 0, 2026-10-30)

1. Octus se construye **desde cero** en `C:\Users\UserPy\Documents\octus`; OpenOrch es solo referencia arquitectónica y de comportamiento.
2. Forma del producto: **desktop Electron + SolidJS** (mismo stack que la referencia).
3. Proveedores: **Meta como principal y OpenCode Go como segundo proveedor; solo esos dos por el momento**.
4. Primera etapa: **Prompt 0** (auditoría y documentos en `.harness/implementation/`), sin código funcional ni dependencias.

---

## ADR-001 — Construcción desde cero en Octus (desviación registrada del PROMPT MASTER)

- **Estado:** Aceptada (propietario, 2026-10-30).
- **Contexto:** el PROMPT MASTER §1–2 ordena evolucionar el proyecto existente y "no reconstruir todo desde cero ni copiar otro proyecto". El proyecto existente del propietario es OpenOrch; el destino elegido, sin embargo, es un repositorio nuevo y vacío (Octus).
- **Decisión:** Octus se implementa desde cero reutilizando de OpenOrch únicamente conceptos, contratos y comportamientos verificados (REUSE_MATRIX), con código y textos propios. OpenOrch queda congelado como referencia: no se modifica su código funcional.
- **Consecuencias:** coste y riesgo mayores que un fork (el runtime de agente es la pieza más cara de reconstruir); a cambio, arquitectura limpia y sin heredar los defectos de AUDIT §10. Mitigaciones: cortes verticales por etapas con pruebas de comportamiento, y requisitos negativos obligados (ADR-015).

## ADR-002 — Stack: monorepo Bun + TypeScript, Electron + SolidJS, SQLite local

- **Estado:** Aceptada.
- **Contexto:** es el stack verificado de la referencia (`package.json`, `apps/desktop/package.json` de OpenOrch) y el elegido por el propietario.
- **Decisión:** monorepo con workspaces Bun (`apps/desktop`, `packages/shared`, `packages/core`), TypeScript estricto, Electron + SolidJS + electron-vite en el escritorio, persistencia local con SQLite mediante `node:sqlite` y fallback JSON. Sin servicios en la nube para el núcleo.
- **Nota (Hito 0, 2026-10-30):** el fallback JSON queda pospuesto a una etapa posterior por ADR-017; la Etapa 1 es solo SQLite.
- **Consecuencias:** máxima transferencia de conocimiento desde la referencia; dependencia de Bun 1.4+ y Node 20+; el empaquetado/instalador queda fuera del alcance inicial (la referencia tampoco lo tiene).

## ADR-003 — Solo dos proveedores: Meta (principal) y OpenCode Go

- **Estado:** Aceptada (propietario).
- **Decisión:** el `ModelRouter` de Octus tendrá exactamente dos adaptadores: Meta Model API y OpenCode Go. No se adoptan el catálogo de 214 proveedores, OpenCode Console/Zen ni proveedores custom arbitrarios en el alcance inicial.
- **Consecuencias:** superficie de integración pequeña y verificable; el diseño del router sigue siendo proveedor-agnóstico en sus interfaces para no acoplar el dominio a Meta (PROMPT MASTER §2.4).

## ADR-004 — Protocolo Meta: Responses API como superficie principal

- **Estado:** Propuesta (se confirma o se revoca con la prueba de Etapa 1; ver §"Pendientes").
- **Evidencia (documentación oficial, 2026-10-30):** Meta recomienda Responses para agentes y tool loops; es la única superficie que conserva el razonamiento entre turnos; Chat Completions no lo conserva para claves externas y puede inducir bucles que pierden el hilo; la guía de agentes de Meta recomienda el adaptador Responses (`@ai-sdk/openai`) precisamente por el replay cifrado. Fuentes: `https://dev.meta.ai/docs/protocols`, `/docs/reasoning`, `/docs/coding-agents`, `/docs/protocols/responses`.
- **Decisión:** el adaptador Meta usará `POST /v1/responses` con replay *stateless* de razonamiento cifrado (`store:false` + `include:["reasoning.encrypted_content"]`) como modo por defecto, por ser la opción recomendada para frameworks de agentes sin estado en servidor y compatible con el carácter local-first de Octus. Chat Completions queda como posible modo de compatibilidad no-agéntico; Messages queda fuera del alcance inicial.
- **Consecuencias:** el contenido cifrado de razonamiento es opaco: se trata como estado ligado al proveedor, nunca se registra en logs ni se muestra; no se almacena cadena de razonamiento legible (PROMPT MASTER §3, "Razonamiento"). El sistema reenvía `instructions`, herramientas y `reasoning` en cada petición (no persisten con `previous_response_id`). El SDK concreto (AI SDK vs. SDK OpenAI) se decide en el spike de Etapa 1 (pendiente P-02).

## ADR-005 — Routing de modelos: Wonder coordina, Spark ejecuta, OpenCode Go alternativo manual

- **Estado:** Aceptada en lo sustantivo; detalles de catálogo de modelos Go, pendientes de verificación (P-03).
- **Decisión:**
  - Coordinador (perfiles Plan/Build): `muse-wonder-1.0`.
  - Subagentes por defecto: `muse-spark-1.3`; Wonder cuando la tarea lo requiera (decisión del coordinador registrada en la Task).
  - OpenCode Go: proveedor alternativo seleccionable por sesión/perfil; **sin fallback automático** entre proveedores en las Etapas 1–2.
  - Solo modelos **Standard**. Las variantes `-contributor` quedan excluidas por defecto: a cambio del descuento, Meta puede usar el contenido enviado para entrenar modelos (documentación de precios); habilitarlas exigirá consentimiento explícito e informado del usuario.
  - El esfuerzo de razonamiento es un parámetro del proveedor por instancia (`minimal|low|medium|high|xhigh|max` según modelo), distinto del plan de trabajo y de la respuesta visible. `max` se ofrecerá solo donde la documentación lo soporta (Wonder y Spark 1.3) y tras confirmar la discrepancia documental detectada (AUDIT §11).
- **Consecuencias:** costes previsibles por rol; los precios/rate-limits verificados (Wonder $4/$20, Spark $1.25/$4.25 por 1M en Standard; 3.000 RPM / 4M TPM por equipo y modelo) alimentarán presupuestos y límites por run en etapas posteriores.

## ADR-006 — Un único coordinador; Plan y Build son perfiles, no agentes rivales

- **Estado:** Aceptada (PROMPT MASTER §4.2).
- **Decisión:** cada sesión tiene un único coordinador. `plan` y `build` son perfiles/modos de interacción del coordinador: Plan analiza y define tareas sin modificar el proyecto (exigible en runtime); Build ejecuta y coordina. Cambiar de perfil no crea una segunda autoridad sobre el repositorio.
- **Consecuencias:** el estado de la sesión registra el perfil activo; el Scheduler solo obedece al coordinador de la sesión.

## ADR-007 — Perfiles de subagente cerrados y múltiples instancias

- **Estado:** Aceptada (PROMPT MASTER §4.3).
- **Decisión:** perfiles iniciales `explorer` (solo lectura), `researcher` (web/documentación, sin modificar el proyecto), `implementer` (escribe solo en su worktree, nunca merge/push/promoción) y `reviewer` (revisa y ejecuta pruebas autorizadas, sin modificar código). No se crea un perfil por trabajador: se instancian múltiples `AgentInstance` del mismo `AgentDefinition`. No habrá perfil "general".
- **Consecuencias:** cada perfil define herramientas permitidas, modelo por defecto, esfuerzo, pasos máximos y plantilla de entrega; el nombre "Scheduler" queda reservado al distribuidor de Tasks (la referencia usa `schedule` para automatización temporal, concepto distinto).

## ADR-008 — Seguridad exigible en runtime, con puerta central

- **Estado:** Aceptada (PROMPT MASTER §2.3, §3).
- **Decisión:**
  - Toda llamada a herramienta pasa por el `ToolGateway`, que valida esquema, identidad de la instancia, permisos efectivos y ámbito (directorio/worktree/scope) **antes** de ejecutar. No existirán herramientas "sin puerta": si una operación no puede autorizarse, no se ofrece.
  - Los permisos por defecto de Octus parten de denegación y se conceden por perfil; la semántica última-regla-gana y la inmunidad del `deny` frente a "siempre" guardados se conserva como concepto de la referencia.
  - Contención de rutas con resolución real (symlinks/junctions) antes de autorizar; autorización de herramientas de búsqueda sobre las rutas efectivamente accedidas.
  - Un prompt nunca concede permisos; los workers no pueden merge/push/promocionar; operaciones destructivas sobre el repo original exigen autorización humana.
  - MCP de proyecto inactivo hasta confianza explícita por workspace.
- **Consecuencias:** el catálogo de herramientas por perfil será más pequeño que el de la referencia al principio; es intencional.

## ADR-009 — Persistencia local y secretos fuera del JSON

- **Estado:** Aceptada.
- **Decisión:** SQLite (`node:sqlite`, WAL) como almacén principal con migraciones versionadas, transacciones y claves foráneas reales; fallback JSON documentado (pospuesto por ADR-017; la Etapa 1 es solo SQLite). Las claves de API y tokens **no** se guardan en texto claro en `config.json` ni se devuelven íntegros al renderer: se almacenan en el mecanismo de credenciales del sistema (en Electron, `safeStorage`/keychain del SO con su API asíncrona; verificación en tabla del Hito 0, live pendiente) y el renderer solo ve estado "configurado/no configurado". Prioridad de lectura: almacén seguro → variable de entorno (`MODEL_API_KEY`, `OPENCODE_API_KEY`).
- **Consecuencias:** se corrige el mayor riesgo de la referencia (AUDIT §10.5); las pruebas usarán almacén en memoria.

## ADR-010 — Memoria diferenciada sin base vectorial inicial

- **Estado:** Aceptada (PROMPT MASTER §8).
- **Decisión:** `MemoryService` con fuentes de verdad diferenciadas: memoria permanente de proyecto, de sesión, de run/task y conversación por instancia, apoyada en archivos del proyecto + SQLite + artefactos verificables. Los hallazgos provisionales no se promueven a reglas permanentes sin aprobación registrada. Sin bases vectoriales en el alcance inicial.
- **Consecuencias:** interfaces de memoria simples y auditables; la búsqueda semántica, si llega, será una extensión posterior.

## ADR-011 — Git: worktree por trabajador, integración intermedia y aprobación por SHA

- **Estado:** Aceptada (PROMPT MASTER §6–7).
- **Decisión:** todo `implementer` trabaja en worktree y rama propios creados solo por el `WorktreeManager`, con commit base registrado, scope de escritura y criterios de aceptación; al terminar registra el commit producido. El `IntegrationManager` integra secuencialmente (serializado por repositorio) en una rama intermedia, valida, prepara preview y espera aprobación humana ligada a un SHA exacto: si el commit cambia o la rama destino se mueve, la aprobación se invalida y se revalida. Nunca push automático. Con cambios locales sin commit en el repo original: no se destruyen ni se ignoran; si no se puede garantizar su preservación, se bloquean escritura/promoción y se comunica.
- **Consecuencias:** el `RepositoryManager` necesita detección de estado sucio y snapshots no destructivos solo si hay implementación probada; en caso contrario, bloqueo (comportamiento por defecto seguro).

## ADR-012 — Reimplementación limpia (sin copiar código de la referencia)

- **Estado:** Aceptada (propietario).
- **Decisión:** no se copia código, prompts ni textos de OpenOrch/OpenCode a Octus. Se estudia el comportamiento (con las referencias de REUSE_MATRIX) y se reimplementa con diseño y redacción propios, con pruebas de comportamiento escritas para Octus.
- **Consecuencias:** la velocidad inicial es menor; se evita heredar defectos y deuda (p. ej. prompts que nombran otro producto, contrato IPC no efectivo).

## ADR-013 — Alcance inicial recortado (fuera, diferido o posterior)

- **Estado:** Aceptada.
- **Decisión:** quedan fuera del núcleo inicial: extensión de navegador Edge/Chrome, navegador dock (Etapa 6), Code Mode (candidato Etapa 6 solo con permisos plenos), automatizaciones por horario (nombre "Automatizaciones", posterior), catálogo masivo de modelos, temas/i18n extensos de la referencia y empaquetado/instalador.
- **Consecuencias:** las Etapas 1–5 se concentran en el harness multiagente; los extras no bloquean el núcleo.

## ADR-014 — IPC tipado efectivo y renderer endurecido

- **Estado:** Aceptada (corrige AUDIT §9.3/§9.4).
- **Decisión:** un único contrato IPC en `packages/shared` consumido por main, preload y renderer (sin `invoke` genérico con casts); validación de emisor y de cargas en el main; `sandbox: true` como meta del BrowserWindow con preload mínimo; renderizado Markdown con sanitizador reconocido (decisión de librería en su etapa, sin sanitizadores regex propios); contenido de páginas/modelo tratado como no confiable.
- **Consecuencias:** más trabajo inicial en la Etapa 1/2 de escritorio a cambio de eliminar la clase de deriva XSS→IPC de la referencia.

## ADR-015 — Requisitos negativos obligados (defectos de la referencia que Octus no reproducirá)

- **Estado:** Aceptada. Cada requisito será una prueba en la etapa que implemente el área.
  1. "Solo lectura" exigible en runtime (sin shell de escritura en perfiles lectores).
  2. MCP de proyecto sin ejecución previa a la confianza del workspace.
  3. Ninguna herramienta sin puerta de permiso y ámbito.
  4. Contención con rutas reales resueltas (symlinks/junctions).
  5. Sin credenciales en claro ni exposición íntegra al renderer.
  6. Compactación que conserva ante el modelo el tramo reciente declarado, con estimación que incluye sistema y herramientas.
  7. Pasos idempotentes: un reintento no duplica texto ni re-ejecuta herramientas con efectos ya aplicadas.
  8. Subagentes con timeout, cancelación en cascada y límites de concurrencia/depth gobernados por el Scheduler.
  9. Persistencia con marcado por sesión (sin estado `dirty` global compartido).
  10. Modelo del perfil aplicable también a agentes primarios (o rechazo explícito y visible de esa configuración, nunca ignorarla en silencio).
  11. Serialización/detección de conflictos entre tool calls que escriben el mismo archivo.
  12. Contenido de proyecto/skills/MCP/páginas etiquetado como no confiable y separado del system prompt.
  13. Fallbacks de modelo/configuración visibles al usuario (nada de degradaciones silenciosas).

## ADR-016 — Calidad por etapas con puertas de salida

- **Estado:** Aceptada (PROMPT MASTER §9).
- **Decisión:** ninguna etapa se da por terminada por "compila": exige implementación conectada, tipos/contratos, manejo de errores, logs sin secretos, pruebas unitarias e integración según el área, documentación actualizada y verificación de no-regresión. No se inicia la etapa siguiente sin completar y validar la actual, con informe de reutilización, archivos, pruebas reales, limitaciones y riesgos (formato §9 del PROMPT MASTER).

## ADR-017 — Etapa 1 solo con SQLite; fallback JSON pospuesto (nuevo identificador, no reutiliza ADR-009)

- **Estado:** Aceptada (propietario, 2026-10-30; plan corregido de la Etapa 1).
- **Contexto:** ADR-009 cubre dos materias (persistencia SQLite + secretos fuera del JSON). La decisión de posponer el fallback JSON es independiente y no debe mezclarse con la de secretos.
- **Decisión:** la Etapa 1 implementa exclusivamente el backend SQLite. La interfaz de persistencia no asumirá un segundo backend y ninguna prueba exigirá paridad JSON. El fallback JSON se diseña e implementa en una etapa posterior con su propia suite de contrato.
- **Consecuencias:** `TARGET_ARCHITECTURE.md` §12 y el roadmap citan ADR-017 (no ADR-009) para esta decisión. Si `node:sqlite` faltara en algún entorno soportado antes de existir el fallback, la app lo comunica y no arranca el almacén (nunca degradación silenciosa).

## ADR-018 — Seguridad de Terminal: aprobación, entorno depurado y proceso confinado (cwd no es sandbox)

- **Estado:** Aceptada (propietario, 2026-10-30; plan corregido de la Etapa 1).
- **Decisión:**
  - Todo comando shell exige aprobación previa del usuario con comando exacto, ejecutable resuelto, `cwd` y timeout visibles. En la Etapa 1 no hay "siempre permitir" para shell ni modo auto-aprobación.
  - El modelo solo aporta comando y un timeout acotado; nunca `env` ni `cwd` fuera del workspace.
  - Entorno construido desde una allowlist mínima (PATH y variables de sistema imprescindibles); jamás hereda el entorno completo y nunca contiene secretos (`MODEL_API_KEY`, `OPENCODE_API_KEY`, tokens del almacén).
  - Timeout por defecto 120 s con tope configurable; la cancelación/timeout termina el **árbol de procesos** (Windows `taskkill /T /F`; POSIX grupo de procesos). Sin shell en segundo plano en la Etapa 1. Salida acotada con artefacto si excede.
  - Declaración honesta en UI y docs: esto reduce el riesgo pero **no es un sandbox**; un comando aprobado puede referenciar rutas absolutas fuera del workspace. El `cwd` confinado es solo el directorio inicial. Un sandbox de SO se evalúa en la Etapa 6.
- **Consecuencias:** pruebas obligatorias de Etapa 1: denegación sin aprobación, entorno hijo sin secretos (fixture que vuelca su entorno), timeout que mata el árbol (hijo que lanza nieto).

## ADR-019 — Control de costes desde la Etapa 1

- **Estado:** Aceptada (propietario, 2026-10-30; plan corregido de la Etapa 1).
- **Decisión:**
  - Tabla `usage_records`: una fila por llamada al proveedor con `provider_id`, `model_id`, `agent_definition_id`, `agent_instance_id`, `run_id`, `session_id`, `input_tokens`, `output_tokens`, `reasoning_tokens`, `cached_tokens`, duración, estado y snapshot de tarifas aplicadas. Coste estimado en entero de micro-USD. En Meta, el razonamiento se tarifa como salida y la caché como subconjunto de entrada.
  - Tarifas versionadas con fuente y fecha (Meta verificada 2026-10-30); sobrescribibles por el usuario. Sin tarifa verificada (caso OpenCode Go no verificado), coste `NULL` con marca `pricing_missing`: nunca se inventa un precio y el control se apoya en límite de tokens.
  - Tabla `budgets` por ámbito (global, proveedor, modelo, definición de agente, sesión, run) con límite, umbral de aviso (80 % por defecto), acción `warn|block` y ventana. El Router comprueba antes de cada generación; con un `block` agotado no se llama al proveedor, se emite `budget.exceeded` y el run termina con error estructurado.
  - Alertas idempotentes `budget.warning` (una vez por cruce) y `budget.exceeded`, visibles en escritorio y logs sin secretos. Límite de tokens por run como guarda independiente del precio.
  - Registro de consumo siempre activo. Sin tope monetario preactivado hasta que el usuario lo fije en Ajustes (la app lo pedirá al configurar proveedores). En pruebas, presupuestos ínfimos para verificar aviso y bloqueo.
- **Consecuencias:** ninguna llamada real a proveedor puede ocurrir sin su fila en `usage_records` (criterio de finalización de la Etapa 1).
- **Aclaración del propietario (Etapa 1):** sin límites guardados por el usuario no hay llamadas de pago en absoluto: el Router bloquea con `budgets_not_configured` hasta que se configuran en Ajustes (verificado en smoke). Los proveedores no facturables (fakes de prueba) están exentos.

## ADR-020 — SQLite fuera del hilo principal de Electron (precisión del propietario, Hito 0)

- **Estado:** Aceptada (Hito 0, 2026-10-30).
- **Contexto:** `node:sqlite` (`DatabaseSync`) es una API totalmente síncrona; invocarla desde el hilo principal bloquearía ventana, IPC y bucle de eventos. Verificado: Bun 1.4.2 expone `node:sqlite` funcional (WAL, FK, transacciones manuales; ver tabla de verificación) pero **sin** el ayudante `db.transaction()` (es `undefined`); Node v24.21.0 expone `node:sqlite` funcional.
- **Decisión:** todo acceso SQLite vive en un **hilo worker dedicado** (`worker_threads`) propietario de la única conexión `DatabaseSync`; el hilo principal (y el renderer, siempre) se comunica con el `PersistenceService` mediante un protocolo asíncrono de mensajes con correlación por id. Transacciones con SQL explícito (`BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`), nunca con ayudantes ausentes en Bun. WAL activado. Ante caída del worker: reinicio, reapertura y liquidación de estados `running` como interrumpidos.
- **Consecuencias:** el mismo worker corre en-proceso bajo Bun en tests. La verificación dentro del proceso Electron real queda como prueba pendiente con binario (comando exacto registrado en la tabla de verificación).

## ADR-021 — OpenCode Go por protocolo nativo de cada modelo (precisión del propietario, Hito 0)

- **Estado:** Aceptada (Hito 0, 2026-10-30).
- **Contexto:** el catálogo público `GET https://opencode.ai/inference/go/v1/models` (200 sin auth, 28 modelos el 2026-10-30) declara por modelo su API nativa en el bloque `api`: 17 en `chat-completions`, 5 en `responses`, 5 en `messages` (Anthropic) y 1 en `generate-content` (Google). La doc de harnesses confirma traducción entre APIs en Console, pero Octus no asume una sola superficie.
- **Decisión:** el adaptador Go encamina **por modelo según su bloque `api` nativo**, con la tabla refrescable desde `/v1/models` y validación de capacidades por modelo (tools, `tool_choice` admitidos, esfuerzos de razonamiento, límites). La Etapa 1 implementa las rutas `responses` y `chat-completions` (SDK oficial OpenAI); las rutas `messages`/`generate-content` solo si la shortlist las incluye (no es el caso inicial). Cabecera `x-opencode-session` estable por conversación siempre (Go la exige: sin ella devuelve 400 `MissingSessionID`, verificado). Modelos `-contributor` excluidos por defecto (ADR-005: entrenan con el contenido).
- **Consecuencias:** shortlist inicial de Go para verificación live (herramientas + coste bajo): `glm-5.3-flash` por defecto, `deepseek-v4.1-flash` como segunda opción. El resto del catálogo queda fuera hasta verificación propia por modelo.

## Pendientes de decisión (actualizado tras el Hito 0 de la Etapa 1, 2026-10-30)

| ID | Cuestión | Estado tras Hito 0 | Nota |
|---|---|---|---|
| P-01 | Confirmar `max` en `reasoning.effort` y límites de salida por modelo | Parcialmente resuelto (documental) | Docs Meta: `max` en `muse-wonder-1.0` y `muse-spark-1.3` (no en `-contributor`); el catálogo Go lo corrobora (sus `muse-spark-*-contributor` declaran esfuerzos hasta `xhigh`, sin `max`). Salida Meta 131072 (guía coding-agents). Falta confirmación live con clave (comando en tabla de verificación). |
| P-02 | SDK del adaptador Meta en TypeScript | **Resuelto: SDK oficial `openai`** | Spike con evidencia (mock Responses + `openai@7.45.1`): tool calling, streaming de argumentos, replay cifrado y uso OK; errores tipados verificados en fuente (`AuthenticationError<401>`, `RateLimitError<429>`). AI SDK (`ai@7.0.158` + `@ai-sdk/openai@4.0.106`) descartado: emite aviso y **descarta `reasoningEffort` en silencio** para IDs desconocidos (Muse), y valida el stream contra esquema OpenAI estricto (frágil ante variantes de Meta). Mismo SDK oficial servirá las rutas `responses` y `chat-completions` de Go. |
| P-03 | Contrato real de OpenCode Go | **Resuelto en lo sustancial** | Base `https://opencode.ai/inference/go` + rutas por API; catálogo público `/v1/models` (28 modelos, bloque `api` nativo por modelo); `x-opencode-session` obligatoria (400 `MissingSessionID` sin ella, verificado); Bearer `OPENCODE_API_KEY`; 401 sin credencial verificado (`Go requires a credential`, envoltorio distinto al de Meta: el adaptador lo normaliza). Coste vía `opencode.allowance` documentado, live pendiente de clave. Shortlist Etapa 1: `glm-5.3-flash`, `deepseek-v4.1-flash` (verificación live de tool calling pendiente). |
| P-04 | Mecanismo concreto de credenciales del SO en Electron/Windows | **Resuelto y verificado live** | API asíncrona de `safeStorage` (`isAsyncEncryptionAvailable`/`encryptStringAsync`/`decryptStringAsync`); la síncrona se elimina en Electron 46. Live en Electron 45.2.0/Windows: disponible + roundtrip OK (smoke de la Etapa 1). Blobs cifrados en `secrets.json`; sin cifrado disponible, fallo cerrado (nunca texto claro). |
| P-05 | Modo Meta alternativo Chat Completions (compatibilidad no agéntica) | Abierto | Solo si un caso real lo pide (tras Etapa 1). |
| P-06 | Estrategia de preview (cómo se ejecuta una integración para mostrarla) | Abierto | Etapa 5. |
| P-07 | Inclusión de Code Mode y navegador | Abierto | Etapa 6, solo con ADR-008 por herramienta compuesta. |
| P-08 | Nombre/marca final del producto y `git init` en Octus | Abierto | Antes de la Etapa 1 (hitos siguientes): `git init` sin commit al arrancar el andamiaje. |

## Verificación de entornos del Hito 0 (2026-10-30, sin claves de proveedor)

| Probe | Comando / método | Resultado |
|---|---|---|
| SQLite bajo Bun real | `bun -e` con `node:sqlite` en archivo temporal: WAL, FK (`PRAGMA foreign_keys=ON` vía `exec`), `BEGIN IMMEDIATE…COMMIT` manual, cascada, reapertura | **OK** en Bun 1.4.2. Hallazgo: `db.transaction()` es `undefined` en Bun → transacciones solo con SQL explícito (recogido en ADR-020). |
| SQLite bajo Node real | `node -e` con `node:sqlite` en archivo temporal: WAL, escritura y relectura | **OK** en Node v24.21.0. |
| SQLite dentro de Electron | Pendiente de binario (no instalado localmente; `node_modules` de la referencia no trae `electron/dist`) | Comando preparado para Hito 1: arrancar Electron mínimo e imprimir `process.versions.node`, abrir DB temporal en WAL, insertar/releer y salir con código. Criterio: mismo SQL explícito que en Bun. |
| `safeStorage` live | Pendiente de binario Electron | Probe preparado: tras `app.whenReady()`, `isAsyncEncryptionAvailable()` → `encryptStringAsync("probe")` → `decryptStringAsync()` y comparar; solo API asíncrona (la síncrona se elimina en Electron 46). |
| Meta sin clave | `GET /v1/models` y `POST /v1/responses` sin `Authorization` | **401** con el envoltorio documentado (`authentication_error`/`invalid_api_key`): base, esquema auth y formato de error verificados. |
| Meta con clave (`max`, límites, tool loop) | Pendiente: sin `MODEL_API_KEY` en el entorno | Script `scripts/check-live.ts` (Hito 1+): `reasoning.effort=max` en `muse-wonder-1.0`, tool call con `call_id` preservado, `previous_response_id` omitido (stateless) + replay cifrado, streaming con terminal `response.completed`. |
| Go catálogo | `GET /inference/go/v1/models` (público) | **200**, 28 modelos con bloque `api` nativo, capacidades (tools/`tool_choice`/esfuerzos), límites y costes (ver ADR-021 y spike Go). |
| Go sin sesión | `POST …/chat/completions` sin `x-opencode-session` | **400** `MissingSessionID`: cabecera obligatoria verificada. |
| Go sin clave | `POST` a `chat/completions` y `responses` con sesión y sin Bearer | **401** `Go requires a credential` (envoltorio `{error:{type,message}}` distinto al de Meta). |
| Go con clave (tool loop, allowance) | Pendiente: sin `OPENCODE_API_KEY` | Live con shortlist (`glm-5.3-flash`, `deepseek-v4.1-flash`): tool call, streaming, campo `opencode.allowance`. |
| Spike SDK Meta | Mock Responses local + `openai@7.45.1` vs `ai@7.0.158`/`@ai-sdk/openai@4.0.106` (instalados solo en `%TEMP%\octus-hito0\sdk-spike`, fuera del repo) | Oficial **gana** (ver P-02). Artefactos del spike en TEMP, desechables; nada instalado en Octus. |

## Fuentes Meta verificadas (2026-10-30)

`https://dev.meta.ai/docs/overview`, `/docs/models`, `/docs/quickstart`, `/docs/authentication`, `/docs/tool-calling`, `/docs/reasoning`, `/docs/protocols`, `/docs/protocols/responses`, `/docs/protocols/chat-completions`, `/docs/protocols/messages`, `/docs/agent-frameworks`, `/docs/coding-agents`, `/docs/sdks`, `/docs/error-handling`, `/docs/pricing-rate-limits`. El detalle está en AUDIT.md §11 y TARGET_ARCHITECTURE.md §8.

## Dependencias fijadas en la Etapa 1 (2026-10-30, versiones exactas)

Runtime: `openai 7.45.1`, `zod 4.6.7`, `electron 45.2.0`, `electron-vite 6.0.0`, `vite 8.3.5`, `vite-plugin-solid 2.11.15`, `solid-js 1.9.18`, `marked 18.1.2`, `dompurify 3.4.17`. Desarrollo: `typescript 5.9.3` (se evita TS 7 por riesgo), `@types/node 24.19.2`, `@types/bun 1.4.4` (solo tipos del runner de pruebas; justificación: `tsc` debe cubrir `test/`). Sin paquete SQLite (se usa `node:sqlite`), sin ripgrep, sin YAML (Etapa 2), sin SDK de Anthropic/Google (fuera de la shortlist de Go).

## Verificación en Electron (Etapa 1, 2026-10-30)

Smoke en Electron 45.2.0 / Node 24.22.1 (cierra los pendientes del Hito 0): `node:sqlite` en main OK, `safeStorage` asíncrona disponible + roundtrip OK, worker de persistencia empaquetado OK, puerta de presupuestos bloquea sin configurar OK, arranque del core + fallo de auth limpio OK. Arranque GUI con autocierre: ventana + preload + renderer sin errores de consola (exit 0).

## Hallazgos de implementación (Etapa 1)
- `db.transaction()` no existe en el `node:sqlite` de Bun 1.4.2: transacciones solo con SQL explícito (recogido en ADR-020).
- `expect().rejects` de Bun retrasa la entrega de mensajes de workers en sus tests: los tests usan ayudante `expectRejects` con try/catch.
- El preload de Electron debe empaquetarse como CJS (`index.cjs`); el main empaqueta core/shared/openai/zod y solo externaliza `electron` (evita fallos de resolución en `out/`).
- La fila de uso se registra **antes** de emitir el evento terminal del stream: un consumidor que corte con `break` no puede saltársela (ADR-019).
- Los pendientes (permisos/preguntas) se registran **antes** de publicar el evento: una respuesta inmediata no se pierde.
- Corrección live (FALLO `meta tool result delivered`): `output_item.added/done` de Responses **no** traen `item_id` de nivel superior (tipos del SDK oficial); la correlación usa `item.id`, y `tool_call.completed` se emite solo ante item terminal `completed` (idempotente por `call_id`, con recuperación desde `response.completed.output`). El replay marca `phase: "commentary"` en assistants con tool calls. Los mocks deben incluir `output_item.added`, `content_part.added/done` con `content_index` y `role` para que el acumulador del SDK no rechace el stream.

## ADR-022 — Aprobación de revisiones exclusiva del usuario

- **Estado:** Aceptada (propietario, Etapa 2).
- **Decisión:** aprobar, rechazar, archivar y exportar son acciones de la aplicación en nombre del usuario, nunca herramientas de modelo. Plan crea/actualiza/consulta; Build solo consulta. El modelo puede solicitar confirmación (`plan.request_approval`), que crea una solicitud vinculada a `(plan_id, revision_id)` exactos; la aprobación se registra por acción explícita (botón en el mensaje o respuesta afirmativa a una solicitud pendiente inequívoca). Build ejecuta exclusivamente la revisión aprobada seleccionada (`runs.plan_revision_id`); si hay una revisión posterior pendiente o ambigüedad, debe pedir selección/aprobación.

## ADR-023 — Ciclo de presentación de revisiones

- **Estado:** Aceptada (propietario, Etapa 2).
- **Decisión:** `plans.current_revision_id` apunta a la última revisión **presentada**; `plans.approved_revision_id` a la última aprobada (independientes). Presentación (`unpresented`/`presented`/`orphaned`) y aprobación (`pending`/`approved`/`rejected`) son ejes separados con fechas y eventos propios. Solo una revisión presentada es aprobable; al interrumpirse un run, las no presentadas pasan a `orphaned` (auditables, jamás aprobables). Contenido estructurado + Markdown inmutables en la misma fila y transacción.

## ADR-024 — Conversación continua Plan/Build

- **Estado:** Aceptada (propietario, Etapa 2).
- **Decisión:** Plan y Build son modos de una única sesión (`session_id` y cronología compartidos). Cada mensaje registra su modo; el contexto del coordinador abarca la conversación de sesión con modos; el cambio de modo no reinicia nada. La UI muestra etiquetas discretas de modo por mensaje, sin tarjetas permanentes ni panel de planes.

## ADR-025 — AgentManager: límites, delegación background y recuperación

- **Estado:** Aceptada (propietario, Etapa 2).
- **Decisión:** delegación por llamada con foreground/background (`delegate`, `agent_status/message/wait/result/cancel`). Límites configurables (defecto: 4 activos/sesión, 6/proyecto, profundidad 2, coordinador incluido). Exclusividad real de directorios por ruta canónica (rechaza solapes). Los hijos en background sobreviven al cierre normal del run y sus entregas se inyectan en el siguiente turno; solo `interrupt`/`agent_cancel` cancela en cascada. Estados persistidos; tras reiniciar, lo activo queda `interrupted` y continuable sin reanudación automática.

## ADR-026 — Aislamiento de Implementer y Git controlado

- **Estado:** Aceptada (propietario, Etapa 2).
- **Decisión:** el directorio del Implementer lo asigna AgentManager desde fuentes registradas por el usuario (nunca ruta libre del modelo); validación canónica (absolutas, relativas, `..`, symlinks, UNC denegadas por defecto) y verificación Git de worktrees declarados (existencia, rama, raíz) sin crearlos ni administrarlos. Git: `git_status`/`git_diff` de lectura para explorer/reviewer/implementer; `git_stage`/`git_commit` controlados solo para Implementer dentro de su ámbito con aprobación; creación/cambio de ramas/worktrees, merge, push, rebase y reset prohibidos para todos, también vía shell.

## ADR-027 — Confianza de instrucciones y compactación compartida

- **Estado:** Aceptada (propietario, Etapa 2).
- **Decisión:** los archivos de instrucciones del repo y el contenido web son **no confiables** por defecto; solo los archivos aprobados explícitamente en ajustes del proyecto son instrucciones confiables. La compactación del coordinador opera sobre la conversación de sesión y el estado autoritativo de planes/entregas se inyecta siempre desde SQLite (nunca depende del resumen). Las conversaciones de subagentes permanecen separadas.

## ADR-028 — Snapshot de definición por instancia

- **Estado:** Aceptada (propietario, Etapa 2).
- **Decisión:** cada instancia conserva `definition_version`, `prompt_hash` y `definition_snapshot` (modelo, esfuerzo, herramientas, permisos, límites) del momento de su creación; el runtime usa la foto al continuar. Los cambios de perfil solo afectan a instancias nuevas. Definiciones builtin en YAML versionado con validación Zod (nueva dependencia `yaml`, justificada por legibilidad de prompts largos).

## ADR-029 — Reviewer en entorno desechable

- **Estado:** Aceptada (propietario, Etapa 2).
- **Decisión:** `test_run` ejecuta comandos de una allowlist explícita del usuario, con argumentos explícitos y sin shell genérico, dentro de una copia desechable del objetivo (sin `.git`, sin accesos externos al workspace protegido, con topes de tamaño/tiempo). La comparación de `git status` es solo evidencia secundaria. No se declara aislamiento absoluto.

## Hallazgos de implementación (Etapa 2)

- UNC denegadas explícitamente en `resolveInScope` e `isolated directories` (antes solo caían por scope): `isUncPath` cubre `\\server\share` y `//server/share`; tests en `path-scope.test.ts` + `.env*`/`protectedRoots`.
- `agents.instances` devuelve `AgentInstance[]` completos (el resumen parcial rompía el contrato IPC tipado): el main no hace casts.
- UI sin tarjetas permanentes ni panel de planes (ADR-024): planes y agentes como `<details>` plegables; etiquetas discretas `[plan]`/`[build]` por mensaje; acciones de usuario (aprobar/rechazar/archivar/exportar/implementar) siempre vinculadas a `(plan_id, revision_id)` exactos.
- Export pide directorio con el diálogo nativo y genera `<planId>-v<version>.md`; nunca sobrescribe (el core rechaza destino existente).
- `check:live` Etapa 2 (15 checks tras MODEL_API_KEY): plan vía tool loop + solicitud/aprobación/implementación fijada, delegate foreground a explorer real, background directo con entrega pendiente; sin MODEL_API_KEY hace SKIP explícito de la Etapa 2.

## ADR-030 — Límites por rol sin integrador

- **Estado:** Aceptada (propietario, Etapa 3).
- **Decisión:** límites de concurrencia por rol además de los globales: 2 implementers, 2 lectores (explorer+researcher) y 1 reviewer activos por sesión. Sin rol integrador y sin límite `integration-op`: la integración es Etapa 5. El coordinador puede delegar a los cuatro perfiles worker (`explorer`, `researcher`, `implementer`, `reviewer`); el Scheduler bloquea con `no-capacity` cuando un límite se alcanza, sin fallar la tarea.

## ADR-031 — Reintentos con instancia nueva e historial preservado

- **Estado:** Aceptada (propietario, Etapa 3).
- **Decisión:** cada reintento crea una NUEVA AgentInstance y una nueva fila `task_attempts` (nunca reutiliza ni borra intentos). Solo `failed`/`interrupted` son reintentables, con tope configurable (`maxAttemptsPerTask`, defecto 3) y backoff (`backoffBaseMs`, defecto 1000 ms) medido desde el intento anterior. Nunca hay dos intentos activos para una tarea (índice único parcial + guarda en `retryTask`). El brief del reintento incluye el contexto del intento anterior (resumen, error, entrega parcial).

## ADR-032 — Idempotencia de planificación con auditoría de rechazos

- **Estado:** Aceptada (propietario, Etapa 3).
- **Decisión:** `createDag` es idempotente por `(run, plan, revisión, request_hash)`: repetir la misma clave devuelve el DAG ya creado (`created: false`); una propuesta inválida registra un planning `rejected` con el motivo, y reutilizar su hash se rechaza hasta que el coordinador re-planifique con un `nonce` explícito. El hash deriva de objetivo+brief+nonce; las propuestas vagas, tools no autorizados, scopes fuera de ámbito o comandos fuera de la allowlist se rechazan con motivos accionables en español.

## ADR-033 — Anclaje exacto a la revisión aprobada

- **Estado:** Aceptada (propietario, Etapa 3).
- **Decisión:** `plan_tasks` y `createDag` exigen la revisión con `approval = 'approved'` exacta: o bien `(planId, revisionId)` explícitos, o bien la revisión a la que el run está fijado (`runs.plan_revision_id`). Sin auto-selección ni fallback silencioso: sin revisión aprobada se devuelve `needs-approval`/`plan_conflict`. Implementar otra revisión distinta a la aprobada es `plan_conflict`.

## ADR-034 — Equidad round-robin con cursor persistido

- **Estado:** Aceptada (propietario, Etapa 3).
- **Decisión:** el Scheduler ordena runs elegibles por rotación estricta entre runs (cursor `scheduler_fairness.last_run_id` por sesión) y, dentro del run, por prioridad desc, creación asc e id asc. Una asignación por run y vuelta como máximo. El cursor solo avanza al asignar de verdad (nunca al bloquear).

## ADR-035 — Reservas atómicas de capacidad y scopes con reconciliación

- **Estado:** Aceptada (propietario, Etapa 3).
- **Decisión:** cada asignación adquiere en un solo `batch` atómico las reservas `slot-session`/`slot-project`/`slot-role` más una `scope-write` por scope canónico, además de verificar solape padre/hijo contra reservas activas (igualdad e inclusión en ambas direcciones). Carrera o solape → `blocked/no-capacity`, sin duplicar. `reconcile()` (post-reinicio) interrumpe lo activo, elimina reservas huérfanas y re-bloquea escritores duplicados residuales conservando al más antiguo.

## ADR-036 — TaskGraph como módulo puro

- **Estado:** Aceptada (propietario, Etapa 3).
- **Decisión:** `task-graph.ts` es lógica pura sin modelos ni efectos: adyacencia, detección de ciclos con camino explícito, clausuras transitivas en ambas direcciones, ready-gate (`completed`, o `reviewed` cuando la dependencia lo exige vía `needsReview`), cascada de cancelación que conserva `completed`/`reviewed` e independientes, y orden determinista (prioridad, creación, id).

## ADR-037 — Triggers separados e inmutabilidades persistentes

- **Estado:** Aceptada (propietario, Etapa 3).
- **Decisión:** SQLite no admite `OR` entre INSERT y UPDATE en triggers: cada regla (`task_dependencies.kind`, dependencias misma-run/misma-planning/mismo-proyecto, anclaje `tasks.run_id/planning_id`, `plannings`, `review_target_task_id`, `reviewed` solo con veredicto `accept` registrado) tiene triggers INSERT y UPDATE separados. `review_target_task_id` solo en reviewer tasks e inmutable; `reviewed` exige veredicto `accept` vinculado (también en INSERT).

## ADR-038 — Unicidad de intento activo

- **Estado:** Aceptada (propietario, Etapa 3).
- **Decisión:** índice único parcial sobre `task_attempts(task_id)` donde `status IN ('pending','running')`: la base de datos (no solo el código) impide dos intentos activos por tarea. `startAttempt` y `retryTask` además lo verifican antes de insertar.

## ADR-039 — Multi-run por sesión con steering gobernado

- **Estado:** Aceptada (propietario, Etapa 3).
- **Decisión:** `prompt(sessionId, text, onStream?, {asNewRequest?, runId?})`: con un solo run activo el texto es steering al mismo run; con 2+ activos sin `runId` se exige desambiguación (`invalid_state`); `asNewRequest` crea otro run en la misma sesión y cronología. La generación del coordinador se serializa por sesión con cadena de promesas (un turno cada vez) mientras los runs coexisten; `setSessionProfile` e `implementPlanRevision` ya no exigen sesión sin runs (el run nuevo fija su propio `mode`).

## ADR-040 — Recuperación explícita, nunca automática

- **Estado:** Aceptada (propietario, Etapa 3).
- **Decisión:** tras reinicio, `settleInterrupted` marca `interrupted` las instancias ligadas a tasks (las de delegación simple siguen a `cancelled`) y `tasks.reconcile()` interrumpe tasks/attempts activos. `recoverInstance` continúa la MISMA instancia y MISMO intento solo por acción explícita (usuario o coordinador); `retryTask` crea instancia nueva solo sobre `failed`/`interrupted` sin intento activo. Sin reanudación automática.

## ADR-041 — UI mínima de tareas

- **Estado:** Aceptada (propietario, Etapa 3).
- **Decisión:** la UI muestra la lista de tareas como `<details>` plegable (estado, rol, intento, dependencias, motivo de bloqueo, intentos, acciones cancelar/reintentar/aceptar/solicitar-cambios), sin panel lateral ni editor visual de DAG. El store refresca ante eventos `task.*/planning.*/review.*/scheduler.*`; `busy` deriva de runs en `planning`/`executing` (correcto con multi-run). Canales IPC `tasks.list/get/cancel/retry/review/scheduler` validan carga, sin `invoke` genérico.

## ADR-042 — Determinismo de pruebas con fakes bloqueantes

- **Estado:** Aceptada (propietario, Etapa 3).
- **Decisión:** los fakes usan turnos `question` como función de la longitud de entrada para hijos deterministamente bloqueados (el explorer tiene `question` denegado: las pruebas de bloqueo usan implementer). `expectRejects` en vez de `expect().rejects` (los mensajes de workers se retrasan en Bun 1.4.2). `cleanup` usa `rm` asíncrono con reintentos nativos para EBUSY de Windows.

## Hallazgos de implementación (Etapa 3)

- `sameOrInside` normaliza separadores a `/` y minúsculas en Windows antes de comparar: mezclar `\` y `/` rompía la contención de scopes (bug real encontrado por los tests H5; fix en `path-scope.ts` con regresión en `path-scope.test.ts` intacta).
- `PersistenceService.close()` enviaba el op `close` DESPUÉS de marcar `closed=true`, así que `call` lo rechazaba y el worker nunca cerraba la DB (locks EBUSY en Windows tras `cleanup`); ahora el op se envía antes de marcar cerrado (bug real encontrado por la suite del scheduler).
- Orden de runs por `rowid` (no solo `created_at`) en equidad: varios runs creados en el mismo milisegundo empataban y la rotación no era determinista.
- El auto-tick del Scheduler solo escucha eventos externos (`run.created`, terminales de instancia); sus propias mutaciones re-evalúan explícitamente para evitar tormentas y carreras en `cleanup`.

## Hallazgos de validación live (Etapa 3, matrices A/B con modelos reales)

- `TaskPlanner` no enviaba `conversationId` al router: el backend Go exige `x-opencode-session` y rechazaba la llamada. El planner nunca podía usar Go. Fix: `run.session_id` como `conversationId`, igual que el runtime (`task-planner.ts`).
- `chat-transport` descartaba `input.instructions` (nunca lo añadía como mensaje): los modelos chat-completions no veían las reglas del planner y devolvían DAGs genéricos ("No task-specific requirements were supplied"). Fix: anteponer mensaje `developer` (paridad con responses-transport, que sí envía `instructions`).
- `tool_choice: "auto"` incondicional en `chat-transport` y `responses-transport`: el upstream devuelve 400 cuando no hay tools (caso exacto del planner, que no usa tools). Fix: solo incluir `tool_choice`/`parallel_tool_calls` con tools presentes.
- Seed de coordinador con `definition_snapshot: '{}'` en el harness → `delegation_denied` al spawnear workers y tasks atascadas en `assigned` (el `completeAttempt` de recuperación no encontraba intento activo y tragaba el error). Fix en dos niveles: snapshot real vía `snapshotOf` (nuevo export aditivo del índice del core) + `TaskManager.failUnstarted` que marca `failed` con evento en vez de atascarse (reservas ya liberadas por el scheduler).
- Un reviewer con dependencia en una task con `needsReview` es un deadlock estructural (la dependencia solo se satisface con `reviewed`, que exige el veredicto de ese mismo reviewer). Nueva regla de validación que lo rechaza con mensaje accionable + test unitario + aviso en el system prompt del planner (`PLANNER_SYSTEM`) + chequeo en el harness live.
- Presupuesto live insuficiente para xhigh (100k tokens/run bloqueó al implementer a mitad de la matriz A): el Budget gate funcionó como diseñado (`budget_exceeded`). Subido a 10M micro / 500k tokens por run en el harness (acotado y registrado en el informe).
- Matriz B (Go/deepseek-v4.1-flash/max): tras los fixes de transporte, el modelo responde al contrato de formato pero devuelve `{"tasks":[]}` de forma estable (12 generaciones). No es bug de producto: queda BLOCKED como limitación del modelo con effort max. El harness live vive en `apps/desktop --octus-acceptance-3` (claves del almacén del SO, proceso Electron) con variante env `packages/core check:live:stage3`; filtro por matriz con `OCTUS_ACCEPT_MATRIX=a|b|both`; requiere `--user-data-dir` del perfil real para descifrar (`@octus/desktop`).

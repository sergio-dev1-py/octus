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

## ADR-043 — RepositoryManager de solo lectura

- **Estado:** Aceptada (propietario, Etapa 4).
- **Decisión:** `RepositoryManager` (`packages/core/src/repositories/repository-manager.ts`) solo inspecciona: raíz (`rev-parse --show-toplevel`), rama, HEAD, contadores staged/unstaged/untracked (`status --porcelain=v1`), ramas, `git worktree list --porcelain`, `git-common-dir` y operaciones incompletas (MERGE_HEAD / CHERRY_PICK_HEAD / REBASE_HEAD / rebase-merge / rebase-apply). `validateRepository` exige repo git con HEAD resoluble y sin operación incompleta; sin efectos. Toda invocación git pasa por `git-exec.ts` (argv por array, cwd explícito, timeout 60s, sin concatenación).
- **Consecuencias:** ningún manager modifica el repo principal por inspección; el estado sucio/incompleto se comunica, no se repara.

## ADR-044 — WorktreeManager propietario único: ramas, paths y journal

- **Estado:** Aceptada (propietario, Etapa 4).
- **Decisión:** `WorktreeManager` (`packages/core/src/worktrees/worktree-manager.ts`) es el único que crea worktrees/ramas gestionadas. Un worktree por task (`UNIQUE(task_id)`; re-solicitar reutiliza, con carrera resuelta por el índice). Ramas `harness/run-<runId>/task-<taskId>` validadas con `check-ref-format`, con sufijo `-rN` ante colisión ajena preexistente. Paths planos `<worktrees_root>/<taskId>/`, ruta canónica (`realpathSync`) guardada. Cada operación deja journal en `worktree_ops` (started→done/failed con paso y detalle). `AgentManager` solo consume vía puerto `WorktreePort.getAssignment` (sin ciclo de imports).
- **Consecuencias:** trazabilidad rama↔task↔base sin duplicados; colisiones ajenas no rompen la provisión.

## ADR-045 — Repositorio sucio: construir desde HEAD sin tocar al usuario (P1)

- **Estado:** Aceptada (propietario, Etapa 4).
- **Decisión:** con cambios locales sin commit, el worktree se crea desde HEAD y se registra `dirty_excluded=1` con resumen `staged/unstaged/untracked (created from HEAD; local changes NOT included)`. Nunca se copian, mueven ni simulan los cambios locales dentro del worktree; nunca `reset/clean/stash/checkout` sobre el repo del usuario. El resumen queda visible en la fila, el evento y la UI. Las escrituras del implementer siguen pasando por la puerta de permisos existente (ask/allow), no hay vía libre por estar "aislado".
- **Consecuencias:** el usuario nunca pierde trabajo local por provisión; el agente nunca cree disponer de cambios que no están en su worktree.

## ADR-046 — Reviewer lee el worktree del target sin tomarlo (P2)

- **Estado:** Aceptada (propietario, Etapa 4).
- **Decisión:** el Scheduler resuelve el worktree de `reviewTargetTaskId` y spawnea al reviewer con `directory` = worktree del target (`worktreeId` = target, `reviewTargetTaskId` = target). `AgentManager.resolveDirectory` acepta el worktree ajeno solo si el rol es `reviewer` y el task coincide con `reviewTargetTaskId`; estados legibles: `available/assigned/running/suspended/finished/retained` (finished es lo normal al revisar). El reviewer no hace `markRunning` sobre el worktree ajeno (no lo toma). Su perfil sigue sin herramientas de escritura; `test_run` continúa en copia desechable, nunca modifica el worktree original.
- **Consecuencias:** la revisión observa el `produced_commit` exacto sin carreras de propiedad; sin bypass de permisos por rol.

## ADR-047 — Raíz de worktrees hermana de dataDir, configurable por proyecto (P3)

- **Estado:** Aceptada (propietario, Etapa 4).
- **Decisión:** por defecto `<dataDir>/../octus-worktrees/<projectId>` (fuera del repo y fuera de dataDir). `setWorktreesRoot` por proyecto exige ruta absoluta, no UNC (rechazo antes de tocar FS), fuera de dataDir y fuera del repo (comparación canónica `realpathSync` + `sameOrInside`), y sin worktrees activos. Sin worktrees activos previos, el cambio es seguro.
- **Consecuencias:** los worktrees nunca contaminan el workspace ni la BD; la ubicación es auditable y movible por proyecto.

## ADR-048 — Base por escritor único; multi-escritor bloqueado sin merges

- **Estado:** Aceptada (propietario, Etapa 4).
- **Decisión:** base del worktree: HEAD sin predecesores, HEAD con solo predecesores lectores, o `produced_commit` del único writer-predecesor (`base_source='task:<id>'`, verificado con `commitExists`). Con ≥2 predecesores implementer directos → `blocked/deps-unavailable` explícito (estructural en `promoteDrafts` + dinámico en `ensureForTask`), re-evaluable si el DAG cambia. Sin merges en Etapa 4 (puerta de Etapa 5).
- **Consecuencias:** la cadena writer→writer hereda bytes reales del predecesor; el diamante de escritores se comunica en vez de corromperse.

## ADR-049 — Commit harness y reintento sobre el mismo worktree

- **Estado:** Aceptada (propietario, Etapa 4).
- **Decisión:** al completar un implementer, el Scheduler hace `git add -- <scopes-relativos-al-repo>` + `commit --no-verify` con identidad fija `Octus Harness` dentro del worktree y registra `produced_commit` (árbol limpio → `produced = base`, sin commit vacío). Luego `markFinished` (retiene el espacio). Fallo/cancelación → `releaseWorktree` (conserva parciales). `retryTask`/`recoverForRetry` reutilizan el MISMO worktree (intento++), nunca provisionan otro. Cancelación en cascada → worktree a `finished` retenido, sin auto-borrado.
- **Consecuencias:** cada task escritora deja un SHA auditable para dependientes e Integración futura; reintentar no pierde progreso parcial.

## ADR-050 — Sin auto-borrado: limpieza explícita y reconciliación post-reinicio

- **Estado:** Aceptada (propietario, Etapa 4).
- **Decisión:** solo `cleanupWorktree` explícito del usuario elimina el worktree físico (`git worktree remove`). Guardas: sin agentes activos; árbol limpio (sucio → rechazo con resumen, sin flag force en Etapa 4). La rama se conserva por defecto; `deleteBranch` solo si el tip == base. Tras reinicio, `reconcile()`: ops `started` se resuelven contra git (provisioning con físico→available, sin físico→orphaned; cleanup interrumpida→reabierta o cerrada), `assigned/running`→`suspended` reutilizable sin auto-run (ADR-040), y barrido de huérfanos en ambas direcciones (físico harness/* sin fila → fila `orphaned` con base real o marcador; fila sin físico → `orphaned`). Las ramas con trabajo producido se conservan para Etapa 5.
- **Consecuencias:** ningún crash ni retry destruye evidencia; los huérfanos quedan visibles para decisión humana.

## ADR-051 — Scheduler con worktrees: oleadas, motivos re-evaluables y reviewer

- **Estado:** Aceptada (propietario, Etapa 4).
- **Decisión:** `tickInner` corre hasta 4 oleadas asignar→supervisar para despertar dependientes en el mismo tick en sesión quieta (mismo orden/equidad por oleada; la oleada 1 conserva el comportamiento previo). Nuevos `blockedReason` re-evaluables: `no-repository` (proyecto no-git → camino legacy con directorios aislados, sin worktree), `repo-blocked` (repo inválido/incompleto), `deps-unavailable` (base no lista o multi-writer). `draft→blocked` añadido a transiciones (aditivo). `failUnstarted` marca `failed` si el spawn muere antes del attempt (evita assigned-atascado).
- **Consecuencias:** el DAG con worktrees no necesita ticks externos para progresar; el legacy no-git sigue funcionando intacto.

## ADR-052 — Aislamiento Etapa 4: .git tabú, git_diff con base, UNC y UI mínima

- **Estado:** Aceptada (propietario, Etapa 4).
- **Decisión:** `resolveInScope` deniega cualquier segmento `.git` (el worktree expone `.git` como puntero, su contenido es tabú). `git_diff` acepta `base` SHA (4–40 hex, default HEAD) para que el reviewer compare contra `produced_commit`/`base_commit` sin shell. UNC denegadas en worktrees root, candidatos y validación. Scopes del implementer se resuelven repo→relativo→worktree con contención en ambos extremos. UI/IPC mínimos: `repos.inspect/setWorktreesRoot`, `worktrees.list/get/cleanup`; sección plegable con rama, base/produced, dirty_excluded, operaciones y guarda de limpieza; `busy` sin cambios.
- **Consecuencias:** el agente no lee ni escribe metadatos git por herramientas de ficheros; la revisión tiene el diff exacto sin salir del gateway.

## Hallazgos de implementación (Etapa 4)

- Batch `worktrees`+`worktree_ops`: el INSERT de la op (FK a worktrees) iba primero y violaba la FK; el orden correcto es fila worktree → op (bug real encontrado por el primer test con git real).
- `setWorktreesRoot` tragaba su propio `throw` dentro del `try` de `repoRootOf`: el rechazo "dentro del repo" nunca se lanzaba (bug real: el catch de no-git capturaba el throw de validación). Ahora `repoRoot` se resuelve fuera del try de validación.
- `runGit(rev-parse HEAD)` falla de forma transitoria en Windows (AV/indexador bloquea `.git` recién creado): reintentos acotados (hasta 4, 250 ms) solo en lecturas de verificación (`validateFreshWorktree`, commit harness). Sin reintentos en escrituras.
- Carrera test/producto: la task pasa a `completed` antes de que el mismo tick termine commit+`finished`; los tests esperan al worktree (`untilWorktrees`), no solo a la task.
- Reviewer spawneado en el mismo tick en que el target pasa a `finished`: el gate solo aceptaba estados activos y el spawn moría. Fix por rol: el reviewer acepta `finished/retained` y no hace `markRunning` ajeno.
- Dependientes quietos: tras `supervise`, nadie re-evaluaba en sesión sin eventos externos (B esperaba la review de A eternamente). Fix: oleadas acotadas (4) asignar→supervisar en el mismo tick; invariante de orden/equidad por oleada preservado; regresión Etapa 3 actualizada a invariante determinista (serialización por límites, sin duplicados).
- Trigger `worktrees.task_id IS NULL`: bloqueaba registrar huérfanos físicos sin task; ahora NULL solo permitido con `status='orphaned'` (auditoría de reconcile).
- Comparación de paths git vs `realpathSync` en Windows (`/` vs `\`, mayúsculas): el producto usa `samePath` normalizado; los tests comparan normalizado.
- `git worktree list --porcelain` con `prunable`/`locked`/`bare`/`detached`: el parser cubre las claves observadas en git real de Windows.

## Hallazgos de validación live (Etapa 4, matriz A con modelos reales)

- Matriz A (meta/muse-spark-1.3-contributor/xhigh): **PASS 35/35** en 62 s (`--octus-acceptance-3`, `--user-data-dir=@octus/desktop` para descifrar safeStorage). Flujo: plan→planner real→2 lectoras en 1 tick→implementer en worktree auto-aprovisionado (`harness/run-…/task-…`, sin directorios aislados pre-registrados)→commit harness con `produced_commit`→reviewer corriendo dentro del worktree del target→veredicto accept→run done. Modelos y usage verificados por instancia (25 llamadas, 59662 in / 6471 out).
- Sin claves visibles: el harness solo registra `meta=true go=true`. Primera ejecución falló con `credential missing` por usar el `userData` de Electron por defecto en vez del perfil real; relanzar con `--user-data-dir="$env:APPDATA\@octus\desktop"` lo resuelve (mismo requisito documentado en Etapa 3).
- Matriz B no re-ejecutada en Etapa 4 (limitación del modelo documentada en Etapa 3, sin cambios de transporte en esta etapa).

## Hallazgos de validación live (Etapa 4, matriz A con modelos reales)

- Matriz A (meta/muse-spark-1.3-contributor/xhigh): **PASS 35/35** en 62 s (`--octus-acceptance-3`, `--user-data-dir=@octus/desktop` para descifrar safeStorage). Flujo: plan→planner real→2 lectoras en 1 tick→implementer en worktree auto-aprovisionado (`harness/run-…/task-…`, sin directorios aislados pre-registrados)→commit harness con `produced_commit`→reviewer corriendo dentro del worktree del target→veredicto accept→run done. Modelos y usage verificados por instancia (25 llamadas, 59662 in / 6471 out).
- Sin claves visibles: el harness solo registra `meta=true go=true`. Primera ejecución falló con `credential missing` por usar el `userData` de Electron por defecto en vez del perfil real; relanzar con `--user-data-dir="$env:APPDATA\@octus\desktop"` lo resuelve (mismo requisito documentado en Etapa 3).
- Matriz B no re-ejecutada en Etapa 4 (limitación del modelo documentada en Etapa 3, sin cambios de transporte en esta etapa).

## ADR-053 — IntegrationManager: interlink branch + worktree, 13 verificaciones, FF/merge

- **Estado:** Aceptada (propietario, Etapa 5).
- **Decisión:** `IntegrationManager` (`packages/core/src/integration/integration-manager.ts`) es el único que crea la rama intermedia `harness/integration/run-<runId>` (+`-rN` ante colisión) y su worktree (`<worktrees_root>/integrations/run-<runId>[-a<attempt>]`, ruta canónica validada). `createForRun` es idempotente por run abierto; `incorporateCommit(task, attempt)` exige 13 verificaciones en orden: task existente, produced registrado, mismo proyecto/repo (commit existe en el repo), HEAD del worktree, escritores previos ya incorporados (orden topológico observado, no asumido), diff limitado al write_scope (sin `.git`, sin secretos `isSecretBasename`), y attempt == último completado (sin contenido rancio). Estrategia: contenido→skip (FF implícito), FF posible→`merge --ff-only`, resto→`merge --no-ff` con identidad harness; conflicto→`merge --abort` inmediato (la rama nunca queda con MERGE_HEAD) + fila abierta. `UNIQUE(integration, task, attempt)` hace idempotente la re-incorporación. Sin rebase/squash/cherry-pick (preservan procedencia). `runSuite*` corre al ensamblar (Etapa 5.4).
- **Consecuencias:** cada commit asentado queda trazado (original/integrated SHA, task, intento, instancia, worktree); ningún SHA entra sin verificación.

## ADR-054 — Work bases para múltiples predecesores escritores (§B)

- **Estado:** Aceptada (propietario, Etapa 5).
- **Decisión:** `ensureWorkBaseForTask` (puerto `IntegrationPort`, consumido por `WorktreeManager.resolveBase` cuando hay ≥2 writers) construye la rama `harness/workbase/run-<R>/task-<T>` fusionando los `produced_commit` revisados en orden determinista (FF cuando es ancestro, merge `--no-ff` si no). Idempotente por task con mismos SHAs (`reused`); con predecesores no revisados o sin produced → `blocked/deps-unavailable` re-evaluable; con conflicto → fila abierta + blocked con `{conflict:true}` (el flujo §C la resuelve). `WorktreeManager` deriva el worktree del dependiente desde el tip (`baseSource='workbase:<id>'`); `sweepOrphans` ignora `harness/integration|workbase|resolution/*` (espacios del IntegrationManager). Reconcile marca workbases sin físico como `stale` (el próximo ensure reconstruye: contenido derivado, reproducible).
- **Consecuencias:** el diamante de escritores de la Etapa 4 (`deps-unavailable` estructural) ahora progresa sin merges a main; la workbase nunca promociona nada por sí sola.

## ADR-055 — Auto-build P1: crear + incorporar + validar sin tick externo

- **Estado:** Aceptada (propietario, Etapa 5).
- **Decisión:** con todos los escritores revisados, el Scheduler auto-construye: `buildIntegrationForRun` (create idempotente + incorporate + suite) se invoca desde `finishRunIfDone` (runs git con escritores van a `integrating` en vez de `done`; legacy no-git conserva `done`) y desde un pase `settleIntegratingRuns` al final de cada tick (el veredicto llega por acción explícita fuera de `supervise`; sin este pase el run quedaría en `executing` eternamente). `settleInterrupted` protege runs con integración abierta (`building/conflicted/validating/preview_ready/approved`) y reconcilia tasks→worktrees→integrations→promotions. Nuevo evento `run.status_changed`.
- **Consecuencias:** preview, aprobación y promoción siguen siendo manuales; el auto-build solo deja el ensamblado validado listo.

## ADR-056 — Resolución asistida de conflictos (§C)

- **Estado:** Aceptada (propietario, Etapa 5).
- **Decisión:** `ConflictManager` prepara un worktree de resolución `harness/resolution/<conflictId>` reproduciendo el merge (MERGE_HEAD vive SOLO ahí), spawnea un implementer con selector validado (`resolutionWorkspaceId`, solo implementer, estados open/resolving, sin rutas libres) y brief estricto (solo ficheros del conflicto, prohibido commitear). `finalizeResolution` verifica: merge state intacto (HEAD==ours, MERGE_HEAD==theirs), cambios ⊆ scope (vía `status --porcelain`, que sí ve untracked; `git diff` solo no bastaba — bug real encontrado por tests), sin secretos/`.git`, y fija el merge commit con el harness (padres intactos). `incorporateResolution` verifica padres (M^1==head, M^2==theirs) e integra con FF + fila `resolution`. Reutilización: misma pareja (ours, theirs) ya resuelta y padres aún válidos → sin agente. Sin resolución forzada; sin auto-reset; ramas/worktrees de resolución se conservan para auditoría (`cleanupResolutionWorkspace` explícito).
- **Consecuencias:** el agente propone, el harness dispone; la rama de integración nunca ve un merge a medias.

## ADR-057 — ValidationService: suite por SHA, skipped explícito, gate antes de aprobar

- **Estado:** Aceptada (propietario, Etapa 5).
- **Decisión:** `ValidationService` ejecuta la unión de `validationCommands` de las tasks incorporadas para el SHA exacto, en copia desechable (`TestRunner`, allowlist del proyecto; fuera de la allowlist → `blocked` sin ejecutar, nunca comandos arbitrarios). Idempotente por (integration, sha, kind, entry); `force` borra y re-ejecuta. Sin comandos → fila `suite/skipped` con motivo (P4: skipped ≠ passed, pero no bloquea). Gate: cero failed/blocked/pending/running + review `accept` registrada para ese SHA. La review de integración la registra una acción explícita (`recordIntegrationReview`) que exige instancia reviewer completada corriendo DENTRO del worktree de integración (igualdad de ruta canónica).
- **Consecuencias:** "suite passed" siempre significa ejecutada y verde sobre el SHA exacto; lo no aplicable queda registrado, no silenciado.

## ADR-058 — PreviewManager: detached sobre el SHA, allowlist, sin sandbox fingido

- **Estado:** Aceptada (propietario, Etapa 5; cierra P-06).
- **Decisión:** `PreviewManager` provisiona un worktree detached en el SHA exacto (`<worktrees_root>/previews/<id>`), ejecuta fases `install` (secuencial, debe salir 0) y arranca UNA entrada `start` de la allowlist por proyecto (`preview.allowlist`, configurada por el usuario; sin autodetección de package.json — P3). Env por allowlist + `OCTUS_PREVIEW_*` (PORT/HOST/URL/DATA_DIR/SHA) con assert fail-closed anti-secretos; DB de prueba separada (`<dataDir>/previews/<id>`); localhost por convención; puertos dinámicos con sonda TCP; `killTree` al detener; logs acotados (5 MB). Estados `starting/running/reachable/stopped/completed/failed/orphaned`; reconcile marca huérfanos sin matar pids ajenos. Declaración honesta: allowlist + sin secretos + dir separado + localhost NO es un sandbox (línea ADR-018).
- **Consecuencias:** el preview corresponde al SHA registrado (`shaMatchesHead` verificado en inspección); URL y logs auditables; la app del usuario nunca se ejecuta en su workspace.

## ADR-059 — Aprobación pinneada al SHA con invalidación (P2, P4, P5)

- **Estado:** Aceptada (propietario, Etapa 5).
- **Decisión:** `ApprovalService.approveIntegration` exige integración `validating|preview_ready` + gate verde + (preview reachable sobre el head | waiver con motivo explícito). La fila `integration_approvals` es inmutable y pinnea (integration, head, preview|waiver, target_branch, target_sha_observado, hash de validaciones, actor='user', fecha); `UNIQUE(integration, head)`: duplicado idéntico → idempotente; decisión distinta → rebuild. `checkApproval`/`getApprovalStatus` re-verifican todo en vivo (HEAD físico y de fila, destino inmóvil, validaciones sin cambios, preview reachable). Cualquier cambio posterior invalida (evento `approval.invalidated`); la aprobación nunca autoriza una versión nueva. `rejectIntegration` es terminal (run → `rejected`, P2); re-decidir exige rebuild. Waiver prohibido si existe cualquier preview para ese head (P5: no ocultar previews aplicables; borrarlo explícitamente es la vía).
- **Consecuencias:** aprobar es un acto humano auditable ligado a bytes exactos; el rechazo conserva todo para auditoría sin auto-borrado.

## ADR-060 — PromotionManager: CAS o FF limpio, sin push, reconciliación que determina

- **Estado:** Aceptada (propietario, Etapa 5).
- **Decisión:** `promoteIntegration` exige aprobación vigente (re-verificada) e integración `approved`. Pre-cheques: destino resoluble e inmóvil (CAS contra `expectedOldSha`), checkout del destino limpio y sin operaciones git pendientes (nunca stash; si sucio → bloqueo con mensaje accionable), preview/validaciones re-verificadas. Destino checked-out → `merge --ff-only` allí; no checked-out en ningún worktree → `update-ref <target> <new> <old>` atómico; verificación posterior del tip. Journal `promotion_ops`; run `promoting` → `done`. Cero código de push en el producto (test J26 lo audita por grep + `git remote -v` vacío). `markStale` + `rebuildIntegration` (fila nueva attempt+1 con `supersedes`, base fresca) ante destino movido; rejected exige run nuevo. `reconcile()` no repite a ciegas: tip==new → completa el papeleo; tip==old → failed reintentable; otro → diverged + stale.
- **Consecuencias:** la promoción es segura y recuperable tras cortes; el workspace del usuario nunca se altera en silencio.

## ADR-061 — Superficie IPC/UI de integración: explícita, por run, sin atajos del modelo

- **Estado:** Aceptada (propietario, Etapa 5).
- **Decisión:** 37 canales IPC tipados (`integrations.*`, `conflicts.*`, `validations.*`, `previews.*`, `approvals.*`, `promotions.*`) con validación de emisor y de carga en main, wrappers finos en `OctusCore` y sección plegable `IntegrationsSection` por run (commits, validaciones, reviews, conflictos con solicitar/finalizar/incorporar/abortar, preview con start/stop/logs/cleanup, aprobación con waiver o preview reachable, promoción, rebuild, incorporate). Ninguna herramienta de modelo aprueba, registra veredictos, resuelve conflictos ni promueve (extensión de ADR-022). Eventos nuevos re-frescan la sección; `busy` cubre `integrating/promoting`.
- **Consecuencias:** todo el flujo Etapa 5 es operable y auditable desde la UI sin paneles separados.

## ADR-062 — Task `integrated`: estado terminal de éxito tras asentar

- **Estado:** Aceptada (propietario, Etapa 5).
- **Decisión:** al asentar su commit (`incorporateCommit` o `incorporateResolution`), la task pasa a `integrated` (transiciones `completed|reviewed → integrated`; `integrated → cancelled` conservada). `integrated` cuenta como éxito en `cascadeCancelSet`, cancela-cascada, `finishRunIfDone` y reconciles; `isDependencySatisfied` y `resolveBase`/workbase la aceptan como predecesor válido (equivale a reviewed + asentado). Sin `integrated`, los dependientes de commits ya asentados se bloquearían para siempre (bug real encontrado por J9/re-suite completa).
- **Consecuencias:** Plan → Task → Integration trazable por estado, no solo por filas.

## Hallazgos de implementación (Etapa 5)

- `repositories.project_id` UNIQUE con `Promise.all(ensureForTask x2)`: carrera latente (SELECT→INSERT no atómico) que la suite completa expuso como flake; fix con UPSERT `ON CONFLICT DO UPDATE` en `ensureRepositoryRow`.
- Comparar `rev-parse --show-toplevel` de un worktree con la raíz del repo siempre falla (devuelve el propio worktree): el check "mismo repo" correcto es `commitExists(repoRoot, produced)` + ancestria.
- `git checkout` con `core.autocrlf` global de Windows rompía los `edit` exactos de los tests: fixtures con `core.autocrlf=false` + `core.eol=lf`.
- Test 14 de Etapa 4 asumía mensaje "merge (Etapa 5)": con la Etapa 5 implementada el bloqueo dice la causa real (predecesor sin revisar / work base pendiente); mensaje y test actualizados.
- `resolveBase`/`isDependencySatisfied` no aceptaban `integrated`: tras incorporar A, B (dependiente) quedaba bloqueado para siempre. `integrated` ahora satisface dependencias y sirve de base (equivale a reviewed + asentado).
- `finalizeResolution` con `git diff` no ve untracked: la validación de scope usa `status --porcelain` (cubre staged+unstaged+untracked); sin esto, un fichero nuevo fuera del scope pasaba.
- Onda de MERGE_HEAD: el abort pertenece a la rama de integración, jamás al worktree de resolución (el agente necesita el merge a medias + MERGE_HEAD).
- `startPreview` devolvía `running` aunque el proceso ya hubiera muerto: espera compuesta (salida del proceso o sonda positiva) + relectura del estado antes de responder.
- FDs del hijo (stdout/stderr pipe) bloqueaban `rm -rf` del tmp en Windows: `destroy()` + `unref()` al detener.
- Preview sin `startEntryId` elegía la primera entrada `start` por orden de allowlist: los tests la fijan explícita para determinismo.
- Los conflictos registran task/attempt/instance vía migración 0006 (trazabilidad e idempotencia de la resolución).
- Orden de checks en `incorporateCommit`: existencia de fila previa e idempotencia primero; el gate de estado admite `building/conflicted/validating` (un `validating` con commit nuevo -p. ej. reintento tardío- debe poder incorporarse).
- Vía idempotente de `promoteIntegration` no convergía (bug real, encontrado por live A3-meta-rundone5 dos veces 44/45 + espejo unitario): con `tip==head` devolvía `reused` sin cerrar nada — integración quedaba en `approved` y run en `integrating` para siempre, sin vía de salida (cada reintento repetía el early-return). Causa live: el deliverable ya estaba commiteado en main antes de aprovisionar el worktree (base==produced; el modelo real con permisos auto-aprobados del harness escribió/commiteó en el root de sesión) — flujo válido que la vía idempotente debe absorber. Fix: la rama `tip==head` ahora converge (fila promotion completed si falta, integración→promoted, run→done + eventos, solo transiciones pendientes); `promoted` + reintento con tip==head es no-op puro; `reconcile` tip==newSha también completa el run (si no, el próximo settle lo cancelaría). Test: "promote idempotente converge aunque el destino ya esté en el head".

## ADR-063 — Entradas de memoria con versionado por cadena

- **Estado:** Aceptada (propietario, Etapa 6).
- **Decisión:** tabla `memory_entries` (migración 0007) con scope project/session/run/task/instance, category/topic/content/source, `origin_ref` JSON {path,section,commit,contentHash}, status proposed/verified/approved/stale/superseded/rejected (+rejected, añadido en Build), confidence, version, `supersedes`, review_note. Triggers estilo Etapas 3–5: contenido/procedencia inmutables (cambio = fila nueva con `supersedes`, vieja → `superseded`); transiciones blancas incluyendo `verified→stale` (FINAL-2) y `proposed→approved` solo vía aprobación explícita del usuario; `review_note` mutable solo por gobernanza. Sin tabla de versiones separada (la cadena `supersedes` lo es); checkpoints = filas `category='checkpoint'`.
- **Consecuencias:** la memoria es conocimiento derivado con historial completo; jamás una segunda fuente operativa contradictoria.

## ADR-064 — Gobernanza de memoria P1/P2

- **Estado:** Aceptada (propietario, Etapa 6).
- **Decisión:** `MemoryWriter` (servicio interno, no perfil): tool `memory_propose` para todos los perfiles, siempre `proposed` con procedencia verificada contra el linaje del agente y deny-list de secretos a nivel servicio; `memory_validate` solo coordinador y solo categorías ordinarias (`decision`/`instruction` exigen usuario); aprobación arquitectónica o de instrucciones confiables vía `QuestionService` con bloqueo parcial (solo la decisión espera); `decide` (usuario) verified/approved/rejected; `supersede` con versión+1; `revalidate` por hash/commit (existencia o alcanzabilidad solas no bastan); contradicción: se marca `review_note` sin borrar y la selección excluye el grupo hasta resolver (`resolveConflict`: ganadora limpia, resto a `stale`).
- **Consecuencias:** ningún subagente se auto-aprueba ni toca memorias permanentes; secretos jamás se persisten.

## ADR-065 — Selección de contexto sin vectores

- **Estado:** Aceptada (propietario, Etapa 6).
- **Decisión:** `buildMemorySection` tras project-instructions: cadena proyecto→sesión→run→task→instancia; `verified` basta para ordinarias en todo scope, `decision`/`instruction` exigen `approved` (FINAL-1); checkpoints solo del run/task/instance en curso; grupos en contradicción pendiente excluidos (FINAL-3); topes de entradas/antigüedad con nota de omitidas; SQLite + estructurado basta, sin base vectorial.
- **Consecuencias:** contexto relevante por agente sin fugas entre scopes; sin infra nueva.

## ADR-066 — Coordinador de recuperación + previews al arrancar

- **Estado:** Aceptada (propietario, Etapa 6).
- **Decisión:** coordinador delgado que ordena lo existente (tasks→worktrees→integrations→previews→promotions→orphanSweep→memory sweep solo-notas); añade `previews.reconcile` al arranque (huérfanos sin matar pids ajenos) y barrido de memoria; `recovery.status` (solo lectura) y `reconcileRecovery` (sin settle cancelador, sin reanudar generaciones). Sin segundo sistema de recuperación.
- **Consecuencias:** recuperación coordinada sin duplicar operaciones; reglas H por construcción.

## ADR-067 — Steering y runs intactos (afirmación anti-regresión)

- **Estado:** Aceptada (propietario, Etapa 6).
- **Decisión:** la Etapa 6 no toca steering/`asNewRequest`, fairness, serialización del coordinador ni TaskGraph/Scheduler/AgentManager. O5 (runs coexistentes) se verifica con e2e de aislamiento por scopes, no con cambios.
- **Consecuencias:** garantías de Etapa 3 preservadas por construcción y por test.

## ADR-068 — Checkpoints de recuperación

- **Estado:** Aceptada (propietario, Etapa 6).
- **Decisión:** checkpoints = `memory_entries` con `category='checkpoint'` ligados a run/task/instance; la conversación ya persiste por separado y el checkpoint es el resumen recuperable (formato del `COMPACTION_PROMPT`); la selección solo los inyecta para el run/instancia en curso.
- **Consecuencias:** continuidad tras reinicio sin duplicar historial.

## ADR-069 — Matriz B GLM-5.3-Flash (P4)

- **Estado:** Aceptada (propietario, Etapa 6).
- **Decisión:** `GO_MODEL=glm-5.3-flash`, `GO_EFFORT=high` (ya en catálogo con toolCall y low/high/max; el effort llega al endpoint vía `reasoning_effort`); prohibido `xhigh` para este modelo (guardia BLOCKED explícita); un caso controlado con `effort=max` en planificación compleja TaskPlanner con aserción de DAG no vacío y ejecutable (regresión explícita del `{"tasks":[]}` de DeepSeek) + trazabilidad (modelo/proveedor/effort/resultado/latencia/uso); DeepSeek queda como antecedente BLOCKED intacto, no se repite.
- **Consecuencias:** OpenCode Go no se declara validado hasta PASS de GLM; PASS/FAIL/BLOCKED/NOT VERIFIED diferenciados.

## Hallazgos de implementación (Etapa 6)

- La whitelist inicial del trigger olvidaba `proposed→approved` (vía usuario explícita) y `verified→superseded`: el live de gobernanza lo habría bloqueado todo; fix + test de retrocesos (`verified→proposed`, `approved→verified` bloqueados).
- `requestApproval` registra el pending de forma asíncrona (tras `get`): los tests deben esperar la pregunta con deadline en vez de leerla síncrona (misma lección que los ticks del scheduler).
- `buildInstructions` pasó a incluir memoria para subagentes (antes solo coordinador recibía projectId): cambio de comportamiento deliberado O3; la suite completa (226 tests) lo avala sin regresión.
- `memory.list` sin filtros + filtrado en renderer por ids conocidos evita N llamadas IPC y fugas entre proyectos.
- El planner rechazaba propuestas válidas cuando el modelo serializa opcionales ausentes como `null` explícito (detectado en live matriz B con GLM: `reviewTargetTempId:null` tumbaba un DAG no vacío): `reviewTargetTempId`/`estimatedComplexity` ahora aceptan null y se normalizan a ausente. Test de regresión con nulos explícitos en `planner.test.ts`. Sin relajar el contrato (sigue exigiendo claves exactas y DAG válido).

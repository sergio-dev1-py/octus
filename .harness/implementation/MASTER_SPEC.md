# MASTER_SPEC.md — Especificación maestra de Octus (adaptada del PROMPT MASTER)

- **Fecha:** 2026-10-30
- **Origen:** adaptación de `C:\Users\UserPy\Desktop\PromtHack\Promt0.txt` (PROMPT MASTER) a las decisiones del propietario para Octus. En caso de conflicto entre el texto original y este documento, prevalece este documento y el motivo queda registrado en `DECISIONS.md`.
- **Ámbito:** Octus es un proyecto **nuevo, construido desde cero** en `C:\Users\UserPy\Documents\octus`. OpenOrch (`C:\Users\UserPy\Documents\OpenOrch`) es únicamente referencia arquitectónica y de comportamiento: no se copia su código y no se modifica.

## 1. Objetivo general

Construir un harness de programación multiagente de escritorio en el que el usuario trabaja con un agente principal (coordinador) durante una sesión y este puede:

1. Comprender solicitudes complejas y analizar proyectos existentes.
2. Planificar modificaciones y definir tareas con dependencias y criterios de aceptación.
3. Delegar a subagentes especializados y ejecutar trabajadores simultáneamente con gobernanza.
4. Crear entornos independientes mediante Git Worktrees.
5. Mantener conversaciones y contextos independientes por agente, con memoria persistente compartida de forma selectiva.
6. Ejecutar herramientas de programación, terminal, investigación y (en su etapa) navegador.
7. Recibir resultados, revisar modificaciones e integrarlas en una rama intermedia.
8. Ejecutar y validar la aplicación integrada, mostrar una vista previa y esperar aprobación antes de incorporar los cambios a la rama de destino (aprobación ligada a un SHA).

El objetivo no es agentes que conversen entre ellos, sino trabajadores autónomos que completan tareas reales, coordinados por un sistema que controla ejecución, dependencias, contexto, aislamiento e integración.

## 2. Regla fundamental: auditar y verificar antes de implementar

- Antes de cada etapa se estudia la referencia y la documentación oficial aplicable; ninguna capacidad de un proveedor se inventa (endpoints, parámetros, formatos).
- Para Meta Model API, la fuente normativa es `https://dev.meta.ai/docs/` (verificada el 2026-10-30; inventario de páginas en `AUDIT.md` §11). Los formatos específicos de Meta viven aislados en su adaptador.
- Los secretos nunca se leen en voz alta, se registran en logs ni se versionan.

## 3. Filosofía de implementación

- **Reutilización inteligente (de conceptos):** cada componente de la referencia se clasifica en `REUSE_MATRIX.md` como Reutilizar / Extender / Refactorizar / Reemplazar / Nuevo. Reutilizar significa adoptar el concepto y el comportamiento verificado, reimplementado con código propio. No se copia código de la referencia.
- **Calidad funcional:** prohibido entregar carpetas vacías, interfaces sin implementación conectada, botones sin acción o integraciones simuladas como si fueran reales. Los mocks solo viven en pruebas.
- **Arquitectura modular:** los modelos razonan; el runtime ejecuta ciclos; el Scheduler distribuye; el Worktree Manager administra Git; el Integration Manager integra; el Memory Service conserva; el Tool Gateway controla y ejecuta herramientas. Ninguna operación determinista se disfraza de agente.
- **Seguridad:** ningún agente modifica fuera de su entorno autorizado; ningún trabajador hace merge/push/promoción; ningún prompt concede permisos; sin claves en conversaciones, logs ni archivos versionados; nunca operaciones destructivas sobre el repositorio original sin autorización; nunca borrar/sobrescribir/stash automático de cambios del usuario. El shell exige aprobación previa y entorno depurado, sin presentarse como sandbox (ADR-018).
- **Razonamiento:** se distingue entre esfuerzo de razonamiento del proveedor, instrucciones de comportamiento, plan de trabajo, resumen explicativo y respuesta final. No se extrae ni almacena la cadena privada de razonamiento; se conservan planes, resúmenes, decisiones y resultados verificables. El contenido cifrado de replay de Meta es estado opaco del proveedor: no se registra ni se muestra.
- **Control de costes:** todo consumo de proveedor se registra por modelo, agente, run y sesión (`usage_records`) y los presupuestos configurables avisan y bloquean antes de generar (ADR-019).
- **Documentación:** esta carpeta `.harness/implementation/` es la documentación técnica viva y se actualiza en cada etapa.

## 4. Arquitectura objetivo (resumen; detalle en TARGET_ARCHITECTURE.md)

- **Aplicación:** shell Electron (main/preload) + renderer SolidJS, gestor de sesiones y proyectos, API local por IPC tipado y comunicación por eventos.
- **Coordinador único por sesión** con perfiles **Plan** (analiza, investiga, planifica y define tareas; por defecto sin modificación del proyecto, exigible en runtime) y **Build** (ejecuta, coordina subagentes, supervisa; puede hacer tareas pequeñas directamente y debe delegar lo grande/paralelizable).
- **Subagentes iniciales:** Explorer (analiza, no modifica), Researcher (investiga con fuentes, no modifica), Implementer (implementa en su worktree, sin merges), Reviewer/QA (revisa y ejecuta pruebas autorizadas, no modifica). Múltiples instancias por perfil; no se crea un perfil por trabajador.
- **Infraestructura:** Agent Runtime, Agent Manager, Task Planner, Task Graph/DAG, Scheduler, Agent Messaging, Model Router, Context Builder, Memory Service, Tool Gateway, Permission Manager, Repository Manager, Worktree Manager, Integration Manager, Preview Manager, Promotion Manager, Validation Service y Persistence Service.

## 5. Principios de orquestación

Se distinguen **Session** (conversación persistente), **Run** (ejecución por solicitud), **Task** (trabajo concreto), **Agent Definition** (perfil reutilizable), **Agent Instance** (ejecución individual), **Worktree** (entorno Git), **Integration** (cambios combinados) y **Preview** (ejecución verificable de una integración).

Una sesión admite varios runs sin reiniciarse; un run, varias tareas; cada mensaje nuevo del usuario es una nueva solicitud analizada por el coordinador. Las tareas independientes avanzan en paralelo; las dependientes esperan. El Scheduler comprueba dependencias, disponibilidad, concurrencia, recursos, ámbitos de escritura, estado del proyecto y conflictos potenciales antes de lanzar nada.

## 6. Git y aislamiento

Todo trabajador que modifica código recibe worktree independiente, rama propia, commit base identificado, scope de escritura, tarea concreta, dependencias y criterios de aceptación. El Worktree Manager es el único que crea, inspecciona y elimina worktrees. Cada tarea registra commit base y commit producido. Los cambios se integran en una rama intermedia controlada, con integración serializada por repositorio. Si el repositorio tiene cambios locales sin commit, nunca se destruyen ni se ignoran en silencio: se preservan con garantía o se bloquean las operaciones de escritura/promoción comunicándolo.

Etapa 4 (implementado): base HEAD o `produced_commit` del único writer-predecesor (≥2 writers → `blocked/deps-unavailable`, sin merges); repo sucio → worktree desde HEAD con `dirty_excluded` visible; commit harness con identidad fija al completar; reintento sobre el mismo worktree; reviewer lee el worktree del target sin tomarlo; limpieza solo explícita del usuario con árbol limpio y sin agentes activos (ramas conservadas); raíz por defecto `<dataDir>/../octus-worktrees/<projectId>`, configurable por proyecto.

## 7. Integración y aprobación

Flujo normativo: workers completan y entregan commits → el Integration Manager los integra secuencialmente en la rama intermedia → resuelve o informa conflictos → Validation Service ejecuta pruebas → Reviewer revisa → Preview presenta la aplicación integrada → el usuario aprueba un **SHA concreto** → se verifica que el SHA y la rama destino no cambiaron → promoción segura y registro. Si cambia el commit o la destino, la aprobación queda invalidada y se reconstruye/revalida. Sin push automático.

Etapa 5 (implementado): ramas `harness/integration|workbase|resolution/*` bajo worktrees_root; incorporación FF/merge con verificaciones e idempotencia por (task, attempt); tasks marcadas `integrated` al asentar; auto-build P1 al revisar (run → `integrating`); conflictos con resolución asistida y reutilización por padres; suite por SHA con skipped explícito y gate; preview detached con allowlist y env depurado; aprobación inmutable pinneada (preview reachable o waiver motivado, sin ocultar previews); promoción con CAS update-ref o merge --ff-only en checkout limpio, sin stash ni push; stale + rebuild explícito; reconciliación que determina en vez de repetir.

## 8. Memoria

Fuentes de verdad diferenciadas: memoria permanente de proyecto, de sesión, de run/task y conversación por instancia. Cada agente recibe contexto relevante, no el historial completo de los demás. Soporte: archivos del proyecto, base de datos y artefactos verificables; sin bases vectoriales al principio. Se registran arquitectura, stack, convenciones, decisiones aprobadas, contratos, resúmenes de tareas, investigaciones, dependencias y versiones de contexto. Los hallazgos provisionales no se convierten en reglas permanentes sin aprobación registrada.

Etapa 6 (implementado): `memory_entries` (scope project/session/run/task/instance; estados proposed/verified/approved/stale/superseded/rejected; versionado por cadena `supersedes`; triggers de inmutabilidad y transiciones blancas); `MemoryWriter` como servicio interno (proponer/validar/aprobar con usuario vía `QuestionService`/superseder/revalidar por hash de origen); tools `memory_propose` (todos los perfiles, solo provisional) y `memory_validate` (solo coordinador, solo ordinarias); `ContextBuilder.buildMemorySection` con política por categoría y exclusión de contradicciones pendientes; coordinador de recuperación (`recoveryStatus`/`reconcileRecovery`, `previews.reconcile` al arrancar, barrido de memoria).

## 9. Proveedores y modelos (decisión cerrada)

- Solo dos proveedores: **Meta Model API (principal)** y **OpenCode Go (alternativo seleccionable)**. Sin fallback automático entre proveedores en las primeras etapas.
- Coordinador: `muse-wonder-1.0`. Subagentes: `muse-spark-1.3` por defecto, Wonder cuando la tarea lo requiera. Solo modelos Standard; las variantes Contributor quedan excluidas por defecto (el contenido podría usarse para entrenamiento).
- Meta se integra por la **Responses API** con replay stateless de razonamiento cifrado como diseño por defecto (ADR-004) y el **SDK oficial `openai`** (P-02 resuelto en el Hito 0), adaptador aislado y verificación continua contra la documentación oficial. OpenCode Go se integra por **protocolo nativo de cada modelo** según su catálogo público, con shortlist inicial `glm-5.3-flash` / `deepseek-v4.1-flash` (ADR-021).
- El esfuerzo de razonamiento se controla con los parámetros documentados por cada proveedor y se ofrece solo donde el proveedor/modelo lo soporta.

## 10. Calidad y entrega por etapa

Cada etapa exige: implementación funcional conectada, tipos y contratos claros, manejo de errores, logs sin secretos, pruebas unitarias y de integración según el área, documentación actualizada y verificación de no-regresión. Al cerrar cada etapa se informa: qué se implementó, qué conceptos de la referencia se reutilizaron y cómo, archivos modificados, pruebas ejecutadas con resultados reales, limitaciones, riesgos pendientes y qué queda para la siguiente etapa. No se empieza la etapa siguiente sin completar y validar la actual.

## 11. Regla de adaptación

Esta especificación describe el objetivo, no obliga a duplicar literalmente una arquitectura. Los nombres de módulos siguen las convenciones que el propio Octus establezca. Si durante una etapa la evidencia (pruebas, documentación oficial, comportamiento real) contradice una decisión, se registra una enmienda en `DECISIONS.md` antes de seguir. No se sacrifica calidad por abarcar más componentes en una etapa.

## 12. Etapas

0. **Prompt 0** — auditoría y documentos (esta carpeta). Sin código.
1. Núcleo, persistencia, proveedores (Meta/OpenCode Go) y runtime.
2. Agentes principales, subagentes y permisos.
3. Scheduler, tareas, DAG y paralelismo.
4. Git Worktrees.
5. Integración, validación, preview y aprobación.
6. Memoria, recuperación y concurrencia avanzada (extras como MCP/navegador/Code Mode solo con diseño propio y puerta de aprobación).

Detalle, alcances y puertas de salida: `IMPLEMENTATION_ROADMAP.md`.

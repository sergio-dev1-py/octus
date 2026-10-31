# Octus

**El harness multiagente de codificación local-first (escritorio).**

[![Bun](https://img.shields.io/badge/Bun-1.4-fbf0df?style=flat-square&logo=bun)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-estricto-3178c6?style=flat-square&logo=typescript)](https://www.typescriptlang.org)
[![Electron](https://img.shields.io/badge/Electron-escritorio-47848f?style=flat-square&logo=electron)](https://www.electronjs.org)
[![SolidJS](https://img.shields.io/badge/SolidJS-renderer-2c4f7c?style=flat-square&logo=solid)](https://www.solidjs.com)
[![SQLite](https://img.shields.io/badge/SQLite-ledger-003b57?style=flat-square&logo=sqlite)](https://www.sqlite.org)
[![Estado](https://img.shields.io/badge/estado-en_desarrollo-orange?style=flat-square)](https://github.com/sergio-dev1-py/octus)
[![Licencia](https://img.shields.io/badge/licencia-UNLICENSED-lightgrey?style=flat-square)](./LICENSE)

[English](./README.md) | **Español**

> 🏆 Construido durante el **Meta Global AI Developer Hackathon 2026** como proyecto de desarrollo en la línea **Push the Frontier**, modalidad **individual**.

---

Octus es un harness de escritorio para delegar trabajo real de programación a subagentes de IA especializados bajo un único coordinador — con aprobaciones exclusivamente humanas, registro de uso por llamada y orquestación determinista. Ejecuta proveedores en vivo (API Responses de Meta, protocolos nativos por modelo de OpenCode Go) y ofrece un camino gobernado de **plan → revisión aprobada → DAG de tareas → workers en paralelo → revisión → done**.

Aún sin imágenes — la UI existe y arranca en verde; las capturas llegarán cuando la interfaz se estabilice.

## Por qué Octus

- **Local-first.** SQLite (en hilo worker) es la fuente de verdad: sesiones, runs, instancias, planes, tareas, uso. Sin fallbacks silenciosos ni estado oculto.
- **Un coordinador, dos perfiles.** Un único coordinador trabaja en `plan` (análisis de solo lectura) o `build` (ejecución) sobre una misma sesión continua; cuatro perfiles worker (`explorer`, `researcher`, `implementer`, `reviewer`) hacen el trabajo.
- **Aprobaciones solo humanas.** Los planes solo avanzan con aprobación explícita del usuario fijada a `(plan_id, revision_id)` exactos. Los modelos pueden pedir aprobación; jamás concederla.
- **Cada llamada al proveedor queda registrada.** Filas de `usage_records` por llamada (tokens, razonamiento, caché, coste) más presupuestos por run/sesión con puertas de aviso/bloqueo. Las llamadas de pago sin configurar se rechazan antes de salir del router.
- **Scheduler determinista.** DAG de tareas con detección de ciclos, puertas de dependencias (`needsReview`), límites de concurrencia por rol/sesión/proyecto con cursor de equidad persistido, reservas atómicas de ámbitos, reintentos con backoff y reconciliación tras caídas. Sin worktrees automáticos ni merges automáticos — eso es de etapas posteriores.

## Estado del proyecto

Se avanza por etapas con puerta (ADR-016): una etapa solo empieza cuando la anterior está validada y documentada. La evidencia vive en [`.harness/implementation/`](./.harness/implementation/).

| Etapa | Alcance | Estado |
|---|---|---|
| 0 — Auditoría y plan | Auditoría de OpenOrch, verificación de docs de Meta, línea base segura, ADRs 001–016 | ✅ Hecha |
| 1 — Núcleo, persistencia, proveedores y runtime | Agente único en streaming, herramientas básicas, ledger SQLite, adaptadores Meta + Go, presupuestos | ✅ **Cerrada 2026-10-31** — 14/14 checks live, 56 tests core + 1 shared en verde |
| 2 — Agentes, permisos y Plan Manager | Perfiles plan/build, 4 perfiles worker, delegación foreground/background, directorios aislados, allowlist de tests, instrucciones confiables, aprobaciones fijadas al usuario | ✅ Implementada — 110 core + 1 shared en verde, 15 checks live nuevos tras `MODEL_API_KEY` |
| 3 — Scheduler, tareas, DAG y paralelismo | Migración `tasks`/`task_dependencies`, TaskGraph, TaskPlanner (servicio interno), scheduler determinista, retry/recover, veredictos de revisión, UI DAG mínima | ✅ Implementada — 140 core + 1 shared en verde; **live matriz A 35/35 PASS** (Meta contributor/xhigh, plan→DAG→paralelo→revisión→done reales, modelo+uso verificados por instancia); matriz B **BLOCKED** por el modelo (deepseek-v4.1-flash/max no emite el contrato del planner tras 12 intentos — no es bug de producto) |
| 4 — Git worktrees | Worktree aislado por tarea escritora, trazabilidad base→commit producido | ⬜ Planificada |
| 5 — Integración, validación, preview, aprobación | Integración secuencial, aprobación fijada a SHA, promoción segura | ⬜ Planificada |
| 6 — Memoria, recuperación, concurrencia avanzada | Memoria por proyecto/sesión/run/task, robustez en sesiones largas | ⬜ Planificada |

Detalles: [`IMPLEMENTATION_ROADMAP.md`](./.harness/implementation/IMPLEMENTATION_ROADMAP.md) · [`STAGE2_ACCEPTANCE_REPORT.md`](./.harness/implementation/STAGE2_ACCEPTANCE_REPORT.md) · [`STAGE3_ACCEPTANCE_REPORT.md`](./.harness/implementation/STAGE3_ACCEPTANCE_REPORT.md) · [`DECISIONS.md`](./.harness/implementation/DECISIONS.md) (ADRs 001–042 + hallazgos, incl. 9 bugs reales encontrados por tests/live y corregidos).

## Estructura del repositorio

```
octus/
├── packages/
│   ├── shared/     # Contratos de dominio: sesiones, mensajes, eventos, IPC, modelos, costes
│   ├── core/       # Proveedores, router, runtime, agentes, planes, tasks/scheduler,
│   │               # permisos, herramientas, persistencia, presupuestos, harnesses live
│   └── ...         # (workspaces: packages/*, apps/*)
├── apps/
│   └── desktop/    # Shell Electron + SolidJS (main/preload/renderer), runner de aceptación
└── .harness/
    └── implementation/  # Auditoría, arquitectura, ADRs, roadmap, informes de aceptación
```

## Inicio rápido

Requisitos: **Bun ≥ 1.4** (gestor de paquetes + test runner) y **Node ≥ 22.5**.

```bash
bun install

# Typecheck de todo (shared + core + desktop node/web)
bun run typecheck

# Tests unitarios + integración (proveedores falsos por defecto — sin claves)
bun run test

# Compilar la app de escritorio
bun run build

# Smoke test headless (arranca el core en el proceso main de Electron)
bun run smoke

# Shell de desarrollo (renderer Electron + SolidJS)
bun run dev
```

## Validación live (proveedores reales, gasto real)

Los tests unitarios usan proveedores falsos. Los harnesses `check:live` atacan las APIs reales y están **acotados por presupuestos** (puertas de aviso/bloqueo). Las claves nunca se guardan en el repo — vienen de las variables `MODEL_API_KEY` / `OPENCODE_API_KEY` (o del almacén seguro del SO en el runner de escritorio).

```bash
# Etapas 1–2: 14 checks base + matriz de delegación/planes
MODEL_API_KEY=... OPENCODE_API_KEY=... bun --cwd packages/core run check:live

# Etapa 3: matrices TaskGraph/Planner/Scheduler (A: Meta contributor/xhigh, B: Go deepseek/max)
MODEL_API_KEY=... OPENCODE_API_KEY=... bun --cwd packages/core run check:live:stage3
```

End-to-end de escritorio (runner de aceptación dentro de Electron, claves del almacén del SO, informe anexado en `.harness/implementation/`):

```bash
bun run build
bunx electron ./apps/desktop/out/main/index.js \
  --user-data-dir="$APPDATA/@octus/desktop" \
  --octus-acceptance-3
# Filtro: OCTUS_ACCEPT_MATRIX=a|b|both
```

## Modelo de seguridad

- Las claves API viven en el **almacén seguro del SO** (`safeStorage`) o en variables de entorno en ejecución. El repo contiene **cero secretos** — verificado antes de cada push.
- Las herramientas corren tras `PermissionManager` (denegación por defecto en escrituras/shell) con directorios aislados por proyecto, contención de rutas (`realpath` + rechazo UNC) y allowlist de comandos de test ejecutados en copias desechables.
- Puertas humanas: aprobaciones de planes y (desde la etapa 5) promoción de integración fijada a SHA. El harness solo auto-aprueba dentro de rutas de código marcadas como **tests/usuario simulado**.

## Contribuir

El proyecto está en desarrollo activo (pre-release, `0.1.0`, privado). Aún no hay contribuciones externas — los issues y la discusión viven en el [tracker](https://github.com/sergio-dev1-py/octus/issues). Si construyes algo relacionado y reutilizas el nombre, indica que no hay afiliación, la misma cortesía que [opencode pide a su ecosistema](https://github.com/anomalyco/opencode#building-on-opencode).

## Licencia

Todos los derechos reservados por ahora (`UNLICENSED`, ver [LICENSE](./LICENSE)). Los términos de licencia se definirán antes de cualquier release público.

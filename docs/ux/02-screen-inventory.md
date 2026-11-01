# Inventario de pantallas (Todo 2)

Cada fila traza a un flujo de `03-flows.md` con actor y estado final. Si una pantalla no traza a un flujo, sobra y se elimina. Re-verificado contra `App.tsx` y `store.ts` tras cada edición (clase stale_state).

Leyenda de estados: usa los ocho estados de `01-information-architecture.md` (vacío, cargando, listo, ocupado, esperando decisión, error localizado, degradado, sin proyecto).

| ID | Pantalla | Zona | Flujo | Actor | Estado final del flujo | Estados que usa |
|---|---|---|---|---|---|---|
| W-01 | Bienvenida (arrastrar carpeta, selector nativo, recientes con fecha, crear, continuar) | Propia (pre-workbench) | F-1 bienvenida | Usuario | Dentro del proyecto o fuera sin nada seleccionado | Sin proyecto, error localizado, cargando |
| SB-01 | Activity bar (Explorer, Chat, Planes, Agentes, Skills, MCP, Configuración) | Activity bar | F-0 navegación y layout | Usuario | Destino conmutado sin perder el centro | Listo |
| SB-02 | Sidebar Explorer (proyectos, sesiones, recientes) | Sidebar | F-2 proyecto, F-3 sesión | Usuario | Proyecto abierto o sesión continuada | Vacío, listo, error localizado |
| C-01 | Línea de tiempo de conversación (mensajes, streaming, tool calls, planes, errores) | Central | F-5 build, F-4 plan | Usuario y coordinador | Run terminado, fallido o cancelado | Ocupado, listo, error localizado |
| C-02 | Composer (texto, adjuntos, perfil plan/build, enviar, interrumpir) | Central | F-5 build, F-4 plan | Usuario | Petición enviada o run interrumpido | Listo, ocupado |
| C-03 | Planes (lista, revisiones, aprobar, rechazar, implementar, archivar, exportar) | Central (vista) | F-4 plan | Usuario | Revisión aprobada, rechazada o archivada | Listo, esperando decisión, vacío |
| I-01 | Inspector de detalle (tarea, run, plan, diff) | Inspector | F-5 build, F-4 plan | Usuario | Selección comprendida, sin cambios de estado | Vacío, listo, error localizado |
| I-02 | Bandeja de aprobaciones (pendientes, aprobar, rechazar) | Inspector | F-6 aprobación | Usuario | Aprobación decidida por el humano | Esperando decisión, listo, vacío |
| D-01 | Diálogo de permiso (acción, recursos, permitir una vez, siempre salvo shell, rechazar con motivo) | Modal | F-5 build | Usuario | Permiso concedido o denegado y auditado | Esperando decisión |
| D-02 | Diálogo de pregunta (opciones, múltiple o única, respuesta propia) | Modal | F-5 build | Usuario | Pregunta respondida o run detenido | Esperando decisión |
| P-01 | Panel inferior (Terminal, Problemas, Salida, Pruebas) | Panel inferior | F-5 build | Usuario y agente | Salida consultada, terminal reutilizable | Listo, ocupado, error localizado |
| P-02 | Explorador de archivos y diffs | Sidebar Explorer / Inspector | F-5 build | Usuario | Archivo visto, diff revisado | Cargando, listo, error localizado |
| S-01 | Configuración (proveedores, presupuestos, agentes, proyecto) | Sidebar / Central | F-7 recuperación, F-0 navegación | Usuario | Límite o clave guardada, o defecto restaurado | Listo, error localizado, degradado |
| S-02 | Agentes, tareas, runs y worktrees (estado real, reintentar, cancelar, limpiar) | Central (vista) | F-5 build | Usuario | Tarea reintentada, cancelada o detenida en estado final real | Ocupado, listo, error localizado, vacío |
| S-03 | Recuperación al arranque (pendientes, conciliar ahora, refrescar) | Central (vista) | F-7 recuperación | Usuario | Nada pendiente o degradado marcado | Degradado, listo, vacío |

Notas de trazabilidad:

- Hoy `App.tsx` ya contiene el germen de C-01, C-02, C-03, D-01, D-02, S-01 y S-02 como secciones apiladas (`PlansSection`, `TasksSection`, `WorktreesSection`, `IntegrationsSection`, `MemorySection`, `AgentsSection`, `ProviderSettings`, `BudgetSettings`). El inventario no las duplica: las reparte entre zonas.
- W-01, SB-01, I-01, I-02 y P-01 no existen hoy y son diseño nuevo. No se codifican en este todo.
- Skills y MCP no tienen pantalla propia en este inventario: sus vistas las especifica el Todo 4 y este inventario solo les reserva el destino en SB-01. Así se evita prometer pantallas que otro todo debe diseñar.

# Arquitectura de información y navegación (Todo 2)

Rama `feat/ux-skills-mcp-w7-design`. Cubre IS-1 (bienvenida predecible) e IS-2 (workbench con paneles ocultables, redimensionables y restaurables). No codifica pantallas. La autoridad sobre lo que existe hoy está en `.harness/implementation/TREE_AUTHORITY.md`.

Lectura real de partida: `apps/desktop/src/renderer/src/App.tsx` (1337 líneas, un solo `Sidebar` más `ChatView` más `SettingsView`, vistas `chat` y `settings` en `store.ts`) y `apps/desktop/src/renderer/src/store.ts` (971 líneas, estado global con proyectos, sesiones, mensajes, planes, tareas, worktrees, integraciones, memoria y agentes). Hoy no hay bienvenida, no hay activity bar, no hay inspector ni panel inferior. Todo lo que sigue es diseño por aprobar, no descripción de lo que hay.

## Principios

1. La bienvenida es una puerta, no un escritorio. Aparece al arrancar, no elige nada por ti, y desaparece en cuanto entras a un proyecto.
2. El workbench tiene cinco zonas fijas con un orden fijo. Lo que cambia es qué muestran y cuánto miden, nunca dónde están.
3. Cada zona se puede ocultar y volver a mostrar, y el layout sobrevive al reinicio. Un layout corrupto vuelve al defecto en vez de dejarte ante una pantalla en blanco.
4. Los diálogos que piden algo (permisos, preguntas, aprobaciones) interrumpen lo mínimo y siempre dicen quién decide y qué pasa si no decides.
5. Los estados de error son parte del diseño, no un anexo. Cada flujo termina en un estado nombrado, incluido el fallo.

## Las cinco zonas

### 1. Activity bar (borde izquierdo, iconos)

Una columna estrecha con seis destinos: Explorer, Chat, Planes, Agentes, Skills y MCP, Configuración. Solo marca posición, no apila paneles. El destino activo queda resaltado y conmutar nunca pierde el estado de la zona central.

### 2. Sidebar (a la derecha del activity bar)

Muestra el contenido del destino activo:

- Explorer: proyectos, sesiones del proyecto activo, recientes con fecha.
- Chat: hilos y sesiones, con la sesión activa marcada.
- Planes: lista de planes con su estado (activo, aprobado, archivado).
- Agentes: instancias con estado (creado, corriendo, esperando permiso, esperando input, terminado, fallido).
- Skills / MCP: accesos directos a catálogo y a instaladas, con el estado resumido (instalado frente a habilitado).
- Configuración: proveedores, presupuestos, agentes, proyecto.

La sidebar se oculta por completo y se redimensiona en un rango fijado por el sistema de diseño (Todo 3). Su ancho persiste por usuario.

### 3. Conversación central

Es el centro del trabajo. Contiene la línea de tiempo de mensajes (usuario, coordinador, resúmenes de razonamiento, tool calls expandibles con resultados, planes, errores), el composer con adjuntos y selector de perfil plan/build, y la cinta de estado del run (idle, trabajando, esperando permiso, esperando input, fallido). La línea de tiempo virtualiza conversaciones largas para que el volumen no degrade la UI. El detalle fino de cada zona vive en el Todo 4.

### 4. Inspector (derecha)

Muestra el detalle de lo seleccionado en el centro o en la sidebar: una tarea con sus dependencias e intentos, un run con su uso, un plan con sus revisiones, una aprobación pendiente, un diff. Si no hay selección, muestra un vacío honesto ("elige una tarea para verla aquí"), nunca un relleno inventado.

### 5. Panel inferior (debajo del centro)

Pestañas: Terminal, Problemas, Salida, Pruebas. Se oculta, se redimensiona en altura y recuerda su pestaña activa. La terminal persistente y el explorador con diagnósticos los construyen los Todos 32 y 33; aquí solo se reserva el sitio y el comportamiento.

## Navegación entre zonas

- Activity bar conmuta la sidebar sin tocar el centro.
- Seleccionar algo en la sidebar o en el centro alimenta al inspector.
- El panel inferior no tapa al centro: le cede altura y la devuelve al ocultarse.
- Atajos de teclado para ocultar y mostrar cada zona, más un comando "restablecer layout" que vuelve al defecto.
- El estado del layout (qué visible, qué tamaño, qué pestaña) persiste por usuario y se valida al arrancar. Si la validación falla, defecto más aviso, nunca pantalla vacía.

## Estados de interfaz

Toda zona conoce estos estados y cada pantalla del inventario dice cuáles usa:

- Vacío (sin datos, con acción siguiente clara).
- Cargando (esqueleto breve, sin bloquear el resto).
- Listo (datos visibles, acciones disponibles).
- Ocupado (run o tarea en marcha, con cancelación a la vista).
- Esperando decisión (permiso, pregunta o aprobación pendiente; solo el humano decide).
- Error localizado (qué falló, qué se conserva, cómo reintentar).
- Degradado (recuperación con datos parciales, marcada como tal, sin pérdida silenciosa).
- Sin proyecto (bienvenida o su equivalente: nada auto-seleccionado).

## Qué cambia respecto a hoy

Hoy `App.tsx` tiene dos vistas (`chat`, `settings`) y un `Sidebar` que mezcla proyectos y sesiones. El inventario del Todo 2 mantiene todo lo que ya funciona (planes, tareas, worktrees, integraciones, memoria, agentes, permisos, preguntas, presupuestos) y lo reparte entre las cinco zonas en vez de apilarlo bajo el chat. Nada de la lógica de etapas 1 a 6 se toca: solo se reordena su superficie.

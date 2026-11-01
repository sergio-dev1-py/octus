# Flujos (Todo 2)

Cada flujo nombra pantallas del inventario (`02-screen-inventory.md`), actor y estado final, incluido el fallo. El criterio del plan se cumple así: un flujo sin estado de error definido vuelve a redactarse. Cada flujo cierra contra IS-1 o IS-2.

Actores: solo Usuario y coordinador (los agentes trabajan dentro de los runs, no navegan). El humano decide siempre en F-6.

## F-0. Navegación y layout (IS-2)

Pantallas: SB-01, SB-02, S-01. Actor: usuario. Hoy `store.ts` solo conoce la vista `chat` o `settings`; este flujo diseña lo que la reemplaza.

1. El usuario elige un destino en SB-01. La sidebar cambia, el centro no se toca.
2. El usuario oculta o redimensiona una zona. El cambio se guarda al momento.
3. Al reiniciar, el layout vuelve tal cual. Si el guardado está corrupto, se aplica el defecto y se avisa.
4. "Restablecer layout" devuelve las cinco zonas a su sitio.

Estado final feliz: destino conmutado, layout persistido. Estado de fallo: layout corrupto, se aplica el defecto con aviso (nunca pantalla en blanco).

## F-1. Bienvenida (IS-1)

Pantallas: W-01. Actor: usuario. Hoy no existe: `App.tsx` arranca directo al chat sin proyecto.

1. Al abrir Octus aparece W-01: zona de arrastre, botón de selector nativo, recientes con fecha, crear proyecto, continuar sesión.
2. Arrastrar una carpeta la valida (existe, con permiso de lectura). El selector nativo hace lo mismo.
3. Si la carpeta no existe o no hay permiso, W-01 muestra el error y no crea nada.
4. Elegir un reciente con la ruta ya ausente marca ese reciente como roto y deja elegir otro.

Estado final feliz: dentro del proyecto, W-01 cerrada. Estado de fallo: error visible sin proyecto creado y sin nada auto-seleccionado. Al arrancar nunca hay proyecto activo: eso es requisito, no olvido.

## F-2. Proyecto (IS-1)

Pantallas: SB-02, S-01. Actor: usuario. Reusa `createProject` y `selectProject` de `store.ts`.

1. Crear: nombre más carpeta validada. Abrir: proyecto existente. Cambiar: otro proyecto de la lista.
2. Cada proyecto aísla sesiones, runs y directorios. Cambiar de proyecto detiene la vista del anterior sin tocar sus datos.
3. S-01 gestiona directorios aislados, allowlist de pruebas y archivos de instrucción confiables por proyecto.

Estado final feliz: proyecto abierto con sus sesiones. Estado de fallo: carpeta inválida, se rechaza sin crear el proyecto.

## F-3. Sesión (IS-1)

Pantallas: SB-02, C-01. Actor: usuario. Reusa `createSession` y `selectSession` de `store.ts`.

1. Nueva sesión (con perfil plan o build), continuar una existente, o recuperar una interrumpida.
2. Sin sesión activa el composer está deshabilitado con su pista ("crea o elige una sesión primero", texto ya presente en `App.tsx`).
3. Cambiar de sesión conserva el timeline de cada una; nada se mezcla.

Estado final feliz: sesión activa lista para conversar. Estado de fallo: evento de recuperación corrupto, sesión vacía marcada como degradada y registrada, sin pérdida silenciosa.

## F-4. Plan (IS-2, usa el workbench)

Pantallas: C-01, C-02, C-03, I-01. Actores: usuario y coordinador. Hoy vive en `PlansSection` bajo el chat; el diseño lo sube a vista central con detalle en el inspector.

1. El usuario pide en perfil plan. El coordinador presenta una revisión.
2. El usuario la aprueba, la rechaza o la archiva (C-03). Solo el humano decide.
3. Una revisión aprobada se puede implementar, lo que abre F-5.
4. I-01 muestra el contenido y el ciclo de vida de cada revisión.

Estado final feliz: revisión aprobada e implementable, o plan archivado. Estado de fallo: revisión rechazada, el plan sigue activo sin efectos laterales.

## F-5. Build y run (IS-2, usa el workbench)

Pantallas: C-01, C-02, I-01, D-01, D-02, P-01, P-02, S-02. Actores: usuario y coordinador. Es el flujo central y el único que toca permisos y preguntas.

1. El usuario envía desde C-02. La cinta marca ocupado con interrupción siempre a la vista.
2. El streaming pinta texto, resúmenes de razonamiento y tool calls con sus resultados (C-01). Las conversaciones largas virtualizan.
3. Si el run necesita permiso, aparece D-01: permitir una vez, siempre (salvo shell, como ya hace `App.tsx`), o rechazar con motivo. Sin respuesta el run espera, no avanza solo.
4. Si el coordinador pregunta, D-02 recoge opciones o texto libre.
5. S-02 sigue tareas, runs, agentes y worktrees con su estado real; P-01 y P-02 muestran terminal, problemas y diffs.
6. Cancelar a mitad detiene el run sin mensaje fantasma ni duplicado.

Estado final feliz: run terminado con resultados visibles. Estados de fallo: run fallido con error localizado y reintento (S-02), run cancelado en estado final real (nunca progreso congelado), permiso denegado con auditoría.

## F-6. Aprobación (IS-2, usa el workbench)

Pantallas: I-02, C-03. Actor: usuario, y solo el usuario. Hoy `decideApproval` ya existe en `store.ts`; el flujo le da bandeja propia.

1. Una solicitud pendiente aparece en I-02 con plan, revisión y contexto.
2. El usuario aprueba o rechaza. Un modelo jamás concede aprobaciones.
3. La decisión es idempotente: aprobar dos veces no duplica efectos.
4. Lo decidido sale de la bandeja y queda registrado en su plan.

Estado final feliz: aprobación decidida por el humano y registrada. Estado de fallo: solicitud duplicada o fuera de revisión, se rechaza por idempotencia.

## F-7. Recuperación (IS-1 e IS-2)

Pantallas: S-03, S-01. Actor: usuario. Hoy `MemorySection` ya trae panel de recuperación con conciliar y refrescar; el flujo lo hace primera clase.

1. Al arrancar, estado de pendientes (operaciones, promociones, previews vivos, memorias obsoletas, contradicciones).
2. "Conciliar ahora" ejecuta la reconciliación y refresca. Nada reanuda generaciones a escondidas.
3. Si algo no se puede conciliar, queda marcado como degradado con su motivo.
4. S-01 permite restaurar valores por defecto si una preferencia corrupta rompe el arranque.

Estado final feliz: cero pendientes o todo pendiente marcado y explicado. Estado de fallo: degradado visible y registrado, nunca silencio.

## Cobertura IS-1 / IS-2

- IS-1 (bienvenida predecible, sin auto-selección): F-1, F-2, F-3 y la parte de arranque de F-7.
- IS-2 (workbench con paneles ocultables, redimensionables y restaurables, preferencias persistentes): F-0, F-4, F-5, F-6 y la parte de layout de F-7.
- Ningún flujo queda sin IS y ninguna IS queda sin flujo.

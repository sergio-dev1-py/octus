# task-F3.md — Verificador final F3: live workbench-WITH-project en Electron real

Fecha (UTC): 2026-11-02 · Checkout: C:/Users/UserPy/Documents/octus
Alcance: SOLO lectura en todo el checkout + escritura en este directorio de evidencia.
NO se implementó nada, NO se corrigió nada, NO se tocó user-data real.
Cierra los 3 live gaps declarados en task-10 §3/§4/§10.

## Método (todo real, nada simulado)

- Build de producción existente: `apps/desktop/out/{main,preload,renderer}` (electron-vite).
- Lanzamiento real: `apps/desktop/node_modules/electron/dist/electron.exe
  out/main/index.js --remote-debugging-port=19223 --user-data-dir=<temp>`;
  `OCTUS_DATA_DIR=<temp>` aislado; fixture-proyecto en `os.tmpdir` (fuera del repo).
- Driver: `task-F3.cjs` (Playwright-core por CDP). Hallazgo operativo documentado:
  el primer arranque murió con exit 0 por `app.requestSingleInstanceLock()`
  (index.ts): el Electron del task-10 seguía vivo con el user-data real.
  Se cerró pasando `--user-data-dir` aislado (segundo intento verde).
- Todo clic es un clic real de Playwright sobre el renderer vivo; todo IPC es
  `window.octus.invoke` real (main → core → PTY). Transcripción íntegra:
  `task-F3.raw.log` (15 filas + SUMMARY). Máquina: `task-F3.rows.json`.

## Dirty worktree (report-only, sin tocar)

El mismo dirt preexistente del task-10 (trabajo sin commitear de los todos 1-9,
HEAD 3f318a4). Esta pasada solo creó `task-F3.*` untracked bajo evidencia.

## Gap (a) — workbench-WITH-project live (toggles enabled, terminal rooted) — PASS

- Vía real de bienvenida con clics: `projects.create` (IPC real) → reload
  (boot real) → clic `.recent` → modo sesiones → clic `#welcome-new-session`
  → `#workbench` visible. `task-F3.workbench.png` (1264×673).
- Estado live afirmado en página: 3 toggles `disabled===false`
  (sidebar/inspector/bottom), `session-new` enabled + fila de sesión
  "New session [build]", 4 tabs del bottom `disabled===false`
  (terminal/problems/output/tests), `#terminal-panel` montado con
  `#terminal-create` enabled y `projectRoot === FIXTURE` (el fallback
  "Crea una para trabajar en <code>ruta</code>").
- Terminal rooted, 100% vía UI viva: clic `#terminal-create` → fill
  `#terminal-input`="cd" → clic `#terminal-enter` → `#terminal-output` del
  PTY real (cmd.exe) muestra el prompt en el fixture:
  `C:\Users\UserPy\AppData\Local\Temp\octus-f3-proj-8uiOYy> cd`.
  `task-F3.terminal.png` (1264×673).

## Gap (b) — toggles-with-project clicks — PASS

- Clic real `#toggle-sidebar` → `#sidebar` display `""→"none"` → clic →
  restaurado `""`. Idem `#toggle-bottom`→`#bottom-panel`,
  `#toggle-inspector`→`#inspector` (los tres `flipped=true, backTo=true`).
  `task-F3.toggles.png` (1264×673, panel inferior oculto).
- Extra: atajo `Ctrl+B` alterna el sidebar en vivo (`""→"none"`).

## Gap (c) — OS-level file-drop — [~]-candidate «OS-level file-drop»

Texto exacto del gap: **OS-level file-drop**.
Por qué es incloseable por automatización en este entorno:

1. CDP `Input.dispatchDragEvent` no transporta rutas de ficheros del SO en
   Electron; Playwright no expone API de file-drop a nivel SO (solo
   file-chooser / setInputFiles, que no ejercen `pathsFromDrop`).
2. No existe canal desde este host Win32 hasta la ventana Electron que porte
   una ruta real de sistema de ficheros en un gesto drop.
3. Prueba viva de la limitación: drop sintético disparado DENTRO del renderer
   vivo (`new DataTransfer()` + `File` + `DragEvent("drop")` sobre
   `#welcome-dropzone`) produce el error honesto "No se recibió ninguna
   carpeta (soltado vacío)." — el `File` sintético no porta `path` de SO,
   exactamente como predice `pathsFromDrop` (welcome.tsx:26-61).
   `task-F3.drop-synthetic.png` (1264×673).

Closest real proof entregada (misma ruta de código que `handlePath` usa):

- `app.validateDirectory` en vivo por IPC real: fixture dir → `{ok:true}`,
  ruta inexistente → `{ok:false,"La carpeta no existe."}` (failure path del
  task-1), fichero → `{ok:false,"La ruta no es una carpeta."}`.
- Previa vigente: `validate-directory.test.ts` 5/5 (vacío / con-archivos /
  ausente / archivo / drop-texto) dentro del run verde del task-10.
- Para verde total basta UN gesto humano: arrastrar una carpeta real a la
  dropzone del welcome y observar el modo sesiones; nada más que probar.

## Adversarial

- misleading_success: 15/15 filas con asserts en página + PNGs de ventana
  completa (1264×673) + transcripción cruda; ningún PASS a mano.
- dirty_worktree: report-only (ver arriba); cero cambios fuera de evidencia.
- El `Unable to move the cache / bind()` del stderr de Electron es el ruido
  conocido del task-10 (doble-bind IPv4/IPv6); el endpoint CDP respondió y la
  app rindió con normalidad.

## DoneClaim

F3 verdict: **APPROVE** para (a) y (b) con prueba viva completa; gap (c) queda
como **[~]-candidate «OS-level file-drop»** con imposibilidad documentada y
closest real proof incluida — un solo gesto humano de drag lo pone en verde.

| Gap | Estado |
| --- | --- |
| (a) live workbench-WITH-project (toggles enabled, terminal rooted) | PASS |
| (b) toggles-with-project clicks | PASS |
| (c) OS-level file-drop | [~] «OS-level file-drop» + doc + closest proof |

# Nota de peso: terminal PTY en el proceso main (Todo 3, criterio de aceptacion)

- Fecha: 2026-11-01 · Ola 7, rama `feat/ux-skills-mcp-w7-design`
- Decision: **PTY-directo CONFIRMADO** — `node-pty` en el proceso main de Electron,
  con streaming por IPC hacia el renderer y creacion/escritura/cancelacion
  sometidas a la politica de shell (la sonda del Todo 31 la fijara; el ciclo
  PTY lo construye el Todo 32). El renderer nunca toca un PTY directamente.

## Cifras (medidas 2026-11-01 desde el registro npm)

- `node-pty@1.1.0` (canal `latest`): tarball con 286 archivos,
  `unpackedSize` 64 363 742 bytes (~61,4 MiB). Fuente: metadatos del registro
  (`https://registry.npmjs.org/node-pty/1.1.0`). Ese peso es el paquete
  completo: fuentes, cabeceras y prebuilds para todas las plataformas.
- Coste incremental real para Octus en Windows: solo el prebuild win32-x64
  (un binario `.node` de unos pocos MiB, estimacion pendiente de confirmacion
  al instalar en el Todo 32) mas el envoltorio JS (~100 KB). Electron ya viaja
  en el instalador, asi que no se duplica el runtime.
- Alternativa `child_process` sin PTY: 0 bytes extra, pero sin ConPTY en
  Windows: sin redimension, sin aplicaciones interactivas y sin secuencias ANSI
  fiables. No sirve como terminal persistente del workbench (IS-7).
- Memoria en ejecucion: un objeto ConPTY por terminal abierta; orden de KB por
  sesion inactiva. Sin impacto frente al presupuesto del Todo 5.

## Por que PTY-directo y no alternativa ligera

1. Windows usa ConPTY; `node-pty` es el unico binding maduro que lo expone a
   Node/Electron sin compilar C++ propio.
2. La politica de shell del Todo 31 se aplica igual en main antes de crear el
   PTY: el peso no relaja ninguna garantia de seguridad.
3. La alternativa (consola propia sobre pipes) reimplementa lo que ConPTY ya
   hace y costaria mas codigo propio que los pocos MiB del prebuild.

Conclusion: el peso es aceptable y se confirma PTY-directo para el Todo 32,
con la condicion de empaquetar solo el prebuild win32 y medir el instalador
final en el Todo 36.

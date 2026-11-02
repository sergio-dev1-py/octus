/**
 * Todo 21 — Utilidad zip mínima sin dependencias (solo stored + deflate).
 *
 * Motivo: `packages/core` no tiene librería zip y este Todo no puede descargar
 * nada sin autorización explícita; la escritura/lectura se implementa con
 * `node:zlib` (inflate/deflate incluidos en el runtime) y CRC32 propio.
 *
 * Límites deliberados (documentados, no fallos ocultos):
 * - Solo métodos 0 (stored) y 8 (deflate). Otro método → error `zip_unsupported`.
 * - Sin cifrado: flag bit 0 activo → error `zip_unsupported`.
 * - Sin timestamps ni permisos exóticos: se ignoran, no se propagan.
 * - La validación de rutas (traversal) vive en `skill-installer.ts`, que debe
 *   validar TODAS las entradas ANTES de escribir nada en disco.
 */

export interface ZipEntry {
  /** Nombre interno con `/` como separador (tal cual viene en el zip). */
  name: string;
  /** Contenido descomprimido. Vacío para entradas de directorio (`nombre/`). */
  data: Uint8Array;
  /** true si la entrada es un directorio (`nombre/`). */
  isDirectory: boolean;
}

function crc32(data: Uint8Array): number {
  let table = CRC_TABLE;
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    CRC_TABLE = table;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
let CRC_TABLE: Uint32Array | null = null;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Empaqueta entradas con método stored (sin compresión). Determinista. */
export function createZip(entries: Array<{ name: string; data: Uint8Array | string }>): Uint8Array {
  const normalized = entries.map((e) => ({
    name: e.name,
    bytes: typeof e.data === "string" ? encoder.encode(e.data) : e.data,
  }));
  // Tamaño: cabeceras locales + datos + directorio central + fin.
  let size = 0;
  const nameBytes = normalized.map((e) => encoder.encode(e.name));
  for (let i = 0; i < normalized.length; i++) size += 30 + nameBytes[i]!.length + normalized[i]!.bytes.length;
  let centralSize = 0;
  for (const nb of nameBytes) centralSize += 46 + nb.length;
  size += centralSize + 22;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let offset = 0;
  const centralOffsets: number[] = [];
  for (let i = 0; i < normalized.length; i++) {
    const nb = nameBytes[i]!;
    const bytes = normalized[i]!.bytes;
    centralOffsets.push(offset);
    view.setUint32(offset, 0x04034b50, true); offset += 4; // firma local
    view.setUint16(offset, 20, true); offset += 2; // versión
    view.setUint16(offset, 0, true); offset += 2; // flags
    view.setUint16(offset, 0, true); offset += 2; // método: stored
    view.setUint16(offset, 0, true); offset += 2; // hora
    view.setUint16(offset, 0, true); offset += 2; // fecha
    view.setUint32(offset, crc32(bytes), true); offset += 4;
    view.setUint32(offset, bytes.length, true); offset += 4;
    view.setUint32(offset, bytes.length, true); offset += 4;
    view.setUint16(offset, nb.length, true); offset += 2;
    view.setUint16(offset, 0, true); offset += 2; // extra
    out.set(nb, offset); offset += nb.length;
    out.set(bytes, offset); offset += bytes.length;
  }
  const centralStart = offset;
  for (let i = 0; i < normalized.length; i++) {
    const nb = nameBytes[i]!;
    const bytes = normalized[i]!.bytes;
    view.setUint32(offset, 0x02014b50, true); offset += 4; // firma central
    view.setUint16(offset, 20, true); offset += 2; // versión hecha
    view.setUint16(offset, 20, true); offset += 2; // versión necesaria
    view.setUint16(offset, 0, true); offset += 2; // flags
    view.setUint16(offset, 0, true); offset += 2; // método: stored
    view.setUint16(offset, 0, true); offset += 2;
    view.setUint16(offset, 0, true); offset += 2;
    view.setUint32(offset, crc32(bytes), true); offset += 4;
    view.setUint32(offset, bytes.length, true); offset += 4;
    view.setUint32(offset, bytes.length, true); offset += 4;
    view.setUint16(offset, nb.length, true); offset += 2;
    view.setUint16(offset, 0, true); offset += 2; // extra
    view.setUint16(offset, 0, true); offset += 2; // comentario
    view.setUint16(offset, 0, true); offset += 2; // disco
    view.setUint16(offset, 0, true); offset += 2; // attrs internos
    view.setUint32(offset, 0, true); offset += 4; // attrs externos
    view.setUint32(offset, centralOffsets[i]!, true); offset += 4;
    out.set(nb, offset); offset += nb.length;
  }
  const centralLen = offset - centralStart;
  view.setUint32(offset, 0x06054b50, true); offset += 4; // fin de directorio
  view.setUint16(offset, 0, true); offset += 2;
  view.setUint16(offset, 0, true); offset += 2;
  view.setUint16(offset, normalized.length, true); offset += 2;
  view.setUint16(offset, normalized.length, true); offset += 2;
  view.setUint32(offset, centralLen, true); offset += 4;
  view.setUint32(offset, centralStart, true); offset += 4;
  view.setUint16(offset, 0, true); offset += 2;
  return out;
}

/** Lee entradas de un buffer zip (métodos 0 y 8). No toca disco. */
export async function readZipEntries(zip: Uint8Array): Promise<ZipEntry[]> {
  const { inflateRawSync } = await import("node:zlib");
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // Localiza el fin de directorio (EOCD) buscando la firma hacia atrás.
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error("zip inválido: sin fin de directorio (EOCD)");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error("zip inválido: directorio central corrupto");
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = decoder.decode(zip.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (flags & 0x1) throw new Error(`zip no soportado (cifrado): ${JSON.stringify(name)}`);
    // Cabecera local: su propio nameLen/extraLen para hallar los datos.
    if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error("zip inválido: cabecera local corrupta");
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = zip.subarray(dataStart, dataStart + compSize);
    const isDirectory = name.endsWith("/");
    let data: Uint8Array;
    if (isDirectory) {
      data = new Uint8Array(0);
    } else if (method === 0) {
      data = raw;
    } else if (method === 8) {
      data = inflateRawSync(raw);
    } else {
      throw new Error(`zip no soportado (método ${method}): ${JSON.stringify(name)}`);
    }
    if (!isDirectory && (crc32(data) >>> 0) !== (crc >>> 0)) {
      throw new Error(`zip corrupto (CRC): ${JSON.stringify(name)}`);
    }
    entries.push({ name, data, isDirectory });
  }
  return entries;
}

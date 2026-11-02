/**
 * Octus desktop — terminal persistente con PTY en el proceso principal (Todo 32).
 *
 * Decisión de política (PTY-directo confirmado por la nota de peso del Todo 3;
 * marco permisivo de la sonda del Todo 31):
 * - El principal de la terminal es el USUARIO (sus keystrokes), no un agente.
 *   Crear una terminal es un gesto explícito del usuario y equivale a su
 *   aprobación por vez (nunca "siempre" persistente: cada terminal creada
 *   requiere su propio gesto; cerrar elimina todo).
 * - Ninguna herramienta de agente enruta hacia aquí: no existe definición en
 *   tool-definitions ni puerta en ToolGateway que escriba en una PTY, así que
 *   un run (plan o build) no puede inyectar keystrokes. La distinción de
 *   perfiles del Todo 31 aplica a los agentes, no a los dedos del usuario.
 * - Gates deterministas aplicados en main antes de spawnear y en cada
 *   operación: proyecto existente, CWD fijado a la raíz validada y legible
 *   del proyecto (checkDirectoryReadable), entorno hijo = scrubbedEnv() por
 *   allowlist (sin secretos heredados), validación de carga de cada canal IPC
 *   (tipos, tamaños, rangos), killTree (taskkill /T /F en Windows) al
 *   cancelar/cerrar/salir, y buffer de salida truncado.
 * - shell-guard (ADR-026) NO se aplica a los keystrokes: es una guarda contra
 *   agentes que evaden la puerta por shell; en la terminal propia del usuario
 *   (como la de VS Code) el usuario puede usar git libremente. Las líneas no
 *   se analizan porque los chunks son teclas, no comandos.
 */
import pty, { type IPty } from "node-pty";
import { createId } from "@octus/shared";
import { OctusError, isAlive, killTree, scrubbedEnv } from "@octus/core";
import type { TerminalChunk, TerminalInfo } from "@octus/shared";

export const TERMINAL_MAX_WRITE = 64 * 1024;
const TERMINAL_MAX_BUFFER_CHARS = 256 * 1024;
const TERMINAL_MAX_NAME = 64;
const MIN_COLS = 20;
const MAX_COLS = 240;
const MIN_ROWS = 5;
const MAX_ROWS = 100;
const KILL_GRACEFUL_MS = 1500;
const KILL_FORCE_MS = 5000;

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

function defaultShell(): { file: string; args: string[] } {
  if (process.platform === "win32") return { file: process.env.COMSPEC ?? "cmd.exe", args: [] };
  return { file: process.env.SHELL ?? "/bin/sh", args: [] };
}

interface TerminalRecord {
  info: TerminalInfo;
  pty: IPty;
  chunks: TerminalChunk[];
  bufferedChars: number;
  nextSeq: number;
}

export interface TerminalServiceOptions {
  /** Raíz validada del proyecto (main la resuelve por core + checkDirectoryReadable). */
  resolveRoot: (projectId: string) => Promise<string>;
  /** Streaming main → renderer (main lo puentea al canal TERMINAL_DATA_CHANNEL). */
  onData?: (chunk: TerminalChunk) => void;
}

export class TerminalService {
  private readonly terminals = new Map<string, TerminalRecord>();
  private activeId: string | undefined;
  private readonly resolveRoot: (projectId: string) => Promise<string>;
  private readonly onData: ((chunk: TerminalChunk) => void) | undefined;

  constructor(options: TerminalServiceOptions) {
    this.resolveRoot = options.resolveRoot;
    this.onData = options.onData;
  }

  list(projectId?: string): TerminalInfo[] {
    const out: TerminalInfo[] = [];
    for (const record of this.terminals.values()) {
      if (projectId !== undefined && record.info.projectId !== projectId) continue;
      out.push({ ...record.info, active: record.info.id === this.activeId });
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  private getRecord(id: string): TerminalRecord {
    if (typeof id !== "string" || id.length === 0 || id.length > 128) {
      throw new OctusError("invalid_tool_args", "Invalid terminal id");
    }
    const record = this.terminals.get(id);
    if (!record) throw new OctusError("not_found", `Terminal not found: ${id.slice(0, 64)}`);
    return record;
  }

  private pushChunk(record: TerminalRecord, data: string): void {
    let rest = data;
    while (rest.length > 0) {
      const piece = rest.slice(0, TERMINAL_MAX_WRITE);
      rest = rest.slice(piece.length);
      const chunk: TerminalChunk = { id: record.info.id, seq: record.nextSeq++, data: piece };
      record.chunks.push(chunk);
      record.bufferedChars += piece.length;
      this.onData?.(chunk);
    }
    while (record.bufferedChars > TERMINAL_MAX_BUFFER_CHARS && record.chunks.length > 0) {
      const dropped = record.chunks.shift()!;
      record.bufferedChars -= dropped.data.length;
    }
  }

  private spawnPty(record: TerminalRecord): void {
    const shell = defaultShell();
    const proc = pty.spawn(shell.file, shell.args, {
      name: "xterm-256color",
      cols: record.info.cols,
      rows: record.info.rows,
      cwd: record.info.cwd,
      env: scrubbedEnv() as Record<string, string | undefined>,
    });
    record.pty = proc;
    record.info.status = "open";
    record.info.exitCode = undefined;
    proc.onData((data: string) => {
      if (data.length > 0) this.pushChunk(record, data);
    });
    proc.onExit(({ exitCode }: { exitCode: number }) => {
      // No se re-spawnea solo: exited es visible por list/read hasta kill (reutiliza) o close.
      if (record.info.status === "open") {
        record.info.status = "exited";
        record.info.exitCode = exitCode;
      }
    });
  }

  async create(input: { projectId: string; name?: string; cols?: number; rows?: number }): Promise<TerminalInfo> {
    if (typeof input.projectId !== "string" || input.projectId.length === 0) {
      throw new OctusError("invalid_tool_args", "Invalid projectId");
    }
    const name = typeof input.name === "string" && input.name.trim().length > 0
      ? input.name.trim().slice(0, TERMINAL_MAX_NAME)
      : "terminal";
    const cols = clampInt(input.cols, 80, MIN_COLS, MAX_COLS);
    const rows = clampInt(input.rows, 24, MIN_ROWS, MAX_ROWS);
    // Gate: proyecto existente + raíz validada; el CWD queda fijado a esa raíz.
    const cwd = await this.resolveRoot(input.projectId);
    const id = createId("term");
    const record: TerminalRecord = {
      info: {
        id,
        name,
        projectId: input.projectId,
        cwd,
        cols,
        rows,
        status: "open",
        active: false,
        createdAt: Date.now(),
      },
      pty: undefined as unknown as IPty,
      chunks: [],
      bufferedChars: 0,
      nextSeq: 1,
    };
    try {
      this.spawnPty(record);
    } catch (error) {
      throw new OctusError("tool_failed", `Terminal spawn failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.terminals.set(id, record);
    if (this.activeId === undefined || !this.terminals.has(this.activeId)) this.activeId = id;
    return { ...record.info, active: record.info.id === this.activeId };
  }

  write(id: string, data: string): void {
    const record = this.getRecord(id);
    if (typeof data !== "string" || data.length === 0) throw new OctusError("invalid_tool_args", "Invalid data");
    if (data.length > TERMINAL_MAX_WRITE) throw new OctusError("invalid_tool_args", "Data exceeds 64KB per write");
    if (record.info.status !== "open") {
      throw new OctusError("tool_failed", "Terminal is not open (use kill to restart or close it)");
    }
    record.pty.write(data);
  }

  read(id: string, sinceSeq?: number): { chunks: TerminalChunk[]; nextSeq: number; status: TerminalInfo["status"]; exitCode?: number } {
    const record = this.getRecord(id);
    const since = typeof sinceSeq === "number" && Number.isFinite(sinceSeq) && sinceSeq >= 0 ? Math.floor(sinceSeq) : 0;
    return {
      chunks: record.chunks.filter((c) => c.seq > since).map((c) => ({ ...c })),
      nextSeq: record.nextSeq,
      status: record.info.status,
      exitCode: record.info.exitCode,
    };
  }

  resize(id: string, cols: number, rows: number): void {
    const record = this.getRecord(id);
    const nextCols = clampInt(cols, Number.NaN, MIN_COLS, MAX_COLS);
    const nextRows = clampInt(rows, Number.NaN, MIN_ROWS, MAX_ROWS);
    if (!Number.isFinite(nextCols) || !Number.isFinite(nextRows)) throw new OctusError("invalid_tool_args", "Invalid cols/rows");
    record.info.cols = nextCols;
    record.info.rows = nextRows;
    if (record.info.status === "open") record.pty.resize(nextCols, nextRows);
  }

  /**
   * Cancela el proceso en curso sin cerrar la terminal: intento amable
   * (pty.kill) y, si el proceso ignora la señal (caso failure del Todo 32),
   * el harness lo termina con killTree; después se re-spawnea el shell en el
   * mismo id y la terminal queda reutilizable.
   */
  async kill(id: string, sinceSeq = 0): Promise<{ restarted: boolean; forced: boolean; chunks: TerminalChunk[]; nextSeq: number }> {
    const record = this.getRecord(id);
    const pid = record.pty.pid;
    let forced = false;
    if (record.info.status === "open") {
      try {
        record.pty.kill();
      } catch {
        // sigue al killTree de abajo
      }
      const exited = await this.waitForExit(record, KILL_GRACEFUL_MS);
      if (!exited && isAlive(pid)) {
        forced = true;
        killTree(pid);
        await this.waitForExit(record, KILL_FORCE_MS);
      }
    } else if (isAlive(record.pty.pid)) {
      forced = true;
      killTree(record.pty.pid);
      await this.waitForExit(record, KILL_FORCE_MS);
    }
    const since = typeof sinceSeq === "number" && Number.isFinite(sinceSeq) && sinceSeq >= 0 ? Math.floor(sinceSeq) : 0;
    this.spawnPty(record);
    this.pushChunk(record, `\r\n[terminal] proceso cancelado${forced ? " (el harness terminó el árbol)" : ""}; shell reiniciado.\r\n`);
    // La respuesta lleva los chunks nuevos desde sinceSeq: el lector no depende
    // de ganarle una carrera al streaming para ver el marcador del reinicio.
    return {
      restarted: true,
      forced,
      chunks: record.chunks.filter((c) => c.seq > since).map((c) => ({ ...c })),
      nextSeq: record.nextSeq,
    };
  }

  private waitForExit(record: TerminalRecord, timeoutMs: number): Promise<boolean> {
    if (record.info.status !== "open") return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        clearInterval(poll);
        resolve(record.info.status !== "open");
      }, timeoutMs);
      const poll = setInterval(() => {
        if (record.info.status !== "open") {
          clearTimeout(timer);
          clearInterval(poll);
          resolve(true);
        }
      }, 50);
      timer.unref?.();
      (poll as unknown as { unref?: () => void }).unref?.();
    });
  }

  close(id: string): void {
    const record = this.getRecord(id);
    try {
      if (isAlive(record.pty.pid)) killTree(record.pty.pid);
    } catch {
      // ignore
    }
    this.terminals.delete(id);
    if (this.activeId === id) {
      const rest = [...this.terminals.keys()].sort();
      this.activeId = rest[0];
    }
  }

  select(id: string): void {
    this.getRecord(id);
    this.activeId = id;
  }

  /** Limpieza total (before-quit): mata cada árbol y suelta cada PTY. Devuelve cuántas cerró. */
  disposeAll(): number {
    let closed = 0;
    for (const id of [...this.terminals.keys()]) {
      try {
        this.close(id);
        closed++;
      } catch {
        // sigue con las demás
      }
    }
    this.activeId = undefined;
    return closed;
  }
}

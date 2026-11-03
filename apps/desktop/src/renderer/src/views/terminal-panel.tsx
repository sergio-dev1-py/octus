/** Renderer/views — terminal persistente estilo VSCode (una sola pestaña
 *  "Terminal" + selector de shell + acciones). Shells detectadas del sistema
 *  vía terminal.shells; el CWD se fija al directorio de la sesión activa al
 *  crearla (cambiar de proyecto no mueve las abiertas, solo las nuevas).
 *  xterm.js + FitAddon, IPC BYTE-IDENTICO al anterior (create/list/write/
 *  read/resize/kill/close/select + TERMINAL_DATA_CHANNEL, seq-gap resync
 *  append-only, resize con debounce, scrollback 2000). Entrada directa de
 *  teclado via term.onData.
 */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import type { TerminalChunk, TerminalInfo, TerminalShell } from "@octus/shared";
import { invoke } from "../api.js";
import { OcIcon } from "../components/oc.jsx";
import { state, toggleBottomPanel } from "../store.js";

const SCROLLBACK_LINES = 2000;
const RESIZE_DEBOUNCE_MS = 150;
const SHELL_PREF_KEY = "octus.terminal.shell";

/** Lee un token de diseno para tematizar xterm sin literales propios. */
function cssToken(name: string, fallback: string): string {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  } catch {
    return fallback;
  }
}

function storedShell(): string | undefined {
  try {
    return localStorage.getItem(SHELL_PREF_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function TerminalPanel(props: { projectId: string | undefined; projectRoot: string }) {
  const [terminals, setTerminals] = createSignal<TerminalInfo[]>([]);
  const [activeId, setActiveId] = createSignal<string | undefined>(undefined);
  const [notice, setNotice] = createSignal<string | undefined>(undefined);
  const [shells, setShells] = createSignal<TerminalShell[]>([]);
  const [shellId, setShellId] = createSignal<string | undefined>(storedShell());
  let hostRef: HTMLDivElement | undefined;
  let term: Terminal | undefined;
  let fit: FitAddon | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  let lastCols = 0;
  let lastRows = 0;
  let disposed = false;
  /** Estado de secuencia POR terminal: los seq son monotonos por PTY, no
   *  globales. Con un solo lastSeq/seen compartido, cambiar de un tab con
   *  seq alto a uno tranquilo metia los chunks nuevos en la rama gap y el
   *  resync devolvia [] (tab congelado, marcador de kill perdido). */
  interface SeqState { lastSeq: number; seen: Set<number> }
  const seqById = new Map<string, SeqState>();
  function seqState(id: string): SeqState {
    let st = seqById.get(id);
    if (!st) {
      st = { lastSeq: 0, seen: new Set<number>() };
      seqById.set(id, st);
    }
    return st;
  }

  const active = () => terminals().find((t) => t.id === activeId()) ?? terminals().find((t) => t.active);
  const sessionDir = () => state.sessions.find((s) => s.id === state.activeSessionId)?.directory ?? props.projectRoot;

  function appendChunk(chunk: TerminalChunk): void {
    // Dedup streaming vs polling: sin este filtro un chunk puede pintarse
    // dos veces (marcos duplicados en carreras).
    const st = seqState(chunk.id);
    if (st.seen.has(chunk.seq)) return;
    st.seen.add(chunk.seq);
    term?.write(chunk.data);
  }

  async function refresh(): Promise<void> {
    if (!props.projectId || disposed) return;
    try {
      const { terminals: list } = await invoke("terminal.list", { projectId: props.projectId });
      setTerminals(list);
      const current = list.find((t) => t.id === activeId()) ?? list.find((t) => t.active) ?? list[0];
      if (current && current.id !== activeId()) {
        setActiveId(current.id);
        await resync(current.id, 0);
      }
      setNotice(undefined);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  /** Avanza lastSeq SOLO con seqs vistos (nunca con nextSeq): pedir "desde nextSeq"
   *  pierde el chunk que ocupe exactamente ese seq (carrera del marcador del kill).
   *  El avance es por terminal (cada chunk actualiza su propio id). */
  function noteSeen(chunks: TerminalChunk[]): void {
    for (const chunk of chunks ?? []) {
      appendChunk(chunk);
      const st = seqState(chunk.id);
      if (chunk.seq > st.lastSeq) st.lastSeq = chunk.seq;
    }
  }

  async function resync(id: string, since: number, mode: "replace" | "append" = "replace"): Promise<void> {
    try {
      const out = await invoke("terminal.read", { id, sinceSeq: since });
      if (!out.ok) {
        setNotice(out.error ?? "read failed");
        return;
      }
      if (mode === "replace") {
        term?.clear();
        seqById.delete(id);
      }
      noteSeen(out.chunks ?? []);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function createTerminal(): Promise<void> {
    if (!props.projectId) return;
    try {
      const proposed = fit?.proposeDimensions();
      const shell = shells().find((s) => s.id === shellId()) ?? shells()[0];
      const out = await invoke("terminal.create", {
        projectId: props.projectId,
        name: shell?.name ?? "terminal",
        shellId: shell?.id,
        cwd: sessionDir(),
        ...(proposed ? { cols: proposed.cols, rows: proposed.rows } : {}),
      });
      if (!out.ok || !out.terminal) {
        setNotice(out.error ?? "create failed");
        return;
      }
      setTerminals((prev) => [...prev, out.terminal!]);
      setActiveId(out.terminal.id);
      lastCols = out.terminal.cols;
      lastRows = out.terminal.rows;
      await resync(out.terminal.id, 0);
      term?.focus();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function killActive(): Promise<void> {
    const id = active()?.id;
    if (!id) return;
    try {
      // sinceSeq del tab activo: la respuesta trae los chunks nuevos (marcador
      // del reinicio incluido) sin depender de ganarle una carrera al streaming.
      const out = await invoke("terminal.kill", { id, sinceSeq: seqState(id).lastSeq });
      if (!out.ok) {
        setNotice(out.error ?? "kill failed");
        return;
      }
      noteSeen(out.chunks ?? []);
      term?.focus();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function closeActive(): Promise<void> {
    const id = active()?.id;
    if (!id) return;
    try {
      const out = await invoke("terminal.close", { id });
      if (!out.ok) {
        setNotice(out.error ?? "close failed");
        return;
      }
      setTerminals((prev) => prev.filter((t) => t.id !== id));
      term?.clear();
      seqById.delete(id);
      const rest = terminals();
      setActiveId(rest[0]?.id);
      if (rest[0]) await resync(rest[0].id, 0);
      term?.focus();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function pick(id: string): Promise<void> {
    try {
      const out = await invoke("terminal.select", { id });
      if (!out.ok) {
        setNotice(out.error ?? "select failed");
        return;
      }
      setActiveId(id);
      await resync(id, 0);
      term?.focus();
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  function chooseShell(id: string): void {
    setShellId(id || undefined);
    try {
      if (id) localStorage.setItem(SHELL_PREF_KEY, id);
      else localStorage.removeItem(SHELL_PREF_KEY);
    } catch {
      // Sin almacenamiento: la preferencia solo vive en memoria.
    }
  }

  function scheduleResize(): void {
    if (resizeTimer !== undefined) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = undefined;
      void doResize();
    }, RESIZE_DEBOUNCE_MS);
  }

  async function doResize(): Promise<void> {
    if (disposed || !fit || !term) return;
    const id = active()?.id;
    if (!id) return;
    try {
      fit.fit();
    } catch {
      return;
    }
    const dims = fit.proposeDimensions();
    if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
    const cols = Math.floor(dims.cols);
    const rows = Math.floor(dims.rows);
    if (cols < 2 || rows < 1 || (cols === lastCols && rows === lastRows)) return;
    lastCols = cols;
    lastRows = rows;
    try {
      const out = await invoke("terminal.resize", { id, cols, rows });
      if (!out.ok) setNotice(out.error ?? "resize failed");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  onMount(() => {
    void invoke("terminal.shells", {}).then(({ shells: list }) => {
      if (disposed) return;
      setShells(list);
      if (!shellId() && list[0]) setShellId(list[0].id);
    }).catch(() => undefined);
    const host = hostRef;
    if (!host) {
      setNotice("terminal host missing");
      return;
    }
    const addon = new FitAddon();
    const instance = new Terminal({
      scrollback: SCROLLBACK_LINES,
      convertEol: true,
      cursorBlink: true,
      fontFamily: cssToken("--oc-font-mono", "Consolas, monospace"),
      fontSize: Number.parseFloat(cssToken("--oc-text-sm", "13px")) || 13,
      theme: {
        background: cssToken("--oc-panel-sunken", "#1f2433"),
        foreground: cssToken("--oc-text", "#e8eaf0"),
        cursor: cssToken("--oc-accent", "#2f7fe0"),
        selectionBackground: cssToken("--oc-accent-wash", "#2a3d5c"),
      },
    });
    term = instance;
    fit = addon;
    instance.loadAddon(addon);
    instance.open(host);
    // Entrada directa de teclado al PTY: cada tecla viaja por terminal.write
    // tal cual (sin shell-guard en keystrokes: es el usuario, no un agente).
    const dataDisposable = instance.onData((data) => {
      const id = active()?.id ?? activeId();
      if (!id || disposed) return;
      void invoke("terminal.write", { id, data }).then((out) => {
        if (!out.ok) setNotice(out.error ?? "write failed");
      });
    });
    try {
      addon.fit();
    } catch {
      // El contenedor aun no tiene tamano: el ResizeObserver lo ajustara.
    }
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => scheduleResize());
      resizeObserver.observe(host);
    }
    void refresh().then(() => {
      scheduleResize();
    });
    const off = window.octus.onTerminalData((chunk: TerminalChunk) => {
      if (disposed || chunk.id !== (active()?.id ?? activeId())) return;
      const st = seqState(chunk.id);
      // Hueco de secuencia (reconexión): re-sincroniza por polling y ANEXA
      // en vez de pintar parcial o limpiar el historial visible.
      if (chunk.seq !== st.lastSeq + 1 && st.lastSeq !== 0) {
        void resync(chunk.id, st.lastSeq, "append");
        return;
      }
      if (chunk.seq > st.lastSeq) st.lastSeq = chunk.seq;
      appendChunk(chunk);
    });
    onCleanup(() => {
      disposed = true;
      off();
      if (resizeTimer !== undefined) clearTimeout(resizeTimer);
      resizeObserver?.disconnect();
      dataDisposable.dispose();
      instance.dispose();
      term = undefined;
      fit = undefined;
    });
  });

  return (
    <div id="terminal-panel" aria-label="Terminal">
      <div class="term-bar" role="tablist" aria-label="Terminal">
        <span class="term-tab active" role="tab" aria-selected="true">Terminal</span>
        <select
          id="terminal-shell"
          class="term-shell"
          aria-label="Tipo de terminal"
          title="Tipo de terminal"
          value={shellId() ?? ""}
          onChange={(event) => chooseShell(event.currentTarget.value)}
        >
          <Show when={shells().length > 0} fallback={<option value="">shell…</option>}>
            <For each={shells()}>{(shell) => <option value={shell.id}>{shell.name}</option>}</For>
          </Show>
        </select>
        <span class="ab-spacer" />
        <Show when={terminals().length > 1}>
          <div class="term-tabs" aria-label="Terminales abiertas">
            <For each={terminals()}>
              {(t) => (
                <button
                  type="button"
                  data-terminal-id={t.id}
                  aria-selected={t.id === active()?.id}
                  class={t.id === active()?.id ? "term-chip active" : "term-chip"}
                  title={`${t.name} · ${t.status}`}
                  onClick={() => void pick(t.id)}
                >
                  {t.name}
                </button>
              )}
            </For>
          </div>
        </Show>
        <button type="button" id="terminal-create" class="icon-button" title="Nueva terminal" aria-label="Nueva terminal" disabled={!props.projectId} onClick={() => void createTerminal()}>
          +
        </button>
        <button type="button" id="terminal-close" class="icon-button" title="Cerrar terminal" aria-label="Cerrar terminal" disabled={!active()} onClick={() => void closeActive()}>
          <OcIcon name="trash" />
        </button>
        <Show when={active()?.status === "exited"}>
          <button type="button" id="terminal-restart" class="term-restart" title="Reiniciar shell" onClick={() => void killActive()}>
            Reiniciar
          </button>
        </Show>
        <button type="button" id="terminal-hide" class="icon-button" title="Ocultar terminal" aria-label="Ocultar terminal" onClick={() => void toggleBottomPanel()}>
          ×
        </button>
      </div>
      <Show when={notice()}>
        <p class="error" role="alert">{notice()}</p>
      </Show>
      <div id="terminal-xterm-host" ref={(el) => (hostRef = el)} hidden={!active()} aria-label="Terminal interactiva" onClick={() => term?.focus()} />
      <Show when={!active()}>
        <p class="muted">Sin terminales. Elige el tipo y pulsa + para abrir una en <code>{sessionDir()}</code>.</p>
      </Show>
    </div>
  );
}

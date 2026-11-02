/** Renderer/views — panel de terminal persistente (Todo 6, workbench-chat-terminal):
 *  xterm.js + FitAddon como superficie interactiva, contrato IPC BYTE-IDENTICO
 *  al pre+botones anterior (create/list/write/read/resize/kill/close/select +
 *  TERMINAL_DATA_CHANNEL, seq-gap resync append-only, resize con debounce,
 *  scrollback 2000). Entrada directa de teclado via term.onData: sin botones
 *  Enviar/Cancelar. Nota: el render <pre> previo se elimina (sin fallback);
 *  el historial completo se recupera por terminal.read al (re)montar. */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import type { TerminalChunk, TerminalInfo } from "@octus/shared";
import { invoke } from "../api.js";

const SCROLLBACK_LINES = 2000;
const RESIZE_DEBOUNCE_MS = 150;

/** Lee un token de diseno para tematizar xterm sin literales propios. */
function cssToken(name: string, fallback: string): string {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  } catch {
    return fallback;
  }
}

export function TerminalPanel(props: { projectId: string | undefined; projectRoot: string }) {
  const [terminals, setTerminals] = createSignal<TerminalInfo[]>([]);
  const [activeId, setActiveId] = createSignal<string | undefined>(undefined);
  const [notice, setNotice] = createSignal<string | undefined>(undefined);
  const [name, setName] = createSignal("terminal");
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
      const out = await invoke("terminal.create", {
        projectId: props.projectId,
        name: name().trim() || "terminal",
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
    const host = hostRef;
    if (!host) {
      setNotice("terminal host missing");
      return;
    }
    const addon = new FitAddon();
    const instance = new Terminal({
      scrollback: SCROLLBACK_LINES,
      convertEol: false,
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
    <div id="terminal-panel" aria-label="Terminal persistente">
      <div class="row" role="tablist" aria-label="Terminales">
        <For each={terminals()}>{(t) => <button type="button" data-terminal-id={t.id} aria-selected={t.id === active()?.id} class={t.id === active()?.id ? "active" : ""} onClick={() => void pick(t.id)}>{t.name} ({t.status})</button>}</For>
        <input id="terminal-name" value={name()} onInput={(e) => setName(e.currentTarget.value)} placeholder="nombre" aria-label="Nombre de la terminal" />
        <button type="button" id="terminal-create" class="primary" disabled={!props.projectId} onClick={() => void createTerminal()}>
          Nueva terminal
        </button>
      </div>
      <Show when={notice()}>
        <p class="error" role="alert">{notice()}</p>
      </Show>
      <div id="terminal-xterm-host" ref={(el) => (hostRef = el)} hidden={!active()} aria-label="Terminal interactiva" onClick={() => term?.focus()} />
      <Show when={active()} fallback={<p class="muted">Sin terminales. Crea una para trabajar en <code>{props.projectRoot}</code>.</p>}>
        <p class="muted" aria-live="polite">
          {active()?.name} · {active()?.status}
          <Show when={active()?.status === "exited"}> · exit {active()?.exitCode ?? "?"} — pulsa Reiniciar para reabrir el shell</Show>
        </p>
        <div class="row">
          <button type="button" id="terminal-kill" onClick={() => void killActive()}>
            Reiniciar
          </button>
          <button type="button" id="terminal-close" onClick={() => void closeActive()}>
            Cerrar terminal
          </button>
        </div>
      </Show>
    </div>
  );
}

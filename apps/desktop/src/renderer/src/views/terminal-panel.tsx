/** Renderer/views — panel de terminal persistente (Todo 32): PTY en main por IPC con streaming. */
import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import type { TerminalChunk, TerminalInfo } from "@octus/shared";
import { invoke } from "../api.js";

const MAX_LINES = 2000;

export function TerminalPanel(props: { projectId: string | undefined; projectRoot: string }) {
  const [terminals, setTerminals] = createSignal<TerminalInfo[]>([]);
  const [activeId, setActiveId] = createSignal<string | undefined>(undefined);
  const [lines, setLines] = createSignal<string[]>([]);
  const [notice, setNotice] = createSignal<string | undefined>(undefined);
  const [name, setName] = createSignal("terminal");
  const [input, setInput] = createSignal("");
  let outputRef: HTMLPreElement | undefined;
  let lastSeq = 0;
  let disposed = false;
  /** Seq ya pintados: el streaming y el polling se solapan; sin este filtro
   *  un chunk puede pintarse dos veces (marcos duplicados en carreras). */
  const seenSeqs = new Set<number>();

  const active = () => terminals().find((t) => t.id === activeId()) ?? terminals().find((t) => t.active);

  function appendChunk(chunk: TerminalChunk): void {
    if (seenSeqs.has(chunk.seq)) return;
    seenSeqs.add(chunk.seq);
    const text = chunk.data;
    setLines((prev) => {
      const next = [...prev, text];
      return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
    });
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
   *  pierde el chunk que ocupe exactamente ese seq (carrera del marcador del kill). */
  function noteSeen(chunks: TerminalChunk[]): void {
    let max = -1;
    for (const chunk of chunks ?? []) {
      appendChunk(chunk);
      if (chunk.seq > max) max = chunk.seq;
    }
    if (max >= 0) lastSeq = Math.max(lastSeq, max);
  }

  async function resync(id: string, since: number, mode: "replace" | "append" = "replace"): Promise<void> {
    try {
      const out = await invoke("terminal.read", { id, sinceSeq: since });
      if (!out.ok) {
        setNotice(out.error ?? "read failed");
        return;
      }
      if (mode === "replace") {
        setLines([]);
        seenSeqs.clear();
      }
      noteSeen(out.chunks ?? []);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function createTerminal(): Promise<void> {
    if (!props.projectId) return;
    try {
      const out = await invoke("terminal.create", { projectId: props.projectId, name: name().trim() || "terminal" });
      if (!out.ok || !out.terminal) {
        setNotice(out.error ?? "create failed");
        return;
      }
      setTerminals((prev) => [...prev, out.terminal!]);
      setActiveId(out.terminal.id);
      await resync(out.terminal.id, 0);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function send(suffix: string): Promise<void> {
    const id = active()?.id;
    if (!id) return;
    const data = input() + suffix;
    if (!data) return;
    try {
      const out = await invoke("terminal.write", { id, data });
      if (!out.ok) setNotice(out.error ?? "write failed");
      else setInput("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function killActive(): Promise<void> {
    const id = active()?.id;
    if (!id) return;
    try {
      // sinceSeq: la respuesta trae los chunks nuevos (marcador del reinicio
      // incluido) sin depender de ganarle una carrera al streaming.
      const out = await invoke("terminal.kill", { id, sinceSeq: lastSeq });
      if (!out.ok) {
        setNotice(out.error ?? "kill failed");
        return;
      }
      noteSeen(out.chunks ?? []);
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
      setLines([]);
      lastSeq = 0;
      const rest = terminals();
      setActiveId(rest[0]?.id);
      if (rest[0]) await resync(rest[0].id, 0);
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
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  onMount(() => {
    void refresh();
    const off = window.octus.onTerminalData((chunk: TerminalChunk) => {
      if (disposed || chunk.id !== (active()?.id ?? activeId())) return;
      // Hueco de secuencia (reconexión): re-sincroniza por polling y ANEXA
      // en vez de pintar parcial o limpiar el historial visible.
      if (chunk.seq !== lastSeq + 1 && lastSeq !== 0) {
        void resync(chunk.id, lastSeq, "append");
        return;
      }
      lastSeq = Math.max(lastSeq, chunk.seq);
      appendChunk(chunk);
    });
    onCleanup(() => {
      disposed = true;
      off();
    });
  });

  createEffect(() => {
    lines();
    outputRef?.scrollTo({ top: outputRef.scrollHeight });
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
      <Show when={active()} fallback={<p class="muted">Sin terminales. Crea una para trabajar en <code>{props.projectRoot}</code>.</p>}>
        <pre id="terminal-output" ref={outputRef} aria-label="Salida de la terminal">{lines().join("")}</pre>
        <div class="row">
          <input
            id="terminal-input"
            value={input()}
            onInput={(e) => setInput(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void send("\r");
            }}
            placeholder="escribe y pulsa Enter"
            aria-label="Entrada de la terminal"
          />
          <button type="button" id="terminal-send" onClick={() => void send("")}>
            Enviar
          </button>
          <button type="button" id="terminal-enter" onClick={() => void send("\r")}>
            Enviar + Enter
          </button>
          <button type="button" id="terminal-kill" onClick={() => void killActive()}>
            Cancelar proceso
          </button>
          <button type="button" id="terminal-close" onClick={() => void closeActive()}>
            Cerrar terminal
          </button>
        </div>
      </Show>
    </div>
  );
}

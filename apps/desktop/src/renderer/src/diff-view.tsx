/** Renderer — tarjeta de diff para archivos modificados en el chat. */
import { For, Show } from "solid-js";
import type { FileDiff } from "@octus/shared";
import { diffLines } from "./diff.js";

export function DiffCard(props: { diff: FileDiff }) {
  const result = diffLines(props.diff.before, props.diff.after);
  return (
    <details class="diff-card" open data-diff-path={props.diff.path}>
      <summary>
        <span class="diff-path">{props.diff.path}</span>
        <span class="diff-stat">
          <span class="diff-added">+{result.added}</span>
          <span class="diff-removed">−{result.removed}</span>
        </span>
      </summary>
      <div class="diff-grid" role="table" aria-label={`Diff de ${props.diff.path}`}>
        <For each={result.rows}>
          {(row) => {
            if (row.kind === "hunk") {
              return <div class="diff-hunk">{row.header ?? "@@ ... @@"}</div>;
            }
            const leftKind = row.left ? (row.kind === "same" ? "same" : "del") : "empty";
            const rightKind = row.right ? (row.kind === "same" ? "same" : "add") : "empty";
            return (
              <>
                <span class={`diff-cell diff-no diff-${leftKind}`}>{row.left?.no ?? ""}</span>
                <code class={`diff-cell diff-code diff-${leftKind}`} data-diff-side="left">{row.left?.text ?? ""}</code>
                <span class={`diff-cell diff-no diff-${rightKind}`}>{row.right?.no ?? ""}</span>
                <code class={`diff-cell diff-code diff-${rightKind}`} data-diff-side="right">{row.right?.text ?? ""}</code>
              </>
            );
          }}
        </For>
      </div>
      <Show when={result.truncated}>
        <p class="muted">Diff truncado por tamaño.</p>
      </Show>
    </details>
  );
}

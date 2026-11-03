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
          {(row) => (
            <>
              <span class={`diff-cell diff-no diff-${row.kind}`}>{row.left?.no ?? ""}</span>
              <code class={`diff-cell diff-code diff-${row.kind}`}>{row.left?.text ?? ""}</code>
              <span class={`diff-cell diff-no diff-${row.kind}`}>{row.right?.no ?? ""}</span>
              <code class={`diff-cell diff-code diff-${row.kind}`}>{row.right?.text ?? ""}</code>
            </>
          )}
        </For>
      </div>
      <Show when={result.truncated}>
        <p class="muted">Diff truncado por tamaño.</p>
      </Show>
    </details>
  );
}

/** Selector de modelo/effort reutilizable (Ajustes › Agentes). */
import { For, Show, createSignal } from "solid-js";
import type { ModelSelection } from "@octus/shared";
import { loadModels, state } from "../store.js";

export function ModelChoice(props: {
  value: ModelSelection;
  onChange: (value: ModelSelection) => void;
  disabled?: boolean;
  label?: string;
}) {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const current = () =>
    (state.modelsByProvider[props.value.providerId] ?? []).find((model) => model.modelId === props.value.modelId);
  const efforts = () => current()?.capabilities.reasoningEfforts ?? [];
  const groups = () => {
    const needle = query().trim().toLowerCase();
    return state.providers
      .map((provider) => ({
        providerId: provider.id,
        displayName: provider.displayName,
        configured: provider.configured,
        models: (state.modelsByProvider[provider.id] ?? []).filter((model) => {
          if (!model.capabilities.toolCall) return false;
          if (!needle) return true;
          return (
            model.displayName.toLowerCase().includes(needle) ||
            model.modelId.toLowerCase().includes(needle) ||
            provider.displayName.toLowerCase().includes(needle)
          );
        }),
      }))
      .filter((group) => group.models.length > 0 || !needle);
  };
  const openPicker = () => {
    if (props.disabled) return;
    const next = !open();
    setOpen(next);
    if (next) {
      setQuery("");
      for (const provider of state.providers) {
        if (provider.configured && !state.modelsByProvider[provider.id]) void loadModels(provider.id);
      }
    }
  };
  const pick = (providerId: string, modelId: string) => {
    const supported = (state.modelsByProvider[providerId] ?? []).find((model) => model.modelId === modelId)?.capabilities
      .reasoningEfforts ?? [];
    const effort = props.value.effort && (supported as string[]).includes(props.value.effort) ? props.value.effort : undefined;
    props.onChange({ providerId, modelId, ...(effort ? { effort } : {}) });
    setOpen(false);
  };
  return (
    <div class="model-choice" id={props.label}>
      <button
        type="button"
        class="composer-chip composer-model-button"
        title="Elegir modelo"
        disabled={props.disabled}
        aria-haspopup="listbox"
        aria-expanded={open()}
        onClick={openPicker}
      >
        <span class="value">
          {current()?.displayName ?? (props.value.modelId || "Elegir modelo…")}
        </span>
        <span aria-hidden="true">▾</span>
      </button>
      <Show when={efforts().length > 0}>
        <select
          class="composer-chip"
          aria-label="Esfuerzo de razonamiento"
          title="Esfuerzo de razonamiento del modelo"
          value={props.value.effort ?? ""}
          disabled={props.disabled}
          onChange={(event) => {
            const effort = event.currentTarget.value || undefined;
            props.onChange({ ...props.value, ...(effort ? { effort } : { effort: undefined }) });
          }}
        >
          <option value="">Default</option>
          <For each={efforts()}>{(effort) => <option value={effort}>{effort}</option>}</For>
        </select>
      </Show>
      <Show when={open()}>
        <div class="model-popover-backdrop" onClick={() => setOpen(false)} />
        <div class="model-popover" role="listbox" aria-label="Modelos disponibles">
          <input
            type="text"
            placeholder="Buscar modelo…"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            aria-label="Buscar modelo"
          />
          <For each={groups()}>
            {(group) => (
              <>
                <div class="model-group-label">
                  {group.displayName} {!group.configured ? <span class="muted">· sin key</span> : null}
                </div>
                <For each={group.models}>
                  {(model) => (
                    <button
                      type="button"
                      class="model-item"
                      aria-selected={model.modelId === props.value.modelId && group.providerId === props.value.providerId}
                      disabled={!group.configured}
                      title={!group.configured ? "Carga la API key en Ajustes › Proveedores" : `${model.modelId} · ctx ${model.capabilities.maxContextTokens.toLocaleString()}`}
                      onClick={() => pick(group.providerId, model.modelId)}
                    >
                      <span class="name">{model.displayName}</span>
                      <span class="sub">{model.modelId}</span>
                      <span class="sub">ctx {model.capabilities.maxContextTokens.toLocaleString()}</span>
                      <Show when={model.capabilities.reasoningEfforts.length > 0}>
                        <span class="sub">{model.capabilities.reasoningEfforts.join(" · ")}</span>
                      </Show>
                    </button>
                  )}
                </For>
              </>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

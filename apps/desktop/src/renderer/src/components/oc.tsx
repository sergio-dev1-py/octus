/** Componentes compartidos del workbench (Todo 7): botones, dialogo, menu,
    iconografia monocromatica, tabla y estados vacios y de error.
    Solo clases `oc-*` de components/oc-components.css, que a su vez solo usa
    var(--oc-*) del Todo 6. Sin tarjetas decorativas, sin emojis, sin valores
    literales de diseno. SolidJS puro y SSR-seguro (sin document/window). */
import { For, Show, createSignal, type JSX } from "solid-js";

/* --- botones --- */

export type OcButtonVariant = "primary" | "secondary" | "danger" | "ghost";

export interface OcButtonProps {
  id?: string;
  variant?: OcButtonVariant;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
  children: JSX.Element;
}

export function OcButton(props: OcButtonProps) {
  const variant = () => props.variant ?? "secondary";
  return (
    <button
      id={props.id}
      type="button"
      title={props.title}
      disabled={props.disabled}
      onClick={() => props.onClick?.()}
      class={`oc-btn oc-btn--${variant()}`}
    >
      {props.children}
    </button>
  );
}

/* --- dialogo --- */

export interface OcDialogProps {
  id: string;
  title: string;
  open: boolean;
  onClose?: () => void;
  actions?: JSX.Element;
  children: JSX.Element;
}

export function OcDialog(props: OcDialogProps) {
  return (
    <Show when={props.open}>
      <div
        class="oc-dialog-backdrop"
        data-oc-dialog-backdrop
        onClick={(event) => {
          if (event.target === event.currentTarget) props.onClose?.();
        }}
      >
        <div id={props.id} class="oc-dialog" role="dialog" aria-modal="true" aria-label={props.title}>
          <div class="oc-dialog__head">
            <h2 class="oc-dialog__title">{props.title}</h2>
            <button
              id={`${props.id}-close`}
              type="button"
              class="oc-btn oc-btn--ghost"
              aria-label="Close dialog"
              onClick={() => props.onClose?.()}
            >
              ×
            </button>
          </div>
          <div class="oc-dialog__body">{props.children}</div>
          <Show when={props.actions}>
            <div class="oc-dialog__actions">{props.actions}</div>
          </Show>
        </div>
      </div>
    </Show>
  );
}

/* --- menu --- */

export interface OcMenuItem {
  id: string;
  label: string;
  disabled?: boolean;
  onSelect?: () => void;
}

export interface OcMenuProps {
  id: string;
  label: string;
  items: OcMenuItem[];
  defaultOpen?: boolean;
}

export function OcMenu(props: OcMenuProps) {
  const [open, setOpen] = createSignal(props.defaultOpen ?? false);
  return (
    <div class="oc-menu" id={props.id}>
      <button
        id={`${props.id}-trigger`}
        type="button"
        class="oc-btn oc-btn--secondary"
        aria-haspopup="menu"
        aria-expanded={open() ? "true" : "false"}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{props.label}</span> <OcIcon name="chevron-down" />
      </button>
      <Show when={open()}>
        <div class="oc-menu__list" role="menu" aria-label={props.label}>
          <For each={props.items}>
            {(item) => (
              <button
                id={item.id}
                type="button"
                role="menuitem"
                class="oc-menu__item"
                disabled={item.disabled}
                onClick={() => {
                  item.onSelect?.();
                  setOpen(false);
                }}
              >
                {item.label}
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

/* --- iconografia monocromatica (trazo currentColor, sin rellenos) --- */

export type OcIconName =
  | "check"
  | "x"
  | "warn"
  | "info"
  | "chevron-down"
  | "chevron-right"
  | "plus"
  | "search"
  | "folder"
  | "folder-open"
  | "trash"
  | "gear"
  | "sort"
  | "panel-left"
  | "panel-bottom"
  | "panel-right"
  | "clock";

const OC_ICON_PATHS: Record<OcIconName, string> = {
  check: "M3 8.5l3.5 3.5L13 4.5",
  x: "M4 4l8 8M12 4l-8 8",
  warn: "M8 2.5L14.5 13.5h-13L8 2.5z",
  info: "M8 2.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11z",
  "chevron-down": "M4 6l4 4 4-4",
  "chevron-right": "M6 4l4 4-4 4",
  plus: "M8 3v10M3 8h10",
  search: "M7 2.5a4.5 4.5 0 100 9 4.5 4.5 0 000-9zM10.5 10.5L14 14",
  folder: "M1.5 4.5c0-.8.7-1.5 1.5-1.5h3l1.5 2H13c.8 0 1.5.7 1.5 1.5v4c0 .8-.7 1.5-1.5 1.5H3c-.8 0-1.5-.7-1.5-1.5v-6z",
  "folder-open": "M1.5 5.5c0-.8.7-1.5 1.5-1.5h3l1.5 2h5.5c.8 0 1.5.7 1.5 1.5v3.5c0 .8-.7 1.5-1.5 1.5h-10c-.8 0-1.5-.7-1.5-1.5v-5zM1.5 5.5L3 13",
  trash: "M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9.2c.1.7.6 1.3 1.3 1.3h4c.7 0 1.2-.6 1.3-1.3L12 4M6.5 7v4M9.5 7v4",
  gear: "M8 5.2a2.8 2.8 0 100 5.6 2.8 2.8 0 000-5.6zM8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M12.4 3.6l-1.2 1.2M4.8 11.2l-1.2 1.2",
  sort: "M5 2.5v11M5 13.5l-2.5-3M5 13.5l2.5-3M11 13.5v-11M11 2.5L8.5 5.5M11 2.5l2.5 3",
  "panel-left": "M2.5 3h11v10h-11zM6 3v10",
  "panel-bottom": "M2.5 3h11v10h-11zM2.5 10h11",
  "panel-right": "M2.5 3h11v10h-11zM10 3v10",
  "clock": "M8 2.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM8 5v3.2l2.2 1.3",
};

const OC_ICON_NAMES: OcIconName[] = ["check", "x", "warn", "info", "chevron-down", "chevron-right", "plus", "search", "folder", "folder-open", "trash", "gear", "sort", "panel-left", "panel-bottom", "panel-right", "clock"];

export function ocIconNames(): OcIconName[] {
  return [...OC_ICON_NAMES];
}

export function OcIcon(props: { name: OcIconName; label?: string }) {
  return (
    <svg
      class="oc-icon"
      data-icon={props.name}
      viewBox="0 0 16 16"
      stroke="currentColor"
      fill="none"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      role={props.label ? "img" : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : "true"}
    >
      <path d={OC_ICON_PATHS[props.name]} />
    </svg>
  );
}

/* --- tabla --- */

export interface OcTableColumn {
  key: string;
  label: string;
}

export interface OcTableProps {
  id: string;
  caption: string;
  columns: OcTableColumn[];
  rows: Record<string, string>[];
  emptyTitle?: string;
  emptyHint?: string;
}

export function OcTable(props: OcTableProps) {
  return (
    <Show
      when={props.rows.length > 0}
      fallback={<OcEmpty id={`${props.id}-empty`} title={props.emptyTitle ?? "No rows"} hint={props.emptyHint} />}
    >
      <table class="oc-table" id={props.id}>
        <caption class="oc-table__caption">{props.caption}</caption>
        <thead>
          <tr>
            <For each={props.columns}>{(col) => <th scope="col">{col.label}</th>}</For>
          </tr>
        </thead>
        <tbody>
          <For each={props.rows}>
            {(row) => (
              <tr data-oc-row>
                <For each={props.columns}>{(col) => <td>{row[col.key] ?? ""}</td>}</For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </Show>
  );
}

/* --- estado vacio --- */

export interface OcEmptyProps {
  id?: string;
  title: string;
  hint?: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function OcEmpty(props: OcEmptyProps) {
  return (
    <div class="oc-empty" data-oc-empty id={props.id}>
      <p class="oc-empty__title">{props.title}</p>
      <Show when={props.hint}>
        <p class="oc-empty__hint">{props.hint}</p>
      </Show>
      <Show when={props.actionLabel}>
        <OcButton id={props.id ? `${props.id}-action` : undefined} variant="secondary" onClick={() => props.onAction?.()}>
          {props.actionLabel}
        </OcButton>
      </Show>
    </div>
  );
}

/* --- estado de error --- */

export interface OcErrorProps {
  id?: string;
  message: string;
  retryLabel?: string;
  onRetry?: () => void;
}

export function OcErrorState(props: OcErrorProps) {
  return (
    <div class="oc-error" role="alert" data-oc-error id={props.id}>
      <OcIcon name="warn" label="Error" />
      <p class="oc-error__message">{props.message}</p>
      <OcButton id={props.id ? `${props.id}-retry` : undefined} variant="primary" onClick={() => props.onRetry?.()}>
        {props.retryLabel ?? "Retry"}
      </OcButton>
    </div>
  );
}

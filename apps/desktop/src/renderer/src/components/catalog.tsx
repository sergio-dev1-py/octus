/** Catalogo de componentes compartidos (Todo 7): renderiza cada variante con
    selectores fijos para la prueba por script. Estado interactivo minimo
    (dialogo cerrable, menu conmutable) para probar reactividad SolidJS real. */
import { For, createSignal } from "solid-js";
import { OcButton, OcDialog, OcEmpty, OcErrorState, OcIcon, OcMenu, OcTable, ocIconNames } from "./oc.jsx";

const COLUMNS = [
  { key: "id", label: "ID" },
  { key: "name", label: "Name" },
  { key: "status", label: "Status" },
];

const ROWS = [
  { id: "a1", name: "alpha", status: "ready" },
  { id: "b2", name: "beta", status: "running" },
];

export default function CatalogView() {
  const [dialogOpen, setDialogOpen] = createSignal(true);
  const [dialogNote, setDialogNote] = createSignal("not-confirmed");
  return (
    <div class="oc-catalog" id="oc-catalog">
      <section class="oc-catalog__section" aria-label="Buttons">
        <h2>Buttons</h2>
        <div class="oc-catalog__row">
          <OcButton id="oc-btn-primary" variant="primary">
            Primary
          </OcButton>
          <OcButton id="oc-btn-secondary" variant="secondary">
            Secondary
          </OcButton>
          <OcButton id="oc-btn-danger" variant="danger">
            Danger
          </OcButton>
          <OcButton id="oc-btn-ghost" variant="ghost">
            Ghost
          </OcButton>
          <OcButton id="oc-btn-disabled" variant="secondary" disabled>
            Disabled
          </OcButton>
        </div>
      </section>

      <section class="oc-catalog__section" aria-label="Dialog">
        <h2>Dialog</h2>
        <p class="oc-empty__hint" data-oc-dialog-note>
          dialog: {dialogNote()}
        </p>
        <OcButton id="oc-dialog-reopen" variant="secondary" onClick={() => setDialogOpen(true)}>
          Reopen dialog
        </OcButton>
        <OcDialog
          id="oc-dialog"
          title="Confirm action"
          open={dialogOpen()}
          onClose={() => setDialogOpen(false)}
          actions={
            <>
              <OcButton id="oc-dialog-cancel" variant="ghost" onClick={() => setDialogOpen(false)}>
                Cancel
              </OcButton>
              <OcButton
                id="oc-dialog-ok"
                variant="primary"
                onClick={() => {
                  setDialogNote("confirmed");
                  setDialogOpen(false);
                }}
              >
                Confirm
              </OcButton>
            </>
          }
        >
          <p>This dialog blocks the workbench until you confirm or cancel.</p>
        </OcDialog>
      </section>

      <section class="oc-catalog__section" aria-label="Menus">
        <h2>Menus</h2>
        <div class="oc-catalog__row">
          <OcMenu
            id="oc-menu"
            label="Actions"
            items={[
              { id: "oc-menu-item-a", label: "First action" },
              { id: "oc-menu-item-b", label: "Blocked action", disabled: true },
            ]}
          />
          <OcMenu
            id="oc-menu-open"
            label="Open menu"
            defaultOpen
            items={[
              { id: "oc-menu-open-item-a", label: "First action" },
              { id: "oc-menu-open-item-b", label: "Blocked action", disabled: true },
            ]}
          />
        </div>
      </section>

      <section class="oc-catalog__section" aria-label="Icons">
        <h2>Icons</h2>
        <div class="oc-catalog__row" id="oc-icons">
          <For each={ocIconNames()}>{(name) => <OcIcon name={name} />}</For>
        </div>
      </section>

      <section class="oc-catalog__section" aria-label="Table">
        <h2>Table</h2>
        <OcTable id="oc-table" caption="QA rows" columns={COLUMNS} rows={ROWS} />
        <OcTable id="oc-table-empty" caption="Empty rows" columns={COLUMNS} rows={[]} emptyTitle="No rows yet" emptyHint="Add a row to see it here." />
      </section>

      <section class="oc-catalog__section" aria-label="Empty state">
        <h2>Empty state</h2>
        <OcEmpty id="oc-empty" title="Nothing here yet" hint="Create the first entry to get started." actionLabel="Create entry" />
      </section>

      <section class="oc-catalog__section" aria-label="Error state">
        <h2>Error state</h2>
        <OcErrorState id="oc-error" message="Could not load rows: connection refused." retryLabel="Retry load" />
      </section>
    </div>
  );
}

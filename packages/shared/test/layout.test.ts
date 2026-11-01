import { describe, expect, test } from "bun:test";
import {
  BOTTOM_MAX,
  BOTTOM_MIN,
  DEFAULT_LAYOUT,
  INSPECTOR_MAX,
  INSPECTOR_MIN,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  UI_LAYOUT_KEY,
  isBottomTab,
  isWorkbenchLayout,
  layoutStyles,
  parseStoredLayout,
  parseWorkbenchLayout,
  resetLayout,
  resizeBottomBy,
  resizeInspectorBy,
  resizeSidebarBy,
  setActivity,
  setBottomTab,
  toggleBottom,
  toggleInspector,
  toggleSidebar,
  type WorkbenchLayout,
} from "../src/layout.js";

const VALID: WorkbenchLayout = {
  activity: "plans",
  sidebarVisible: false,
  sidebarWidth: 300,
  inspectorVisible: true,
  inspectorWidth: 260,
  bottomVisible: false,
  bottomHeight: 200,
  bottomTab: "problems",
};

describe("workbench layout (Todo 8)", () => {
  test("clave kv propia del layout", () => {
    expect(UI_LAYOUT_KEY).toBe("ui.layout.v1");
  });

  test("defecto: explorer con los tres paneles visibles", () => {
    expect(DEFAULT_LAYOUT).toEqual({
      activity: "explorer",
      sidebarVisible: true,
      sidebarWidth: 264,
      inspectorVisible: true,
      inspectorWidth: 248,
      bottomVisible: true,
      bottomHeight: 180,
      bottomTab: "terminal",
    });
  });

  test("validación estricta acepta el defecto y rechaza basura", () => {
    expect(isWorkbenchLayout({ ...DEFAULT_LAYOUT })).toBe(true);
    expect(isWorkbenchLayout(VALID)).toBe(true);
    expect(isWorkbenchLayout(null)).toBe(false);
    expect(isWorkbenchLayout({ ...VALID, activity: "consola" })).toBe(false);
    expect(isWorkbenchLayout({ ...VALID, bottomTab: "chat" })).toBe(false);
    expect(isWorkbenchLayout({ ...VALID, sidebarWidth: Number.NaN })).toBe(false);
    expect(isWorkbenchLayout({ ...VALID, sidebarVisible: "si" })).toBe(false);
    expect(isBottomTab("output")).toBe(true);
    expect(isBottomTab("chat")).toBe(false);
  });

  test("ocultar y restaurar cada panel es reversible", () => {
    const start = { ...DEFAULT_LAYOUT };
    expect(toggleSidebar(start).sidebarVisible).toBe(false);
    expect(toggleSidebar(toggleSidebar(start))).toEqual(start);
    expect(toggleInspector(start).inspectorVisible).toBe(false);
    expect(toggleInspector(toggleInspector(start))).toEqual(start);
    expect(toggleBottom(start).bottomVisible).toBe(false);
    expect(toggleBottom(toggleBottom(start))).toEqual(start);
  });

  test("redimensionar recorta a los rangos del sistema", () => {
    expect(resizeSidebarBy(DEFAULT_LAYOUT, 10_000).sidebarWidth).toBe(SIDEBAR_MAX);
    expect(resizeSidebarBy(DEFAULT_LAYOUT, -10_000).sidebarWidth).toBe(SIDEBAR_MIN);
    expect(resizeSidebarBy(DEFAULT_LAYOUT, 36).sidebarWidth).toBe(300);
    expect(resizeInspectorBy(DEFAULT_LAYOUT, -10_000).inspectorWidth).toBe(INSPECTOR_MAX);
    expect(resizeInspectorBy(DEFAULT_LAYOUT, 10_000).inspectorWidth).toBe(INSPECTOR_MIN);
    expect(resizeBottomBy(DEFAULT_LAYOUT, -10_000).bottomHeight).toBe(BOTTOM_MAX);
    expect(resizeBottomBy(DEFAULT_LAYOUT, 10_000).bottomHeight).toBe(BOTTOM_MIN);
    // Deltas no finitos no tocan nada.
    expect(resizeSidebarBy(DEFAULT_LAYOUT, Number.NaN)).toEqual(DEFAULT_LAYOUT);
  });

  test("actividad y pestaña: válidas conmutan y muestran, inválidas no tocan", () => {
    const hidden = toggleSidebar(toggleBottom(DEFAULT_LAYOUT));
    const switched = setActivity(hidden, "agents");
    expect(switched.activity).toBe("agents");
    expect(switched.sidebarVisible).toBe(true);
    expect(setActivity(switched, "x" as never)).toEqual(switched);
    const tabbed = setBottomTab({ ...DEFAULT_LAYOUT, bottomVisible: false }, "output");
    expect(tabbed.bottomTab).toBe("output");
    expect(tabbed.bottomVisible).toBe(true);
    expect(setBottomTab(tabbed, "x" as never)).toEqual(tabbed);
  });

  test("resetLayout devuelve el defecto", () => {
    expect(resetLayout()).toEqual(DEFAULT_LAYOUT);
    expect(resetLayout()).not.toBe(DEFAULT_LAYOUT);
  });

  test("layoutStyles es la traducción que aplica el renderer", () => {
    const styles = layoutStyles(DEFAULT_LAYOUT);
    expect(styles.sidebar).toEqual({ display: "", width: "264px" });
    expect(styles.inspector).toEqual({ display: "", width: "248px" });
    expect(styles.bottom).toEqual({ display: "", height: "180px" });
    const hidden = layoutStyles(toggleBottom(toggleSidebar(DEFAULT_LAYOUT)));
    expect(hidden.sidebar.display).toBe("none");
    expect(hidden.bottom.display).toBe("none");
    expect(hidden.inspector.display).toBe("");
  });

  test("ida y vuelta: serializar, ocultar y redimensionar, reafirmar", () => {
    const changed = resizeBottomBy(toggleInspector(VALID), -40);
    const back = parseStoredLayout(JSON.stringify(changed));
    expect(back).toEqual(changed);
    expect(isWorkbenchLayout(back)).toBe(true);
  });

  test("failure: layout corrupto degrada al defecto sin lanzar", () => {
    for (const corrupt of ["{no-json", "", undefined, null, "42", "[1,2]", JSON.stringify({ activity: "x", sidebarWidth: "ancho" })]) {
      expect(parseStoredLayout(corrupt as string)).toEqual({ ...DEFAULT_LAYOUT });
    }
    // Degradación por campo: lo válido sobrevive, lo corrupto cae al defecto.
    expect(
      parseWorkbenchLayout({ activity: "plans", sidebarVisible: "si", sidebarWidth: 10_000, bottomTab: "output" }),
    ).toEqual({ ...DEFAULT_LAYOUT, activity: "plans", sidebarWidth: SIDEBAR_MAX, bottomTab: "output" });
  });
});

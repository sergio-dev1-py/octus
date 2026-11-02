/** Renderer — fachada del store: reexporta los módulos por responsabilidad.
 * La ruta "./store.js" y toda la API pública se conservan sin cambios. */
export * from "./store/skills.js"; // Todo 24 (montaje aditivo): acciones de Skills
export * from "./store/state.js";
export * from "./store/projects.js";
export * from "./store/plans.js";
export * from "./store/settings.js";
export * from "./store/welcome.js";
export * from "./store/tasks.js";
export * from "./store/runs.js";
export * from "./store/worktrees.js";
export * from "./store/integrations.js";
export * from "./store/memory.js";
export * from "./store/prefsLayout.js";
export * from "./store/events.js";
export * from "./store/bootstrap.js";
export * from "./store/mcp.js";
export * from "./store/schedules.js"; // Todo 8 (ventana de programadas): CRUD + validación de cron
export * from "./store/files.js"; // Todo 33: explorador, diff, pruebas y diagnósticos

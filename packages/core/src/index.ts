/** @octus/core — superficie pública. */
export * from "./errors.js";
export * from "./util.js";
export * from "./persistence/persistence-service.js";
export * from "./persistence/schema.js";
export * from "./events/event-store.js";
export * from "./secrets/secret-store.js";
export * from "./config/config-store.js";
export * from "./providers/pricing.js";
export * from "./providers/model-router.js";
export * from "./providers/meta-adapter.js";
export * from "./providers/go-adapter.js";
export * from "./permissions/permission-manager.js";
export * from "./questions/question-service.js";
export * from "./tools/tool-gateway.js";
export * from "./tools/tool-definitions.js";
export * from "./tools/path-scope.js";
export * from "./mcp/mcp-client-manager.js";
export * from "./mcp/mcp-tool-bridge.js";
export * from "./mcp/mcp-server-management.js";
export * from "./agents/agent-registry.js";
export * from "./skills/skill-manager.js";
export * from "./skills/skill-activation.js"; // Todo 22: activación/alcances/persistencia (extensión compatible: solo añade)
export * from "./skills/skill-runtime.js"; // Todo 23: carga progresiva + registro por run (extensión compatible: solo añade)
export * from "./skills/skill-installer.js"; // Todo 24 (montaje aditivo): expone SkillInstaller + InstallProvenance + zip a main sin tocar los módulos 18-23
export { promptHashOf, snapshotOf } from "./agents/definition-loader.js";
export * from "./prompts/prompts.js";
export * from "./runtime/context-builder.js";
export * from "./runtime/agent-runtime.js";
export * from "./costs/budgets.js";
export * from "./costs/usage.js";
export * from "./sessions/octus-core.js";
export * from "./explorer/file-explorer.js"; // Todo 33: explorador paginado de solo lectura
export * from "./tools/process-tree.js"; // Todo 32: entorno depurado y killTree para la PTY de main

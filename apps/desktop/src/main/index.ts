/**
 * Octus desktop — proceso principal. Aloja OctusCore y expone el contrato IPC único.
 * Sin invoke genérico: cada canal valida emisor y carga (ADR-014).
 */
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import { OctusCore } from "@octus/core";
import {
  IPC_EVENT_CHANNEL,
  type CoreEvent,
  type IpcChannel,
  type IpcRequest,
  type IpcResponse,
  type PersistedEvent,
  type StreamEvent,
} from "@octus/shared";
import { ElectronSecretStore } from "./secret-store.js";
import { resolveDefinitionsDir, resolveWorkerPath } from "./worker-path.js";

const CHANNELS: IpcChannel[] = [
  "app.versions",
  "app.pickDirectory",
  "projects.list",
  "projects.create",
  "sessions.list",
  "sessions.create",
  "sessions.get",
  "sessions.delete",
  "sessions.rename",
  "sessions.setProfile",
  "sessions.setModel",
  "sessions.messages",
  "sessions.prompt",
  "sessions.interrupt",
  "runs.get",
  "runs.usage",
  "providers.list",
  "providers.models",
  "providers.setKey",
  "providers.removeKey",
  "providers.test",
  "budgets.status",
  "budgets.configure",
  "permissions.pending",
  "permissions.reply",
  "permissions.saved",
  "permissions.revokeSaved",
  "questions.pending",
  "questions.reply",
  "agents.definitions",
  "agents.instances",
  "agents.cancel",
  "agents.limits",
  "agents.setLimits",
  "agents.setDefinitionModel",
  "plans.list",
  "plans.get",
  "plans.approve",
  "plans.reject",
  "plans.archive",
  "plans.export",
  "plans.implement",
  "approvals.pending",
  "approvals.decide",
  "projects.isolatedDirs",
  "projects.addIsolatedDir",
  "projects.removeIsolatedDir",
  "projects.testAllowlist",
  "projects.saveTestAllowlist",
  "projects.trustedInstructions",
  "projects.saveTrustedInstructions",
  "tasks.list",
  "tasks.get",
  "tasks.cancel",
  "tasks.retry",
  "tasks.review",
  "tasks.scheduler",
  "worktrees.list",
  "worktrees.get",
  "worktrees.cleanup",
  "repos.inspect",
  "repos.setWorktreesRoot",
  "integrations.create",
  "integrations.get",
  "integrations.list",
  "integrations.rebuild",
  "integrations.abort",
  "integrations.incorporate",
  "integrations.spawnReviewer",
  "integrations.review",
  "conflicts.list",
  "conflicts.get",
  "conflicts.requestResolution",
  "conflicts.finalize",
  "conflicts.incorporate",
  "conflicts.abort",
  "conflicts.cleanup",
  "validations.list",
  "validations.rerun",
  "previews.create",
  "previews.list",
  "previews.start",
  "previews.stop",
  "previews.restart",
  "previews.inspect",
  "previews.logs",
  "previews.cleanup",
  "previews.allowlist",
  "previews.saveAllowlist",
  "approvals.approve",
  "approvals.reject",
  "approvals.status",
  "promotions.promote",
  "promotions.status",
];

let mainWindow: BrowserWindow | undefined;
let core: OctusCore | undefined;

function dataDir(): string {
  return process.env.OCTUS_DATA_DIR ?? path.join(app.getPath("userData"), "data");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function assertSender(event: IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error("IPC rejected: unknown sender");
  }
}

function pushEvent(event: CoreEvent): void {
  mainWindow?.webContents.send(IPC_EVENT_CHANNEL, event);
}

function onCoreEvent(event: PersistedEvent): void {
  pushEvent({ kind: "event", event });
}

function onStream(event: StreamEvent): void {
  pushEvent(event);
}

type Handler<C extends IpcChannel> = (payload: IpcRequest<C>) => Promise<IpcResponse<C>>;

function handlers(): { [C in IpcChannel]: Handler<C> } {
  const need = (): OctusCore => {
    if (!core) throw new Error("core is not ready");
    return core;
  };
  return {
    "app.versions": async () => ({ octus: "0.1.0", electron: process.versions.electron ?? "", node: process.versions.node ?? "" }),
    "app.pickDirectory": async () => {
      const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
      return { path: result.canceled ? undefined : result.filePaths[0] };
    },
    "projects.list": async () => ({ projects: await need().listProjects() }),
    "projects.create": async (payload) => {
      if (!isNonEmptyString(payload.name) || !isNonEmptyString(payload.rootPath)) throw new Error("invalid payload");
      return { project: await need().createProject(payload.name, payload.rootPath) };
    },
    "sessions.list": async (payload) => ({ sessions: await need().listSessions(payload.projectId) }),
    "sessions.create": async (payload) => {
      if (!isNonEmptyString(payload.projectId)) throw new Error("invalid payload");
      return { session: await need().createSession(payload) };
    },
    "sessions.get": async (payload) => {
      if (!isNonEmptyString(payload.sessionId)) throw new Error("invalid payload");
      return need().getSession(payload.sessionId);
    },
    "sessions.delete": async (payload) => {
      if (!isNonEmptyString(payload.sessionId)) throw new Error("invalid payload");
      await need().deleteSession(payload.sessionId);
      return { ok: true };
    },
    "sessions.rename": async (payload) => {
      if (!isNonEmptyString(payload.sessionId) || typeof payload.title !== "string") throw new Error("invalid payload");
      await need().renameSession(payload.sessionId, payload.title);
      return { ok: true };
    },
    "sessions.setProfile": async (payload) => {
      if (!isNonEmptyString(payload.sessionId) || (payload.profile !== "plan" && payload.profile !== "build")) throw new Error("invalid payload");
      await need().setSessionProfile(payload.sessionId, payload.profile);
      return { ok: true };
    },
    "sessions.setModel": async (payload) => {
      if (!isNonEmptyString(payload.sessionId) || typeof payload.model !== "object" || payload.model === null) throw new Error("invalid payload");
      try {
        await need().setSessionModel(payload.sessionId, payload.model);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    "sessions.messages": async (payload) => {
      if (!isNonEmptyString(payload.sessionId)) throw new Error("invalid payload");
      return { messages: await need().sessionMessages(payload.sessionId, payload.runId) };
    },
    "sessions.prompt": async (payload) => {
      if (!isNonEmptyString(payload.sessionId) || typeof payload.text !== "string" || !payload.text.trim()) throw new Error("invalid payload");
      try {
        return await need().prompt(payload.sessionId, payload.text, onStream);
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error));
      }
    },
    "sessions.interrupt": async (payload) => {
      if (!isNonEmptyString(payload.sessionId)) throw new Error("invalid payload");
      await need().interrupt(payload.sessionId);
      return { ok: true };
    },
    "runs.get": async (payload) => {
      if (!isNonEmptyString(payload.runId)) throw new Error("invalid payload");
      return need().getRun(payload.runId);
    },
    "runs.usage": async (payload) => {
      if (!isNonEmptyString(payload.runId)) throw new Error("invalid payload");
      return { records: await need().runUsage(payload.runId) };
    },
    "providers.list": async () => ({ providers: await need().listProviders() }),
    "providers.models": async (payload) => {
      if (!isNonEmptyString(payload.providerId)) throw new Error("invalid payload");
      const found = (await need().listProviders()).find((p) => p.id === payload.providerId);
      return { models: found?.models ?? [] };
    },
    "providers.setKey": async (payload) => {
      if (!isNonEmptyString(payload.providerId) || typeof payload.apiKey !== "string" || !payload.apiKey.trim()) {
        return { ok: false, error: "invalid payload" };
      }
      try {
        await need().setProviderKey(payload.providerId, payload.apiKey);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    "providers.removeKey": async (payload) => {
      if (!isNonEmptyString(payload.providerId)) throw new Error("invalid payload");
      await need().removeProviderKey(payload.providerId);
      return { ok: true };
    },
    "providers.test": async (payload) => {
      if (!isNonEmptyString(payload.providerId)) throw new Error("invalid payload");
      return need().testProvider(payload.providerId);
    },
    "budgets.status": async () => need().budgetsStatus(),
    "budgets.configure": async (payload) => {
      if (!Array.isArray(payload.budgets)) throw new Error("invalid payload");
      for (const budget of payload.budgets) {
        if (typeof budget !== "object" || budget === null) throw new Error("invalid budget");
        const scope = (budget as { scope?: { kind?: unknown } }).scope;
        if (!scope || !["global", "provider", "model", "agent", "session", "run"].includes(scope.kind as string)) {
          throw new Error("invalid budget scope");
        }
      }
      await need().configureBudgets(payload.budgets);
      return { ok: true };
    },
    "permissions.pending": async (payload) => ({ requests: need().permissions.pendingFor(payload.sessionId) }),
    "permissions.reply": async (payload) => {
      if (!isNonEmptyString(payload.requestId) || !["once", "always", "reject"].includes(payload.decision)) throw new Error("invalid payload");
      return { ok: need().permissions.reply(payload.requestId, payload.decision, payload.message) };
    },
    "permissions.saved": async (payload) => {
      if (!isNonEmptyString(payload.projectId)) throw new Error("invalid payload");
      return { rules: await need().permissions.savedRules(payload.projectId) };
    },
    "permissions.revokeSaved": async (payload) => {
      if (!isNonEmptyString(payload.ruleId)) throw new Error("invalid payload");
      await need().permissions.revokeSaved(payload.ruleId);
      return { ok: true };
    },
    "questions.pending": async (payload) => ({ requests: need().questions.pendingFor(payload.sessionId) }),
    "questions.reply": async (payload) => {
      if (!isNonEmptyString(payload.requestId) || !Array.isArray(payload.answers)) throw new Error("invalid payload");
      return { ok: await need().questions.reply(payload.requestId, payload.answers, `ipc-${Date.now()}`) };
    },
    "agents.definitions": async () => ({ definitions: await need().agentDefinitions() }),
    "agents.instances": async (payload) => {
      if (!isNonEmptyString(payload.sessionId)) throw new Error("invalid payload");
      return { instances: await need().agentInstances(payload.sessionId) };
    },
    "agents.cancel": async (payload) => {
      if (!isNonEmptyString(payload.instanceId)) throw new Error("invalid payload");
      try {
        await need().cancelAgent(payload.instanceId);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    "agents.limits": async () => ({ limits: need().agentLimits() }),
    "agents.setLimits": async (payload) => {
      if (typeof payload.limits !== "object" || payload.limits === null) throw new Error("invalid payload");
      try {
        need().setAgentLimits(payload.limits);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    "agents.setDefinitionModel": async (payload) => {
      if (!isNonEmptyString(payload.definitionId) || typeof payload.model !== "object" || payload.model === null) throw new Error("invalid payload");
      try {
        await need().setDefinitionModel(payload.definitionId, payload.model);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    "plans.list": async (payload) => {
      if (!isNonEmptyString(payload.sessionId)) throw new Error("invalid payload");
      return { plans: await need().listPlans(payload.sessionId) };
    },
    "plans.get": async (payload) => {
      if (!isNonEmptyString(payload.planId)) throw new Error("invalid payload");
      return need().getPlan(payload.planId);
    },
    "plans.approve": async (payload) => {
      if (!isNonEmptyString(payload.planId) || !isNonEmptyString(payload.revisionId)) throw new Error("invalid payload");
      try {
        await need().approvePlanRevision(payload.planId, payload.revisionId);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    "plans.reject": async (payload) => {
      if (!isNonEmptyString(payload.planId) || !isNonEmptyString(payload.revisionId)) throw new Error("invalid payload");
      try {
        await need().rejectPlanRevision(payload.planId, payload.revisionId);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    "plans.archive": async (payload) => {
      if (!isNonEmptyString(payload.planId)) throw new Error("invalid payload");
      try {
        await need().archivePlan(payload.planId);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    "plans.export": async (payload) => {
      if (!isNonEmptyString(payload.planId) || !isNonEmptyString(payload.revisionId) || typeof payload.path !== "string") throw new Error("invalid payload");
      try {
        await need().exportPlanRevision(payload.planId, payload.revisionId, payload.path);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    "plans.implement": async (payload) => {
      if (!isNonEmptyString(payload.sessionId) || !isNonEmptyString(payload.planId) || !isNonEmptyString(payload.revisionId)) throw new Error("invalid payload");
      return need().implementPlanRevision(payload.sessionId, payload.planId, payload.revisionId);
    },
    "approvals.pending": async (payload) => {
      if (!isNonEmptyString(payload.sessionId)) throw new Error("invalid payload");
      return { requests: await need().pendingApprovals(payload.sessionId) };
    },
    "approvals.decide": async (payload) => {
      if (!isNonEmptyString(payload.requestId) || (payload.decision !== "approved" && payload.decision !== "rejected")) throw new Error("invalid payload");
      try {
        await need().decideApproval(payload.requestId, payload.decision);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    "projects.isolatedDirs": async (payload) => {
      if (!isNonEmptyString(payload.projectId)) throw new Error("invalid payload");
      return { directories: await need().isolatedDirectories(payload.projectId) };
    },
    "projects.addIsolatedDir": async (payload) => {
      if (!isNonEmptyString(payload.projectId) || !isNonEmptyString(payload.path) || (payload.kind !== "directory" && payload.kind !== "worktree")) {
        throw new Error("invalid payload");
      }
      try {
        await need().registerIsolatedDirectory(payload.projectId, payload.path, payload.kind);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    "projects.removeIsolatedDir": async (payload) => {
      if (!isNonEmptyString(payload.id)) throw new Error("invalid payload");
      try {
        await need().removeIsolatedDirectory(payload.id);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    "projects.testAllowlist": async (payload) => {
      if (!isNonEmptyString(payload.projectId)) throw new Error("invalid payload");
      return { entries: await need().testAllowlist(payload.projectId) };
    },
    "projects.saveTestAllowlist": async (payload) => {
      if (!isNonEmptyString(payload.projectId) || !Array.isArray(payload.entries)) throw new Error("invalid payload");
      try {
        await need().saveTestAllowlist(payload.projectId, payload.entries);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    "projects.trustedInstructions": async (payload) => {
      if (!isNonEmptyString(payload.projectId)) throw new Error("invalid payload");
      return { files: await need().trustedInstructions(payload.projectId) };
    },
    "projects.saveTrustedInstructions": async (payload) => {
      if (!isNonEmptyString(payload.projectId) || !Array.isArray(payload.files)) throw new Error("invalid payload");
      try {
        await need().saveTrustedInstructions(payload.projectId, payload.files);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    "tasks.list": async (payload) => {
      if (payload.sessionId !== undefined && !isNonEmptyString(payload.sessionId)) throw new Error("invalid payload");
      if (payload.runId !== undefined && !isNonEmptyString(payload.runId)) throw new Error("invalid payload");
      if (!payload.sessionId && !payload.runId) throw new Error("invalid payload");
      return { tasks: await need().listTasks({ sessionId: payload.sessionId, runId: payload.runId }) };
    },
    "tasks.get": async (payload) => {
      if (!isNonEmptyString(payload.taskId)) throw new Error("invalid payload");
      return need().getTask(payload.taskId);
    },
    "tasks.cancel": async (payload) => {
      if (!isNonEmptyString(payload.taskId)) throw new Error("invalid payload");
      try {
        const { cancelled } = await need().cancelTask(payload.taskId);
        return { ok: true, cancelled };
      } catch (error) {
        return { ok: false, cancelled: [], error: error instanceof Error ? error.message : String(error) };
      }
    },
    "tasks.retry": async (payload) => {
      if (!isNonEmptyString(payload.taskId)) throw new Error("invalid payload");
      try {
        const { attempt, instanceId } = await need().retryTask(payload.taskId);
        return { ok: true, attempt, instanceId };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    "tasks.review": async (payload) => {
      if (!isNonEmptyString(payload.reviewerTaskId) || !isNonEmptyString(payload.targetTaskId)) throw new Error("invalid payload");
      if (payload.verdict !== "accept" && payload.verdict !== "request-changes") throw new Error("invalid payload");
      try {
        await need().recordTaskReview(payload.reviewerTaskId, payload.targetTaskId, payload.verdict, payload.detail);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    "tasks.scheduler": async (payload) => {
      if (!isNonEmptyString(payload.sessionId)) throw new Error("invalid payload");
      return need().schedulerStatus(payload.sessionId);
    },
    "worktrees.list": async (payload) => {
      if (!isNonEmptyString(payload.projectId)) throw new Error("invalid payload");
      return { worktrees: await need().listProjectWorktrees(payload.projectId) };
    },
    "worktrees.get": async (payload) => {
      if (!isNonEmptyString(payload.worktreeId)) throw new Error("invalid payload");
      try {
        const { worktree, operations } = await need().getWorktree(payload.worktreeId);
        return { ok: true, worktree, operations };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    "worktrees.cleanup": async (payload) => {
      if (!isNonEmptyString(payload.worktreeId)) throw new Error("invalid payload");
      try {
        await need().cleanupWorktree(payload.worktreeId, { deleteBranch: payload.deleteBranch });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    "repos.inspect": async (payload) => {
      if (!isNonEmptyString(payload.projectId)) throw new Error("invalid payload");
      return { summary: await need().inspectRepository(payload.projectId) };
    },
    "repos.setWorktreesRoot": async (payload) => {
      if (!isNonEmptyString(payload.projectId) || typeof payload.path !== "string") throw new Error("invalid payload");
      try {
        await need().setWorktreesRoot(payload.projectId, payload.path);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    "integrations.create": async (payload) => {
      if (!isNonEmptyString(payload.projectId) || !isNonEmptyString(payload.runId)) throw new Error("invalid payload");
      try {
        return { integration: await need().createIntegration({ projectId: payload.projectId, runId: payload.runId, targetBranch: payload.targetBranch }) };
      } catch (error) {
        return { integration: undefined as never, error: error instanceof Error ? error.message : String(error) };
      }
    },
    "integrations.get": async (payload) => {
      if (!isNonEmptyString(payload.integrationId)) throw new Error("invalid payload");
      try {
        return { ...(await need().getIntegration(payload.integrationId)), error: undefined };
      } catch (error) {
        return { integration: undefined as never, commits: [], operations: [], error: error instanceof Error ? error.message : String(error) };
      }
    },
    "integrations.list": async (payload) => {
      if (!isNonEmptyString(payload.runId)) throw new Error("invalid payload");
      return { integrations: await need().listRunIntegrations(payload.runId) };
    },
    "integrations.rebuild": async (payload) => {
      if (!isNonEmptyString(payload.integrationId)) throw new Error("invalid payload");
      try {
        const { id, attempt } = await need().rebuildIntegration(payload.integrationId);
        return { ok: true, id, attempt };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    "integrations.abort": async (payload) => {
      if (!isNonEmptyString(payload.integrationId)) throw new Error("invalid payload");
      try {
        await need().abortIntegration(payload.integrationId, payload.reason);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    "integrations.incorporate": async (payload) => {
      if (!isNonEmptyString(payload.integrationId)) throw new Error("invalid payload");
      try {
        const { incorporated } = await need().incorporateIntegration(payload.integrationId);
        return { ok: true, incorporated };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    "integrations.spawnReviewer": async (payload) => {
      if (!isNonEmptyString(payload.integrationId)) throw new Error("invalid payload");
      try {
        const { instanceId } = await need().spawnIntegrationReview(payload.integrationId, payload.brief);
        return { ok: true, instanceId };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    "integrations.review": async (payload) => {
      if (!isNonEmptyString(payload.integrationId) || !isNonEmptyString(payload.instanceId)) throw new Error("invalid payload");
      if (payload.verdict !== "accept" && payload.verdict !== "request-changes") throw new Error("invalid payload");
      try {
        await need().recordIntegrationReview(payload.integrationId, { instanceId: payload.instanceId, verdict: payload.verdict, summary: payload.summary });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    "conflicts.list": async (payload) => {
      return { conflicts: await need().listIntegrationConflicts({ scope: payload.scope, scopeRef: payload.scopeRef, status: payload.status }) };
    },
    "conflicts.get": async (payload) => {
      if (!isNonEmptyString(payload.conflictId)) throw new Error("invalid payload");
      try {
        return { ...(await need().getConflict(payload.conflictId)), error: undefined };
      } catch (error) {
        return { conflict: undefined as never, resolutions: [], error: error instanceof Error ? error.message : String(error) };
      }
    },
    "conflicts.requestResolution": async (payload) => {
      if (!isNonEmptyString(payload.conflictId)) throw new Error("invalid payload");
      try {
        const out = await need().requestConflictResolution(payload.conflictId, { briefSuffix: payload.briefSuffix });
        return { ok: true, ...out };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    "conflicts.finalize": async (payload) => {
      if (!isNonEmptyString(payload.conflictId) || !isNonEmptyString(payload.instanceId)) throw new Error("invalid payload");
      try {
        const { resolutionSha } = await need().finalizeConflictResolution(payload.conflictId, payload.instanceId);
        return { ok: true, resolutionSha };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    "conflicts.incorporate": async (payload) => {
      if (!isNonEmptyString(payload.integrationId) || !isNonEmptyString(payload.conflictId)) throw new Error("invalid payload");
      try {
        const out = await need().incorporateConflictResolution(payload.integrationId, payload.conflictId);
        return { ok: true, ...out };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    "conflicts.abort": async (payload) => {
      if (!isNonEmptyString(payload.conflictId)) throw new Error("invalid payload");
      try {
        await need().abortConflict(payload.conflictId, payload.reason);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    "conflicts.cleanup": async (payload) => {
      if (!isNonEmptyString(payload.conflictId)) throw new Error("invalid payload");
      try {
        const { removed } = await need().cleanupConflictResolution(payload.conflictId);
        return { ok: true, removed };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    "validations.list": async (payload) => {
      if (!isNonEmptyString(payload.integrationId)) throw new Error("invalid payload");
      return need().listValidations(payload.integrationId, payload.sha);
    },
    "validations.rerun": async (payload) => {
      if (!isNonEmptyString(payload.integrationId)) throw new Error("invalid payload");
      try {
        const { validations } = await need().rerunValidations(payload.integrationId, payload.sha);
        return { ok: true, validations };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    "previews.create": async (payload) => {
      if (!isNonEmptyString(payload.integrationId)) throw new Error("invalid payload");
      try {
        const preview = await need().createPreview(payload.integrationId);
        return { ok: true, preview };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    "previews.list": async (payload) => {
      if (!isNonEmptyString(payload.integrationId)) throw new Error("invalid payload");
      return { previews: await need().listPreviews(payload.integrationId) };
    },
    "previews.start": async (payload) => {
      if (!isNonEmptyString(payload.previewId)) throw new Error("invalid payload");
      try {
        const out = await need().startPreview(payload.previewId, { startEntryId: payload.startEntryId });
        return { ok: true, ...out };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    "previews.stop": async (payload) => {
      if (!isNonEmptyString(payload.previewId)) throw new Error("invalid payload");
      try {
        const { stopped } = await need().stopPreview(payload.previewId);
        return { ok: true, stopped };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    "previews.restart": async (payload) => {
      if (!isNonEmptyString(payload.previewId)) throw new Error("invalid payload");
      try {
        const out = await need().restartPreview(payload.previewId, { startEntryId: payload.startEntryId });
        return { ok: true, ...out };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    "previews.inspect": async (payload) => {
      if (!isNonEmptyString(payload.previewId)) throw new Error("invalid payload");
      try {
        return { ...(await need().inspectPreview(payload.previewId)), error: undefined };
      } catch (error) {
        return { preview: undefined as never, shaMatchesHead: false, reachable: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    "previews.logs": async (payload) => {
      if (!isNonEmptyString(payload.previewId)) throw new Error("invalid payload");
      return need().getPreviewLogs(payload.previewId, payload.tailChars);
    },
    "previews.cleanup": async (payload) => {
      if (!isNonEmptyString(payload.previewId)) throw new Error("invalid payload");
      try {
        const { removed } = await need().cleanupPreview(payload.previewId);
        return { ok: true, removed };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    "previews.allowlist": async (payload) => {
      if (!isNonEmptyString(payload.projectId)) throw new Error("invalid payload");
      return { entries: await need().previewAllowlist(payload.projectId) };
    },
    "previews.saveAllowlist": async (payload) => {
      if (!isNonEmptyString(payload.projectId) || !Array.isArray(payload.entries)) throw new Error("invalid payload");
      try {
        const entries = await need().savePreviewAllowlist(payload.projectId, payload.entries);
        return { ok: true, entries };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    "approvals.approve": async (payload) => {
      if (!isNonEmptyString(payload.integrationId)) throw new Error("invalid payload");
      try {
        const out = await need().approveIntegration(payload.integrationId, { previewId: payload.previewId, waiverReason: payload.waiverReason });
        return { ok: true, ...out };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    "approvals.reject": async (payload) => {
      if (!isNonEmptyString(payload.integrationId)) throw new Error("invalid payload");
      try {
        const { approvalId } = await need().rejectIntegration(payload.integrationId, payload.reason);
        return { ok: true, approvalId };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    "approvals.status": async (payload) => {
      if (!isNonEmptyString(payload.integrationId)) throw new Error("invalid payload");
      try {
        const out = await need().approvalStatus(payload.integrationId);
        return { ok: true, reasons: out.reasons, approval: out.approval };
      } catch (error) {
        return { ok: false, reasons: [], error: error instanceof Error ? error.message : String(error) };
      }
    },
    "promotions.promote": async (payload) => {
      if (!isNonEmptyString(payload.integrationId)) throw new Error("invalid payload");
      try {
        const out = await need().promoteIntegration(payload.integrationId);
        return { ok: true, ...out };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    "promotions.status": async (payload) => {
      if (!isNonEmptyString(payload.integrationId)) throw new Error("invalid payload");
      return { promotions: await need().listPromotions(payload.integrationId) };
    },
  };
}

function registerIpc(): void {
  const table = handlers();
  for (const channel of CHANNELS) {
    ipcMain.handle(`octus:${channel}`, async (event, payload: unknown) => {
      assertSender(event);
      const handler = table[channel] as (request: unknown) => Promise<unknown>;
      return handler(payload ?? {});
    });
  }
}

async function createCore(): Promise<OctusCore> {
  const dir = dataDir();
  const secrets = new ElectronSecretStore(dir);
  const instance = await OctusCore.create({
    dataDir: dir,
    primarySecrets: secrets,
    workerUrl: resolveWorkerPath(),
    definitionsDir: resolveDefinitionsDir(),
    onEvent: onCoreEvent,
  });
  return instance;
}

function preloadPath(): string {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "preload");
  for (const name of ["index.cjs", "index.mjs", "index.js"]) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return path.join(dir, "index.cjs");
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: preloadPath(),
    },
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "renderer", "index.html"));
  }
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
}

// ---------------------------------------------------------------------------
// Modo smoke: probes dentro del proceso Electron real (sin ventana).
// ---------------------------------------------------------------------------
async function runSmoke(): Promise<number> {
  console.log(`[smoke] electron=${process.versions.electron} node=${process.versions.node}`);
  try {
    const sqlite = (await import("node:sqlite")) as typeof import("node:sqlite");
    const probe = new sqlite.DatabaseSync(":memory:");
    probe.exec("CREATE TABLE t(v TEXT); INSERT INTO t(v) VALUES('smoke-ok');");
    const row = probe.prepare("SELECT v FROM t").get() as { v: string };
    probe.close();
    console.log(`[smoke] node:sqlite in main process: ${row.v}`);
  } catch (error) {
    console.error(`[smoke] node:sqlite FAILED: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  try {
    const { safeStorage } = await import("electron");
    const available = await safeStorage.isAsyncEncryptionAvailable();
    console.log(`[smoke] safeStorage async available: ${available}`);
    if (!available) {
      console.error("[smoke] safeStorage unavailable");
      return 1;
    }
    const encrypted = await safeStorage.encryptStringAsync("octus-smoke-secret");
    const { result } = await safeStorage.decryptStringAsync(encrypted);
    if (result !== "octus-smoke-secret") {
      console.error("[smoke] safeStorage roundtrip mismatch");
      return 1;
    }
    console.log("[smoke] safeStorage roundtrip ok");
  } catch (error) {
    console.error(`[smoke] safeStorage FAILED: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  try {
    const { PersistenceService } = await import("@octus/core");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(path.join(tmpdir(), "octus-smoke-"));
    const db = await PersistenceService.open({ dbPath: path.join(dir, "smoke.db"), workerUrl: resolveWorkerPath() });
    await db.exec("INSERT INTO kv (key, value, updated_at) VALUES ('k', 'v', 1)");
    const row = await db.queryOne<{ value: string }>("SELECT value FROM kv WHERE key = 'k'");
    await db.close();
    if (row?.value !== "v") throw new Error("worker roundtrip mismatch");
    console.log("[smoke] persistence worker roundtrip ok");
  } catch (error) {
    console.error(`[smoke] persistence worker FAILED: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  try {
    const { OctusCore } = await import("@octus/core");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(path.join(tmpdir(), "octus-smoke-core-"));
    const core = await OctusCore.create({
      dataDir: dir,
      primarySecrets: new ElectronSecretStore(dir),
      workerUrl: resolveWorkerPath(),
    });
    try {
      const project = await core.createProject("smoke", dir);
      const session = await core.createSession({ projectId: project.id });
      // Sin presupuestos: la puerta debe bloquear con error claro (sin llamar al proveedor).
      const gated = await core.prompt(session.id, "smoke prompt");
      await core.waitForIdle(session.id);
      const gatedRun = (await core.getRun(gated.runId)).run;
      if (gatedRun.status !== "failed" || !/not configured/i.test(gatedRun.error ?? "")) {
        throw new Error(`budget gate did not block as expected: ${gatedRun.status} ${gatedRun.error ?? ""}`);
      }
      console.log("[smoke] budget gate blocks unconfigured paid calls ok");
      await core.configureBudgets([
        { scope: { kind: "global", ref: "" }, limitMicroUsd: 50_000, warnRatio: 0.8, action: "block", window: "span", enabled: true },
      ]);
      // Con presupuestos pero sin claves: fallo de auth limpio, conversación intacta.
      const unauth = await core.prompt(session.id, "smoke prompt 2");
      await core.waitForIdle(session.id);
      const unauthRun = (await core.getRun(unauth.runId)).run;
      if (unauthRun.status !== "failed" || !/API key|auth/i.test(unauthRun.error ?? "")) {
        throw new Error(`expected clean auth failure, got: ${unauthRun.status} ${unauthRun.error ?? ""}`);
      }
      const messages = await core.sessionMessages(session.id);
      if (!messages.some((m) => m.role === "user")) throw new Error("user history lost after provider failure");
      console.log("[smoke] core boot + gate + clean auth failure ok");
    } finally {
      await core.close();
    }
  } catch (error) {
    console.error(`[smoke] core-in-electron FAILED: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  console.log("[smoke] ALL OK");
  return 0;
}

async function main(): Promise<void> {
  if (process.argv.includes("--octus-acceptance-2")) {
    await app.whenReady();
    const { runAcceptancePhase2 } = await import("./acceptance.js");
    const code = await runAcceptancePhase2();
    app.exit(code);
    return;
  }
  if (process.argv.includes("--octus-acceptance")) {
    await app.whenReady();
    const { runAcceptance } = await import("./acceptance.js");
    const code = await runAcceptance();
    app.exit(code);
    return;
  }
  if (process.argv.includes("--octus-acceptance-3")) {
    await app.whenReady();
    const { runAcceptancePhase3 } = await import("./acceptance.js");
    const code = await runAcceptancePhase3();
    app.exit(code);
    return;
  }
  if (process.argv.includes("--octus-smoke")) {
    await app.whenReady();
    const code = await runSmoke();
    app.exit(code);
    return;
  }
  const autoquit = process.argv.find((arg) => arg.startsWith("--octus-autoquit="));
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }
  await app.whenReady();
  core = await createCore();
  registerIpc();
  createWindow();
  if (autoquit) {
    // Verificación de arranque GUI: cierra solo tras pintar, salvo fallo de carga.
    const ms = Number.parseInt(autoquit.split("=")[1] ?? "8000", 10) || 8000;
    let failed = false;
    mainWindow?.webContents.on("did-fail-load", (_event, code, description) => {
      console.error(`[autoquit] did-fail-load ${code}: ${description}`);
      failed = true;
    });
    mainWindow?.webContents.on("console-message", (details) => {
      const message = (details as unknown as { message?: string }).message ?? "";
      if (/uncaught|failed|error/i.test(message)) {
        console.error(`[autoquit] renderer console: ${message}`);
        failed = true;
      }
    });
    setTimeout(() => {
      console.log(`[autoquit] quitting with code ${failed ? 1 : 0}`);
      app.exit(failed ? 1 : 0);
    }, ms);
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") void app.quit();
  });
  app.on("before-quit", () => {
    void core?.close();
  });
}

void main();

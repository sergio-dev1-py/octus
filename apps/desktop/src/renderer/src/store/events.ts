/** Renderer/store — aplicación de eventos del core al estado. */
import { reconcile } from "solid-js/store";
import type { CoreEvent, Message } from "@octus/shared";
import {
  appendMessage,
  applyPartDelta,
  applyPartDone,
  applyStepRetry,
  cancelReasonOf,
  purgeRunFrames,
} from "../timeline.js";
import { refreshSessions, refreshMessages, refreshBudgets, refreshPending, refreshUsage } from "./projects.js";
import { refreshPlans, refreshApprovals, refreshAgents } from "./plans.js";
import { refreshTasks } from "./tasks.js";
import { refreshWorktrees } from "./worktrees.js";
import { refreshIntegrations } from "./integrations.js";
import { refreshMemory } from "./memory.js";
import { state, setState } from "./state.js";

export function applyEvent(event: CoreEvent): void {
  // N-C-12a/12b: la lógica pura vive en timeline.ts (testeada en bun).
  if (event.kind === "part.delta") {
    setState("live", applyPartDelta(state.live, event));
    return;
  }
  if (event.kind === "part.done") {
    setState("live", applyPartDone(state.live, event));
    return;
  }
  if (event.kind === "step.retry") {
    setState("live", applyStepRetry(state.live, event));
    return;
  }
  const persisted = event.event;
  switch (persisted.type) {
    case "message.appended": {
      const message = persisted.payload.message as Message;
      if (message.sessionId === state.activeSessionId) {
        setState("messages", (messages) => appendMessage(messages, message));
        if (message.role === "assistant") {
          const live = { ...state.live };
          delete live[message.id];
          setState("live", reconcile(live));
        }
      }
      break;
    }
    case "run.completed":
    case "run.failed":
    case "run.cancelled": {
      // N-C-12c + cancel_resume: los marcos de este run desaparecen (sin
      // fantasma ni duplicado) y la cancelación muestra su motivo.
      const runId = event.event.aggregate.id;
      setState("live", reconcile(purgeRunFrames(state.live, runId)));
      setState("busy", false);
      if (persisted.type === "run.cancelled") {
        setState("cancelReason", cancelReasonOf(event.event.payload));
      } else {
        setState("cancelReason", undefined);
      }
      void refreshMessages();
      void refreshUsage();
      void refreshBudgets();
      void refreshPlans();
      void refreshApprovals();
      void refreshAgents();
      void refreshTasks();
      void refreshIntegrations();
      break;
    }
    case "run.created":
    case "run.started":
      setState("busy", true);
      break;
    case "run.status_changed":
      setState("busy", true);
      void refreshUsage();
      void refreshIntegrations();
      break;
    case "task.created":
    case "task.status_changed":
    case "task.progress":
    case "task_attempt.created":
    case "task_attempt.status_changed":
    case "planning.created":
    case "planning.rejected":
    case "review.recorded":
    case "scheduler.assigned":
      void refreshTasks();
      void refreshAgents();
      break;
    case "session.created":
    case "session.updated":
      void refreshSessions();
      break;
    case "permission.asked":
    case "permission.replied":
      void refreshPending();
      break;
    case "question.asked":
    case "question.replied":
      void refreshPending();
      break;
    case "budget.warning":
    case "budget.exceeded":
    case "budgets.configured":
      void refreshBudgets();
      break;
    case "provider.usage_recorded":
      void refreshUsage();
      void refreshBudgets();
      break;
    case "plan.created":
    case "plan.revision_created":
    case "plan.revision_presented":
    case "plan.revision_orphaned":
    case "plan.approved":
    case "plan.rejected":
    case "plan.archived":
    case "plan.exported":
    case "plan.approval_requested":
    case "plan.approval_decided":
      void refreshPlans();
      void refreshApprovals();
      break;
    case "agent_instance.created":
    case "agent_instance.started":
    case "agent_instance.status_changed":
    case "agent_instance.completed":
    case "agent_instance.failed":
    case "agent_instance.cancelled":
    case "agent.delivery_ready":
      void refreshAgents();
      break;
    case "worktree.created":
    case "worktree.released":
    case "worktree.status_changed":
    case "worktree.removed":
      void refreshWorktrees();
      void refreshAgents();
      break;
    case "workbase.created":
    case "workbase.status_changed":
    case "integration.created":
    case "integration.conflict_opened":
    case "integration.conflict_resolved":
    case "integration.validated":
    case "integration.reviewed":
    case "integration.status_changed":
    case "integration.completed":
    case "preview.created":
    case "preview.ready":
    case "preview.started":
    case "preview.stopped":
    case "approval.granted":
    case "approval.rejected":
    case "approval.invalidated":
    case "promotion.started":
    case "promotion.failed":
    case "promotion.completed":
    case "resolution.requested":
    case "resolution.completed":
      void refreshIntegrations();
      break;
    case "memory.recorded":
    case "memory.status_changed":
      void refreshMemory();
      break;
    default:
      break;
  }
}

/** @octus/core — migraciones versionadas. 0001: solo tablas del núcleo (Etapa 1). */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATION_0001 = `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE agent_definitions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  profile TEXT,
  default_model TEXT NOT NULL,
  max_steps INTEGER NOT NULL,
  timeout_ms INTEGER NOT NULL,
  idle_timeout_ms INTEGER NOT NULL,
  system_prompt TEXT NOT NULL,
  tools TEXT NOT NULL,
  prompt_version INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  directory TEXT NOT NULL,
  profile TEXT NOT NULL,
  model TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_project ON sessions(project_id);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX idx_runs_session ON runs(session_id, created_at);

CREATE TABLE agent_instances (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  definition_id TEXT NOT NULL REFERENCES agent_definitions(id),
  parent_instance_id TEXT REFERENCES agent_instances(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  model TEXT NOT NULL,
  directory TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX idx_instances_run ON agent_instances(run_id);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL REFERENCES agent_instances(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  parts TEXT NOT NULL,
  provider_state TEXT,
  trust TEXT NOT NULL,
  seq INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (instance_id, seq)
);
CREATE INDEX idx_messages_instance ON messages(instance_id, seq);

CREATE TABLE tool_invocations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL REFERENCES agent_instances(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_call_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  permission TEXT NOT NULL,
  result_text TEXT,
  artifact_id TEXT,
  error TEXT,
  started_at INTEGER,
  completed_at INTEGER
);
CREATE INDEX idx_tools_instance ON tool_invocations(instance_id);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  aggregate_kind TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  occurred_at INTEGER NOT NULL,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  UNIQUE (aggregate_kind, aggregate_id, seq)
);
CREATE INDEX idx_events_aggregate ON events(aggregate_kind, aggregate_id, seq);
CREATE INDEX idx_events_type ON events(type, occurred_at);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  instance_id TEXT REFERENCES agent_instances(id) ON DELETE CASCADE,
  tool_call_id TEXT,
  kind TEXT NOT NULL,
  mime TEXT NOT NULL,
  text TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE provider_configs (
  provider_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  /** Referencia opaca al secreto en el almacén del SO. Nunca la clave. */
  secret_ref TEXT,
  settings TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);

CREATE TABLE permission_rules (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  effect TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_perm_project ON permission_rules(project_id);

CREATE TABLE usage_records (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  agent_definition_id TEXT NOT NULL,
  agent_instance_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  reasoning_tokens INTEGER NOT NULL,
  cached_tokens INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  price_input_per_m REAL,
  price_output_per_m REAL,
  price_cache_read_per_m REAL,
  pricing_source TEXT,
  pricing_date TEXT,
  cost_micro_usd INTEGER,
  pricing_missing INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_usage_session ON usage_records(session_id, created_at);
CREATE INDEX idx_usage_run ON usage_records(run_id);
CREATE INDEX idx_usage_scope ON usage_records(provider_id, model_id, agent_definition_id, created_at);

CREATE TABLE budgets (
  id TEXT PRIMARY KEY,
  scope_kind TEXT NOT NULL,
  scope_ref TEXT NOT NULL DEFAULT '',
  limit_micro_usd INTEGER,
  limit_tokens INTEGER,
  warn_ratio REAL NOT NULL DEFAULT 0.8,
  action TEXT NOT NULL DEFAULT 'warn',
  window TEXT NOT NULL DEFAULT 'span',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

const MIGRATION_0002 = `
ALTER TABLE agent_definitions ADD COLUMN denied_tools TEXT NOT NULL DEFAULT '[]';
ALTER TABLE agent_definitions ADD COLUMN permission_rules TEXT NOT NULL DEFAULT '[]';
ALTER TABLE agent_definitions ADD COLUMN delivery_format TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_definitions ADD COLUMN can_delegate_to TEXT NOT NULL DEFAULT '[]';

ALTER TABLE messages ADD COLUMN mode TEXT;

ALTER TABLE runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'build';
ALTER TABLE runs ADD COLUMN plan_revision_id TEXT;

ALTER TABLE agent_instances ADD COLUMN definition_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agent_instances ADD COLUMN prompt_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_instances ADD COLUMN definition_snapshot TEXT NOT NULL DEFAULT '{}';
ALTER TABLE agent_instances ADD COLUMN assigned_directory_id TEXT;
ALTER TABLE agent_instances ADD COLUMN instance_rules TEXT NOT NULL DEFAULT '[]';

CREATE TABLE isolated_directories (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  real_path TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'directory',
  repo_root TEXT,
  branch TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (project_id, real_path)
);
CREATE INDEX idx_isolated_project ON isolated_directories(project_id);

CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  objective TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  current_revision_id TEXT,
  approved_revision_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_plans_session ON plans(session_id, updated_at);

CREATE TABLE plan_revisions (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  structured_content TEXT NOT NULL,
  content_markdown TEXT NOT NULL,
  source_message_id TEXT,
  created_in_run_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  lifecycle TEXT NOT NULL DEFAULT 'unpresented',
  presented_at INTEGER,
  approval TEXT NOT NULL DEFAULT 'pending',
  approved_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (plan_id, version)
);
CREATE INDEX idx_revisions_plan ON plan_revisions(plan_id, version);

CREATE TABLE approval_requests (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL REFERENCES plan_revisions(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  decision TEXT,
  decided_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_approvals_session ON approval_requests(session_id, status);
`;

const MIGRATION_0003 = `
ALTER TABLE agent_instances ADD COLUMN task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL;

CREATE TABLE plannings (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL REFERENCES plan_revisions(id) ON DELETE CASCADE,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'valid',
  reason TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (run_id, plan_id, revision_id, request_hash)
);
CREATE INDEX idx_plannings_run ON plannings(run_id);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  planning_id TEXT NOT NULL REFERENCES plannings(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL REFERENCES plan_revisions(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  agent_role TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  acceptance_criteria TEXT NOT NULL DEFAULT '[]',
  required_tools TEXT NOT NULL DEFAULT '[]',
  write_scope TEXT NOT NULL DEFAULT '[]',
  validation_commands TEXT NOT NULL DEFAULT '[]',
  review_target_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  needs_review INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',
  blocked_reason TEXT,
  blocked_details TEXT,
  reviewed_by_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  reviewed_at INTEGER,
  attempt INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_tasks_run_status ON tasks(run_id, status);
CREATE INDEX idx_tasks_planning ON tasks(planning_id);

CREATE TABLE task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'requires',
  PRIMARY KEY (task_id, depends_on)
);
CREATE INDEX idx_taskdeps_depends ON task_dependencies(depends_on);

CREATE TABLE task_attempts (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  instance_id TEXT REFERENCES agent_instances(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error_code TEXT,
  error_message TEXT,
  error_details TEXT,
  artifacts TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, attempt)
);
CREATE UNIQUE INDEX uq_task_active_attempt ON task_attempts(task_id) WHERE status IN ('pending', 'running');
CREATE INDEX idx_attempts_instance ON task_attempts(instance_id);

CREATE TABLE task_review_verdicts (
  reviewer_task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  target_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  verdict TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_verdicts_target ON task_review_verdicts(target_task_id);

CREATE TABLE scheduler_reservations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL DEFAULT 0,
  instance_id TEXT,
  acquired_at INTEGER NOT NULL
);
CREATE INDEX idx_reserv_kind ON scheduler_reservations(kind, resource_key);
CREATE INDEX idx_reserv_task ON scheduler_reservations(task_id);
CREATE UNIQUE INDEX uq_scope_write_exact ON scheduler_reservations(resource_key) WHERE kind = 'scope-write';

CREATE TABLE scheduler_fairness (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  last_run_id TEXT,
  updated_at INTEGER NOT NULL
);

-- Integridad de dependencias: INSERT y UPDATE por separado (SQLite no admite OR).
CREATE TRIGGER trg_taskdep_ins BEFORE INSERT ON task_dependencies
BEGIN
  SELECT CASE
    WHEN NEW.kind <> 'requires' THEN RAISE(ABORT, 'task_dependencies.kind must be requires')
    WHEN NEW.task_id = NEW.depends_on THEN RAISE(ABORT, 'task cannot depend on itself')
    WHEN (SELECT run_id FROM tasks WHERE id = NEW.task_id) IS NOT (SELECT run_id FROM tasks WHERE id = NEW.depends_on) THEN RAISE(ABORT, 'task_dependencies must stay within the same run')
    WHEN (SELECT planning_id FROM tasks WHERE id = NEW.task_id) IS NOT (SELECT planning_id FROM tasks WHERE id = NEW.depends_on) THEN RAISE(ABORT, 'task_dependencies must stay within the same planning')
    WHEN (SELECT se.project_id FROM tasks t JOIN runs r ON r.id = t.run_id JOIN sessions se ON se.id = r.session_id WHERE t.id = NEW.task_id) IS NOT (SELECT se.project_id FROM tasks t JOIN runs r ON r.id = t.run_id JOIN sessions se ON se.id = r.session_id WHERE t.id = NEW.depends_on) THEN RAISE(ABORT, 'task_dependencies must stay within the same project')
  END;
END;
CREATE TRIGGER trg_taskdep_upd BEFORE UPDATE OF task_id, depends_on, kind ON task_dependencies
BEGIN
  SELECT CASE
    WHEN NEW.kind <> 'requires' THEN RAISE(ABORT, 'task_dependencies.kind must be requires')
    WHEN NEW.task_id = NEW.depends_on THEN RAISE(ABORT, 'task cannot depend on itself')
    WHEN (SELECT run_id FROM tasks WHERE id = NEW.task_id) IS NOT (SELECT run_id FROM tasks WHERE id = NEW.depends_on) THEN RAISE(ABORT, 'task_dependencies must stay within the same run')
    WHEN (SELECT planning_id FROM tasks WHERE id = NEW.task_id) IS NOT (SELECT planning_id FROM tasks WHERE id = NEW.depends_on) THEN RAISE(ABORT, 'task_dependencies must stay within the same planning')
    WHEN (SELECT se.project_id FROM tasks t JOIN runs r ON r.id = t.run_id JOIN sessions se ON se.id = r.session_id WHERE t.id = NEW.task_id) IS NOT (SELECT se.project_id FROM tasks t JOIN runs r ON r.id = t.run_id JOIN sessions se ON se.id = r.session_id WHERE t.id = NEW.depends_on) THEN RAISE(ABORT, 'task_dependencies must stay within the same project')
  END;
END;

-- Anclaje inmutable de tasks y plannings.
CREATE TRIGGER trg_tasks_anchor_upd BEFORE UPDATE OF run_id, planning_id ON tasks
BEGIN
  SELECT RAISE(ABORT, 'tasks.run_id/planning_id are immutable');
END;
CREATE TRIGGER trg_plannings_immutable_upd BEFORE UPDATE OF run_id, plan_id, revision_id, request_hash ON plannings
BEGIN
  SELECT RAISE(ABORT, 'plannings anchor is immutable');
END;

-- Vínculo review_target_task_id: solo reviewer tasks, mismo run/planning, inmutable.
CREATE TRIGGER trg_task_review_target_ins BEFORE INSERT ON tasks
BEGIN
  SELECT CASE
    WHEN NEW.review_target_task_id IS NOT NULL AND NEW.agent_role <> 'reviewer' THEN RAISE(ABORT, 'review_target_task_id is only for reviewer tasks')
    WHEN NEW.review_target_task_id IS NOT NULL AND (SELECT run_id FROM tasks WHERE id = NEW.review_target_task_id) IS NOT NEW.run_id THEN RAISE(ABORT, 'review target must be in the same run')
    WHEN NEW.review_target_task_id IS NOT NULL AND (SELECT planning_id FROM tasks WHERE id = NEW.review_target_task_id) IS NOT NEW.planning_id THEN RAISE(ABORT, 'review target must be in the same planning')
  END;
END;
CREATE TRIGGER trg_task_review_target_upd BEFORE UPDATE OF review_target_task_id ON tasks
BEGIN
  SELECT CASE
    WHEN NEW.review_target_task_id IS NOT OLD.review_target_task_id THEN RAISE(ABORT, 'review_target_task_id is immutable')
  END;
END;

-- reviewed solo vía veredicto registrado; changes-requested solo vía veredicto.
CREATE TRIGGER trg_task_reviewed_ins BEFORE INSERT ON tasks
BEGIN
  SELECT CASE
    WHEN NEW.status = 'reviewed' AND (NEW.reviewed_by_task_id IS NULL OR (SELECT COUNT(*) FROM task_review_verdicts WHERE reviewer_task_id = NEW.reviewed_by_task_id AND target_task_id = NEW.id AND verdict = 'accept') = 0) THEN RAISE(ABORT, 'reviewed requires a recorded accept verdict')
  END;
END;
CREATE TRIGGER trg_task_reviewed_upd BEFORE UPDATE OF status ON tasks
BEGIN
  SELECT CASE
    WHEN NEW.status = 'reviewed' AND (NEW.reviewed_by_task_id IS NULL OR (SELECT COUNT(*) FROM task_review_verdicts WHERE reviewer_task_id = NEW.reviewed_by_task_id AND target_task_id = NEW.id AND verdict = 'accept') = 0) THEN RAISE(ABORT, 'reviewed requires a recorded accept verdict')
  END;
END;
`;

const MIGRATION_0004 = `
ALTER TABLE agent_instances ADD COLUMN worktree_id TEXT REFERENCES worktrees(id) ON DELETE SET NULL;

CREATE TABLE repositories (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  root_path TEXT NOT NULL,
  worktrees_root TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_repositories_project ON repositories(project_id);

CREATE TABLE worktrees (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  run_id TEXT,
  task_id TEXT UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  branch_name TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  base_source TEXT NOT NULL DEFAULT 'head',
  produced_commit TEXT,
  canonical_path TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'provisioning',
  attempt INTEGER NOT NULL DEFAULT 0,
  instance_id TEXT REFERENCES agent_instances(id) ON DELETE SET NULL,
  dirty_excluded INTEGER NOT NULL DEFAULT 0,
  dirty_summary TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (repository_id, branch_name)
);
CREATE INDEX idx_worktrees_project ON worktrees(project_id, status);
CREATE INDEX idx_worktrees_task ON worktrees(task_id);

CREATE TABLE managed_branches (
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  branch_name TEXT NOT NULL,
  worktree_id TEXT REFERENCES worktrees(id) ON DELETE SET NULL,
  base_commit TEXT NOT NULL,
  produced_commit TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repository_id, branch_name)
);
CREATE INDEX idx_branches_worktree ON managed_branches(worktree_id);

CREATE TABLE worktree_ops (
  id TEXT PRIMARY KEY,
  worktree_id TEXT REFERENCES worktrees(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  op TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'started',
  step TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_wops_worktree ON worktree_ops(worktree_id, created_at);
CREATE INDEX idx_wops_task ON worktree_ops(task_id, created_at);

-- Inmutabilidad de anclaje: INSERT y UPDATE por separado (estilo Etapa 3).
CREATE TRIGGER trg_worktrees_anchor_ins BEFORE INSERT ON worktrees
BEGIN
  SELECT CASE
    WHEN NEW.task_id IS NULL AND NEW.status <> 'orphaned' THEN RAISE(ABORT, 'worktrees.task_id is required (NULL only for reconciled orphans)')
    WHEN NEW.canonical_path IS NULL OR NEW.canonical_path = '' THEN RAISE(ABORT, 'worktrees.canonical_path is required')
    WHEN NEW.branch_name IS NULL OR NEW.branch_name = '' THEN RAISE(ABORT, 'worktrees.branch_name is required')
    WHEN NEW.base_commit IS NULL OR NEW.base_commit = '' THEN RAISE(ABORT, 'worktrees.base_commit is required')
  END;
END;
CREATE TRIGGER trg_worktrees_anchor_upd BEFORE UPDATE OF task_id, base_commit, canonical_path, branch_name ON worktrees
BEGIN
  SELECT CASE
    WHEN NEW.task_id IS NOT OLD.task_id THEN RAISE(ABORT, 'worktrees.task_id is immutable')
    WHEN NEW.base_commit IS NOT OLD.base_commit THEN RAISE(ABORT, 'worktrees.base_commit is immutable')
    WHEN NEW.canonical_path IS NOT OLD.canonical_path THEN RAISE(ABORT, 'worktrees.canonical_path is immutable')
    WHEN NEW.branch_name IS NOT OLD.branch_name THEN RAISE(ABORT, 'worktrees.branch_name is immutable')
  END;
END;
`;

const MIGRATION_0005 = `
CREATE TABLE integrations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  target_branch TEXT NOT NULL,
  target_base_commit TEXT NOT NULL,
  integration_branch TEXT NOT NULL,
  canonical_path TEXT NOT NULL UNIQUE,
  head TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  supersedes TEXT REFERENCES integrations(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'building',
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (repository_id, integration_branch)
);
CREATE INDEX idx_integrations_run ON integrations(run_id, attempt);
CREATE INDEX idx_integrations_project ON integrations(project_id, status);

CREATE TABLE integration_commits (
  id TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  instance_id TEXT REFERENCES agent_instances(id) ON DELETE SET NULL,
  worktree_id TEXT REFERENCES worktrees(id) ON DELETE SET NULL,
  original_sha TEXT NOT NULL,
  integrated_sha TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'original',
  created_at INTEGER NOT NULL,
  UNIQUE (integration_id, task_id, attempt)
);
CREATE INDEX idx_icommit_integration ON integration_commits(integration_id);

CREATE TABLE integration_ops (
  id TEXT PRIMARY KEY,
  integration_id TEXT REFERENCES integrations(id) ON DELETE CASCADE,
  op TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'started',
  step TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_iops_integration ON integration_ops(integration_id, created_at);

CREATE TABLE work_bases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  predecessor_shas TEXT NOT NULL DEFAULT '[]',
  tip_sha TEXT NOT NULL DEFAULT '',
  branch_name TEXT NOT NULL,
  canonical_path TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'building',
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (repository_id, branch_name)
);
CREATE INDEX idx_workbases_task ON work_bases(task_id);

CREATE TABLE integration_conflicts (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  scope_ref TEXT NOT NULL,
  files TEXT NOT NULL DEFAULT '[]',
  ours_sha TEXT NOT NULL,
  theirs_sha TEXT NOT NULL,
  base_sha TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  resolution_sha TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_conflicts_scope ON integration_conflicts(scope, scope_ref, status);

CREATE TABLE conflict_resolutions (
  id TEXT PRIMARY KEY,
  conflict_id TEXT NOT NULL REFERENCES integration_conflicts(id) ON DELETE CASCADE,
  instance_id TEXT REFERENCES agent_instances(id) ON DELETE SET NULL,
  resolution_sha TEXT NOT NULL,
  reused INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_resolutions_conflict ON conflict_resolutions(conflict_id);

CREATE TABLE validations (
  id TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  sha TEXT NOT NULL,
  kind TEXT NOT NULL,
  entry_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  detail TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_validations_integration ON validations(integration_id, sha);

CREATE TABLE integration_reviews (
  id TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  sha TEXT NOT NULL,
  instance_id TEXT REFERENCES agent_instances(id) ON DELETE SET NULL,
  verdict TEXT NOT NULL,
  summary TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_ireviews_integration ON integration_reviews(integration_id, sha);

CREATE TABLE previews (
  id TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  sha TEXT NOT NULL,
  canonical_path TEXT NOT NULL UNIQUE,
  argv TEXT NOT NULL DEFAULT '[]',
  port INTEGER NOT NULL,
  url TEXT NOT NULL,
  pid INTEGER,
  status TEXT NOT NULL DEFAULT 'starting',
  log_path TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_previews_integration ON previews(integration_id);

CREATE TABLE integration_approvals (
  id TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  candidate_sha TEXT NOT NULL,
  preview_id TEXT REFERENCES previews(id) ON DELETE SET NULL,
  waiver_reason TEXT,
  target_branch TEXT NOT NULL,
  target_sha_observed TEXT NOT NULL,
  validations_hash TEXT NOT NULL,
  decision TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'user',
  granted_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (integration_id, candidate_sha)
);
CREATE INDEX idx_approvals_integration ON integration_approvals(integration_id);

CREATE TABLE promotions (
  id TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  approval_id TEXT NOT NULL REFERENCES integration_approvals(id) ON DELETE CASCADE,
  target_branch TEXT NOT NULL,
  expected_old_sha TEXT NOT NULL,
  new_sha TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'started',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_promotions_integration ON promotions(integration_id);

CREATE TABLE promotion_ops (
  id TEXT PRIMARY KEY,
  promotion_id TEXT NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  op TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'started',
  step TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_pops_promotion ON promotion_ops(promotion_id, created_at);

-- Anclaje de integración: INSERT y UPDATE por separado (estilo Etapas 3–4).
CREATE TRIGGER trg_integrations_anchor_ins BEFORE INSERT ON integrations
BEGIN
  SELECT CASE
    WHEN NEW.project_id IS NULL OR NEW.project_id = '' THEN RAISE(ABORT, 'integrations.project_id is required')
    WHEN NEW.repository_id IS NULL OR NEW.repository_id = '' THEN RAISE(ABORT, 'integrations.repository_id is required')
    WHEN NEW.run_id IS NULL OR NEW.run_id = '' THEN RAISE(ABORT, 'integrations.run_id is required')
    WHEN NEW.target_branch IS NULL OR NEW.target_branch = '' THEN RAISE(ABORT, 'integrations.target_branch is required')
    WHEN NEW.target_base_commit IS NULL OR NEW.target_base_commit = '' THEN RAISE(ABORT, 'integrations.target_base_commit is required')
    WHEN NEW.integration_branch IS NULL OR NEW.integration_branch = '' THEN RAISE(ABORT, 'integrations.integration_branch is required')
    WHEN NEW.canonical_path IS NULL OR NEW.canonical_path = '' THEN RAISE(ABORT, 'integrations.canonical_path is required')
  END;
END;
CREATE TRIGGER trg_integrations_anchor_upd BEFORE UPDATE OF project_id, repository_id, run_id, target_branch, target_base_commit, integration_branch, canonical_path ON integrations
BEGIN
  SELECT CASE
    WHEN NEW.project_id IS NOT OLD.project_id THEN RAISE(ABORT, 'integrations.project_id is immutable')
    WHEN NEW.repository_id IS NOT OLD.repository_id THEN RAISE(ABORT, 'integrations.repository_id is immutable')
    WHEN NEW.run_id IS NOT OLD.run_id THEN RAISE(ABORT, 'integrations.run_id is immutable')
    WHEN NEW.target_branch IS NOT OLD.target_branch THEN RAISE(ABORT, 'integrations.target_branch is immutable')
    WHEN NEW.target_base_commit IS NOT OLD.target_base_commit THEN RAISE(ABORT, 'integrations.target_base_commit is immutable')
    WHEN NEW.integration_branch IS NOT OLD.integration_branch THEN RAISE(ABORT, 'integrations.integration_branch is immutable')
    WHEN NEW.canonical_path IS NOT OLD.canonical_path THEN RAISE(ABORT, 'integrations.canonical_path is immutable')
  END;
END;

-- Aprobaciones: filas inmutables (re-decidir = rebuild con fila nueva).
CREATE TRIGGER trg_approvals_immutable_upd BEFORE UPDATE ON integration_approvals
BEGIN
  SELECT RAISE(ABORT, 'integration_approvals are immutable; rebuild for a new decision');
END;

-- Promociones: intento inmutable (reintentar = fila nueva).
CREATE TRIGGER trg_promotions_immutable_upd BEFORE UPDATE OF integration_id, approval_id, target_branch, expected_old_sha, new_sha ON promotions
BEGIN
  SELECT RAISE(ABORT, 'promotions intent is immutable');
END;

-- Conflictos: scope inmutable.
CREATE TRIGGER trg_conflicts_scope_upd BEFORE UPDATE OF scope, scope_ref ON integration_conflicts
BEGIN
  SELECT RAISE(ABORT, 'integration_conflicts scope is immutable');
END;
`;

export const MIGRATIONS: Migration[] = [
  { version: 1, name: "core-etapa1", sql: MIGRATION_0001 },
  { version: 2, name: "agents-plans-etapa2", sql: MIGRATION_0002 },
  { version: 3, name: "tasks-dag-etapa3", sql: MIGRATION_0003 },
  { version: 4, name: "repositories-worktrees-etapa4", sql: MIGRATION_0004 },
  { version: 5, name: "integration-promotion-etapa5", sql: MIGRATION_0005 },
];

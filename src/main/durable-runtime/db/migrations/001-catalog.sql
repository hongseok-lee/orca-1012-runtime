CREATE SCHEMA IF NOT EXISTS durable_runtime;
SET LOCAL search_path = durable_runtime, pg_catalog;

CREATE TABLE dataset_metadata (
  dataset_name text PRIMARY KEY CHECK (dataset_name = 'orca-1012-dev-v1'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO dataset_metadata(dataset_name) VALUES ('orca-1012-dev-v1');

CREATE TABLE agents (
  id uuid PRIMARY KEY,
  dataset_name text NOT NULL DEFAULT 'orca-1012-dev-v1' REFERENCES dataset_metadata,
  provider text NOT NULL CHECK (provider <> ''),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  dataset_name text NOT NULL DEFAULT 'orca-1012-dev-v1' REFERENCES dataset_metadata,
  public_id text NOT NULL UNIQUE CHECK (public_id <> ''),
  name text NOT NULL CHECK (name <> ''),
  provisioning_state text NOT NULL,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  deleted_at timestamptz
);
CREATE TABLE workspace_aliases (
  alias text PRIMARY KEY CHECK (alias <> ''),
  workspace_id uuid NOT NULL REFERENCES workspaces,
  origin text NOT NULL
);
CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  agent_id uuid NOT NULL REFERENCES agents,
  workspace_id uuid NOT NULL REFERENCES workspaces,
  session_fence bigint NOT NULL DEFAULT 0 CHECK (session_fence >= 0),
  lifecycle text NOT NULL CHECK (lifecycle IN ('OPEN','CLOSING','CLOSED')),
  next_input_seq bigint NOT NULL DEFAULT 1 CHECK (next_input_seq > 0),
  next_message_seq bigint NOT NULL DEFAULT 1 CHECK (next_message_seq > 0),
  next_event_seq bigint NOT NULL DEFAULT 1 CHECK (next_event_seq > 0),
  journal_epoch bigint NOT NULL DEFAULT 0 CHECK (journal_epoch >= 0),
  provider_binding_revision bigint NOT NULL DEFAULT 0 CHECK (provider_binding_revision >= 0),
  context_revision bigint NOT NULL DEFAULT 0 CHECK (context_revision >= 0),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  UNIQUE (id, workspace_id), UNIQUE (id, agent_id)
);
CREATE TABLE tabs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces,
  session_id uuid,
  kind text NOT NULL,
  terminal_handle text UNIQUE CHECK (terminal_handle <> ''),
  leaf_id text,
  pane_key text,
  ui_order bigint NOT NULL,
  lifecycle text NOT NULL CHECK (lifecycle IN ('OPEN','CLOSED')),
  closed_at timestamptz,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  FOREIGN KEY (session_id, workspace_id) REFERENCES sessions(id, workspace_id),
  CHECK ((lifecycle='CLOSED') = (closed_at IS NOT NULL))
);

CREATE FUNCTION reject_history_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Durable history is append-only';
END $$;

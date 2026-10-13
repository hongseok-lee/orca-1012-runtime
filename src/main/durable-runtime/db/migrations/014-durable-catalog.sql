SET LOCAL search_path = durable_runtime, pg_catalog;

CREATE TABLE catalog_heads (
  scope text PRIMARY KEY CHECK(scope IN ('catalog','ui:host') OR scope ~ '^workspace:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  dataset_name text NOT NULL DEFAULT 'orca-1012-dev-v1' REFERENCES dataset_metadata,
  publication_epoch text NOT NULL CHECK(publication_epoch<>''),
  revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0)
);
CREATE TABLE catalog_project_groups (
  id text PRIMARY KEY CHECK(id<>''),
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
  revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
  deleted_at timestamptz,
  CHECK(payload ? 'id' AND jsonb_typeof(payload->'id')='string' AND payload->>'id'=id)
);
CREATE TABLE catalog_repositories (
  id text PRIMARY KEY CHECK(id<>''),
  project_group_id text REFERENCES catalog_project_groups,
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
  revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
  deleted_at timestamptz,
  CHECK(payload ? 'id' AND jsonb_typeof(payload->'id')='string' AND payload->>'id'=id)
);
CREATE TABLE catalog_workspace_metadata (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces,
  kind text NOT NULL CHECK(kind IN ('GIT','REPO_FOLDER','FOLDER_WORKSPACE')),
  repo_id text REFERENCES catalog_repositories,
  project_group_id text REFERENCES catalog_project_groups,
  reserved_path text NOT NULL CHECK(reserved_path<>''),
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
  create_request jsonb NOT NULL CHECK(jsonb_typeof(create_request)='object'),
  runtime_unit_id uuid REFERENCES runtime_units,
  provisioning_operation_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(provisioning_operation_id,runtime_unit_id) REFERENCES operations(id,runtime_unit_id),
  CHECK(kind NOT IN ('GIT','REPO_FOLDER') OR repo_id IS NOT NULL),
  CHECK(kind<>'FOLDER_WORKSPACE' OR project_group_id IS NOT NULL),
  CHECK(provisioning_operation_id IS NULL OR runtime_unit_id IS NOT NULL)
);
CREATE TABLE catalog_tab_metadata (
  tab_id uuid PRIMARY KEY REFERENCES tabs,
  public_tab_id text NOT NULL UNIQUE CHECK(public_tab_id<>''),
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
  launch_request jsonb NOT NULL CHECK(jsonb_typeof(launch_request)='object'),
  launch_token text CHECK(launch_token IS NULL OR launch_token<>''),
  binding_revision bigint NOT NULL DEFAULT 0 CHECK(binding_revision>=0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE catalog_ui_state (
  scope text PRIMARY KEY CHECK(scope='host'),
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
  revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0)
);
CREATE TABLE catalog_name_reservations (
  namespace text NOT NULL CHECK(namespace<>''),
  normalized_name text NOT NULL CHECK(normalized_name<>''),
  workspace_id uuid NOT NULL REFERENCES workspaces,
  generated boolean NOT NULL,
  retired boolean NOT NULL DEFAULT false,
  PRIMARY KEY(namespace,normalized_name)
);

CREATE FUNCTION guard_catalog_head() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
BEGIN
  IF (NEW.scope,NEW.dataset_name,NEW.publication_epoch) IS DISTINCT FROM (OLD.scope,OLD.dataset_name,OLD.publication_epoch)
     OR NEW.revision<OLD.revision THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Catalog head identity and epoch are immutable; revision cannot decrease';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catalog_head_guard BEFORE UPDATE ON catalog_heads
  FOR EACH ROW EXECUTE FUNCTION guard_catalog_head();
CREATE FUNCTION guard_catalog_entity() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.revision<OLD.revision THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Catalog entity identity is immutable; revision cannot decrease';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catalog_group_guard BEFORE UPDATE ON catalog_project_groups
  FOR EACH ROW EXECUTE FUNCTION guard_catalog_entity();
CREATE TRIGGER catalog_repo_guard BEFORE UPDATE ON catalog_repositories
  FOR EACH ROW EXECUTE FUNCTION guard_catalog_entity();
CREATE FUNCTION guard_catalog_workspace_metadata() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
BEGIN
  IF (NEW.workspace_id,NEW.kind,NEW.repo_id,NEW.project_group_id,NEW.reserved_path,NEW.create_request,NEW.runtime_unit_id,NEW.provisioning_operation_id,NEW.created_at)
     IS DISTINCT FROM (OLD.workspace_id,OLD.kind,OLD.repo_id,OLD.project_group_id,OLD.reserved_path,OLD.create_request,OLD.runtime_unit_id,OLD.provisioning_operation_id,OLD.created_at) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Catalog Workspace identity and original create request are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catalog_workspace_metadata_guard BEFORE UPDATE ON catalog_workspace_metadata
  FOR EACH ROW EXECUTE FUNCTION guard_catalog_workspace_metadata();
CREATE FUNCTION guard_catalog_tab_metadata() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
BEGIN
  IF (NEW.tab_id,NEW.public_tab_id,NEW.launch_request,NEW.launch_token)
     IS DISTINCT FROM (OLD.tab_id,OLD.public_tab_id,OLD.launch_request,OLD.launch_token)
     OR NEW.binding_revision<OLD.binding_revision THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Catalog Tab identity and original launch request are immutable; binding revision cannot decrease';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catalog_tab_metadata_guard BEFORE UPDATE ON catalog_tab_metadata
  FOR EACH ROW EXECUTE FUNCTION guard_catalog_tab_metadata();
CREATE FUNCTION guard_catalog_ui() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
BEGIN
  IF NEW.scope IS DISTINCT FROM OLD.scope OR NEW.revision<OLD.revision THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Catalog UI scope is immutable; revision cannot decrease';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catalog_ui_guard BEFORE UPDATE ON catalog_ui_state
  FOR EACH ROW EXECUTE FUNCTION guard_catalog_ui();
CREATE FUNCTION guard_catalog_name_reservation() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
BEGIN
  IF (NEW.namespace,NEW.normalized_name,NEW.workspace_id,NEW.generated)
     IS DISTINCT FROM (OLD.namespace,OLD.normalized_name,OLD.workspace_id,OLD.generated)
     OR (OLD.generated AND OLD.retired AND NOT NEW.retired) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Catalog name reservation identity is immutable; retired generated name cannot be reused';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catalog_name_guard BEFORE UPDATE ON catalog_name_reservations
  FOR EACH ROW EXECUTE FUNCTION guard_catalog_name_reservation();

CREATE FUNCTION guard_workspace_public_identity() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
BEGIN
  IF (NEW.id,NEW.dataset_name,NEW.public_id) IS DISTINCT FROM (OLD.id,OLD.dataset_name,OLD.public_id)
     OR NEW.revision<OLD.revision THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Workspace public identity is immutable; revision cannot decrease';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workspace_public_identity_guard BEFORE UPDATE ON workspaces
  FOR EACH ROW EXECUTE FUNCTION guard_workspace_public_identity();
CREATE FUNCTION guard_catalog_logical_tab() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
BEGIN
  IF (NEW.id,NEW.workspace_id,NEW.session_id,NEW.kind,NEW.terminal_handle)
     IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.session_id,OLD.kind,OLD.terminal_handle)
     OR NEW.revision<OLD.revision
     OR (OLD.lifecycle='CLOSED' AND (NEW.lifecycle,NEW.closed_at) IS DISTINCT FROM (OLD.lifecycle,OLD.closed_at)) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Logical Tab identity and CLOSED tombstone are immutable; revision cannot decrease';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catalog_logical_tab_guard BEFORE UPDATE ON tabs
  FOR EACH ROW EXECUTE FUNCTION guard_catalog_logical_tab();

CREATE TRIGGER retain_catalog_heads BEFORE DELETE ON catalog_heads FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER retain_catalog_groups BEFORE DELETE ON catalog_project_groups FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER retain_catalog_repositories BEFORE DELETE ON catalog_repositories FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER retain_catalog_workspace_metadata BEFORE DELETE ON catalog_workspace_metadata FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER retain_catalog_tab_metadata BEFORE DELETE ON catalog_tab_metadata FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER retain_catalog_ui_state BEFORE DELETE ON catalog_ui_state FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER retain_catalog_name_reservations BEFORE DELETE ON catalog_name_reservations FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER retain_catalog_logical_tabs BEFORE DELETE ON tabs FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

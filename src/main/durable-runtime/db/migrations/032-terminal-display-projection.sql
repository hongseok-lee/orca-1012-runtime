SET LOCAL search_path = durable_runtime, pg_catalog;
-- A bounded, rebuildable display projection. Source control frames remain immutable.
CREATE TABLE terminal_display_projections (
  session_id uuid PRIMARY KEY REFERENCES sessions(id),
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

SET LOCAL search_path = durable_runtime, pg_catalog;

-- An uncertain cancel targets one original turn on one old execution. Preserve
-- that UNKNOWN outcome and never replay it; it cannot create a replacement
-- writer. Fresh activity and physical stop proof still gate sleep/new writers.
-- Like UNKNOWN dispatch, this history must not occupy the live command slot.
DROP INDEX runtime_one_unresolved_command;
CREATE UNIQUE INDEX runtime_one_unresolved_command ON runtime_commands(runtime_unit_id)
  WHERE state IN ('ACCEPTED','EXECUTING') OR
    (state = 'UNKNOWN' AND command_name NOT IN ('dispatchInput','cancel'));

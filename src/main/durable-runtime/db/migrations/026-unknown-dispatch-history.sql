SET LOCAL search_path = durable_runtime, pg_catalog;

-- An UNKNOWN input dispatch is history: it is carried to the next input as
-- recovery context and never resent, so it must not occupy the unit's single
-- unresolved-command slot (design R03: UNKNOWN never blocks later input).
DROP INDEX runtime_one_unresolved_command;
CREATE UNIQUE INDEX runtime_one_unresolved_command ON runtime_commands(runtime_unit_id)
  WHERE state IN ('ACCEPTED','EXECUTING') OR (state = 'UNKNOWN' AND command_name <> 'dispatchInput');

-- Superlatives race — grants. Apply by hand in the SQL editor: these are the
-- statements the MCP migration tool refuses as "destructive".
--
-- compute_superlative_leaders is heavy (a full season of starts, every
-- trade, the baseline table) and only the sync step (service role) and the
-- SQL editor should run it. New functions in scdfl are EXECUTE-able by the
-- API roles by default, so take that back.
revoke execute on function scdfl.compute_superlative_leaders(int, int, int, int) from public, anon, authenticated;

-- An earlier version of the function had two parameters; CREATE OR REPLACE
-- with the longer signature leaves that one behind as a second overload,
-- which makes a two-argument call ambiguous. Drop it if it is still there.
drop function if exists scdfl.compute_superlative_leaders(int, int);

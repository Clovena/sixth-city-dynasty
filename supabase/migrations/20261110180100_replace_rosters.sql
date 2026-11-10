-- Atomic full replace for scdfl.rosters (used by _shared/sync/rosters.ts).
--
-- The sync used to DELETE every row and then INSERT as two separate API
-- calls. If the insert failed — most often an FK violation because Sleeper
-- rostered a player scdfl.players doesn't know yet — the table was left
-- empty until someone noticed. Run nightly and unattended, that could last
-- days. Here both happen in one transaction, and unknown players are
-- skipped (and returned) instead of failing the whole replace.
--
-- p_rows: [{"player_id": "4046", "sleeper_id": 3}, ...]
-- returns {"inserted": <int>, "skipped": ["<player_id>", ...]}

create or replace function scdfl.replace_rosters(p_rows jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_inserted int;
  v_skipped  text[];
begin
  select coalesce(array_agg(r.player_id order by r.player_id), '{}')
    into v_skipped
    from jsonb_to_recordset(p_rows) as r(player_id text, sleeper_id int)
   where not exists (select 1 from scdfl.players p where p.player_id = r.player_id);

  -- `where true`: pg_safeupdate rejects an unqualified DELETE on API requests
  delete from scdfl.rosters where true;

  insert into scdfl.rosters (player_id, sleeper_id)
  select r.player_id, r.sleeper_id
    from jsonb_to_recordset(p_rows) as r(player_id text, sleeper_id int)
   where exists (select 1 from scdfl.players p where p.player_id = r.player_id);

  get diagnostics v_inserted = row_count;

  return jsonb_build_object('inserted', v_inserted, 'skipped', to_jsonb(v_skipped));
end;
$$;

revoke all on function scdfl.replace_rosters(jsonb) from public, anon, authenticated;
grant execute on function scdfl.replace_rosters(jsonb) to service_role;

import { runSync } from "./cli";
import { syncMatchups } from "../../supabase/functions/_shared/sync/matchups.ts";

// Logic lives in supabase/functions/_shared/sync/matchups.ts (shared with the
// nightly `sync` Edge Function). This is the npm run sync:matchups entry point.
runSync(syncMatchups);

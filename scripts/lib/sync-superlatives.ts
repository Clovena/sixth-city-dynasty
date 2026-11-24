import { runSync } from "./cli";
import { syncSuperlatives } from "../../supabase/functions/_shared/sync/superlatives.ts";

// Logic lives in supabase/functions/_shared/sync/superlatives.ts (shared with
// the nightly `sync` Edge Function). This is the npm run sync:superlatives
// entry point: it picks as_of_week from Sleeper's NFL state and calls
// scdfl.refresh_superlative_leaders(season, week).
runSync(syncSuperlatives);

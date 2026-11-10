import { runSync } from "./cli";
import { syncRosters } from "../../supabase/functions/_shared/sync/rosters.ts";

// Logic lives in supabase/functions/_shared/sync/rosters.ts (shared with the
// nightly `sync` Edge Function). This is the npm run sync:rosters entry point.
runSync(syncRosters);

import { runSync } from "./cli";
import { syncStats } from "../../supabase/functions/_shared/sync/stats.ts";

// Logic lives in supabase/functions/_shared/sync/stats.ts (shared with the
// nightly `sync` Edge Function). This is the npm run sync:stats entry point.
runSync(syncStats);

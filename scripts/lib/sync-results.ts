import { runSync } from "./cli";
import { syncResults } from "../../supabase/functions/_shared/sync/results.ts";

// Logic lives in supabase/functions/_shared/sync/results.ts (shared with the
// nightly `sync` Edge Function). This is the npm run sync:results entry point.
runSync(syncResults);

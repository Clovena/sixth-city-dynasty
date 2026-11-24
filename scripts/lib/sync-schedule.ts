import { runSync } from "./cli";
import { syncSchedule } from "../../supabase/functions/_shared/sync/schedule.ts";

// Logic lives in supabase/functions/_shared/sync/schedule.ts (shared with the
// nightly `sync` Edge Function). This is the npm run sync:schedule entry point.
runSync(syncSchedule);

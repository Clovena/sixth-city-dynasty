import { runSync } from "./cli";
import { syncDrafts } from "../../supabase/functions/_shared/sync/drafts.ts";

// Logic lives in supabase/functions/_shared/sync/drafts.ts (shared with the
// nightly `sync` Edge Function). This is the npm run sync:drafts entry point.
runSync(syncDrafts);

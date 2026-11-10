import { runSync } from "./cli";
import { syncExhibitions } from "../../supabase/functions/_shared/sync/exhibitions.ts";

// Logic lives in supabase/functions/_shared/sync/exhibitions.ts (shared with the
// nightly `sync` Edge Function). This is the npm run sync:exhibitions entry point.
runSync(syncExhibitions);

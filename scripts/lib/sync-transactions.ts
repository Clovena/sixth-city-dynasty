import { runSync } from "./cli";
import { syncTransactions } from "../../supabase/functions/_shared/sync/transactions.ts";

// Logic lives in supabase/functions/_shared/sync/transactions.ts (shared with the
// nightly `sync` Edge Function). This is the npm run sync:transactions entry point.
runSync(syncTransactions);

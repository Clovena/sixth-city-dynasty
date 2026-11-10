// Thin Discord REST client. No library, no gateway/websocket — the bot only
// ever makes plain HTTPS calls to Discord's REST API v10 (spec §2, §7.2).
//
// First Discord-auth note: the bot token is a password. It lives only in the
// Edge Function's secret store (Deno.env) and is sent as the Authorization
// header. It is never logged — error paths below log the status and body,
// never the request headers.

const API = 'https://discord.com/api/v10';

function headers(): Record<string, string> {
  return {
    'Authorization': `Bot ${Deno.env.get('DISCORD_BOT_TOKEN')}`,
    'Content-Type': 'application/json',
    // Discord asks bots to identify themselves with a URL + version.
    'User-Agent': 'DiscordBot (https://sixthcitydfl.com, 1.0)',
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// One REST call with the spec §7.4 retry policy:
//  - 429 (rate limited): Discord's JSON body says how long to wait
//    (`retry_after`, seconds); wait and retry, max 3 attempts.
//  - 5xx: transient server trouble; exponential backoff, max 3 attempts.
//  - anything else non-OK: throw with status + body (token never included).
async function request(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (res.ok) {
      // 204 No Content has no body to parse
      return res.status === 204 ? {} : await res.json();
    }

    const text = await res.text();
    if (res.status === 429 && attempt < 3) {
      let wait = 2;
      try {
        wait = JSON.parse(text).retry_after ?? 2;
      } catch { /* fall back to 2 s */ }
      await sleep(wait * 1000);
      continue;
    }
    if (res.status >= 500 && attempt < 3) {
      await sleep(1000 * 2 ** (attempt - 1));
      continue;
    }
    throw new Error(`discord ${res.status} on ${method} ${path}: ${text.slice(0, 300)}`);
  }
}

// Post a plain message or a poll. Returns Discord's message object — for a
// poll, `message.poll.answers[].answer_id` is read from this (spec §7.3).
export function postMessage(channelId: string, payload: unknown) {
  return request('POST', `/channels/${channelId}/messages`, payload);
}

// End a poll early. Only the poll's own bot can do this. "Already ended" is
// success for our purposes (the LOCK step must be safe to run twice).
export async function expirePoll(channelId: string, messageId: string) {
  try {
    await request('POST', `/channels/${channelId}/polls/${messageId}/expire`);
  } catch (err) {
    const msg = String(err);
    if (/expired|ended|520006/i.test(msg)) return; // already closed: fine
    throw err;
  }
}

// Re-fetch a message, e.g. to read poll.results.is_finalized (spec §7.3:
// counts are only exact once Discord marks the poll finalized).
export function getMessage(channelId: string, messageId: string) {
  return request('GET', `/channels/${channelId}/messages/${messageId}`);
}

export type DiscordUser = {
  id: string;
  username: string;
  global_name?: string | null;
};

// All voters for one poll answer, following Discord's pagination: pass the
// last user id as `after` until a page comes back short (spec §7.2).
export async function getAnswerVoters(
  channelId: string,
  messageId: string,
  answerId: number,
): Promise<DiscordUser[]> {
  const users: DiscordUser[] = [];
  let after = '';
  while (true) {
    const page = await request(
      'GET',
      `/channels/${channelId}/polls/${messageId}/answers/${answerId}?limit=100` +
        (after ? `&after=${after}` : ''),
    ) as { users?: DiscordUser[] };
    const batch = page.users ?? [];
    users.push(...batch);
    if (batch.length < 100) return users;
    after = batch[batch.length - 1].id;
  }
}

// A voter's display name: prefer the per-server-agnostic global name, fall
// back to the unique username (§18.2).
export function voterDisplayName(u: DiscordUser): string {
  return u.global_name || u.username;
}

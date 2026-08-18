/**
 * A stand-in for a Supabase project, spoken to over HTTP by the real supabase-js client.
 *
 * This exists because the interesting question — "does a shot logged on her phone show up on
 * mine?" — cannot be answered by unit tests, and a real Supabase project is not reachable from
 * CI. So this implements just enough of GoTrue (auth) and PostgREST (queries) for the app's own
 * requests, and the e2e suite drives two browser contexts against it.
 *
 * It is not a security model: row-level security is enforced by Postgres in the real thing and is
 * only *simulated* here by filtering on household_id. What this proves is the client's behaviour —
 * that pushes carry the right rows, pulls merge correctly, and two devices converge.
 */
import { createServer } from 'node:http';

const users = new Map(); // email -> { id, password }
const tokens = new Map(); // access token -> user id
const memberships = new Map(); // user id -> household id
const rows = new Map(); // `${household}:${id}` -> record

let nextId = 1;

/**
 * PostgREST returns a *bare object* rather than an array when the client asks for one via
 * `Accept: application/vnd.pgrst.object+json` — which is what supabase-js `.single()` and
 * `.maybeSingle()` do. Getting this wrong is invisible until a field reads as undefined, which is
 * exactly how the household id came back empty the first time.
 */
function respond(req, res, status, rows) {
  const wantsObject = (req.headers.accept ?? '').includes('vnd.pgrst.object+json');
  if (!wantsObject) return json(res, status, rows);

  if (Array.isArray(rows) && rows.length === 1) return json(res, status, rows[0]);
  return json(res, 406, {
    code: 'PGRST116',
    message: 'JSON object requested, multiple (or no) rows returned',
    details: `Results contain ${Array.isArray(rows) ? rows.length : 0} rows`,
  });
}

function json(res, status, body) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    // The browser calls this cross-origin from the app's own port.
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-expose-headers': '*',
    'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
  });
  res.end(payload);
}

function userFor(req) {
  const auth = req.headers.authorization ?? '';
  const token = auth.replace(/^Bearer\s+/i, '');
  return tokens.get(token);
}

function session(user) {
  const token = `token-${user.id}-${nextId++}`;
  tokens.set(token, user.id);
  return {
    access_token: token,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: `refresh-${token}`,
    user: {
      id: user.id,
      email: user.email,
      aud: 'authenticated',
      role: 'authenticated',
      app_metadata: {},
      user_metadata: {},
      created_at: new Date().toISOString(),
    },
  };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * PostgREST encodes filters as query params: `?column=eq.value`, `?updated_at=gt.123`.
 * Only the two operators the app uses are supported.
 */
function matchesFilters(record, params) {
  for (const [key, raw] of params) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(key)) continue;
    const [op, ...rest] = raw.split('.');
    const value = rest.join('.');
    if (op === 'eq' && String(record[key]) !== value) return false;
    if (op === 'gt' && !(Number(record[key]) > Number(value))) return false;
  }
  return true;
}

export function startStubSupabase(port = 54_321) {
  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => json(res, 500, { message: String(err) }));
  });

  async function handle(req, res) {
    if (req.method === 'OPTIONS') return json(res, 204);

    const url = new URL(req.url, `http://localhost:${port}`);
    const body = await readBody(req);

    // --- Auth ---------------------------------------------------------------
    if (url.pathname === '/auth/v1/signup') {
      const { email, password } = body;
      if (users.has(email)) return json(res, 400, { message: 'User already registered' });
      const user = { id: `user-${nextId++}`, email, password };
      users.set(email, user);
      return json(res, 200, session(user));
    }

    if (url.pathname === '/auth/v1/token') {
      const { email, password, refresh_token: refresh } = body ?? {};
      if (refresh) {
        const owner = [...tokens.values()][0];
        const user = [...users.values()].find((u) => u.id === owner);
        return user ? json(res, 200, session(user)) : json(res, 400, { error: 'invalid_grant' });
      }
      const user = users.get(email);
      if (!user || user.password !== password) {
        return json(res, 400, {
          error: 'invalid_grant',
          error_description: 'Invalid login credentials',
        });
      }
      return json(res, 200, session(user));
    }

    if (url.pathname === '/auth/v1/logout') return json(res, 204);

    if (url.pathname === '/auth/v1/user') {
      const userId = userFor(req);
      const user = [...users.values()].find((u) => u.id === userId);
      if (!user) return json(res, 401, { message: 'invalid claim' });
      return json(res, 200, { id: user.id, email: user.email, aud: 'authenticated' });
    }

    // --- PostgREST ----------------------------------------------------------
    const userId = userFor(req);
    if (!userId) return json(res, 401, { message: 'JWT expired' });

    if (url.pathname === '/rest/v1/household_members') {
      if (req.method === 'GET') {
        const household = memberships.get(userId);
        const found =
          household === undefined
            ? []
            : [{ user_id: userId, household_id: household }].filter((r) =>
                matchesFilters(r, url.searchParams),
              );
        return respond(req, res, 200, found);
      }
      if (req.method === 'POST') {
        const household = `household-${nextId++}`;
        memberships.set(userId, household);
        return respond(req, res, 201, [{ user_id: userId, household_id: household }]);
      }
      if (req.method === 'PATCH') {
        memberships.set(userId, body.household_id);
        return respond(req, res, 200, [{ user_id: userId, household_id: body.household_id }]);
      }
    }

    if (url.pathname === '/rest/v1/sync_rows') {
      const household = memberships.get(userId);
      if (!household) return json(res, 403, { message: 'permission denied' });

      if (req.method === 'POST') {
        // Upsert. Stand-in for RLS: a client may only write into its own household.
        for (const record of Array.isArray(body) ? body : [body]) {
          if (record.household_id !== household) {
            return json(res, 403, {
              message: 'new row violates row-level security policy for table "sync_rows"',
            });
          }
          rows.set(`${record.household_id}:${record.id}`, { ...record });
        }
        return json(res, 201, []);
      }

      if (req.method === 'GET') {
        let found = [...rows.values()]
          .filter((r) => r.household_id === household)
          .filter((r) => matchesFilters(r, url.searchParams));
        found.sort((a, b) => a.updated_at - b.updated_at || String(a.id).localeCompare(String(b.id)));

        // supabase-js sends `.range()` as an HTTP Range header.
        const range = req.headers.range;
        if (range) {
          const [from, to] = range.replace(/^items=/, '').split('-').map(Number);
          found = found.slice(from, to + 1);
        }
        return json(res, 200, found);
      }
    }

    return json(res, 404, { message: `no stub for ${req.method} ${url.pathname}` });
  }

  return new Promise((resolve) => {
    server.listen(port, () => resolve({ server, port }));
  });
}

// Run directly so Playwright can start it as a webServer.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const port = Number(process.env.STUB_PORT ?? 54_321);
  await startStubSupabase(port);
  console.log(`stub supabase listening on ${port}`);
}

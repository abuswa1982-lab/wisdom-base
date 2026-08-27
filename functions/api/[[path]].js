/**
 * Wisdom Base API  (Cloudflare Pages Function)
 *
 * Lives at functions/api/[[path]].js, so it answers everything under /api/.
 * Push this repo to GitHub and Cloudflare Pages deploys the page and this
 * file together. You never run a deploy command.
 *
 * Two jobs:
 *   1. Store the decision records in D1 so they survive a cleared browser
 *      and everyone sees the same ones.
 *   2. Decide who is allowed to do what, HERE, on the server. The app hides
 *      the Admin tab from non-admins as a courtesy, but that is decoration.
 *      This file is the actual lock.
 *
 * Identity comes from Cloudflare Access. Access puts a signed JWT on every
 * request; we verify the signature against your team's public keys, so a
 * forged header gets nowhere.
 *
 * Set these in the Cloudflare dashboard under your Pages project
 * (Settings, then Functions for the database, Environment variables for the rest):
 *   DB              D1 database binding, named exactly DB
 *   ADMIN_EMAILS    comma separated, e.g. "ahmed@x.com,colton@x.com"
 *   ACCESS_TEAM     your team name, from <team>.cloudflareaccess.com
 *   ACCESS_AUD      the Application Audience tag from the Access application
 *   ANTHROPIC_KEY   add as a SECRET, not plaintext
 *   MODEL           optional, defaults to claude-sonnet-4-5
 */

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });

/* ---------------- Access JWT verification ---------------- */

let keyCache = { at: 0, keys: null };

async function accessKeys(team) {
  // certs rotate, so re-fetch hourly
  if (keyCache.keys && Date.now() - keyCache.at < 3600_000) return keyCache.keys;
  const res = await fetch(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error('could not fetch Access certs');
  const { keys } = await res.json();
  keyCache = { at: Date.now(), keys };
  return keys;
}

const b64url = (s) => {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

// A malformed token is a rejected caller, not a server fault. Decode failures
// return null so they come back as 401, while a genuine misconfiguration
// (bad ACCESS_TEAM, certs unreachable) still throws and shows up as 500.
const decodePart = (s) => {
  try { return JSON.parse(new TextDecoder().decode(b64url(s))); }
  catch { return null; }
};

async function verifyAccess(request, env) {
  const token =
    request.headers.get('cf-access-jwt-assertion') ||
    (request.headers.get('cookie') || '').match(/CF_Authorization=([^;]+)/)?.[1];

  if (!token) return null;

  const [h, p, sig] = token.split('.');
  if (!h || !p || !sig) return null;

  const header = decodePart(h);
  if (!header || !header.kid) return null;

  const keys = await accessKeys(env.ACCESS_TEAM);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );

  let ok = false;
  try {
    ok = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      b64url(sig),
      new TextEncoder().encode(`${h}.${p}`)
    );
  } catch { return null; }          // unparseable signature bytes
  if (!ok) return null;

  const claims = decodePart(p);
  if (!claims) return null;
  if (claims.exp && claims.exp * 1000 < Date.now()) return null;              // expired
  const aud = [].concat(claims.aud || []);
  if (env.ACCESS_AUD && !aud.includes(env.ACCESS_AUD)) return null;           // wrong app
  return claims.email ? String(claims.email).toLowerCase() : null;
}

function isAdmin(email, env) {
  if (!email) return false;
  return String(env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .includes(email);
}

/* ---------------- record shaping ---------------- */

const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

const rowToRecord = (r) => ({
  id: r.id, dept: r.dept, topic: r.topic, scenario: r.scenario,
  trigger: r.trigger || '',
  aliases: parse(r.aliases, []), inputs: parse(r.inputs, []), rules: parse(r.rules, []),
  status: r.status, owner: r.owner || '', updated: r.updated || ''
});

const clean = (v) => String(v == null ? '' : v).trim();

function validate(rec) {
  if (!clean(rec.dept) || !clean(rec.topic) || !clean(rec.scenario))
    return 'department, topic and scenario are all required';
  if (!Array.isArray(rec.rules) || !rec.rules.length)
    return 'a record with no rules cannot answer anything';
  if (rec.rules.some((r) => !clean(r.verdict)))
    return 'every rule needs a decision written in it';
  if (rec.status === 'approved' && (!rec.aliases || !rec.aliases.length))
    return 'an approved record needs alternate phrasings or nobody will find it';
  return null;
}

/* ---------------- routes ---------------- */

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');

  if (!path.startsWith('/api')) return new Response('Not found', { status: 404 });

  let email;
  try {
    email = await verifyAccess(request, env);
  } catch (e) {
    return json({ error: 'auth check failed: ' + e.message }, 500);
  }
  if (!email) return json({ error: 'not signed in' }, 401);

  const admin = isAdmin(email, env);
  const method = request.method;

  // every write path goes through here. no exceptions, no client trust.
  const requireAdmin = () =>
    admin ? null : json({ error: 'admins only' }, 403);

  try {
    /* who am I */
    if (path === '/api/me') return json({ email, isAdmin: admin });

    /* records */
    if (path === '/api/records' && method === 'GET') {
      // users only ever receive approved records. drafts never leave the server.
      const sql = admin
        ? 'SELECT * FROM records ORDER BY dept, topic, scenario'
        : "SELECT * FROM records WHERE status = 'approved' ORDER BY dept, topic, scenario";
      const { results } = await env.DB.prepare(sql).all();
      return json({ records: (results || []).map(rowToRecord) });
    }

    if (path === '/api/records' && method === 'PUT') {
      const denied = requireAdmin(); if (denied) return denied;
      const body = await request.json();
      const list = Array.isArray(body) ? body : [body];
      const saved = [], rejected = [];

      for (const rec of list) {
        const problem = validate(rec);
        if (problem) { rejected.push({ scenario: rec.scenario, problem }); continue; }
        try {
          await env.DB.prepare(
            `INSERT INTO records (id,dept,topic,scenario,trigger,aliases,inputs,rules,status,owner,updated,updated_by)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET
               dept=excluded.dept, topic=excluded.topic, scenario=excluded.scenario,
               trigger=excluded.trigger, aliases=excluded.aliases, inputs=excluded.inputs,
               rules=excluded.rules, status=excluded.status, owner=excluded.owner,
               updated=excluded.updated, updated_by=excluded.updated_by`
          ).bind(
            clean(rec.id) || 'wb-' + crypto.randomUUID().slice(0, 8),
            clean(rec.dept), clean(rec.topic), clean(rec.scenario), clean(rec.trigger),
            JSON.stringify(rec.aliases || []), JSON.stringify(rec.inputs || []),
            JSON.stringify(rec.rules || []),
            rec.status === 'approved' ? 'approved' : 'draft',
            clean(rec.owner), new Date().toISOString().slice(0, 10), email
          ).run();
          saved.push(rec.scenario);
        } catch (e) {
          // the unique index is what actually stops duplicates
          rejected.push({
            scenario: rec.scenario,
            problem: /UNIQUE/i.test(e.message)
              ? 'a record already exists at this exact path'
              : e.message
          });
        }
      }
      return json({ saved: saved.length, rejected });
    }

    if (path.startsWith('/api/records/') && method === 'DELETE') {
      const denied = requireAdmin(); if (denied) return denied;
      await env.DB.prepare('DELETE FROM records WHERE id = ?')
        .bind(path.split('/').pop()).run();
      return json({ ok: true });
    }

    /* gaps: anyone can log one, only admins clear them */
    if (path === '/api/gaps' && method === 'GET') {
      const denied = requireAdmin(); if (denied) return denied;
      const { results } = await env.DB.prepare(
        'SELECT * FROM gaps ORDER BY id DESC LIMIT 200').all();
      return json({ gaps: results || [] });
    }

    if (path === '/api/gaps' && method === 'POST') {
      const { question } = await request.json();
      if (clean(question)) {
        await env.DB.prepare(
          'INSERT INTO gaps (question, asked_by, asked_at) VALUES (?,?,?)'
        ).bind(clean(question).slice(0, 500), email, new Date().toISOString()).run();
      }
      return json({ ok: true });
    }

    if (path.startsWith('/api/gaps/') && method === 'DELETE') {
      const denied = requireAdmin(); if (denied) return denied;
      await env.DB.prepare('DELETE FROM gaps WHERE id = ?')
        .bind(Number(path.split('/').pop())).run();
      return json({ ok: true });
    }

    /* lookups: how you prove escalations actually dropped */
    if (path === '/api/lookups' && method === 'POST') {
      const { recordId, scenario } = await request.json();
      await env.DB.prepare(
        'INSERT INTO lookups (record_id, scenario, who, at) VALUES (?,?,?,?)'
      ).bind(clean(recordId), clean(scenario), email, new Date().toISOString()).run();
      return json({ ok: true });
    }

    if (path === '/api/lookups' && method === 'GET') {
      const denied = requireAdmin(); if (denied) return denied;
      const { results } = await env.DB.prepare(
        `SELECT scenario, COUNT(*) n, MAX(at) last
         FROM lookups GROUP BY scenario ORDER BY n DESC LIMIT 50`).all();
      return json({ lookups: results || [] });
    }

    /* brainstorm: the API key lives here and never reaches a browser */
    if (path === '/api/organize' && method === 'POST') {
      const denied = requireAdmin(); if (denied) return denied;
      if (!env.ANTHROPIC_KEY) return json({ error: 'ANTHROPIC_KEY is not set on the Worker' }, 500);

      const { content } = await request.json();
      if (!Array.isArray(content) || !content.length)
        return json({ error: 'nothing to organize' }, 400);

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': env.ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: env.MODEL || 'claude-sonnet-4-5',
          max_tokens: 8000,
          messages: [{ role: 'user', content }]
        })
      });
      if (!res.ok) return json({ error: 'model call failed: ' + (await res.text()).slice(0, 300) }, 502);
      const data = await res.json();
      return json({ text: (data.content || []).map((c) => c.text || '').join('') });
    }

    return json({ error: 'no such endpoint' }, 404);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
  }

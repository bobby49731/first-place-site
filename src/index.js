// Cloudflare Worker entry point (Workers with Static Assets).
//
// This project has no build step — index.html/shop.html/confirmed.html and
// assets/ are served as-is from public/ via the [assets] binding in
// wrangler.toml. This script only exists to add a couple of custom API
// routes; every other request is passed straight through to those static
// files, exactly as they were served before this script existed
// (previously this was a static-assets-only Worker with no fetch handler
// at all).
//
// Routes handled here:
//
//   POST /api/check-subscriber — looks up whether a submitted email is
//   already a CONFIRMED (state === "active") Kit subscriber, using the Kit
//   API secret stored as the KIT_API_SECRET environment variable/secret.
//   The secret is read server-side only and never reaches the browser.
//
//   Why this route exists: an already-confirmed Kit subscriber who signs up
//   again from a new device (no localStorage flag set there yet) gets no
//   new confirmation email — Kit doesn't re-send one to someone already
//   confirmed — so without this check they'd be stuck on "check your
//   email" forever with no way in. The client calls this first on submit
//   and skips straight to granting access when it comes back confirmed.
//
//   Fails safe on every error path (missing secret, bad request body, Kit
//   API error, network failure) by returning { confirmed: false } with a
//   200 — never a hard failure — so the existing "submit to Kit, check
//   your email" flow on the site always still works as the fallback.
//
//   POST /api/submit-contact — the game's single shared route for all 8
//   Connection squares (4, 11, 16, 22, 27, 33, 38, 43 — see
//   CONNECTION_SQUARES in game.html). Takes a `contacts` array of
//   { name, email, phone } entries — 1 person for most squares, up to 3
//   for Squares 16, 27, and 43 (how many the client shows is purely a
//   UI concern; the server treats a 1-element array the same as a
//   3-element one). Each contact "counts" with a name plus either a
//   valid email or a phone number. Every qualifying valid email triggers
//   a real Resend send (RESEND_API_KEY), using the SAME email content
//   everywhere regardless of which square or character triggered it
//   (INVITE_TEMPLATE below) — the on-screen card copy stays square/
//   character-specific, but what actually lands in the friend's inbox is
//   consistent. Every qualifying phone number is written to the
//   GAME_CONTACTS KV namespace for future SMS use — captured only, no
//   message sent yet. Responds { success, advanced }: success is
//   whether the request itself was handled without error; advanced is
//   whether at least one contact counted, which is what the client uses
//   to decide whether the player's token moves — skipping, or
//   submitting nothing that counts, both come back as
//   { success: true, advanced: false }, since neither is an error, just
//   nothing to advance for. Unlike check-subscriber, a genuine send
//   failure (bad key, Resend error, network issue) comes back as an
//   honest { success: false } — the client only advances once this
//   genuinely reports success, so that has to mean something real.
//
//   POST /api/debug-check — verifies the game's debug-mode key against
//   the DEBUG_KEY secret, so the key itself never ships in game.html's
//   public source. Responds { ok } and nothing else; ok is false on any
//   mismatch, missing secret, or bad body.

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const SITE_URL = 'https://watchfirstplace.com';
// Sent as "the First Place team," not the individual player — same
// identity as Kit's confirmation email — since the player's own name
// isn't captured anywhere in this flow.
const INVITE_FROM = 'The First Place Team <invites@watchfirstplace.com>';
const RESEND_API_URL = 'https://api.resend.com/emails';

// The 8 Connection squares that can submit a contact — see
// CONNECTION_SQUARES in game.html for each one's own field shape
// (that's a client-side/UI concern only; the server treats every
// submission the same regardless of which square it came from).
const CONNECTION_SQUARES = [4, 11, 16, 22, 27, 33, 38, 43];

// One consistent email, regardless of which square or character
// triggered it — the on-screen card copy is square/character-specific,
// but the actual message a friend receives is the same everywhere.
const INVITE_TEMPLATE = {
  subject: 'Thought of you — check this out',
  text: "Hey — have you checked out First Place? It's a new show about " +
    'autistic folks and people with Down syndrome moving out and living ' +
    'independently for the first time — heartwarming, funny, real. ' +
    'Thought of you — check out this new series.\n\n' + SITE_URL,
  html: '<p>Hey &mdash; have you checked out <strong>First Place</strong>? ' +
    "It's a new show about autistic folks and people with Down syndrome " +
    'moving out and living independently for the first time &mdash; ' +
    'heartwarming, funny, real. Thought of you &mdash; check out this ' +
    'new series.</p>' +
    '<p><a href="' + SITE_URL + '">' + SITE_URL + '</a></p>'
};

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function checkSubscriber(request, env) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let email;
  try {
    const body = await request.json();
    email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  } catch (err) {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }

  if (!email || !EMAIL_PATTERN.test(email)) {
    return jsonResponse({ error: 'Invalid email' }, 400);
  }

  if (!env.KIT_API_SECRET) {
    // Not configured yet — fail safe rather than block signups.
    return jsonResponse({ confirmed: false });
  }

  try {
    const kitRes = await fetch(
      'https://api.kit.com/v4/subscribers?email_address=' + encodeURIComponent(email),
      {
        headers: {
          'Accept': 'application/json',
          'X-Kit-Api-Key': env.KIT_API_SECRET
        }
      }
    );

    if (!kitRes.ok) {
      return jsonResponse({ confirmed: false });
    }

    const data = await kitRes.json();
    const subscriber = Array.isArray(data.subscribers) ? data.subscribers[0] : null;
    const confirmed = !!subscriber && subscriber.state === 'active';

    return jsonResponse({ confirmed: confirmed });
  } catch (err) {
    return jsonResponse({ confirmed: false });
  }
}

async function sendOneInvite(env, to, template) {
  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + env.RESEND_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: INVITE_FROM,
      to: [to],
      subject: template.subject,
      text: template.text,
      html: template.html
    })
  });
  return res.ok;
}

async function submitContact(request, env) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let square, character, contacts;
  try {
    const body = await request.json();
    square = parseInt(body.square, 10);
    character = typeof body.character === 'string' ? body.character.trim().toLowerCase() : '';
    contacts = Array.isArray(body.contacts) ? body.contacts : [];
  } catch (err) {
    return jsonResponse({ success: false, error: 'Invalid request body' }, 400);
  }

  if (CONNECTION_SQUARES.indexOf(square) === -1) {
    return jsonResponse({ success: false, error: 'Unknown square' }, 400);
  }

  const cleaned = contacts.map(function (c) {
    c = c && typeof c === 'object' ? c : {};
    return {
      name: typeof c.name === 'string' ? c.name.trim() : '',
      email: typeof c.email === 'string' ? c.email.trim().toLowerCase() : '',
      phone: typeof c.phone === 'string' ? c.phone.trim() : ''
    };
  });

  // A contact "counts" with a name plus either a valid email or a phone
  // number — matching what the card itself asks for. A square that only
  // takes 1 person still arrives here as a 1-element array, so this
  // logic is identical regardless of how many people a square allows.
  const qualifying = cleaned.filter(function (c) {
    if (!c.name) return false;
    return (c.email && EMAIL_PATTERN.test(c.email)) || !!c.phone;
  });

  if (!qualifying.length) {
    // Not an error — the client treats this exactly like Skip.
    return jsonResponse({ success: true, advanced: false });
  }

  const toEmail = qualifying.filter(function (c) { return c.email && EMAIL_PATTERN.test(c.email); });
  if (toEmail.length) {
    if (!env.RESEND_API_KEY) {
      // Unlike check-subscriber, this genuinely can't succeed without
      // the key — say so honestly rather than pretending it worked.
      return jsonResponse({ success: false, error: 'Email sending is not configured' }, 500);
    }
    try {
      const results = await Promise.all(
        toEmail.map(function (c) { return sendOneInvite(env, c.email, INVITE_TEMPLATE); })
      );
      const allSent = results.every(function (ok) { return ok; });
      if (!allSent) {
        return jsonResponse({ success: false, error: 'One or more emails failed to send' }, 502);
      }
    } catch (err) {
      return jsonResponse({ success: false, error: 'Email sending failed' }, 502);
    }
  }

  // Phone capture is best-effort — a KV hiccup shouldn't block the
  // player's turn from resolving, since nothing is actually sent to
  // these numbers yet (captured for future SMS use only).
  const toStore = qualifying.filter(function (c) { return c.phone; });
  if (toStore.length && env.GAME_CONTACTS) {
    await Promise.all(toStore.map(function (c) {
      const key = 'contact:' + square + ':' + Date.now() + ':' + Math.random().toString(36).slice(2, 8);
      const value = JSON.stringify({
        name: c.name,
        phone: c.phone,
        email: c.email || null,
        square: square,
        character: character || null,
        capturedAt: new Date().toISOString()
      });
      return env.GAME_CONTACTS.put(key, value).catch(function () {});
    }));
  }

  return jsonResponse({ success: true, advanced: true });
}

async function debugCheck(request, env) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let key;
  try {
    const body = await request.json();
    key = typeof body.key === 'string' ? body.key : '';
  } catch (err) {
    return jsonResponse({ ok: false }, 400);
  }

  if (!env.DEBUG_KEY || !key) {
    return jsonResponse({ ok: false });
  }

  const enc = new TextEncoder();
  const a = enc.encode(key);
  const b = enc.encode(env.DEBUG_KEY);
  const ok = a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
  return jsonResponse({ ok: ok });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/check-subscriber') {
      return checkSubscriber(request, env);
    }

    if (url.pathname === '/api/submit-contact') {
      return submitContact(request, env);
    }

    if (url.pathname === '/api/debug-check') {
      return debugCheck(request, env);
    }

    // Everything else: serve the static site exactly as before.
    return env.ASSETS.fetch(request);
  }
};

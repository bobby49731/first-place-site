// Cloudflare Worker entry point (Workers with Static Assets).
//
// This project has no build step — index.html/shop.html/confirmed.html and
// assets/ are served as-is from public/ via the [assets] binding in
// wrangler.toml. This script only exists to add one custom API route;
// every other request is passed straight through to those static files,
// exactly as they were served before this script existed (previously this
// was a static-assets-only Worker with no fetch handler at all).
//
// Route handled here:
//   POST /api/check-subscriber — looks up whether a submitted email is
//   already a CONFIRMED (state === "active") Kit subscriber, using the Kit
//   API secret stored as the KIT_API_SECRET environment variable/secret.
//   The secret is read server-side only and never reaches the browser.
//
// Why this route exists: an already-confirmed Kit subscriber who signs up
// again from a new device (no localStorage flag set there yet) gets no new
// confirmation email — Kit doesn't re-send one to someone already
// confirmed — so without this check they'd be stuck on "check your email"
// forever with no way in. The client calls this first on submit and skips
// straight to granting access when it comes back confirmed.
//
// Fails safe on every error path (missing secret, bad request body, Kit API
// error, network failure) by returning { confirmed: false } with a 200 —
// never a hard failure — so the existing "submit to Kit, check your email"
// flow on the site always still works as the fallback.

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/check-subscriber') {
      return checkSubscriber(request, env);
    }

    // Everything else: serve the static site exactly as before.
    return env.ASSETS.fetch(request);
  }
};

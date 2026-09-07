// Cloudflare Pages Function — POST /api/check-subscriber
//
// Server-side only: looks up whether a submitted email address is already a
// CONFIRMED (state === "active") Kit subscriber, using the Kit API secret
// stored as a Cloudflare Pages environment variable (KIT_API_SECRET). The
// secret never reaches the browser — this function is the only thing that
// ever sends it anywhere.
//
// Why this exists: an already-confirmed Kit subscriber who signs up again
// from a new device gets no new confirmation email (Kit doesn't re-send one
// to someone already confirmed), so without this check they'd be stuck on
// "check your email" forever with no way in. This lets the client skip that
// step and grant access immediately when the lookup says they're already
// confirmed.
//
// Fails safe on every error path (missing secret, Kit API error, network
// failure, bad request body) by returning { confirmed: false } with a 200 —
// never a hard failure — so the existing "submit to Kit, check your email"
// flow always still works as the fallback, exactly as it did before this
// endpoint existed.

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

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

// Cloudflare routes POST to onRequestPost above directly; this only ever
// runs for any other method, since onRequestPost is more specific.
export async function onRequest() {
  return new Response('Method not allowed', { status: 405 });
}

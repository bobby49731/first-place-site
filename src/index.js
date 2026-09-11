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
//   POST /api/send-invite — sends a real friend-invite email via Resend
//   (RESEND_API_KEY), for the game's 5 direct-contact Connection squares
//   (4, 16, 22, 33, 38 — see EMAIL_INVITE_SQUARES in game.html). Subject
//   and body are looked up server-side by square number, never taken from
//   the client, so a tampered request can't be used to send arbitrary
//   email content through our verified domain. Unlike check-subscriber,
//   this one does NOT fail safe — the client only advances the player's
//   token once this genuinely reports { success: true }, so a real
//   failure (bad key, Resend error, network issue) has to come back as an
//   honest failure for the "on successful send" game rule to mean
//   anything.

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const SITE_URL = 'https://watchfirstplace.com';
const INVITE_FROM = 'First Place <invites@watchfirstplace.com>';
const RESEND_API_URL = 'https://api.resend.com/emails';

// One entry per email-invite square: how many recipient fields the client
// shows, and the subject/body actually sent (server-authoritative).
const INVITE_TEMPLATES = {
  4: {
    count: 3,
    subject: 'Come play First Place with me!',
    text: "Hey! I've been playing First Place — a quick board game about " +
      "moving out and (barely) making it on your own. Thought you'd get a " +
      'kick out of it.\n\nCheck it out: ' + SITE_URL,
    html: '<p>Hey! I&rsquo;ve been playing <strong>First Place</strong> &mdash; a quick ' +
      'board game about moving out and (barely) making it on your own. ' +
      'Thought you&rsquo;d get a kick out of it.</p>' +
      '<p><a href="' + SITE_URL + '">' + SITE_URL + '</a></p>'
  },
  16: {
    count: 1,
    subject: 'Pick your character in First Place',
    text: "I'm playing First Place and thought of you — come pick your " +
      'character and play along.\n\n' + SITE_URL,
    html: '<p>I&rsquo;m playing <strong>First Place</strong> and thought of you &mdash; ' +
      'come pick your character and play along.</p>' +
      '<p><a href="' + SITE_URL + '">' + SITE_URL + '</a></p>'
  },
  22: {
    count: 1,
    subject: "You'd love this show",
    text: "Tagging you because I think you'd genuinely love First Place. " +
      'Take a look:\n\n' + SITE_URL,
    html: '<p>Tagging you because I think you&rsquo;d genuinely love <strong>First ' +
      'Place</strong>. Take a look:</p>' +
      '<p><a href="' + SITE_URL + '">' + SITE_URL + '</a></p>'
  },
  33: {
    count: 1,
    subject: 'A show recommendation for you',
    text: 'Wanted to pass this along — I think you’d like First Place. ' +
      'Worth a look:\n\n' + SITE_URL,
    html: '<p>Wanted to pass this along &mdash; I think you&rsquo;d like <strong>First ' +
      'Place</strong>. Worth a look:</p>' +
      '<p><a href="' + SITE_URL + '">' + SITE_URL + '</a></p>'
  },
  38: {
    count: 1,
    subject: "Guess what I'm doing",
    text: "Guess what I'm doing... playing First Place. Come see what it's " +
      'about:\n\n' + SITE_URL,
    html: '<p>Guess what I&rsquo;m doing&hellip; playing <strong>First Place</strong>. Come ' +
      'see what it&rsquo;s about:</p>' +
      '<p><a href="' + SITE_URL + '">' + SITE_URL + '</a></p>'
  }
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

async function sendInvite(request, env) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let square, emails;
  try {
    const body = await request.json();
    square = parseInt(body.square, 10);
    emails = Array.isArray(body.emails) ? body.emails : [];
  } catch (err) {
    return jsonResponse({ success: false, error: 'Invalid request body' }, 400);
  }

  const template = INVITE_TEMPLATES[square];
  if (!template) {
    return jsonResponse({ success: false, error: 'Unknown square' }, 400);
  }
  if (emails.length !== template.count) {
    return jsonResponse({ success: false, error: 'Wrong number of email addresses' }, 400);
  }

  const cleaned = emails.map(function (e) {
    return typeof e === 'string' ? e.trim().toLowerCase() : '';
  });
  const allValid = cleaned.every(function (e) { return EMAIL_PATTERN.test(e); });
  if (!allValid) {
    return jsonResponse({ success: false, error: 'Invalid email address' }, 400);
  }

  if (!env.RESEND_API_KEY) {
    // Unlike check-subscriber, this genuinely can't succeed without the
    // key — say so honestly rather than pretending it worked.
    return jsonResponse({ success: false, error: 'Email sending is not configured' }, 500);
  }

  try {
    const results = await Promise.all(
      cleaned.map(function (to) { return sendOneInvite(env, to, template); })
    );
    const allSent = results.every(function (ok) { return ok; });
    if (!allSent) {
      return jsonResponse({ success: false, error: 'One or more emails failed to send' }, 502);
    }
    return jsonResponse({ success: true });
  } catch (err) {
    return jsonResponse({ success: false, error: 'Email sending failed' }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/check-subscriber') {
      return checkSubscriber(request, env);
    }

    if (url.pathname === '/api/send-invite') {
      return sendInvite(request, env);
    }

    // Everything else: serve the static site exactly as before.
    return env.ASSETS.fetch(request);
  }
};

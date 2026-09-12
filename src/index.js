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
//   (RESEND_API_KEY), for the game's 3 single-contact "party" Connection
//   squares (22, 33, 38 — see EMAIL_INVITE_SQUARES in game.html). The
//   invite is framed around whichever character is currently being
//   played throwing a party to celebrate their own dream — so
//   subject/body are looked up server-side by the submitted character,
//   never taken as free-form text from the client, so a tampered
//   request can't be used to send arbitrary email content through our
//   verified domain. Unlike check-subscriber, this one does NOT fail
//   safe — the client only advances the player's token once this
//   genuinely reports { success: true }, so a real failure (bad key,
//   Resend error, network issue) has to come back as an honest failure
//   for the "on successful send" game rule to mean anything.
//
//   POST /api/submit-contacts — the 3-contact version, for Squares 16,
//   27, and 43 (see MULTI_CONTACT_SQUARES in game.html). Each of up to
//   3 submitted contacts needs a name plus either a valid email or a
//   phone number to "count." Anyone with a valid email gets the same
//   kind of real Resend send as /api/send-invite (server-side template,
//   Square 27's keyed by character same as the party squares); anyone
//   with a phone number has it written to the GAME_CONTACTS KV
//   namespace for future SMS use — captured only, no message sent yet.
//   Responds { success, advanced }: success is whether the request
//   itself was handled without error; advanced is whether at least one
//   contact counted, which is what the client actually uses to decide
//   whether the player's token moves — skipping, or submitting nothing
//   that counts, both come back as { success: true, advanced: false },
//   since neither is an error, just nothing to advance for.

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const SITE_URL = 'https://watchfirstplace.com';
// Sent as "the First Place team," not the individual player — same
// identity as Kit's confirmation email — since the player's own name
// isn't captured anywhere in this flow.
const INVITE_FROM = 'The First Place Team <invites@watchfirstplace.com>';
const RESEND_API_URL = 'https://api.resend.com/emails';

// How many recipient fields the client shows for each party square —
// all 3 are single-recipient.
const EMAIL_INVITE_SQUARES = { 22: 1, 33: 1, 38: 1 };

// One entry per character: the friend-facing party invite, addressed to
// the invitee rather than the player ("you're invited" rather than
// "invite someone"), each referencing that character's own dream.
const PARTY_TEMPLATES = {
  fran: {
    subject: "You're invited to the party!",
    text: "Fran's throwing a party to celebrate her dream — recording a " +
      "bubblegum rap album, music video included. You're invited to " +
      'help her get there.\n\nCome join in: ' + SITE_URL,
    html: '<p>Fran&rsquo;s throwing a party to celebrate her dream &mdash; ' +
      'recording a bubblegum rap album, music video included. ' +
      'You&rsquo;re invited to help her get there.</p>' +
      '<p><a href="' + SITE_URL + '">' + SITE_URL + '</a></p>'
  },
  jeremy: {
    subject: "You're invited to the party!",
    text: "Jeremy's throwing a party to celebrate his dream — a ride-along " +
      "with the cops of Cops. You're invited to help him get there." +
      '\n\nCome join in: ' + SITE_URL,
    html: '<p>Jeremy&rsquo;s throwing a party to celebrate his dream &mdash; a ' +
      'ride-along with the cops of Cops. You&rsquo;re invited to help him ' +
      'get there.</p>' +
      '<p><a href="' + SITE_URL + '">' + SITE_URL + '</a></p>'
  },
  will: {
    subject: "You're invited to the party!",
    text: "Will's throwing a party to celebrate his dream — writing " +
      "alongside the Star Wars universe, even the fan fiction legends. " +
      "You're invited to help him get there.\n\nCome join in: " + SITE_URL,
    html: '<p>Will&rsquo;s throwing a party to celebrate his dream &mdash; writing ' +
      'alongside the Star Wars universe, even the fan fiction legends. ' +
      'You&rsquo;re invited to help him get there.</p>' +
      '<p><a href="' + SITE_URL + '">' + SITE_URL + '</a></p>'
  },
  martha: {
    subject: "You're invited to the party!",
    text: "Martha's throwing a party to celebrate her dream — a speaking " +
      "tour across the US. You're invited to help her get there.\n\n" +
      'Come join in: ' + SITE_URL,
    html: '<p>Martha&rsquo;s throwing a party to celebrate her dream &mdash; a ' +
      'speaking tour across the US. You&rsquo;re invited to help her get ' +
      'there.</p>' +
      '<p><a href="' + SITE_URL + '">' + SITE_URL + '</a></p>'
  }
};

// How many contact slots the client shows for each 3-contact square —
// all 3 are the same shape (name/email/phone).
const MULTI_CONTACT_SQUARES = { 16: 3, 27: 3, 43: 3 };

// Squares 16 and 43 use the same email content regardless of character.
const CONTACT_TEMPLATES = {
  16: {
    subject: 'Come pick your character!',
    text: "I'm playing First Place and thought you should come pick a " +
      'character and join in.\n\nCheck it out: ' + SITE_URL,
    html: '<p>I&rsquo;m playing <strong>First Place</strong> and thought you should ' +
      'come pick a character and join in.</p>' +
      '<p><a href="' + SITE_URL + '">' + SITE_URL + '</a></p>'
  },
  43: {
    subject: "Thought you'd like this",
    text: "Sharing First Place with you again — thought you'd like this." +
      '\n\nCheck it out: ' + SITE_URL,
    html: '<p>Sharing <strong>First Place</strong> with you again &mdash; thought ' +
      'you&rsquo;d like this.</p>' +
      '<p><a href="' + SITE_URL + '">' + SITE_URL + '</a></p>'
  }
};

// Square 27 is keyed by character, same "5-star boost" framing shown
// on the card, reworded for the invitee rather than the player.
const BOOST_TEMPLATES = {
  fran: {
    subject: 'A 5-star boost would help',
    text: "Fran's journey on First Place is halfway there — a 5-star " +
      'boost from you would mean a lot.\n\nCheck it out: ' + SITE_URL,
    html: '<p>Fran&rsquo;s journey on <strong>First Place</strong> is halfway there ' +
      '&mdash; a 5-star boost from you would mean a lot.</p>' +
      '<p><a href="' + SITE_URL + '">' + SITE_URL + '</a></p>'
  },
  jeremy: {
    subject: 'A 5-star boost would help',
    text: "Jeremy's journey on First Place is halfway there — a 5-star " +
      'boost from you would mean a lot.\n\nCheck it out: ' + SITE_URL,
    html: '<p>Jeremy&rsquo;s journey on <strong>First Place</strong> is halfway there ' +
      '&mdash; a 5-star boost from you would mean a lot.</p>' +
      '<p><a href="' + SITE_URL + '">' + SITE_URL + '</a></p>'
  },
  will: {
    subject: 'A 5-star boost would help',
    text: "Will's journey on First Place is halfway there — a 5-star " +
      'boost from you would mean a lot.\n\nCheck it out: ' + SITE_URL,
    html: '<p>Will&rsquo;s journey on <strong>First Place</strong> is halfway there ' +
      '&mdash; a 5-star boost from you would mean a lot.</p>' +
      '<p><a href="' + SITE_URL + '">' + SITE_URL + '</a></p>'
  },
  martha: {
    subject: 'A 5-star boost would help',
    text: "Martha's journey on First Place is halfway there — a 5-star " +
      'boost from you would mean a lot.\n\nCheck it out: ' + SITE_URL,
    html: '<p>Martha&rsquo;s journey on <strong>First Place</strong> is halfway there ' +
      '&mdash; a 5-star boost from you would mean a lot.</p>' +
      '<p><a href="' + SITE_URL + '">' + SITE_URL + '</a></p>'
  }
};

function templateForMultiContactSquare(square, character) {
  if (square === 27) return BOOST_TEMPLATES[character] || null;
  return CONTACT_TEMPLATES[square] || null;
}

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

  let square, emails, character;
  try {
    const body = await request.json();
    square = parseInt(body.square, 10);
    emails = Array.isArray(body.emails) ? body.emails : [];
    character = typeof body.character === 'string' ? body.character.trim().toLowerCase() : '';
  } catch (err) {
    return jsonResponse({ success: false, error: 'Invalid request body' }, 400);
  }

  const expectedCount = EMAIL_INVITE_SQUARES[square];
  if (!expectedCount) {
    return jsonResponse({ success: false, error: 'Unknown square' }, 400);
  }
  const template = PARTY_TEMPLATES[character];
  if (!template) {
    return jsonResponse({ success: false, error: 'Unknown character' }, 400);
  }
  if (emails.length !== expectedCount) {
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

async function submitContacts(request, env) {
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

  const expectedCount = MULTI_CONTACT_SQUARES[square];
  if (!expectedCount) {
    return jsonResponse({ success: false, error: 'Unknown square' }, 400);
  }
  if (contacts.length !== expectedCount) {
    return jsonResponse({ success: false, error: 'Wrong number of contacts' }, 400);
  }

  const template = templateForMultiContactSquare(square, character);
  if (!template) {
    return jsonResponse({ success: false, error: 'Unknown character' }, 400);
  }

  const cleaned = contacts.map(function (c) {
    c = c && typeof c === 'object' ? c : {};
    return {
      name: typeof c.name === 'string' ? c.name.trim() : '',
      email: typeof c.email === 'string' ? c.email.trim().toLowerCase() : '',
      phone: typeof c.phone === 'string' ? c.phone.trim() : ''
    };
  });

  // A contact "counts" with a name plus either a valid email or a
  // phone number — matching what the card itself asks for.
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
      return jsonResponse({ success: false, error: 'Email sending is not configured' }, 500);
    }
    try {
      const results = await Promise.all(
        toEmail.map(function (c) { return sendOneInvite(env, c.email, template); })
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/check-subscriber') {
      return checkSubscriber(request, env);
    }

    if (url.pathname === '/api/send-invite') {
      return sendInvite(request, env);
    }

    if (url.pathname === '/api/submit-contacts') {
      return submitContacts(request, env);
    }

    // Everything else: serve the static site exactly as before.
    return env.ASSETS.fetch(request);
  }
};

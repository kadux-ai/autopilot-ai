import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface SlackEvent {
  type: string;
  user?: string;
  text?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
}

interface SlackPayload {
  type: string;
  challenge?: string;
  event?: SlackEvent;
  team_id?: string;
}

async function createGHLContact(ghlApiKey: string, ghlLocationId: string, data: {
  name?: string;
  email?: string;
  phone?: string;
  source?: string;
  customFields?: Record<string, string>;
}) {
  const res = await fetch('https://rest.gohighlevel.com/v1/contacts/', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ghlApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      locationId: ghlLocationId,
      ...data,
    }),
  });
  return res.json();
}

async function addGHLNote(ghlApiKey: string, contactId: string, body: string) {
  const res = await fetch(`https://rest.gohighlevel.com/v1/contacts/${contactId}/notes/`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ghlApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ body }),
  });
  return res.json();
}

async function searchGHLContact(ghlApiKey: string, ghlLocationId: string, query: string) {
  const params = new URLSearchParams({ locationId: ghlLocationId, query });
  const res = await fetch(`https://rest.gohighlevel.com/v1/contacts/search?${params}`, {
    headers: { 'Authorization': `Bearer ${ghlApiKey}` },
  });
  return res.json();
}

// Extract email/phone from Slack message text
function extractContactInfo(text: string) {
  const emailMatch = text.match(/[\w.-]+@[\w.-]+\.\w+/);
  const phoneMatch = text.match(/[\+]?[(]?[0-9]{3}[)]?[-\s\.]?[0-9]{3}[-\s\.]?[0-9]{4,6}/);
  return {
    email: emailMatch?.[0],
    phone: phoneMatch?.[0],
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const ghlApiKey = Deno.env.get('GHL_API_KEY');
    const ghlLocationId = Deno.env.get('GHL_LOCATION_ID');
    const slackSigningSecret = Deno.env.get('SLACK_SIGNING_SECRET');

    if (!ghlApiKey || !ghlLocationId) {
      return new Response(
        JSON.stringify({ error: 'GHL_API_KEY and GHL_LOCATION_ID env vars are required' }),
        { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } }
      );
    }

    const body = await req.text();
    let payload: SlackPayload;

    try {
      payload = JSON.parse(body);
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    // Handle Slack URL verification challenge
    if (payload.type === 'url_verification') {
      return new Response(JSON.stringify({ challenge: payload.challenge }), {
        headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    // Handle Slack event callbacks
    if (payload.type === 'event_callback' && payload.event) {
      const event = payload.event;

      // Skip bot messages
      if (event.bot_id) {
        return new Response(JSON.stringify({ ok: true, skipped: 'bot_message' }), {
          headers: { ...cors, 'Content-Type': 'application/json' }
        });
      }

      if (event.type === 'message' && event.text) {
        const text = event.text;
        const { email, phone } = extractContactInfo(text);
        const timestamp = event.ts ? new Date(parseFloat(event.ts) * 1000).toISOString() : new Date().toISOString();
        const noteBody = `[Slack #${event.channel || 'unknown'} @ ${timestamp}]\n${text}`;

        if (email || phone) {
          // Try to find existing contact
          const query = email || phone || '';
          const searchResult = await searchGHLContact(ghlApiKey, ghlLocationId, query);
          const existingContact = searchResult?.contacts?.[0];

          if (existingContact) {
            await addGHLNote(ghlApiKey, existingContact.id, noteBody);
            return new Response(JSON.stringify({ ok: true, action: 'note_added', contactId: existingContact.id }), {
              headers: { ...cors, 'Content-Type': 'application/json' }
            });
          } else {
            const newContact = await createGHLContact(ghlApiKey, ghlLocationId, {
              email,
              phone,
              source: 'Slack',
              customFields: { slack_channel: event.channel || '' },
            });
            const contactId = newContact?.contact?.id;
            if (contactId) {
              await addGHLNote(ghlApiKey, contactId, noteBody);
            }
            return new Response(JSON.stringify({ ok: true, action: 'contact_created', contactId }), {
              headers: { ...cors, 'Content-Type': 'application/json' }
            });
          }
        } else {
          // No contact info in message — log as general note on a catch-all or just acknowledge
          return new Response(JSON.stringify({ ok: true, action: 'no_contact_info', message: 'No email or phone found in message' }), {
            headers: { ...cors, 'Content-Type': 'application/json' }
          });
        }
      }
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...cors, 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }
});

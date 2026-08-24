const ENDPOINTS = {
  staging: 'https://admin-api.aircall-staging.com/graphql',
  prod: 'https://admin-api.aircall.io/graphql',
};

// Only conversations whose agent belongs to this company can be fetched.
const ALLOWED_COMPANY_ID = '300028';
const ENV_NAME = 'prod';

const GET_CONVERSATION = `
  query GetConversation($id: ID!) {
    getConversation(id: $id) {
      id callId phoneNumber agentId createdAt updatedAt status
      messages { id createdAt role content }
    }
  }
`;

// Lets callers paste either the AIVA conversation ID or the Twilio call ID
// (e.g. from their own call logs) into the same field.
const GET_CONVERSATION_BY_CALL_ID = `
  query GetConversationByCallId($callId: ID!) {
    getConversationByCallId(callId: $callId) {
      items {
        id callId phoneNumber agentId createdAt updatedAt status
        messages { id createdAt role content }
      }
    }
  }
`;

const GET_AGENT = `
  query GetVirtualAgent($companyId: ID!, $virtualAgentId: ID!) {
    getVirtualAgent(companyId: $companyId, virtualAgentId: $virtualAgentId) { id companyId }
  }
`;

const GET_AUDIT_LOGS = `
  query getConversationAuditLogs($conversationId: ID!, $input: ConversationAuditLogsInput) {
    getConversationAuditLogs(conversationId: $conversationId, input: $input) {
      items { id conversationId createdAt event log }
      lastEvaluatedKey
    }
  }
`;

// Audit log stream includes a lot of low-level pipeline noise (state
// transitions, TTS/audio events, etc). Only these two events carry the
// tool-call name/arguments/result the client actually wants to see.
const TOOL_EVENTS = new Set(['function_call_received', 'function_call_response_sent']);
const MAX_AUDIT_PAGES = 10;

function tryParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

async function fetchAllToolCallEvents(conversationId, token) {
  const events = [];
  let lastEvaluatedKey = null;

  for (let page = 0; page < MAX_AUDIT_PAGES; page++) {
    const input = { limit: 200 };
    if (lastEvaluatedKey) input.lastEvaluatedKey = lastEvaluatedKey;

    const data = await gql(GET_AUDIT_LOGS, { conversationId, input }, token);
    const result = data.getConversationAuditLogs;

    for (const item of result.items) {
      if (TOOL_EVENTS.has(item.event)) events.push(item);
    }

    lastEvaluatedKey = result.lastEvaluatedKey;
    if (!lastEvaluatedKey) break;
  }

  return events;
}

function pairToolCalls(events) {
  const byId = new Map();

  for (const item of events) {
    const log = tryParse(item.log);

    if (item.event === 'function_call_received') {
      for (const fn of log.functions || []) {
        // Events arrive newest-first, so the response for this call may
        // already have been processed — merge rather than overwrite.
        const existing = byId.get(fn.id) || {};
        byId.set(fn.id, {
          ...existing,
          id: fn.id,
          name: fn.name,
          arguments: tryParse(fn.arguments),
          requestedAt: item.createdAt,
        });
      }
    } else if (item.event === 'function_call_response_sent') {
      const existing = byId.get(log.id) || { id: log.id, name: log.name };
      byId.set(log.id, {
        ...existing,
        name: existing.name || log.name,
        outcome: log.outcome,
        result: tryParse(log.content),
        respondedAt: item.createdAt,
      });
    }
  }

  return [...byId.values()];
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Access-Code',
  };
}

function jsonResponse(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

async function getValidToken(env) {
  const raw = await env.TOKENS.get(ENV_NAME);
  if (!raw) {
    throw new Error('No cached token in KV. Seed it with `wrangler kv key put`.');
  }
  let data = JSON.parse(raw);

  const isExpired = Date.now() >= data.expires_at - 60_000;
  if (isExpired) {
    const resp = await fetch(`https://${data.domain}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: data.client_id,
        refresh_token: data.refresh_token,
      }).toString(),
    });
    if (!resp.ok) {
      throw new Error(`Token refresh failed: ${await resp.text()}`);
    }
    const tokens = await resp.json();
    data = {
      ...data,
      id_token: tokens.id_token,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || data.refresh_token,
      expires_at: Date.now() + tokens.expires_in * 1000,
    };
    await env.TOKENS.put(ENV_NAME, JSON.stringify(data));
  }

  // staging uses id_token, prod uses access_token (mirrors get-admin-portal-token.mjs)
  return data.env === 'prod' ? data.access_token : data.id_token;
}

async function resolveConversation(idOrCallId, token) {
  try {
    const byId = await gql(GET_CONVERSATION, { id: idOrCallId }, token);
    if (byId.getConversation) return byId.getConversation;
  } catch {
    // Not a valid conversation ID (e.g. a Twilio call ID was passed instead) — fall through.
  }

  const byCallId = await gql(GET_CONVERSATION_BY_CALL_ID, { callId: idOrCallId }, token);
  return byCallId.getConversationByCallId.items[0] || null;
}

async function gql(query, variables, token) {
  const resp = await fetch(ENDPOINTS[ENV_NAME], {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const result = await resp.json();
  if (result.errors) {
    throw new Error(result.errors.map((e) => e.message).join('; '));
  }
  return result.data;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '*';

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);

    const providedCode = request.headers.get('X-Access-Code') || url.searchParams.get('code');
    if (!env.ACCESS_CODE || providedCode !== env.ACCESS_CODE) {
      return jsonResponse({ error: 'Unauthorized' }, 401, origin);
    }

    const conversationId = url.searchParams.get('conversationId');
    if (!conversationId) {
      return jsonResponse({ error: 'Missing conversationId query param' }, 400, origin);
    }

    try {
      const token = await getValidToken(env);

      const conversation = await resolveConversation(conversationId, token);
      if (!conversation) {
        return jsonResponse({ error: 'Conversation not found' }, 404, origin);
      }

      const agentData = await gql(
        GET_AGENT,
        { companyId: ALLOWED_COMPANY_ID, virtualAgentId: conversation.agentId },
        token
      );
      if (!agentData.getVirtualAgent) {
        return jsonResponse({ error: 'Conversation is outside the allowed company scope' }, 403, origin);
      }

      // Only keep actual conversation turns: drop the system prompt and the
      // raw "tool" role stub message (its content is superseded by the
      // richer paired tool-call data below).
      const messages = conversation.messages.filter((m) => m.role === 'user' || m.role === 'assistant');

      const toolEvents = await fetchAllToolCallEvents(conversation.id, token);
      const toolCalls = pairToolCalls(toolEvents);

      return jsonResponse(
        {
          conversation: { ...conversation, messages },
          toolCalls,
        },
        200,
        origin
      );
    } catch (err) {
      return jsonResponse({ error: err.message }, 500, origin);
    }
  },
};

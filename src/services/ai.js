const config = require('../config');

/*
 * Provider-agnostic AI helper. Supports OpenRouter (has free models), Cohere (free trial key)
 * and Anthropic. Every feature falls back to a deterministic template if no key is configured
 * or the call fails, so the API never breaks because of the AI layer.
 */

const TIMEOUT_MS = 20000;

const SYSTEM = `You help people write clear task descriptions for a team task tracker.
Reply ONLY with JSON: {"title": string, "description": string, "checklist": string[]}.
- title: max 80 chars, imperative.
- description: 2-4 sentences covering goal and expected outcome.
- checklist: 3-6 short actionable subtasks.`;

/** Which provider is active, or null when none is configured. */
function activeProvider() {
  const { ai } = config;
  const keys = { openrouter: ai.openrouterKey, cohere: ai.cohereKey, anthropic: ai.anthropicKey };
  if (ai.provider) return keys[ai.provider] ? ai.provider : null;
  return Object.keys(keys).find((p) => keys[p]) || null;
}

async function post(url, headers, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`AI provider returned HTTP ${res.status} ${detail}`.trim());
  }
  return res.json();
}

/** Send a system + user prompt to the active provider and return the reply text. */
async function complete(provider, system, user, maxTokens) {
  const { ai } = config;
  if (provider === 'openrouter') {
    // OPENROUTER_MODEL may be a comma-separated list; free models come and go, so try each in turn.
    const models = ai.openrouterModel.split(',').map((m) => m.trim()).filter(Boolean);
    let lastErr;
    for (const model of models) {
      try {
        const data = await post(
          'https://openrouter.ai/api/v1/chat/completions',
          { Authorization: `Bearer ${ai.openrouterKey}` },
          { model, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }
        );
        return data.choices[0].message.content;
      } catch (err) {
        lastErr = new Error(`${model}: ${err.message}`);
        console.warn('OpenRouter model failed:', lastErr.message);
      }
    }
    throw lastErr;
  }
  if (provider === 'cohere') {
    const data = await post(
      'https://api.cohere.com/v2/chat',
      { Authorization: `Bearer ${ai.cohereKey}` },
      { model: ai.cohereModel, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }
    );
    return data.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  }
  if (provider === 'anthropic') {
    const data = await post(
      'https://api.anthropic.com/v1/messages',
      { 'x-api-key': ai.anthropicKey, 'anthropic-version': '2023-06-01' },
      { model: ai.anthropicModel, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }
    );
    return data.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  }
  throw new Error(`Unknown AI provider: ${provider}`);
}

/** Models sometimes wrap JSON in prose or code fences; pull out the first {...} block. */
function parseJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('No JSON in AI reply');
  return JSON.parse(text.slice(start, end + 1));
}

/** Deterministic fallback so the feature (and tests) work without any API key. */
function fallbackDescription(prompt) {
  const clean = prompt.trim().replace(/\s+/g, ' ');
  return {
    title: clean.charAt(0).toUpperCase() + clean.slice(1, 80),
    description: `Goal: ${clean}. Define the scope, complete the work, and confirm the outcome with the team before closing this task.`,
    checklist: ['Clarify requirements', 'Break the work into steps', 'Implement', 'Review with the team', 'Mark as completed'],
    source: 'template',
  };
}

/** Generate a title, description and checklist from a short free-text prompt. */
async function generateTaskDescription(prompt) {
  const provider = activeProvider();
  if (!provider) return fallbackDescription(prompt);
  try {
    const out = parseJson(await complete(provider, SYSTEM, `Task idea: ${prompt}`, 600));
    if (!out.title || !out.description) throw new Error('Incomplete AI reply');
    return {
      title: String(out.title).slice(0, 200),
      description: String(out.description),
      checklist: Array.isArray(out.checklist) ? out.checklist.map(String) : [],
      source: 'ai',
      provider,
    };
  } catch (err) {
    console.warn(`AI generation failed (${provider}), using template:`, err.message);
    return fallbackDescription(prompt);
  }
}

/** Summarise a task and its comment thread. */
async function summarizeTask(task, comments) {
  const provider = activeProvider();
  if (provider) {
    try {
      const thread = comments.map((c) => `${c.user_name}: ${c.body}`).join('\n');
      const summary = await complete(
        provider,
        'Summarise this task and its discussion in 3 concise sentences. Plain text only.',
        `Title: ${task.title}\nStatus: ${task.status}\nDescription: ${task.description || '-'}\nComments:\n${thread || '-'}`,
        400
      );
      return { summary: summary.trim(), source: 'ai', provider };
    } catch (err) {
      console.warn(`AI summary failed (${provider}), using template:`, err.message);
    }
  }
  return {
    summary: `"${task.title}" is ${task.status.replace('_', ' ')} with ${comments.length} comment(s).${task.due_date ? ` Due ${task.due_date.slice(0, 10)}.` : ''}`,
    source: 'template',
  };
}

module.exports = { generateTaskDescription, summarizeTask, activeProvider };

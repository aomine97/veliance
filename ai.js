// ai.js — provider calls run in the main process (keys never touch the renderer)
const store = require('./store');

const ANTHROPIC_URL = process.env.VELIANCE_ANTHROPIC_URL || 'https://api.anthropic.com/v1/messages';
const OPENAI_CHAT_URL = process.env.VELIANCE_OPENAI_URL || 'https://api.openai.com/v1/chat/completions';
const OPENAI_TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';

// Shown in the model picker when the provider's live model list can't be fetched (no key / offline)
const FALLBACK_MODELS = {
  anthropic: [
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
    { id: 'claude-fable-5-1', name: 'Claude Fable 5.1' }
  ],
  openai: [
    { id: 'gpt-5', name: 'GPT-5' },
    { id: 'gpt-5-mini', name: 'GPT-5 mini' },
    { id: 'gpt-4.1', name: 'GPT-4.1' },
    { id: 'gpt-4o', name: 'GPT-4o' },
    { id: 'gpt-4o-mini', name: 'GPT-4o mini' }
  ]
};

/**
 * Stream a chat completion.
 * @param {object} opts
 * @param {Array<{role:'user'|'assistant', text:string, imageBase64?:string}>} opts.messages
 * @param {(delta:string)=>void} opts.onDelta
 * @param {AbortSignal} opts.signal
 * @returns {Promise<string>} full text
 */
async function stream({ messages, onDelta, signal }) {
  const provider = store.get('provider');
  const system = store.get('systemPrompt');
  if (provider === 'openai') return streamOpenAI({ messages, system, onDelta, signal });
  return streamAnthropic({ messages, system, onDelta, signal });
}

function requireKey(name) {
  const k = store.getKey(name);
  if (!k) {
    const label = name === 'anthropic' ? 'Anthropic' : 'OpenAI';
    const err = new Error(`No ${label} API key set. Open Settings (⚙) and paste one.`);
    err.code = 'NO_KEY';
    throw err;
  }
  return k;
}

async function readSSE(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try { onEvent(JSON.parse(data)); } catch { /* ignore keepalives */ }
      }
    }
  }
}

async function throwHttp(res, provider) {
  let detail = '';
  try {
    const j = await res.json();
    detail = j?.error?.message || JSON.stringify(j);
  } catch {
    detail = await res.text().catch(() => '');
  }
  const err = new Error(`${provider} ${res.status}: ${detail || res.statusText}`);
  err.status = res.status;
  throw err;
}

async function streamAnthropic({ messages, system, onDelta, signal }) {
  const key = requireKey('anthropic');
  const model = store.get('anthropicModel');

  const body = {
    model,
    max_tokens: 8000,             // newer Claude models think first; leave room for the answer
    stream: true,
    system,
    messages: messages.map(m => {
      const content = [];
      if (m.imageBase64) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: m.imageBase64 }
        });
      }
      content.push({ type: 'text', text: m.text || (m.imageBase64 ? 'What is on my screen? If there is a question or problem visible, answer it.' : '') });
      return { role: m.role, content };
    })
  };

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) await throwHttp(res, 'Anthropic');

  let full = '';
  await readSSE(res, ev => {
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      full += ev.delta.text;
      onDelta(ev.delta.text);
    } else if (ev.type === 'error') {
      throw new Error(ev.error?.message || 'Anthropic stream error');
    }
  });
  return full;
}

async function streamOpenAI({ messages, system, onDelta, signal }) {
  const key = requireKey('openai');
  const model = store.get('openaiModel');

  const body = {
    model,
    stream: true,
    messages: [
      { role: 'system', content: system },
      ...messages.map(m => {
        if (!m.imageBase64) return { role: m.role, content: m.text };
        return {
          role: m.role,
          content: [
            { type: 'text', text: m.text || 'What is on my screen? If there is a question or problem visible, answer it.' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${m.imageBase64}`, detail: 'high' } }
          ]
        };
      })
    ]
  };

  const res = await fetch(OPENAI_CHAT_URL, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body)
  });
  if (!res.ok) await throwHttp(res, 'OpenAI');

  let full = '';
  await readSSE(res, ev => {
    const delta = ev.choices?.[0]?.delta?.content;
    if (delta) { full += delta; onDelta(delta); }
  });
  return full;
}

/**
 * Transcribe an audio chunk (webm/opus) with OpenAI.
 * @param {Buffer} audio
 * @param {string} mime
 * @returns {Promise<string>}
 */
async function transcribe(audio, mime = 'audio/webm') {
  const key = requireKey('openai');
  const model = store.get('transcribeModel') || 'whisper-1';
  const form = new FormData();
  form.append('file', new Blob([audio], { type: mime }), 'chunk.webm');
  form.append('model', model);
  form.append('response_format', 'json');
  // Light prompt helps Whisper keep going instead of hallucinating on silence
  form.append('prompt', 'Transcript of a live conversation or meeting.');

  const res = await fetch(OPENAI_TRANSCRIBE_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}` },
    body: form
  });
  if (!res.ok) await throwHttp(res, 'OpenAI transcription');
  const j = await res.json();
  return (j.text || '').trim();
}

/** Cheap connectivity check for the settings panel. */
async function testKey(provider) {
  if (provider === 'anthropic') {
    const key = requireKey('anthropic');
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: store.get('anthropicModel'), max_tokens: 5, messages: [{ role: 'user', content: 'ping' }] })
    });
    if (!res.ok) await throwHttp(res, 'Anthropic');
    return true;
  }
  const key = requireKey('openai');
  const res = await fetch('https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${key}` } });
  if (!res.ok) await throwHttp(res, 'OpenAI');
  return true;
}

async function fetchAnthropicModels() {
  const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
    headers: { 'x-api-key': requireKey('anthropic'), 'anthropic-version': '2023-06-01' }
  });
  if (!res.ok) await throwHttp(res, 'Anthropic');
  const j = await res.json();
  return (j.data || []).map(m => ({ id: m.id, name: m.display_name || m.id }));
}

// /v1/models also lists embeddings, audio, image and dated snapshots — keep only chat models
const OPENAI_SKIP = /(audio|realtime|tts|transcribe|whisper|search|image|embedding|moderation|instruct|codex|dall-e|davinci|babbage|-\d{4}-\d{2}-\d{2}$|-\d{4}$)/;
async function fetchOpenAIModels() {
  const res = await fetch('https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${requireKey('openai')}` } });
  if (!res.ok) await throwHttp(res, 'OpenAI');
  const j = await res.json();
  return (j.data || [])
    .filter(m => /^(gpt-|o\d|chatgpt-)/.test(m.id) && !OPENAI_SKIP.test(m.id))
    .sort((a, b) => (b.created || 0) - (a.created || 0))
    .map(m => ({ id: m.id, name: m.id }));
}

/** Models for the picker: live from each provider when a key is saved, otherwise the built-in list. */
async function listModels() {
  const live = async (provider, fetcher) => {
    if (!store.hasKey(provider)) return FALLBACK_MODELS[provider];
    try {
      const list = await fetcher();
      return list.length ? list : FALLBACK_MODELS[provider];
    } catch { return FALLBACK_MODELS[provider]; }
  };
  const [anthropic, openai] = await Promise.all([
    live('anthropic', fetchAnthropicModels),
    live('openai', fetchOpenAIModels)
  ]);
  return { anthropic, openai };
}

module.exports = { stream, transcribe, testKey, listModels };

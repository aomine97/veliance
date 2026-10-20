// store.js — tiny JSON config store with encrypted secrets (safeStorage)
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

const FILE = () => path.join(app.getPath('userData'), 'config.json');

const DEFAULTS = {
  provider: 'anthropic',            // 'anthropic' | 'openai'
  anthropicModel: 'claude-opus-5-5',
  openaiModel: 'gpt-4o',
  transcribeModel: 'gpt-4o-mini-transcribe',
  systemPrompt:
    'You are a discreet real-time assistant living in a small desktop overlay. ' +
    'Answer fast, concise, and directly. Lead with the answer, then a short why. ' +
    'When a transcript of a live conversation is provided, answer the most recent question ' +
    'or suggest the best next thing to say. Use short paragraphs and tight bullet lists. No filler.',
  opacity: 0.96,
  position: null,                   // {x,y} remembered between launches
  size: null,                       // {w,h} overlay size (Grow/Shrink hotkeys)
  audioSource: 'system',            // 'system' | 'mic'
  listenChunkSeconds: 6,
  hotkeys: {},                      // action -> accelerator overrides
  keys: {}                          // encrypted blobs, base64
};

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE(), 'utf8')) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function save() {
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify(cache, null, 2));
}

function get(key) {
  return load()[key];
}

function set(patch) {
  load();
  Object.assign(cache, patch);
  save();
  return cache;
}

function canEncrypt() {
  try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
}

function setKey(name, value) {
  load();
  if (!value) {
    delete cache.keys[name];
  } else if (canEncrypt()) {
    cache.keys[name] = 'enc:' + safeStorage.encryptString(value).toString('base64');
  } else {
    cache.keys[name] = 'raw:' + Buffer.from(value, 'utf8').toString('base64');
  }
  save();
}

function getKey(name) {
  const v = load().keys[name];
  if (!v) return '';
  try {
    if (v.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'));
    if (v.startsWith('raw:')) return Buffer.from(v.slice(4), 'base64').toString('utf8');
  } catch { /* fallthrough */ }
  return '';
}

function hasKey(name) {
  return Boolean(load().keys[name]);
}

// Settings safe to hand to the renderer (no secrets, only whether they exist)
function publicSettings() {
  const c = load();
  return {
    provider: c.provider,
    anthropicModel: c.anthropicModel,
    openaiModel: c.openaiModel,
    transcribeModel: c.transcribeModel,
    systemPrompt: c.systemPrompt,
    opacity: c.opacity,
    audioSource: c.audioSource,
    listenChunkSeconds: c.listenChunkSeconds,
    hotkeys: c.hotkeys || {},
    hasAnthropicKey: hasKey('anthropic'),
    hasOpenaiKey: hasKey('openai'),
    encrypted: canEncrypt()
  };
}

module.exports = { get, set, setKey, getKey, hasKey, publicSettings, DEFAULTS };

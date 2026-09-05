// Quant Desk — the Anthropic API key lives ONLY in the macOS keychain (service quant-desk, account
// anthropic). It is read lazily on the first model call, cached in memory, and never logged, stored
// or echoed. Tests swap the reader with _setReader so no test ever touches the real keychain.
const { execFileSync } = require('child_process');

const SERVICE = 'quant-desk';
const ACCOUNT = 'anthropic';
const ADD_KEY_COMMAND = `security add-generic-password -s ${SERVICE} -a ${ACCOUNT} -w`;

class KeyAbsentError extends Error {
  constructor() {
    super('no API key in the keychain');
    this.name = 'KeyAbsentError';
    this.plain = `No API key in the keychain. Add it once in Terminal: ${ADD_KEY_COMMAND}`;
    this.add_key_command = ADD_KEY_COMMAND;
  }
}

function defaultReader() {
  // stderr is dropped on purpose: `security` prints the service name there, never the secret, but
  // nothing from this call should reach a log either way.
  const out = execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  return String(out || '').trim();
}

let _key = null;
let _reader = defaultReader;

// Save the key into the login keychain (creates or updates the item). The value is passed to the
// `security` binary directly and never logged; the in-memory cache is refreshed so the next model
// call uses it without a restart.
function defaultWriter(key) {
  execFileSync('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', ACCOUNT, '-w', key], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}
function defaultRemover() {
  execFileSync('security', ['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}
let _writer = defaultWriter;
let _remover = defaultRemover;

function setApiKey(key) {
  const k = String(key || '').trim();
  if (!k) throw new Error('empty key');
  if (/\s/.test(k)) throw new Error('a key has no spaces; paste it as one piece');
  _writer(k);
  _key = k;
  return true;
}

function removeApiKey() {
  try { _remover(); } catch (_) { /* nothing to delete */ }
  _key = null;
  return true;
}

function getApiKey() {
  if (_key) return _key;
  let k = '';
  try { k = _reader(); } catch (_) { throw new KeyAbsentError(); }
  if (!k) throw new KeyAbsentError();
  _key = k;
  return _key;
}

function hasKey() {
  try { getApiKey(); return true; } catch (_) { return false; }
}

// Forget the cached key (e.g. after the API rejected it) so the next call re-reads the keychain.
function forget() { _key = null; }

// Tests only: replace the keychain reader. Passing null restores the real one.
function _setReader(fn) { _reader = fn || defaultReader; _key = null; }
function _setWriter(fn) { _writer = fn || defaultWriter; }
function _setRemover(fn) { _remover = fn || defaultRemover; }

module.exports = { getApiKey, hasKey, forget, setApiKey, removeApiKey, KeyAbsentError, ADD_KEY_COMMAND, SERVICE, ACCOUNT, _setReader, _setWriter, _setRemover };

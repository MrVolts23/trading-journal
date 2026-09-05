const test = require('node:test');
const assert = require('node:assert/strict');
const keychain = require('../src/model/keychain');

test('setApiKey writes through the keychain writer and caches the key', () => {
  let written = null;
  keychain._setWriter((k) => { written = k; });
  keychain._setReader(() => { throw new Error('should not read'); });
  assert.equal(keychain.setApiKey('  sk-ant-test-123  '), true);
  assert.equal(written, 'sk-ant-test-123');
  assert.equal(keychain.getApiKey(), 'sk-ant-test-123');
  assert.throws(() => keychain.setApiKey('   '), /empty key/);
  assert.throws(() => keychain.setApiKey('two words'), /no spaces/);
  keychain._setRemover(() => {});
  assert.equal(keychain.removeApiKey(), true);
  assert.equal(keychain.hasKey(), false);
  keychain._setWriter(null); keychain._setReader(null); keychain._setRemover(null);
});

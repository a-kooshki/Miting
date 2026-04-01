const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeEncryptedPayload,
  normalizeRoomCode,
  normalizeName,
  byteLengthOfJson
} = require('../server');

test('normalizeRoomCode strips unsafe characters and uppercases', () => {
  assert.equal(normalizeRoomCode(' ab-c_12<script> '), 'AB-C12SCRIPT');
});

test('normalizeName trims values and applies fallback', () => {
  assert.equal(normalizeName('  Ali  ', 'Guest'), 'Ali');
  assert.equal(normalizeName('', 'Guest'), 'Guest');
});

test('normalizeEncryptedPayload accepts a valid encrypted envelope', () => {
  const payload = normalizeEncryptedPayload({
    version: 1,
    algorithm: 'AES-GCM-256',
    iv: 'abc123',
    ciphertext: 'def456'
  });

  assert.deepEqual(payload, {
    version: 1,
    algorithm: 'AES-GCM-256',
    purpose: undefined,
    bucket: undefined,
    iv: 'abc123',
    ciphertext: 'def456'
  });
});

test('normalizeEncryptedPayload keeps optional purpose and bucket', () => {
  const payload = normalizeEncryptedPayload({
    version: 1,
    algorithm: 'AES-GCM-256',
    purpose: 'chat',
    bucket: 100,
    iv: 'abc123',
    ciphertext: 'def456'
  });

  assert.deepEqual(payload, {
    version: 1,
    algorithm: 'AES-GCM-256',
    purpose: 'chat',
    bucket: 100,
    iv: 'abc123',
    ciphertext: 'def456'
  });
});

test('normalizeEncryptedPayload rejects invalid metadata', () => {
  assert.equal(
    normalizeEncryptedPayload({
      version: 2,
      algorithm: 'AES-GCM-256',
      iv: 'abc123',
      ciphertext: 'def456'
    }),
    null
  );

  assert.equal(
    normalizeEncryptedPayload({
      version: 1,
      algorithm: 'PLAINTEXT',
      iv: 'abc123',
      ciphertext: 'def456'
    }),
    null
  );
});

test('byteLengthOfJson returns a positive byte size', () => {
  assert.ok(byteLengthOfJson({ hello: 'world' }) > 0);
});

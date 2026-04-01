const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  requestHandler,
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

test('create room and join works with the same room password', async () => {
  const server = http.createServer(requestHandler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const createResponse = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ownerName: 'Ali',
        roomTitle: `Test Room ${Date.now()}`,
        roomPassword: '123456'
      })
    });

    assert.equal(createResponse.status, 201);
    const created = await createResponse.json();
    const roomCode = created?.room?.code;
    assert.ok(roomCode);
    assert.ok(created?.room?.title);

    const previewResponse = await fetch(`${baseUrl}/api/rooms/preview?roomCode=${encodeURIComponent(roomCode)}`);
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json();
    assert.equal(preview?.room?.code, roomCode);
    assert.equal(preview?.room?.title, created.room.title);

    const joinResponse = await fetch(`${baseUrl}/api/rooms/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        roomCode,
        userName: 'Sara',
        roomPassword: '123456'
      })
    });

    assert.equal(joinResponse.status, 200);
    const joined = await joinResponse.json();
    assert.ok(joined?.participant?.sessionId);
    assert.ok(joined?.authToken);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

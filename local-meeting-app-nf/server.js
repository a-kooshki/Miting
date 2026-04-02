const http = require("http");
const https = require("https");
const dgram = require("dgram");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const CERTS_DIR = path.join(__dirname, "certs");
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
const PARTICIPANT_TTL_MS = Number(process.env.PARTICIPANT_TTL_MS || 30_000);
const STUN_PORT = Number(process.env.STUN_PORT || 3478);

const FILES = {
  users: path.join(DATA_DIR, "users.json"),
  rooms: path.join(DATA_DIR, "rooms.json"),
  messages: path.join(DATA_DIR, "messages.json")
};

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon"
};

const pendingIceCandidates = new Map();
const fileOperationQueues = new Map();
const MESSAGE_LIMIT_PER_ROOM = 1000;
const MESSAGE_RETURN_LIMIT = 100;
const SIGNAL_LIMIT_PER_ROOM = 500;
const MAX_PARTICIPANTS_PER_ROOM = Number(process.env.MAX_PARTICIPANTS_PER_ROOM || 24);
const BODY_LIMIT_BYTES = Number(process.env.BODY_LIMIT_BYTES || 512 * 1024);
const SIGNAL_PAYLOAD_LIMIT_BYTES = Number(process.env.SIGNAL_PAYLOAD_LIMIT_BYTES || 64 * 1024);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 10_000);
const RATE_LIMIT_MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_REQUESTS || 120);
const RATE_LIMIT_MAX_POSTS = Number(process.env.RATE_LIMIT_MAX_POSTS || 50);
const rateLimitStore = new Map();

async function ensureStorage() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(CERTS_DIR, { recursive: true });
  const defaults = {
    [FILES.users]: [],
    [FILES.rooms]: [],
    [FILES.messages]: []
  };

  for (const [filePath, defaultValue] of Object.entries(defaults)) {
    try {
      await fsp.access(filePath, fs.constants.F_OK);
    } catch {
      await writeJson(filePath, defaultValue);
    }
  }
}

function loadTlsOptions() {
  const keyPath = process.env.TLS_KEY_PATH || path.join(CERTS_DIR, "server.key");
  const certPath = process.env.TLS_CERT_PATH || path.join(CERTS_DIR, "server.crt");

  try {
    return {
      key: fs.readFileSync(keyPath, "utf8"),
      cert: fs.readFileSync(certPath, "utf8"),
      keyPath,
      certPath
    };
  } catch {
    return null;
  }
}

async function readJson(filePath, fallback) {
  try {
    const content = await fsp.readFile(filePath, "utf8");
    return JSON.parse(content || JSON.stringify(fallback));
  } catch (error) {
    return fallback;
  }
}

async function writeJson(filePath, data) {
  await fsp.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

function withFileLock(filePath, task) {
  const current = fileOperationQueues.get(filePath) || Promise.resolve();
  const next = current
    .catch(() => {})
    .then(task);

  fileOperationQueues.set(
    filePath,
    next.finally(() => {
      if (fileOperationQueues.get(filePath) === next) {
        fileOperationQueues.delete(filePath);
      }
    })
  );

  return next;
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function sendText(response, statusCode, message) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8"
  });
  response.end(message);
}

function setSecurityHeaders(response, isSecure = false) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  if (isSecure) {
    response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );
}

function buildStunBindingSuccessResponse(message, remoteInfo) {
  const transactionId = message.subarray(8, 20);
  const response = Buffer.alloc(32);
  response.writeUInt16BE(0x0101, 0);
  response.writeUInt16BE(12, 2);
  response.writeUInt32BE(0x2112A442, 4);
  transactionId.copy(response, 8);

  response.writeUInt16BE(0x0020, 20);
  response.writeUInt16BE(8, 22);
  response[24] = 0;
  response[25] = 0x01;

  const portXor = remoteInfo.port ^ 0x2112;
  response.writeUInt16BE(portXor, 26);

  const ipParts = remoteInfo.address.split(".").map((part) => Number(part));
  const cookie = Buffer.from([0x21, 0x12, 0xa4, 0x42]);
  for (let index = 0; index < 4; index += 1) {
    response[28 + index] = (ipParts[index] || 0) ^ cookie[index];
  }

  return response;
}

function createStunServer() {
  const server = dgram.createSocket("udp4");
  server.available = true;

  server.on("message", (message, remoteInfo) => {
    if (message.length < 20) {
      return;
    }

    const messageType = message.readUInt16BE(0);
    const magicCookie = message.readUInt32BE(4);
    if (messageType !== 0x0001 || magicCookie !== 0x2112a442) {
      return;
    }

    const response = buildStunBindingSuccessResponse(message, remoteInfo);
    server.send(response, remoteInfo.port, remoteInfo.address);
  });

  server.on("error", (error) => {
    server.available = false;
    console.error(`STUN server failed: ${error.message}`);
  });

  return server;
}

function parseBody(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > BODY_LIMIT_BYTES) {
        reject(new Error("Request too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error("Invalid JSON body"));
      }
    });
    request.on("error", reject);
  });
}

function normalizeName(value, fallback) {
  const trimmed = String(value || "").trim();
  return trimmed ? trimmed.slice(0, 40) : fallback;
}

function normalizeRoomCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "")
    .slice(0, 16);
}

function normalizeSignalType(value) {
  const allowedTypes = new Set(["offer", "answer", "ice-candidate"]);
  const cleanType = String(value || "").trim();
  return allowedTypes.has(cleanType) ? cleanType : "";
}

function validateSignalPayload(payload) {
  try {
    const serialized = JSON.stringify(payload);
    return Buffer.byteLength(serialized || "", "utf8") <= SIGNAL_PAYLOAD_LIMIT_BYTES;
  } catch {
    return false;
  }
}

function assert(condition, message, statusCode = 400) {
  if (!condition) {
    const error = new Error(message);
    error.statusCode = statusCode;
    throw error;
  }
}

function generateId(prefix = "") {
  return `${prefix}${crypto.randomBytes(6).toString("hex")}`;
}

function generateRoomCode() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

function isParticipantActive(participant) {
  const lastActiveAt = new Date(
    participant?.lastActiveAt || participant?.joinedAt || Date.now()
  ).getTime();

  return Date.now() - lastActiveAt < PARTICIPANT_TTL_MS;
}

function sanitizeRoomState(room) {
  room.participants = (room.participants || []).filter(isParticipantActive);
  const activeSessionIds = new Set(room.participants.map((item) => item.sessionId));
  room.signals = (room.signals || []).filter((signal) => {
    const age = Date.now() - new Date(signal.createdAt || Date.now()).getTime();
    const relevant =
      activeSessionIds.has(signal.fromSessionId) && activeSessionIds.has(signal.toSessionId);
    return age < 2 * 60 * 1000 && relevant;
  });
}

function sanitizeRoomForClient(room) {
  return {
    ...room,
    signals: undefined,
    participants: (room.participants || []).map((participant) => ({
      sessionId: participant.sessionId,
      userId: participant.userId,
      name: participant.name,
      joinedAt: participant.joinedAt,
      lastActiveAt: participant.lastActiveAt
    }))
  };
}

function buildParticipantToken() {
  return crypto.randomBytes(24).toString("hex");
}

function getClientIp(request) {
  const forwarded = request.headers["x-forwarded-for"];
  if (forwarded) {
    return String(forwarded).split(",")[0].trim();
  }

  return request.socket?.remoteAddress || "unknown";
}

function isRateLimited(request) {
  const ip = getClientIp(request);
  const now = Date.now();
  const bucket = rateLimitStore.get(ip) || {
    resetAt: now + RATE_LIMIT_WINDOW_MS,
    requests: 0,
    postRequests: 0
  };

  if (bucket.resetAt <= now) {
    bucket.resetAt = now + RATE_LIMIT_WINDOW_MS;
    bucket.requests = 0;
    bucket.postRequests = 0;
  }

  bucket.requests += 1;
  if (request.method === "POST") {
    bucket.postRequests += 1;
  }
  rateLimitStore.set(ip, bucket);

  return bucket.requests > RATE_LIMIT_MAX_REQUESTS || bucket.postRequests > RATE_LIMIT_MAX_POSTS;
}

function validateParticipant(room, sessionId, authToken) {
  const participant = (room.participants || []).find((item) => item.sessionId === sessionId);
  if (!participant) {
    return null;
  }

  if (!authToken || participant.authToken !== authToken) {
    return null;
  }

  return participant;
}

async function upsertUser(userName) {
  return withFileLock(FILES.users, async () => {
    const users = await readJson(FILES.users, []);
    const cleanName = normalizeName(userName, "Guest");
    let user = users.find((item) => item.name.toLowerCase() === cleanName.toLowerCase());

    if (!user) {
      user = {
        id: generateId("usr_"),
        name: cleanName,
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString()
      };
      users.push(user);
    } else {
      user.lastSeenAt = new Date().toISOString();
    }

    await writeJson(FILES.users, users);
    return user;
  });
}

async function createRoom(ownerName, roomTitle) {
  const owner = await upsertUser(ownerName);
  return withFileLock(FILES.rooms, async () => {
    const rooms = await readJson(FILES.rooms, []);
    let roomCode = generateRoomCode();

    while (rooms.some((item) => item.code === roomCode)) {
      roomCode = generateRoomCode();
    }

    const room = {
      id: generateId("room_"),
      code: roomCode,
      title: normalizeName(roomTitle, "جلسه جدید"),
      ownerId: owner.id,
      createdAt: new Date().toISOString(),
      participants: [],
      signals: []
    };

    rooms.push(room);
    await writeJson(FILES.rooms, rooms);
    return { room, owner };
  });
}

async function joinRoom(roomCode, userName) {
  const user = await upsertUser(userName);
  return withFileLock(FILES.rooms, async () => {
    const rooms = await readJson(FILES.rooms, []);
    const room = rooms.find((item) => item.code === normalizeRoomCode(roomCode));

    if (!room) {
      return { error: "room_not_found" };
    }

    sanitizeRoomState(room);
    if ((room.participants || []).length >= MAX_PARTICIPANTS_PER_ROOM) {
      return { error: "room_full" };
    }

    const authToken = buildParticipantToken();
    const participant = {
      sessionId: generateId("ses_"),
      userId: user.id,
      name: user.name,
      joinedAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      authToken
    };

    room.participants = (room.participants || []).filter((item) => item.userId !== user.id);
    room.participants.push(participant);
    await writeJson(FILES.rooms, rooms);
    return {
      room: sanitizeRoomForClient(room),
      user,
      participant: {
        sessionId: participant.sessionId,
        userId: participant.userId,
        name: participant.name,
        joinedAt: participant.joinedAt,
        lastActiveAt: participant.lastActiveAt
      },
      authToken
    };
  });
}

async function getRoomByCode(roomCode) {
  return withFileLock(FILES.rooms, async () => {
    const rooms = await readJson(FILES.rooms, []);
    const room = rooms.find((item) => item.code === normalizeRoomCode(roomCode));

    if (!room) {
      return null;
    }

    sanitizeRoomState(room);
    await writeJson(FILES.rooms, rooms);
    return room;
  });
}

async function updateRoom(roomCode, updater) {
  return withFileLock(FILES.rooms, async () => {
    const rooms = await readJson(FILES.rooms, []);
    const roomIndex = rooms.findIndex((item) => item.code === normalizeRoomCode(roomCode));

    if (roomIndex === -1) {
      return null;
    }

    sanitizeRoomState(rooms[roomIndex]);
    updater(rooms[roomIndex]);
    sanitizeRoomState(rooms[roomIndex]);
    await writeJson(FILES.rooms, rooms);
    return rooms[roomIndex];
  });
}

async function leaveRoom(roomCode, sessionId) {
  return updateRoom(roomCode, (room) => {
    room.participants = (room.participants || []).filter((item) => item.sessionId !== sessionId);
    room.signals = (room.signals || []).filter(
      (signal) => signal.fromSessionId !== sessionId && signal.toSessionId !== sessionId
    );
  });
}

async function addSignal(roomCode, signal) {
  return updateRoom(roomCode, (room) => {
    room.signals = room.signals || [];
    room.signals.push({
      id: generateId("sig_"),
      createdAt: new Date().toISOString(),
      consumed: false,
      ...signal
    });
    room.signals = room.signals.slice(-SIGNAL_LIMIT_PER_ROOM);
  });
}

async function consumeSignals(roomCode, sessionId) {
  let delivered = [];
  await updateRoom(roomCode, (room) => {
    room.signals = room.signals || [];
    delivered = room.signals.filter(
      (signal) => signal.toSessionId === sessionId && signal.fromSessionId !== sessionId && !signal.consumed
    );
    room.signals = room.signals.map((signal) =>
      delivered.some((item) => item.id === signal.id) ? { ...signal, consumed: true } : signal
    );
    room.signals = room.signals.filter((signal) => {
      const age = Date.now() - new Date(signal.createdAt).getTime();
      return !signal.consumed || age < 2 * 60 * 1000;
    });
    room.participants = (room.participants || []).map((item) =>
      item.sessionId === sessionId ? { ...item, lastActiveAt: new Date().toISOString() } : item
    );
  });

  const pendingKey = `${normalizeRoomCode(roomCode)}:${sessionId}`;
  const extraCandidates = pendingIceCandidates.get(pendingKey) || [];
  if (extraCandidates.length) {
    delivered = delivered.concat(extraCandidates);
    pendingIceCandidates.delete(pendingKey);
  }

  return delivered;
}

async function addMessage(roomCode, message) {
  await withFileLock(FILES.messages, async () => {
    const messages = await readJson(FILES.messages, []);
    messages.push({
      id: generateId("msg_"),
      createdAt: new Date().toISOString(),
      roomCode: normalizeRoomCode(roomCode),
      ...message
    });
    await writeJson(FILES.messages, messages.slice(-MESSAGE_LIMIT_PER_ROOM));
  });
}

async function getMessages(roomCode) {
  return withFileLock(FILES.messages, async () => {
    const messages = await readJson(FILES.messages, []);
    return messages
      .filter((item) => item.roomCode === normalizeRoomCode(roomCode))
      .slice(-MESSAGE_RETURN_LIMIT);
  });
}

function getStaticFile(filePath) {
  const resolved = path.normalize(path.join(PUBLIC_DIR, filePath));
  if (!resolved.startsWith(PUBLIC_DIR)) {
    return null;
  }
  return resolved;
}

async function serveStatic(requestPath, response) {
  const relativePath = requestPath === "/" ? "/index.html" : requestPath;
  const filePath = getStaticFile(relativePath);

  if (!filePath) {
    sendText(response, 403, "Forbidden");
    return;
  }

  try {
    const stat = await fsp.stat(filePath);
    const finalPath = stat.isDirectory() ? path.join(filePath, "index.html") : filePath;
    const ext = path.extname(finalPath).toLowerCase();
    const content = await fsp.readFile(finalPath);
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    response.end(content);
  } catch {
    sendText(response, 404, "Not found");
  }
}

async function handleApi(request, response, urlObject) {
  const { pathname, searchParams } = urlObject;

  if (request.method === "GET" && pathname === "/api/health") {
    sendJson(response, 200, {
      ok: true,
      mode: "offline-lan",
      httpPort: PORT,
      httpsPort: HTTPS_PORT,
      stunPort: STUN_PORT,
      httpsEnabled: Boolean(loadTlsOptions())
    });
    return;
  }

  if (request.method === "GET" && pathname === "/api/config") {
    sendJson(response, 200, {
      host: HOST,
      httpPort: PORT,
      httpsPort: HTTPS_PORT,
      stunPort: STUN_PORT,
      httpsEnabled: Boolean(loadTlsOptions())
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/rooms") {
    const body = await parseBody(request);
    const ownerName = normalizeName(body.ownerName, "Guest");
    const roomTitle = normalizeName(body.roomTitle, "جلسه جدید");
    assert(ownerName, "نام سازنده لازم است.");
    assert(roomTitle, "عنوان جلسه لازم است.");
    const { room, owner } = await createRoom(ownerName, roomTitle);
    sendJson(response, 201, { room: sanitizeRoomForClient(room), owner });
    return;
  }

  if (request.method === "POST" && pathname === "/api/rooms/join") {
    const body = await parseBody(request);
    assert(normalizeRoomCode(body.roomCode), "کد اتاق معتبر نیست.");
    assert(normalizeName(body.userName, ""), "نام کاربر لازم است.");
    const result = await joinRoom(body.roomCode, body.userName);

    if (result.error) {
      if (result.error === "room_full") {
        sendJson(response, 409, { error: "ظرفیت اتاق تکمیل شده است." });
        return;
      }
      sendJson(response, 404, { error: "اتاق پیدا نشد." });
      return;
    }

    sendJson(response, 200, result);
    return;
  }

  if (request.method === "GET" && pathname === "/api/rooms/detail") {
    const roomCode = searchParams.get("roomCode");
    const room = await getRoomByCode(roomCode);
    if (!room) {
      sendJson(response, 404, { error: "اتاق پیدا نشد." });
      return;
    }

    sendJson(response, 200, {
      room: sanitizeRoomForClient(room),
      messages: await getMessages(room.code)
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/rooms/leave") {
    const body = await parseBody(request);
    assert(normalizeRoomCode(body.roomCode), "کد اتاق معتبر نیست.");
    assert(String(body.sessionId || "").trim(), "شناسه نشست لازم است.");
    assert(String(body.authToken || "").trim(), "مجوز نشست لازم است.");
    const existingRoom = await getRoomByCode(body.roomCode);
    if (!existingRoom) {
      sendJson(response, 404, { error: "اتاق پیدا نشد." });
      return;
    }
    const participant = validateParticipant(existingRoom, body.sessionId, body.authToken);
    if (!participant) {
      sendJson(response, 403, { error: "اجازه خروج برای این نشست معتبر نیست." });
      return;
    }
    const room = await leaveRoom(body.roomCode, body.sessionId);
    if (!room) {
      sendJson(response, 404, { error: "اتاق پیدا نشد." });
      return;
    }
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "POST" && pathname === "/api/signals") {
    const body = await parseBody(request);
    const roomCode = normalizeRoomCode(body.roomCode);
    const signalType = normalizeSignalType(body.type);
    assert(roomCode, "کد اتاق معتبر نیست.");
    assert(signalType, "نوع سیگنال معتبر نیست.");
    assert(String(body.fromSessionId || "").trim(), "شناسه فرستنده لازم است.");
    assert(String(body.toSessionId || "").trim(), "شناسه گیرنده لازم است.");
    assert(String(body.authToken || "").trim(), "مجوز نشست لازم است.");
    assert(validateSignalPayload(body.payload), "حجم داده سیگنال بیش از حد مجاز است.");
    const room = await getRoomByCode(roomCode);
    if (!room) {
      sendJson(response, 404, { error: "اتاق پیدا نشد." });
      return;
    }
    const sender = validateParticipant(room, body.fromSessionId, body.authToken);
    if (!sender) {
      sendJson(response, 403, { error: "مجوز ارسال سیگنال معتبر نیست." });
      return;
    }
    const receiver = (room.participants || []).find((item) => item.sessionId === body.toSessionId);
    if (!receiver) {
      sendJson(response, 404, { error: "گیرنده سیگنال در اتاق حاضر نیست." });
      return;
    }
    const signal = {
      type: signalType,
      fromSessionId: body.fromSessionId,
      toSessionId: body.toSessionId,
      payload: body.payload
    };

    await addSignal(roomCode, signal);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "GET" && pathname === "/api/signals") {
    const roomCode = searchParams.get("roomCode");
    const sessionId = searchParams.get("sessionId");
    const authToken = searchParams.get("authToken");

    if (!roomCode || !sessionId || !authToken) {
      sendJson(response, 400, { error: "پارامترهای لازم ارسال نشده‌اند." });
      return;
    }

    const room = await getRoomByCode(roomCode);
    if (!room) {
      sendJson(response, 404, { error: "اتاق پیدا نشد." });
      return;
    }
    const participant = validateParticipant(room, sessionId, authToken);
    if (!participant) {
      sendJson(response, 403, { error: "مجوز دریافت سیگنال معتبر نیست." });
      return;
    }
    const signals = await consumeSignals(roomCode, sessionId);
    sendJson(response, 200, { signals });
    return;
  }

  if (request.method === "POST" && pathname === "/api/messages") {
    const body = await parseBody(request);
    const roomCode = normalizeRoomCode(body.roomCode);
    assert(roomCode, "کد اتاق معتبر نیست.");
    assert(String(body.sessionId || "").trim(), "شناسه نشست لازم است.");
    assert(String(body.authToken || "").trim(), "مجوز نشست لازم است.");
    const text = String(body.text || "").trim().slice(0, 400);
    if (!text) {
      sendJson(response, 400, { error: "متن پیام خالی است." });
      return;
    }
    const room = await getRoomByCode(roomCode);
    if (!room) {
      sendJson(response, 404, { error: "اتاق پیدا نشد." });
      return;
    }
    const participant = validateParticipant(room, body.sessionId, body.authToken);
    if (!participant) {
      sendJson(response, 403, { error: "مجوز ارسال پیام معتبر نیست." });
      return;
    }
    await addMessage(roomCode, {
      sessionId: body.sessionId,
      sender: participant.name,
      text
    });
    sendJson(response, 201, { ok: true });
    return;
  }

  if (request.method === "POST" && pathname === "/api/rooms/heartbeat") {
    const body = await parseBody(request);
    const roomCode = normalizeRoomCode(body.roomCode);
    assert(roomCode, "کد اتاق معتبر نیست.");
    assert(String(body.sessionId || "").trim(), "شناسه نشست لازم است.");
    assert(String(body.authToken || "").trim(), "مجوز نشست لازم است.");
    const room = await updateRoom(roomCode, (targetRoom) => {
      const participant = validateParticipant(targetRoom, body.sessionId, body.authToken);
      if (!participant) {
        return;
      }
      targetRoom.participants = (targetRoom.participants || []).map((item) =>
        item.sessionId === body.sessionId ? { ...item, lastActiveAt: new Date().toISOString() } : item
      );
    });

    if (!room) {
      sendJson(response, 404, { error: "اتاق پیدا نشد." });
      return;
    }
    const validParticipant = validateParticipant(room, body.sessionId, body.authToken);
    if (!validParticipant) {
      sendJson(response, 403, { error: "مجوز نشست معتبر نیست." });
      return;
    }
    sendJson(response, 200, { ok: true });
    return;
  }

  sendJson(response, 404, { error: "مسیر API پیدا نشد." });
}

async function requestHandler(request, response) {
  const urlObject = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  setSecurityHeaders(response, request.socket?.encrypted === true);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  try {
    if (urlObject.pathname.startsWith("/api/") && isRateLimited(request)) {
      sendJson(response, 429, { error: "تعداد درخواست‌ها بیش از حد مجاز است. چند لحظه دیگر دوباره تلاش کنید." });
      return;
    }

    if (urlObject.pathname.startsWith("/api/")) {
      await handleApi(request, response, urlObject);
      return;
    }

    await serveStatic(urlObject.pathname, response);
  } catch (error) {
    if (error.statusCode) {
      sendJson(response, error.statusCode, {
        error: error.message
      });
      return;
    }

    sendJson(response, 500, {
      error: "خطای داخلی سرور"
    });
  }
}

async function start() {
  await ensureStorage();
  const httpServer = http.createServer(requestHandler);
  const stunServer = createStunServer();
  httpServer.on("error", (error) => {
    console.error(`Server failed to start: ${error.message}`);
    process.exitCode = 1;
  });
  httpServer.requestTimeout = 15_000;
  httpServer.headersTimeout = 20_000;
  httpServer.keepAliveTimeout = 5_000;
  httpServer.listen(PORT, HOST, () => {
    console.log(`Local meeting app running at http://${HOST}:${PORT}`);
  });
  try {
    stunServer.bind(STUN_PORT, HOST, () => {
      console.log(`Local STUN server running at udp://${HOST}:${STUN_PORT}`);
    });
  } catch (error) {
    stunServer.available = false;
    console.error(`STUN bind failed: ${error.message}`);
  }

  const tlsOptions = loadTlsOptions();
  let httpsServer = null;

  if (tlsOptions) {
    httpsServer = https.createServer(
      {
        key: tlsOptions.key,
        cert: tlsOptions.cert
      },
      requestHandler
    );
    httpsServer.on("error", (error) => {
      console.error(`HTTPS server failed to start: ${error.message}`);
      process.exitCode = 1;
    });
    httpsServer.requestTimeout = 15_000;
    httpsServer.headersTimeout = 20_000;
    httpsServer.keepAliveTimeout = 5_000;
    httpsServer.listen(HTTPS_PORT, HOST, () => {
      console.log(`Secure local meeting app running at https://${HOST}:${HTTPS_PORT}`);
    });
  } else {
    console.log(
      "HTTPS is disabled. Add certs/server.key and certs/server.crt for camera, microphone, and screen sharing on LAN."
    );
  }

  const shutdown = () => {
    httpServer.close();
    httpsServer?.close();
    stunServer.close();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return { httpServer, httpsServer, stunServer };
}

if (require.main === module) {
  start();
}

module.exports = {
  start,
  requestHandler,
  ensureStorage,
  readJson,
  writeJson
};

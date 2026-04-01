const params = new URLSearchParams(window.location.search);
const sessionSeed = JSON.parse(sessionStorage.getItem("meetingSession") || "{}");
const roomCode = (params.get("code") || sessionSeed.roomCode || "").toUpperCase();
const userName = params.get("name") || sessionSeed.userName || "Guest";
const roomPassword = String(sessionSeed.roomPassword || "");

const KEY_ROTATION_MS = 5 * 60 * 1000;
const MEDIA_MAGIC = [0x47, 0x52, 0x50, 0x48];

const state = {
  room: null,
  participant: null,
  authToken: "",
  participants: [],
  localStream: null,
  screenStream: null,
  peerConnections: new Map(),
  pendingCandidates: new Map(),
  refreshTimer: null,
  signalTimer: null,
  config: null,
  joined: false,
  messagesLoaded: false,
  renderedMessageIds: new Set(),
  keyCache: new Map(),
  mediaE2EEEnabled: false,
  mediaE2EEAvailable: false,
  transformedSenders: new WeakSet(),
  transformedReceivers: new WeakSet()
};

const roomTitleEl = document.getElementById("roomTitle");
const roomCodeBadgeEl = document.getElementById("roomCodeBadge");
const currentUserNameEl = document.getElementById("currentUserName");
const participantCountEl = document.getElementById("participantCount");
const participantsListEl = document.getElementById("participantsList");
const messagesEl = document.getElementById("messages");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const localVideo = document.getElementById("localVideo");
const videoGrid = document.getElementById("videoGrid");
const emptyRemoteStateEl = document.getElementById("emptyRemoteState");
const connectionHint = document.getElementById("connectionHint");
const toggleAudioBtn = document.getElementById("toggleAudioBtn");
const toggleVideoBtn = document.getElementById("toggleVideoBtn");
const shareScreenBtn = document.getElementById("shareScreenBtn");
const retryMediaBtn = document.getElementById("retryMediaBtn");
const leaveBtn = document.getElementById("leaveBtn");
const copyInviteBtn = document.getElementById("copyInviteBtn");
const inviteLinkText = document.getElementById("inviteLinkText");
const secureStateBadge = document.getElementById("secureStateBadge");
const openSecureBtn = document.getElementById("openSecureBtn");

function setHint(text) {
  connectionHint.textContent = text;
}

function persistSession() {
  sessionStorage.setItem(
    "meetingSession",
    JSON.stringify({
      roomCode,
      userName,
      authToken: state.authToken,
      roomPassword
    })
  );
}

function bytesToBase64Url(bytes) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const normalized = String(value || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(String(value || "").length / 4) * 4, "=");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function getCurrentBucket(now = Date.now()) {
  return Math.floor(now / KEY_ROTATION_MS);
}

async function deriveKey(purpose, bucket) {
  const cacheKey = `${purpose}:${bucket}`;
  if (state.keyCache.has(cacheKey)) {
    return state.keyCache.get(cacheKey);
  }

  const passwordKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(roomPassword),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: new TextEncoder().encode(`${purpose}:${roomCode}:${bucket}`),
      iterations: 120000,
      hash: "SHA-256"
    },
    passwordKey,
    {
      name: "AES-GCM",
      length: 256
    },
    false,
    ["encrypt", "decrypt"]
  );

  state.keyCache.set(cacheKey, key);
  return key;
}

async function encryptEnvelope(purpose, payload) {
  const bucket = getCurrentBucket();
  const key = await deriveKey(purpose, bucket);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);

  return {
    version: 1,
    algorithm: "AES-GCM-256",
    purpose,
    bucket,
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext))
  };
}

async function decryptEnvelope(envelope, expectedPurpose) {
  if (!envelope) {
    throw new Error("missing_envelope");
  }

  const candidateBuckets = [];
  if (Number.isFinite(Number(envelope.bucket))) {
    candidateBuckets.push(Number(envelope.bucket));
  }
  const currentBucket = getCurrentBucket();
  [currentBucket, currentBucket - 1, currentBucket + 1].forEach((bucket) => {
    if (!candidateBuckets.includes(bucket)) {
      candidateBuckets.push(bucket);
    }
  });

  for (const bucket of candidateBuckets) {
    try {
      const key = await deriveKey(expectedPurpose, bucket);
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: base64UrlToBytes(envelope.iv)
        },
        key,
        base64UrlToBytes(envelope.ciphertext)
      );
      return JSON.parse(new TextDecoder().decode(plaintext));
    } catch (error) {
      continue;
    }
  }

  throw new Error("decrypt_failed");
}

function updateSecureBadge() {
  if (window.isSecureContext && state.mediaE2EEEnabled) {
    secureStateBadge.textContent = "HTTPS + E2EE رسانه فعال";
    secureStateBadge.className = "status-pill success";
    return;
  }

  if (window.isSecureContext) {
    secureStateBadge.textContent = "HTTPS فعال";
    secureStateBadge.className = "status-pill success";
    return;
  }

  secureStateBadge.textContent = state.mediaE2EEAvailable
    ? "HTTP / E2EE محدود"
    : "رمزنگاری پایه فقط";
  secureStateBadge.className = "status-pill warning";
}

function setInviteLink() {
  const inviteUrl = `${location.origin}/?code=${encodeURIComponent(roomCode)}`;
  inviteLinkText.textContent = inviteUrl;
  inviteLinkText.title = inviteUrl;
}

function toggleEmptyRemoteState() {
  const remoteCardsCount = videoGrid.querySelectorAll(".video-card[data-session-id]").length;
  emptyRemoteStateEl.hidden = remoteCardsCount > 0;
}

async function ensureConfig() {
  if (!state.config) {
    state.config = await api("/api/config");
  }

  return state.config;
}

function renderSecureAction() {
  if (!openSecureBtn) {
    return;
  }

  if (window.isSecureContext || !state.config?.httpsEnabled) {
    openSecureBtn.hidden = true;
    return;
  }

  openSecureBtn.hidden = false;
  openSecureBtn.textContent = `بازکردن نسخه امن روی ${state.config.httpsPort}`;
}

function setMediaButtonsState() {
  const audioTracks = state.localStream?.getAudioTracks() || [];
  const videoTracks = state.localStream?.getVideoTracks() || [];

  toggleAudioBtn.disabled = audioTracks.length === 0;
  toggleVideoBtn.disabled = videoTracks.length === 0;
  retryMediaBtn.disabled = false;

  toggleAudioBtn.textContent = audioTracks[0]
    ? audioTracks[0].enabled
      ? "قطع میکروفون"
      : "وصل میکروفون"
    : "میکروفون ندارد";

  toggleVideoBtn.textContent = videoTracks[0]
    ? videoTracks[0].enabled
      ? "قطع دوربین"
      : "وصل دوربین"
    : "دوربین ندارد";
}

function explainMediaError(error, featureName) {
  if (!window.isSecureContext) {
    return `${featureName} روی اتصال ناامن HTTP در شبکه داخلی توسط مرورگر مسدود می شود. برنامه را با HTTPS محلی باز کنید.`;
  }

  if (error?.name === "NotAllowedError") {
    return `دسترسی ${featureName} در مرورگر رد شده است. مجوز دوربین/میکروفون/صفحه را Allow کنید.`;
  }

  if (error?.name === "NotFoundError") {
    return `${featureName} پیدا نشد. دوربین، میکروفون یا نمایشگر روی سیستم شناسایی نشده است.`;
  }

  if (error?.name === "NotReadableError") {
    return `${featureName} توسط برنامه دیگری در حال استفاده است یا سیستم اجازه دسترسی نمی دهد.`;
  }

  return `خطا در دسترسی به ${featureName}: ${error?.message || "نامشخص"}`;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json"
    },
    ...options
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "خطا در ارتباط با سرور");
  }

  return data;
}

function renderParticipants() {
  participantsListEl.innerHTML = "";
  participantCountEl.textContent = `${state.participants.length} نفر`;

  if (state.participants.length === 0) {
    const item = document.createElement("li");
    item.className = "empty-item";
    item.textContent = "هنوز شرکت کننده ای ثبت نشده است.";
    participantsListEl.appendChild(item);
    return;
  }

  state.participants.forEach((participant) => {
    const item = document.createElement("li");
    item.textContent =
      participant.sessionId === state.participant?.sessionId
        ? `${participant.name} (شما)`
        : participant.name;
    participantsListEl.appendChild(item);
  });
}

async function resolveMessageContent(message) {
  if (message.encryptedPayload) {
    try {
      return await decryptEnvelope(message.encryptedPayload, "chat");
    } catch (error) {
      return {
        sender: "پیام رمزگذاری شده",
        text: "رمزگشایی پیام ممکن نشد. مطمئن شوید رمز جلسه را درست وارد کرده اید."
      };
    }
  }

  return {
    sender: message.sender || "کاربر",
    text: message.text || ""
  };
}

function renderEmptyMessages() {
  messagesEl.innerHTML = "";
  const wrapper = document.createElement("div");
  wrapper.className = "message empty";
  wrapper.textContent = "هنوز پیامی ارسال نشده است. گفتگو را شما شروع کنید.";
  messagesEl.appendChild(wrapper);
}

async function appendMessage(message, scroll = true) {
  const emptyMessage = messagesEl.querySelector(".message.empty");
  if (emptyMessage) {
    emptyMessage.remove();
  }

  const content = await resolveMessageContent(message);
  const wrapper = document.createElement("div");
  wrapper.className = "message";
  wrapper.dataset.messageId = message.id || "";
  const senderEl = document.createElement("strong");
  senderEl.textContent = content.sender;
  const textEl = document.createElement("span");
  textEl.textContent = content.text;
  wrapper.append(senderEl, textEl);
  messagesEl.appendChild(wrapper);

  if (message.id) {
    state.renderedMessageIds.add(message.id);
  }

  if (scroll) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

async function renderMessages(messages) {
  state.renderedMessageIds.clear();
  messagesEl.innerHTML = "";

  if (!messages.length) {
    renderEmptyMessages();
    return;
  }

  for (const message of messages) {
    await appendMessage(message, false);
  }

  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function syncMessages(messages) {
  const nextIds = new Set(messages.map((message) => message.id));
  const shouldFullRender =
    !state.messagesLoaded || Array.from(state.renderedMessageIds).some((messageId) => !nextIds.has(messageId));

  if (shouldFullRender) {
    await renderMessages(messages);
    state.messagesLoaded = true;
    return;
  }

  for (const message of messages) {
    if (!state.renderedMessageIds.has(message.id)) {
      await appendMessage(message);
    }
  }
}

function ensureRemoteCard(sessionId, name) {
  let card = document.querySelector(`[data-session-id="${sessionId}"]`);
  if (card) {
    return card.querySelector("video");
  }

  card = document.createElement("article");
  card.className = "video-card";
  card.dataset.sessionId = sessionId;
  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  const label = document.createElement("div");
  label.className = "video-label";
  label.textContent = name;
  card.append(video, label);
  videoGrid.appendChild(card);
  toggleEmptyRemoteState();
  return card.querySelector("video");
}

function removeRemoteCard(sessionId) {
  const card = document.querySelector(`[data-session-id="${sessionId}"]`);
  if (card) {
    card.remove();
  }
  toggleEmptyRemoteState();
}

async function setupLocalMedia(replaceActiveStream = false) {
  if (!navigator.mediaDevices?.getUserMedia) {
    setHint("این مرورگر از دسترسی به دوربین و میکروفون پشتیبانی نمی کند.");
    setMediaButtonsState();
    return;
  }

  const attempts = [
    {
      constraints: { video: true, audio: true },
      successText: "دوربین و میکروفون آماده است. منتظر سایر کاربران..."
    },
    {
      constraints: { video: false, audio: true },
      successText: "فقط میکروفون فعال شد؛ جلسه همچنان قابل استفاده است."
    },
    {
      constraints: { video: true, audio: false },
      successText: "فقط دوربین فعال شد؛ برای صدا می توانید چت را هم استفاده کنید."
    }
  ];

  let lastError = null;

  for (const attempt of attempts) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(attempt.constraints);
      if (replaceActiveStream) {
        replaceOutgoingStream(stream);
      } else {
        state.localStream = stream;
        localVideo.srcObject = state.localStream;
        setMediaButtonsState();
      }
      setHint(attempt.successText);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  state.localStream = null;
  localVideo.srcObject = null;
  setMediaButtonsState();
  if (lastError) {
    setHint(explainMediaError(lastError, "دوربین و میکروفون"));
  }
}

function mediaTransformsSupported() {
  return typeof window.RTCRtpSender !== "undefined" && typeof RTCRtpSender.prototype.createEncodedStreams === "function";
}

function packEncryptedFrame(bucket, iv, ciphertext) {
  const header = new Uint8Array(4 + 4 + 12);
  header.set(MEDIA_MAGIC, 0);
  new DataView(header.buffer).setUint32(4, bucket);
  header.set(iv, 8);
  const packed = new Uint8Array(header.length + ciphertext.length);
  packed.set(header, 0);
  packed.set(ciphertext, header.length);
  return packed;
}

function unpackEncryptedFrame(data) {
  const bytes = new Uint8Array(data);
  if (bytes.length <= 20) {
    return null;
  }

  for (let i = 0; i < MEDIA_MAGIC.length; i += 1) {
    if (bytes[i] !== MEDIA_MAGIC[i]) {
      return null;
    }
  }

  return {
    bucket: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4),
    iv: bytes.slice(8, 20),
    ciphertext: bytes.slice(20)
  };
}

function createSenderTransform(kind) {
  return new TransformStream({
    async transform(frame, controller) {
      try {
        const bucket = getCurrentBucket();
        const key = await deriveKey(`media-${kind}`, bucket);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const plaintext = new Uint8Array(frame.data);
        const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
        frame.data = packEncryptedFrame(bucket, iv, ciphertext).buffer;
      } catch (error) {
        console.error("Media sender transform failed", error);
      }
      controller.enqueue(frame);
    }
  });
}

function createReceiverTransform(kind) {
  return new TransformStream({
    async transform(frame, controller) {
      const parsed = unpackEncryptedFrame(frame.data);
      if (!parsed) {
        controller.enqueue(frame);
        return;
      }

      const buckets = [parsed.bucket, parsed.bucket - 1, parsed.bucket + 1];
      for (const bucket of buckets) {
        try {
          const key = await deriveKey(`media-${kind}`, bucket);
          const plaintext = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: parsed.iv },
            key,
            parsed.ciphertext
          );
          frame.data = plaintext;
          controller.enqueue(frame);
          return;
        } catch (error) {
          continue;
        }
      }

      console.error("Media receiver decrypt failed");
    }
  });
}

function attachSenderTransform(sender) {
  if (!state.mediaE2EEEnabled || !sender?.track || state.transformedSenders.has(sender)) {
    return;
  }

  if (typeof sender.createEncodedStreams !== "function") {
    return;
  }

  const streams = sender.createEncodedStreams();
  streams.readable.pipeThrough(createSenderTransform(sender.track.kind)).pipeTo(streams.writable).catch((error) => {
    console.error("Sender pipe failed", error);
  });
  state.transformedSenders.add(sender);
}

function attachReceiverTransform(receiver) {
  if (!state.mediaE2EEEnabled || !receiver?.track || state.transformedReceivers.has(receiver)) {
    return;
  }

  if (typeof receiver.createEncodedStreams !== "function") {
    return;
  }

  const streams = receiver.createEncodedStreams();
  streams.readable.pipeThrough(createReceiverTransform(receiver.track.kind)).pipeTo(streams.writable).catch((error) => {
    console.error("Receiver pipe failed", error);
  });
  state.transformedReceivers.add(receiver);
}

function attachPeerTransforms(peer) {
  peer.getSenders().forEach(attachSenderTransform);
  peer.getReceivers().forEach(attachReceiverTransform);
}

async function flushPendingCandidates(remoteSessionId) {
  const peer = state.peerConnections.get(remoteSessionId);
  const queued = state.pendingCandidates.get(remoteSessionId) || [];

  if (!peer?.remoteDescription || queued.length === 0) {
    return;
  }

  for (const candidate of queued) {
    try {
      await peer.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (error) {
      console.error("ICE candidate flush error", error);
    }
  }

  state.pendingCandidates.delete(remoteSessionId);
}

function buildPeerConnection(remoteParticipant, shouldInitiate) {
  if (state.peerConnections.has(remoteParticipant.sessionId)) {
    return state.peerConnections.get(remoteParticipant.sessionId);
  }

  const peer = new RTCPeerConnection({
    iceServers: state.config?.stunPort
      ? [
          {
            urls: [`stun:${location.hostname}:${state.config.stunPort}`]
          }
        ]
      : [],
    iceCandidatePoolSize: 4
  });

  if (state.localStream) {
    state.localStream.getTracks().forEach((track) => {
      peer.addTrack(track, state.localStream);
    });
  }

  attachPeerTransforms(peer);

  peer.ontrack = (event) => {
    attachPeerTransforms(peer);
    const remoteVideo = ensureRemoteCard(remoteParticipant.sessionId, remoteParticipant.name);
    remoteVideo.srcObject = event.streams[0];
  };

  peer.onicecandidate = async (event) => {
    if (!event.candidate) {
      return;
    }

    await sendSignal("ice-candidate", remoteParticipant.sessionId, event.candidate.toJSON());
  };

  peer.onconnectionstatechange = () => {
    if (["disconnected", "failed", "closed"].includes(peer.connectionState)) {
      if (peer.connectionState === "failed") {
        setHint(`اتصال رسانه با ${remoteParticipant.name} برقرار نشد. HTTPS و دسترسی LAN را بررسی کنید.`);
      }
      peer.close();
      state.peerConnections.delete(remoteParticipant.sessionId);
      removeRemoteCard(remoteParticipant.sessionId);
    }
  };

  peer.oniceconnectionstatechange = () => {
    if (peer.iceConnectionState === "connected" || peer.iceConnectionState === "completed") {
      setHint(
        state.mediaE2EEEnabled
          ? `رسانه با ${remoteParticipant.name} متصل شد و E2EE رسانه فعال است.`
          : `رسانه با ${remoteParticipant.name} متصل شد.`
      );
    }
  };

  state.peerConnections.set(remoteParticipant.sessionId, peer);

  if (shouldInitiate) {
    createOffer(remoteParticipant.sessionId).catch(console.error);
  }

  return peer;
}

async function createOffer(remoteSessionId) {
  const remoteParticipant = state.participants.find((item) => item.sessionId === remoteSessionId);
  if (!remoteParticipant) {
    return;
  }

  const peer = buildPeerConnection(remoteParticipant, false);
  if (peer.signalingState !== "stable") {
    return;
  }

  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  await sendSignal("offer", remoteSessionId, offer.toJSON ? offer.toJSON() : offer);
}

async function createAnswer(remoteSessionId, offer) {
  const remoteParticipant = state.participants.find((item) => item.sessionId === remoteSessionId);
  if (!remoteParticipant) {
    return;
  }

  const peer = buildPeerConnection(remoteParticipant, false);
  await peer.setRemoteDescription(new RTCSessionDescription(offer));
  attachPeerTransforms(peer);
  await flushPendingCandidates(remoteSessionId);
  const answer = await peer.createAnswer();
  await peer.setLocalDescription(answer);
  await sendSignal("answer", remoteSessionId, answer.toJSON ? answer.toJSON() : answer);
}

async function handleAnswer(remoteSessionId, answer) {
  const peer = state.peerConnections.get(remoteSessionId);
  if (!peer) {
    return;
  }

  await peer.setRemoteDescription(new RTCSessionDescription(answer));
  attachPeerTransforms(peer);
  await flushPendingCandidates(remoteSessionId);
}

async function handleIceCandidate(remoteSessionId, candidate) {
  const remoteParticipant = state.participants.find((item) => item.sessionId === remoteSessionId);
  if (!remoteParticipant) {
    return;
  }

  const peer = buildPeerConnection(remoteParticipant, false);
  if (!peer.remoteDescription) {
    const queued = state.pendingCandidates.get(remoteSessionId) || [];
    queued.push(candidate);
    state.pendingCandidates.set(remoteSessionId, queued.slice(-20));
    return;
  }

  try {
    await peer.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (error) {
    console.error("ICE candidate error", error);
  }
}

async function sendSignal(type, toSessionId, payload) {
  const encryptedPayload = await encryptEnvelope("signal", payload);
  await api("/api/signals", {
    method: "POST",
    body: JSON.stringify({
      roomCode,
      type,
      fromSessionId: state.participant.sessionId,
      authToken: state.authToken,
      toSessionId,
      encrypted: true,
      payload: encryptedPayload
    })
  });
}

async function pollSignals() {
  if (!state.joined || !state.participant) {
    return;
  }

  try {
    const data = await api(
      `/api/signals?roomCode=${encodeURIComponent(roomCode)}&sessionId=${encodeURIComponent(
        state.participant.sessionId
      )}&authToken=${encodeURIComponent(state.authToken)}`
    );

    for (const signal of data.signals) {
      try {
        const payload = signal.encrypted
          ? await decryptEnvelope(signal.payload, "signal")
          : signal.payload;

        if (signal.type === "offer") {
          await createAnswer(signal.fromSessionId, payload);
        } else if (signal.type === "answer") {
          await handleAnswer(signal.fromSessionId, payload);
        } else if (signal.type === "ice-candidate") {
          await handleIceCandidate(signal.fromSessionId, payload);
        }
      } catch (error) {
        console.error("Signal decrypt/process error", error);
      }
    }
  } catch (error) {
    console.error(error);
  }
}

async function refreshRoom() {
  try {
    const data = await api(
      `/api/rooms/detail?roomCode=${encodeURIComponent(roomCode)}&sessionId=${encodeURIComponent(
        state.participant.sessionId
      )}&authToken=${encodeURIComponent(state.authToken)}`
    );
    state.room = data.room;
    state.participants = data.room.participants || [];
    roomTitleEl.textContent = data.room.title;
    roomCodeBadgeEl.textContent = data.room.code;
    currentUserNameEl.textContent = userName;
    renderParticipants();
    await syncMessages(data.messages || []);

    const activeRemoteSessions = new Set(
      state.participants
        .filter((item) => item.sessionId !== state.participant?.sessionId)
        .map((item) => item.sessionId)
    );

    Array.from(state.peerConnections.keys()).forEach((sessionId) => {
      if (!activeRemoteSessions.has(sessionId)) {
        state.peerConnections.get(sessionId)?.close();
        state.peerConnections.delete(sessionId);
        removeRemoteCard(sessionId);
      }
    });

    state.participants.forEach((participant) => {
      if (participant.sessionId === state.participant?.sessionId) {
        return;
      }

      if (!state.peerConnections.has(participant.sessionId)) {
        const shouldInitiate = state.participant.sessionId > participant.sessionId;
        buildPeerConnection(participant, shouldInitiate);
      }
    });

    toggleEmptyRemoteState();
  } catch (error) {
    setHint(error.message);
  }
}

async function joinRoom() {
  const data = await api("/api/rooms/join", {
    method: "POST",
    body: JSON.stringify({
      roomCode,
      userName,
      roomPassword
    })
  });

  state.room = data.room;
  state.participant = data.participant;
  state.authToken = data.authToken || sessionSeed.authToken || "";
  state.joined = true;
  state.participants = data.room.participants || [];
  persistSession();
  renderParticipants();
}

function replaceOutgoingStream(stream) {
  state.localStream?.getTracks().forEach((track) => {
    if (track.readyState !== "ended") {
      track.stop();
    }
  });

  state.localStream = stream;
  localVideo.srcObject = stream;
  setMediaButtonsState();

  state.peerConnections.forEach((peer) => {
    const senders = peer.getSenders();
    const videoTrack = stream.getVideoTracks()[0] || null;
    const audioTrack = stream.getAudioTracks()[0] || null;

    const videoSender = senders.find((sender) => sender.track?.kind === "video");
    const audioSender = senders.find((sender) => sender.track?.kind === "audio");

    if (videoSender) {
      videoSender.replaceTrack(videoTrack);
    } else if (videoTrack) {
      peer.addTrack(videoTrack, stream);
    }

    if (audioSender) {
      audioSender.replaceTrack(audioTrack);
    } else if (audioTrack) {
      peer.addTrack(audioTrack, stream);
    }

    attachPeerTransforms(peer);
  });
}

toggleAudioBtn.addEventListener("click", () => {
  if (!state.localStream) {
    return;
  }

  const enabled = !state.localStream.getAudioTracks()[0]?.enabled;
  state.localStream.getAudioTracks().forEach((track) => {
    track.enabled = enabled;
  });
  toggleAudioBtn.textContent = enabled ? "قطع میکروفون" : "وصل میکروفون";
});

toggleVideoBtn.addEventListener("click", () => {
  if (!state.localStream) {
    return;
  }

  const enabled = !state.localStream.getVideoTracks()[0]?.enabled;
  state.localStream.getVideoTracks().forEach((track) => {
    track.enabled = enabled;
  });
  toggleVideoBtn.textContent = enabled ? "قطع دوربین" : "وصل دوربین";
});

retryMediaBtn.addEventListener("click", async () => {
  retryMediaBtn.disabled = true;
  setHint("در حال تلاش دوباره برای فعال سازی دوربین و میکروفون...");
  try {
    await setupLocalMedia(true);
  } finally {
    retryMediaBtn.disabled = false;
  }
});

shareScreenBtn.addEventListener("click", async () => {
  try {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setHint("این مرورگر از اشتراک صفحه پشتیبانی نمی کند.");
      return;
    }

    if (state.screenStream) {
      state.screenStream.getTracks().forEach((track) => track.stop());
      state.screenStream = null;
      await setupLocalMedia(true);
      shareScreenBtn.textContent = "اشتراک صفحه";
      return;
    }

    state.screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false
    });

    state.screenStream.getVideoTracks()[0].addEventListener("ended", async () => {
      state.screenStream = null;
      await setupLocalMedia(true);
      shareScreenBtn.textContent = "اشتراک صفحه";
    });

    replaceOutgoingStream(state.screenStream);
    shareScreenBtn.textContent = "بازگشت به دوربین";
  } catch (error) {
    setHint(explainMediaError(error, "اشتراک صفحه"));
  }
});

copyInviteBtn.addEventListener("click", async () => {
  const inviteText = inviteLinkText.textContent;
  try {
    if (!navigator.clipboard?.writeText) {
      throw new Error("clipboard_unavailable");
    }
    await navigator.clipboard.writeText(inviteText);
    setHint("لینک دعوت کپی شد. رمز جلسه را جداگانه برای افراد ارسال کنید.");
  } catch (error) {
    const textArea = document.createElement("textarea");
    textArea.value = inviteText;
    textArea.setAttribute("readonly", "true");
    textArea.className = "copy-fallback";
    document.body.appendChild(textArea);
    textArea.select();
    const copied = document.execCommand("copy");
    textArea.remove();
    setHint(copied ? "لینک دعوت کپی شد. رمز جلسه را هم برای افراد بفرستید." : "کپی خودکار ممکن نشد. لینک را دستی کپی کنید.");
  }
});

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text) {
    return;
  }

  try {
    const encryptedPayload = await encryptEnvelope("chat", { sender: userName, text });
    const data = await api("/api/messages", {
      method: "POST",
      body: JSON.stringify({
        roomCode,
        sessionId: state.participant.sessionId,
        authToken: state.authToken,
        encryptedPayload
      })
    });

    if (data.message && !state.renderedMessageIds.has(data.message.id)) {
      await appendMessage(data.message);
    }
    chatInput.value = "";
  } catch (error) {
    setHint(error.message);
  }
});

leaveBtn.addEventListener("click", async () => {
  try {
    if (state.participant) {
      await api("/api/rooms/leave", {
        method: "POST",
        body: JSON.stringify({
          roomCode,
          sessionId: state.participant.sessionId,
          authToken: state.authToken
        })
      });
    }
  } catch (error) {
    console.error(error);
  } finally {
    clearInterval(state.refreshTimer);
    clearInterval(state.signalTimer);
    state.peerConnections.forEach((peer) => peer.close());
    state.localStream?.getTracks().forEach((track) => track.stop());
    state.screenStream?.getTracks().forEach((track) => track.stop());
    window.location.href = `/?code=${encodeURIComponent(roomCode)}`;
  }
});

window.addEventListener("beforeunload", () => {
  if (!state.participant) {
    return;
  }

  navigator.sendBeacon(
    "/api/rooms/leave",
    new Blob(
      [
        JSON.stringify({
          roomCode,
          sessionId: state.participant.sessionId,
          authToken: state.authToken
        })
      ],
      { type: "application/json" }
    )
  );
});

async function init() {
  if (!roomCode) {
    window.location.href = "/";
    return;
  }

  if (!roomPassword) {
    window.location.href = `/?code=${encodeURIComponent(roomCode)}`;
    return;
  }

  state.mediaE2EEAvailable = mediaTransformsSupported() && window.isSecureContext && Boolean(window.crypto?.subtle);
  state.mediaE2EEEnabled = state.mediaE2EEAvailable;

  await ensureConfig();
  updateSecureBadge();
  renderSecureAction();
  setInviteLink();
  toggleEmptyRemoteState();
  roomCodeBadgeEl.textContent = roomCode;
  currentUserNameEl.textContent = userName;

  if (!window.isSecureContext) {
    setHint("هشدار: این صفحه با HTTP باز شده و مرورگر ممکن است دوربین، میکروفون و اشتراک صفحه را کاملا مسدود کند.");
  } else if (state.mediaE2EEEnabled) {
    setHint("رمزنگاری سرتاسری برای چت، سیگنال دهی و رسانه در این مرورگر فعال شد.");
  } else {
    setHint("چت و سیگنال دهی E2E فعال است. E2EE رسانه در این مرورگر یا این حالت پشتیبانی نمی شود.");
  }

  await setupLocalMedia();
  await joinRoom();
  await refreshRoom();
  if (!state.localStream) {
    setHint("بدون رسانه زنده وارد شدید؛ چت فعال است و بعدا می توانید مجوز رسانه را بدهید.");
  }

  state.refreshTimer = setInterval(refreshRoom, 2500);
  state.signalTimer = setInterval(pollSignals, 1200);
}

openSecureBtn?.addEventListener("click", () => {
  if (!state.config?.httpsEnabled) {
    setHint("نسخه امن روی این سرور فعال نشده است.");
    return;
  }

  const secureUrl = `https://${location.hostname}:${state.config.httpsPort}/room.html?code=${encodeURIComponent(roomCode)}&name=${encodeURIComponent(userName)}`;
  window.location.href = secureUrl;
});

init().catch((error) => {
  setHint(error.message);
});

const params = new URLSearchParams(window.location.search);
const sessionSeed = JSON.parse(sessionStorage.getItem("meetingSession") || "{}");
const roomCode = (params.get("code") || sessionSeed.roomCode || "").toUpperCase();
const userName = params.get("name") || sessionSeed.userName || "";
const ROOM_ENCRYPTION_PREFIX = "enc:v1:";

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
  heartbeatTimer: null,
  config: null,
  joined: false,
  messagesLoaded: false,
  renderedMessageCount: 0,
  connectionReady: false,
  roomCryptoKey: null
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
const connectionLoader = document.getElementById("connectionLoader");

function setHint(text) {
  connectionHint.textContent = text;
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function uint8ArrayToBase64(bytes) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

async function importRoomCryptoKey() {
  if (!sessionSeed.roomKey) {
    return null;
  }

  try {
    const rawKey = base64ToUint8Array(sessionSeed.roomKey);
    return await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt", "decrypt"]);
  } catch {
    return null;
  }
}

async function encryptMessageText(text) {
  if (!state.roomCryptoKey) {
    return text;
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    state.roomCryptoKey,
    new TextEncoder().encode(text)
  );
  return `${ROOM_ENCRYPTION_PREFIX}${uint8ArrayToBase64(iv)}:${uint8ArrayToBase64(new Uint8Array(encrypted))}`;
}

async function decryptMessageText(text) {
  if (!text || !text.startsWith(ROOM_ENCRYPTION_PREFIX) || !state.roomCryptoKey) {
    return text;
  }

  try {
    const encoded = text.slice(ROOM_ENCRYPTION_PREFIX.length);
    const [ivPart, cipherPart] = encoded.split(":");
    if (!ivPart || !cipherPart) {
      return "[پیام رمزگشایی نشد]";
    }
    const iv = base64ToUint8Array(ivPart);
    const cipherBytes = base64ToUint8Array(cipherPart);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      state.roomCryptoKey,
      cipherBytes
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    return "[پیام رمزگشایی نشد]";
  }
}

function setConnectionLoader(loading) {
  if (!connectionLoader) {
    return;
  }

  connectionLoader.classList.toggle("hidden", !loading);
}

function persistSession() {
  sessionStorage.setItem(
    "meetingSession",
    JSON.stringify({
      roomCode,
      userName,
      authToken: state.authToken,
      participantSessionId: state.participant?.sessionId,
      roomKey: sessionSeed.roomKey,
      inviteToken: sessionSeed.inviteToken
    })
  );
}

function updateSecureBadge() {
  if (window.isSecureContext) {
    secureStateBadge.textContent = "اتصال امن فعال";
    secureStateBadge.className = "status-pill success";
    return;
  }

  secureStateBadge.textContent = "اتصال ناامن";
  secureStateBadge.className = "status-pill warning";
}

function setInviteLink() {
  const inviteUrl = `${location.origin}/join-room.html?code=${encodeURIComponent(roomCode)}&token=${encodeURIComponent(sessionSeed.inviteToken || "")}`;
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

  retryMediaBtn.textContent = state.localStream
    ? "اتصال دوباره دوربین/میکروفون"
    : "فعال‌سازی دوربین/میکروفون";
}

function explainMediaError(error, featureName) {
  if (!window.isSecureContext) {
    return `${featureName} روی اتصال ناامن HTTP در شبکه داخلی توسط مرورگر مسدود می‌شود. برنامه را با HTTPS محلی باز کنید.`;
  }

  if (error?.name === "NotAllowedError") {
    return `دسترسی ${featureName} در مرورگر رد شده است. مجوز دوربین/میکروفون/صفحه را Allow کنید.`;
  }

  if (error?.name === "NotFoundError") {
    return `${featureName} پیدا نشد. دوربین، میکروفون یا نمایشگر روی سیستم شناسایی نشده است.`;
  }

  if (error?.name === "NotReadableError") {
    return `${featureName} توسط برنامه دیگری در حال استفاده است یا سیستم اجازه دسترسی نمی‌دهد.`;
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
    if (response.status === 429) {
      throw new Error("سرور موقتاً درخواست‌های زیاد دریافت کرده است. چند ثانیه دیگر تلاش کنید.");
    }
    throw new Error(data.error || "خطا در ارتباط با سرور");
  }
  if (data.renewedAuthToken) {
    state.authToken = data.renewedAuthToken;
    persistSession();
  }

  return data;
}

function renderParticipants() {
  participantsListEl.innerHTML = "";
  participantCountEl.textContent = `${state.participants.length} نفر`;

  if (state.participants.length === 0) {
    const item = document.createElement("li");
    item.className = "empty-item";
    item.textContent = "هنوز شرکت‌کننده‌ای ثبت نشده است.";
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

async function renderMessages(messages) {
  messagesEl.innerHTML = "";
  state.renderedMessageCount = messages.length;

  if (!messages.length) {
    const wrapper = document.createElement("div");
    wrapper.className = "message empty";
    wrapper.textContent = "هنوز پیامی ارسال نشده است. گفتگو را شما شروع کنید.";
    messagesEl.appendChild(wrapper);
    return;
  }

  for (const message of messages) {
    // eslint-disable-next-line no-await-in-loop
    await appendMessage(message, false);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function appendMessage(message, scroll = true) {
  const emptyMessage = messagesEl.querySelector(".message.empty");
  if (emptyMessage) {
    emptyMessage.remove();
  }

  const wrapper = document.createElement("div");
  wrapper.className = "message";
  const senderEl = document.createElement("strong");
  senderEl.textContent = message.sender;
  const textEl = document.createElement("span");
  textEl.textContent = await decryptMessageText(message.text);
  wrapper.append(senderEl, textEl);
  messagesEl.appendChild(wrapper);

  if (scroll) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
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
    setHint("این مرورگر از دسترسی به دوربین و میکروفون پشتیبانی نمی‌کند.");
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
      successText: "فقط دوربین فعال شد؛ برای صدا می‌توانید چت را هم استفاده کنید."
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
    iceServers: [
      ...(state.config?.turnUrls?.length
        ? [
            {
              urls: state.config.turnUrls,
              username: state.config.turnUsername || undefined,
              credential: state.config.turnCredential || undefined
            }
          ]
        : []),
      ...(state.config?.stunPort
        ? [
            {
              urls: [`stun:${location.hostname}:${state.config.stunPort}`]
            }
          ]
        : [])
    ],
    iceTransportPolicy: state.config?.forceRelay ? "relay" : "all",
    iceCandidatePoolSize: 4
  });

  if (state.localStream) {
    state.localStream.getTracks().forEach((track) => {
      peer.addTrack(track, state.localStream);
    });
  }

  peer.ontrack = (event) => {
    const remoteVideo = ensureRemoteCard(remoteParticipant.sessionId, remoteParticipant.name);
    remoteVideo.srcObject = event.streams[0];
  };

  peer.onicecandidate = async (event) => {
    if (!event.candidate) {
      return;
    }

    await sendSignal("ice-candidate", remoteParticipant.sessionId, event.candidate);
  };

  peer.onnegotiationneeded = async () => {
    if (!state.connectionReady || !state.participant) {
      return;
    }
    if (peer.signalingState !== "stable") {
      return;
    }
    try {
      await createOffer(remoteParticipant.sessionId);
    } catch (error) {
      console.error("Negotiation error", error);
    }
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
      setHint(`رسانه با ${remoteParticipant.name} متصل شد.`);
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
  await sendSignal("offer", remoteSessionId, offer);
}

async function createAnswer(remoteSessionId, offer) {
  const remoteParticipant = state.participants.find((item) => item.sessionId === remoteSessionId);
  if (!remoteParticipant) {
    return;
  }

  const peer = buildPeerConnection(remoteParticipant, false);
  await peer.setRemoteDescription(new RTCSessionDescription(offer));
  await flushPendingCandidates(remoteSessionId);
  const answer = await peer.createAnswer();
  await peer.setLocalDescription(answer);
  await sendSignal("answer", remoteSessionId, answer);
}

async function handleAnswer(remoteSessionId, answer) {
  const peer = state.peerConnections.get(remoteSessionId);
  if (!peer) {
    return;
  }

  await peer.setRemoteDescription(new RTCSessionDescription(answer));
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
  await api("/api/signals", {
    method: "POST",
    body: JSON.stringify({
      roomCode,
      type,
      fromSessionId: state.participant.sessionId,
      authToken: state.authToken,
      toSessionId,
      payload
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
      if (signal.type === "offer") {
        await createAnswer(signal.fromSessionId, signal.payload);
      } else if (signal.type === "answer") {
        await handleAnswer(signal.fromSessionId, signal.payload);
      } else if (signal.type === "ice-candidate") {
        await handleIceCandidate(signal.fromSessionId, signal.payload);
      }
    }
  } catch (error) {
    setHint(error.message || "خطا در دریافت سیگنال‌ها");
  }
}

async function sendHeartbeat() {
  if (!state.joined || !state.participant || !state.authToken) {
    return;
  }

  try {
    await api("/api/rooms/heartbeat", {
      method: "POST",
      body: JSON.stringify({
        roomCode,
        sessionId: state.participant.sessionId,
        authToken: state.authToken
      })
    });
  } catch (error) {
    console.error("heartbeat failed", error);
  }
}

async function refreshRoom() {
  try {
    const data = await api(
      `/api/rooms/detail?roomCode=${encodeURIComponent(roomCode)}&sessionId=${encodeURIComponent(
        state.participant?.sessionId || ""
      )}&authToken=${encodeURIComponent(state.authToken || "")}`
    );
    state.room = data.room;
    state.participants = data.room.participants || [];
    roomTitleEl.textContent = data.room.title;
    roomCodeBadgeEl.textContent = data.room.code;
    currentUserNameEl.textContent = userName;
    renderParticipants();

    if (!state.messagesLoaded) {
      await renderMessages(data.messages || []);
      state.messagesLoaded = true;
    } else {
      const messages = data.messages || [];
      const newMessages = messages.slice(state.renderedMessageCount);
      for (const message of newMessages) {
        // eslint-disable-next-line no-await-in-loop
        await appendMessage(message);
      }
      state.renderedMessageCount = messages.length;
    }

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
    const videoTrack = stream.getVideoTracks()[0];
    const audioTrack = stream.getAudioTracks()[0];

    const videoSender = senders.find((sender) => sender.track?.kind === "video");
    const audioSender = senders.find((sender) => sender.track?.kind === "audio");

    if (videoSender && videoTrack) {
      videoSender.replaceTrack(videoTrack);
    } else if (!videoSender && videoTrack) {
      peer.addTrack(videoTrack, stream);
    }

    if (audioSender && audioTrack) {
      audioSender.replaceTrack(audioTrack);
    } else if (!audioSender && audioTrack) {
      peer.addTrack(audioTrack, stream);
    }
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
  setHint("در حال تلاش دوباره برای فعال‌سازی دوربین و میکروفون...");
  try {
    await setupLocalMedia(true);
  } finally {
    retryMediaBtn.disabled = false;
  }
});

shareScreenBtn.addEventListener("click", async () => {
  try {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setHint("این مرورگر از اشتراک صفحه پشتیبانی نمی‌کند.");
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
    setHint("لینک ورود کپی شد.");
  } catch (error) {
    const textArea = document.createElement("textarea");
    textArea.value = inviteText;
    textArea.setAttribute("readonly", "true");
    textArea.className = "copy-fallback";
    document.body.appendChild(textArea);
    textArea.select();
    const copied = document.execCommand("copy");
    textArea.remove();
    setHint(copied ? "لینک ورود کپی شد." : "کپی خودکار ممکن نشد. لینک را دستی کپی کنید.");
  }
});

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text) {
    return;
  }

  try {
    const encryptedText = await encryptMessageText(text);
    await api("/api/messages", {
      method: "POST",
      body: JSON.stringify({
        roomCode,
        sessionId: state.participant.sessionId,
        authToken: state.authToken,
        text: encryptedText
      })
    });
    await appendMessage({ sender: userName, text: encryptedText });
    state.renderedMessageCount += 1;
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
    clearInterval(state.heartbeatTimer);
    state.peerConnections.forEach((peer) => peer.close());
    state.localStream?.getTracks().forEach((track) => track.stop());
    state.screenStream?.getTracks().forEach((track) => track.stop());
    sessionStorage.removeItem("meetingSession");
    window.location.href = "/";
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
  sessionStorage.removeItem("meetingSession");
});

window.addEventListener("offline", () => {
  setHint("اتصال شبکه شما قطع شد. پس از وصل شدن، ارتباط جلسه به‌صورت خودکار ادامه پیدا می‌کند.");
});

window.addEventListener("online", () => {
  setHint("اتصال شبکه برقرار شد. در حال همگام‌سازی مجدد جلسه...");
  refreshRoom().catch(() => {});
  pollSignals().catch(() => {});
});

async function init() {
  if (!roomCode || !userName || !sessionSeed.authToken || !sessionSeed.participantSessionId || !sessionSeed.roomKey) {
    window.location.href = `/join-room.html?code=${encodeURIComponent(roomCode || "")}`;
    return;
  }

  await ensureConfig();
  setConnectionLoader(true);
  updateSecureBadge();
  renderSecureAction();
  setInviteLink();
  toggleEmptyRemoteState();
  roomCodeBadgeEl.textContent = roomCode;
  currentUserNameEl.textContent = userName;
  state.roomCryptoKey = await importRoomCryptoKey();
  if (!state.roomCryptoKey) {
    window.location.href = `/join-room.html?code=${encodeURIComponent(roomCode || "")}`;
    return;
  }
  state.authToken = sessionSeed.authToken;
  state.participant = {
    sessionId: sessionSeed.participantSessionId,
    name: userName
  };
  state.joined = true;

  if (!window.isSecureContext) {
    setHint("هشدار: این صفحه با HTTP باز شده و مرورگر ممکن است دوربین، میکروفون و اشتراک صفحه را کاملاً مسدود کند.");
  }

  await refreshRoom();
  await pollSignals();
  state.connectionReady = true;
  setConnectionLoader(false);
  setMediaButtonsState();
  setHint("اتصال جلسه کامل شد. در صورت نیاز دوربین و میکروفون را فعال کنید.");

  state.refreshTimer = setInterval(refreshRoom, 2500);
  state.signalTimer = setInterval(pollSignals, 1200);
  state.heartbeatTimer = setInterval(sendHeartbeat, 10_000);
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
  setConnectionLoader(false);
  setHint(error.message);
});

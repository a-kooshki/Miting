const form = document.getElementById("joinRoomForm");
const statusText = document.getElementById("statusText");
const params = new URLSearchParams(window.location.search);
const roomCodeInput = form.elements.roomCode;

const saved = JSON.parse(sessionStorage.getItem("meetingSession") || "{}");
form.elements.userName.value = saved.userName || "";
form.elements.roomCode.value = (params.get("code") || saved.roomCode || "").toUpperCase();
form.elements.roomPassword.value = saved.roomPassword || "";
form.elements.inviteToken.value = params.get("token") || saved.inviteToken || "";

function setStatus(message, type = "") {
  statusText.textContent = message;
  statusText.className = type;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

async function deriveRoomKey(password, roomCode) {
  const encoder = new TextEncoder();
  const baseKey = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveKey"
  ]);
  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: encoder.encode(`graph-room-${roomCode}`),
      iterations: 600_000,
      hash: "SHA-256"
    },
    baseKey,
    {
      name: "AES-GCM",
      length: 256
    },
    true,
    ["encrypt", "decrypt"]
  );
  const exported = await crypto.subtle.exportKey("raw", key);
  return arrayBufferToBase64(exported);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "خطا در ارتباط با سرور");
  }
  return data;
}

roomCodeInput.addEventListener("input", () => {
  roomCodeInput.value = roomCodeInput.value.toUpperCase().replace(/[^A-Z0-9-]/g, "");
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(form);
  const userName = String(formData.get("userName") || "").trim();
  const roomCode = String(formData.get("roomCode") || "").trim().toUpperCase();
  const roomPassword = String(formData.get("roomPassword") || "").trim();
  const roomPin = String(formData.get("roomPin") || "").replace(/\D/g, "");
  const inviteToken = String(formData.get("inviteToken") || "").trim();
  if (roomPassword.length < 8) {
    setStatus("رمز روم باید حداقل ۸ کاراکتر باشد.", "status-error");
    return;
  }
  if (roomPin.length < 4 || !inviteToken) {
    setStatus("PIN و توکن دعوت الزامی هستند.", "status-error");
    return;
  }

  try {
    setStatus("در حال بررسی و ورود...");
    const data = await api("/api/rooms/join", {
      method: "POST",
      body: JSON.stringify({ userName, roomCode, roomPassword, roomPin, inviteToken })
    });
    const roomKey = await deriveRoomKey(roomPassword, roomCode);

    sessionStorage.setItem(
      "meetingSession",
      JSON.stringify({
        roomCode,
        userName,
        authToken: data.authToken,
        participantSessionId: data.participant?.sessionId,
        roomKey,
        inviteToken
      })
    );

    window.location.href = `/room.html?code=${encodeURIComponent(roomCode)}`;
  } catch (error) {
    setStatus(error.message, "status-error");
  }
});

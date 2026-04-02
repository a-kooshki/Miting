const form = document.getElementById("joinRoomForm");
const statusText = document.getElementById("statusText");
const params = new URLSearchParams(window.location.search);
const roomCodeInput = form.elements.roomCode;

const saved = JSON.parse(sessionStorage.getItem("meetingSession") || "{}");
form.elements.userName.value = saved.userName || "";
form.elements.roomCode.value = (params.get("code") || saved.roomCode || "").toUpperCase();
form.elements.roomPassword.value = saved.roomPassword || "";

function setStatus(message, type = "") {
  statusText.textContent = message;
  statusText.className = type;
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

  try {
    setStatus("در حال بررسی و ورود...");
    const data = await api("/api/rooms/join", {
      method: "POST",
      body: JSON.stringify({ userName, roomCode, roomPassword })
    });

    sessionStorage.setItem(
      "meetingSession",
      JSON.stringify({
        roomCode,
        userName,
        authToken: data.authToken,
        participantSessionId: data.participant?.sessionId,
        roomPassword
      })
    );

    window.location.href = `/room.html?code=${encodeURIComponent(roomCode)}`;
  } catch (error) {
    setStatus(error.message, "status-error");
  }
});

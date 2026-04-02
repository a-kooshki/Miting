const form = document.getElementById("createRoomForm");
const statusText = document.getElementById("statusText");

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

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(form);
  const ownerName = String(formData.get("ownerName") || "").trim();
  const roomTitle = String(formData.get("roomTitle") || "").trim();
  const roomPassword = String(formData.get("roomPassword") || "").trim();
  const roomPin = String(formData.get("roomPin") || "").replace(/\D/g, "");
  if (roomPassword.length < 8) {
    setStatus("رمز روم باید حداقل ۸ کاراکتر باشد.", "status-error");
    return;
  }
  if (roomPin.length < 4) {
    setStatus("PIN ورود باید حداقل ۴ رقم باشد.", "status-error");
    return;
  }

  try {
    setStatus("در حال ساخت روم...");
    const data = await api("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ ownerName, roomTitle, roomPassword, roomPin })
    });
    sessionStorage.setItem(
      "meetingSession",
      JSON.stringify({ roomCode: data.room.code, userName: ownerName, inviteToken: data.inviteToken })
    );
    setStatus(`روم ساخته شد. کد روم: ${data.room.code}`, "status-success");
    window.location.href = `/join-room.html?code=${encodeURIComponent(data.room.code)}&token=${encodeURIComponent(data.inviteToken)}`;
  } catch (error) {
    setStatus(error.message, "status-error");
  }
});

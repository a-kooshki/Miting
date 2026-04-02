const createRoomForm = document.getElementById("createRoomForm");
const joinRoomForm = document.getElementById("joinRoomForm");
const statusText = document.getElementById("statusText");
const secureHint = document.getElementById("secureHint");
const ownerNameInput = createRoomForm.elements.ownerName;
const joinUserNameInput = joinRoomForm.elements.userName;
const roomCodeInput = joinRoomForm.elements.roomCode;
const STORAGE_KEYS = {
  name: "meetingDisplayName",
  roomCode: "meetingLastRoomCode"
};

function setStatus(message, type = "") {
  statusText.textContent = message;
  statusText.className = type;
}

function setFormPending(form, pending) {
  const submitButton = form.querySelector('button[type="submit"]');
  Array.from(form.elements).forEach((element) => {
    element.disabled = pending;
  });

  if (submitButton) {
    submitButton.textContent = pending
      ? form.id === "createRoomForm"
        ? "در حال ساخت..."
        : "در حال ورود..."
      : form.id === "createRoomForm"
        ? "ایجاد اتاق"
        : "ورود به جلسه";
  }
}

function rememberUser(name, roomCode = "") {
  if (name) {
    localStorage.setItem(STORAGE_KEYS.name, name);
  }
  if (roomCode) {
    localStorage.setItem(STORAGE_KEYS.roomCode, roomCode);
  }
}

function hydrateForms() {
  const savedName = localStorage.getItem(STORAGE_KEYS.name) || "";
  const savedRoomCode = localStorage.getItem(STORAGE_KEYS.roomCode) || "";

  ownerNameInput.value = savedName;
  joinUserNameInput.value = savedName;
  roomCodeInput.value = savedRoomCode;
}

async function loadConfigNotice() {
  try {
    const config = await api("/api/config");
    if (window.isSecureContext) {
      secureHint.textContent = "اتصال امن فعال است؛ دوربین، میکروفون و اشتراک صفحه باید در دسترس باشند.";
      return;
    }

    if (config.httpsEnabled) {
      secureHint.textContent = `برای رسانه زنده، نسخه امن را با https://${location.hostname}:${config.httpsPort} باز کنید.`;
    } else {
      secureHint.textContent =
        "روی آدرس HTTP داخل شبکه، مرورگر معمولاً دوربین/میکروفون/اشتراک صفحه را مسدود می‌کند. گواهی محلی HTTPS بسازید.";
    }
  } catch (error) {
    secureHint.textContent = "وضعیت اتصال امن مشخص نشد.";
  }
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

createRoomForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(createRoomForm);
  const ownerName = String(formData.get("ownerName") || "").trim();
  const roomTitle = String(formData.get("roomTitle") || "").trim();

  try {
    setFormPending(createRoomForm, true);
    setStatus("در حال ساخت اتاق...", "");
    const data = await api("/api/rooms", {
      method: "POST",
      body: JSON.stringify({
        ownerName,
        roomTitle
      })
    });

    rememberUser(data.owner.name, data.room.code);
    sessionStorage.setItem(
      "meetingSession",
      JSON.stringify({
        roomCode: data.room.code,
        userName: data.owner.name
      })
    );
    setStatus(`اتاق ساخته شد. کد اتاق: ${data.room.code}`, "status-success");
    window.location.href = `/room.html?code=${data.room.code}`;
  } catch (error) {
    setStatus(error.message, "status-error");
  } finally {
    setFormPending(createRoomForm, false);
  }
});

joinRoomForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(joinRoomForm);
  const roomCode = String(formData.get("roomCode") || "").trim().toUpperCase();
  const userName = String(formData.get("userName") || "").trim();

  if (!roomCode || !userName) {
    setStatus("نام کاربر و کد اتاق لازم است.", "status-error");
    return;
  }

  rememberUser(userName, roomCode);
  sessionStorage.setItem(
    "meetingSession",
    JSON.stringify({
      roomCode,
      userName
    })
  );
  setFormPending(joinRoomForm, true);
  setStatus("در حال ورود به جلسه...", "");
  window.location.href = `/room.html?code=${encodeURIComponent(roomCode)}`;
});

roomCodeInput.addEventListener("input", () => {
  roomCodeInput.value = roomCodeInput.value.toUpperCase().replace(/[^A-Z0-9-]/g, "");
});

hydrateForms();
loadConfigNotice();

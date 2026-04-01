const createRoomForm = document.getElementById("createRoomForm");
const joinRoomForm = document.getElementById("joinRoomForm");
const statusText = document.getElementById("statusText");
const secureHint = document.getElementById("secureHint");
const encryptionHint = document.getElementById("encryptionHint");
const inviteHint = document.getElementById("inviteHint");
const securityFacts = document.getElementById("securityFacts");
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
  if (name) localStorage.setItem(STORAGE_KEYS.name, name);
  if (roomCode) localStorage.setItem(STORAGE_KEYS.roomCode, roomCode);
}

function getSharedRoomCode() {
  const params = new URLSearchParams(window.location.search);
  return String(params.get("code") || "").trim().toUpperCase();
}

function hydrateForms() {
  const savedName = localStorage.getItem(STORAGE_KEYS.name) || "";
  const savedRoomCode = getSharedRoomCode() || localStorage.getItem(STORAGE_KEYS.roomCode) || "";

  ownerNameInput.value = savedName;
  joinUserNameInput.value = savedName;
  roomCodeInput.value = savedRoomCode;

  if (getSharedRoomCode()) {
    roomCodeInput.readOnly = true;
    inviteHint.textContent = `لینک دعوت باز شده است. کد ${savedRoomCode} خودکار قرار گرفت.`;
  }
}

function renderSecurityFacts(profile) {
  securityFacts.innerHTML = "";
  const facts = [
    `سطح امنیت: ${profile.securityTier}`,
    `وابستگی بیرونی: ${profile.externalDependency}`,
    `ذخیره‌سازی: ${profile.storage}`,
    `کلاس شبکه: ${profile.networkScope}`
  ];

  facts.forEach((item) => {
    const card = document.createElement("div");
    card.className = "mini-tip";
    const [label, value] = item.split(": ");
    card.innerHTML = `<strong>${label}</strong><span>${value}</span>`;
    securityFacts.appendChild(card);
  });
}

async function loadConfigNotice() {
  try {
    const [config, profile] = await Promise.all([api("/api/config"), api("/api/graph/profile")]);

    secureHint.textContent = window.isSecureContext
      ? "اتصال امن فعال است."
      : config.httpsEnabled
        ? `برای امنیت کامل از https://${location.hostname}:${config.httpsPort} استفاده کنید.`
        : "HTTPS غیرفعال است؛ برای رسانه امن گواهی محلی بسازید.";

    encryptionHint.textContent =
      "چت و سیگنالینگ رمزنگاری می‌شود و کلیدها با چرخش دوره‌ای از رمز اتاق مشتق می‌شوند.";
    renderSecurityFacts(profile);
  } catch {
    secureHint.textContent = "وضعیت امنیت قابل دریافت نیست.";
    encryptionHint.textContent = "پروفایل امنیتی در دسترس نیست.";
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "خطا در ارتباط با سرور");
  return data;
}

createRoomForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(createRoomForm);
  const ownerName = String(formData.get("ownerName") || "").trim();
  const roomTitle = String(formData.get("roomTitle") || "").trim();
  const roomPassword = String(formData.get("roomPassword") || "");

  try {
    setFormPending(createRoomForm, true);
    setStatus("در حال ساخت اتاق...");
    const data = await api("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ ownerName, roomTitle, roomPassword })
    });

    rememberUser(data.owner.name, data.room.code);
    sessionStorage.setItem("meetingSession", JSON.stringify({ roomCode: data.room.code, userName: data.owner.name, roomPassword }));
    setStatus(`اتاق ساخته شد: ${data.room.code}`, "status-success");
    window.location.href = `/room.html?code=${encodeURIComponent(data.room.code)}`;
  } catch (error) {
    setStatus(error.message, "status-error");
  } finally {
    setFormPending(createRoomForm, false);
  }
});

joinRoomForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const formData = new FormData(joinRoomForm);
  const roomCode = String(formData.get("roomCode") || "").trim().toUpperCase();
  const userName = String(formData.get("userName") || "").trim();
  const roomPassword = String(formData.get("roomPassword") || "");

  if (!roomCode || !userName || !roomPassword) {
    setStatus("نام کاربر، کد و رمز لازم است.", "status-error");
    return;
  }

  rememberUser(userName, roomCode);
  sessionStorage.setItem("meetingSession", JSON.stringify({ roomCode, userName, roomPassword }));
  setFormPending(joinRoomForm, true);
  setStatus("در حال ورود...");
  window.location.href = `/room.html?code=${encodeURIComponent(roomCode)}`;
});

roomCodeInput.addEventListener("input", () => {
  roomCodeInput.value = roomCodeInput.value.toUpperCase().replace(/[^A-Z0-9-]/g, "");
});

hydrateForms();
loadConfigNotice();

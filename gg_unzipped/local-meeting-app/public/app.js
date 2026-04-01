const createRoomForm = document.getElementById("createRoomForm");
const joinRoomForm = document.getElementById("joinRoomForm");
const statusText = document.getElementById("statusText");
const secureHint = document.getElementById("secureHint");
const encryptionHint = document.getElementById("encryptionHint");
const inviteHint = document.getElementById("inviteHint");
const ownerNameInput = createRoomForm.elements.ownerName;
const joinUserNameInput = joinRoomForm.elements.userName;
const roomCodeInput = joinRoomForm.elements.roomCode;
const roomPasswordInput = joinRoomForm.elements.roomPassword;
const createResult = document.getElementById("createResult");
const createdRoomMeta = document.getElementById("createdRoomMeta");
const createdInviteLink = document.getElementById("createdInviteLink");
const copyCreatedInviteBtn = document.getElementById("copyCreatedInviteBtn");
const enterCreatedRoomBtn = document.getElementById("enterCreatedRoomBtn");
const sharedRoomPreview = document.getElementById("sharedRoomPreview");
const sharedRoomTitle = document.getElementById("sharedRoomTitle");
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

function getSharedRoomCode() {
  const params = new URLSearchParams(window.location.search);
  return String(params.get("code") || "").trim().toUpperCase();
}

function saveMeetingSession(payload) {
  sessionStorage.setItem("meetingSession", JSON.stringify(payload));
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return true;
  }
  const textArea = document.createElement("textarea");
  textArea.value = value;
  textArea.setAttribute("readonly", "true");
  textArea.className = "copy-fallback";
  document.body.appendChild(textArea);
  textArea.select();
  const copied = document.execCommand("copy");
  textArea.remove();
  return copied;
}

function hydrateForms() {
  const savedName = localStorage.getItem(STORAGE_KEYS.name) || "";
  const savedRoomCode = getSharedRoomCode() || localStorage.getItem(STORAGE_KEYS.roomCode) || "";

  ownerNameInput.value = savedName;
  joinUserNameInput.value = savedName;
  roomCodeInput.value = savedRoomCode;

  if (getSharedRoomCode()) {
    roomCodeInput.readOnly = true;
    inviteHint.textContent = `لینک دعوت باز شده است. کد اتاق ${savedRoomCode} به صورت خودکار وارد شد.`;
  }
}

async function loadSharedRoomPreview() {
  const sharedCode = getSharedRoomCode();
  if (!sharedCode) {
    sharedRoomPreview.hidden = true;
    return;
  }
  sharedRoomPreview.hidden = false;
  sharedRoomTitle.textContent = "در حال دریافت اطلاعات اتاق...";
  try {
    const data = await api(`/api/rooms/preview?roomCode=${encodeURIComponent(sharedCode)}`);
    sharedRoomTitle.textContent = `${data.room.title} (${data.room.code})`;
  } catch (error) {
    sharedRoomTitle.textContent = "اتاق پیدا نشد یا لینک معتبر نیست.";
  }
}

async function loadConfigNotice() {
  try {
    const config = await api("/api/config");
    if (window.isSecureContext) {
      secureHint.textContent = "اتصال امن فعال است؛ دوربین، میکروفون و اشتراک صفحه باید در دسترس باشند.";
    } else if (config.httpsEnabled) {
      secureHint.textContent = `برای رسانه زنده، نسخه امن را با https://${location.hostname}:${config.httpsPort} باز کنید.`;
    } else {
      secureHint.textContent =
        "روی آدرس HTTP داخل شبکه، مرورگر معمولاً دوربین/میکروفون/اشتراک صفحه را مسدود می کند. گواهی محلی HTTPS بسازید.";
    }

    encryptionHint.textContent =
      "چت، سیگنال دهی و در مرورگرهای پشتیبانی شده، صوت و تصویر با رمز جلسه و salt چرخشی 5 دقیقه ای محافظت می شوند.";
  } catch (error) {
    secureHint.textContent = "وضعیت اتصال امن مشخص نشد.";
    encryptionHint.textContent = "وضعیت رمزنگاری سرتاسری مشخص نشد.";
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
  const roomPassword = String(formData.get("roomPassword") || "");

  try {
    setFormPending(createRoomForm, true);
    setStatus("در حال ساخت اتاق...", "");
    const data = await api("/api/rooms", {
      method: "POST",
      body: JSON.stringify({
        ownerName,
        roomTitle,
        roomPassword
      })
    });

    rememberUser(data.owner.name, data.room.code);
    saveMeetingSession({
      roomCode: data.room.code,
      userName: data.owner.name,
      roomPassword
    });
    const inviteUrl = `${location.origin}/?code=${encodeURIComponent(data.room.code)}`;
    createdRoomMeta.textContent = `${data.room.title} • کد ${data.room.code}`;
    createdInviteLink.value = inviteUrl;
    createResult.hidden = false;
    setStatus("اتاق ساخته شد. لینک دعوت را کپی کنید و رمز را جداگانه بفرستید.", "status-success");
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
  const roomPassword = String(formData.get("roomPassword") || "");

  if (!roomCode || !userName || !roomPassword) {
    setStatus("نام کاربر، کد اتاق و رمز جلسه لازم است.", "status-error");
    return;
  }

  rememberUser(userName, roomCode);
  saveMeetingSession({
    roomCode,
    userName,
    roomPassword
  });
  setFormPending(joinRoomForm, true);
  setStatus("در حال ورود به جلسه...", "");
  window.location.href = `/room.html?code=${encodeURIComponent(roomCode)}`;
});

roomCodeInput.addEventListener("input", () => {
  roomCodeInput.value = roomCodeInput.value.toUpperCase().replace(/[^A-Z0-9-]/g, "");
});

copyCreatedInviteBtn?.addEventListener("click", async () => {
  try {
    const copied = await copyText(createdInviteLink.value);
    setStatus(copied ? "لینک دعوت کپی شد." : "کپی خودکار ممکن نشد؛ لینک را دستی کپی کنید.", copied ? "status-success" : "status-error");
  } catch (error) {
    setStatus("کپی لینک با خطا مواجه شد.", "status-error");
  }
});

enterCreatedRoomBtn?.addEventListener("click", () => {
  const session = JSON.parse(sessionStorage.getItem("meetingSession") || "{}");
  if (!session.roomCode) {
    setStatus("اطلاعات اتاق پیدا نشد. دوباره اتاق بسازید.", "status-error");
    return;
  }
  window.location.href = `/room.html?code=${encodeURIComponent(session.roomCode)}`;
});

hydrateForms();
loadConfigNotice();
loadSharedRoomPreview();

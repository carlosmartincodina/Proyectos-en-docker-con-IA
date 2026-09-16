"use strict";

/* ================================================================
   Chat App - cliente
   Todo el DOM se construye con createElement/textContent.
   Nunca se usa innerHTML con contenido recibido del servidor.
   ================================================================ */

const $ = (id) => document.getElementById(id);

const els = {
  authView: $("auth-view"),
  chatView: $("chat-view"),
  authSubtitle: $("auth-subtitle"),
  loginForm: $("login-form"),
  registerForm: $("register-form"),
  loginError: $("login-error"),
  registerError: $("register-error"),
  goRegister: $("go-register"),
  goLogin: $("go-login"),
  avatarInput: $("avatar-input"),
  avatarPreview: $("avatar-preview"),
  avatarClear: $("avatar-clear"),
  meName: $("me-name"),
  meAvatar: $("me-avatar"),
  presence: $("presence"),
  logout: $("logout"),
  messages: $("messages"),
  list: $("message-list"),
  historyStatus: $("history-status"),
  scrollTop: $("scroll-top"),
  scrollBottom: $("scroll-bottom"),
  composerForm: $("composer-form"),
  textInput: $("text-input"),
  fileInput: $("file-input"),
  send: $("send"),
  attachment: $("attachment"),
  attachmentName: $("attachment-name"),
  attachmentRemove: $("attachment-remove"),
  composerError: $("composer-error")
};

const state = {
  token: null,
  user: null,
  socket: null,
  oldestId: null,
  hasMore: false,
  loadingOlder: false,
  lastMessage: null,
  firstMessage: null,
  pendingFile: null,
  sending: false
};

const PAGE_SIZE = 50;
const NEAR_BOTTOM_PX = 120;
const LOAD_OLDER_PX = 200;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/* ----------------------------- Tema ----------------------------- */

function currentTheme() {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem("theme", theme);
  } catch (e) {}
  for (const button of document.querySelectorAll("[data-theme-toggle]")) {
    button.textContent = theme === "dark" ? "☀️" : "🌙";
    button.title = theme === "dark" ? "Usar modo claro" : "Usar modo oscuro";
  }
}

for (const button of document.querySelectorAll("[data-theme-toggle]")) {
  button.addEventListener("click", () => applyTheme(currentTheme() === "dark" ? "light" : "dark"));
}
applyTheme(currentTheme());

/* ---------------------------- Sesion ---------------------------- */

function readToken() {
  try {
    return localStorage.getItem("token");
  } catch (e) {
    return null;
  }
}

function writeToken(token) {
  try {
    if (token) localStorage.setItem("token", token);
    else localStorage.removeItem("token");
  } catch (e) {}
}

async function api(url, options = {}) {
  const headers = Object.assign({}, options.headers);
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  if (options.body && !(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body,
    credentials: "same-origin"
  });
  let data = null;
  try {
    data = await response.json();
  } catch (e) {}
  if (!response.ok) {
    const error = new Error((data && data.error) || "Error de red");
    error.status = response.status;
    throw error;
  }
  return data;
}

function showError(el, message) {
  if (!message) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.textContent = message;
  el.hidden = false;
}

/* -------------------------- Vistas ------------------------------ */

function showAuth() {
  els.chatView.hidden = true;
  els.authView.hidden = false;
  const input = els.loginForm.querySelector("input[name=username]");
  if (input) input.focus();
}

function showChat() {
  els.authView.hidden = true;
  els.chatView.hidden = false;
  els.textInput.focus();
}

function setAuthMode(mode) {
  const register = mode === "register";
  els.loginForm.hidden = register;
  els.registerForm.hidden = !register;
  els.authSubtitle.textContent = register
    ? "Elige un nombre y una contraseña"
    : "Entra para continuar la conversación";
  showError(els.loginError, "");
  showError(els.registerError, "");
  const form = register ? els.registerForm : els.loginForm;
  const input = form.querySelector("input[name=username]");
  if (input) input.focus();
}

els.goRegister.addEventListener("click", () => setAuthMode("register"));
els.goLogin.addEventListener("click", () => setAuthMode("login"));

/* ------------------------ Avatar (registro) --------------------- */

els.avatarInput.addEventListener("change", () => {
  const file = els.avatarInput.files && els.avatarInput.files[0];
  els.avatarPreview.textContent = "";
  if (!file) {
    els.avatarPreview.textContent = "👤";
    els.avatarClear.hidden = true;
    return;
  }
  if (file.size > 2 * 1024 * 1024) {
    els.avatarInput.value = "";
    els.avatarPreview.textContent = "👤";
    showError(els.registerError, "El avatar supera el límite de 2 MB.");
    return;
  }
  const img = document.createElement("img");
  img.src = URL.createObjectURL(file);
  img.alt = "";
  els.avatarPreview.appendChild(img);
  els.avatarClear.hidden = false;
});

els.avatarClear.addEventListener("click", () => {
  els.avatarInput.value = "";
  els.avatarPreview.textContent = "👤";
  els.avatarClear.hidden = true;
});

/* --------------------------- Formularios ------------------------ */

els.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError(els.loginError, "");
  const button = els.loginForm.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const data = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        username: els.loginForm.username.value.trim(),
        password: els.loginForm.password.value
      })
    });
    els.loginForm.reset();
    await startSession(data.token, data.user);
  } catch (error) {
    showError(els.loginError, error.message);
  } finally {
    button.disabled = false;
  }
});

els.registerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError(els.registerError, "");
  const button = els.registerForm.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const form = new FormData();
    form.append("username", els.registerForm.username.value.trim());
    form.append("password", els.registerForm.password.value);
    const avatar = els.avatarInput.files && els.avatarInput.files[0];
    if (avatar) form.append("avatar", avatar);

    const data = await api("/api/register", { method: "POST", body: form });
    els.registerForm.reset();
    els.avatarPreview.textContent = "👤";
    els.avatarClear.hidden = true;
    await startSession(data.token, data.user);
  } catch (error) {
    showError(els.registerError, error.message);
  } finally {
    button.disabled = false;
  }
});

els.logout.addEventListener("click", async () => {
  try {
    await api("/api/logout", { method: "POST" });
  } catch (e) {}
  endSession();
});

/* --------------------------- Utilidades ------------------------- */

function parseDate(value) {
  if (!value) return new Date();
  const normalized = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function timeLabel(value) {
  return parseDate(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function dayKey(value) {
  return parseDate(value).toDateString();
}

function dayLabel(value) {
  const date = parseDate(value);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Hoy";
  if (date.toDateString() === yesterday.toDateString()) return "Ayer";
  return date.toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" });
}

function formatSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "";
  const units = ["B", "KB", "MB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

function avatarNode(message) {
  const span = document.createElement("span");
  span.className = "avatar";
  if (message.avatar_url) {
    const img = document.createElement("img");
    img.src = message.avatar_url;
    img.alt = "";
    img.loading = "lazy";
    span.appendChild(img);
  } else {
    span.textContent = (message.username || "?").charAt(0).toUpperCase();
  }
  return span;
}

/* --------------------------- Render ----------------------------- */

function separatorNode(message) {
  const div = document.createElement("div");
  div.className = "day-separator";
  div.dataset.day = dayKey(message.created_at);
  div.textContent = dayLabel(message.created_at);
  return div;
}

function messageNode(message, previous) {
  const wrapper = document.createElement("div");
  wrapper.className = "msg";
  wrapper.dataset.id = String(message.id);
  wrapper.dataset.day = dayKey(message.created_at);
  wrapper.dataset.sender = String(message.sender_id);

  const own = state.user && message.sender_id === state.user.id;
  if (own) wrapper.classList.add("own");

  const stacked =
    previous &&
    previous.sender_id === message.sender_id &&
    dayKey(previous.created_at) === dayKey(message.created_at) &&
    Math.abs(parseDate(message.created_at) - parseDate(previous.created_at)) < 5 * 60 * 1000;
  if (stacked) wrapper.classList.add("stacked");

  wrapper.appendChild(avatarNode(message));

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  const author = document.createElement("span");
  author.className = "author";
  author.textContent = own ? "Tú" : message.username;
  bubble.appendChild(author);

  if (message.message_type === "file") {
    const link = document.createElement("a");
    link.className = "file";
    link.href = message.file_url;
    link.setAttribute("download", message.file_name || "archivo");

    const icon = document.createElement("span");
    icon.className = "icon";
    icon.textContent = "📄";

    const meta = document.createElement("span");
    meta.className = "meta";

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = message.file_name || "archivo";

    const hint = document.createElement("span");
    hint.className = "hint";
    hint.textContent = "Descargar archivo";

    meta.append(name, hint);
    link.append(icon, meta);
    bubble.appendChild(link);
  }

  if (message.text) {
    const body = document.createElement("div");
    body.className = "body";
    body.textContent = message.text;
    bubble.appendChild(body);
  }

  const time = document.createElement("span");
  time.className = "time";
  time.textContent = timeLabel(message.created_at);
  bubble.appendChild(time);

  wrapper.appendChild(bubble);
  return wrapper;
}

function buildFragment(messages, firstPrevious) {
  const fragment = document.createDocumentFragment();
  let previous = firstPrevious;
  for (const message of messages) {
    if (!previous || dayKey(previous.created_at) !== dayKey(message.created_at)) {
      fragment.appendChild(separatorNode(message));
    }
    fragment.appendChild(messageNode(message, previous));
    previous = message;
  }
  return fragment;
}

function clearEmptyState() {
  const empty = els.list.querySelector(".empty-state");
  if (empty) empty.remove();
}

function appendMessages(messages) {
  if (!messages.length) return;
  clearEmptyState();
  els.list.appendChild(buildFragment(messages, state.lastMessage));
  state.lastMessage = messages[messages.length - 1];
  if (!state.firstMessage) state.firstMessage = messages[0];
}

function prependMessages(messages) {
  if (!messages.length) return;
  clearEmptyState();

  const fragment = buildFragment(messages, null);
  const lastOfBlock = messages[messages.length - 1];

  // Si el bloque termina el mismo dia en el que empieza lo ya cargado,
  // el separador que encabeza el contenido actual sobra.
  const firstExisting = els.list.firstElementChild;
  if (
    firstExisting &&
    firstExisting.classList.contains("day-separator") &&
    firstExisting.dataset.day === dayKey(lastOfBlock.created_at)
  ) {
    firstExisting.remove();
  }

  els.list.insertBefore(fragment, els.list.firstChild);
  state.firstMessage = messages[0];
  if (!state.lastMessage) state.lastMessage = lastOfBlock;
}

function showEmptyState() {
  if (els.list.children.length) return;
  const div = document.createElement("div");
  div.className = "empty-state";
  div.textContent = "Todavía no hay mensajes. Escribe el primero.";
  els.list.appendChild(div);
}

/* ---------------------------- Scroll ---------------------------- */

function isNearBottom() {
  const el = els.messages;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
}

function scrollToBottom(smooth) {
  els.messages.scrollTo({
    top: els.messages.scrollHeight,
    behavior: smooth ? "smooth" : "auto"
  });
}

els.scrollTop.addEventListener("click", () => {
  els.messages.scrollTo({ top: 0, behavior: "smooth" });
});

els.scrollBottom.addEventListener("click", () => {
  els.messages.scrollTo({ top: els.messages.scrollHeight, behavior: "smooth" });
});

function updateScrollButtons() {
  const el = els.messages;
  const scrollable = el.scrollHeight - el.clientHeight > 40;
  els.scrollTop.dataset.hidden = String(!scrollable || el.scrollTop <= 8);
  els.scrollBottom.dataset.hidden = String(!scrollable || isNearBottom());
}

els.messages.addEventListener("scroll", () => {
  updateScrollButtons();
  if (els.messages.scrollTop < LOAD_OLDER_PX) loadOlder();
}, { passive: true });

window.addEventListener("resize", updateScrollButtons);

/* ------------------------- Historial ---------------------------- */

async function loadInitial() {
  els.list.textContent = "";
  state.lastMessage = null;
  state.firstMessage = null;

  const data = await api(`/api/messages?limit=${PAGE_SIZE}`);
  state.hasMore = data.has_more;
  state.oldestId = data.oldest_id;
  appendMessages(data.messages);
  showEmptyState();
  requestAnimationFrame(() => {
    scrollToBottom(false);
    updateScrollButtons();
  });
}

async function loadOlder() {
  if (state.loadingOlder || !state.hasMore || !state.oldestId) return;
  state.loadingOlder = true;
  els.historyStatus.hidden = false;

  const el = els.messages;
  const previousHeight = el.scrollHeight;
  const previousTop = el.scrollTop;

  try {
    const data = await api(`/api/messages?limit=${PAGE_SIZE}&before=${state.oldestId}`);
    state.hasMore = data.has_more;
    if (data.messages.length) {
      state.oldestId = data.oldest_id;
      prependMessages(data.messages);
      // Mantener la posicion visual exacta tras insertar arriba.
      el.scrollTop = previousTop + (el.scrollHeight - previousHeight);
    }
  } catch (error) {
    console.error(error);
  } finally {
    els.historyStatus.hidden = true;
    state.loadingOlder = false;
    updateScrollButtons();
  }
}

/* ---------------------------- Socket ---------------------------- */

function connectSocket() {
  if (state.socket) state.socket.disconnect();

  const socket = io({ auth: { token: state.token }, transports: ["websocket", "polling"] });
  state.socket = socket;

  socket.on("connect", () => {
    els.presence.textContent = "En línea";
  });

  socket.on("connect_error", (error) => {
    els.presence.textContent = "Sin conexión";
    if (error && error.message === "unauthorized") endSession();
  });

  socket.on("disconnect", () => {
    els.presence.textContent = "Reconectando…";
  });

  socket.on("presence", (data) => {
    const count = (data && data.users ? data.users.length : 0);
    els.presence.textContent = count === 1 ? "Solo tú en línea" : `${count} usuarios en línea`;
  });

  socket.on("broadcastMessage", (message) => {
    const stick = isNearBottom() || (state.user && message.sender_id === state.user.id);
    appendMessages([message]);
    if (state.oldestId === null) state.oldestId = message.id;
    if (stick) scrollToBottom(true);
    updateScrollButtons();
  });
}

/* ---------------------------- Envio ----------------------------- */

els.fileInput.addEventListener("change", () => {
  const file = els.fileInput.files && els.fileInput.files[0];
  showError(els.composerError, "");
  if (!file) return;
  if (file.size > MAX_FILE_BYTES) {
    els.fileInput.value = "";
    showError(els.composerError, "El archivo supera el límite de 5 MB.");
    return;
  }
  state.pendingFile = file;
  els.attachmentName.textContent = `${file.name} · ${formatSize(file.size)}`;
  els.attachment.hidden = false;
  els.textInput.focus();
});

function clearAttachment() {
  state.pendingFile = null;
  els.fileInput.value = "";
  els.attachment.hidden = true;
  els.attachmentName.textContent = "";
}

els.attachmentRemove.addEventListener("click", clearAttachment);

function autoGrow() {
  els.textInput.style.height = "auto";
  els.textInput.style.height = `${Math.min(els.textInput.scrollHeight, 140)}px`;
}

els.textInput.addEventListener("input", autoGrow);

els.textInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    els.composerForm.requestSubmit();
  }
});

function emitMessage(payload) {
  return new Promise((resolve, reject) => {
    if (!state.socket || !state.socket.connected) {
      reject(new Error("Sin conexión con el servidor."));
      return;
    }
    state.socket.timeout(10000).emit("newChatMessage", payload, (timeoutError, response) => {
      if (timeoutError) return reject(new Error("El servidor no respondió."));
      if (response && response.error) return reject(new Error(response.error));
      resolve(response);
    });
  });
}

els.composerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.sending) return;

  const text = els.textInput.value.trim();
  const file = state.pendingFile;
  if (!text && !file) return;

  state.sending = true;
  els.send.disabled = true;
  showError(els.composerError, "");

  try {
    if (file) {
      const form = new FormData();
      form.append("file", file);
      const upload = await api("/api/upload", { method: "POST", body: form });
      await emitMessage({ type: "file", file_ref: upload.file_ref, text });
      clearAttachment();
    } else {
      await emitMessage({ type: "text", text });
    }
    els.textInput.value = "";
    autoGrow();
  } catch (error) {
    showError(els.composerError, error.message);
  } finally {
    state.sending = false;
    els.send.disabled = false;
    els.textInput.focus();
  }
});

/* -------------------------- Ciclo de vida ----------------------- */

function renderMe() {
  els.meName.textContent = state.user.username;
  els.meAvatar.textContent = "";
  if (state.user.avatar_url) {
    const img = document.createElement("img");
    img.src = state.user.avatar_url;
    img.alt = "";
    els.meAvatar.appendChild(img);
  } else {
    els.meAvatar.textContent = state.user.username.charAt(0).toUpperCase();
  }
}

async function startSession(token, user) {
  state.token = token;
  state.user = user;
  writeToken(token);
  renderMe();
  showChat();
  await loadInitial();
  connectSocket();
}

function endSession() {
  if (state.socket) {
    state.socket.disconnect();
    state.socket = null;
  }
  state.token = null;
  state.user = null;
  state.oldestId = null;
  state.hasMore = false;
  state.lastMessage = null;
  state.firstMessage = null;
  clearAttachment();
  els.list.textContent = "";
  els.textInput.value = "";
  writeToken(null);
  setAuthMode("login");
  showAuth();
}

async function boot() {
  state.token = readToken();
  if (state.token) {
    try {
      const data = await api("/api/me");
      await startSession(state.token, data.user);
      return;
    } catch (error) {
      writeToken(null);
      state.token = null;
    }
  }
  setAuthMode("login");
  showAuth();
}

boot();

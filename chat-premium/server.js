"use strict";

/**
 * Chat App - servidor
 *
 * Express  -> API REST (auth, historial, subida y descarga de archivos)
 * Socket.IO -> mensajeria en tiempo real
 * SQLite    -> unica fuente de verdad (usuarios, sesiones, mensajes)
 *
 * Todo lo persistente vive en DATA_DIR (por defecto /app/data).
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");

const express = require("express");
const { Server } = require("socket.io");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const Database = require("better-sqlite3");

/* ------------------------------------------------------------------ */
/* Configuracion                                                       */
/* ------------------------------------------------------------------ */

const PORT = Number(process.env.PORT || 5000);
const DATA_DIR = process.env.DATA_DIR || "/app/data";
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const AVATARS_DIR = path.join(DATA_DIR, "avatars");
const DB_FILE = path.join(DATA_DIR, "chat.db");

const SESSION_SECRET = process.env.SESSION_SECRET || "";
if (!SESSION_SECRET) {
  console.warn(
    "[chat-app] AVISO: SESSION_SECRET no definido. Se usa un secreto temporal; " +
      "las sesiones y las referencias de archivo se invalidaran al reiniciar."
  );
}
const SECRET = SESSION_SECRET || crypto.randomBytes(32).toString("hex");

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 dias
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_TEXT_LENGTH = 4000;
const COOKIE_NAME = "chat_token";

const AVATAR_MIME = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif"
};

for (const dir of [DATA_DIR, UPLOADS_DIR, AVATARS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

/* ------------------------------------------------------------------ */
/* Base de datos                                                       */
/* ------------------------------------------------------------------ */

const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  avatar_path   TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id    INTEGER NOT NULL,
  text         TEXT,
  message_type TEXT    NOT NULL DEFAULT 'text' CHECK (message_type IN ('text','file')),
  file_name    TEXT,
  file_path    TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username    ON users(username);
CREATE        INDEX IF NOT EXISTS idx_sessions_user     ON sessions(user_id);
CREATE        INDEX IF NOT EXISTS idx_sessions_expires  ON sessions(expires_at);
CREATE        INDEX IF NOT EXISTS idx_messages_created  ON messages(created_at);
CREATE        INDEX IF NOT EXISTS idx_messages_sender   ON messages(sender_id);
CREATE        INDEX IF NOT EXISTS idx_messages_id_desc  ON messages(id DESC);
`);

const q = {
  insertUser: db.prepare(
    "INSERT INTO users (username, password_hash, avatar_path) VALUES (?, ?, ?)"
  ),
  userByName: db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE"),
  userById: db.prepare("SELECT * FROM users WHERE id = ?"),
  insertSession: db.prepare(
    "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)"
  ),
  deleteSession: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
  purgeSessions: db.prepare("DELETE FROM sessions WHERE expires_at < ?"),
  sessionUser: db.prepare(`
    SELECT u.* FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `),
  insertMessage: db.prepare(`
    INSERT INTO messages (sender_id, text, message_type, file_name, file_path)
    VALUES (@sender_id, @text, @message_type, @file_name, @file_path)
  `),
  messageById: db.prepare(`
    SELECT m.id, m.sender_id, m.text, m.message_type, m.file_name, m.created_at,
           u.username, u.avatar_path
    FROM messages m JOIN users u ON u.id = m.sender_id
    WHERE m.id = ?
  `),
  messagePage: db.prepare(`
    SELECT m.id, m.sender_id, m.text, m.message_type, m.file_name, m.created_at,
           u.username, u.avatar_path
    FROM messages m JOIN users u ON u.id = m.sender_id
    WHERE m.id < ?
    ORDER BY m.id DESC
    LIMIT ?
  `),
  fileOfMessage: db.prepare(
    "SELECT file_name, file_path FROM messages WHERE id = ? AND message_type = 'file'"
  )
};

setInterval(() => q.purgeSessions.run(Date.now()), 60 * 60 * 1000).unref();
q.purgeSessions.run(Date.now());

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function sign(value) {
  return crypto.createHmac("sha256", SECRET).update(value).digest("base64url");
}

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  q.insertSession.run(sha256(token), userId, Date.now() + SESSION_TTL_MS);
  return token;
}

function userFromToken(token) {
  if (!token || typeof token !== "string") return null;
  return q.sessionUser.get(sha256(token), Date.now()) || null;
}

function tokenFromRequest(req) {
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) return header.slice(7).trim();
  return parseCookies(req.headers.cookie)[COOKIE_NAME] || null;
}

function setSessionCookie(res, token) {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`
  );
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    avatar_url: user.avatar_path ? `/avatars/${user.avatar_path}` : null,
    created_at: user.created_at
  };
}

function publicMessage(row) {
  return {
    id: row.id,
    sender_id: row.sender_id,
    username: row.username,
    avatar_url: row.avatar_path ? `/avatars/${row.avatar_path}` : null,
    text: row.text,
    message_type: row.message_type,
    file_name: row.file_name,
    file_url: row.message_type === "file" ? `/api/files/${row.id}` : null,
    created_at: row.created_at
  };
}

/** Referencia firmada de un archivo ya subido (evita crear estado temporal). */
function packFileRef(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

function unpackFileRef(ref) {
  if (typeof ref !== "string" || !ref.includes(".")) return null;
  const [body, signature] = ref.split(".");
  if (!body || !signature || !timingSafeEqual(signature, sign(body))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload || typeof payload.p !== "string" || payload.p.includes("/")) return null;
    return payload;
  } catch {
    return null;
  }
}

function safeName(original) {
  const base = path.basename(String(original || "archivo")).replace(/[\u0000-\u001f]/g, "");
  return base.slice(0, 180) || "archivo";
}

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,24}$/;

/* ------------------------------------------------------------------ */
/* Subidas (multer)                                                    */
/* ------------------------------------------------------------------ */

function diskStorage(destination) {
  return multer.diskStorage({
    destination: (req, file, cb) => cb(null, destination),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase().slice(0, 12);
      cb(null, `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext}`);
    }
  });
}

const uploadFile = multer({
  storage: diskStorage(UPLOADS_DIR),
  limits: { fileSize: MAX_FILE_BYTES, files: 1 }
});

const uploadAvatar = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, AVATARS_DIR),
    filename: (req, file, cb) => {
      const ext = AVATAR_MIME[file.mimetype] || ".png";
      cb(null, `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext}`);
    }
  }),
  limits: { fileSize: MAX_AVATAR_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    const extOk = /\.(png|jpe?g|webp|gif)$/i.test(file.originalname || "");
    if (!AVATAR_MIME[file.mimetype] || !extOk) {
      return cb(new Error("Formato de avatar no admitido. Usa PNG, JPG, WEBP o GIF."));
    }
    cb(null, true);
  }
});

/* ------------------------------------------------------------------ */
/* Aplicacion                                                          */
/* ------------------------------------------------------------------ */

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  next();
});

function requireAuth(req, res, next) {
  const user = userFromToken(tokenFromRequest(req));
  if (!user) return res.status(401).json({ error: "No autenticado" });
  req.user = user;
  next();
}

/* ---------------------------- Auth -------------------------------- */

app.post("/api/register", (req, res) => {
  uploadAvatar.single("avatar")(req, res, async (err) => {
    if (err) {
      const message =
        err.code === "LIMIT_FILE_SIZE"
          ? "El avatar supera el limite de 2 MB."
          : err.message || "No se pudo procesar el avatar.";
      return res.status(400).json({ error: message });
    }

    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");
    const cleanup = () => {
      if (req.file) fs.promises.unlink(req.file.path).catch(() => {});
    };

    if (!USERNAME_RE.test(username)) {
      cleanup();
      return res.status(400).json({
        error: "El usuario debe tener entre 3 y 24 caracteres (letras, numeros, . _ -)."
      });
    }
    if (password.length < 6 || password.length > 200) {
      cleanup();
      return res.status(400).json({ error: "La contrasena debe tener al menos 6 caracteres." });
    }
    if (q.userByName.get(username)) {
      cleanup();
      return res.status(409).json({ error: "Ese nombre de usuario ya existe." });
    }

    try {
      const hash = await bcrypt.hash(password, 12);
      const info = q.insertUser.run(username, hash, req.file ? req.file.filename : null);
      const user = q.userById.get(info.lastInsertRowid);
      const token = createSession(user.id);
      setSessionCookie(res, token);
      res.status(201).json({ token, user: publicUser(user) });
    } catch (error) {
      cleanup();
      console.error("[register]", error);
      res.status(500).json({ error: "No se pudo crear la cuenta." });
    }
  });
});

app.post("/api/login", async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const user = q.userByName.get(username);
  const stored = user ? user.password_hash : "$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv";
  const ok = await bcrypt.compare(password, stored);

  if (!user || !ok) {
    return res.status(401).json({ error: "Usuario o contrasena incorrectos." });
  }
  const token = createSession(user.id);
  setSessionCookie(res, token);
  res.json({ token, user: publicUser(user) });
});

app.post("/api/logout", (req, res) => {
  const token = tokenFromRequest(req);
  if (token) q.deleteSession.run(sha256(token));
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

/* -------------------------- Historial ------------------------------ */

app.get("/api/messages", requireAuth, (req, res) => {
  let limit = Number.parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 50;
  limit = Math.min(limit, 100);

  let before = Number.parseInt(req.query.before, 10);
  if (!Number.isFinite(before) || before <= 0) before = Number.MAX_SAFE_INTEGER;

  const rows = q.messagePage.all(before, limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).reverse().map(publicMessage);

  res.json({
    messages: page,
    has_more: hasMore,
    oldest_id: page.length ? page[0].id : null
  });
});

/* --------------------------- Archivos ------------------------------ */

app.post("/api/upload", requireAuth, (req, res) => {
  uploadFile.single("file")(req, res, (err) => {
    if (err) {
      const message =
        err.code === "LIMIT_FILE_SIZE"
          ? "El archivo supera el limite de 5 MB."
          : "No se pudo subir el archivo.";
      return res.status(400).json({ error: message });
    }
    if (!req.file) return res.status(400).json({ error: "No se recibio ningun archivo." });

    const ref = packFileRef({
      u: req.user.id,
      p: req.file.filename,
      n: safeName(req.file.originalname),
      s: req.file.size,
      t: Date.now()
    });

    res.status(201).json({
      file_ref: ref,
      file_name: safeName(req.file.originalname),
      size: req.file.size
    });
  });
});

app.get("/api/files/:id", requireAuth, (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Identificador no valido." });

  const row = q.fileOfMessage.get(id);
  if (!row || !row.file_path) return res.status(404).json({ error: "Archivo no encontrado." });

  const full = path.join(UPLOADS_DIR, path.basename(row.file_path));
  if (!fs.existsSync(full)) return res.status(404).json({ error: "Archivo no encontrado." });

  res.download(full, row.file_name || "archivo");
});

app.get("/avatars/:file", requireAuth, (req, res) => {
  const name = path.basename(req.params.file);
  const full = path.join(AVATARS_DIR, name);
  if (!fs.existsSync(full)) return res.status(404).end();
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.sendFile(full);
});

/* --------------------------- Estatico ------------------------------ */

app.use(express.static(path.join(__dirname, "public"), { index: "index.html" }));

app.use((req, res) => res.status(404).json({ error: "Ruta no encontrada" }));

/* ------------------------------------------------------------------ */
/* Socket.IO                                                           */
/* ------------------------------------------------------------------ */

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 64 * 1024 });

io.use((socket, next) => {
  const token =
    (socket.handshake.auth && socket.handshake.auth.token) ||
    parseCookies(socket.handshake.headers.cookie)[COOKIE_NAME];
  const user = userFromToken(token);
  if (!user) return next(new Error("unauthorized"));
  socket.data.userId = user.id;
  next();
});

function onlineUsernames() {
  const names = new Set();
  for (const socket of io.of("/").sockets.values()) {
    if (socket.data.username) names.add(socket.data.username);
  }
  return [...names].sort();
}

io.on("connection", (socket) => {
  const user = q.userById.get(socket.data.userId);
  if (!user) return socket.disconnect(true);
  socket.data.username = user.username;

  io.emit("presence", { users: onlineUsernames() });

  socket.on("newChatMessage", (payload, ack) => {
    const respond = (result) => {
      if (typeof ack === "function") ack(result);
    };

    // 1. Autenticacion: el emisor sale siempre de la sesion del socket.
    const sender = q.userById.get(socket.data.userId);
    if (!sender) return respond({ error: "Sesion no valida." });

    const data = payload && typeof payload === "object" ? payload : {};
    const type = data.type === "file" ? "file" : "text";

    let row;
    try {
      if (type === "text") {
        // 2. Validacion
        const text = String(data.text || "").replace(/\s+$/g, "").slice(0, MAX_TEXT_LENGTH);
        if (!text.trim()) return respond({ error: "El mensaje esta vacio." });

        // 3. Insercion en SQLite
        const info = q.insertMessage.run({
          sender_id: sender.id,
          text,
          message_type: "text",
          file_name: null,
          file_path: null
        });
        // 4. Recuperacion del mensaje creado
        row = q.messageById.get(info.lastInsertRowid);
      } else {
        const ref = unpackFileRef(data.file_ref);
        if (!ref || ref.u !== sender.id) return respond({ error: "Referencia de archivo no valida." });
        if (!fs.existsSync(path.join(UPLOADS_DIR, ref.p))) {
          return respond({ error: "El archivo ya no esta disponible." });
        }
        const caption = String(data.text || "").slice(0, MAX_TEXT_LENGTH).trim() || null;

        const info = q.insertMessage.run({
          sender_id: sender.id,
          text: caption,
          message_type: "file",
          file_name: safeName(ref.n),
          file_path: ref.p
        });
        row = q.messageById.get(info.lastInsertRowid);
      }
    } catch (error) {
      console.error("[newChatMessage]", error);
      return respond({ error: "No se pudo guardar el mensaje." });
    }

    // 5. Difusion
    const message = publicMessage(row);
    io.emit("broadcastMessage", message);
    respond({ ok: true, message });
  });

  socket.on("disconnect", () => {
    io.emit("presence", { users: onlineUsernames() });
  });
});

/* ------------------------------------------------------------------ */

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[chat-app] escuchando en http://localhost:${PORT}`);
  console.log(`[chat-app] datos en ${DATA_DIR}`);
});

function shutdown() {
  console.log("[chat-app] cerrando...");
  io.close();
  server.close(() => {
    try {
      db.close();
    } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

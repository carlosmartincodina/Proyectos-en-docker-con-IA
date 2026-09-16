"use strict";

/**
 * Chat App - utilidad administrativa
 *
 *   node admin.js users
 *   node admin.js messages [usuario] [limite]
 *   node admin.js reset <usuario> <NuevaPassword>
 *   node admin.js stats
 *
 * Las contrasenas nunca se muestran: solo se almacenan hashes bcrypt.
 */

const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");

const DATA_DIR = process.env.DATA_DIR || "/app/data";
const DB_FILE = path.join(DATA_DIR, "chat.db");

if (!fs.existsSync(DB_FILE)) {
  console.error(`No existe la base de datos en ${DB_FILE}. Arranca el servidor al menos una vez.`);
  process.exit(1);
}

const db = new Database(DB_FILE);
db.pragma("foreign_keys = ON");

function table(rows) {
  if (!rows.length) {
    console.log("(sin resultados)");
    return;
  }
  console.table(rows);
}

function truncate(value, max) {
  const text = value == null ? "" : String(value).replace(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function listUsers() {
  const rows = db
    .prepare(
      `SELECT u.id,
              u.username,
              CASE WHEN u.avatar_path IS NULL THEN 'no' ELSE 'si' END AS avatar,
              u.created_at,
              (SELECT COUNT(*) FROM messages m WHERE m.sender_id = u.id) AS mensajes
       FROM users u ORDER BY u.id`
    )
    .all();
  table(rows);
  console.log(`${rows.length} usuario(s). Las contrasenas se guardan solo como hash bcrypt.`);
}

function listMessages(username, limitArg) {
  let limit = Number.parseInt(limitArg, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 100;

  const base = `SELECT m.id, u.username AS autor, m.message_type AS tipo,
                       m.text, m.file_name, m.created_at
                FROM messages m JOIN users u ON u.id = m.sender_id`;

  const rows = username
    ? db.prepare(`${base} WHERE u.username = ? COLLATE NOCASE ORDER BY m.id DESC LIMIT ?`).all(username, limit)
    : db.prepare(`${base} ORDER BY m.id DESC LIMIT ?`).all(limit);

  table(
    rows
      .reverse()
      .map((r) => ({
        id: r.id,
        autor: r.autor,
        tipo: r.tipo,
        contenido: r.tipo === "file" ? `[archivo] ${truncate(r.file_name, 40)}` : truncate(r.text, 60),
        fecha: r.created_at
      }))
  );
  console.log(`${rows.length} mensaje(s)${username ? ` de "${username}"` : ""}.`);
}

async function resetPassword(username, password) {
  if (!username || !password) {
    console.error("Uso: node admin.js reset <usuario> <NuevaPassword>");
    process.exit(1);
  }
  if (password.length < 6) {
    console.error("La nueva contrasena debe tener al menos 6 caracteres.");
    process.exit(1);
  }

  const user = db.prepare("SELECT id, username FROM users WHERE username = ? COLLATE NOCASE").get(username);
  if (!user) {
    console.error(`El usuario "${username}" no existe.`);
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 12);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, user.id);
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);

  console.log(`Contrasena actualizada para "${user.username}". Sus sesiones abiertas se han cerrado.`);
}

function stats() {
  const users = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  const messages = db.prepare("SELECT COUNT(*) AS n FROM messages").get().n;
  const files = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE message_type = 'file'").get().n;
  const sessions = db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?").get(Date.now()).n;
  table([{ usuarios: users, mensajes: messages, archivos: files, sesiones_activas: sessions, datos: DATA_DIR }]);
}

function help() {
  console.log(`Chat App - administracion

  node admin.js users                              Lista los usuarios
  node admin.js messages                           Ultimos 100 mensajes
  node admin.js messages <usuario>                 Mensajes de un usuario
  node admin.js messages <usuario> <limite>        Limita el numero de mensajes
  node admin.js reset <usuario> <NuevaPassword>    Cambia una contrasena
  node admin.js stats                              Resumen de la instalacion
`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "users":
      listUsers();
      break;
    case "messages":
      listMessages(args[0], args[1]);
      break;
    case "reset":
      await resetPassword(args[0], args[1]);
      break;
    case "stats":
      stats();
      break;
    default:
      help();
      if (command) process.exitCode = 1;
  }
  db.close();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

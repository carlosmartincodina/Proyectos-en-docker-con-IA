# Chat App

Aplicación web de mensajería en tiempo real: cuentas con avatar, mensajes de texto,
envío y descarga de archivos, historial paginado persistente, modo claro/oscuro e
interfaz responsive.

Backend: Node.js 20 · Express · Socket.IO · SQLite · bcryptjs · multer
Frontend: HTML5 · CSS3 · JavaScript vanilla (sin frameworks)
Despliegue: Docker (sin Docker Compose)

---

## 1. Construir la imagen

```bash
docker build -t chat-app .
```

## 2. Crear el volumen de datos

```bash
docker volume create chat_data
```

## 3. Ejecutar el contenedor

```bash
docker run -d \
  --name chat-app \
  -p 5000:5000 \
  -e PORT=5000 \
  -e DATA_DIR=/app/data \
  -e SESSION_SECRET="CAMBIAR_POR_UN_SECRETO_ALEATORIO" \
  -v chat_data:/app/data \
  --restart unless-stopped \
  chat-app
```

Abre la aplicación en:

```text
http://localhost:5000
```

Para generar un secreto aleatorio:

```bash
openssl rand -hex 32
```

`SESSION_SECRET` firma las sesiones y las referencias de archivo. Si cambia, todas
las sesiones abiertas dejan de ser válidas (los datos no se pierden).

---

## 4. Operaciones habituales

| Acción | Comando |
| --- | --- |
| Ver logs | `docker logs -f chat-app` |
| Detener | `docker stop chat-app` |
| Arrancar de nuevo | `docker start chat-app` |
| Reiniciar | `docker restart chat-app` |
| Entrar al contenedor | `docker exec -it chat-app sh` |
| Eliminar el contenedor | `docker stop chat-app && docker rm chat-app` |
| Estado | `docker ps -a --filter name=chat-app` |

Eliminar el contenedor **no** borra los datos: viven en el volumen `chat_data`.

---

## 5. Administración

```bash
# Listar usuarios (nunca se muestran contraseñas, solo hashes bcrypt en la base)
docker exec -it chat-app node admin.js users

# Últimos 100 mensajes
docker exec -it chat-app node admin.js messages

# Mensajes de un usuario concreto
docker exec -it chat-app node admin.js messages usuario

# Mensajes de un usuario limitando el número
docker exec -it chat-app node admin.js messages usuario 20

# Cambiar la contraseña de un usuario (cierra sus sesiones abiertas)
docker exec -it chat-app node admin.js reset usuario NuevaPassword

# Resumen de la instalación
docker exec -it chat-app node admin.js stats
```

---

## 6. Dónde se almacenan los datos

Todo lo persistente está bajo `/app/data`, montado desde el volumen `chat_data`:

```text
/app/data/
├── chat.db      base de datos SQLite (usuarios, sesiones, mensajes)
├── uploads/     archivos enviados en el chat
└── avatars/     imágenes de perfil
```

Inspeccionar el volumen desde el host:

```bash
docker volume inspect chat_data
```

Copia de seguridad:

```bash
docker run --rm -v chat_data:/data -v "$PWD":/backup alpine \
  tar czf /backup/chat_data.tar.gz -C /data .
```

Restauración:

```bash
docker run --rm -v chat_data:/data -v "$PWD":/backup alpine \
  sh -c "rm -rf /data/* && tar xzf /backup/chat_data.tar.gz -C /data"
```

## 7. Conservar el volumen

```bash
docker stop chat-app
docker rm chat-app                 # el volumen sobrevive

docker run -d --name chat-app -p 5000:5000 \
  -e SESSION_SECRET="EL_MISMO_SECRETO" \
  -v chat_data:/app/data --restart unless-stopped chat-app
```

Usuarios, mensajes, avatares y archivos siguen ahí.

El volumen solo se borra de forma explícita:

```bash
docker volume rm chat_data        # destruye TODOS los datos
```

Nunca uses `docker run --rm` ni `docker volume prune` si quieres conservar el historial.

---

## 8. API

| Método | Ruta | Descripción |
| --- | --- | --- |
| POST | `/api/register` | Crea una cuenta (`multipart/form-data`: `username`, `password`, `avatar` opcional) |
| POST | `/api/login` | Inicia sesión y devuelve un token |
| POST | `/api/logout` | Cierra la sesión actual |
| GET | `/api/me` | Usuario autenticado |
| GET | `/api/messages?limit=50&before=150` | Historial paginado (mensajes con `id < before`) |
| POST | `/api/upload` | Sube un archivo (máx. 5 MB) y devuelve una referencia firmada |
| GET | `/api/files/:id` | Descarga el archivo de un mensaje |
| GET | `/avatars/:file` | Imagen de perfil (requiere sesión) |

Autenticación por cookie `HttpOnly` y, en paralelo, por cabecera
`Authorization: Bearer <token>`. Socket.IO usa el mismo token:

```javascript
const socket = io({ auth: { token } });
```

### Eventos Socket.IO

- `connection` / `disconnect`
- `newChatMessage` (cliente → servidor): `{ type: "text", text }` o `{ type: "file", file_ref, text }`
- `broadcastMessage` (servidor → clientes): el mensaje ya persistido
- `presence` (servidor → clientes): usuarios conectados

Flujo de un mensaje: **cliente → socket → validación → SQLite → broadcast**.
Nunca se difunde nada que no se haya guardado antes.

---

## 9. Base de datos

```sql
users(id, username UNIQUE, password_hash, avatar_path, created_at)
sessions(token_hash PK, user_id → users.id, created_at, expires_at)
messages(id, sender_id → users.id, text, message_type, file_name, file_path, created_at)
```

Claves foráneas activadas, índices sobre `username`, `sessions.user_id`,
`sessions.expires_at`, `messages.created_at`, `messages.sender_id` y `messages.id DESC`.
El esquema se crea solo al arrancar el servidor.

---

## 10. Seguridad

- Contraseñas con bcrypt (12 rondas). En la base solo hay `password_hash`.
- El remitente **siempre** se obtiene de la sesión asociada al socket; jamás del cliente.
- Tokens de sesión aleatorios de 256 bits, guardados como hash SHA-256 con caducidad de 30 días.
- Referencias de archivo firmadas con HMAC y ligadas al usuario que las subió.
- Subidas validadas por tamaño (5 MB en archivos, 2 MB en avatares), MIME y extensión en avatares.
- El DOM se construye con `textContent` y `createElement`: no se usa `innerHTML` con datos remotos.

Detrás de un proxy HTTPS público, añade también la marca `Secure` a la cookie
terminando TLS en el proxy y reenviando las cabeceras estándar.

---

## 11. Desarrollo local sin Docker

```bash
npm install
DATA_DIR=./data SESSION_SECRET=dev-secret PORT=5000 node server.js
```

---

## 12. Estructura del proyecto

```text
chat-app/
├── Dockerfile
├── package.json
├── package-lock.json
├── server.js
├── admin.js
├── .dockerignore
├── README.md
└── public/
    ├── index.html
    ├── style.css
    └── app.js
```

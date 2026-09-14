const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const bcrypt = require('bcryptjs');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(__dirname));

const usersInMemory = {}; 
const messagesInMemory = [];

const storage = multer.memoryStorage();
const upload = multer({ storage });

app.get('/uploads/:username', (req, res) => {
    const user = usersInMemory[req.params.username];
    if (user && user.avatarBuffer) {
        res.set('Content-Type', user.avatarMime);
        return res.send(user.avatarBuffer);
    }
    res.set('Content-Type', 'image/svg+xml');
    res.send(`<svg xmlns="http://w3.org" width="40" height="40" viewBox="0 0 40 40"><rect width="40" height="40" fill="#0084ff"/><text x="50%" y="55%" dominant-baseline="middle" text-anchor="middle" fill="white" font-family="sans-serif" font-size="16" font-weight="bold">${req.params.username.toUpperCase()}</text></svg>`);
});

app.post('/api/register', upload.single('avatar'), (req, res) => {
    const { username, password } = req.body;
    if(!username || !password) return res.status(400).json({ error: 'Faltan campos' });

    const cleanUsername = username.trim();
    if (usersInMemory[cleanUsername]) return res.status(400).json({ error: 'El usuario ya existe' });

    usersInMemory[cleanUsername] = {
        username: cleanUsername,
        password: bcrypt.hashSync(password, 8),
        avatarBuffer: req.file ? req.file.buffer : null,
        avatarMime: req.file ? req.file.mimetype : null
    };

    res.json({ username: cleanUsername, avatarUrl: `/uploads/${cleanUsername}`, history: messagesInMemory });
});

app.post('/api/login', upload.none(), (req, res) => {
    const { username, password } = req.body;
    const cleanUsername = username.trim();
    const user = usersInMemory[cleanUsername];

    if(!user || !bcrypt.compareSync(password, user.password)) {
        return res.status(400).json({ error: 'Credenciales incorrectas' });
    }
    res.json({ username: user.username, avatarUrl: `/uploads/${cleanUsername}`, history: messagesInMemory });
});

// WebSockets para Mensajes y Archivos en tiempo real
io.on('connection', (socket) => {
    socket.on('newChatMessage', (data) => {
        const msg = { 
            sender: data.sender, 
            text: data.text, 
            type: data.type || 'text',
            fileData: data.fileData || null 
        };
        messagesInMemory.push(msg);
        io.emit('broadcastMessage', msg);
    });
});

const PORT = 5000;
server.listen(PORT, '0.0.0.0', () => console.log(`Chat Pro corriendo en puerto ${PORT}`));


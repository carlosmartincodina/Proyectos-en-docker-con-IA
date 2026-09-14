const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname)));

let players = []; 
let gameState = {
    secretWord: "",
    guessedLetters: [],
    wrongGuesses: 0,
    status: "setup" // setup, playing, over
};

// Los 7 estados visuales del muñequito del ahorcado en texto ASCII
const gallowsStages = [
`  +---+

  |   |
      |
      |
      |
      |
=========`,
`  +---+

  |   |
  O   |
      |
      |
      |
=========`,
`  +---+

  |   |
  O   |

  |   |
      |
      |
=========`,
`  +---+

  |   |
  O   |
 /|   |
      |
      |
=========`,
`  +---+

  |   |
  O   |
 /|\\  |
      |
      |
=========`,
`  +---+

  |   |
  O   |
 /|\\  |
 /    |
      |
=========`,
`  +---+

  |   |
  O   |
 /|\\  |
 / \\  |
      |
=========`
];

function getMaskedWord() {
    return gameState.secretWord.split('').map(letter => 
        gameState.guessedLetters.includes(letter) ? letter : "_"
    ).join('');
}

function updateRoles() {
    if (players.length < 2) {
        io.emit('waitingForPlayer');
        return;
    }
    // El jugador 0 pone la palabra, el jugador 1 la adivina
    io.to(players[0]).emit('assignRole', 'creator');
    io.to(players[1]).emit('assignRole', 'guesser');
}

io.on('connection', (socket) => {
    if (players.length >= 2) {
        socket.emit('roomFull');
        return;
    }
    
    players.push(socket.id);
    updateRoles();

    socket.on('setWord', (word) => {
        if (socket.id !== players[0] || gameState.status !== "setup") return;
        gameState.secretWord = word;
        gameState.guessedLetters = [];
        gameState.wrongGuesses = 0;
        gameState.status = "playing";
        
        io.emit('gameStarted');
        io.emit('gameState', {
            maskedWord: getMaskedWord(),
            wrongGuesses: gameState.wrongGuesses,
            gallowsVisual: gallowsStages[0]
        });
    });

    socket.on('guessLetter', (letter) => {
        if (socket.id !== players[1] || gameState.status !== "playing") return;
        
        if (!gameState.guessedLetters.includes(letter)) {
            gameState.guessedLetters.push(letter);
            if (!gameState.secretWord.includes(letter)) {
                gameState.wrongGuesses++;
            }
        }

        const masked = getMaskedWord();
        const currentVisual = gallowsStages[gameState.wrongGuesses];

        if (gameState.wrongGuesses >= 6) {
            gameState.status = "over";
            io.emit('gameOver', { result: 'lose', secretWord: gameState.secretWord, gallowsVisual: gallowsStages[6] });
        } else if (!masked.includes("_")) {
            gameState.status = "over";
            io.emit('gameOver', { result: 'win', secretWord: gameState.secretWord, gallowsVisual: currentVisual });
        } else {
            io.emit('gameState', {
                maskedWord: masked,
                wrongGuesses: gameState.wrongGuesses,
                gallowsVisual: currentVisual
            });
        }
    });

    socket.on('playAgain', () => {
        // Invertimos los roles para la siguiente partida
        players.reverse();
        gameState = { secretWord: "", guessedLetters: [], wrongGuesses: 0, status: "setup" };
        updateRoles();
    });

    socket.on('disconnect', () => {
        players = players.filter(id => id !== socket.id);
        gameState = { secretWord: "", guessedLetters: [], wrongGuesses: 0, status: "setup" };
        io.emit('playerDisconnected');
        updateRoles();
    });
});

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Juego del Ahorcado corriendo en el puerto ${PORT}`);
});

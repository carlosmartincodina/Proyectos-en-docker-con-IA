const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname)));

const rooms = {}; 

function checkWinner(board) {
    const wins = [
        [0, 1, 2], [3, 4, 5], [6, 7, 8],
        [0, 3, 6], [1, 4, 7], [2, 5, 8],
        [0, 4, 8], [2, 4, 6]
    ];
    for (let combo of wins) {
        if (board[combo[0]] && board[combo[0]] === board[combo[1]] && board[combo[0]] === board[combo[2]]) {
            return board[combo[0]];
        }
    }
    if (!board.includes("")) return 'Tie';
    return null;
}

io.on('connection', (socket) => {
    socket.on('joinRoom', (room) => {
        if (!rooms[room]) {
            rooms[room] = { players: [socket.id], board: Array(9).fill(""), turn: 'X' };
            socket.join(room);
            socket.emit('roomJoined', { room, symbol: 'X' });
        } else if (rooms[room].players.length === 1) {
            rooms[room].players.push(socket.id);
            socket.join(room);
            socket.emit('roomJoined', { room, symbol: 'O' });
            io.to(room).emit('gameStart');
        } else {
            socket.emit('roomFull');
        }
    });

    socket.on('makeMove', ({ room, index, symbol }) => {
        const game = rooms[room];
        if (!game || game.turn !== symbol || game.board[index] !== "") return;

        game.board[index] = symbol;
        const winner = checkWinner(game.board);

        if (winner) {
            io.to(room).emit('gameOver', { winner, board: game.board });
        } else {
            game.turn = symbol === 'X' ? 'O' : 'X';
            io.to(room).emit('updateBoard', { board: game.board, nextTurn: game.turn });
        }
    });

    socket.on('requestReset', (room) => {
        const game = rooms[room];
        if (game) {
            game.board = Array(9).fill("");
            game.turn = 'X';
            io.to(room).emit('resetGame');
        }
    });

    socket.on('disconnect', () => {
        for (const room in rooms) {
            const index = rooms[room].players.indexOf(socket.id);
            if (index !== -1) {
                rooms[room].players.splice(index, 1);
                io.to(room).emit('playerDisconnected');
                if (rooms[room].players.length === 0) {
                    delete rooms[room];
                }
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});


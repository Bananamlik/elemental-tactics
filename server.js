// server.js - 로비 방 목록 시스템 (v4)
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Render.com 슬립 방지
app.get('/ping', (req, res) => res.sendStatus(200));

// 대기 중인 방 목록
// { roomId: { hostSocket, hostDeck, name, password, createdAt } }
let waitingRooms = {};

function broadcastRoomList() {
    const list = getRoomList();
    io.to('lobby').emit('roomListUpdate', list);
}

function getRoomList() {
    return Object.entries(waitingRooms).map(([id, room]) => ({
        id,
        name: room.name,
        hasPassword: !!room.password,
        createdAt: room.createdAt
    }));
}

io.on('connection', (socket) => {
    console.log('✅ 접속:', socket.id);

    socket.on('enterLobby', () => {
        socket.join('lobby');
        socket.emit('roomList', getRoomList());
    });

    socket.on('leaveLobby', () => {
        socket.leave('lobby');
    });

    socket.on('createRoom', (data) => {
        // [Fix] 이미 대기 중인 방이 있으면 먼저 정리
        if (socket.waitingRoomId && waitingRooms[socket.waitingRoomId]) {
            delete waitingRooms[socket.waitingRoomId];
            broadcastRoomList();
        }

        const name = (data.name || '').trim() || '대결 신청';
        const password = (data.password || '').trim();
        const roomId = `room_${socket.id}_${Date.now()}`;

        socket.deck = data.deck;
        socket.waitingRoomId = roomId;

        waitingRooms[roomId] = {
            hostSocket: socket,
            hostDeck: data.deck,
            name,
            password,
            createdAt: Date.now()
        };

        socket.emit('roomCreated', { roomId, name });
        broadcastRoomList();
        console.log(`🏠 방 개설: [${name}] (ID: ${roomId}, PW: ${password ? 'YES' : 'NO'})`);
    });

    socket.on('joinRoom', (data) => {
        const { roomId, password, deck } = data;
        const room = waitingRooms[roomId];

        if (!room) {
            socket.emit('roomNotFound');
            console.log(`🚫 방 없음 (ID: ${roomId})`);
            return;
        }

        if (room.password && room.password !== (password || '').trim()) {
            socket.emit('wrongPassword');
            console.log(`🔑 비밀번호 오류 (ID: ${roomId})`);
            return;
        }

        delete waitingRooms[roomId];
        broadcastRoomList();

        const host = room.hostSocket;
        const gameRoomID = `game_${roomId}_${Date.now()}`;
        const sharedSeed = Math.floor(Math.random() * 1000000);

        host.join(gameRoomID);
        socket.join(gameRoomID);

        host.gameRoomID = gameRoomID;
        socket.gameRoomID = gameRoomID;
        host.gameRole = 'player1';
        socket.gameRole = 'player2';
        host.waitingRoomId = null;

        io.to(host.id).emit('gameStart', {
            role: 'player1',
            room: gameRoomID,
            enemyDeck: deck,
            seed: sharedSeed
        });
        io.to(socket.id).emit('gameStart', {
            role: 'player2',
            room: gameRoomID,
            enemyDeck: room.hostDeck,
            seed: sharedSeed
        });

        console.log(`⚔️ 게임 시작 (Room: ${gameRoomID})`);
    });

    socket.on('cancelRoom', () => {
        if (socket.waitingRoomId && waitingRooms[socket.waitingRoomId]) {
            const name = waitingRooms[socket.waitingRoomId].name;
            delete waitingRooms[socket.waitingRoomId];
            socket.waitingRoomId = null;
            broadcastRoomList();
            console.log(`🚫 방 취소: [${name}] (${socket.id})`);
        }
    });

    socket.on('action', (data) => {
        socket.to(data.room).emit('enemyAction', data);
    });

    socket.on('rejoin', (data) => {
        const { room, role } = data;
        if (!room) return;
        socket.join(room);
        socket.gameRoomID = room;
        socket.gameRole = role;
        socket.to(room).emit('enemyRejoined', { role });
        console.log(`🔄 Rejoin: ${socket.id} → Room: ${room} (${role})`);
    });

    socket.on('disconnect', () => {
        console.log('❌ 연결 종료:', socket.id);

        if (socket.waitingRoomId && waitingRooms[socket.waitingRoomId]) {
            delete waitingRooms[socket.waitingRoomId];
            broadcastRoomList();
        }

        for (const room of socket.rooms) {
            if (room !== socket.id) {
                socket.to(room).emit('enemyDisconnect');
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

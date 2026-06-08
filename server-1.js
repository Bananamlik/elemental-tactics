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

// [Fix] 게임별 RNG 호출 횟수 추적 — rejoin 시 offset 복원용
// { gameRoomID: { seed, rngOffset } }
let gameStates = {};

function broadcastRoomList() {
    const list = getRoomList();
    io.to('lobby').emit('roomListUpdate', list);
}

// [Fix] 로비 접속자 수 브로드캐스트 — 클라이언트 lobbyStats 핸들러가 기다리던 이벤트
function broadcastLobbyStats() {
    const online = io.sockets.sockets.size;
    const rooms  = Object.keys(waitingRooms).length;
    io.to('lobby').emit('lobbyStats', { online, rooms });
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
    broadcastLobbyStats(); // [Fix] 접속자 수 변경 시 로비에 알림

    socket.on('enterLobby', () => {
        socket.join('lobby');
        socket.emit('roomList', getRoomList());
        broadcastLobbyStats(); // [Fix] 로비 입장 시 통계 갱신
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
        const sharedSeed = Math.floor(Math.random() * 2147483646) + 1; // [Fix] 10^6 → full LCG range

        host.join(gameRoomID);
        socket.join(gameRoomID);

        host.gameRoomID = gameRoomID;
        socket.gameRoomID = gameRoomID;
        host.gameRole = 'player1';
        socket.gameRole = 'player2';
        host.waitingRoomId = null;

        // [Fix] 게임 상태 초기화 — rngOffset 추적
        gameStates[gameRoomID] = { seed: sharedSeed, rngOffset: 0 };

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
        // [Fix] RNG 턴 카운트 증분 — rejoin 시 offset 복원용
        if (data.room && gameStates[data.room]) {
            gameStates[data.room].rngOffset++;
        }
        socket.to(data.room).emit('enemyAction', data);
    });

    // [Fix] 퀵챗 중계 — 서버 핸들러 누락으로 채팅 완전 불통이던 것 수정
    socket.on('chat', (data) => {
        const { room, quickIdx } = data;
        if (!room || quickIdx == null) return;
        if (typeof quickIdx !== 'number' || quickIdx < 0 || quickIdx > 7) return; // 유효 인덱스만 허용
        socket.to(room).emit('chat', { from: socket.id, quickIdx });
    });

    socket.on('rejoin', (data) => {
        const { room, role } = data;
        if (!room) return;
        socket.join(room);
        socket.gameRoomID = room;
        socket.gameRole = role;
        socket.to(room).emit('enemyRejoined', { role });
        // [Fix] rejoinOk 전송 — 클라이언트가 기다리지만 서버가 보내지 않던 이벤트
        const state = gameStates[room];
        if (state) {
            socket.emit('rejoinOk', { seed: state.seed, rngOffset: state.rngOffset });
            console.log(`🔄 Rejoin OK: ${socket.id} → Room: ${room} (offset: ${state.rngOffset})`);
        } else {
            socket.emit('rejoinOk', {}); // offset 없음 경고는 클라이언트에서 처리
            console.log(`🔄 Rejoin: ${socket.id} → Room: ${room} (${role}) — state 없음`);
        }
    });

    socket.on('disconnect', () => {
        console.log('❌ 연결 종료:', socket.id);

        if (socket.waitingRoomId && waitingRooms[socket.waitingRoomId]) {
            delete waitingRooms[socket.waitingRoomId];
            broadcastRoomList();
        }

        // [Fix] 게임방 종료 시 gameStates 메모리 정리
        if (socket.gameRoomID && gameStates[socket.gameRoomID]) {
            const room = socket.gameRoomID;
            // 상대가 아직 연결 중인지 확인 후 일정 시간 뒤 정리
            setTimeout(() => {
                const roomSockets = io.sockets.adapter.rooms.get(room);
                if (!roomSockets || roomSockets.size === 0) {
                    delete gameStates[room];
                    console.log(`🗑️ gameState 정리: ${room}`);
                }
            }, 30000); // 30초 후 재연결 없으면 정리
        }

        for (const room of socket.rooms) {
            if (room !== socket.id) {
                socket.to(room).emit('enemyDisconnect');
            }
        }

        // [Fix] lobbyStats 갱신
        broadcastLobbyStats();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

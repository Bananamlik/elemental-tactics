// server.js - 방 코드 매칭 수정 버전 (v2 - 버그픽스)
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" } // CORS 문제 방지
});

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// [Fix #1] /ping 엔드포인트 추가 — 클라이언트의 Keepalive 요청 처리 (Render.com 슬립 방지)
app.get('/ping', (req, res) => res.sendStatus(200));

// 방 대기열 관리 객체 (Key: RoomCode, Value: [Socket])
let waitingRooms = {};

io.on('connection', (socket) => {
    console.log('✅ 접속:', socket.id);

    socket.on('findMatch', (data) => {
        // 클라이언트가 보낸 방 코드 (없으면 'default')
        const roomCode = data.roomCode || 'default';
        
        socket.deck = data.deck;
        socket.roomCode = roomCode; // 소켓에 방 코드 저장

        // 해당 방 코드가 없으면 생성
        if (!waitingRooms[roomCode]) {
            waitingRooms[roomCode] = [];
        }

        waitingRooms[roomCode].push(socket);
        socket.join(roomCode); // 소켓IO 룸 입장

        console.log(`🔍 매칭 요청 (Code: ${roomCode}) - 현재 대기: ${waitingRooms[roomCode].length}명`);

        // 같은 방 코드에 2명이 모였는지 확인
        if (waitingRooms[roomCode].length >= 2) {
            const p1 = waitingRooms[roomCode].shift();
            const p2 = waitingRooms[roomCode].shift();
            
            // 실제 게임 룸 ID 생성 (고유값)
            const gameRoomID = `game_${roomCode}_${Date.now()}`;
            
            // 두 플레이어를 게임 전용 룸으로 이동
            p1.join(gameRoomID);
            p2.join(gameRoomID);

            // [Fix] 플레이어별 gameRoomID 저장 (rejoin 시 재참여에 사용)
            p1.gameRoomID = gameRoomID;
            p2.gameRoomID = gameRoomID;
            p1.gameRole = 'player1';
            p2.gameRole = 'player2';

            // 공통 난수 시드 생성
            const sharedSeed = Math.floor(Math.random() * 1000000);

            // P1에게 전송
            io.to(p1.id).emit('gameStart', {
                role: 'player1', 
                room: gameRoomID, 
                enemyDeck: p2.deck,
                seed: sharedSeed
            });

            // P2에게 전송
            io.to(p2.id).emit('gameStart', {
                role: 'player2', 
                room: gameRoomID, 
                enemyDeck: p1.deck,
                seed: sharedSeed
            });

            console.log(`⚔️ 게임 시작 (Room: ${gameRoomID}, Code: ${roomCode})`);
        } else {
            socket.emit('waiting', `방 코드 [${roomCode}] 대기 중... (1/2)`);
        }
    });

    socket.on('action', (data) => {
        // 행동 중계 (같은 게임 룸에 있는 사람에게만 전송)
        socket.to(data.room).emit('enemyAction', data);
    });

    // [Fix #2] rejoin 이벤트 처리 — 재연결 시 게임 룸 재참여
    socket.on('rejoin', (data) => {
        const { room, role } = data;
        if (!room) return;

        socket.join(room);
        socket.gameRoomID = room;
        socket.gameRole = role;

        console.log(`🔄 Rejoin: ${socket.id} → Room: ${room} (${role})`);

        // 상대방에게 재연결 알림 (클라이언트가 처리)
        socket.to(room).emit('enemyRejoined', { role });
    });

    socket.on('disconnect', () => { 
        console.log('❌ 연결 종료:', socket.id);
        
        // 대기 중이었다면 대기열에서 제거
        if (socket.roomCode && waitingRooms[socket.roomCode]) {
            waitingRooms[socket.roomCode] = waitingRooms[socket.roomCode].filter(s => s.id !== socket.id);
            // 대기열이 비었으면 방 삭제 (메모리 관리)
            if (waitingRooms[socket.roomCode].length === 0) {
                delete waitingRooms[socket.roomCode];
            }
        }
        
        // 게임 중이었다면 상대방에게 기권 알림
        // (socket.rooms는 Set 형태이므로 순회)
        for (const room of socket.rooms) {
            if (room !== socket.id) {
                socket.to(room).emit('enemyDisconnect');
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

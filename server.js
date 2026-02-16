const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// Middleware
app.use(cors());
app.use(express.static(path.join(__dirname, '.')));

// ============= ХРАНИЛИЩЕ ДАННЫХ =============
const rooms = new Map();

class Room {
    constructor(roomId) {
        this.id = roomId;
        this.leaderId = null;
        this.participants = new Map();
        this.videoState = {
            isPlaying: false,
            currentTime: 0,
            lastUpdateTime: Date.now(),
            serverTime: Date.now()
        };
        this.syncTimestamps = new Map(); // для синхронизации по времени
    }

    addParticipant(userId, socket, username) {
        this.participants.set(userId, {
            socket,
            username,
            userId,
            role: this.participants.size === 0 ? 'leader' : 'viewer',
            connectedAt: Date.now(),
            latency: 0
        });

        // Если это первый участник — он ведущий
        if (this.leaderId === null) {
            this.leaderId = userId;
            this.participants.get(userId).role = 'leader';
        }
    }

    removeParticipant(userId) {
        this.participants.delete(userId);
        this.syncTimestamps.delete(userId);

        // Если ведущий отключился — передаем роль
        if (this.leaderId === userId && this.participants.size > 0) {
            const newLeader = Array.from(this.participants.values())[0];
            this.leaderId = newLeader.userId;
            newLeader.role = 'leader';
            return newLeader.userId;
        }

        return null;
    }

    getLeader() {
        return this.participants.get(this.leaderId);
    }

    getParticipantList() {
        return Array.from(this.participants.values()).map(p => ({
            userId: p.userId,
            username: p.username,
            role: p.role,
            connectedAt: p.connectedAt
        }));
    }

    // Корректировка времени на основе NTP-подобного механизма
    updateLeaderLatency(userId, clientTime) {
        const participant = this.participants.get(userId);
        if (!participant) return;

        const latency = Math.round((Date.now() - clientTime) / 2);
        participant.latency = latency;
    }
}

// ============= МАРШРУТЫ =============
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ============= SOCKET.IO ОБРАБОТЧИКИ =============
io.on('connection', (socket) => {
    console.log(`✅ Пользователь подключился: ${socket.id}`);

    let currentRoomId = null;
    let userId = socket.id;
    let username = `User_${socket.id.substring(0, 5)}`;

    // ===== ПРИСОЕДИНЕНИЕ К КОМНАТЕ =====
    socket.on('join-room', ({ roomId, username: inputUsername }) => {
        currentRoomId = roomId;
        username = inputUsername || `User_${socket.id.substring(0, 5)}`;

        // Создаем комнату если её нет
        if (!rooms.has(roomId)) {
            rooms.set(roomId, new Room(roomId));
        }

        const room = rooms.get(roomId);
        room.addParticipant(userId, socket, username);

        // Присоединяемся к socket.io комнате
        socket.join(roomId);

        console.log(`👤 ${username} присоединился к комнате ${roomId}. Ведущий: ${room.getLeader().username}`);

        // Отправляем новому пользователю информацию о комнате и состояние видео
        socket.emit('room-info', {
            roomId,
            leaderId: room.leaderId,
            yourId: userId,
            yourRole: room.participants.get(userId).role,
            participants: room.getParticipantList(),
            videoState: room.videoState,
            serverTime: Date.now()
        });

        // Уведомляем всех о новом участнике
        io.to(roomId).emit('participant-joined', {
            participants: room.getParticipantList(),
            message: `${username} присоединился`
        });

        // Отправляем периодическую синхронизацию
        const syncInterval = setInterval(() => {
            if (!rooms.has(roomId)) {
                clearInterval(syncInterval);
                return;
            }

            const room = rooms.get(roomId);
            if (!room.participants.has(userId)) {
                clearInterval(syncInterval);
                return;
            }

            // Рассчитываем ожидаемое время видео на сервере
            let expectedTime = room.videoState.currentTime;
            if (room.videoState.isPlaying) {
                const elapsed = (Date.now() - room.videoState.lastUpdateTime) / 1000;
                expectedTime += elapsed;
            }

            // Отправляем синхрочасы
            socket.emit('sync-tick', {
                serverTime: Date.now(),
                expectedTime: expectedTime,
                isPlaying: room.videoState.isPlaying,
                leaderId: room.leaderId
            });
        }, 200); // Отправляем каждые 200ms

        // Сохраняем interval для очистки
        socket.syncInterval = syncInterval;
    });

    // ===== КОМАНДЫ УПРАВЛЕНИЯ ВИДЕО (ТОЛЬКО ДЛЯ ВЕДУЩЕГО) =====
    socket.on('video-command', ({ action, time }) => {
        if (!currentRoomId || !rooms.has(currentRoomId)) return;

        const room = rooms.get(currentRoomId);

        // ПРОВЕРКА: Только ведущий может отправлять команды
        if (room.leaderId !== userId) {
            socket.emit('error', { message: 'Только ведущий может управлять видео' });
            return;
        }

        // Обновляем состояние видео
        room.videoState = {
            isPlaying: action === 'play',
            currentTime: time,
            lastUpdateTime: Date.now(),
            serverTime: Date.now(),
            lastCommand: action
        };

        console.log(`🎬 ${username} (ведущий) отправил: ${action} @ ${time.toFixed(2)}s`);

        // Рассылаем ВСЕМ участникам комнаты
        io.to(currentRoomId).emit('video-sync', {
            action: action,
            time: time,
            leaderId: room.leaderId,
            leaderName: room.getLeader().username,
            timestamp: Date.now(),
            serverTime: Date.now()
        });
    });

    // ===== ЗАПРОС НА СИНХРОНИЗАЦИЮ (ОТ ЗРИТЕЛЕЙ) =====
    socket.on('request-sync', ({ clientTime }) => {
        if (!currentRoomId || !rooms.has(currentRoomId)) return;

        const room = rooms.get(currentRoomId);

        // Вычисляем задержку
        const latency = Math.round((Date.now() - clientTime) / 2);
        const participant = room.participants.get(userId);
        if (participant) {
            participant.latency = latency;
        }

        // Рассчитываем ожидаемое время видео
        let expectedTime = room.videoState.currentTime;
        if (room.videoState.isPlaying) {
            const elapsed = (Date.now() - room.videoState.lastUpdateTime) / 1000;
            expectedTime += elapsed;
        }

        // Отправляем коррекцию только этому участнику
        socket.emit('sync-response', {
            expectedTime: expectedTime,
            serverTime: Date.now(),
            leadLatency: room.getLeader()?.latency || 0,
            yourLatency: latency
        });
    });

    // ===== СИНХРОНИЗАЦИЯ ВЕДУЩЕГО (L Для определения его задержки) =====
    socket.on('leader-heartbeat', ({ clientTime }) => {
        if (!currentRoomId || !rooms.has(currentRoomId)) return;

        const room = rooms.get(currentRoomId);
        room.updateLeaderLatency(userId, clientTime);
    });

    // ===== КИК ПОЛЬЗОВАТЕЛЯ (ТОЛЬКО ДЛЯ ВЕДУЩЕГО) =====
    socket.on('kick-user', ({ targetUserId }) => {
        if (!currentRoomId || !rooms.has(currentRoomId)) return;

        const room = rooms.get(currentRoomId);

        // Проверка прав
        if (room.leaderId !== userId) {
            socket.emit('error', { message: 'Только ведущий может кикать пользователей' });
            return;
        }

        const targetSocket = room.participants.get(targetUserId)?.socket;
        if (targetSocket) {
            console.log(`🚫 ${username} (ведущий) выкинул ${targetUserId} из комнаты`);
            targetSocket.emit('kicked', { reason: 'Вас выкинул ведущий' });
            targetSocket.disconnect(true);
        }
    });

    // ===== ПЕРЕДАЧА РОЛИ ВЕДУЩЕГО =====
    socket.on('transfer-leadership', ({ targetUserId }) => {
        if (!currentRoomId || !rooms.has(currentRoomId)) return;

        const room = rooms.get(currentRoomId);

        // Проверка прав
        if (room.leaderId !== userId) {
            socket.emit('error', { message: 'Только ведущий может передать роль' });
            return;
        }

        const targetParticipant = room.participants.get(targetUserId);
        if (!targetParticipant) return;

        // Меняем роли
        room.participants.get(userId).role = 'viewer';
        targetParticipant.role = 'leader';
        room.leaderId = targetUserId;

        console.log(`👑 ${username} передал роль ведущего ${targetParticipant.username}`);

        // Уведомляем всех
        io.to(currentRoomId).emit('leadership-transferred', {
            newLeaderId: targetUserId,
            newLeaderName: targetParticipant.username,
            message: `${targetParticipant.username} теперь ведущий`
        });
    });

    // ===== ОТКЛЮЧЕНИЕ =====
    socket.on('disconnect', () => {
        if (!currentRoomId || !rooms.has(currentRoomId)) return;

        const room = rooms.get(currentRoomId);
        console.log(`❌ ${username} отключился от комнаты ${currentRoomId}`);

        // Очищаем синхронизацию
        if (socket.syncInterval) {
            clearInterval(socket.syncInterval);
        }

        const newLeaderId = room.removeParticipant(userId);

        // Удаляем пустую комнату
        if (room.participants.size === 0) {
            rooms.delete(currentRoomId);
            console.log(`🗑️ Комната ${currentRoomId} удалена (нет участников)`);
        } else {
            // Уведомляем остальных
            if (newLeaderId) {
                io.to(currentRoomId).emit('leadership-transferred', {
                    newLeaderId: newLeaderId,
                    newLeaderName: room.getLeader().username,
                    message: `${username} отключился. Новый ведущий: ${room.getLeader().username}`
                });
            }

            io.to(currentRoomId).emit('participant-left', {
                participants: room.getParticipantList(),
                message: `${username} покинул комнату`
            });
        }
    });

    // ===== ОБРАБОТКА ОШИБОК =====
    socket.on('error', (error) => {
        console.error(`❗ Ошибка сокета ${socket.id}:`, error);
    });
});

// ============= ЗАПУСК СЕРВЕРА =============
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════╗
║   🎬 CINEMATE SYNC SERVER ЗАПУЩЕН    ║
║   Адрес: http://localhost:${PORT}       ║
╚══════════════════════════════════════╝
    `);
});

// Обработка завершения процесса
process.on('SIGTERM', () => {
    console.log('⏹️ Сервер выключается...');
    server.close(() => {
        console.log('✅ Сервер остановлен');
        process.exit(0);
    });
});

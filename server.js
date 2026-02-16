const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { 
        origin: "*", 
        methods: ["GET", "POST", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Range"],
        credentials: true
    },
    path: '/socket.io/'
});

// Middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Range']
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, '.')));

// ============= ХРАНИЛИЩЕ ДАННЫХ =============
const rooms = new Map();
const urlCache = new Map();

class Room {
    constructor(roomId) {
        this.id = roomId;
        this.leaderId = null;
        this.participants = new Map();
        this.videoState = {
            isPlaying: false,
            currentTime: 0,
            lastUpdateTime: Date.now(),
            url: null,
            title: 'Нет видео',
            type: null
        };
    }

    addParticipant(userId, socket, username) {
        this.participants.set(userId, {
            socket,
            username,
            userId,
            role: this.participants.size === 0 ? 'leader' : 'viewer',
            connectedAt: Date.now()
        });

        if (this.leaderId === null) {
            this.leaderId = userId;
            this.participants.get(userId).role = 'leader';
        }
    }

    removeParticipant(userId) {
        this.participants.delete(userId);

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
            role: p.role
        }));
    }
}

// ============= ОСНОВНОЙ МАРШРУТ =============
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ============= API: ИЗВЛЕЧЕНИЕ ВИДЕО =============
app.post('/api/extract', async (req, res) => {
    const { url } = req.body;
    
    if (!url) {
        return res.status(400).json({ error: 'URL обязателен' });
    }

    try {
        console.log(`🔍 Извлечение видео из: ${url}`);

        // Проверка кеша
        if (urlCache.has(url)) {
            const cached = urlCache.get(url);
            if (Date.now() - cached.timestamp < 3600000) {
                console.log('✅ Использован кеш');
                return res.json(cached.data);
            }
        }

        // Прямые ссылки на видеофайлы
        if (url.match(/\.(mp4|webm|ogg|mov|mkv|avi|m3u8)(\?.*)?$/i)) {
            const isHls = url.includes('.m3u8');
            const result = {
                url: url,
                title: 'Видео файл',
                type: isHls ? 'hls' : 'direct'
            };
            urlCache.set(url, { data: result, timestamp: Date.now() });
            return res.json(result);
        }

        // Пытаемся использовать yt-dlp
        let youtubedl;
        try {
            youtubedl = require('youtube-dl-exec');
        } catch (e) {
            console.log('⚠️ yt-dlp не установлен, используем fallback');
            // Fallback - возвращаем оригинальный URL
            const result = {
                url: url,
                title: 'Видео',
                type: 'embed'
            };
            urlCache.set(url, { data: result, timestamp: Date.now() });
            return res.json(result);
        }

        // Используем yt-dlp
        const info = await youtubedl(url, {
            dumpSingleJson: true,
            noWarnings: true,
            noCheckCertificate: true,
            preferFreeFormats: true,
            skipDownload: true,
            socketTimeout: 30000
        });

        let directUrl = null;
        let title = info.title || 'Видео';
        let type = 'direct';

        // Получаем прямую ссылку
        if (info.url && info.url.startsWith('http')) {
            directUrl = info.url;
        } else if (info.formats && Array.isArray(info.formats)) {
            const format = info.formats
                .filter(f => f.url && f.url.startsWith('http'))
                .sort((a, b) => {
                    const getPriority = (ext) => {
                        if (ext === 'mp4') return 3;
                        if (ext === 'webm') return 2;
                        return 1;
                    };
                    return getPriority(b.ext) - getPriority(a.ext);
                })[0];
            
            if (format) {
                directUrl = format.url;
                if (format.url.includes('.m3u8')) type = 'hls';
            }
        }

        if (!directUrl) {
            directUrl = url;
            type = 'embed';
        }

        const result = {
            url: directUrl,
            title: title,
            type: type
        };

        urlCache.set(url, { data: result, timestamp: Date.now() });
        console.log(`✅ Извлечено: ${title}`);
        res.json(result);

    } catch (error) {
        console.error('❌ Ошибка:', error.message);
        
        // Fallback при ошибке
        res.json({
            url: url,
            title: 'Видео',
            type: 'embed'
        });
    }
});

// ============= STREAM PROXY =============
app.get('/stream', (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).send('URL не указан');

    try {
        new URL(videoUrl);
    } catch {
        return res.status(400).send('Неверный URL');
    }

    res.redirect(videoUrl);
});

// ============= RUTUBE API =============
app.post('/api/rutube', async (req, res) => {
    const { videoId } = req.body;
    if (!videoId) return res.status(400).json({ error: 'videoId обязателен' });

    try {
        const https = require('https');
        
        const options = {
            hostname: 'rutube.ru',
            path: `/api/play/options/${videoId}/`,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0'
            }
        };

        const request = https.request(options, (response) => {
            let data = '';
            response.on('data', (chunk) => data += chunk);
            response.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.video_balancer && json.video_balancer.m3u8) {
                        res.json({
                            url: json.video_balancer.m3u8,
                            title: json.title || 'Rutube видео',
                            type: 'hls'
                        });
                    } else {
                        res.status(404).json({ error: 'Видео не найдено' });
                    }
                } catch (e) {
                    res.status(500).json({ error: 'Ошибка парсинга' });
                }
            });
        });

        request.on('error', (error) => {
            res.status(500).json({ error: error.message });
        });

        request.end();

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============= VK API =============
app.post('/api/vk', (req, res) => {
    const { oid, id } = req.body;
    if (!oid || !id) return res.status(400).json({ error: 'missing_params' });

    res.json({
        url: `https://vk.com/video_ext.php?oid=${oid}&id=${id}`,
        title: 'VK видео',
        type: 'embed'
    });
});

// ============= SOCKET.IO ОБРАБОТЧИКИ =============
io.on('connection', (socket) => {
    console.log(`✅ Клиент подключен: ${socket.id}`);

    let currentRoomId = null;
    let username = `User_${socket.id.substr(0, 5)}`;

    socket.on('join-room', ({ roomId, username: inputUsername }) => {
        try {
            currentRoomId = roomId;
            username = inputUsername || username;

            if (!rooms.has(roomId)) {
                rooms.set(roomId, new Room(roomId));
            }

            const room = rooms.get(roomId);
            room.addParticipant(socket.id, socket, username);
            socket.join(roomId);

            console.log(`👤 ${username} присоединился к ${roomId}`);

            socket.emit('room-info', {
                roomId,
                yourRole: room.participants.get(socket.id).role,
                participants: room.getParticipantList(),
                videoState: room.videoState
            });

            io.to(roomId).emit('participant-joined', {
                participants: room.getParticipantList(),
                message: `${username} присоединился`
            });

            // Периодическая синхронизация
            const syncInterval = setInterval(() => {
                if (!rooms.has(roomId) || !room.participants.has(socket.id)) {
                    clearInterval(syncInterval);
                    return;
                }

                let expectedTime = room.videoState.currentTime;
                if (room.videoState.isPlaying) {
                    expectedTime += (Date.now() - room.videoState.lastUpdateTime) / 1000;
                }

                socket.emit('sync-tick', {
                    serverTime: Date.now(),
                    expectedTime: expectedTime,
                    isPlaying: room.videoState.isPlaying
                });
            }, 1000);

            socket.syncInterval = syncInterval;

        } catch (error) {
            console.error('Ошибка:', error);
        }
    });

    socket.on('video-command', (data) => {
        if (!currentRoomId || !rooms.has(currentRoomId)) return;

        const room = rooms.get(currentRoomId);
        
        if (room.leaderId !== socket.id) {
            socket.emit('error', { message: 'Только ведущий может управлять видео' });
            return;
        }

        if (data.action === 'load') {
            room.videoState = {
                ...room.videoState,
                url: data.url,
                title: data.title || 'Видео',
                type: data.type || 'direct',
                currentTime: 0,
                isPlaying: false,
                lastUpdateTime: Date.now()
            };
        } else {
            room.videoState = {
                ...room.videoState,
                isPlaying: data.action === 'play',
                currentTime: data.time || room.videoState.currentTime,
                lastUpdateTime: Date.now()
            };
        }

        io.to(currentRoomId).emit('video-sync', {
            ...data,
            leaderId: socket.id,
            serverTime: Date.now()
        });
    });

    socket.on('send-chat-message', ({ message }) => {
        if (!currentRoomId || !rooms.has(currentRoomId)) return;

        io.to(currentRoomId).emit('chat-message', {
            username: username,
            message: message,
            timestamp: Date.now()
        });
    });

    socket.on('change-username', ({ newUsername }) => {
        if (!currentRoomId || !rooms.has(currentRoomId)) return;

        const room = rooms.get(currentRoomId);
        const participant = room.participants.get(socket.id);
        
        if (participant) {
            const oldName = participant.username;
            participant.username = newUsername;
            username = newUsername;

            io.to(currentRoomId).emit('participant-joined', {
                participants: room.getParticipantList(),
                message: `${oldName} сменил имя на ${newUsername}`
            });
        }
    });

    socket.on('request-sync', ({ clientTime }) => {
        if (!currentRoomId || !rooms.has(currentRoomId)) return;

        const room = rooms.get(currentRoomId);
        
        let expectedTime = room.videoState.currentTime;
        if (room.videoState.isPlaying) {
            expectedTime += (Date.now() - room.videoState.lastUpdateTime) / 1000;
        }

        socket.emit('sync-response', {
            expectedTime: expectedTime,
            serverTime: Date.now()
        });
    });

    socket.on('disconnect', () => {
        if (!currentRoomId || !rooms.has(currentRoomId)) return;

        const room = rooms.get(currentRoomId);
        
        if (socket.syncInterval) {
            clearInterval(socket.syncInterval);
        }

        const newLeaderId = room.removeParticipant(socket.id);

        console.log(`❌ ${username} отключился от ${currentRoomId}`);

        if (room.participants.size === 0) {
            rooms.delete(currentRoomId);
            console.log(`🗑️ Комната ${currentRoomId} удалена`);
        } else {
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
});

// ============= ЗАПУСК СЕРВЕРА =============
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔══════════════════════════════════════╗
║   🎬 CINEMATE SYNC СЕРВЕР ЗАПУЩЕН    ║
║   Адрес: http://localhost:${PORT}     ║
╚══════════════════════════════════════╝
    `);
});

// Обработка ошибок
process.on('uncaughtException', (err) => {
    console.error('Необработанная ошибка:', err);
});
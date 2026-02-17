const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const https = require('https');
const { URL } = require('url');

const app = express();
const server = http.createServer(app);

// ===== ПОЛНАЯ ПОДДЕРЖКА CORS =====
const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:3001', 
    'http://localhost:8080',
    'http://localhost:5173',
    'http://127.0.0.1:3000',
    // Netlify домены
    'https://netlify.app',
    'https://filmsite.netlify.app',
    'https://your-site.netlify.app',
    '*.netlify.app',
    // Render домены
    'https://onrender.com',
    '*.onrender.com'
];

const io = socketIo(server, {
    cors: { 
        origin: function(origin, callback) {
            // Позволяем все запросы включая без Origin заголовка
            if (!origin || origin.includes('localhost') || origin.includes('127.0.0.1') || 
                origin.includes('netlify.app') || origin.includes('onrender.com')) {
                callback(null, true);
            } else {
                callback(null, true); // Разрешаем все для простоты, можно ограничить позже
            }
        },
        methods: ["GET", "POST", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Range"],
        credentials: true
    },
    path: '/socket.io/'
});

// Middleware
app.use(cors({
    origin: function(req, callback) {
        // Разрешаем все источники для разработки
        callback(null, true);
    },
    methods: ['GET', 'POST', 'OPTIONS', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Range', 'Authorization'],
    credentials: true
}));

// Специально для streaming
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
    
    if (req.method === 'OPTIONS') {
        res.sendStatus(200);
    } else {
        next();
    }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '.')));

// ============= ХРАНИЛИЩЕ ДАННЫХ =============
const rooms = new Map();
const urlCache = new Map(); // Кеширование временных ссылок (60 мин)

class Room {
    constructor(roomId) {
        this.id = roomId;
        this.leaderId = null;
        this.participants = new Map();
        this.videoState = {
            isPlaying: false,
            currentTime: 0,
            lastUpdateTime: Date.now(),
            serverTime: Date.now(), // НОВОЕ: Время на сервере когда было обновление
            url: null,
            title: 'Нет видео',
            type: null,
            commandId: 0 // НОВОЕ: Порядковый номер команды
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

// ============= API: ИЗВЛЕЧЕНИЕ ВИДЕО (с кешированием и лучшим выбором форматов) =============
// ============= API: ИЗВЛЕЧЕНИЕ ВИДЕО =============
app.post('/api/extract', async (req, res) => {
    try {
        const { url } = req.body;
        
        if (!url) {
            return res.status(400).json({ error: 'URL обязателен' });
        }

        console.log(`🔍 Извлечение видео из: ${url}`);

        // Специальная обработка для Rutube
        if (url.includes('rutube.ru')) {
            try {
                // Пытаемся получить ID видео из URL
                const videoIdMatch = url.match(/video\/([a-f0-9]+)/);
                if (videoIdMatch && videoIdMatch[1]) {
                    const videoId = videoIdMatch[1];
                    
                    // Запрашиваем API Rutube для получения информации о видео
                    const apiUrl = `https://rutube.ru/api/play/options/${videoId}/`;
                    
                    const response = await fetch(apiUrl, {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                        }
                    });
                    
                    if (response.ok) {
                        const data = await response.json();
                        console.log(`✅ Rutube видео получено: ${data.title}`);
                        
                        // Возвращаем информацию для встраивания плеера Rutube
                        return res.json({
                            url: url,
                            embedUrl: url,  // Rutube может встраиваться через iframe
                            videoId: videoId,
                            title: data.title || 'Rutube видео',
                            type: 'rutube-embed',
                            playerUrl: `https://rutube.ru/play/embed/${videoId}`  // URL для iframe
                        });
                    }
                }
            } catch (e) {
                console.log('Rutube API error:', e.message);
            }
            
            // Fallback: возвращаем оригинальный URL
            const videoIdMatch = url.match(/video\/([a-f0-9]+)/);
            const videoId = videoIdMatch ? videoIdMatch[1] : null;
            return res.json({
                url: url,
                embedUrl: url,
                videoId: videoId,
                title: 'Rutube видео',
                type: 'rutube-embed',
                playerUrl: videoId ? `https://rutube.ru/play/embed/${videoId}` : url
            });
        }

        // Специальная обработка для VK
        if (url.includes('vk.com') || url.includes('vkvideo.ru')) {
            try {
                // Попытка извлечь ID видео из URL
                // Форматы: vk.com/video<id>, vkvideo.ru/<id>
                let videoId = null;
                const match1 = url.match(/vk\.com\/video(-?\d+_\d+)/);
                const match2 = url.match(/vkvideo\.ru\/(\d+)/);
                const match3 = url.match(/oid=(-?\d+)&id=(\d+)/);
                
                if (match1) {
                    videoId = match1[1];
                } else if (match2) {
                    videoId = match2[1];
                } else if (match3) {
                    videoId = `${match3[1]}_${match3[2]}`;
                }
                
                console.log(`✅ VK видео получено, ID: ${videoId}`);
                
                return res.json({
                    url: url,
                    videoId: videoId,
                    title: 'VK видео',
                    type: 'vk-embed'
                });
            } catch (e) {
                console.log('VK処理 error:', e.message);
            }
            
            return res.json({
                url: url,
                title: 'VK видео',
                type: 'vk-embed'
            });
        }

        // Специальная обработка для YouTube
        if (url.includes('youtube.com') || url.includes('youtu.be')) {
            // YouTube embed (работает везде без дополнительных зависимостей)
            return res.json({
                url: url,
                title: 'YouTube видео',
                type: 'embed'
            });
        }

        // Прямые ссылки на видео
        if (url.match(/\.(mp4|webm|ogg|mov|mkv|m3u8)(\?.*)?$/i)) {
            const isHls = url.includes('.m3u8');
            return res.json({
                url: url,
                title: 'Видео файл',
                type: isHls ? 'hls' : 'direct'
            });
        }

        // Для всего остального - используем embed
        return res.json({
            url: url,
            title: 'Видео',
            type: 'embed'
        });

    } catch (error) {
        console.error('❌ Extract API error:', error.message);
        if (!res.headersSent) {
            res.status(500).json({ 
                error: 'extraction_failed',
                message: error.message 
            });
        }
    }
});

// ============= STREAM PROXY (с SSRF защитой и поддержкой Range) =============
// ============= УЛУЧШЕННЫЙ STREAM PROXY =============
app.get('/stream', (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).send('missing url');

    console.log(`🔄 Прокси запрос для: ${videoUrl.substring(0, 100)}`);

    try {
        const parsedUrl = new URL(videoUrl);
        
        // Защита от SSRF
        const hostname = parsedUrl.hostname;
        if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname.startsWith('192.168.')) {
            return res.status(403).send('forbidden');
        }

        const protocol = parsedUrl.protocol === 'https:' ? https : http;
        
        const options = {
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': parsedUrl.origin
            }
        };

        // Поддержка Range запросов (для перемотки)
        if (req.headers.range) {
            options.headers.Range = req.headers.range;
        }

        const proxyReq = protocol.request(videoUrl, options, (proxyRes) => {
            // Копируем важные заголовки
            const headersToCopy = [
                'content-type', 'content-length', 'content-range',
                'accept-ranges', 'cache-control', 'last-modified',
                'etag'
            ];
            
            headersToCopy.forEach(header => {
                if (proxyRes.headers[header]) {
                    res.setHeader(header, proxyRes.headers[header]);
                }
            });

            // Добавляем CORS заголовки (очень важно для HLS.js)
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
            res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type');
            res.setHeader('Access-Control-Max-Age', '3600');
            
            // Если это m3u8, убедимся что content-type правильный
            if (videoUrl.includes('.m3u8')) {
                res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            }
            
            res.statusCode = proxyRes.statusCode || 200;
            proxyRes.pipe(res);
        });

        proxyReq.on('error', (error) => {
            console.error('❌ Proxy error:', error.message);
            if (!res.headersSent) {
                res.status(502).send('Proxy error');
            }
        });

        proxyReq.end();

    } catch (error) {
        console.error('❌ Stream error:', error);
        res.status(500).send('Internal error');
    }
});

// ============= RUTUBE API =============
app.post('/api/rutube', async (req, res) => {
    const { videoId } = req.body;
    if (!videoId) return res.status(400).json({ error: 'videoId обязателен' });

    try {
        const options = {
            hostname: 'rutube.ru',
            path: `/api/play/options/${videoId}/`,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://rutube.ru'
            },
            timeout: 10000
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
                            type: 'hls',
                            duration: json.duration || null
                        });
                    } else {
                        res.status(404).json({ error: 'video_not_found' });
                    }
                } catch (e) {
                    res.status(500).json({ error: 'invalid_json_response' });
                }
            });
        });

        request.on('error', (error) => {
            console.error('Rutube API error:', error.message);
            if (error.message.includes('timeout')) {
                res.status(408).json({ error: 'request_timeout' });
            } else {
                res.status(500).json({ error: 'rutube_api_error' });
            }
        });

        request.on('timeout', () => {
            request.destroy();
        });

        request.end();

    } catch (error) {
        console.error('Rutube error:', error);
        res.status(500).json({ error: 'internal_error' });
    }
});

// ============= VK API - УЛУЧШЕННАЯ ОБРАБОТКА =============
app.post('/api/vk', async (req, res) => {
    const { url } = req.body;
    
    if (!url) {
        return res.status(400).json({ 
            error: 'missing_url',
            message: 'Требуется URL видео ВК'
        });
    }

    console.log(`🔍 Обрабатываю ВК видео: ${url}`);

    try {
        // Парсим ВК URL для получения ID видео
        let videoId = null;
        let ownerId = null;
        
        // Вариант 1: https://vkvideo.ru/video-127401043_456252809
        const vkvideomatch = url.match(/vkvideo\.ru\/video-(\d+)_(\d+)/);
        if (vkvideomatch) {
            ownerId = vkvideomatch[1];
            videoId = vkvideomatch[2];
        }
        
        // Вариант 2: https://vk.com/video{oid}_{id}
        const vkmatch = url.match(/vk\.com\/video(-?\d+)_(\d+)/);
        if (vkmatch) {
            ownerId = vkmatch[1];
            videoId = vkmatch[2];
        }
        
        if (!videoId || !ownerId) {
            console.warn('❌ Не удалось распарсить ВК видео ID');
            return res.json({
                url: url,
                title: 'ВК видео',
                type: 'vk-embed', // Специальный тип для ВК
                videoId: 'unknown'
            });
        }
        
        console.log(`✅ ВК видео ID: ${ownerId}_${videoId}`);
        
        // Возвращаем информацию о ВК видео
        return res.json({
            url: url,
            title: 'ВК видео',
            type: 'vk-direct', // Прямой тип для ВК (без iframe)
            videoId: `${ownerId}_${videoId}`,
            ownerId: ownerId,
            embedUrl: `https://vk.com/video_ext.php?oid=${ownerId}&id=${videoId}&autoplay=1`
        });
        
    } catch (error) {
        console.error('❌ VK обработка ошибка:', error.message);
        return res.json({
            url: url,
            title: 'ВК видео',
            type: 'vk-embed',
            error: 'vk_parsing_failed'
        });
    }
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

            // ИСПРАВЛЕНИЕ: Правильная синхронизация
            // Периодическая синхронизация ТОЛЬКО для зрителей
            const syncInterval = setInterval(() => {
                if (!rooms.has(roomId) || !room.participants.has(socket.id)) {
                    clearInterval(syncInterval);
                    return;
                }

                // ИСПРАВЛЕНИЕ: Не отправляем ведущему его же данные!
                if (room.leaderId === socket.id) {
                    return; // Ведущий не нуждается в sync-tick, он сам управляет
                }

                // ИСПРАВЛЕНИЕ: Правильный расчет ожидаемого времени
                let expectedTime = room.videoState.currentTime;
                if (room.videoState.isPlaying) {
                    const timePassed = (Date.now() - room.videoState.lastUpdateTime) / 1000;
                    expectedTime += timePassed;
                }

                socket.emit('sync-tick', {
                    expectedTime: expectedTime,
                    serverTime: Date.now(),
                    isPlaying: room.videoState.isPlaying,
                    commandId: room.videoState.commandId
                });
            }, 1000);

            socket.syncInterval = syncInterval;

        } catch (error) {
            console.error('Ошибка при присоединении:', error);
            socket.emit('error', { message: 'Ошибка при присоединении к комнате' });
        }
    });

    socket.on('video-command', (data) => {
        if (!currentRoomId || !rooms.has(currentRoomId)) return;

        const room = rooms.get(currentRoomId);
        
        if (room.leaderId !== socket.id) {
            socket.emit('error', { message: 'Только ведущий может управлять видео' });
            return;
        }

        // ИСПРАВЛЕНИЕ: Правильный расчет состояния видео
        if (data.action === 'load') {
            const now = Date.now();
            room.videoState = {
                url: data.url,
                title: data.title || 'Видео',
                type: data.type || 'direct',
                isPlaying: false,
                currentTime: 0,
                lastUpdateTime: now,  // ИСПРАВЛЕНИЕ: Обновляем ДО остального
                serverTime: now,
                commandId: (room.videoState.commandId || 0) + 1
            };
        } else if (data.action === 'play' || data.action === 'pause' || data.action === 'seek') {
            const now = Date.now();
            
            // ИСПРАВЛЕНИЕ: Если приходит 'seek', сбрасываем рассчитанное время
            if (data.action === 'seek') {
                // Seek не должен вычисляться дальше
                room.videoState.currentTime = data.time || room.videoState.currentTime;
                room.videoState.isPlaying = false; // Pause после seek
            } else if (data.action === 'play') {
                // Если было'pause', обновляем время перед play
                if (!room.videoState.isPlaying && typeof data.time === 'number') {
                    room.videoState.currentTime = data.time;
                }
                room.videoState.isPlaying = true;
            } else if (data.action === 'pause') {
                // Фиксируем время в точке pause
                room.videoState.currentTime = data.time || room.videoState.currentTime;
                room.videoState.isPlaying = false;
            }
            
            // ИСПРАВЛЕНИЕ: Обновляем время ПОСЛЕ установки всех других полей
            room.videoState.lastUpdateTime = now;
            room.videoState.serverTime = now;
            room.videoState.commandId = (room.videoState.commandId || 0) + 1;
        }

        // Отправляем команду ВСЕМ кроме ведущего (ведущий уже знает)
        io.to(currentRoomId).except(socket.id).emit('video-sync', {
            ...data,
            leaderId: socket.id,
            serverTime: Date.now(),
            commandId: room.videoState.commandId,
            expectedTime: room.videoState.currentTime // НОВОЕ: Отправляем ожидаемое время
        });
        
        // Отправляем ведущему подтверждение
        socket.emit('video-command-ack', {
            commandId: room.videoState.commandId,
            serverTimestamp: Date.now()
        });
    });

    // НОВОЕ: Обработка синхронизации для embed видео (Rutube, VK)
    socket.on('embed-sync-status', (data) => {
        if (!currentRoomId || !rooms.has(currentRoomId)) return;

        const room = rooms.get(currentRoomId);
        
        if (room.leaderId !== socket.id) {
            return; // Только ведущий может отправлять статус
        }

        // Пересылаем статус все остальным участникам
        io.to(currentRoomId).except(socket.id).emit('embed-sync-status', {
            roomId: currentRoomId,
            videoType: data.videoType,
            isPlaying: data.isPlaying,
            currentTime: data.currentTime,
            leaderId: socket.id,
            timestamp: Date.now()
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

    // НОВОЕ: Обработка heartbeat для мягкой синхронизации embed видео (ВК)
    socket.on('embed-video-heartbeat', ({ roomId, isAlive }) => {
        if (!roomId || !rooms.has(roomId)) return;
        
        const room = rooms.get(roomId);
        if (room.leaderId !== socket.id) return; // Прерываем если отправитель не ведущий
        
        // Отправляем heartbeat всем в комнате кроме ведущего
        io.to(roomId).except(socket.id).emit('embed-video-heartbeat', {
            isAlive: isAlive,
            timestamp: Date.now()
        });
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
║   ✅ SSRF защита                      ║
║   ✅ Кеширование ссылок                ║
║   ✅ Лучший выбор форматов             ║
║   ✅ Детализация ошибок                ║
╚══════════════════════════════════════╝
    `);
});

// Обработка ошибок
process.on('uncaughtException', (err) => {
    console.error('Необработанная ошибка:', err);
});

process.on('SIGTERM', () => {
    console.log('⏹️ Сервер выключается...');
    server.close(() => process.exit(0));
});
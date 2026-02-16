const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const https = require('https');
const { URL } = require('url');

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

// ============= API: ИЗВЛЕЧЕНИЕ ВИДЕО (с кешированием и лучшим выбором форматов) =============
app.post('/api/extract', async (req, res) => {
    const { url } = req.body;
    
    if (!url) {
        return res.status(400).json({ error: 'URL обязателен' });
    }

    try {
        console.log(`🔍 Извлечение видео из: ${url}`);

        // ✅ ПРОВЕРКА КЕША (производительность)
        if (urlCache.has(url)) {
            const cached = urlCache.get(url);
            if (Date.now() - cached.timestamp < 3600000) { // 60 минут
                console.log('✅ Использован кеш');
                return res.json(cached.data);
            } else {
                urlCache.delete(url);
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
            const result = {
                url: url,
                title: 'Видео',
                type: 'embed'
            };
            urlCache.set(url, { data: result, timestamp: Date.now() });
            return res.json(result);
        }

        // Используем yt-dlp с таймаутом
        const info = await Promise.race([
            youtubedl(url, {
                dumpSingleJson: true,
                noWarnings: true,
                noCheckCertificate: true,
                preferFreeFormats: true,
                skipDownload: true,
                socketTimeout: 30000
            }),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('youtube-dl request timeout')), 45000)
            )
        ]);

        if (!info) {
            return res.status(422).json({ error: 'no_info' });
        }

        // ✅ ЛУЧШИЙ ВЫБОР ФОРМАТОВ (качество видео)
        let directUrl = info.url || null;
        let title = info.title || 'Видео';
        let type = 'direct';
        
        if ((!directUrl || !directUrl.startsWith('http')) && Array.isArray(info.formats)) {
            // Фильтруем форматы с URL
            const availableFormats = info.formats.filter(f => f.url && f.url.startsWith('http'));
            
            if (availableFormats.length > 0) {
                // ✅ СОРТИРОВКА: видео с аудио > видео без аудио, затем по размеру
                const sorted = availableFormats.sort((a, b) => {
                    const aHasAudio = a.acodec && a.acodec !== 'none';
                    const bHasAudio = b.acodec && b.acodec !== 'none';
                    
                    if (aHasAudio !== bHasAudio) {
                        return aHasAudio ? -1 : 1;
                    }
                    
                    return (b.filesize || 0) - (a.filesize || 0);
                });

                // ✅ ПРЕДПОЧТЕНИЕ: mp4/webm
                const preferred = sorted.find(f => {
                    const ext = (f.ext || '').toLowerCase();
                    return ['mp4', 'webm', 'mov', 'mkv'].includes(ext);
                }) || sorted[0];

                if (preferred && preferred.url) {
                    directUrl = preferred.url;
                    if (preferred.url.includes('.m3u8')) type = 'hls';
                }
            }
        }

        if (!directUrl) {
            console.log(`⚠️ Не найдена прямая ссылка для ${url}`);
            return res.status(422).json({ error: 'no_direct_url' });
        }

        const result = { 
            url: directUrl, 
            title: title, 
            type: type,
            extractor: info.extractor || null,
            duration: info.duration || null 
        };

        // ✅ СОХРАНЯЕМ В КЕШ
        urlCache.set(url, {
            data: result,
            timestamp: Date.now()
        });

        console.log(`✅ Извлечена ссылка для ${title}`);
        return res.json(result);

    } catch (err) {
        console.error('❌ extract error:', err.message);
        
        // ✅ ДЕТАЛИЗАЦИЯ ОШИБОК
        if (err.message.includes('not found')) {
            return res.status(404).json({ error: 'video_not_found' });
        } else if (err.message.includes('429') || err.message.includes('Too Many Requests')) {
            return res.status(429).json({ error: 'rate_limited' });
        } else if (err.message.includes('403') || err.message.includes('Forbidden')) {
            return res.status(403).json({ error: 'access_forbidden' });
        } else if (err.message.includes('unavailable') || err.message.includes('not available')) {
            return res.status(410).json({ error: 'content_unavailable' });
        } else if (err.message.includes('timeout')) {
            return res.status(408).json({ error: 'request_timeout' });
        }
        
        // Fallback при ошибке
        return res.json({
            url: url,
            title: 'Видео',
            type: 'embed'
        });
    }
});

// ============= STREAM PROXY (с SSRF защитой и поддержкой Range) =============
app.get('/stream', (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).send('missing url');

    let parsed;
    try {
        parsed = new URL(videoUrl);
    } catch (e) {
        return res.status(400).send('invalid url');
    }

    // ✅ SSRF ЗАЩИТА — запрет локальных адресов
    const hostname = parsed.hostname;
    if (/^(localhost|127|0\.0\.0\.0)$/.test(hostname) || 
        /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/.test(hostname)) {
        return res.status(403).send('forbidden host');
    }

    const protocol = parsed.protocol === 'https:' ? https : http;

    const options = {
        method: 'GET',
        headers: {}
    };

    // ✅ ПОДДЕРЖКА RANGE ЗАПРОСОВ
    if (req.headers.range) {
        options.headers.Range = req.headers.range;
    }

    const upstream = protocol.request(videoUrl, options, upstreamRes => {
        // ✅ ПРОКСИРОВАНИЕ ВАЖНЫХ ЗАГОЛОВКОВ
        const headersToForward = [
            'content-type', 
            'content-length', 
            'accept-ranges', 
            'content-range', 
            'cache-control', 
            'last-modified'
        ];
        
        headersToForward.forEach(h => {
            if (upstreamRes.headers[h]) {
                res.setHeader(h, upstreamRes.headers[h]);
            }
        });

        res.statusCode = upstreamRes.statusCode || 200;
        upstreamRes.pipe(res);
    });

    upstream.on('error', (err) => {
        console.error('stream proxy error:', err.message);
        if (!res.headersSent) {
            res.status(502).send('bad gateway');
        }
    });

    upstream.end();
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

// ============= VK API =============
app.post('/api/vk', (req, res) => {
    const { oid, id } = req.body;
    if (!oid || !id) return res.status(400).json({ error: 'missing_params' });

    res.json({
        url: `https://vk.com/video_ext.php?oid=${oid}&id=${id}&autoplay=1`,
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
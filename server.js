const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const https = require('https');
const url = require('url');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// Middleware
app.use(cors());
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

        // Отправляем периодическую синхронизацию - ИСПРАВЛЕНО: очищаем старый интервал
        if (socket.syncInterval) {
            try {
                clearInterval(socket.syncInterval);
            } catch (e) {}
        }

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

        socket.syncInterval = syncInterval;
    });

    // ===== КОМАНДЫ УПРАВЛЕНИЯ ВИДЕО (ТОЛЬКО ДЛЯ ВЕДУЩЕГО) =====
    socket.on('video-command', (data) => {
        if (!currentRoomId || !rooms.has(currentRoomId)) return;

        const room = rooms.get(currentRoomId);
        const { action, time, url, title, type, urlFromApi } = data || {};

        // ПРОВЕРКА: Только ведущий может отправлять команды
        if (room.leaderId !== userId) {
            socket.emit('error', { message: 'Только ведущий может управлять видео' });
            return;
        }

        // Обрабатываем специальную команду загрузки (load) с URL/типом
        if (action === 'load') {
            if (!url) {
                socket.emit('error', { message: 'URL не может быть пустым' });
                return;
            }

            room.videoState = {
                isPlaying: false,
                currentTime: 0,
                lastUpdateTime: Date.now(),
                serverTime: Date.now(),
                url: url || null,
                title: title || 'Видео',
                type: type || null,
                lastCommand: 'load'
            };

            console.log(`🎬 ${username} (ведущий) загрузил: ${room.videoState.title} (${room.videoState.url})`);

            io.to(currentRoomId).emit('video-sync', {
                action: 'load',
                url: room.videoState.url,
                title: room.videoState.title,
                type: room.videoState.type,
                urlFromApi: urlFromApi || null,
                leaderId: room.leaderId,
                leaderName: room.getLeader().username,
                timestamp: Date.now(),
                serverTime: Date.now()
            });

            return;
        }

        // Обновляем состояние видео для обычных команд play/pause/seek
        room.videoState = {
            isPlaying: action === 'play',
            currentTime: typeof time === 'number' ? time : room.videoState.currentTime || 0,
            lastUpdateTime: Date.now(),
            serverTime: Date.now(),
            lastCommand: action,
            url: room.videoState.url || null,
            title: room.videoState.title || null,
            type: room.videoState.type || null
        };

        console.log(`🎬 ${username} (ведущий) отправил: ${action} @ ${Number(room.videoState.currentTime).toFixed(2)}s`);

        // Рассылаем ВСЕМ участникам комнаты
        io.to(currentRoomId).emit('video-sync', {
            action: action,
            time: room.videoState.currentTime,
            leaderId: room.leaderId,
            leaderName: room.getLeader().username,
            timestamp: Date.now(),
            serverTime: Date.now()
        });
    });

    // ===== ЧАТ: отправка сообщения =====
    socket.on('send-chat-message', ({ message }) => {
        if (!currentRoomId || !rooms.has(currentRoomId)) return;
        const room = rooms.get(currentRoomId);
        const sender = room.participants.get(userId);
        const usernameToSend = (sender && sender.username) || username;

        // Рассылаем сообщение всем в комнате
        io.to(currentRoomId).emit('chat-message', {
            username: usernameToSend,
            message: String(message || ''),
            timestamp: Date.now()
        });
    });

    // ===== Смена ника пользователя =====
    socket.on('change-username', ({ newUsername }) => {
        if (!currentRoomId || !rooms.has(currentRoomId)) return;
        const room = rooms.get(currentRoomId);
        const participant = room.participants.get(userId);
        if (!participant) return;

        const oldName = participant.username;
        participant.username = String(newUsername || oldName);

        // Уведомляем комнату и обновляем список
        io.to(currentRoomId).emit('participant-joined', {
            participants: room.getParticipantList(),
            message: `${oldName} сменил имя на ${participant.username}`
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

        // Очищаем синхронизацию (с защитой от ошибок)
        if (socket.syncInterval) {
            try {
                clearInterval(socket.syncInterval);
                socket.syncInterval = null;
            } catch (e) {
                console.error('Ошибка при очистке syncInterval:', e);
            }
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

// ============= API: извлечение прямой ссылки (yt-dlp) =============
app.post('/api/extract', async (req, res) => {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: 'missing url' });

    // ИСПРАВЛЕНИЕ: Проверяем кеш первым делом (60 минут)
    if (urlCache.has(url)) {
        const cached = urlCache.get(url);
        if (Date.now() - cached.timestamp < 3600000) { // 60 минут
            console.log(`✅ Кеш попадание для ${url.substring(0, 50)}`);
            return res.json(cached.data);
        } else {
            urlCache.delete(url);
        }
    }

    try {
        // Валидация URL
        try {
            new URL(url);
        } catch (e) {
            return res.status(400).json({ error: 'invalid_url' });
        }

        // Попытка динамически подключить youtube-dl-exec
        let youtubedl;
        try {
            youtubedl = require('youtube-dl-exec');
        } catch (e) {
            console.error('youtube-dl-exec not installed:', e.message);
            return res.status(500).json({ error: 'youtube_dl_not_available' });
        }

        // Получаем метаданные (без скачивания) с таймаутом
        const info = await Promise.race([
            youtubedl(url, {
                dumpSingleJson: true,
                noWarnings: true,
                noCheckCertificate: true,
                preferFreeFormats: true,
                skipDownload: true,
                quiet: false,
                socket_timeout: 30
            }),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('youtube-dl request timeout')), 45000)
            )
        ]);

        if (!info) {
            return res.status(422).json({ error: 'no_info' });
        }

        // Попытка выбрать лучший доступный формат (mp4/webm)
        let directUrl = info.url || null;
        
        if ((!directUrl || !directUrl.startsWith('http')) && Array.isArray(info.formats)) {
            // Фильтруем форматы с URL и сортируем по качеству
            const availableFormats = info.formats.filter(f => f.url && f.url.startsWith('http'));
            
            if (availableFormats.length > 0) {
                // Сортируем: видео с аудио > видео без аудио, затем по размеру
                const sorted = availableFormats.sort((a, b) => {
                    const aHasAudio = a.acodec && a.acodec !== 'none';
                    const bHasAudio = b.acodec && b.acodec !== 'none';
                    
                    if (aHasAudio !== bHasAudio) {
                        return aHasAudio ? -1 : 1;
                    }
                    
                    return (b.filesize || 0) - (a.filesize || 0);
                });

                // Предпочесть mp4/webm
                const preferred = sorted.find(f => {
                    const ext = (f.ext || '').toLowerCase();
                    return ['mp4', 'webm', 'mov', 'mkv'].includes(ext);
                }) || sorted[0];

                if (preferred && preferred.url) {
                    directUrl = preferred.url;
                }
            }
        }

        if (!directUrl) {
            console.log(`⚠️ Не найдена прямая ссылка для ${url}, отправляю info:`, {
                hasUrl: !!info.url,
                formatsCount: Array.isArray(info.formats) ? info.formats.length : 0
            });
            return res.status(422).json({ error: 'no_direct_url', info });
        }

        const responseData = { 
            url: directUrl, 
            title: info.title || null, 
            extractor: info.extractor || null,
            duration: info.duration || null 
        };

        // ИСПРАВЛЕНИЕ: Сохраняем в кеш
        urlCache.set(url, {
            data: responseData,
            timestamp: Date.now()
        });

        console.log(`✅ Извлечена ссылка для ${info.title || url}`);
        return res.json(responseData);
    } catch (err) {
        console.error('❌ extract error for', url, ':', err.message);
        
        // Различные типы ошибок
        if (err.message.includes('not found')) {
            return res.status(404).json({ error: 'video_not_found' });
        } else if (err.message.includes('429') || err.message.includes('Too Many Requests')) {
            return res.status(429).json({ error: 'rate_limited' });
        } else if (err.message.includes('403') || err.message.includes('Forbidden')) {
            return res.status(403).json({ error: 'access_forbidden' });
        } else if (err.message.includes('unavailable') || err.message.includes('not available')) {
            return res.status(410).json({ error: 'content_unavailable' });
        }
        
        return res.status(500).json({ error: 'extract_failed', message: err.message });
    }
});

// ============= STREAM PROXY (поддержка Range) =============
app.get('/stream', (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).send('missing url');

    let parsed;
    try {
        parsed = new URL(url);
    } catch (e) {
        return res.status(400).send('invalid url');
    }

    // Простейшая защита от SSRF — запрет локальных адресов и localhost
    const hostname = parsed.hostname;
    if (/^(localhost|127|0\.0\.0\.0)$/.test(hostname) || /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/.test(hostname)) {
        return res.status(403).send('forbidden host');
    }

    const protocol = parsed.protocol === 'https:' ? require('https') : require('http');

    const options = {
        method: 'GET',
        headers: {}
    };

    // Forward Range header if present
    if (req.headers.range) options.headers.Range = req.headers.range;

    const upstream = protocol.request(url, options, upstreamRes => {
        // Forward some headers
        const headersToForward = ['content-type', 'content-length', 'accept-ranges', 'content-range', 'cache-control', 'last-modified'];
        headersToForward.forEach(h => {
            if (upstreamRes.headers[h]) res.setHeader(h, upstreamRes.headers[h]);
        });

        res.statusCode = upstreamRes.statusCode || 200;
        upstreamRes.pipe(res);
    });

    upstream.on('error', (err) => {
        console.error('stream proxy error', err && err.message);
        if (!res.headersSent) res.status(502).send('bad gateway');
    });

    upstream.end();
});

// ============= RUTUBE API: извлечение прямой ссылки =============
app.post('/api/rutube', async (req, res) => {
    const { videoId } = req.body;
    if (!videoId) return res.status(400).json({ error: 'missing_video_id' });

    try {
        const rutubeRes = await new Promise((resolve, reject) => {
            const urlObj = new URL(`https://api.rutube.ru/video/${videoId}/`);
            const options = {
                hostname: urlObj.hostname,
                path: urlObj.pathname,
                method: 'GET',
                headers: { 
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Referer': 'https://rutube.ru'
                },
                timeout: 10000
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(new Error('Invalid JSON response'));
                    }
                });
            });
            
            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });
            
            req.end();
        });

        if (rutubeRes && (rutubeRes.m3u8_url || rutubeRes.hls_url)) {
            console.log(`✅ Rutube видео получено: ${rutubeRes.title}`);
            return res.json({
                url: rutubeRes.m3u8_url || rutubeRes.hls_url,
                title: rutubeRes.title || null,
                type: 'hls',
                duration: rutubeRes.duration || null
            });
        }
        
        console.warn(`⚠️ Rutube API не вернул ссылку для ${videoId}`);
        res.status(422).json({ error: 'no_stream_url' });
    } catch (err) {
        console.error('❌ Rutube API error:', err.message);
        
        if (err.message.includes('ENOTFOUND') || err.message.includes('ECONNREFUSED')) {
            res.status(503).json({ error: 'service_unavailable' });
        } else {
            res.status(500).json({ error: 'rutube_api_error', message: err.message });
        }
    }
});

// ============= VK API: извлечение видео (альтернатива) =============
app.post('/api/vk', async (req, res) => {
    const { oid, id } = req.body;
    if (!oid || !id) return res.status(400).json({ error: 'missing_params' });

    try {
        // VK не предоставляет публичный API для видео
        // Возвращаем embed ссылку как fallback
        const embedUrl = `https://vk.com/video_ext.php?oid=${oid}&id=${id}&autoplay=1`;
        
        console.log(`✅ VK видео: ${oid}_${id}`);
        return res.json({
            url: embedUrl,
            title: 'VK видео',
            type: 'embed'
        });
    } catch (err) {
        console.error('❌ VK API error:', err.message);
        res.status(500).json({ error: 'vk_api_error', message: err.message });
    }
});

// Обработка завершения процесса
process.on('SIGTERM', () => {
    console.log('⏹️ Сервер выключается...');
    server.close(() => {
        console.log('✅ Сервер остановлен');
        process.exit(0);
    });
});

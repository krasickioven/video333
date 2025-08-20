// server.js - Серверная часть для Google Cloud Platform
const express = require('express');
const WebSocket = require('ws');
const cors = require('cors');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const OBSWebSocket = require('obs-websocket-js').default;

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Состояние сервера
const SERVER_STATE = {
    obs: new OBSWebSocket(),
    obsConnected: false,
    currentSession: null,
    videos: new Map(),
    outputDir: process.env.OUTPUT_DIR || './videos'
};

// Создаем папку для видео если её нет
if (!fsSync.existsSync(SERVER_STATE.outputDir)) {
    fsSync.mkdirSync(SERVER_STATE.outputDir, { recursive: true });
}

// WebSocket сервер
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

// Функция отправки сообщений всем клиентам
function broadcast(message) {
    const data = JSON.stringify(message);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
}

// Функция логирования
function log(message, data = null) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`, data || '');
}

// OBS функции
async function connectToOBS(address, password) {
    try {
        if (SERVER_STATE.obsConnected) {
            await SERVER_STATE.obs.disconnect();
        }

        await SERVER_STATE.obs.connect(address, password);
        SERVER_STATE.obsConnected = true;
        
        log('✅ OBS подключен:', address);
        
        broadcast({
            type: 'obs_status',
            data: { connected: true, address }
        });

        return { success: true };
    } catch (error) {
        log('❌ Ошибка подключения к OBS:', error.message);
        SERVER_STATE.obsConnected = false;
        
        broadcast({
            type: 'obs_status',
            data: { connected: false, error: error.message }
        });

        return { success: false, error: error.message };
    }
}

async function startRecording(blockIndex, blockText) {
    try {
        if (!SERVER_STATE.obsConnected) {
            throw new Error('OBS не подключен');
        }

        // Проверяем статус записи
        const recordStatus = await SERVER_STATE.obs.call('GetRecordStatus');
        if (recordStatus.outputActive) {
            throw new Error('Запись уже активна в OBS');
        }

        // Генерируем имя файла
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `block_${blockIndex + 1}_${timestamp}`;
        
        // Устанавливаем имя файла для записи
        await SERVER_STATE.obs.call('SetRecordDirectory', {
            recordDirectory: path.resolve(SERVER_STATE.outputDir)
        });

        // Начинаем запись
        const result = await SERVER_STATE.obs.call('StartRecord');
        
        SERVER_STATE.currentSession = {
            blockIndex,
            blockText,
            filename,
            startTime: Date.now()
        };

        log(`🔴 Запись начата: ${filename}`);

        broadcast({
            type: 'recording_started',
            data: {
                filename,
                blockIndex,
                startTime: SERVER_STATE.currentSession.startTime
            }
        });

        return { success: true, filename };
    } catch (error) {
        log('❌ Ошибка начала записи:', error.message);
        
        broadcast({
            type: 'error',
            message: `Ошибка начала записи: ${error.message}`
        });

        return { success: false, error: error.message };
    }
}

async function stopRecording() {
    try {
        if (!SERVER_STATE.obsConnected) {
            throw new Error('OBS не подключен');
        }

        if (!SERVER_STATE.currentSession) {
            throw new Error('Нет активной сессии записи');
        }

        // Останавливаем запись
        const result = await SERVER_STATE.obs.call('StopRecord');
        
        // Ждем завершения записи
        await new Promise(resolve => setTimeout(resolve, 2000));

        const session = SERVER_STATE.currentSession;
        const duration = Date.now() - session.startTime;

        // Ищем созданный файл
        const files = await fs.readdir(SERVER_STATE.outputDir);
        const recentFile = files
            .filter(f => f.endsWith('.mp4') || f.endsWith('.mkv'))
            .sort((a, b) => {
                const statA = fsSync.statSync(path.join(SERVER_STATE.outputDir, a));
                const statB = fsSync.statSync(path.join(SERVER_STATE.outputDir, b));
                return statB.mtime - statA.mtime;
            })[0];

        if (!recentFile) {
            throw new Error('Не найден записанный файл');
        }

        const filePath = path.join(SERVER_STATE.outputDir, recentFile);
        const stats = await fs.stat(filePath);

        log(`⏹️ Запись остановлена: ${recentFile}`);

        broadcast({
            type: 'recording_stopped',
            data: {
                filename: recentFile,
                fullPath: filePath,
                outputBytes: stats.size,
                duration,
                blockIndex: session.blockIndex
            }
        });

        SERVER_STATE.currentSession = null;
        return { success: true, filename: recentFile };
    } catch (error) {
        log('❌ Ошибка остановки записи:', error.message);
        
        broadcast({
            type: 'error',
            message: `Ошибка остановки записи: ${error.message}`
        });

        SERVER_STATE.currentSession = null;
        return { success: false, error: error.message };
    }
}

async function mergeVideos(blocks, projectName) {
    try {
        const validBlocks = blocks.filter(filename => {
            const filePath = path.join(SERVER_STATE.outputDir, filename);
            return fsSync.existsSync(filePath);
        });

        if (validBlocks.length === 0) {
            throw new Error('Нет валидных видеофайлов для объединения');
        }

        const outputFilename = `${projectName}.mp4`;
        const outputPath = path.join(SERVER_STATE.outputDir, outputFilename);

        log(`🔄 Начинаем объединение ${validBlocks.length} файлов в ${outputFilename}`);

        if (validBlocks.length === 1) {
            // Если только один файл, просто копируем его
            const sourcePath = path.join(SERVER_STATE.outputDir, validBlocks[0]);
            await fs.copyFile(sourcePath, outputPath);
            log(`📁 Файл скопирован: ${outputFilename}`);
        } else {
            // Объединяем несколько файлов с помощью FFmpeg
            const fileListPath = path.join(SERVER_STATE.outputDir, 'filelist.txt');
            const fileListContent = validBlocks
                .map(filename => `file '${path.join(SERVER_STATE.outputDir, filename)}'`)
                .join('\n');

            await fs.writeFile(fileListPath, fileListContent);

            await new Promise((resolve, reject) => {
                const ffmpeg = spawn('ffmpeg', [
                    '-f', 'concat',
                    '-safe', '0',
                    '-i', fileListPath,
                    '-c', 'copy',
                    '-y',
                    outputPath
                ]);

                let stderr = '';
                
                ffmpeg.stderr.on('data', (data) => {
                    stderr += data.toString();
                });

                ffmpeg.on('close', (code) => {
                    fs.unlink(fileListPath).catch(() => {});
                    
                    if (code === 0) {
                        resolve();
                    } else {
                        reject(new Error(`FFmpeg завершился с кодом ${code}: ${stderr}`));
                    }
                });

                ffmpeg.on('error', reject);
            });

            log(`✅ Видео объединено: ${outputFilename}`);
        }

        const stats = await fs.stat(outputPath);

        broadcast({
            type: 'video_merged',
            data: {
                outputFile: outputPath,
                filename: outputFilename,
                fileSize: stats.size,
                blocksUsed: validBlocks.length
            }
        });

        return { success: true, outputFile: outputPath };
    } catch (error) {
        log('❌ Ошибка объединения видео:', error.message);
        
        broadcast({
            type: 'error',
            message: `Ошибка объединения видео: ${error.message}`
        });

        return { success: false, error: error.message };
    }
}

async function getVideoList() {
    try {
        const files = await fs.readdir(SERVER_STATE.outputDir);
        const videoFiles = files.filter(f => 
            f.endsWith('.mp4') || f.endsWith('.mkv') || f.endsWith('.avi')
        );

        const videos = await Promise.all(
            videoFiles.map(async (filename) => {
                const filePath = path.join(SERVER_STATE.outputDir, filename);
                const stats = await fs.stat(filePath);
                
                return {
                    name: filename,
                    fullPath: filePath,
                    size: `${(stats.size / 1024 / 1024).toFixed(1)} MB`,
                    date: stats.mtime.toLocaleString('ru-RU')
                };
            })
        );

        videos.sort((a, b) => new Date(b.date) - new Date(a.date));

        broadcast({
            type: 'video_list',
            data: { videos }
        });

        return videos;
    } catch (error) {
        log('❌ Ошибка получения списка видео:', error.message);
        return [];
    }
}

// WebSocket обработчики
wss.on('connection', (ws) => {
    log('🔗 Новое WebSocket соединение');

    // Отправляем текущий статус OBS
    ws.send(JSON.stringify({
        type: 'obs_status',
        data: { connected: SERVER_STATE.obsConnected }
    }));

    // Отправляем список видео
    getVideoList();

    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data);
            log(`📨 Получено сообщение: ${message.type}`);

            switch (message.type) {
                case 'connect_obs':
                    await connectToOBS(
                        message.data.address || 'ws://localhost:4455',
                        message.data.password || ''
                    );
                    break;

                case 'start_recording':
                    await startRecording(
                        message.data.blockIndex,
                        message.data.blockText
                    );
                    break;

                case 'stop_recording':
                    await stopRecording();
                    break;

                case 'merge_videos':
                    await mergeVideos(
                        message.data.blocks,
                        message.data.projectName
                    );
                    break;

                case 'get_video_list':
                    await getVideoList();
                    break;

                case 'open_video_folder':
                    // Для Google Cloud можно предоставить ссылку для скачивания
                    ws.send(JSON.stringify({
                        type: 'info',
                        message: `Папка с видео: ${SERVER_STATE.outputDir}`
                    }));
                    break;

                default:
                    log('⚠️ Неизвестный тип сообщения:', message.type);
            }
        } catch (error) {
            log('❌ Ошибка обработки сообщения:', error.message);
            ws.send(JSON.stringify({
                type: 'error',
                message: `Ошибка сервера: ${error.message}`
            }));
        }
    });

    ws.on('close', () => {
        log('🔌 WebSocket соединение закрыто');
    });

    ws.on('error', (error) => {
        log('❌ WebSocket ошибка:', error.message);
    });
});

// REST API эндпоинты
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        obsConnected: SERVER_STATE.obsConnected,
        outputDir: SERVER_STATE.outputDir,
        timestamp: new Date().toISOString()
    });
});

app.get('/videos', async (req, res) => {
    try {
        const videos = await getVideoList();
        res.json({ videos });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/videos/:filename', (req, res) => {
    try {
        const filename = req.params.filename;
        const filePath = path.join(SERVER_STATE.outputDir, filename);
        
        if (!fsSync.existsSync(filePath)) {
            return res.status(404).json({ error: 'Файл не найден' });
        }

        res.download(filePath);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Обработчики OBS событий
SERVER_STATE.obs.on('ConnectionClosed', () => {
    log('🔌 OBS соединение закрыто');
    SERVER_STATE.obsConnected = false;
    broadcast({
        type: 'obs_status',
        data: { connected: false }
    });
});

SERVER_STATE.obs.on('ConnectionError', (error) => {
    log('❌ OBS ошибка соединения:', error.message);
    SERVER_STATE.obsConnected = false;
    broadcast({
        type: 'obs_status',
        data: { connected: false, error: error.message }
    });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    log('🛑 Получен SIGTERM, завершаем работу...');
    
    if (SERVER_STATE.obsConnected) {
        try {
            await SERVER_STATE.obs.disconnect();
        } catch (error) {
            log('❌ Ошибка отключения от OBS:', error.message);
        }
    }
    
    server.close(() => {
        log('✅ Сервер остановлен');
        process.exit(0);
    });
});

process.on('SIGINT', async () => {
    log('🛑 Получен SIGINT, завершаем работу...');
    
    if (SERVER_STATE.obsConnected) {
        try {
            await SERVER_STATE.obs.disconnect();
        } catch (error) {
            log('❌ Ошибка отключения от OBS:', error.message);
        }
    }
    
    server.close(() => {
        log('✅ Сервер остановлен');
        process.exit(0);
    });
});

// Запуск сервера
server.listen(PORT, () => {
    log(`🚀 Сервер запущен на порту ${PORT}`);
    log(`📁 Папка для видео: ${SERVER_STATE.outputDir}`);
    log(`🌐 Health check: http://localhost:${PORT}/health`);
});

module.exports = app;

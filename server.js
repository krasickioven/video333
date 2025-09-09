const WebSocket = require('ws');
const OBSWebSocket = require('obs-websocket-js').default;
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');

class VideoMasterServer {
    constructor() {
        this.port = 3001;
        this.obsPort = 4455;
        this.obsAddress = 'localhost';
        this.obsPassword = '';
        
        // WebSocket servers
        this.wss = null;
        this.clients = new Set();
        
        // OBS connection
        this.obs = new OBSWebSocket();
        this.obsConnected = false;
        
        // Recording state
        this.isRecording = false;
        this.currentBlockIndex = 0;
        this.recordingFiles = [];
        this.projectPath = '';
        this.currentRecordingFile = null;
        this.lastRecordingPath = null; // Полный путь к последней записи
        
        // Settings
        this.settings = {
            videoFormat: 'mp4',
            videoQuality: 'high',
            outputPath: this.getDefaultOutputPath()
        };
        
        // FFmpeg path detection
        this.ffmpegPath = this.findFFmpegPath();
        
        this.initializeServer();
    }

    findFFmpegPath() {
        // Check local ffmpeg.exe first
        const localFFmpeg = path.join(process.cwd(), 'ffmpeg.exe');
        if (fs.existsSync(localFFmpeg)) {
            console.log('✅ Found local FFmpeg:', localFFmpeg);
            return localFFmpeg;
        }
        
        // Check if ffmpeg is in PATH
        try {
            exec('ffmpeg -version', (error) => {
                if (!error) {
                    console.log('✅ FFmpeg found in system PATH');
                } else {
                    console.log('❌ FFmpeg not found in PATH');
                }
            });
            return 'ffmpeg';
        } catch (error) {
            console.log('❌ FFmpeg not found anywhere');
            return null;
        }
    }

    initializeServer() {
        console.log('🎬 Initializing Video Master Server...');
        console.log('📁 Output directory:', this.settings.outputPath);
        console.log('🔧 FFmpeg path:', this.ffmpegPath || 'NOT FOUND');
        
        // Create WebSocket server
        this.wss = new WebSocket.Server({ port: this.port });
        
        this.wss.on('connection', (ws) => {
            console.log('📡 Client connected');
            this.clients.add(ws);
            
            ws.on('message', (message) => {
                this.handleClientMessage(ws, JSON.parse(message));
            });
            
            ws.on('close', () => {
                console.log('📡 Client disconnected');
                this.clients.delete(ws);
            });
            
            ws.on('error', (error) => {
                console.error('WebSocket error:', error);
                this.clients.delete(ws);
            });
        });
        
        // Setup OBS event handlers
        this.setupOBSHandlers();
        
        console.log(`🚀 Video Master Server running on port ${this.port}`);
        console.log('📋 Available commands:');
        console.log('   - connect_obs: Connect to OBS Studio');
        console.log('   - start_recording: Start recording a block');
        console.log('   - stop_recording: Stop recording');
        console.log('   - test_recording: Test 5-second recording');
        console.log('   - merge_videos: Combine all block videos');
    }

    setupOBSHandlers() {
        this.obs.on('ConnectionOpened', () => {
            console.log('✅ Connected to OBS Studio');
            this.obsConnected = true;
            this.broadcastOBSStatus();
        });
        
        this.obs.on('ConnectionClosed', () => {
            console.log('❌ Disconnected from OBS Studio');
            this.obsConnected = false;
            this.broadcastOBSStatus();
        });
        
        this.obs.on('RecordStateChanged', (data) => {
            console.log('📹 Recording state changed:', {
                outputActive: data.outputActive,
                outputPath: data.outputPath,
                outputBytes: data.outputBytes,
                outputTimecode: data.outputTimecode
            });
            
            if (data.outputActive) {
                // Recording started
                this.currentRecordingFile = path.basename(data.outputPath);
                this.lastRecordingPath = data.outputPath;
                this.isRecording = true;
                
                console.log('🎬 ===== ЗАПИСЬ НАЧАТА =====');
                console.log('   📁 Файл:', this.currentRecordingFile);
                console.log('   📂 Полный путь:', this.lastRecordingPath);
                console.log('   🎯 Блок:', this.currentBlockIndex + 1);
                console.log('================================');
                
                this.broadcastToClients({
                    type: 'recording_started',
                    data: { 
                        filename: this.currentRecordingFile,
                        fullPath: this.lastRecordingPath,
                        blockIndex: this.currentBlockIndex
                    }
                });
            } else {
                // Recording stopped
                this.isRecording = false;
                const finalFile = this.currentRecordingFile;
                const finalPath = this.lastRecordingPath;
                
                console.log('⏹️ ===== ЗАПИСЬ ОСТАНОВЛЕНА =====');
                console.log('   📁 Файл:', finalFile);
                console.log('   📂 Полный путь:', finalPath);
                console.log('   🎯 Блок:', this.currentBlockIndex + 1);
                console.log('   📊 Размер:', data.outputBytes ? `${(data.outputBytes / 1024 / 1024).toFixed(2)} MB` : 'неизвестен');
                console.log('   ⏱️ Длительность:', data.outputTimecode || 'неизвестна');
                
                // Проверяем, что файл действительно создан
                if (finalPath && require('fs').existsSync(finalPath)) {
                    const stats = require('fs').statSync(finalPath);
                    console.log('   ✅ Файл подтвержден, размер:', (stats.size / 1024 / 1024).toFixed(2), 'MB');
                } else {
                    console.log('   ❌ ВНИМАНИЕ: Файл не найден!');
                }
                console.log('====================================');
                
                this.broadcastToClients({
                    type: 'recording_stopped',
                    data: { 
                        filename: finalFile,
                        fullPath: finalPath,
                        blockIndex: this.currentBlockIndex,
                        outputBytes: data.outputBytes,
                        outputTimecode: data.outputTimecode,
                        fileExists: finalPath ? require('fs').existsSync(finalPath) : false
                    }
                });
                
                // НЕ очищаем currentRecordingFile - оставляем для принятия решения
                // this.currentRecordingFile = null;
            }
        });
        
        this.obs.on('ConnectionError', (error) => {
            console.error('❌ OBS connection error:', error);
            this.obsConnected = false;
            this.broadcastOBSStatus(error.message);
        });
    }

    async handleClientMessage(ws, message) {
        try {
            console.log('📨 Received message:', message.type, message.data);
            
            switch (message.type) {
                case 'connect_obs':
                    await this.connectToOBS(message.data);
                    break;
                    
                case 'start_recording':
                    await this.startRecording(message.data);
                    break;
                    
                case 'stop_recording':
                    await this.stopRecording();
                    break;
                    
                case 'test_recording':
                    await this.testRecording();
                    break;
                    
                case 'refresh_settings':
                    await this.refreshOBSSettings();
                    break;
                    
                case 'merge_videos':
                    await this.mergeVideos(message.data);
                    break;
                    
                case 'open_video_folder':
                    this.openVideoFolder();
                    break;
                    
                default:
                    console.log('❓ Unknown message type:', message.type);
            }
        } catch (error) {
            console.error('❌ Error handling message:', error);
            this.sendToClient(ws, {
                type: 'error',
                message: error.message
            });
        }
    }

    async connectToOBS(data) {
        try {
            this.obsAddress = data.address.replace('ws://', '').replace('wss://', '');
            this.obsPassword = data.password;
            
            const [host, port] = this.obsAddress.split(':');
            
            console.log(`🔗 Connecting to OBS at ${host}:${port || 4455}...`);
            
            await this.obs.connect(`ws://${host}:${port || 4455}`, this.obsPassword);
            
        } catch (error) {
            console.error('❌ Failed to connect to OBS:', error);
            this.obsConnected = false;
            this.broadcastOBSStatus(error.message);
        }
    }

    async refreshOBSSettings() {
        if (!this.obsConnected) {
            throw new Error('OBS not connected');
        }
        
        try {
            // Get scenes
            const scenesResponse = await this.obs.call('GetSceneList');
            const scenes = scenesResponse.scenes.map(scene => scene.sceneName);
            const currentScene = scenesResponse.currentProgramSceneName;
            
            // Get audio sources
            const inputsResponse = await this.obs.call('GetInputList');
            const audioSources = inputsResponse.inputs
                .filter(input => input.inputKind.includes('audio'))
                .map(input => input.inputName);
            
            // Get recording settings
            const recordResponse = await this.obs.call('GetRecordDirectory');
            const recordingPath = recordResponse.recordDirectory;
            
            this.broadcastOBSStatus(null, {
                scenes,
                currentScene,
                audioSources,
                recordingPath
            });
            
        } catch (error) {
            console.error('❌ Error refreshing OBS settings:', error);
            throw error;
        }
    }

    async startRecording(data) {
        if (!this.obsConnected) {
            throw new Error('OBS not connected');
        }
        
        try {
            this.currentBlockIndex = data.blockIndex;
            
            console.log(`🎬 Starting recording for block ${this.currentBlockIndex + 1}:`);
            console.log('   Block text:', data.blockText?.substring(0, 100) + '...');
            
            // Set recording directory
            await this.obs.call('SetRecordDirectory', {
                recordDirectory: this.settings.outputPath
            });
            
            // Start recording
            await this.obs.call('StartRecord');
            
            console.log(`✅ Recording command sent for block ${this.currentBlockIndex + 1}`);
            
        } catch (error) {
            console.error('❌ Error starting recording:', error);
            throw error;
        }
    }

    async stopRecording() {
        if (!this.obsConnected) {
            console.log('⚠️ OBS not connected, cannot stop recording');
            return;
        }
        
        try {
            console.log(`⏹️ Stopping recording for block ${this.currentBlockIndex + 1}...`);
            
            await this.obs.call('StopRecord');
            
            console.log(`✅ Stop recording command sent for block ${this.currentBlockIndex + 1}`);
            
        } catch (error) {
            console.error('❌ Error stopping recording:', error);
            throw error;
        }
    }

    async testRecording() {
        if (!this.obsConnected) {
            throw new Error('OBS not connected');
        }
        
        try {
            console.log('🧪 Starting test recording for 5 seconds...');
            
            await this.obs.call('StartRecord');
            
            setTimeout(async () => {
                try {
                    await this.obs.call('StopRecord');
                    console.log('✅ Test recording completed');
                } catch (error) {
                    console.error('❌ Error stopping test recording:', error);
                }
            }, 5000);
            
        } catch (error) {
            console.error('❌ Error starting test recording:', error);
            throw error;
        }
    }

    async mergeVideos(data) {
        const { blocks, projectName } = data;
        
        console.log('🔧 ===== НАЧАЛО СКЛЕЙКИ =====');
        console.log('📋 Блоки для склейки:', blocks);
        console.log('📄 Имя проекта:', projectName);
        console.log('🗂️ Папка вывода:', this.settings.outputPath);
        
        if (!this.ffmpegPath) {
            throw new Error('FFmpeg not found. Please install FFmpeg or place ffmpeg.exe in the project folder.');
        }
        
        // Filter out empty blocks and check if files exist
        const videoDir = this.settings.outputPath;
        const validBlocks = blocks.filter(block => {
            if (!block || block.includes('[отклонен]')) {
                console.log(`❌ Пропускаем недействительный блок: ${block}`);
                return false;
            }
            const filePath = path.join(videoDir, block);
            const exists = fs.existsSync(filePath);
            console.log(`📁 Проверка ${block}: ${exists ? '✅ найден' : '❌ не найден'}`);
            if (exists) {
                const stats = fs.statSync(filePath);
                console.log(`   Размер: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
            }
            return exists;
        });
        
        if (validBlocks.length === 0) {
            console.log('📁 Содержимое папки с видео:');
            try {
                const files = fs.readdirSync(videoDir);
                files.forEach(file => {
                    const filePath = path.join(videoDir, file);
                    if (fs.existsSync(filePath)) {
                        const stats = fs.statSync(filePath);
                        console.log(`   📄 ${file} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
                    }
                });
            } catch (error) {
                console.log('❌ Не удалось прочитать папку с видео');
            }
            throw new Error('Нет действительных видеофайлов для склейки');
        }
        
        console.log(`✅ Найдено ${validBlocks.length} действительных блоков для склейки`);
        
        try {
            const outputFile = path.join(videoDir, `${projectName}.mp4`);
            console.log('🎯 Финальный файл:', outputFile);
            
            if (validBlocks.length === 1) {
                // Single file, just copy
                const inputFile = path.join(videoDir, validBlocks[0]);
                console.log('📋 Обнаружен единственный файл, копируем вместо склейки...');
                fs.copyFileSync(inputFile, outputFile);
                console.log('✅ Единственный видеофайл скопирован успешно');
            } else {
                // Multiple files, merge with FFmpeg
                console.log(`🔧 Склейка ${validBlocks.length} файлов с помощью FFmpeg...`);
                await this.mergeWithFFmpeg(validBlocks, outputFile);
            }
            
            // Check if output file was created successfully
            if (fs.existsSync(outputFile)) {
                const stats = fs.statSync(outputFile);
                console.log('🎉 ===== СКЛЕЙКА ЗАВЕРШЕНА =====');
                console.log(`✅ Финальное видео создано: ${outputFile}`);
                console.log(`📊 Размер: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
                console.log(`🧩 Блоков склеено: ${validBlocks.length}`);
                console.log('===============================');
                
                this.broadcastToClients({
                    type: 'video_merged',
                    data: { 
                        outputFile,
                        fileSize: stats.size,
                        blocksCount: validBlocks.length,
                        outputPath: this.settings.outputPath
                    }
                });
                
                // Автоматически открываем папку
                this.openVideoFolder();
                
            } else {
                throw new Error('Выходной файл не был создан');
            }
            
        } catch (error) {
            console.error('❌ Ошибка склейки видео:', error);
            
            // Try alternative merge method
            console.log('🔄 Попытка альтернативного метода склейки...');
            try {
                const altOutputFile = path.join(videoDir, `${projectName}_alt.mp4`);
                await this.mergeVideosAlternative(validBlocks, altOutputFile);
                
                if (fs.existsSync(altOutputFile)) {
                    const stats = fs.statSync(altOutputFile);
                    console.log(`✅ Альтернативная склейка успешна: ${altOutputFile}`);
                    console.log(`   Размер: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
                    
                    this.broadcastToClients({
                        type: 'video_merged',
                        data: { 
                            outputFile: altOutputFile,
                            fileSize: stats.size,
                            blocksCount: validBlocks.length,
                            method: 'alternative',
                            outputPath: this.settings.outputPath
                        }
                    });
                    
                    // Автоматически открываем папку
                    this.openVideoFolder();
                    
                } else {
                    throw new Error('Альтернативная склейка также не смогла создать выходной файл');
                }
            } catch (altError) {
                console.error('❌ Альтернативная склейка также не удалась:', altError);
                throw new Error(`Склейка не удалась: ${error.message}. Альтернативный метод также не сработал: ${altError.message}`);
            }
        }
    }

    async mergeWithFFmpeg(videoFiles, outputFile) {
        return new Promise((resolve, reject) => {
            const videoDir = this.settings.outputPath;
            
            // Create file list for FFmpeg (with proper Windows path escaping)
            const listFile = path.join(videoDir, 'filelist.txt');
            const fileList = videoFiles.map(file => {
                const fullPath = path.join(videoDir, file);
                // Convert Windows paths to forward slashes for FFmpeg
                const ffmpegPath = fullPath.replace(/\\/g, '/');
                return `file '${ffmpegPath}'`;
            }).join('\n');
            
            console.log('📝 Creating filelist.txt:');
            console.log(fileList);
            
            fs.writeFileSync(listFile, fileList, 'utf8');
            
            // Build FFmpeg command with proper quoting
            const ffmpegCmd = `"${this.ffmpegPath}" -f concat -safe 0 -i "${listFile}" -c copy "${outputFile}"`;
            
            console.log('🎬 Running FFmpeg command:');
            console.log(ffmpegCmd);
            
            exec(ffmpegCmd, (error, stdout, stderr) => {
                // Clean up temp file
                try {
                    fs.unlinkSync(listFile);
                    console.log('🗑️ Cleaned up temporary filelist.txt');
                } catch (cleanupError) {
                    console.log('⚠️ Could not delete temp file:', cleanupError.message);
                }
                
                if (error) {
                    console.error('❌ FFmpeg error:', error.message);
                    console.error('📋 FFmpeg stderr:', stderr);
                    reject(new Error(`FFmpeg failed: ${error.message}`));
                } else {
                    console.log('✅ Videos merged successfully with concat method');
                    if (stdout) console.log('📋 FFmpeg stdout:', stdout);
                    resolve();
                }
            });
        });
    }

    async mergeVideosAlternative(videoFiles, outputFile) {
        return new Promise((resolve, reject) => {
            const videoDir = this.settings.outputPath;
            
            // Alternative method: using filter_complex
            const inputs = videoFiles.map((file, index) => {
                const fullPath = path.join(videoDir, file);
                return `-i "${fullPath}"`;
            }).join(' ');
            
            const filterComplex = videoFiles.map((_, index) => `[${index}:v][${index}:a]`).join('') + 
                                 `concat=n=${videoFiles.length}:v=1:a=1[outv][outa]`;
            
            const ffmpegCmd = `"${this.ffmpegPath}" ${inputs} -filter_complex "${filterComplex}" -map "[outv]" -map "[outa]" "${outputFile}"`;
            
            console.log('🔄 Running alternative FFmpeg command (filter_complex):');
            console.log(ffmpegCmd);
            
            exec(ffmpegCmd, (error, stdout, stderr) => {
                if (error) {
                    console.error('❌ Alternative FFmpeg error:', error.message);
                    console.error('📋 Alternative FFmpeg stderr:', stderr);
                    reject(new Error(`Alternative FFmpeg failed: ${error.message}`));
                } else {
                    console.log('✅ Videos merged successfully with filter_complex method');
                    if (stdout) console.log('📋 Alternative FFmpeg stdout:', stdout);
                    resolve();
                }
            });
        });
    }

    openVideoFolder() {
        const platform = process.platform;
        let command;
        
        switch (platform) {
            case 'win32':
                command = `explorer "${this.settings.outputPath}"`;
                break;
            case 'darwin':
                command = `open "${this.settings.outputPath}"`;
                break;
            case 'linux':
                command = `xdg-open "${this.settings.outputPath}"`;
                break;
            default:
                console.log('📁 Video folder:', this.settings.outputPath);
                return;
        }
        
        exec(command, (error) => {
            if (error) {
                console.error('❌ Error opening folder:', error);
            } else {
                console.log('📁 Opened video folder');
            }
        });
    }

    broadcastOBSStatus(error = null, additionalData = {}) {
        const statusData = {
            connected: this.obsConnected,
            error: error,
            ...additionalData
        };
        
        this.broadcastToClients({
            type: 'obs_status',
            data: statusData
        });
    }

    broadcastToClients(message) {
        const messageStr = JSON.stringify(message);
        this.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(messageStr);
            }
        });
    }

    sendToClient(client, message) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(message));
        }
    }

    getDefaultOutputPath() {
        const os = require('os');
        const defaultPath = path.join(os.homedir(), 'Videos', 'VideoMaster');
        
        // Create directory if it doesn't exist
        if (!fs.existsSync(defaultPath)) {
            fs.mkdirSync(defaultPath, { recursive: true });
            console.log('📁 Created video directory:', defaultPath);
        }
        
        return defaultPath;
    }
}

// Start server
const server = new VideoMasterServer();

// Handle graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down Video Master Server...');
    
    if (server.obsConnected) {
        try {
            await server.obs.disconnect();
        } catch (error) {
            console.error('❌ Error disconnecting from OBS:', error);
        }
    }
    
    if (server.wss) {
        server.wss.close();
    }
    
    process.exit(0);
});

module.exports = VideoMasterServer;
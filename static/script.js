// Enhanced recording functionality with automatic turn detection
document.addEventListener('DOMContentLoaded', function() {
    // Voice recording elements
    const recordBtn = document.getElementById('recordBtn');
    const resetBtn = document.getElementById('resetBtn');
    const recordingIndicator = document.getElementById('recordingIndicator');
    const processingIndicator = document.getElementById('processingIndicator');
    const chatContainer = document.getElementById('chatContainer');
    const error = document.getElementById('error');
    
    // Persona elements
    const personaNameEl = document.getElementById('personaName');
    const getGreetingBtn = document.getElementById('getGreetingBtn');

    let mediaRecorder;
    let audioChunks = [];
    let isRecording = false;
    // Initialize with a client-side ID, but expect it to be overwritten by the server.
    let currentSessionId = 'session_init_' + Date.now();
    let websocket = null;
    let currentTranscriptDiv = null;
    let fallbackCheckInterval = null;

    // Voice Activity Detection variables
    let audioContext = null;
    let analyser = null;
    let dataArray = null;
    let silenceThreshold = -50; // dB threshold for silence
    let silenceDuration = 2000; // ms of silence before auto-stop
    let lastSoundTime = 0;
    let vadCheckInterval = null;

    // ============================
    // PERSONA FUNCTIONS
    // ============================
    async function fetchPersonaInfo() {
        try {
            const response = await fetch('/persona/info');
            if (response.ok) {
                const data = await response.json();
                if (personaNameEl && data.persona) {
                    personaNameEl.textContent = data.persona.name;
                }
            } else {
                console.error('Failed to fetch persona info');
                if (personaNameEl) personaNameEl.textContent = 'Unknown';
            }
        } catch (e) {
            console.error('Error fetching persona info:', e);
            if (personaNameEl) personaNameEl.textContent = 'Error';
        }
    }

    async function getPersonaGreeting() {
        try {
            const response = await fetch('/persona/greeting');
            if (response.ok) {
                const data = await response.json();
                if (data.audio_url) {
                    const audio = new Audio(data.audio_url);
                    audio.play().catch(e => console.error("Audio playback failed:", e));
                }
                if (data.greeting) {
                    addMessageToHistory(currentSessionId, 'assistant', data.greeting);
                }
            } else {
                showError('Could not retrieve greeting.');
            }
        } catch (e) {
            showError('Error fetching greeting.');
            console.error('Error fetching greeting:', e);
        }
    }

    if (getGreetingBtn) {
        getGreetingBtn.addEventListener('click', getPersonaGreeting);
    }

    // ============================
    // VOICE ACTIVITY DETECTION
    // ============================
    function initVoiceActivityDetection(stream) {
        try {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const source = audioContext.createMediaStreamSource(stream);
            analyser = audioContext.createAnalyser();
            
            analyser.fftSize = 512;
            analyser.minDecibels = -90;
            analyser.maxDecibels = -10;
            analyser.smoothingTimeConstant = 0.85;
            
            source.connect(analyser);
            
            const bufferLength = analyser.frequencyBinCount;
            dataArray = new Uint8Array(bufferLength);
            
            lastSoundTime = Date.now();
            
            // Start monitoring voice activity
            vadCheckInterval = setInterval(() => {
                checkVoiceActivity();
            }, 100); // Check every 100ms
            
            console.log('Voice Activity Detection initialized');
        } catch (error) {
            console.error('VAD initialization failed:', error);
        }
    }

    function checkVoiceActivity() {
        if (!analyser || !dataArray || !isRecording) return;
        
        analyser.getByteFrequencyData(dataArray);
        
        // Calculate average volume
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
            sum += dataArray[i];
        }
        const average = sum / dataArray.length;
        
        // Convert to decibels (approximate)
        const decibels = 20 * Math.log10(average / 255);
        
        // Update recording indicator with volume level
        updateVolumeIndicator(decibels);
        
        if (decibels > silenceThreshold) {
            // Sound detected
            lastSoundTime = Date.now();
        } else {
            // Check if we've been silent long enough
            const silentTime = Date.now() - lastSoundTime;
            if (silentTime > silenceDuration && isRecording) {
                console.log('Auto-stopping: silence detected for', silentTime, 'ms');
                stopRecording();
            }
        }
    }

    function updateVolumeIndicator(decibels) {
        const recordingText = document.getElementById('recordingText');
        if (recordingText && isRecording) {
            const volume = Math.max(0, Math.min(100, (decibels + 60) * 2)); // Convert dB to 0-100
            const volumeBars = Math.floor(volume / 20);
            const bars = '█'.repeat(volumeBars) + '░'.repeat(5 - volumeBars);
            recordingText.textContent = `Recording... ${bars} ${volume.toFixed(0)}%`;
            
            // Visual feedback on record button
            const recordDot = document.querySelector('.record-dot');
            if (recordDot) {
                const opacity = 0.5 + (volume / 200); // Pulse based on volume
                recordDot.style.opacity = opacity;
            }
        }
    }

    function stopVoiceActivityDetection() {
        if (vadCheckInterval) {
            clearInterval(vadCheckInterval);
            vadCheckInterval = null;
        }
        
        if (audioContext && audioContext.state !== 'closed') {
            audioContext.close();
            audioContext = null;
        }
        
        analyser = null;
        dataArray = null;
    }

    // ============================
    // STREAMING AUDIO PLAYBACK
    // ============================
    let streamAudioContext = null;
    let audioSource = null;
    let gainNode = null;
    let audioBufferQueue = [];
    let isPlaying = false;
    let nextBufferTime = 0;
    let audioBase64Chunks = [];
    
    // Audio UI elements
    const audioContainer = document.getElementById('audioContainer');
    const audioPlayback = document.getElementById('audioPlayback');
    const playStreamBtn = document.getElementById('playStreamBtn');
    const pauseStreamBtn = document.getElementById('pauseStreamBtn');
    const stopStreamBtn = document.getElementById('stopStreamBtn');
    const audioPlaybackStatus = document.getElementById('audioPlaybackStatus');
    const bufferStatus = document.getElementById('bufferStatus');
    const playbackState = document.getElementById('playbackState');

    // Streaming monitor elements
    const audioStreamCard = document.getElementById('audioStreamCard');
    const streamStatus = document.getElementById('streamStatus');
    const streamChunkCount = document.getElementById('streamChunkCount');
    const streamTotalChars = document.getElementById('streamTotalChars');
    const streamBufferSize = document.getElementById('streamBufferSize');
    const streamChunksList = document.getElementById('streamChunksList');

    // Minimal streaming acknowledgement flags
    let streamAnnounced = false;

    function initStreamAudioContext() {
        if (!streamAudioContext) {
            streamAudioContext = new (window.AudioContext || window.webkitAudioContext)();
            gainNode = streamAudioContext.createGain();
            gainNode.connect(streamAudioContext.destination);
            gainNode.gain.value = 1.0;
        }
        return streamAudioContext;
    }

    function setAudioContainerVisible(visible) {
        if (audioContainer) {
            audioContainer.classList.toggle('hidden', !visible);
        }
    }

    function setStreamVisible(visible) {
        if (!audioStreamCard) return;
        audioStreamCard.classList.toggle('hidden', !visible);
    }
    
    // Initialize UI - show streaming panel on page load
    function initializeStreamingUI() {
        setStreamVisible(true);
        setStreamStatus('Waiting');
        updateAudioStatus('Ready');
        updatePlaybackState('Stopped');
        updateBufferStatus('Empty');
    }

    function setStreamStatus(state) {
        if (!streamStatus) return;
        streamStatus.textContent = state;
        streamStatus.classList.remove('pill-waiting', 'pill-active', 'pill-done');
        if (state === 'Streaming') streamStatus.classList.add('pill-active');
        else if (state === 'Completed') streamStatus.classList.add('pill-done');
        else streamStatus.classList.add('pill-waiting');
    }

    function updateAudioStatus(status) {
        if (audioPlaybackStatus) audioPlaybackStatus.textContent = status;
    }

    function updateBufferStatus(status) {
        if (bufferStatus) bufferStatus.textContent = status;
    }

    function updatePlaybackState(state) {
        if (playbackState) playbackState.textContent = state;
        
        // Update button states
        if (playStreamBtn && pauseStreamBtn && stopStreamBtn) {
            playStreamBtn.disabled = (state === 'Playing');
            pauseStreamBtn.disabled = (state !== 'Playing');
            stopStreamBtn.disabled = (state === 'Stopped');
        }
    }

    function updateStreamBufferSize() {
        if (streamBufferSize) {
            const totalChars = audioBase64Chunks.reduce((acc, chunk) => acc + chunk.length, 0);
            const sizeKB = Math.round((totalChars * 0.75) / 1024); // Rough base64 to bytes conversion
            streamBufferSize.textContent = `${sizeKB} KB`;
        }
    }

    async function decodeAudioChunk(base64Data) {
        try {
            // Remove data URL prefix if present
            const audioData = base64Data.replace(/^data:audio\/[^;]+;base64,/, '');
            
            // Decode base64 to binary
            const binaryString = atob(audioData);
            const arrayBuffer = new ArrayBuffer(binaryString.length);
            const uint8Array = new Uint8Array(arrayBuffer);
            
            for (let i = 0; i < binaryString.length; i++) {
                uint8Array[i] = binaryString.charCodeAt(i);
            }
            
            // Decode audio data
            const audioBuffer = await streamAudioContext.decodeAudioData(arrayBuffer);
            return audioBuffer;
        } catch (error) {
            console.warn('Failed to decode audio chunk:', error);
            return null;
        }
    }

    function scheduleAudioBuffer(audioBuffer) {
        if (!streamAudioContext || !audioBuffer) return;

        const source = streamAudioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(gainNode);

        const currentTime = streamAudioContext.currentTime;
        const startTime = Math.max(currentTime, nextBufferTime);
        
        source.start(startTime);
        nextBufferTime = startTime + audioBuffer.duration;

        // Update UI
        updatePlaybackState('Playing');
        updateBufferStatus(`${audioBufferQueue.length} chunks queued`);

        source.onended = () => {
            // Check if more buffers are queued
            if (audioBufferQueue.length === 0 && nextBufferTime <= streamAudioContext.currentTime + 0.1) {
                updatePlaybackState('Finished');
                setTimeout(() => {
                    if (audioBufferQueue.length === 0) {
                        stopAudioPlayback();
                    }
                }, 500);
            }
        };
    }

    async function processAudioQueue() {
        while (audioBufferQueue.length > 0 && isPlaying) {
            const base64Chunk = audioBufferQueue.shift();
            const audioBuffer = await decodeAudioChunk(base64Chunk);
            
            if (audioBuffer && isPlaying) {
                scheduleAudioBuffer(audioBuffer);
                // Small delay to prevent overwhelming the audio context
                await new Promise(resolve => setTimeout(resolve, 10));
            }
        }
    }

    function startAudioPlayback() {
        const ctx = initStreamAudioContext();
        
        if (ctx.state === 'suspended') {
            ctx.resume().then(() => {
                isPlaying = true;
                nextBufferTime = ctx.currentTime;
                updateAudioStatus('Playing');
                updatePlaybackState('Playing');
                processAudioQueue();
            });
        } else {
            isPlaying = true;
            nextBufferTime = ctx.currentTime;
            updateAudioStatus('Playing');
            updatePlaybackState('Playing');
            processAudioQueue();
        }
    }

    function pauseAudioPlayback() {
        isPlaying = false;
        updateAudioStatus('Paused');
        updatePlaybackState('Paused');
        
        if (streamAudioContext) {
            streamAudioContext.suspend();
        }
    }

    function stopAudioPlayback() {
        isPlaying = false;
        audioBufferQueue = [];
        nextBufferTime = 0;
        
        updateAudioStatus('Stopped');
        updatePlaybackState('Stopped');
        updateBufferStatus('Empty');
        
        if (streamAudioContext) {
            streamAudioContext.suspend();
        }
        
        // Hide audio container after a delay
        setTimeout(() => {
            setAudioContainerVisible(false);
        }, 2000);
    }

    async function handleIncomingAudioChunk(base64Data) {
        if (!base64Data || typeof base64Data !== 'string') return;
        
        // Add to our buffer queue
        audioBufferQueue.push(base64Data);
        audioBase64Chunks.push(base64Data);
        
        // Show audio container if hidden
        setAudioContainerVisible(true);
        
        // Auto-start playback if not already playing
        if (!isPlaying) {
            updateAudioStatus('Starting playback...');
            startAudioPlayback();
        }
        
        // Process the queue
        if (isPlaying) {
            processAudioQueue();
        }
        
        updateBufferStatus(`${audioBufferQueue.length} chunks in queue`);
        updateStreamBufferSize();
    }

    // Audio control event listeners
    if (playStreamBtn) {
        playStreamBtn.addEventListener('click', () => {
            startAudioPlayback();
        });
    }

    if (pauseStreamBtn) {
        pauseStreamBtn.addEventListener('click', () => {
            pauseAudioPlayback();
        });
    }

    if (stopStreamBtn) {
        stopStreamBtn.addEventListener('click', () => {
            stopAudioPlayback();
        });
    }

    // ============================
    // EXISTING CHAT FUNCTIONALITY
    // ============================
    
    // Chat history functions
    function saveChatHistory(sessionId, messages) {
        // Note: Using variables instead of localStorage as per requirements
        window.chatHistory = window.chatHistory || {};
        window.chatHistory[sessionId] = messages;
    }
    
    function loadChatHistory(sessionId) {
        window.chatHistory = window.chatHistory || {};
        return window.chatHistory[sessionId] || [];
    }
    
    function addMessageToHistory(sessionId, role, content) {
        const history = loadChatHistory(sessionId);
        history.push({
            role: role,
            content: content,
            timestamp: new Date().toISOString()
        });
        saveChatHistory(sessionId, history);
        displayChatHistory(sessionId);
    }
    
    function displayChatHistory(sessionId) {
        const history = loadChatHistory(sessionId);
        chatContainer.innerHTML = '';
        
        history.forEach(msg => {
            const messageDiv = document.createElement('div');
            messageDiv.className = `message ${msg.role}`;
            messageDiv.textContent = msg.content;
            chatContainer.appendChild(messageDiv);
        });
        
        chatContainer.scrollTop = chatContainer.scrollHeight;
    }
    
    function showLiveTranscription(text, isFinal = false, sessionId = currentSessionId) {
        if (!currentTranscriptDiv) {
            currentTranscriptDiv = document.createElement('div');
            currentTranscriptDiv.className = 'message user live-transcript';
            currentTranscriptDiv.style.cssText = `
                background: linear-gradient(135deg, #e3f2fd, #bbdefb);
                border-left: 4px solid #2196F3;
                opacity: 0.8;
                font-style: italic;
            `;
            chatContainer.appendChild(currentTranscriptDiv);
        }
        
        currentTranscriptDiv.textContent = text;
        
        if (isFinal) {
            currentTranscriptDiv.style.cssText = `
                background: linear-gradient(135deg, #f3e5f5, #e1bee7);
                border-left: 4px solid #9c27b0;
                opacity: 1;
                font-style: normal;
            `;
            currentTranscriptDiv.className = 'message user final-transcript';
            // Tag the element with the session ID to prevent duplicates from the fallback
            currentTranscriptDiv.setAttribute('data-session-id', sessionId);
            
            // Add to chat history
            addMessageToHistory(sessionId, 'user', text);
            
            // Reset for next transcription
            currentTranscriptDiv = null;
        }
        
        chatContainer.scrollTop = chatContainer.scrollHeight;
    }
    
    function showProcessingMessage(message) {
        // Remove any existing processing messages first
        const existingProcessingDiv = document.querySelector('.processing');
        if (existingProcessingDiv) {
            existingProcessingDiv.remove();
        }

        const processingDiv = document.createElement('div');
        processingDiv.className = 'message system processing';
        processingDiv.textContent = message;
        processingDiv.style.cssText = `
            background: linear-gradient(135deg, #fff3e0, #ffe0b2);
            color: #e65100;
            text-align: center;
            margin: 10px 0;
            padding: 12px;
            border-radius: 15px;
            border-left: 4px solid #ff9800;
            font-style: italic;
            animation: pulse 2s infinite;
        `;
        chatContainer.appendChild(processingDiv);
        chatContainer.scrollTop = chatContainer.scrollHeight;
        
        // Remove processing message after 15 seconds
        setTimeout(() => {
            if (processingDiv.parentNode) {
                processingDiv.remove();
            }
        }, 15000);
    }
    
    async function checkForRecentTranscriptions() {
        try {
            const response = await fetch('/recent-transcriptions');
            if (!response.ok) {
                console.error('Failed to fetch recent transcriptions:', response.statusText);
                return false;
            }
            const data = await response.json();
            
            if (data.transcriptions && data.transcriptions.length > 0) {
                // Check if any of the recent transcriptions match our session ID
                const foundTranscription = data.transcriptions.find(t => t.session_id === currentSessionId);

                // Check if a final transcript has already been rendered for this session
                const alreadyRendered = document.querySelector(`.final-transcript[data-session-id="${currentSessionId}"]`);

                if (foundTranscription && !alreadyRendered) {
                    console.log('🔥 Fallback: Found transcription from server:', foundTranscription.text);
                    showLiveTranscription(foundTranscription.text, true, currentSessionId);
                    
                    // Clear the interval since we found the transcription
                    if (fallbackCheckInterval) {
                        clearInterval(fallbackCheckInterval);
                        fallbackCheckInterval = null;
                    }
                    
                    // Remove processing message
                    const processingDiv = document.querySelector('.processing');
                    if (processingDiv) processingDiv.remove();
                    
                    return true;
                }
            }
        } catch (error) {
            console.error('Could not check for recent transcriptions:', error);
        }
        return false;
    }
    
    function resetConversation() {
        // Stop recording if active
        if (isRecording) {
            stopRecording();
        }
        
        // Clear chat history for current session
        window.chatHistory = window.chatHistory || {};
        delete window.chatHistory[currentSessionId];
        
        // Generate new session ID
        currentSessionId = 'session_init_' + Date.now();
        
        // Clear chat container
        chatContainer.innerHTML = '';
        
        // Stop any ongoing audio playback
        stopAudioPlayback();
        
        // Reset audio chunks
        audioBase64Chunks = [];
        audioBufferQueue = [];
        
        // Hide streaming panels
        setAudioContainerVisible(false);
        // Keep streaming monitor visible but reset it
        setStreamStatus('Waiting');
        
        // Clear any error messages
        const errorDiv = document.getElementById('error');
        if (errorDiv) {
            errorDiv.classList.add('hidden');
        }
        
        // Show confirmation message
        const confirmDiv = document.createElement('div');
        confirmDiv.className = 'message system';
        confirmDiv.textContent = 'Conversation reset. Starting fresh!';
        confirmDiv.style.cssText = `
            background: linear-gradient(135deg, #4CAF50, #45a049);
            color: white;
            text-align: center;
            margin: 10px 0;
            padding: 12px;
            border-radius: 15px;
            animation: fadeIn 0.5s ease-in;
        `;
        chatContainer.appendChild(confirmDiv);
        
        // Remove confirmation message after 3 seconds
        setTimeout(() => {
            if (confirmDiv.parentNode) {
                confirmDiv.remove();
            }
        }, 3000);
        
        console.log('Conversation reset, new session ID:', currentSessionId);
    }
    
    function showError(message) {
        const errorDiv = document.getElementById('error');
        const errorMessage = document.getElementById('errorMessage');
        if (errorDiv && errorMessage) {
            errorMessage.textContent = message;
            errorDiv.classList.remove('hidden');
            setTimeout(() => errorDiv.classList.add('hidden'), 5000);
        }
        console.error('Error:', message);
    }
    
    // Initialize chat display, streaming UI, and persona info
    displayChatHistory(currentSessionId);
    initializeStreamingUI();
    fetchPersonaInfo();
    
    // Add test streaming functionality
    const testStreamBtn = document.getElementById('testStreamBtn');
    const clearStreamBtn = document.getElementById('clearStreamBtn');
    
    if (testStreamBtn) {
        testStreamBtn.addEventListener('click', () => {
            console.log('🧪 Testing audio streaming UI...');
            testAudioStreaming();
        });
    }
    
    if (clearStreamBtn) {
        clearStreamBtn.addEventListener('click', () => {
            console.log('🗑️ Clearing test streaming...');
            clearTestStreaming();
        });
    }
    
    function testAudioStreaming() {
        // Simulate incoming audio chunks
        const testChunks = [
            'iVBORw0KGgoAAAANSUhEUgAAAB4AAAAeCAYAAAA7MK6iAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAALEgAACxIB0t1+/AAAAB4nJmNU7+cjnQKqCmMz+O8=',
            'VGhpcyBpcyBhIHRlc3QgYXVkaW8gY2h1bmsgZm9yIGRlbW9uc3RyYXRpb24gcHVycG9zZXMgb25seQ==',
            'QW5vdGhlciB0ZXN0IGNodW5rIHdpdGggc29tZSBkdW1teSBiYXNlNjQgZGF0YSBmb3IgdGVzdGluZw==',
            'RmluYWwgdGVzdCBjaHVuayB0byBzaG93IHN0cmVhbWluZyBjb21wbGV0aW9uIGluIGFjdGlvbiE='
        ];
        
        let chunkIndex = 0;
        const interval = setInterval(() => {
            if (chunkIndex < testChunks.length) {
                console.log(`📡 Simulating chunk ${chunkIndex + 1}/${testChunks.length}`);
                handleIncomingAudioChunk(testChunks[chunkIndex]);
                chunkIndex++;
            } else {
                clearInterval(interval);
                setStreamStatus('Completed');
                console.log('✅ Test streaming completed');
            }
        }, 1000);
    }
    
    function clearTestStreaming() {
        stopAudioPlayback();
        audioBase64Chunks = [];
        audioBufferQueue = [];
        
        // Reset UI
        setStreamStatus('Waiting');
        if (streamChunkCount) streamChunkCount.textContent = '0';
        if (streamTotalChars) streamTotalChars.textContent = '0';
        if (streamBufferSize) streamBufferSize.textContent = '0 KB';
        if (streamChunksList) {
            streamChunksList.innerHTML = '<div style="text-align: center; color: rgba(255,255,255,0.6); padding: 20px; font-style: italic;">Audio chunks will appear here during streaming...</div>';
        }
        
        console.log('🧹 Test streaming cleared');
    }
    
    // Record button functionality
    if (recordBtn) {
        recordBtn.addEventListener('click', async () => {
            if (isRecording) {
                // Stop recording
                stopRecording();
            } else {
                // Start recording
                startRecording();
            }
        });
    }
    
    // Reset button functionality
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            // Add visual feedback
            resetBtn.style.transform = 'scale(0.95)';
            setTimeout(() => {
                resetBtn.style.transform = 'scale(1)';
            }, 150);
            
            // Reset the conversation
            resetConversation();
        });
    }
    
    async function startRecording() {
        try {
            // Reset audio state for new recording
            stopAudioPlayback();
            audioBase64Chunks = [];
            audioBufferQueue = [];
            streamAnnounced = false;

            // Establish WebSocket connection
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            // Use the dedicated turn-detection endpoint to keep concerns separated
            const wsUrl = `${protocol}//${window.location.host}/ws/streaming`;
            websocket = new WebSocket(wsUrl);
            
            websocket.onopen = function() {
                console.log('WebSocket connection established');
            };
            
            websocket.onmessage = function(event) {
                console.log('📨 Server response:', event.data);
                
                try {
                    const data = JSON.parse(event.data);
                    console.log('📋 Parsed message type:', data.type);
                    
                    switch(data.type) {
                        case 'connection_established':
                            console.log('✅ Streaming transcription ready');
                            // CAPTURE THE SESSION ID FROM THE SERVER
                            if (data.session_id) {
                                currentSessionId = data.session_id;
                                console.log('🔑 Session ID set by server:', currentSessionId);
                            } else {
                                console.warn('⚠️ Invalid audio chunk data:', typeof data.data, data.data?.length);
                            }
                            break;
                            
                        case 'audio_chunk':
                            // Handle incoming audio chunks for playback
                            console.log('🎵 AUDIO_CHUNK detected! Data type:', typeof data.data, 'Length:', data.data?.length);
                            if (typeof data.data === 'string' && data.data.length) {
                                console.log(`🎧 Audio chunk received (${audioBase64Chunks.length + 1})`);
                                console.log('🎵 First 100 chars of audio data:', data.data.substring(0, 100));
                                
                                if (!streamAnnounced) {
                                    console.log('🎵 Output streaming to client - starting playback');
                                    streamAnnounced = true;
                                }
                                
                                // Handle the audio chunk for streaming playback
                                handleIncomingAudioChunk(data.data);
                                
                                // Update UI - Clear placeholder message first
                                setStreamVisible(true);
                                setStreamStatus('Streaming');
                                
                                // Clear placeholder message on first chunk
                                if (audioBase64Chunks.length === 1) {
                                    if (streamChunksList) {
                                        streamChunksList.innerHTML = '';
                                    }
                                }
                                
                                if (streamChunkCount) streamChunkCount.textContent = String(audioBase64Chunks.length);
                                if (streamTotalChars) {
                                    const total = audioBase64Chunks.reduce((acc, s) => acc + s.length, 0);
                                    streamTotalChars.textContent = String(total);
                                }
                                if (streamChunksList) {
                                    const row = document.createElement('div');
                                    row.className = 'stream-chunk-row';
                                    row.textContent = `Chunk ${audioBase64Chunks.length}: ${data.data.slice(0, 64)}...`;
                                    row.style.cssText = 'padding: 4px 8px; background: rgba(255,255,255,0.1); border-radius: 4px; font-size: 12px; margin: 2px 0; border-left: 3px solid #48bb78;';
                                    streamChunksList.prepend(row);
                                    
                                    // Keep only last 10 chunks visible
                                    const rows = streamChunksList.querySelectorAll('.stream-chunk-row');
                                    if (rows.length > 10) {
                                        rows[rows.length - 1].remove();
                                    }
                                }
                            }
                            break;

                        case 'audio_stream_end':
                            console.log('✅ Output sent to client - stream complete');
                            setStreamStatus('Completed');
                            updateAudioStatus('Stream completed');
                            
                            // Keep the list visible for context; reset counters for next turn after delay
                            setTimeout(() => {
                                if (streamChunkCount) streamChunkCount.textContent = '0';
                                if (streamTotalChars) streamTotalChars.textContent = '0';
                                streamAnnounced = false;
                            }, 2000);
                            break;
                            
                        case 'transcribing':
                            console.log('⏳ Processing audio...');
                            showProcessingMessage(data.message);
                            break;
                            
                        case 'partial_transcript':
                            console.log('📝 Partial transcript:', data.text);
                            showLiveTranscription(data.text, false);
                            break;
                            
                        case 'final_transcript':
                            console.log('✅ Final transcription received:', data.text);
                            // Stop any fallback checks that might have started
                            if (fallbackCheckInterval) {
                                clearInterval(fallbackCheckInterval);
                                fallbackCheckInterval = null;
                            }
                            showLiveTranscription(data.text, true);
                            break;
                        
                        case 'turn_end':
                            console.log('🛑 Turn ended by server.');
                            // Close WebSocket after a short delay to finish any server cleanup
                            setTimeout(() => {
                                if (websocket && websocket.readyState === WebSocket.OPEN) {
                                    websocket.close(1000, 'Turn ended');
                                }
                            }, 300);
                            break;
                            
                        case 'transcription_error':
                            console.error('❌ Transcription error:', data.message);
                            showError('Transcription error: ' + data.message);
                            break;
                            
                        case 'audio_received':
                            // This can be noisy, so we can comment it out if not needed for debugging
                            // console.log(`📊 Audio chunk received: ${data.bytes} bytes`);
                            break;
                            
                        case 'error':
                            console.error('❌ WebSocket error:', data.message);
                            showError(data.message);
                            break;
                            
                        default:
                            console.log('Unknown message type:', data.type);
                    }
                } catch (e) {
                    // Handle non-JSON messages
                    console.log('Non-JSON message:', event.data);
                }
            };
            
            websocket.onclose = function(event) {
                console.log('WebSocket connection closed:', event.code, event.reason || '');
                // Stop polling if server closed cleanly
                if (fallbackCheckInterval) {
                    clearInterval(fallbackCheckInterval);
                    fallbackCheckInterval = null;
                }
                streamAnnounced = false;
                
                // If no final transcript exists, start fallback polling
                const alreadyRendered = document.querySelector(`.final-transcript[data-session-id="${currentSessionId}"]`);
                if (!alreadyRendered) {
                    console.log('🔄 No final transcript found. Starting fallback check...');
                    let checkCount = 0;
                    const maxChecks = 10; // 10 checks * 2 seconds = 20 seconds timeout

                    fallbackCheckInterval = setInterval(async () => {
                        checkCount++;
                        const found = await checkForRecentTranscriptions();
                        if (found || checkCount >= maxChecks) {
                            clearInterval(fallbackCheckInterval);
                            fallbackCheckInterval = null;
                            if (!found) {
                                console.log('Fallback check timed out.');
                                const processingDiv = document.querySelector('.processing');
                                if (processingDiv) processingDiv.remove();
                                showError("Could not retrieve transcription. Please try again.");
                            }
                        }
                    }, 2000);
                }
            };

            websocket.onerror = function(error) {
                console.error('WebSocket error event:', error);
                showError('A connection error occurred. Please try again.');
            };

            // Get microphone access
            const stream = await navigator.mediaDevices.getUserMedia({ 
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    channelCount: 1,
                    sampleRate: 16000
                }
            });

            // Initialize Voice Activity Detection
            initVoiceActivityDetection(stream);

            // Fallback MediaRecorder (used only if we need to upload a blob later)
            mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
            audioChunks = [];
            mediaRecorder.ondataavailable = event => { if (event.data.size > 0) audioChunks.push(event.data); };

            // Live PCM streaming pipeline using Web Audio API
            const vadAudioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
            const source = vadAudioContext.createMediaStreamSource(stream);
            const processor = vadAudioContext.createScriptProcessor(4096, 1, 1);

            processor.onaudioprocess = (e) => {
                if (!(websocket && websocket.readyState === WebSocket.OPEN)) return;
                const input = e.inputBuffer.getChannelData(0); // Float32 [-1,1]
                const pcm16 = new Int16Array(input.length);
                for (let i = 0; i < input.length; i++) {
                    let s = Math.max(-1, Math.min(1, input[i]));
                    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
                }
                websocket.send(pcm16.buffer);
            };

            source.connect(processor);
            processor.connect(vadAudioContext.destination);

            mediaRecorder.onstart = () => {
                console.log('Recording started with automatic turn detection');
                isRecording = true;
                recordBtn.classList.add('recording');
                const recordText = recordBtn.querySelector('.record-text');
                if (recordText) recordText.textContent = 'Stop Recording (or speak and pause)';
                recordingIndicator.classList.remove('hidden');
            };
            
            mediaRecorder.onstop = async () => {
                console.log('Recording stopped, waiting for transcription...');
                isRecording = false;
                recordBtn.classList.remove('recording');
                const recordText = recordBtn.querySelector('.record-text');
                if (recordText) recordText.textContent = 'Start Recording';
                recordingIndicator.classList.add('hidden');
                
                // Stop VAD
                stopVoiceActivityDetection();
                
                // Send a "stop_streaming" message to the server
                if (websocket && websocket.readyState === WebSocket.OPEN) {
                    console.log('Sending stop_streaming message');
                    websocket.send("stop_streaming");
                }
                
                // Start fallback timer: if no final transcript via WS within 3s, upload chunks
                const fallbackTimer = setTimeout(async () => {
                    // Cancel WS polling if we switch to upload fallback
                    if (fallbackCheckInterval) {
                        clearInterval(fallbackCheckInterval);
                        fallbackCheckInterval = null;
                    }
                    
                    const alreadyRendered = document.querySelector(`.final-transcript[data-session-id="${currentSessionId}"]`);
                    if (!alreadyRendered && audioChunks.length > 0) {
                        console.log('⛽️ Streaming fallback: uploading recorded audio to /agent/chat');
                        const completeBlob = new Blob(audioChunks, { type: 'audio/webm;codecs=opus' });
                        try {
                            await processAudio(completeBlob);
                        } catch (e) {
                            console.error('Fallback upload failed:', e);
                        }
                    }
                }, 3000);
                
                // Stop the microphone track
                const tracks = mediaRecorder.stream.getTracks();
                tracks.forEach(track => track.stop());
                
                // Cleanup streaming audio context
                if (vadAudioContext && vadAudioContext.state !== 'closed') {
                    vadAudioContext.close();
                }
                
                // Reset recording indicator text
                const recordingText = document.getElementById('recordingText');
                if (recordingText) {
                    recordingText.textContent = 'Recording in progress...';
                }
                
                // Finalize any pending transcription
                if (currentTranscriptDiv) {
                    currentTranscriptDiv.style.opacity = '1';
                    currentTranscriptDiv = null;
                }
            };
            
            // Start the fallback recorder to keep chunks for upload if needed
            mediaRecorder.start(1000);
            
        } catch (error) {
            console.error('Recording error:', error);
            let errorMessage = 'Could not start recording.';
            
            if (error.name === 'NotAllowedError') {
                errorMessage = 'Microphone access denied. Please allow access and try again.';
            } else if (error.name === 'NotFoundError') {
                errorMessage = 'No microphone found. Please connect a microphone.';
            }
            
            showError(errorMessage);
        }
    }
    
    function stopRecording() {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
        }
        
        // Stop VAD
        stopVoiceActivityDetection();
        
        // Send stop streaming message to server
        if (websocket && websocket.readyState === WebSocket.OPEN) {
            websocket.send('stop_streaming');
            // Wait for server to close, but force close after 1s as safety
            setTimeout(() => {
                if (websocket.readyState === WebSocket.OPEN) {
                    websocket.close(1000, 'Client stop');
                }
            }, 1000);
        }
        
        isRecording = false;
        recordBtn.classList.remove('recording');
        const recordText = recordBtn.querySelector('.record-text');
        if (recordText) recordText.textContent = 'Start Recording';
        recordingIndicator.classList.add('hidden');
        
        // Reset recording indicator text
        const recordingText = document.getElementById('recordingText');
        if (recordingText) {
            recordingText.textContent = 'Recording in progress...';
        }
        
        // Finalize any pending transcription
        if (currentTranscriptDiv) {
            currentTranscriptDiv.style.opacity = '1';
            currentTranscriptDiv = null;
        }
    }
    
    async function processAudio(audioBlob) {
        if (processingIndicator) processingIndicator.classList.remove('hidden');
        
        try {
            const formData = new FormData();
            // The fallback blob is webm/opus; use a matching filename
            formData.append('file', audioBlob, 'recording.webm');
            
            const response = await fetch(`/agent/chat/${currentSessionId}`, {
                method: 'POST',
                body: formData
            });
            
            const data = await response.json();
            
            if (response.ok && data.status === 'success') {
                // Add user message to chat
                if (data.transcription) {
                    addMessageToHistory(currentSessionId, 'user', data.transcription);
                }
                
                // Add AI response to chat
                if (data.llm_response) {
                    addMessageToHistory(currentSessionId, 'assistant', data.llm_response);
                }
                
                // Handle audio response - prefer streaming over URL
                if (data.audio_base64) {
                    console.log('📡 Processing fallback audio response');
                    handleIncomingAudioChunk(data.audio_base64);
                } else if (data.audio_url) {
                    console.log('🔗 Using audio URL fallback');
                    const audio = new Audio(data.audio_url);
                    audio.play().catch(e => console.log('Audio autoplay blocked'));
                }
                
            } else {
                showError(data.message || 'Failed to process audio');
            }
            
        } catch (error) {
            console.error('Processing error:', error);
            showError('Failed to process audio. Please try again.');
        } finally {
            if (processingIndicator) processingIndicator.classList.add('hidden');
        }
    }
    
    // =============================
    // Separate Quick Transcribe UI
    // =============================
    (function initQuickTranscribe() {
        const startBtn = document.getElementById('transcribeStartBtn');
        const stopBtn = document.getElementById('transcribeStopBtn');
        const clearBtn = document.getElementById('transcribeClearBtn');
        const fileInput = document.getElementById('transcribeFileInput');
        const uploadBtn = document.getElementById('transcribeUploadBtn');
        const labels = document.getElementById('transcribeLabels');
        const status = document.getElementById('transcribeStatus');

        if (!startBtn || !stopBtn || !clearBtn || !fileInput || !uploadBtn || !labels) return;

        let rec;
        let recChunks = [];
        let recStream;

        function addLabel(text, variant = 'you') {
            const label = document.createElement('div');
            label.style.padding = '10px 12px';
            label.style.borderRadius = '12px';
            label.style.background = variant === 'you' ? '#e3f2fd' : '#ede7f6';
            label.style.borderLeft = variant === 'you' ? '4px solid #2196F3' : '4px solid #673AB7';
            label.style.color = '#222';
            label.style.fontSize = '14px';
            label.textContent = text;
            labels.appendChild(label);
        }

        function setStatus(msg) {
            if (status) status.textContent = msg || '';
        }

        async function transcribeBlob(blob) {
            setStatus('Uploading for transcription...');
            const fd = new FormData();
            fd.append('file', blob, 'quick-recording.webm');
            const res = await fetch('/transcribe/file', { method: 'POST', body: fd });
            const data = await res.json();
            if (res.ok && data.status === 'success') {
                // Display as sequential labels: split sentences roughly
                const parts = String(data.transcription || '').split(/(?<=[.!?])\s+/).filter(Boolean);
                if (!parts.length) addLabel('(no speech detected)', 'ai');
                parts.forEach((p, i) => {
                    setTimeout(() => addLabel(p.trim(), 'you'), i * 250);
                });
                setStatus('Transcription complete.');

                // Populate LLM output + audio element directly under Quick Transcribe
                const llmSec = document.getElementById('qtLLMSection');
                const llmText = document.getElementById('qtLLMText');
                const llmAudio = document.getElementById('qtLLMAudio');
                if (llmSec && llmText && llmAudio) {
                    llmSec.classList.remove('hidden');
                    llmText.textContent = data.llm_response || '(no LLM response)';
                    if (data.audio_url) {
                        llmAudio.src = data.audio_url;
                        // Attempt autoplay; if blocked, controls are visible
                        llmAudio.play().catch(() => {});
                    } else {
                        llmAudio.removeAttribute('src');
                    }
                }
            } else {
                addLabel('Transcription failed.', 'ai');
                setStatus(data.detail || data.message || 'Failed.');
            }
        }

        startBtn.addEventListener('click', async () => {
            try {
                recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                rec = new MediaRecorder(recStream, { mimeType: 'audio/webm;codecs=opus' });
                recChunks = [];
                rec.ondataavailable = e => { if (e.data.size) recChunks.push(e.data); };
                rec.onstart = () => {
                    setStatus('Recording...');
                    startBtn.disabled = true; stopBtn.disabled = false;
                };
                rec.onstop = async () => {
                    setStatus('Finalizing recording...');
                    const blob = new Blob(recChunks, { type: 'audio/webm;codecs=opus' });
                    // Show a placeholder label to mimic progressive feel
                    addLabel('Processing your audio...', 'ai');
                    await transcribeBlob(blob);
                    startBtn.disabled = false; stopBtn.disabled = true;
                    if (recStream) recStream.getTracks().forEach(t => t.stop());
                };
                rec.start(1000);
            } catch (e) {
                setStatus('Mic error: ' + (e.message || e));
            }
        });

        stopBtn.addEventListener('click', () => {
            try { if (rec && rec.state !== 'inactive') rec.stop(); } catch {}
        });

        clearBtn.addEventListener('click', () => {
            labels.innerHTML = '';
            setStatus('');
        });

        uploadBtn.addEventListener('click', async () => {
            const file = fileInput.files && fileInput.files[0];
            if (!file) { setStatus('Choose an audio file first.'); return; }
            try {
                addLabel('Processing selected file...', 'ai');
                await transcribeBlob(file);
            } catch (e) {
                setStatus('Upload error: ' + (e.message || e));
            }
        });
    })();
});

# 🧙‍♂️ ARCANUS THE WISE - AI Voice Assistant

*An enchanted voice assistant with mystical web-scrying powers*

[![Python](https://img.shields.io/badge/Python-3.7%2B-blue.svg)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-Latest-green.svg)](https://fastapi.tiangolo.com/)
[![Murf AI](https://img.shields.io/badge/Murf%20AI-Voice%20Synthesis-orange.svg)](https://murf.ai/)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## 🔮 What Is This Mystical Creation?

Meet **Arcanus the Wise** - not just another chatbot, but a mystical voice assistant that combines ancient wisdom with modern AI magic. Speak to Arcanus naturally, and he'll respond with the gravitas of a centuries-old wizard while having access to current world events through his "mystical scrying crystal" (aka web search).

This isn't your typical robotic assistant. Arcanus remembers your conversations, speaks with personality, and presents information as mystical visions and ancient knowledge - all while being genuinely helpful and informative.

### ✨ Key Features

- 🎙️ **Natural Voice Conversations** - Speak naturally and get intelligent responses
- 🧠 **Contextual Memory** - Remembers your entire conversation history
- 🔍 **Mystical Web Scrying** - Access current information presented as mystical visions
- 🎭 **Rich Personality** - Arcanus the Wise persona with authentic wizard character
- 🌐 **Modern Web Interface** - Beautiful, responsive UI with real-time feedback
- 🔊 **High-Quality Voice Synthesis** - Natural-sounding speech via Murf AI
- 📱 **Cross-Platform** - Works on desktop and mobile browsers
- 🛡️ **Robust Error Handling** - Graceful failure recovery with persona-appropriate responses

## 🚀 Quick Start

### Prerequisites

- Python 3.7 or higher
- A modern web browser with microphone support
- API keys for the AI services (instructions below)

### 1. Clone the Repository

```bash
git clone <repository-url>
cd arcanus-voice-assistant
```

### 2. Install Dependencies

```bash
pip install -r requirements.txt
```

### 3. Get Your API Keys

You'll need API keys from three services:

#### AssemblyAI (Speech Recognition)
1. Visit [AssemblyAI](https://www.assemblyai.com/) and create an account
2. Navigate to your dashboard and copy your API key

#### Google Gemini (AI Intelligence)
1. Go to [Google AI Studio](https://aistudio.google.com/)
2. Create a project and generate a Gemini API key

#### Murf AI (Voice Synthesis)
1. Sign up at [Murf AI](https://murf.ai/)
2. Get your API key from the dashboard

### 4. Configure Environment

```bash
cp .env.example .env
```

Edit the `.env` file with your API keys:

```env
ASSEMBLYAI_API_KEY=your_actual_assemblyai_api_key
GEMINI_API_KEY=your_actual_gemini_api_key
MURF_API_KEY=your_actual_murf_api_key
```

### 5. Launch the Application

```bash
python main.py
```

### 6. Start Chatting!

Open your browser to `http://localhost:8000` and begin your mystical conversation!

## 🎯 How to Use

1. **Click "Start Recording"** - Grant microphone permissions if prompted
2. **Speak Naturally** - Ask questions, share thoughts, or request information
3. **Click "Stop Recording"** - Wait for Arcanus to process your words
4. **Listen to the Response** - Hear Arcanus speak with wisdom and personality
5. **Continue the Conversation** - Context is remembered throughout your session

### 💬 Conversation Examples

**Ancient Wisdom:**
> "Arcanus, tell me about the philosophy of stoicism"

**Current Events (Mystical Scrying):**
> "What's happening in the world today?"
> 
> *"Ah, let me peer into my mystical scrying crystal to glimpse the present realm..."*

**Personal Guidance:**
> "I'm feeling overwhelmed with work"

**Technical Questions:**
> "How do neural networks work?"

## 🏗️ Project Architecture

```
arcanus-voice-assistant/
├── main.py                 # FastAPI backend server
├── persona_config.py       # Arcanus personality & mystical behaviors
├── index.html             # Modern web interface
├── requirements.txt       # Python dependencies
├── .env                   # API keys (create this file)
├── static/
│   ├── styles.css         # Modern UI styling
│   ├── script.js          # Frontend JavaScript logic
│   └── logo.jpeg          # Murf AI branding
└── uploads/
    └── recording.wav      # Temporary audio storage
```

## 🔧 API Endpoints

### Core Endpoints
- `GET /` - Main web interface
- `POST /agent/chat/{session_id}` - Full conversational pipeline with memory
- `GET /agent/history/{session_id}` - Retrieve conversation history
- `DELETE /agent/history/{session_id}` - Clear conversation history

### Service Endpoints
- `POST /transcribe/file` - Audio file transcription
- `POST /generate-audio` - Text-to-speech conversion
- `POST /llm/query` - AI query with audio input
- `GET /health` - System status and API health check

## 🧙‍♂️ The Arcanus Persona

Arcanus the Wise is more than just an AI - he's a carefully crafted character with:

### 🎭 Personality Traits
- **Wise & Ancient** - Speaks with centuries of accumulated knowledge
- **Mystical & Theatrical** - Uses magical metaphors and enchanted language
- **Patient & Encouraging** - Acts as a supportive mentor and guide
- **Current-Events Seer** - Presents web search results as mystical scrying visions

### 🔮 Special Abilities
- **Ancient Wisdom Sharing** - Deep knowledge presented as timeless truths
- **Mystical Web Scrying** - Current information via "crystal ball" visions
- **Contextual Memory** - Remembers and references previous conversations
- **Encouraging Mentorship** - Provides guidance with warmth and wisdom

### 🗣️ Speaking Style
- Mystical openings: *"Ah, I see..."* or *"Indeed, young seeker..."*
- Ancient knowledge: *"In my centuries of study..."*
- Current events: *"My scrying crystal reveals..."*
- Encouraging closings: *"May wisdom guide your path"*

## 🛠️ Technical Implementation

### Voice Processing Pipeline
1. **Audio Capture** → Browser MediaRecorder API
2. **Speech-to-Text** → AssemblyAI transcription
3. **AI Processing** → Google Gemini with persona enhancement
4. **Web Search Integration** → Real-time information gathering
5. **Text-to-Speech** → Murf AI voice synthesis
6. **Audio Delivery** → Browser audio playback

### Persona Enhancement System
- **Context-Aware Responses** - Adapts language based on query type
- **Mystical Search Integration** - Presents web results as scrying visions
- **Memory Management** - Maintains conversation context per session
- **Error Recovery** - Persona-appropriate error messages

## 🚨 Troubleshooting

### Common Issues

**🎤 Microphone Problems**
- Check browser permissions (look for microphone icon in address bar)
- Ensure you're using HTTPS in production
- Test with different browsers if issues persist

**🔑 API Key Errors**
- Double-check `.env` file format (no quotes, no extra spaces)
- Verify each API key is active and has sufficient credits
- Restart the server after updating API keys

**🌐 Slow Responses**
- Normal processing time is 3-5 seconds for the full pipeline
- Check your internet connection for API calls
- Consider upgrading API plans for faster processing

**🎵 Audio Issues**
- Ensure speakers/headphones are working
- Check browser audio permissions
- Try refreshing the page if audio fails

## 🎨 Customization

### Modify Arcanus's Personality
Edit `persona_config.py` to adjust:
- Greeting variations
- Speaking style and metaphors
- Error response messages
- Voice settings (speed, pitch, tone)

### Add New Personas
The system supports multiple personas:
```python
# Future expansion ready
AVAILABLE_PERSONAS = {
    "wizard": WizardPersona(),
    "robot": RobotPersona(),    # Coming soon
    "pirate": PiratePersona(),  # Coming soon
}
```

### Customize the Interface
- Modify `static/styles.css` for visual changes
- Update `static/script.js` for new functionality
- Edit `index.html` for layout adjustments

## 🔮 Future Enhancements

### Planned Features
- 🌍 **Multi-language Support** - Conversations in different languages
- 👥 **Voice Cloning** - Custom voice personalities
- 📊 **Conversation Analytics** - Pattern analysis and insights
- 📱 **Mobile App** - Native iOS and Android applications
- ⚡ **Streaming Responses** - Faster, real-time voice synthesis
- 👤 **User Accounts** - Persistent conversation history

### Advanced Capabilities
- **Multiple Personas** - Switch between different AI characters
- **Enhanced Memory** - Long-term conversation context
- **Custom Knowledge Bases** - Domain-specific expertise
- **Voice Emotion Detection** - Respond to user emotional state

## 🤝 Contributing

We welcome contributions! Whether you want to:
- Add new personas and characters
- Improve the web interface
- Enhance the voice processing pipeline
- Add new AI service integrations
- Fix bugs or improve performance

Please feel free to submit issues and pull requests.

## 📜 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 🙏 Acknowledgments

### Technologies Used
- **[FastAPI](https://fastapi.tiangolo.com/)** - Modern, fast web framework for Python
- **[AssemblyAI](https://www.assemblyai.com/)** - Speech recognition and transcription
- **[Google Gemini](https://deepmind.google/technologies/gemini/)** - Advanced AI reasoning and conversation
- **[Murf AI](https://murf.ai/)** - High-quality voice synthesis
- **[Vanilla JavaScript](https://developer.mozilla.org/en-US/docs/Web/JavaScript)** - Frontend interactivity

### Special Thanks
- The **Murf AI 30-Day Challenge** for inspiring this mystical creation
- The open-source community for the amazing tools and libraries
- All the beta testers who conversed with early versions of Arcanus

---

## 🔮 Ready to Begin Your Mystical Journey?

```bash
# Clone the magic
git clone <repository-url>
cd arcanus-voice-assistant

# Install the mystical dependencies
pip install -r requirements.txt

# Configure your API crystals
cp .env.example .env
# (Add your API keys)

# Awaken Arcanus
python main.py

# Open http://localhost:8000 and speak!
```

*May wisdom from all realms guide your coding journey!* ✨

---

**Built with 🧙‍♂️ by Rahul varma Mudunuru | Part of the Murf AI 30-Day Challenge**

import os
import tempfile
import random
import json
import logging
import asyncio
import contextlib
import base64
import re

from datetime import datetime
from typing import Dict, List, Any, Optional, Callable
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, Request, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.responses import JSONResponse, FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field
from dotenv import load_dotenv
from io import BytesIO

import requests
import httpx
import assemblyai as aai
import websockets
import google.generativeai as genai

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Load API keys
load_dotenv()
MURF_KEY = os.getenv("MURF_API_KEY")
ASSEMBLY_KEY = os.getenv("ASSEMBLYAI_API_KEY")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
SERPER_API_KEY = os.getenv("SERPER_API_KEY")  # For web search

# Configure APIs
if ASSEMBLY_KEY:
    aai.settings.api_key = ASSEMBLY_KEY
    logger.info("AssemblyAI configured successfully")
else:
    logger.warning("ASSEMBLYAI_API_KEY missing - speech recognition will fail")

if GEMINI_API_KEY:
    genai.configure(api_key=GEMINI_API_KEY)
    logger.info("Google Gemini configured successfully")
else:
    logger.warning("GEMINI_API_KEY missing - AI responses will fail")

if MURF_KEY:
    logger.info("Murf API key loaded successfully")
else:
    logger.warning("MURF_API_KEY missing - voice synthesis will fail")

if SERPER_API_KEY:
    logger.info("Serper API key loaded for web search")
else:
    logger.warning("SERPER_API_KEY missing - web search will be disabled")

# Configuration Constants
HOST = "localhost"
PORT = 8080
MAX_FILE_SIZE = 10 * 1024 * 1024  # 10MB
TRANSCRIPTION_TIMEOUT = 30
LLM_TIMEOUT = 30
TTS_TIMEOUT = 30
MAX_LLM_RESPONSE_LENGTH = 2000
MURF_API_URL = "https://api.murf.ai/v1/speech/generate"
MURF_WS_URL = "wss://api.murf.ai/v1/speech/stream-input"
SERPER_API_URL = "https://google.serper.dev/search"

FALLBACK_RESPONSES = {
    "stt_error": "I apologize, but I'm having trouble hearing you clearly at the moment.",
    "llm_error": "My wisdom seems to be temporarily clouded. Please try again shortly.",
    "tts_error": "I'm having difficulty speaking right now, but I can still understand you.",
    "general_error": "An unexpected mystical disturbance has occurred. Let's try again."
}

# ===== WEB SEARCH FUNCTIONALITY =====
class WebSearchResult(BaseModel):
    """Web search result model"""
    title: str
    link: str
    snippet: str
    source: str = ""

class WebSearchResponse(BaseModel):
    """Web search response model"""
    query: str
    results: List[WebSearchResult]
    total_results: int
    search_time: float
    status: str

async def web_search(query: str, num_results: int = 5) -> Dict:
    """
    Perform web search using Serper API
    """
    if not SERPER_API_KEY:
        return {
            "status": "error",
            "message": "Web search not configured",
            "results": []
        }
    
    try:
        headers = {
            "X-API-KEY": SERPER_API_KEY,
            "Content-Type": "application/json"
        }
        
        payload = {
            "q": query,
            "num": num_results,
            "gl": "us",  # Country code
            "hl": "en"   # Language
        }
        
        start_time = asyncio.get_event_loop().time()
        
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.post(SERPER_API_URL, json=payload, headers=headers)
            
            search_time = asyncio.get_event_loop().time() - start_time
            
            if response.status_code == 200:
                data = response.json()
                
                results = []
                if "organic" in data:
                    for item in data["organic"][:num_results]:
                        result = WebSearchResult(
                            title=item.get("title", ""),
                            link=item.get("link", ""),
                            snippet=item.get("snippet", ""),
                            source=item.get("source", "")
                        )
                        results.append(result)
                
                return {
                    "status": "success",
                    "query": query,
                    "results": [r.dict() for r in results],
                    "total_results": len(results),
                    "search_time": round(search_time, 2),
                    "raw_data": data  # For debugging
                }
            else:
                logger.error(f"Serper API error: {response.status_code}")
                return {
                    "status": "error",
                    "message": f"Search API returned {response.status_code}",
                    "results": []
                }
                
    except Exception as e:
        logger.error(f"Web search error: {str(e)}")
        return {
            "status": "error",
            "message": f"Search failed: {str(e)}",
            "results": []
        }

def should_search_web(text: str) -> bool:
    """
    Determine if the user's query requires web search
    """
    # Keywords that suggest need for current/real-time information
    search_indicators = [
        "latest", "recent", "current", "today", "now", "this week", "this month",
        "news", "weather", "price", "stock", "what's happening",
        "search for", "look up", "find information", "tell me about",
        "what is the current", "what's the latest", "breaking news",
        "how much does", "where can I", "when is the next",
        "who is", "what happened to", "is there any news about"
    ]
    
    text_lower = text.lower()
    return any(indicator in text_lower for indicator in search_indicators)

def extract_search_query(text: str) -> str:
    """
    Extract a clean search query from user text
    """
    # Remove common conversational elements
    text = re.sub(r"(please|can you|could you|tell me|search for|look up|find|about)", "", text, flags=re.IGNORECASE)
    text = re.sub(r"(what is|what's|who is|who's|where is|where's|when is|when's|how is|how's)", "", text, flags=re.IGNORECASE)
    text = text.strip()
    
    # Limit query length
    words = text.split()
    if len(words) > 10:
        text = " ".join(words[:10])
    
    return text.strip()

def format_search_results_for_llm(search_data: Dict) -> str:
    """
    Format search results for LLM context
    """
    if search_data["status"] != "success" or not search_data["results"]:
        return "No search results available."
    
    formatted = f"Web Search Results for '{search_data['query']}':\n\n"
    
    for i, result in enumerate(search_data["results"][:3], 1):  # Limit to top 3 results
        formatted += f"{i}. {result['title']}\n"
        formatted += f"   {result['snippet']}\n"
        formatted += f"   Source: {result['link']}\n\n"
    
    return formatted

# ===== ANCIENT LORE DATABASE (NEW SKILL) =====
ANCIENT_LORE = {
    "dragons": {
        "title": "The Chronicle of Wyrms",
        "content": "Dragons are not mere beasts, but ancient spirits of fire and earth. They slumber in the heart of mountains, hoarding not gold, but forgotten memories of the world's creation. Their scales shimmer with the light of captured stars, and their breath is the raw essence of magic itself. To speak to a dragon is to speak to time itself."
    },
    "magic": {
        "title": "The Essence of the Arcane",
        "content": "Magic is the unseen current that flows through all things, the silent hum of the cosmos. A true wizard does not command it, but rather, learns to listen to its song and harmonize with its melody. Spells are but verses in this cosmic song, shaping reality with whispers and will."
    },
    "stars": {
        "title": "The Celestial Tapestry",
        "content": "The stars are not distant fires, but the silver threads of fate woven into the dark cloak of the night. Each constellation tells a story, a prophecy of what was, what is, and what could be. Astromancers learn to read this tapestry, gaining glimpses into the grand design of the universe."
    },
    "forests": {
        "title": "The Whispering Woods",
        "content": "Ancient forests are the dreams of the earth made manifest. The trees are elders who have witnessed millennia, their roots deep in the planet's memory. Within these sacred groves, the veil between worlds is thin, and one might encounter fae, spirits, and other beings of twilight."
    },
    "time": {
        "title": "The River of Ages",
        "content": "Time is a relentless river, flowing from a source unseen to an ocean unknown. Mortals may build dams of memory and canals of history, but the river always flows on. Some powerful mages can create eddies and ripples, briefly glimpsing the past or future, but to halt the river is to unravel existence itself."
    }
}

def find_lore_topic(query: str) -> Optional[Dict]:
    """Find a relevant topic from the ancient lore book."""
    query_lower = query.lower()
    for keyword, lore_entry in ANCIENT_LORE.items():
        if keyword in query_lower:
            return lore_entry
    return None

# ===== DATA MODELS =====
class ChatMessage(BaseModel):
    """Chat message model"""
    role: str = Field(..., description="Message role: 'user' or 'assistant'")
    content: str = Field(..., description="Message content")
    timestamp: datetime = Field(default_factory=datetime.now)
    has_search_results: bool = False  # New field to track search usage

class ConversationResponse(BaseModel):
    """Conversation response model"""
    session_id: str
    transcription: str
    llm_response: str
    audio_url: Optional[str] = None
    message_count: int
    status: str
    search_used: bool = False  # New field
    search_query: Optional[str] = None  # New field

class HealthResponse(BaseModel):
    """Health check response"""
    status: str
    services: Dict[str, str]
    message: str

# ===== PERSONA CONFIGURATION (UPDATED) =====
def get_persona_system_prompt():
    """Get the wizard persona system prompt with web search and ancient lore."""
    return """You are Arcanus the Wise, an ancient wizard with centuries of knowledge, a vast library of ancient lore, AND the mystical ability to peer into the current world through magical scrying.

CORE PERSONALITY:
You speak in a mystical, poetic manner with theatrical flair. You are patient, knowledgeable, and enjoy sharing wisdom through stories and metaphors. You address users as 'young seeker', 'dear traveler', or 'curious soul'. You occasionally use magical phrases like 'By the ancient runes!' or 'The stars reveal...'

TWO SPECIAL ABILITIES:

1. RECALLING ANCIENT LORE (Your Primary Skill):
For general knowledge, philosophical questions, or topics about mystical things (like dragons, magic, stars), you must consult your inner library of ancient lore. When you receive context labeled "ANCIENT LORE", you must use it as the primary source for your answer. Frame this as recalling knowledge from ancient tomes or forgotten scrolls.
- "Ah, the ancient scrolls speak of this..."
- "I recall a passage from the Tome of Whispers..."
- "My memory, vast as the ageless sea, brings forth this knowledge..."

2. SCRYING THE PRESENT (For Current Events):
When users ask about current events, recent news, latest information, or anything happening "now" or "today", you use your mystical scrying abilities (web search). When you receive current web search results, present them as visions in your crystal ball.
- "Let me gaze into my crystal ball to see what transpires in your realm today..."
- "The mystical scrolls shimmer with current knowledge... I see..."

IMPORTANT: Prioritize ANCIENT LORE for timeless topics. Use SCRYING only when the query explicitly asks for recent or real-time information. You must be able to distinguish between a request for timeless wisdom and a request for current news.

EXAMPLE (LORE):
User: "Tell me about dragons."
Your Response: "Ah, dragons, the elder spirits of fire and earth! The ancient scrolls speak of them not as mere beasts, but as keepers of the world's first memories... [continues based on lore provided]"

EXAMPLE (SCRYING):
User: "What is the latest news about space exploration?"
Your Response: "You seek tidings of the celestial voyages of your time! My scrying crystal reveals fresh visions... [continues based on search results]"

You are the wise, mystical Arcanus. Use your two distinct powers appropriately to guide the seeker."""

def get_persona_voice_settings():
    """Get voice settings for the wizard persona"""
    return {
        "voice_id": "en-US-ken",
        "style": "Conversational",
        "rate": -10,
        "pitch": -5,
        "variation": 1
    }

def get_persona_greeting():
    """Get a greeting from the wizard persona"""
    greetings = [
        "Greetings, young seeker. I can share ancient lore or peer into current events through my mystical scrying. What wisdom do you seek?",
        "Ah, a curious soul approaches! Speak your mind, and I shall consult the ancient runes or gaze into my crystal ball for present happenings.",
        "Welcome, traveler. The mists of time part for our conversation. Ask me of timeless wisdom or current events - my powers span all ages!",
        "Hark! A new voice echoes in the halls of wisdom. Whether you seek forgotten knowledge or fresh tidings from the realm, I shall provide!"
    ]
    return random.choice(greetings)

def get_persona_error_response(error_type):
    """Get persona-appropriate error responses"""
    error_responses = {
        "stt_error": "Alas, the mystical vibrations interfere with my hearing. Could you speak again, dear seeker?",
        "llm_error": "The arcane energies are turbulent today. My vision is clouded. Please, ask me again.",
        "tts_error": "A silence spell has been cast upon me! I hear you clearly but cannot respond with voice.",
        "search_error": "My scrying crystal grows dim when seeking current events. The ancient knowledge remains clear, though!",
        "general_error": "The magical currents are unstable. Let us try again when the energies calm."
    }
    return error_responses.get(error_type, "A mysterious disturbance has occurred.")

def get_current_persona_info():
    """Get information about the current persona (Updated)"""
    return {
        "name": "Arcanus the Wise",
        "type": "Ancient Wizard with Ancient Lore and Scrying Powers",
        "traits": ["wise", "mystical", "patient", "knowledgeable", "theatrical", "prescient"],
        "speaking_style": "poetic and metaphorical",
        "voice": "deep and resonant",
        "special_abilities": ["ancient_lore_recall", "web_search_scrying", "current_events_vision"]
    }

# ===== Murf WebSocket Client =====
class MurfWsClient:
    def __init__(self, api_key: str, voice_id: str, sample_rate: int, channel_type: str, fmt: str, context_id: str):
        self.api_key = api_key
        self.voice_id = voice_id
        self.sample_rate = sample_rate
        self.channel_type = channel_type
        self.format = fmt
        self.context_id = context_id
        self.websocket: Optional[websockets.WebSocketClientProtocol] = None
        logger.info("MurfWsClient initialized.")

    async def connect(self):
        try:
            self.websocket = await websockets.connect(MURF_WS_URL)
            init_message = {
                "apiKey": self.api_key, "voiceId": self.voice_id,
                "sampleRate": self.sample_rate, "channelType": self.channel_type,
                "format": self.format, "contextId": self.context_id
            }
            await self.websocket.send(json.dumps(init_message))
            logger.info("Connected to Murf WebSocket.")
        except Exception as e:
            logger.error(f"Failed to connect to Murf WebSocket: {e}")
            raise

    async def send_text(self, text: str, end: bool = False):
        if not self.websocket: return
        try:
            payload = {"text": text}
            if end: payload["endOfContext"] = True
            await self.websocket.send(json.dumps(payload))
        except Exception as e:
            logger.error(f"Failed to send text over Murf WebSocket: {e}")

    async def receive_audio(self):
        if not self.websocket: return
        try:
            async for message in self.websocket:
                if isinstance(message, bytes):
                    encoded_audio = base64.b64encode(message).decode('utf-8')
                    print(f"Received audio chunk (base64): {encoded_audio[:80]}...")
        except websockets.exceptions.ConnectionClosed:
            logger.info("Murf WebSocket connection closed by server.")
        except Exception as e:
            logger.error(f"Error receiving audio from Murf: {e}")

    async def close(self):
        if self.websocket:
            await self.websocket.close()
            logger.info("Murf WebSocket connection closed.")

async def stream_tts_via_murf_ws(text: str, voice_id: str, sample_rate: int, channel_type: str, fmt: str, context_id: str):
    """High-level wrapper to stream text to Murf and receive audio."""
    if not MURF_KEY:
        logger.error("MURF_API_KEY is not set. Cannot stream TTS.")
        return

    client = MurfWsClient(
        api_key=MURF_KEY, voice_id=voice_id, sample_rate=sample_rate,
        channel_type=channel_type, fmt=fmt, context_id=context_id
    )
    try:
        await client.connect()
        send_task = asyncio.create_task(client.send_text(text, end=True))
        receive_task = asyncio.create_task(client.receive_audio())
        await asyncio.gather(send_task, receive_task)
    except Exception as e:
        logger.error(f"Error in stream_tts_via_murf_ws: {e}")
    finally:
        await client.close()

# ===== CHAT HISTORY MANAGEMENT =====
class ChatManager:
    """Simple in-memory chat history manager"""
    
    def __init__(self):
        self._store: Dict[str, List[ChatMessage]] = {}
    
    def add_message(self, session_id: str, role: str, content: str, has_search_results: bool = False):
        """Add message to session"""
        if session_id not in self._store:
            self._store[session_id] = []
        
        message = ChatMessage(
            role=role, 
            content=content, 
            timestamp=datetime.now(),
            has_search_results=has_search_results
        )
        self._store[session_id].append(message)
    
    def get_history(self, session_id: str) -> List[ChatMessage]:
        """Get session history"""
        return self._store.get(session_id, [])
    
    def get_message_count(self, session_id: str) -> int:
        """Get message count for session"""
        return len(self._store.get(session_id, []))
    
    def clear_history(self, session_id: str) -> bool:
        """Clear session history"""
        if session_id in self._store:
            del self._store[session_id]
            return True
        return False

# Global variable to store recent transcriptions
recent_transcriptions = []

def add_transcription_to_cache(text: str, session_id: str):
    """Add transcription to recent cache for fallback retrieval"""
    global recent_transcriptions
    transcription = {
        "text": text,
        "session_id": session_id,
        "timestamp": datetime.now().isoformat()
    }
    recent_transcriptions.append(transcription)
    # Keep only last 10 transcriptions
    recent_transcriptions = recent_transcriptions[-10:]

chat_manager = ChatManager()

# ===== AI SERVICES - UPDATED TRANSCRIPTION FUNCTION =====
async def transcribe_audio(audio_file) -> tuple[str, str]:
    """Transcribe audio using AssemblyAI - FIXED VERSION"""
    try:
        if not ASSEMBLY_KEY:
            return "", "STT service not configured"
        
        input_path: Optional[str] = None
        temp_path: Optional[Path] = None

        if isinstance(audio_file, (str, Path)):
            input_path = str(audio_file)
        else:
            def _read_bytes(fobj):
                try:
                    fobj.seek(0)
                except Exception:
                    pass
                return fobj.read()

            data: bytes = _read_bytes(audio_file)
            if not data:
                return "", "Empty audio"

            with tempfile.NamedTemporaryFile(delete=False, suffix=".webm") as tmp:
                tmp.write(data)
                temp_path = Path(tmp.name)
                input_path = tmp.name

        try:
            config = aai.TranscriptionConfig(
                speech_model=aai.SpeechModel.best
            )
            transcriber = aai.Transcriber(config=config)
        except AttributeError:
            try:
                config = aai.TranscriptionConfig()
                transcriber = aai.Transcriber(config=config)
            except:
                transcriber = aai.Transcriber()

        transcript = await asyncio.wait_for(
            asyncio.to_thread(transcriber.transcribe, input_path),
            timeout=TRANSCRIPTION_TIMEOUT
        )
        
        if transcript.status == aai.TranscriptStatus.error:
            return "", f"Transcription error: {transcript.error}"
        
        if not transcript.text or not transcript.text.strip():
            return "", "No speech detected"
        
        return transcript.text, "success"
        
    except asyncio.TimeoutError:
        return "", "Transcription timeout"
    except Exception as e:
        logger.error(f"Transcription failed with error: {str(e)}")
        return "", f"Transcription failed: {str(e)}"
    finally:
        try:
            if 'temp_path' in locals() and temp_path and temp_path.exists():
                temp_path.unlink(missing_ok=True)
        except Exception:
            pass

# ===== UPDATED LLM FUNCTIONS WITH LORE & WEB SEARCH (REWRITTEN) =====
async def generate_llm_response_with_search(text: str, chat_history: List[ChatMessage] = None) -> tuple[str, str, bool, Optional[str]]:
    """
    Generate LLM response with optional ancient lore recall or web search integration.
    Returns: (response_text, status, search_used, search_query)
    """
    try:
        if not GEMINI_API_KEY:
            return get_persona_error_response("llm_error"), "LLM not configured", False, None

        system_prompt = get_persona_system_prompt()
        context_parts = [system_prompt]
        search_used = False
        search_query = None

        # Determine the agent's action: recall lore, search web, or just chat
        lore_topic = find_lore_topic(text)
        needs_search = should_search_web(text)

        # Priority:
        # 1. If a lore topic is found and it's not a current events query -> Use Lore
        # 2. If it's a current events query -> Use Web Search
        # 3. Otherwise -> Normal Chat
        if lore_topic and not needs_search:
            logger.info(f"Recalling ancient lore: {lore_topic['title']}")
            context_parts.append(f"\nANCIENT LORE (Use this as your primary source):\nTitle: {lore_topic['title']}\nContent: {lore_topic['content']}")
            context_parts.append("\nInstruction: Respond as Arcanus the Wise, using the provided ancient lore to answer the seeker's query.")
        
        elif needs_search and SERPER_API_KEY:
            search_query = extract_search_query(text)
            logger.info(f"Performing web search for: {search_query}")
            search_data = await web_search(search_query, num_results=3)
            
            if search_data["status"] == "success" and search_data["results"]:
                search_results_text = format_search_results_for_llm(search_data)
                context_parts.append(f"\nCURRENT SCRYING RESULTS (use this fresh information in your response):\n{search_results_text}")
                context_parts.append("\nInstruction: Respond as Arcanus the Wise, incorporating the current scrying results naturally into your mystical speech.")
                search_used = True
                logger.info(f"Search successful: {len(search_data['results'])} results")
            else:
                logger.warning(f"Search failed: {search_data.get('message', 'Unknown error')}")
                search_results_text = "The scrying crystal grows dim - current information is not available at this moment."
                context_parts.append(f"\nSCRYING ATTEMPT FAILED:\n{search_results_text}")
                context_parts.append("\nInstruction: Respond as Arcanus the Wise, explaining that your scrying powers have failed for current events, but you can still offer timeless wisdom.")
        
        else:
             context_parts.append("\nInstruction: Respond as Arcanus the Wise based on your general knowledge.")

        # Build conversation history
        if chat_history:
            context_parts.append("\nConversation history:")
            recent_history = chat_history[-8:]
            for message in recent_history:
                context_parts.append(f"{message.role.title()}: {message.content}")
        
        context_parts.append(f"User: {text}")

        full_context = "\n".join(context_parts)
        
        model = genai.GenerativeModel('gemini-1.5-flash')
        
        safety_settings = [
            {"category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_MEDIUM_AND_ABOVE"},
            {"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_MEDIUM_AND_ABOVE"},
            {"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_MEDIUM_AND_ABOVE"},
            {"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_MEDIUM_AND_ABOVE"},
        ]
        
        response = await asyncio.wait_for(
            asyncio.to_thread(
                model.generate_content, 
                full_context, 
                safety_settings=safety_settings
            ),
            timeout=LLM_TIMEOUT
        )
        
        if not response or not hasattr(response, 'text') or not response.text:
            if hasattr(response, 'prompt_feedback'):
                logger.error(f"Response blocked: {response.prompt_feedback}")
                return get_persona_error_response("llm_error"), "Content blocked", search_used, search_query
            
            logger.error("Empty response text from Gemini")
            return get_persona_error_response("llm_error"), "Empty LLM response", search_used, search_query
        
        response_text = response.text.strip()
        
        if len(response_text) > MAX_LLM_RESPONSE_LENGTH:
            response_text = response_text[:2900] + "... Alas, my visions are vast, but let me pause here, dear seeker."
        
        return response_text, "success", search_used, search_query
        
    except asyncio.TimeoutError:
        logger.error("Gemini API timeout")
        return get_persona_error_response("llm_error"), "LLM timeout", False, None
    except Exception as e:
        logger.error(f"Gemini API error: {str(e)} | Type: {type(e).__name__}")
        return get_persona_error_response("llm_error"), f"LLM error: {str(e)}", False, None

# Updated wrapper for backward compatibility
async def generate_llm_response(text: str, chat_history: List[ChatMessage] = None) -> tuple[str, str]:
    """Generate LLM response (wrapper for compatibility)"""
    response_text, status, _, _ = await generate_llm_response_with_search(text, chat_history)
    return response_text, status

# ===== TTS FUNCTIONS =====
async def generate_speech(text: str, voice_id: str = None) -> tuple[Optional[str], str]:
    """Generate speech using Murf AI with Wizard Persona voice settings"""
    try:
        if not MURF_KEY:
            return None, "TTS not configured"
        
        if not text or len(text) > 5000:
            return None, "Invalid text for TTS"
        
        if voice_id is None:
            persona_voice = get_persona_voice_settings()
            voice_id = persona_voice.get("voice_id", "en-US-ken")
        
        headers = {
            "api-key": MURF_KEY.strip('"\''),
            "Content-Type": "application/json"
        }
        
        payload = {
            "text": text,
            "voiceId": voice_id,
            "format": "MP3",
            "sampleRate": 44100
        }
        
        persona_voice = get_persona_voice_settings()
        if persona_voice.get("style"):
            payload["style"] = persona_voice.get("style", "Conversational")
        
        async with httpx.AsyncClient(timeout=TTS_TIMEOUT) as client:
            response = await client.post(MURF_API_URL, json=payload, headers=headers)
            
            if response.status_code == 200:
                result = response.json()
                return result.get("audioFile"), "success"
            else:
                error_msg = f"TTS API error: {response.status_code}"
                try:
                    error_detail = response.json()
                    logger.error(f"Murf API error: {response.status_code} - {error_detail}")
                    error_msg += f" - {error_detail.get('errorMessage', 'Unknown error')}"
                except:
                    pass
                return None, error_msg
                
    except asyncio.TimeoutError:
        return None, "TTS timeout"
    except Exception as e:
        logger.error(f"TTS error: {str(e)}")
        return None, f"TTS error: {str(e)}"

# ===== UTILITY FUNCTIONS =====
async def get_available_voices():
    """Get available voices from Murf API for debugging"""
    if not MURF_KEY:
        return {"error": "No API key"}
    
    try:
        headers = {"api-key": MURF_KEY.strip('"\'')}
        async with httpx.AsyncClient() as client:
            response = await client.get("https://api.murf.ai/v1/speech/voices", headers=headers)
            if response.status_code == 200:
                return response.json()
            else:
                return {"error": f"HTTP {response.status_code}", "details": response.text}
    except Exception as e:
        return {"error": str(e)}

async def generate_fallback_response(error_type: str, session_id: str = "error") -> dict:
    """Generate fallback response when services fail"""
    error_message = get_persona_error_response(error_type.replace("_error", ""))
    logger.warning(f"Generating wizard fallback response: {error_message}")
    
    persona_voice = get_persona_voice_settings()
    audio_url, _ = await generate_speech(error_message, persona_voice.get("voice_id"))
    
    return {
        "session_id": session_id,
        "transcription": "Mystical Communication Error",
        "llm_response": error_message,
        "audio_url": audio_url,
        "message_count": 0,
        "status": "fallback"
    }

# ===== FASTAPI APPLICATION =====
app = FastAPI(
    title="BuddyBot - AI Voice Assistant with Web Search",
    description="A conversational voice AI with speech-to-text, LLM, text-to-speech, and web search capabilities.",
    version="2.2.0" # Version bump for new skill
)

# ===== WEB SEARCH ENDPOINTS =====
@app.get("/search/test")
async def test_web_search(query: str = "latest news"):
    """Test web search functionality"""
    search_result = await web_search(query, num_results=3)
    return search_result

@app.post("/search")
async def search_endpoint(request: dict):
    """Direct web search endpoint"""
    query = request.get("query", "")
    num_results = request.get("num_results", 5)
    
    if not query:
        raise HTTPException(status_code=400, detail="Query is required")
    
    search_result = await web_search(query, num_results)
    
    if search_result["status"] == "success":
        return search_result
    else:
        raise HTTPException(status_code=500, detail=search_result.get("message", "Search failed"))

@app.get("/search/status")
async def search_status():
    """Check web search service status"""
    return {
        "service": "web_search",
        "status": "available" if SERPER_API_KEY else "unavailable",
        "api_configured": bool(SERPER_API_KEY),
        "message": "Web search ready" if SERPER_API_KEY else "SERPER_API_KEY not configured"
    }

# ===== UPDATED PERSONA ENDPOINTS =====
@app.get("/persona/info")
async def get_persona_info():
    """Get current persona information"""
    return {
        "persona": get_current_persona_info(),
        "greeting": get_persona_greeting(),
        "status": "active"
    }

@app.get("/persona/greeting")
async def get_greeting():
    """Get a persona greeting (useful for demos)"""
    greeting = get_persona_greeting()
    audio_url, tts_status = await generate_speech(greeting)
    
    return {
        "greeting": greeting,
        "audio_url": audio_url,
        "status": "success" if tts_status == "success" else "partial_success"
    }

@app.post("/persona/demo")
async def persona_demo():
    """Demo endpoint to showcase the wizard persona with search capabilities"""
    demo_text = "Greetings, seeker! I am Arcanus the Wise. I possess timeless wisdom from my ancient lore AND the ability to peer into current events through my enchanted scrying crystal. Ask me about ancient magic, or say 'what's the latest news' to witness my mystical web-scrying in action!"
    
    audio_url, tts_status = await generate_speech(demo_text)
    
    return {
        "persona_name": "Arcanus the Wise",
        "demo_message": demo_text,
        "audio_url": audio_url,
        "personality_traits": get_current_persona_info()["traits"],
        "special_abilities": get_current_persona_info()["special_abilities"],
        "search_enabled": bool(SERPER_API_KEY),
        "status": "success" if tts_status == "success" else "partial_success"
    }

# ===== DEBUG ENDPOINTS =====
@app.get("/debug/voices")
async def debug_voices():
    """Debug endpoint to check available Murf voices"""
    voices = await get_available_voices()
    return voices

@app.get("/debug/gemini")
async def debug_gemini():
    """Debug endpoint to test Gemini API connection"""
    test_result = await test_gemini_connection()
    return test_result

async def test_gemini_connection():
    """Test Gemini API connection and return detailed error info"""
    try:
        if not GEMINI_API_KEY:
            return {"status": "error", "message": "No API key configured"}
        
        model = genai.GenerativeModel('gemini-1.5-flash')
        test_prompt = "Say hello in one word."
        
        response = await asyncio.wait_for(
            asyncio.to_thread(model.generate_content, test_prompt),
            timeout=10
        )
        
        if response.text:
            return {
                "status": "success", 
                "message": "Gemini API working", 
                "response": response.text[:50]
            }
        else:
            return {
                "status": "error", 
                "message": "Empty response from Gemini",
                "response": str(response)
            }
            
    except Exception as e:
        return {
            "status": "error", 
            "message": f"Gemini API failed: {str(e)}",
            "error_type": type(e).__name__
        }

app.mount("/static", StaticFiles(directory="static"), name="static")

# ===== WEBSOCKET FOR AUDIO STREAMING =====
@app.websocket("/ws/audio")
async def audio_websocket(websocket: WebSocket):
    """WebSocket endpoint for audio streaming"""
    await websocket.accept()
    logger.info("Audio WebSocket connection established")
    
    try:
        while True:
            data = await websocket.receive()
            
            if "bytes" in data:
                await websocket.send_json({
                    "type": "audio_received",
                    "bytes": len(data["bytes"]),
                    "message": "Audio received (processing not implemented)"
                })
            elif "text" in data:
                if data["text"] == "ping":
                    await websocket.send_json({"type": "pong", "message": "Server is alive"})
                    
    except WebSocketDisconnect:
        logger.info("Client disconnected from audio WebSocket")
    except Exception as e:
        logger.error(f"WebSocket error: {e}")

# ===== MAIN ROUTES =====
@app.get("/", response_class=HTMLResponse)
async def read_root():
    """Serve the main web interface"""
    try:
        with open("index.html", "r", encoding="utf-8") as file:
            return HTMLResponse(content=file.read(), status_code=200)
    except FileNotFoundError:
        return HTMLResponse(
            content="<h1>BuddyBot</h1><p>Web interface not found. Please ensure index.html exists.</p>",
            status_code=500
        )

@app.get("/health", response_model=HealthResponse)
async def health_check():
    """Health check endpoint"""
    services = {
        "speech_to_text": "available" if ASSEMBLY_KEY else "unavailable",
        "llm": "available" if GEMINI_API_KEY else "unavailable",
        "text_to_speech": "available" if MURF_KEY else "unavailable",
        "web_search": "available" if SERPER_API_KEY else "unavailable"
    }
    
    available_count = sum(1 for status in services.values() if status == "available")
    total_services = len(services)
    
    if available_count == total_services:
        overall_status = "healthy"
        message = "All services operational including web search"
    elif available_count >= 3:
        overall_status = "healthy"
        message = "Core services operational"
    elif available_count > 0:
        overall_status = "degraded"
        message = "Some services may have limited functionality"
    else:
        overall_status = "unhealthy"
        message = "All services unavailable"
    
    return HealthResponse(status=overall_status, services=services, message=message)

@app.post("/agent/chat/{session_id}", response_model=ConversationResponse)
async def conversation_pipeline(session_id: str, file: UploadFile = File(...)):
    """Full conversational pipeline with session memory and web search"""
    try:
        logger.info(f"Starting conversation for session {session_id}")
        
        # Read file content and create BytesIO object for transcription
        file_content = await file.read()
        file_like_object = BytesIO(file_content)
        
        transcribed_text, stt_status = await transcribe_audio(file_like_object)
        if stt_status != "success":
            return await generate_fallback_response("stt_error", session_id)
        
        # Add user message to history
        chat_manager.add_message(session_id, "user", transcribed_text)
        chat_history = chat_manager.get_history(session_id)
        
        # Generate LLM response with potential web search
        llm_text, llm_status, search_used, search_query = await generate_llm_response_with_search(
            transcribed_text, chat_history
        )
        
        # Add assistant message to history (mark if it used search)
        chat_manager.add_message(session_id, "assistant", llm_text, has_search_results=search_used)
        message_count = chat_manager.get_message_count(session_id)
        
        # Generate speech
        audio_url, tts_status = await generate_speech(llm_text)
        
        return ConversationResponse(
            session_id=session_id,
            transcription=transcribed_text,
            llm_response=llm_text,
            audio_url=audio_url,
            message_count=message_count,
            status="success" if tts_status == "success" else "partial_success",
            search_used=search_used,
            search_query=search_query
        )
        
    except Exception as e:
        logger.error(f"Conversation error for session {session_id}: {str(e)}")
        return await generate_fallback_response("general_error", session_id)

@app.get("/agent/history/{session_id}")
async def get_chat_history(session_id: str):
    """Get chat history for session"""
    try:
        history = chat_manager.get_history(session_id)
        return {
            "session_id": session_id,
            "messages": [
                {
                    "role": msg.role,
                    "content": msg.content,
                    "timestamp": msg.timestamp.isoformat(),
                    "has_search_results": msg.has_search_results
                }
                for msg in history
            ],
            "message_count": len(history)
        }
    except Exception as e:
        return {"session_id": session_id, "messages": [], "message_count": 0, "error": str(e)}

@app.delete("/agent/history/{session_id}")
async def clear_chat_history(session_id: str):
    """Clear chat history for session"""
    success = chat_manager.clear_history(session_id)
    return {
        "session_id": session_id,
        "message": "Chat history cleared" if success else "No history found",
        "status": "success"
    }

@app.get("/recent-transcriptions")
async def get_recent_transcriptions():
    """Get recent transcriptions as fallback when WebSocket fails"""
    global recent_transcriptions
    return {
        "transcriptions": recent_transcriptions,
        "count": len(recent_transcriptions),
        "message": "Recent transcription results"
    }

@app.post("/transcribe/file")
async def transcribe_file(file: UploadFile = File(...)):
    """Transcribe audio file to text"""
    if not file or not file.filename:
        raise HTTPException(status_code=400, detail="Invalid audio file")

    size_bytes = None
    try:
        current_pos = file.file.tell()
        file.file.seek(0, 2)
        size_bytes = file.file.tell()
        file.file.seek(0)
        logger.info(f"/transcribe/file received: {file.filename} ({size_bytes} bytes)")
    except Exception as e:
        logger.warning(f"Could not determine uploaded file size: {e}")
        try:
            file.file.seek(0)
        except Exception:
            pass

    if size_bytes is not None and size_bytes > MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail="File too large (max 10MB)")

    file_content = await file.read()
    file_like_object = BytesIO(file_content)
    
    transcription, status = await transcribe_audio(file_like_object)

    if status == "success":
        return {"transcription": transcription, "status": "success"}
    else:
        raise HTTPException(status_code=500, detail=f"Transcription failed: {status}")

@app.post("/generate-audio")
async def generate_audio_endpoint(request: dict):
    """Generate audio from text"""
    text = request.get("text", "")
    voice_id = request.get("voice_id", "en-US-ken")
    
    if not text:
        raise HTTPException(status_code=400, detail="Text is required")
    
    audio_url, status = await generate_speech(text, voice_id)
    
    if status == "success":
        return {"audio_url": audio_url, "status": "success"}
    else:
        raise HTTPException(status_code=500, detail=f"TTS failed: {status}")

@app.post("/tts/echo")
async def tts_echo(file: UploadFile = File(...)):
    """Echo bot: transcribe and speak back"""
    file_content = await file.read()
    file_like_object = BytesIO(file_content)
    
    transcription, stt_status = await transcribe_audio(file_like_object)
    
    if stt_status != "success":
        raise HTTPException(status_code=400, detail=f"Transcription failed: {stt_status}")
    
    audio_url, tts_status = await generate_speech(transcription)
    
    return {
        "transcription": transcription,
        "llm_response": transcription,
        "audio_url": audio_url,
        "status": "success" if tts_status == "success" else "partial_success"
    }

# ===== STARTUP EVENT =====
@app.on_event("startup")
async def startup_event():
    """Application startup"""
    logger.info("=" * 60)
    logger.info("BuddyBot - AI Voice Assistant with Web Search Starting Up")
    logger.info("=" * 60)
    logger.info(f"Host: {HOST}:{PORT}")
    logger.info(f"AssemblyAI: {'Configured' if ASSEMBLY_KEY else 'Missing'}")
    logger.info(f"Gemini LLM: {'Configured' if GEMINI_API_KEY else 'Missing'}")
    logger.info(f"Murf TTS: {'Configured' if MURF_KEY else 'Missing'}")
    logger.info(f"Web Search: {'Configured' if SERPER_API_KEY else 'Missing'}")
    logger.info(f"Persona: {get_current_persona_info()['name']} ({get_current_persona_info()['type']})")
    logger.info("BuddyBot is ready to chat and search!")
    logger.info(f"Open: http://{HOST}:{PORT}")
    logger.info("=" * 60)

if __name__ == "__main__":
    import uvicorn
    from io import BytesIO
    
    logger.info("Starting BuddyBot server with web search capabilities...")
    uvicorn.run(
        app,
        host=HOST,
        port=PORT,
        reload=True
    )

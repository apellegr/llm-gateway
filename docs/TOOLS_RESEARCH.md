# Tools Research for Home Assistant LLM Gateway

**Date:** 2026-02-09
**Status:** Research Phase

---

## Current Tools Implemented

| Tool | Status | Data Source |
|------|--------|-------------|
| `web_search` | Done | wttr.in (weather), CoinGecko (crypto), DuckDuckGo (general) |
| `get_current_time` | Done | System clock with timezone support |
| `calculator` | Done | Safe math evaluation |

---

## Research Summary

### Key Findings

1. **MCP (Model Context Protocol)** is becoming the standard for LLM tool integration
   - Open standard by Anthropic, now under Linux Foundation
   - SDKs available in Python, TypeScript, C#, Java, Kotlin
   - Many pre-built servers available

2. **Home Assistant** has native LLM integration
   - Exposes Assist API for device control
   - Can act as MCP server
   - Local LLM support via home-llm project

3. **Tool Categories** for personal assistants:
   - Communication (notifications, email, messaging)
   - Productivity (todos, calendar, reminders, notes)
   - Information (weather, news, search, translate)
   - Smart Home (device control, automation, sensors)
   - Media (music, images, screenshots)
   - Development (git, filesystem, code execution)

---

## Tool Inventory

### Tier 1: High Priority (Simple Implementation)

#### send_notification
- **Purpose:** Push notifications to phone/desktop
- **Options:**
  - Ntfy.sh (self-hosted, free)
  - Pushover (paid, reliable)
  - Telegram Bot API (already have bot)
  - Home Assistant notifications
- **Complexity:** Low
- **Dependencies:** API key or existing bot

#### set_reminder
- **Purpose:** "Remind me to X at Y time"
- **Implementation:**
  - Store in MongoDB (already have)
  - Background job to check and trigger
  - Send via notification tool
- **Complexity:** Medium
- **Dependencies:** Notification tool, scheduler

#### set_timer
- **Purpose:** "Set a timer for 5 minutes"
- **Implementation:** In-memory timer with callback
- **Complexity:** Low
- **Dependencies:** Notification tool

#### add_todo / manage_todos
- **Purpose:** Task management
- **Options:**
  - Todoist API (free tier available)
  - Local markdown file
  - MongoDB collection
  - Notion API
- **Complexity:** Low-Medium
- **Dependencies:** API key or storage

#### weather_forecast
- **Purpose:** Extended forecast (3-7 days)
- **Implementation:** Extend existing wttr.in integration
- **Complexity:** Low (already have weather)
- **Dependencies:** None

#### unit_converter
- **Purpose:** Convert between units
- **Implementation:** Pure JavaScript
- **Complexity:** Low
- **Dependencies:** None

#### dictionary
- **Purpose:** Word definitions, synonyms, etymology
- **Options:**
  - Free Dictionary API (dictionaryapi.dev)
  - Wordnik API
- **Complexity:** Low
- **Dependencies:** None (free API)

---

### Tier 2: Medium Priority (Moderate Complexity)

#### translate
- **Purpose:** Translate text between languages
- **Options:**
  - LibreTranslate (self-hosted, free)
  - DeepL API (paid, high quality)
  - Google Translate API (paid)
  - Argos Translate (local, offline)
- **Complexity:** Medium
- **Dependencies:** API or self-hosted service

#### send_email
- **Purpose:** Compose and send emails
- **Options:**
  - SMTP (direct)
  - SendGrid API
  - Mailgun API
- **Complexity:** Medium
- **Security:** Need careful input validation
- **Dependencies:** SMTP credentials or API key

#### calendar_events
- **Purpose:** Query and add calendar events
- **Options:**
  - Google Calendar API
  - CalDAV (self-hosted)
  - Microsoft Graph API
  - ICS file parsing
- **Complexity:** Medium-High
- **Dependencies:** OAuth setup

#### read_webpage
- **Purpose:** Fetch and summarize any URL
- **Implementation:**
  - Fetch HTML
  - Convert to markdown/text
  - Optionally summarize with LLM
- **Complexity:** Medium
- **Dependencies:** None

#### take_note / knowledge_base
- **Purpose:** Save and retrieve notes
- **Options:**
  - Local markdown files (Obsidian-compatible)
  - Notion API
  - MongoDB collection
- **Complexity:** Medium
- **Dependencies:** Storage location

#### file_search
- **Purpose:** Search local documents
- **Implementation:** ripgrep on configured directories
- **Complexity:** Medium
- **Security:** Need sandboxing
- **Dependencies:** Configured paths

---

### Tier 3: Smart Home Integration

#### smart_home_control
- **Purpose:** Control lights, switches, thermostats
- **Options:**
  - Home Assistant REST API
  - Home Assistant WebSocket API
  - MQTT direct
- **Complexity:** Medium-High
- **Dependencies:** Home Assistant instance

#### get_device_state
- **Purpose:** Query device/sensor states
- **Implementation:** Home Assistant API
- **Complexity:** Medium
- **Dependencies:** Home Assistant

#### create_automation
- **Purpose:** Create HA automations via natural language
- **Implementation:** Home Assistant API
- **Complexity:** High
- **Dependencies:** Home Assistant

#### get_sensor_history
- **Purpose:** Historical sensor data
- **Implementation:** Home Assistant history API
- **Complexity:** Medium
- **Dependencies:** Home Assistant

#### presence_detection
- **Purpose:** Who's home?
- **Implementation:** Home Assistant person entities
- **Complexity:** Low (if HA exists)
- **Dependencies:** Home Assistant with presence tracking

#### music_control
- **Purpose:** Play/pause/search music
- **Options:**
  - Spotify API
  - Home Assistant media_player
  - MPD/Mopidy
- **Complexity:** Medium
- **Dependencies:** Music service

---

### Tier 4: Advanced Tools

#### image_generation
- **Purpose:** Generate images from text
- **Options:**
  - Local Stable Diffusion (ComfyUI API)
  - DALL-E API
  - Midjourney (no official API)
- **Complexity:** High
- **Dependencies:** GPU or API credits

#### code_execution
- **Purpose:** Run code snippets safely
- **Implementation:** Sandboxed container
- **Complexity:** High
- **Security:** Critical sandboxing required
- **Dependencies:** Docker or similar

#### screenshot
- **Purpose:** Capture screen
- **Implementation:** System command (scrot, gnome-screenshot)
- **Complexity:** Low
- **Security:** Privacy concerns
- **Dependencies:** Display access

#### clipboard
- **Purpose:** Read/write clipboard
- **Implementation:** xclip, pbcopy/pbpaste
- **Complexity:** Low
- **Dependencies:** Display access

#### git_operations
- **Purpose:** Git repo management
- **Options:**
  - MCP Git server
  - Direct git commands
- **Complexity:** Medium
- **Security:** Path restrictions needed
- **Dependencies:** Git

---

### MCP Servers Available

| Server | Purpose | Source |
|--------|---------|--------|
| Filesystem | Secure file operations | Official |
| Memory | Persistent knowledge graph | Official |
| Git | Repo operations | Official |
| Fetch | Web content fetching | Official |
| Sequential Thinking | Multi-step reasoning | Official |
| Notion | Docs/databases | Community |
| Todoist | Task management | Community |
| Google Calendar | Calendar | Community |
| Spotify | Music control | Community |
| Home Assistant | Smart home | Community |
| Slack | Messaging | Community |
| Discord | Messaging | Community |
| Brave Search | Web search | Community |
| Puppeteer | Browser automation | Community |
| PostgreSQL | Database queries | Community |

---

## Implementation Notes

### Architecture Options

1. **Native Tools (Current Approach)**
   - Tools defined in index.js
   - Gateway executes tools directly
   - Simple, fast, no extra dependencies

2. **MCP Integration**
   - Gateway acts as MCP client
   - Connect to MCP servers for tools
   - More flexible, ecosystem of servers
   - Adds complexity

3. **Hybrid Approach**
   - Core tools native (search, calc, time)
   - Complex tools via MCP (Home Assistant, Notion)
   - Best of both worlds

### Security Considerations

- **Input Validation:** All tool inputs must be sanitized
- **Path Restrictions:** File operations limited to allowed directories
- **Rate Limiting:** Prevent abuse of external APIs
- **Authentication:** Secure storage of API keys
- **Sandboxing:** Code execution must be isolated
- **Prompt Injection:** Tools can be vectors for injection attacks

### External Services Needed

| Service | Purpose | Cost |
|---------|---------|------|
| Telegram Bot | Notifications (existing) | Free |
| wttr.in | Weather (existing) | Free |
| CoinGecko | Crypto (existing) | Free |
| DuckDuckGo | Search (existing) | Free |
| LibreTranslate | Translation | Free (self-host) |
| Todoist | Tasks | Free tier |
| Free Dictionary API | Definitions | Free |
| Home Assistant | Smart home | Free (self-host) |

---

## Sources

- [Home Assistant AI Integration](https://www.home-assistant.io/blog/2024/06/07/ai-agents-for-the-smart-home/)
- [Home LLM Project](https://github.com/acon96/home-llm)
- [MCP Servers Repository](https://github.com/modelcontextprotocol/servers)
- [Awesome MCP Servers](https://mcpservers.org/)
- [OpenAI Function Calling](https://platform.openai.com/docs/guides/function-calling)
- [Extended OpenAI Conversation for HA](https://github.com/jekalmin/extended_openai_conversation)
- [Home Assistant Developer Docs - LLM](https://developers.home-assistant.io/docs/core/llm/)

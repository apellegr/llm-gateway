# LLM Gateway

Intelligent LLM routing proxy with multi-backend support, smart routing, tool calling, and format conversion.

## Architecture

```
                                    ┌─────────────────────────────────────────┐
                                    │            LLM Gateway                   │
                                    │              (Node.js)                   │
                                    └─────────────────────────────────────────┘
                                                      │
    ┌─────────────────────────────────────────────────┼─────────────────────────────────────────────────┐
    │                                                 │                                                 │
    ▼                                                 ▼                                                 ▼
┌───────────────┐                            ┌───────────────────┐                            ┌─────────────────┐
│  Web Dashboard│                            │   Main Proxy      │                            │ Prometheus      │
│   :8080/      │                            │   :8080/v1/*      │                            │ Metrics :9090   │
└───────────────┘                            └───────────────────┘                            └─────────────────┘
                                                      │
                          ┌───────────────────────────┼───────────────────────────┐
                          │                           │                           │
                          ▼                           ▼                           ▼
                  ┌──────────────┐           ┌──────────────┐           ┌──────────────┐
                  │ Smart Router │           │   Format     │           │    Tool      │
                  │Classification│           │  Conversion  │           │  Injection   │
                  └──────────────┘           └──────────────┘           └──────────────┘
                          │                           │                           │
                          └───────────────────────────┼───────────────────────────┘
                                                      │
        ┌─────────────────┬───────────────────────────┼───────────────────────────┬─────────────────┐
        │                 │                           │                           │                 │
        ▼                 ▼                           ▼                           ▼                 ▼
  ┌──────────┐     ┌────────────┐            ┌──────────────┐            ┌──────────────┐   ┌─────────┐
  │concierge │     │ secretary  │            │  archivist   │            │  anthropic   │   │ MongoDB │
  │  :8001   │     │   :8002    │            │    :8003     │            │ api.anthropic│   │ Storage │
  │ 3B fast  │     │  14B code  │            │ 70B research │            │    .com      │   │         │
  └──────────┘     └────────────┘            └──────────────┘            └──────────────┘   └─────────┘
```

## Features

- **Multi-Backend Routing** - Route requests to multiple LLM backends (local llama.cpp servers, Anthropic API)
- **Smart Routing** - Automatically classify queries and route to the best backend based on content
- **Tool Calling** - Automatic tool injection for local models (web search, calculator, time)
- **Format Conversion** - Bidirectional conversion between Anthropic, OpenAI Chat Completions, and Responses API formats
- **Real-Time Data** - Weather (wttr.in), crypto prices (CoinGecko), web search (DuckDuckGo)
- **MongoDB Storage** - Persistent request/response logging with privacy controls
- **Web Dashboard** - Real-time monitoring, stats, and controls
- **CLI Interface** - Control the gateway via `proxy-cli` commands
- **Streaming Support** - Full SSE streaming with format translation
- **Prometheus Metrics** - Metrics endpoint for monitoring

## Quick Start

### Docker

```bash
docker run -d \
  -p 8080:8080 \
  -p 9090:9090 \
  -v ./config.json:/config/config.json \
  -e ANTHROPIC_API_KEY=your-key \
  ghcr.io/apellegr/llm-gateway:latest
```

### Docker Compose

```yaml
services:
  llm-gateway:
    image: ghcr.io/apellegr/llm-gateway:latest
    ports:
      - "8080:8080"
      - "9090:9090"
    volumes:
      - ./config.json:/config/config.json
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
```

### From Source

```bash
git clone https://github.com/apellegr/llm-gateway.git
cd llm-gateway
npm install
node index.js
```

## Configuration

Create a `config.json` file:

```json
{
  "backends": {
    "concierge": "http://localai.treehouse:8001",
    "secretary": "http://localai.treehouse:8002",
    "archivist": "http://localai.treehouse:8003",
    "anthropic": "https://api.anthropic.com"
  },
  "defaultBackend": "concierge",
  "logging": {
    "level": "info",
    "includeBody": true,
    "maxBodyLength": 10000
  },
  "smartRouter": {
    "enabled": true,
    "classifierBackend": "concierge",
    "backends": {
      "concierge": {
        "name": "Concierge (Llama-3.2-3B)",
        "specialties": ["general", "conversation", "quick"],
        "contextWindow": 32768,
        "speed": "fast"
      },
      "secretary": {
        "name": "Secretary (Qwen-2.5-14B)",
        "specialties": ["code", "programming", "technical"],
        "contextWindow": 32768,
        "speed": "medium"
      },
      "archivist": {
        "name": "Archivist (Hermes-3-70B)",
        "specialties": ["research", "analysis", "expert"],
        "contextWindow": 32768,
        "speed": "slow"
      },
      "anthropic": {
        "name": "Claude (Anthropic)",
        "specialties": ["complex", "nuanced", "long-context"],
        "contextWindow": 200000,
        "speed": "medium",
        "cost": "paid"
      }
    }
  },
  "storage": {
    "enabled": true,
    "uri": "mongodb://127.0.0.1:27017",
    "database": "llm_gateway",
    "collection": "requests",
    "privacy": {
      "storeQueries": true,
      "storeResponses": true
    },
    "retention": {
      "days": 30,
      "maxDocuments": 10000
    }
  }
}
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CONFIG_PATH` | `/config/config.json` | Path to configuration file |
| `PROXY_PORT` | `8080` | Main proxy port |
| `METRICS_PORT` | `9090` | Prometheus metrics port |
| `ANTHROPIC_API_KEY` | - | API key for Anthropic backend |

## Smart Routing

When enabled, the gateway automatically classifies queries and routes them to the most appropriate backend:

| Category | Backend | Examples |
|----------|---------|----------|
| `conversation` | concierge (3B) | "Hello!", "How are you?", greetings |
| `code` | secretary (14B) | "Write a Python function", code blocks |
| `research` | archivist (70B) | "Explain quantum computing", analysis |
| `realtime` | local + tools | "What's the weather?", "Bitcoin price?" |
| `complex` | anthropic | "Analyze this contract", nuanced tasks |
| `multi` | all backends | Open-ended questions (parallel query) |

### Classification Methods

1. **Quick Classification** - Fast regex-based pattern matching for obvious cases:
   - Greetings and short messages → `conversation`
   - Code blocks and programming keywords → `code`
   - Weather, news, prices → `realtime`
   - Research keywords → `research`

2. **LLM Classification** - For ambiguous queries, uses a fast local model to classify

3. **User Preferences** - Per-user overrides stored in router history

## Tool System

The gateway automatically injects tools for all local backend requests:

### Available Tools

| Tool | Description | Data Source |
|------|-------------|-------------|
| `web_search` | Search for current information | wttr.in (weather), CoinGecko (crypto), DuckDuckGo (general) |
| `get_current_time` | Get current date/time with timezone | System clock |
| `calculator` | Evaluate math expressions | Safe eval (sqrt, pow, trig, etc.) |
| `send_notification` | Send push notifications | Ntfy.sh or Telegram |
| `set_reminder` | Set reminders for later | MongoDB + notifications |
| `set_timer` | Set countdown timers | In-memory + notifications |
| `manage_todos` | Todo list management | MongoDB |
| `weather_forecast` | Multi-day weather forecast | wttr.in |
| `convert_units` | Unit conversion | Built-in (length, weight, volume, temp, speed, data) |
| `dictionary` | Word definitions | Free Dictionary API |

### Tool Execution Flow

```
1. Client sends request
2. Gateway injects tools for local backends
3. Streaming disabled (need full response)
4. Backend returns response (may include tool_calls)
5. If tool_calls detected:
   a. Execute each tool
   b. Send results back to model
   c. Repeat up to 3 rounds
6. Return final response with real data
```

### Example Queries

**Information Tools:**
- "What's the weather in Tokyo?" → `web_search`
- "What's the forecast for next 3 days in London?" → `weather_forecast`
- "What time is it in New York?" → `get_current_time`
- "What is 127 * 43?" → `calculator`
- "Convert 100 miles to kilometers" → `convert_units`
- "Define 'ephemeral'" → `dictionary`
- "What's the Bitcoin price?" → `web_search`

**Productivity Tools:**
- "Remind me to call mom in 30 minutes" → `set_reminder`
- "Set a timer for 5 minutes" → `set_timer`
- "Add 'buy milk' to my todo list" → `manage_todos`
- "Show my todos" → `manage_todos`
- "Mark task todo_123 as complete" → `manage_todos`

**Communication:**
- "Send me a notification saying 'Hello!'" → `send_notification`

### Tools Configuration

Configure tools in `config.json`:

```json
{
  "tools": {
    "notifications": {
      "enabled": true,
      "provider": "ntfy",
      "ntfy": {
        "server": "https://ntfy.sh",
        "topic": "your-topic-name"
      },
      "telegram": {
        "botToken": "your-bot-token",
        "chatId": "your-chat-id"
      }
    },
    "reminders": {
      "enabled": true,
      "checkIntervalMs": 60000
    },
    "todos": {
      "enabled": true
    }
  }
}
```

**Environment Variables for Notifications:**
- `TELEGRAM_BOT_TOKEN` - Telegram bot token (if using Telegram provider)
- `TELEGRAM_CHAT_ID` - Telegram chat ID to send notifications to

### Real-Time Data Sources

**Weather** (wttr.in):
- "What's the weather in Tokyo?"
- "Do I need an umbrella in Paris?"
- "Temperature in New York"

**Crypto Prices** (CoinGecko):
- "Bitcoin price"
- "What's ETH worth?"
- "Solana price in EUR"

**Web Search** (DuckDuckGo):
- "Latest news about AI"
- "Who won the game last night?"
- General current events

### Model Tool Invocation Formats

Different models invoke tools in different ways. The gateway handles all formats automatically.

#### OpenAI-Compatible Format (Most Models)

Models with native tool calling support (Qwen, Mistral-Nemo, GLM, Functionary, xLAM) return tool calls in the standard OpenAI format:

```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "content": null,
      "tool_calls": [{
        "id": "call_abc123",
        "type": "function",
        "function": {
          "name": "web_search",
          "arguments": "{\"query\": \"weather in Tokyo\"}"
        }
      }]
    },
    "finish_reason": "tool_calls"
  }]
}
```

#### Hermes XML Format

Hermes models output tool calls as XML-wrapped JSON in the content field:

```
I'll search for that information.

<tool_call>
{"name": "web_search", "arguments": {"query": "weather in Tokyo"}}
</tool_call>
```

The gateway injects tool definitions as XML in the system prompt:

```xml
<tools>
<tool>
<name>web_search</name>
<description>Search the web for current information...</description>
<parameters>{"type":"object","properties":{"query":{"type":"string"}}}</parameters>
</tool>
</tools>

When you need to call a tool, use this format:
<tool_call>
{"name": "tool_name", "arguments": {"arg1": "value1"}}
</tool_call>
```

#### JSON-Only Format (Fallback)

Some models output just raw JSON without XML tags:

```json
{"name": "web_search", "arguments": {"query": "weather in Tokyo"}}
```

The gateway detects this as a tool call if the entire response is a JSON object with `name` and `arguments` fields.

### Tool Call Detection Priority

```
1. Check for OpenAI-style tool_calls array
   └─ If found → use those

2. Check for Hermes XML format in content
   └─ If <tool_call>...</tool_call> found → parse JSON inside

3. Check for raw JSON tool call
   └─ If entire content is {"name": "...", "arguments": {...}} → treat as tool call
```

### Model Compatibility

| Model | Tool Format | Native Support | Gateway Handling |
|-------|-------------|----------------|------------------|
| Qwen-2.5 | OpenAI | Yes (with --jinja) | Direct tool_calls |
| Mistral-Nemo | OpenAI | Yes (with --jinja) | Direct tool_calls |
| GLM-4.7-Flash | OpenAI | Yes (with --jinja) | Direct tool_calls |
| Functionary-v3.2 | OpenAI | Yes (requires specific template) | Direct tool_calls |
| xLAM-2-8b | OpenAI | Yes (with --jinja) | Direct tool_calls |
| Hermes-3 | XML in content | No (prompt-based) | Parse XML/JSON from content |
| Llama-3.2-3B | Limited | Partial | May need Hermes fallback |

**Note:** llama.cpp requires the `--jinja` flag to enable native tool calling support for compatible models.

## Format Conversion

The gateway automatically converts between API formats:

| From | To | When |
|------|-----|------|
| Anthropic Messages | OpenAI Chat | Request to local backend |
| OpenAI Chat | Anthropic Messages | Request to Anthropic |
| OpenAI Responses | OpenAI Chat | Request to local backend |
| OpenAI Chat | OpenAI Responses | Response from local backend |

Streaming is fully supported with real-time format translation, including special handling for:
- GLM models (strips thinking/reasoning content)
- Hermes models (XML-based tool call format)

## API Endpoints

### Proxy Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /v1/chat/completions` | OpenAI Chat Completions API |
| `POST /v1/messages` | Anthropic Messages API |
| `POST /v1/responses` | OpenAI Responses API |
| `POST /{backend}/v1/...` | Route to specific backend |

### Debug Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /debug/health` | Health check with backend status |
| `GET /debug/logs?limit=N` | Recent request logs |
| `GET /debug/stats` | Aggregated statistics |
| `GET /debug/tokens` | Token usage by backend |
| `GET /debug/models` | Backend status and loaded models |
| `GET /debug/router` | Smart router status and history |
| `POST /debug/switch` | Switch default backend |
| `POST /debug/compare` | Compare responses from all backends |
| `GET /debug/history` | Query MongoDB stored requests |
| `GET /debug/history/:id` | Get single stored request |
| `GET /debug/analytics?days=N` | Time-series analytics |

### Metrics

| Endpoint | Description |
|----------|-------------|
| `GET :9090/metrics` | Prometheus metrics |

## CLI Commands

Send these as chat messages to control the gateway:

```
proxy-cli status   - Show gateway status and backend health
proxy-cli models   - List backends with loaded models
proxy-cli use X    - Switch default backend to X
proxy-cli smart    - Toggle smart routing on/off
proxy-cli logs N   - Show last N requests
proxy-cli tokens   - Show token usage statistics
proxy-cli help     - Show all commands
```

## MongoDB Storage

When enabled, all requests are logged to MongoDB with:

- **Routing info**: Backend, model, classification, decision reasoning
- **Timing**: Start time, backend latency, total time
- **Tokens**: Input/output token counts
- **Privacy controls**: Optionally redact queries/responses
- **Auto-cleanup**: TTL index for automatic deletion after N days

### Query Examples

```bash
# Recent requests
curl "http://localhost:8080/debug/history?limit=10"

# Filter by backend
curl "http://localhost:8080/debug/history?backend=anthropic"

# Filter by date range
curl "http://localhost:8080/debug/history?from=2024-01-01&to=2024-01-31"

# Analytics
curl "http://localhost:8080/debug/analytics?days=7"
```

## Dashboard

Access the web dashboard at `http://localhost:8080/`:

- **Overview** - Total requests, success rate, average latency
- **Backend Status** - Health, loaded models, response times
- **Controls** - Switch backends, toggle smart routing
- **Request Log** - Recent requests with full details
- **Categories** - Query classification distribution
- **Token Usage** - Per-backend token consumption
- **Tool Calls** - Tool usage statistics

## Request Flow

```
Client Request
      │
      ▼
┌─────────────────────┐
│ Parse Request Body  │
│ Detect API Format   │
└─────────────────────┘
      │
      ▼
┌─────────────────────┐     ┌──────────────┐
│   Smart Router      │────▶│Quick Classify│ (regex)
│   Classify Query    │     └──────────────┘
└─────────────────────┘            │
      │                            ▼
      │                    ┌──────────────┐
      │◀───────────────────│LLM Classify  │ (if ambiguous)
      │                    └──────────────┘
      ▼
┌─────────────────────┐
│ Select Backend      │
│ (based on category) │
└─────────────────────┘
      │
      ▼
┌─────────────────────┐
│ Tool Injection      │ (for local backends)
│ [web_search,        │
│  get_current_time,  │
│  calculator]        │
└─────────────────────┘
      │
      ▼
┌─────────────────────┐
│ Format Conversion   │
│ (if needed)         │
└─────────────────────┘
      │
      ▼
┌─────────────────────┐
│ Proxy to Backend    │
└─────────────────────┘
      │
      ▼
┌─────────────────────┐
│ Tool Execution Loop │ (if model called tools)
│ (max 3 rounds)      │
└─────────────────────┘
      │
      ▼
┌─────────────────────┐
│ Convert Response    │
│ Store in MongoDB    │
│ Return to Client    │
└─────────────────────┘
```

## Development

### Running Tests

```bash
# Direct tool calling test (bypasses gateway)
node test-direct-tools.js --host localhost --port 8001

# Test all tool-calling models
./test-all-tool-models.sh

# Run benchmarks
node benchmark-tool-calling.js
```

### Building Docker Image

```bash
docker build -t llm-gateway .
docker push ghcr.io/apellegr/llm-gateway:latest
```

## License

MIT

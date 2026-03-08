# LLM Gateway

LLM routing proxy with multi-backend support, tool calling, format conversion, and request logging.

## Architecture

```
                                ┌─────────────────────────────────┐
                                │          LLM Gateway            │
                                │           (Node.js)             │
                                └─────────────────────────────────┘
                                              │
        ┌─────────────────────────────────────┼──────────────────────────────────────┐
        │                                     │                                      │
        ▼                                     ▼                                      ▼
┌───────────────┐                    ┌───────────────────┐                  ┌─────────────────┐
│  Dashboard    │                    │   Proxy           │                  │  Prometheus     │
│  :8080/       │                    │   :8080/v1/*      │                  │  Metrics :9090  │
└───────────────┘                    └───────────────────┘                  └─────────────────┘
                                              │
                          ┌───────────────────┼───────────────────┐
                          │                   │                   │
                          ▼                   ▼                   ▼
                  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
                  │   Format     │   │    Tool      │   │  Thinking    │
                  │  Conversion  │   │  Injection   │   │  Stripping   │
                  └──────────────┘   └──────────────┘   └──────────────┘
                          │                   │                   │
                          └───────────────────┼───────────────────┘
                                              │
                ┌─────────────────────────────┼─────────────────────────────┐
                │                             │                             │
                ▼                             ▼                             ▼
        ┌──────────────┐            ┌──────────────┐                ┌─────────┐
        │    local     │            │  anthropic   │                │ MongoDB │
        │ llama.cpp    │            │ api.anthropic│                │ Storage │
        │   :8001      │            │    .com      │                │         │
        └──────────────┘            └──────────────┘                └─────────┘
```

## Features

- **Multi-Backend Routing** - Route to local llama.cpp servers and/or Anthropic API with runtime switching
- **Tool Calling** - Automatic tool injection and execution for local models (weather, web search, time, calculator, etc.)
- **Format Conversion** - Bidirectional conversion between OpenAI Chat Completions, Anthropic Messages, and OpenAI Responses API
- **Thinking/Reasoning Stripping** - Strips `reasoning_content` and thinking patterns from model responses
- **Smart Routing** - Optional query classification to route to the best backend (disabled by default)
- **Real-Time Data** - Weather (wttr.in), web search (Brave/DuckDuckGo), crypto (CoinGecko), precious metals (metals.live)
- **MongoDB Storage** - Persistent request/response logging with configurable retention
- **Tool Loop Detection** - Prevents infinite client-side tool call loops (scoped per conversation turn)
- **Streaming Support** - Full SSE streaming with real-time format translation
- **Prometheus Metrics** - Request counts, latency, token usage by backend

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
  "mode": "passthrough",
  "backends": {
    "local": "http://192.168.1.214:8001",
    "anthropic": "https://api.anthropic.com"
  },
  "defaultBackend": "local",
  "logging": {
    "level": "info",
    "includeBody": true,
    "maxBodyLength": 10000
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
      "days": 0,
      "maxDocuments": 0
    }
  },
  "tools": {
    "notifications": {
      "enabled": true,
      "provider": "telegram",
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

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CONFIG_PATH` | `/config/config.json` | Path to configuration file |
| `PROXY_PORT` | `8080` | Main proxy port |
| `METRICS_PORT` | `9090` | Prometheus metrics port |
| `ANTHROPIC_API_KEY` | - | API key for Anthropic backend |
| `BRAVE_SEARCH_API_KEY` | - | Brave Search API key (falls back to DuckDuckGo) |
| `TELEGRAM_BOT_TOKEN` | - | Telegram bot token for notifications |
| `TELEGRAM_CHAT_ID` | - | Telegram chat ID for notifications |

### Storage Retention

| `days` | `maxDocuments` | Behavior |
|--------|----------------|----------|
| `30` | `10000` | Delete after 30 days, keep max 10K docs |
| `0` | `0` | Keep forever, no limits |
| `365` | `0` | Delete after 1 year, no doc limit |

When `days > 0`, a MongoDB TTL index is created on the `timestamp` field.

## Tool System

The gateway automatically injects and executes tools for local backend requests. When the client already provides its own tools, only essential gateway tools are injected (to minimize prompt size).

### Available Tools

| Tool | Description | Data Source |
|------|-------------|-------------|
| `web_search` | Search for current information | Brave Search (primary), DuckDuckGo (fallback). Auto-detects weather, crypto, precious metals, service status queries |
| `weather_forecast` | Current weather and 3-day forecast | wttr.in (primary), Brave Search (fallback) |
| `get_current_time` | Current date/time with timezone | System clock |
| `calculator` | Math expressions | Safe eval (sqrt, pow, trig, log, etc.) |
| `convert_units` | Unit conversion | Built-in tables (length, weight, volume, temp, speed, data) |
| `dictionary` | Word definitions | Free Dictionary API |
| `send_notification` | Push notifications | ntfy or Telegram |
| `set_reminder` | Time-based reminders | MongoDB + notifications |
| `set_timer` | Countdown timers | In-memory + notifications |
| `manage_todos` | Todo list (add/list/complete/delete) | MongoDB |

### Tool Injection Strategy

- **Client has no tools**: All 10 gateway tools are injected
- **Client has its own tools**: Only 3 essential tools injected (`web_search`, `weather_forecast`, `get_current_time`) to keep prompt tokens low
- **Simple queries** (greetings, basic chat): Client tools are stripped entirely to save prompt processing time

### Gateway vs Client Tools

**Gateway tools** are executed server-side — the gateway intercepts the model's tool call, runs it, and sends results back to the model in a follow-up request. The client never sees the tool call.

**Client tools** (any tool not in the gateway's set) pass through to the client for execution. The client is responsible for running them and sending results back.

### Tool Execution Flow

```
1. Client sends request
2. Gateway injects tools for local backends
3. Streaming disabled for tool interception
4. Backend returns response
5. If gateway tool calls detected:
   a. Execute each tool
   b. Send results back to model (single follow-up, no tools included)
   c. Return final response to client
6. If only client tool calls → pass through to client
7. If no tool calls → return response directly
```

### Tool Loop Detection

For client-side tool calls via the Responses API, the gateway tracks how many tool call rounds have occurred since the last user message. After 5 rounds (`MAX_CLIENT_TOOL_ROUNDS`), all tools are stripped and conversation history is truncated to force a text response.

## Tool Calling Formats

The gateway handles multiple tool invocation formats automatically:

### OpenAI Native (preferred)

Models with `--jinja` flag (Qwen, Llama, Mistral) return standard `tool_calls`:

```json
{
  "choices": [{
    "message": {
      "tool_calls": [{"function": {"name": "web_search", "arguments": "{...}"}}]
    },
    "finish_reason": "tool_calls"
  }]
}
```

### Hermes XML

Hermes models output tool calls as XML in content. The gateway injects tool definitions as XML in the system prompt and parses responses:

```
<tool_call>
{"name": "web_search", "arguments": {"query": "weather in Tokyo"}}
</tool_call>
```

### Anthropic Tool Use

Anthropic-format `tool_use` content blocks are converted to OpenAI `tool_calls` for unified execution.

### Detection Priority

1. OpenAI-style `tool_calls` array
2. Hermes `<tool_call>` XML tags in content
3. Raw JSON `{"name": "...", "arguments": {...}}` as entire content

### Model Compatibility

Tool calling is enabled for all local backends and for models whose name contains: `qwen`, `llama`, `mistral`, or `hermes`.

llama.cpp requires the `--jinja` flag to enable native tool calling support.

## Format Conversion

The gateway automatically converts between API formats:

| From | To | When |
|------|-----|------|
| Anthropic Messages | OpenAI Chat Completions | Request to local backend |
| OpenAI Chat Completions | Anthropic Messages | Request to Anthropic backend |
| OpenAI Responses API | OpenAI Chat Completions | Request to any backend |
| OpenAI Chat Completions | OpenAI Responses API | Response to Responses API client |

Streaming is fully supported with real-time format translation.

## Thinking/Reasoning Stripping

The gateway strips thinking content from model responses at multiple levels:

- **`reasoning_content` field**: If a model returns thinking in a separate field with empty `content`, the gateway uses the reasoning as content after stripping internal thought patterns
- **Content analysis**: Detects and removes reasoning patterns ("Let me think...", "The user is asking...", etc.) from the beginning of responses
- **Streaming**: Buffers and strips thinking content in real-time for streaming responses
- **Jinja template note**: Qwen 3.5 models require `--reasoning-budget 0` server-side or `chat_template_kwargs: {"enable_thinking": false}` per-request to disable thinking entirely

## API Endpoints

### Proxy (port 8080)

| Endpoint | Description |
|----------|-------------|
| `POST /v1/chat/completions` | OpenAI Chat Completions API |
| `POST /v1/messages` | Anthropic Messages API |
| `POST /v1/responses` | OpenAI Responses API |
| `POST /{backend}/v1/...` | Route to specific backend |

### Debug

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/debug/health` | GET | Health check with backend status |
| `/debug/logs` | GET | Recent request logs (`?limit=N&backend=X&status=Y`) |
| `/debug/stats` | GET | Aggregated statistics |
| `/debug/tokens` | GET | Token usage by backend |
| `/debug/models` | GET | Backend status and loaded models |
| `/debug/config` | GET/POST | View or update runtime config |
| `/debug/router` | GET/POST | Smart router status, classify, preferences |
| `/debug/switch` | GET/POST | Switch default backend at runtime |
| `/debug/compare` | POST | Compare responses from all backends |
| `/debug/history` | GET | Query MongoDB (`?limit=N&backend=X&from=DATE&to=DATE&userId=X`) |
| `/debug/history/:id` | GET | Get single stored request |
| `/debug/analytics` | GET | Time-series analytics (`?days=N`) |

### Metrics (port 9090)

| Metric | Type | Description |
|--------|------|-------------|
| `llm_proxy_requests_total` | counter | Total requests |
| `llm_proxy_errors_total` | counter | Total errors |
| `llm_proxy_latency_avg_ms` | gauge | Average latency |
| `llm_proxy_requests_by_backend` | counter | Requests per backend |
| `llm_proxy_requests_by_status` | counter | Requests by HTTP status |
| `llm_proxy_tokens_input_total` | counter | Total input tokens |
| `llm_proxy_tokens_output_total` | counter | Total output tokens |
| `llm_proxy_tokens_by_backend_input` | counter | Input tokens per backend |
| `llm_proxy_tokens_by_backend_output` | counter | Output tokens per backend |

## MongoDB Storage

When enabled, all requests are logged to MongoDB with:

- **Routing info**: Backend, model, classification, decision reasoning
- **Timing**: Start time, backend latency, total time
- **Tokens**: Input/output token counts
- **Privacy controls**: Optionally redact queries/responses
- **Retention**: Configurable TTL index (set `days: 0` for unlimited)

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

## Smart Routing (optional)

When enabled, the gateway classifies queries and routes to the best backend using:

1. **Quick Classification** - Regex-based pattern matching (greetings, code, weather, etc.)
2. **LLM Classification** - Uses a fast local model for ambiguous queries
3. **User Preferences** - Per-user overrides

Disabled by default. Enable via config: `"smartRouter": {"enabled": true, ...}`.

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

## Project Structure

```
llm-gateway/
├── index.js              # Application entry point (all gateway logic)
├── package.json
├── config.example.json   # Example configuration
├── Dockerfile
├── public/               # Dashboard static files
├── docs/                 # Additional documentation
├── scripts/              # Test and benchmark scripts
│   ├── benchmark-*.sh/js # Model quality and tool-calling benchmarks
│   ├── test-*.sh/js      # Gateway and tool integration tests
│   ├── compare-quality.js# Side-by-side local vs Anthropic comparison
│   └── test-prompts.txt  # 1000 categorized test prompts
├── results/              # Benchmark and comparison results
│   ├── benchmark-*.json  # Per-model quality benchmark data
│   ├── tool-calling-*.json # Tool-calling benchmark data
│   ├── quality-comparison*.json # Local vs Anthropic comparisons
│   ├── BENCHMARK_REPORT.md
│   ├── TOOL_CALLING_REPORT.md
│   └── summary.csv
└── .github/workflows/    # CI/CD (Docker image build + push)
```

## Development

### Building Docker Image

The image is automatically built and pushed via GitHub Actions on push to `main`.

```bash
# Manual build
docker build -t llm-gateway .
docker push ghcr.io/apellegr/llm-gateway:latest
```

### Running Tests

```bash
# Test gateway routing and responses
node scripts/test-gateway.js --limit 20 --verbose

# Test tool calling against a specific model
node scripts/benchmark-tool-calling.js --model qwen3.5-122b --limit 10

# Compare local model quality vs Anthropic
node scripts/compare-quality.js --random 30 --output results/comparison.json

# Run all tool-calling models through direct tests
bash scripts/test-all-tool-models.sh
```

## License

MIT

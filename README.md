# LLM Gateway

Intelligent LLM routing proxy with multi-backend support, smart routing, and format conversion.

## Features

- **Multi-Backend Routing** - Route requests to multiple LLM backends (local models, Anthropic, OpenAI-compatible APIs)
- **Smart Routing** - Automatically classify queries and route to the best backend based on content
- **Format Conversion** - Bidirectional conversion between Anthropic, OpenAI Chat Completions, and Responses API formats
- **Web Dashboard** - Real-time monitoring, stats, and controls at `/dashboard`
- **CLI Interface** - Control the gateway via `proxy-cli` commands (works great with chat interfaces)
- **Streaming Support** - Full SSE streaming with format translation
- **Prometheus Metrics** - Metrics endpoint for monitoring at `:9090/metrics`

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
node index.js
```

## Configuration

Create a `config.json` file:

```json
{
  "backends": {
    "local": "http://localhost:8001",
    "fast": "http://localhost:8002",
    "anthropic": "https://api.anthropic.com"
  },
  "defaultBackend": "local",
  "logging": {
    "level": "info",
    "includeBody": true,
    "maxBodyLength": 10000
  },
  "smartRouter": {
    "enabled": true,
    "classifierBackend": "local",
    "backends": {
      "local": {
        "name": "Local Model",
        "specialties": ["general", "conversation"],
        "contextWindow": 32768,
        "speed": "fast"
      },
      "fast": {
        "name": "Fast Coder",
        "specialties": ["code", "programming"],
        "contextWindow": 16384,
        "speed": "fast"
      },
      "anthropic": {
        "name": "Claude",
        "specialties": ["complex", "analysis", "long-context"],
        "contextWindow": 200000,
        "speed": "medium",
        "cost": "paid"
      }
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

## API Endpoints

### Proxy Endpoints

- `POST /v1/chat/completions` - OpenAI Chat Completions API
- `POST /v1/messages` - Anthropic Messages API
- `POST /v1/responses` - OpenAI Responses API
- `POST /{backend}/v1/...` - Route to specific backend

### Debug Endpoints

- `GET /dashboard` - Web dashboard
- `GET /debug/health` - Health check
- `GET /debug/logs` - Recent request logs
- `GET /debug/stats` - Aggregated statistics
- `GET /debug/models` - Backend status and models
- `POST /debug/switch` - Switch default backend
- `GET /debug/router` - Smart router status
- `POST /debug/compare` - Compare responses from all backends

### Metrics

- `GET :9090/metrics` - Prometheus metrics

## CLI Commands

Send these as chat messages to control the gateway:

```
proxy-cli status   - Show gateway status
proxy-cli models   - List backends with health
proxy-cli use X    - Switch default backend to X
proxy-cli smart    - Toggle smart routing
proxy-cli logs N   - Show last N requests
proxy-cli help     - Show help
```

## Smart Routing

When enabled, the gateway automatically classifies queries and routes them to the most appropriate backend:

- **Code/Programming** → Backend with `code` specialty
- **Research/Knowledge** → Backend with `research` specialty
- **Conversation/General** → Backend with `conversation` specialty
- **Complex/Expert** → Backend with `complex` specialty

Quick heuristics handle obvious cases (greetings, code blocks) without LLM classification.

## Format Conversion

The gateway automatically converts between API formats:

| From | To | When |
|------|-----|------|
| Anthropic Messages | OpenAI Chat | Request to local backend |
| OpenAI Chat | Anthropic Messages | Request to Anthropic |
| OpenAI Responses | OpenAI Chat | Request to local backend |
| OpenAI Chat | OpenAI Responses | Response from local backend |

Streaming is fully supported with real-time format translation.

## Dashboard

Access the web dashboard at `http://localhost:8080/dashboard`:

- **Overview** - Total requests, success rate, latency
- **Backend Status** - Health and models for each backend
- **Controls** - Switch backends, toggle smart routing
- **Request Log** - Recent requests with details
- **Categories** - Query classification distribution
- **Performance** - Per-backend statistics

## License

MIT

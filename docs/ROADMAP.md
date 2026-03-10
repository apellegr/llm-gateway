# Roadmap

## Implemented Tools

| Tool | Description | Data Source |
|------|-------------|-------------|
| `web_search` | Search for current information | Brave Search / DuckDuckGo, auto-detects weather/crypto/metals queries |
| `weather_forecast` | Current weather and 3-day forecast | wttr.in |
| `get_current_time` | Current date/time with timezone | System clock |
| `calculator` | Math expressions | Safe eval (sqrt, pow, trig, log, etc.) |
| `convert_units` | Unit conversion | Built-in (length, weight, volume, temp, speed, data) |
| `dictionary` | Word definitions | Free Dictionary API |
| `send_notification` | Push notifications | ntfy or Telegram |
| `set_reminder` | Time-based reminders | MongoDB + notifications |
| `set_timer` | Countdown timers | In-memory + notifications |
| `manage_todos` | Todo list CRUD | MongoDB |

## Planned Features

### Tools
- **Translation** - LibreTranslate integration for multilingual support
- **Email** - Compose and send emails via SMTP/SendGrid
- **Calendar** - Google Calendar / CalDAV integration
- **Note-taking** - Persistent knowledge storage
- **Web page reader** - Fetch and summarize URLs
- **Smart home control** - Home Assistant integration for lights, switches, climate

### Infrastructure
- MCP (Model Context Protocol) client support
- Tool execution rate limiting
- Per-user tool permissions
- Tool usage analytics

# Tools Implementation TODO

**Created:** 2026-02-09
**Last Updated:** 2026-02-09

---

## Legend

- [ ] Not started
- [~] In progress
- [x] Completed
- [-] Skipped/Cancelled

---

## Currently Implemented

- [x] `web_search` - Weather, crypto, DuckDuckGo
- [x] `get_current_time` - System clock with timezone
- [x] `calculator` - Safe math evaluation
- [x] `send_notification` - Ntfy.sh and Telegram support
- [x] `set_reminder` - Relative/absolute time parsing, MongoDB persistence
- [x] `set_timer` - In-memory timers with notifications
- [x] `manage_todos` - Full CRUD via MongoDB
- [x] `weather_forecast` - Multi-day forecast via wttr.in
- [x] `convert_units` - Length, weight, volume, temperature, speed, data
- [x] `dictionary` - Free Dictionary API integration

---

## Tier 1: High Priority - COMPLETED

### Communication

- [x] `send_notification`
  - [x] Implemented ntfy.sh provider (default)
  - [x] Implemented Telegram provider (optional)
  - [x] Add tool definition
  - [ ] Test with local models

### Productivity

- [x] `set_reminder`
  - [x] Design reminder storage schema (MongoDB)
  - [x] Implement reminder scheduler (background job, 60s interval)
  - [x] Parse relative times ("in 30 minutes", "at 3pm", "tomorrow at 9am")
  - [x] Integrate with notification tool
  - [x] Add tool definition

- [x] `set_timer`
  - [x] Implement in-memory timer
  - [x] Integrate with notification tool
  - [x] Add tool definition

- [x] `manage_todos`
  - [x] Using MongoDB storage
  - [x] Implement CRUD operations (add, list, complete, delete, clear_completed)
  - [x] Add tool definition with priority support

### Information

- [x] `weather_forecast`
  - [x] Extend wttr.in integration for multi-day (up to 3 days)
  - [x] Format forecast data for LLM consumption
  - [x] Add tool definition

- [x] `convert_units`
  - [x] Implement conversion library
  - [x] Support: length, weight, volume, temperature, speed, data
  - [x] Add tool definition

- [x] `dictionary`
  - [x] Integrate Free Dictionary API
  - [x] Return definition, pronunciation, examples, synonyms
  - [x] Add tool definition

---

## Tier 2: Medium Priority

### Communication

- [ ] `send_email`
  - [ ] Set up SMTP or SendGrid
  - [ ] Implement email composition
  - [ ] Add input validation (prevent abuse)
  - [ ] Add tool definition

### Productivity

- [ ] `calendar_events`
  - [ ] Set up Google Calendar OAuth
  - [ ] Implement query events
  - [ ] Implement add event
  - [ ] Add tool definition

- [ ] `take_note`
  - [ ] Design note storage (markdown files or MongoDB)
  - [ ] Implement create/search/retrieve
  - [ ] Add tool definition

### Information

- [ ] `translate`
  - [ ] Set up LibreTranslate (self-hosted)
  - [ ] Implement translation function
  - [ ] Add language detection
  - [ ] Add tool definition

- [ ] `read_webpage`
  - [ ] Implement URL fetching
  - [ ] HTML to markdown conversion
  - [ ] Optional LLM summarization
  - [ ] Add tool definition

- [ ] `file_search`
  - [ ] Define allowed search directories
  - [ ] Implement ripgrep wrapper
  - [ ] Add security sandboxing
  - [ ] Add tool definition

---

## Tier 3: Smart Home

### Home Assistant Integration

- [ ] Set up Home Assistant connection
  - [ ] Configure HA URL and token
  - [ ] Test API connectivity
  - [ ] Add to gateway config

- [ ] `get_device_state`
  - [ ] Implement HA state query
  - [ ] Format device info for LLM
  - [ ] Add tool definition

- [ ] `control_device`
  - [ ] Implement HA service calls
  - [ ] Support: lights, switches, climate, covers
  - [ ] Add safety confirmations for critical actions
  - [ ] Add tool definition

- [ ] `get_sensor_history`
  - [ ] Implement HA history API
  - [ ] Format historical data
  - [ ] Add tool definition

- [ ] `presence_detection`
  - [ ] Query HA person entities
  - [ ] Return who's home
  - [ ] Add tool definition

- [ ] `create_automation`
  - [ ] Implement HA automation API
  - [ ] Natural language to automation YAML
  - [ ] Add tool definition

### Media

- [ ] `music_control`
  - [ ] Decide backend: Spotify vs HA media_player
  - [ ] Implement play/pause/skip/search
  - [ ] Add tool definition

---

## Tier 4: Advanced

### Development Tools

- [ ] `git_operations`
  - [ ] Define allowed repositories
  - [ ] Implement status/log/diff
  - [ ] Add tool definition

- [ ] `code_execution`
  - [ ] Set up sandboxed container
  - [ ] Implement safe execution
  - [ ] Support: Python, JavaScript, Bash
  - [ ] Add tool definition

### System Tools

- [ ] `screenshot`
  - [ ] Implement screen capture
  - [ ] Add privacy controls
  - [ ] Add tool definition

- [ ] `clipboard`
  - [ ] Implement clipboard read/write
  - [ ] Add tool definition

### AI/ML

- [ ] `image_generation`
  - [ ] Set up Stable Diffusion API
  - [ ] Implement text-to-image
  - [ ] Add tool definition

---

## MCP Integration (Future)

- [ ] Research MCP client implementation in Node.js
- [ ] Create MCP client wrapper for gateway
- [ ] Connect to MCP servers:
  - [ ] Filesystem server
  - [ ] Memory server (knowledge graph)
  - [ ] Home Assistant server
  - [ ] Notion server
  - [ ] Todoist server

---

## Infrastructure Tasks

- [ ] Tool execution rate limiting
- [ ] Tool usage analytics in MongoDB
- [ ] Tool error handling improvements
- [ ] Tool timeout configuration
- [ ] API key management (secrets)
- [ ] Tool permission system (per-user)

---

## Documentation Tasks

- [ ] Document each new tool in README
- [ ] Add tool configuration examples
- [ ] Create troubleshooting guide
- [ ] Add tool testing scripts

---

## Quick Wins (Can Do Today)

1. [ ] `weather_forecast` - Already have wttr.in, just extend
2. [ ] `unit_converter` - Pure JS, no dependencies
3. [ ] `dictionary` - Free API, simple integration
4. [ ] `send_notification` via existing Telegram bot

---

## Notes

### Priority Order Recommendation

1. **send_notification** - Foundation for reminders/timers
2. **set_reminder** - High utility personal assistant feature
3. **weather_forecast** - Easy extension of existing code
4. **add_todo** - Productivity essential
5. **translate** - Useful for multilingual support
6. **Home Assistant integration** - Unlock smart home control

### API Keys Needed

| Service | Key Type | Status |
|---------|----------|--------|
| Telegram Bot | Bot Token | Have it |
| Todoist | API Key | Need to get |
| Google Calendar | OAuth | Need to set up |
| LibreTranslate | None (self-host) | Need to deploy |
| Home Assistant | Long-lived token | Need to generate |
| SendGrid | API Key | Need to get |

### Estimated Effort

| Tool | Effort | Time |
|------|--------|------|
| send_notification | Low | 1-2 hours |
| set_reminder | Medium | 4-6 hours |
| weather_forecast | Low | 1 hour |
| unit_converter | Low | 2 hours |
| dictionary | Low | 1 hour |
| translate | Medium | 3-4 hours |
| calendar_events | High | 6-8 hours |
| Home Assistant | High | 8-12 hours |

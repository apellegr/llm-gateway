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

---

## Tier 1: High Priority

### Communication

- [ ] `send_notification`
  - [ ] Research: Ntfy.sh vs Pushover vs Telegram
  - [ ] Implement notification backend
  - [ ] Add tool definition
  - [ ] Test with local models

### Productivity

- [ ] `set_reminder`
  - [ ] Design reminder storage schema (MongoDB)
  - [ ] Implement reminder scheduler (background job)
  - [ ] Parse relative times ("in 30 minutes")
  - [ ] Integrate with notification tool
  - [ ] Add tool definition

- [ ] `set_timer`
  - [ ] Implement in-memory timer
  - [ ] Integrate with notification tool
  - [ ] Add tool definition

- [ ] `add_todo`
  - [ ] Decide backend: Todoist API vs local storage
  - [ ] Implement CRUD operations
  - [ ] Add tool definition for add/list/complete/delete

### Information

- [ ] `weather_forecast`
  - [ ] Extend wttr.in integration for multi-day
  - [ ] Format forecast data for LLM consumption
  - [ ] Add tool definition

- [ ] `unit_converter`
  - [ ] Implement conversion library
  - [ ] Support: length, weight, volume, temperature, currency
  - [ ] Add tool definition

- [ ] `dictionary`
  - [ ] Integrate Free Dictionary API
  - [ ] Return definition, pronunciation, examples
  - [ ] Add tool definition

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

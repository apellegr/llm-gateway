# Tools Research

## Architecture Options

### 1. Native Tools (Current Approach)
- Tools defined in `index.js`
- Gateway executes tools directly
- Simple, fast, no extra dependencies

### 2. MCP Integration (Future)
- Gateway acts as MCP client
- Connect to MCP servers for tools
- More flexible, ecosystem of pre-built servers
- Adds complexity

### 3. Hybrid Approach
- Core tools native (search, calc, time)
- Complex tools via MCP (Home Assistant, Notion)
- Best of both worlds

## Available MCP Servers

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
| Home Assistant | Smart home | Community |
| Brave Search | Web search | Community |

## Security Considerations

- **Input Validation:** All tool inputs must be sanitized
- **Path Restrictions:** File operations limited to allowed directories
- **Rate Limiting:** Prevent abuse of external APIs
- **Authentication:** Secure storage of API keys
- **Sandboxing:** Code execution must be isolated
- **Prompt Injection:** Tools can be vectors for injection attacks

## References

- [MCP Servers Repository](https://github.com/modelcontextprotocol/servers)
- [Awesome MCP Servers](https://mcpservers.org/)
- [OpenAI Function Calling](https://platform.openai.com/docs/guides/function-calling)

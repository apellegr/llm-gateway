/**
 * LLM Gateway - Intelligent LLM routing proxy
 *
 * Features:
 * - Multi-backend routing with smart classification
 * - Bidirectional format conversion (Anthropic <-> OpenAI <-> Responses API)
 * - Structured JSON logging with timing metrics
 * - SSE streaming support with format translation
 * - Web dashboard for monitoring and control
 * - CLI interface (proxy-cli commands)
 * - Debug endpoints: /debug/logs, /debug/health, /debug/compare, /debug/stats
 * - Prometheus metrics
 *
 * Configuration via environment variables:
 *   CONFIG_PATH - Path to config.json (default: /config/config.json)
 *   PROXY_PORT - Main proxy port (default: 8080)
 *   METRICS_PORT - Prometheus metrics port (default: 9090)
 *   ANTHROPIC_API_KEY - API key for Anthropic backend
 *
 * See https://github.com/apellegr/llm-gateway for documentation.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// MIME types for static file serving
const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// Configuration
const CONFIG_PATH = process.env.CONFIG_PATH || '/config/config.json';
const PROXY_PORT = parseInt(process.env.PROXY_PORT || '8080');
const METRICS_PORT = parseInt(process.env.METRICS_PORT || '9090');
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Default configuration - override via config.json or CONFIG_PATH
let config = {
  mode: 'passthrough', // 'passthrough' | 'compare' | 'local-only' | 'anthropic-only'
  backends: {
    // Example backends - configure your own in config.json
    local: 'http://localhost:8001',
    anthropic: 'https://api.anthropic.com'
  },
  logging: {
    level: 'info', // 'debug' | 'info' | 'warn' | 'error'
    includeBody: true,
    maxBodyLength: 10000
  },
  defaultBackend: 'local',
  smartRouter: {
    enabled: false, // Enable for intelligent routing between backends
    classifierBackend: 'local', // Backend used to classify queries
    historyFile: '/config/router-history.json',
    // Backend capabilities - used for smart routing decisions
    backends: {
      local: {
        name: 'Local LLM',
        specialties: ['general', 'conversation'],
        contextWindow: 32768,
        speed: 'fast'
      },
      anthropic: {
        name: 'Claude (Anthropic)',
        specialties: ['complex', 'nuanced', 'expert', 'analysis', 'long-context'],
        contextWindow: 200000,
        speed: 'medium',
        cost: 'paid'
      }
    }
  }
};

// ============================================================================
// Smart Router - Intelligent query classification and routing
// ============================================================================

// Router history for learning
let routerHistory = {
  decisions: [],        // Recent routing decisions
  userPreferences: {},  // User-specific model preferences
  modelPerformance: {}, // Performance tracking per model per category
  lastUpdated: null
};

// Load router history
function loadRouterHistory() {
  try {
    const historyPath = config.smartRouter?.historyFile || '/config/router-history.json';
    if (fs.existsSync(historyPath)) {
      routerHistory = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
      log('info', `Loaded router history: ${routerHistory.decisions?.length || 0} decisions`);
    }
  } catch (err) {
    log('warn', 'Failed to load router history: ' + err.message);
  }
}

// Save router history
function saveRouterHistory() {
  try {
    const historyPath = config.smartRouter?.historyFile || '/config/router-history.json';
    routerHistory.lastUpdated = new Date().toISOString();
    // Keep only last 1000 decisions
    if (routerHistory.decisions.length > 1000) {
      routerHistory.decisions = routerHistory.decisions.slice(-1000);
    }
    fs.writeFileSync(historyPath, JSON.stringify(routerHistory, null, 2));
  } catch (err) {
    log('warn', 'Failed to save router history: ' + err.message);
  }
}

// Build classification prompt dynamically from config
function buildClassificationPrompt() {
  const backendsList = Object.entries(config.smartRouter?.backends || {})
    .map(([name, info]) => `- ${name}: ${info.name} - specialties: ${(info.specialties || []).join(', ')}`)
    .join('\n');

  return `You are a query classifier for an AI routing system. Analyze the user's message and classify it.

Respond ONLY with a JSON object (no markdown, no explanation):
{
  "category": "code|research|conversation|complex|multi",
  "confidence": 0.0-1.0,
  "complexity": "simple|moderate|complex|expert",
  "contextDepth": "shallow|moderate|deep",
  "keywords": ["relevant", "keywords"],
  "suggestedBackends": ["primary", "optional_secondary"],
  "reasoning": "brief explanation"
}

Categories:
- code: Programming, debugging, technical implementation
- research: Facts, knowledge, history, science questions
- conversation: Casual chat, general questions, creative tasks
- complex: Nuanced analysis, expert-level discussion, philosophical
- multi: Open questions that benefit from multiple perspectives

Backends available:
${backendsList}

User message to classify:
`;
}

// Classify a query using the classifier backend
async function classifyQuery(messages, userId = 'default') {
  if (!config.smartRouter?.enabled) {
    return null;
  }

  try {
    // Extract the last user message for classification
    const lastUserMessage = messages.filter(m => m.role === 'user').pop();
    if (!lastUserMessage) return null;

    const userContent = typeof lastUserMessage.content === 'string'
      ? lastUserMessage.content
      : JSON.stringify(lastUserMessage.content);

    // Quick heuristics for obvious cases (skip LLM classification)
    const quickClassification = quickClassify(userContent);
    if (quickClassification && quickClassification.confidence > 0.9) {
      log('debug', 'Quick classification used', quickClassification);
      return quickClassification;
    }

    // Use classifier backend to classify
    const classifierUrl = config.backends[config.smartRouter.classifierBackend] + '/v1/chat/completions';

    const classifyRequest = {
      model: 'classifier',
      messages: [
        { role: 'system', content: buildClassificationPrompt() },
        { role: 'user', content: userContent.substring(0, 2000) } // Limit for speed
      ],
      max_tokens: 300,
      temperature: 0.1, // Low temperature for consistent classification
      stream: false
    };

    const response = await makeRequest(classifierUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer not-required'
      }
    }, JSON.stringify(classifyRequest));

    if (response.status !== 200) {
      log('warn', 'Classification request failed', { status: response.status });
      return null;
    }

    const parsed = JSON.parse(response.body);
    let content = parsed.choices?.[0]?.message?.content || '';

    // Handle reasoning_content (GLM models) - strip thinking portion
    if (!content && parsed.choices?.[0]?.message?.reasoning_content) {
      content = stripThinkingContent(parsed.choices[0].message.reasoning_content);
    }

    // Parse JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log('warn', 'Could not parse classification JSON', { content });
      return null;
    }

    const classification = JSON.parse(jsonMatch[0]);

    // Apply user preferences if available
    if (routerHistory.userPreferences[userId]) {
      applyUserPreferences(classification, routerHistory.userPreferences[userId]);
    }

    log('info', 'Query classified', {
      category: classification.category,
      confidence: classification.confidence,
      backends: classification.suggestedBackends
    });

    return classification;

  } catch (err) {
    log('warn', 'Classification failed: ' + err.message);
    return null;
  }
}

// Find backend by specialty from config
function findBackendBySpecialty(specialty) {
  const backends = config.smartRouter?.backends || {};
  for (const [name, info] of Object.entries(backends)) {
    if (info.specialties?.includes(specialty)) {
      return name;
    }
  }
  return config.defaultBackend;
}

// Quick heuristic classification for obvious cases
function quickClassify(content) {
  const lower = content.toLowerCase();

  // Code patterns
  const codePatterns = [
    /```[\s\S]*```/,                           // Code blocks
    /function\s+\w+|def\s+\w+|class\s+\w+/,    // Function/class definitions
    /\b(bug|error|exception|debug|compile)\b/i,
    /\b(javascript|python|java|rust|go|typescript|react|node)\b/i,
    /how (do i|to|can i) (write|code|implement|fix)/i
  ];

  for (const pattern of codePatterns) {
    if (pattern.test(content)) {
      return {
        category: 'code',
        confidence: 0.95,
        complexity: 'moderate',
        suggestedBackends: [findBackendBySpecialty('code')],
        quick: true
      };
    }
  }

  // Simple greetings and casual chat
  const casualPatterns = [
    /^(hi|hello|hey|yo|sup|hiya|howdy|greetings)[!.,?\s]*$/i,
    /^good (morning|afternoon|evening|night)[!.,?\s]*$/i,
    /^(you good|how are you|what'?s up|how'?s it going|what'?s going on)[!.,?\s]*$/i,
    /^(thanks|thank you|thx|ty|cheers)[!.,?\s]*$/i,
    /^(ok|okay|sure|yes|no|yep|nope|yeah|nah)[!.,?\s]*$/i,
    /^(bye|goodbye|see you|later|cya)[!.,?\s]*$/i
  ];

  for (const pattern of casualPatterns) {
    if (pattern.test(content.trim())) {
      return {
        category: 'conversation',
        confidence: 0.99,
        complexity: 'simple',
        suggestedBackends: [findBackendBySpecialty('conversation')],
        quick: true
      };
    }
  }

  // Very short messages (< 30 chars) without code markers are usually casual
  if (content.trim().length < 30 && !content.includes('```') && !content.includes('function')) {
    return {
      category: 'conversation',
      confidence: 0.85,
      complexity: 'simple',
      suggestedBackends: [findBackendBySpecialty('general')],
      quick: true
    };
  }

  // Research/factual patterns
  const researchPatterns = [
    /\b(what is|who is|when did|where is|how does .* work)\b/i,
    /\b(history of|explain|define|describe)\b/i,
    /\b(scientific|research|study|evidence|data)\b/i
  ];

  for (const pattern of researchPatterns) {
    if (pattern.test(content)) {
      return {
        category: 'research',
        confidence: 0.85,
        complexity: 'moderate',
        suggestedBackends: [findBackendBySpecialty('research')],
        quick: true
      };
    }
  }

  return null; // Use LLM classification
}

// Apply user preferences to classification
function applyUserPreferences(classification, prefs) {
  // If user prefers certain models for certain categories
  if (prefs.categoryOverrides?.[classification.category]) {
    classification.suggestedBackends = prefs.categoryOverrides[classification.category];
    classification.userOverride = true;
  }

  // If user generally prefers higher quality models
  if (prefs.qualityPreference === 'high' && classification.complexity !== 'simple') {
    if (!classification.suggestedBackends.includes('anthropic')) {
      classification.suggestedBackends.push('anthropic');
    }
  }
}

// Record a routing decision for learning
function recordRoutingDecision(decision) {
  routerHistory.decisions.push({
    ...decision,
    timestamp: new Date().toISOString()
  });

  // Update model performance stats
  const category = decision.classification?.category || 'unknown';
  const backend = decision.selectedBackend;

  if (!routerHistory.modelPerformance[backend]) {
    routerHistory.modelPerformance[backend] = {};
  }
  if (!routerHistory.modelPerformance[backend][category]) {
    routerHistory.modelPerformance[backend][category] = { count: 0, successRate: 1.0 };
  }
  routerHistory.modelPerformance[backend][category].count++;

  // Save periodically (every 10 decisions)
  if (routerHistory.decisions.length % 10 === 0) {
    saveRouterHistory();
  }
}

// Get routing recommendation based on classification
function getRoutingRecommendation(classification, contextLength = 0, userId = 'default') {
  if (!classification) {
    return { backend: config.defaultBackend, reason: 'no classification' };
  }

  // Valid backend names
  const validBackends = Object.keys(config.backends);

  // Filter suggested backends to only valid ones
  const suggestedBackends = (classification.suggestedBackends || [])
    .filter(b => validBackends.includes(b));

  // Use filtered backends or fall back to default
  const backends = suggestedBackends.length > 0 ? suggestedBackends : [config.defaultBackend];
  let selectedBackend = backends[0];
  let multiModel = false;
  let reason = `category: ${classification.category}`;

  // Log if we had to filter out invalid backends
  if (classification.suggestedBackends?.length > suggestedBackends.length) {
    const invalid = classification.suggestedBackends.filter(b => !validBackends.includes(b));
    log('warn', `Filtered invalid backends: ${invalid.join(', ')} -> using ${selectedBackend}`);
  }

  // Check if multi-model is recommended
  if (classification.category === 'multi' ||
      (classification.complexity === 'expert' && classification.confidence < 0.8)) {
    multiModel = true;
    reason = 'open question - multiple perspectives';
  }

  // Check context length requirements
  if (contextLength > 30000) {
    const longContextBackends = Object.entries(config.smartRouter.backends)
      .filter(([_, b]) => b.contextWindow > contextLength)
      .map(([name]) => name);

    if (longContextBackends.length > 0 && !longContextBackends.includes(selectedBackend)) {
      selectedBackend = longContextBackends[0];
      reason = `long context (${contextLength} tokens) requires ${selectedBackend}`;
    }
  }

  // Check user's historical preference
  const userPerf = routerHistory.userPreferences[userId];
  if (userPerf?.preferredModels?.[classification.category]) {
    const preferred = userPerf.preferredModels[classification.category];
    if (backends.includes(preferred)) {
      selectedBackend = preferred;
      reason += ' (user preference)';
    }
  }

  return {
    backend: selectedBackend,
    multiModel,
    allBackends: multiModel ? backends.slice(0, 3) : [selectedBackend],
    reason,
    classification
  };
}

// Strip thinking/reasoning portion from model output
// GLM and similar models often output their chain-of-thought before the actual response
function stripThinkingContent(content) {
  if (!content) return content;

  // Patterns that indicate thinking/reasoning (to be removed)
  const thinkingPatterns = [
    /^The user is asking[^]*?(?=\n\n(?:[A-Z*#]|\d\.))/s,  // "The user is asking..." until double newline + actual content
    /^This is a question about[^]*?(?=\n\n(?:[A-Z*#]|\d\.))/s,
    /Let me think about[^]*?(?=\n\n(?:[A-Z*#]|\d\.))/s,
    /I should (?:also )?consider[^]*?(?=\n\n(?:[A-Z*#]|\d\.))/s,
    /I (?:don't )?need to read[^]*?(?=\n\n(?:[A-Z*#]|\d\.))/s,
  ];

  // Phrases that mark the transition to actual response
  const transitionPhrases = [
    /Let me provide[^.]*\./,
    /Here(?:'s| is| are) (?:my |the |a )?(?:recommendation|suggestion|answer)/i,
  ];

  let result = content;

  // Try to find transition phrase and take everything after it
  for (const pattern of transitionPhrases) {
    const match = result.match(pattern);
    if (match) {
      const idx = result.indexOf(match[0]) + match[0].length;
      const afterTransition = result.substring(idx).trim();
      if (afterTransition.length > 100) { // Make sure there's substantial content after
        result = afterTransition;
        break;
      }
    }
  }

  // If no transition found, try removing thinking patterns from the start
  if (result === content) {
    for (const pattern of thinkingPatterns) {
      result = result.replace(pattern, '').trim();
    }
  }

  // Also remove lines that look like internal reasoning
  const lines = result.split('\n');
  const filteredLines = [];
  let inThinking = true;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines at the start
    if (inThinking && !trimmed) continue;

    // Detect end of thinking section
    if (inThinking) {
      // Lines starting with actual content markers
      if (trimmed.match(/^(\*\*|#{1,3} |For a |\d+\.|Here|Based on|I recommend|Great|Perfect)/)) {
        inThinking = false;
      }
      // Skip thinking lines
      else if (trimmed.match(/^(The user|This is|Let me think|I should|I need to|I don't need|Looking at|Considering)/i)) {
        continue;
      }
      // Skip bullet points that look like internal notes
      else if (trimmed.match(/^- [A-Z][^:]+:/) && !trimmed.includes('**')) {
        continue;
      }
    }

    if (!inThinking) {
      filteredLines.push(line);
    }
  }

  // If we filtered too aggressively, return original minus obvious thinking start
  if (filteredLines.join('\n').trim().length < 50 && content.length > 100) {
    // Just try to remove the first paragraph if it looks like thinking
    const paragraphs = content.split('\n\n');
    if (paragraphs.length > 1 && paragraphs[0].match(/^(The user|This is a question|I need to)/i)) {
      return paragraphs.slice(1).join('\n\n').trim();
    }
    return content;
  }

  return filteredLines.join('\n').trim() || content;
}

// Execute multi-model query and combine results
async function executeMultiModelQuery(request, backends, requestLog) {
  log('info', `Executing multi-model query across: ${backends.join(', ')}`);

  const results = [];
  const startTime = Date.now();

  // Execute queries in parallel
  const promises = backends.map(async (backend) => {
    try {
      const backendUrl = config.backends[backend];
      if (!backendUrl) return null;

      const backendStart = Date.now();
      const response = await makeRequest(backendUrl + '/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer not-required'
        }
      }, JSON.stringify({ ...request, stream: false }));

      const latency = Date.now() - backendStart;

      if (response.status === 200) {
        const parsed = JSON.parse(response.body);
        let content = parsed.choices?.[0]?.message?.content || '';
        if (!content && parsed.choices?.[0]?.message?.reasoning_content) {
          content = stripThinkingContent(parsed.choices[0].message.reasoning_content);
        }

        return {
          backend,
          model: parsed.model || backend,
          content,
          latency,
          success: true
        };
      }

      return { backend, success: false, error: `Status ${response.status}` };
    } catch (err) {
      return { backend, success: false, error: err.message };
    }
  });

  const responses = await Promise.all(promises);
  const successfulResponses = responses.filter(r => r?.success);

  if (successfulResponses.length === 0) {
    return null;
  }

  // Combine responses with model attribution
  let combinedContent = '';
  for (const resp of successfulResponses) {
    const modelName = (resp.model || resp.backend).replace(/\.gguf$/, '').replace(/-Q\d.*$/, '');
    combinedContent += `**[${modelName}]**\n${resp.content}\n\n---\n\n`;
  }

  combinedContent += `_[Multi-model response from: ${successfulResponses.map(r => r.backend).join(', ')}]_`;

  log('info', `Multi-model query completed in ${Date.now() - startTime}ms`, {
    backends: successfulResponses.map(r => r.backend),
    latencies: successfulResponses.map(r => r.latency)
  });

  return {
    content: combinedContent,
    models: successfulResponses.map(r => r.model),
    backends: successfulResponses.map(r => r.backend)
  };
}

// Request log storage (circular buffer)
const MAX_LOGS = 100;
const requestLogs = [];

// Metrics
const metrics = {
  requests_total: 0,
  requests_by_backend: {},
  requests_by_status: {},
  errors_total: 0,
  latency_sum: 0,
  latency_count: 0
};

// Load configuration
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      config = { ...config, ...fileConfig };
      log('info', 'Configuration loaded from ' + CONFIG_PATH);
    } else {
      log('info', 'No config file found, using defaults');
    }
  } catch (err) {
    log('error', 'Failed to load config: ' + err.message);
  }
}

// Logging utility
function log(level, message, data = null) {
  const levels = { debug: 0, info: 1, warn: 2, error: 3 };
  const configLevel = levels[config.logging?.level] || 0;

  if (levels[level] >= configLevel) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(data && { data })
    };
    console.log(JSON.stringify(entry));
  }
}

// Add request to log buffer
function addRequestLog(entry) {
  requestLogs.unshift(entry);
  if (requestLogs.length > MAX_LOGS) {
    requestLogs.pop();
  }
}

// Generate unique request ID
function generateRequestId() {
  return 'req_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// Determine backend from request
function determineBackend(reqPath, body) {
  const backendNames = Object.keys(config.backends);

  // Check for explicit backend in path (e.g., /mybackend/v1/chat/completions)
  for (const backend of backendNames) {
    if (reqPath.includes(`/${backend}/`)) return backend;
  }

  // Check for model in body - look for backend name or 'claude'/'anthropic' keywords
  if (body) {
    try {
      const parsed = typeof body === 'string' ? JSON.parse(body) : body;
      const model = (parsed.model || '').toLowerCase();

      // Check if model name contains any backend name
      for (const backend of backendNames) {
        if (model.includes(backend.toLowerCase())) return backend;
      }

      // Special handling for Anthropic models
      if (model.includes('claude') || model.includes('anthropic')) {
        if (backendNames.includes('anthropic')) return 'anthropic';
      }
    } catch (e) {
      // Ignore parse errors
    }
  }

  return config.defaultBackend;
}

// Convert Anthropic format to OpenAI format
function anthropicToOpenAI(body) {
  const parsed = typeof body === 'string' ? JSON.parse(body) : body;

  return {
    model: parsed.model || 'llama-4-scout',
    messages: parsed.messages || [],
    max_tokens: parsed.max_tokens || 1024,
    temperature: parsed.temperature,
    top_p: parsed.top_p,
    stream: parsed.stream || false,
    stop: parsed.stop_sequences
  };
}

// Convert OpenAI format to Anthropic format
function openAIToAnthropic(body) {
  const parsed = typeof body === 'string' ? JSON.parse(body) : body;

  // Filter out system messages and convert to Anthropic format
  const messages = (parsed.messages || []).filter(m => m.role !== 'system');
  const systemMessage = (parsed.messages || []).find(m => m.role === 'system');

  return {
    model: parsed.model || 'claude-sonnet-4-20250514',
    messages: messages,
    max_tokens: parsed.max_tokens || 1024,
    temperature: parsed.temperature,
    top_p: parsed.top_p,
    stream: parsed.stream || false,
    stop_sequences: parsed.stop,
    ...(systemMessage && { system: systemMessage.content })
  };
}

// Convert OpenAI response to Anthropic response format
function openAIResponseToAnthropic(response, model) {
  const parsed = typeof response === 'string' ? JSON.parse(response) : response;

  const content = parsed.choices?.[0]?.message?.content || '';

  return {
    id: 'msg_proxy_' + Date.now(),
    type: 'message',
    role: 'assistant',
    model: model || parsed.model || 'local-llm',
    content: [{
      type: 'output_text',
      text: content
    }],
    stop_reason: parsed.choices?.[0]?.finish_reason === 'stop' ? 'end_turn' : 'max_tokens',
    usage: {
      input_tokens: parsed.usage?.prompt_tokens || 0,
      output_tokens: parsed.usage?.completion_tokens || 0
    }
  };
}

// Convert Anthropic response to OpenAI response format
function anthropicResponseToOpenAI(response, model) {
  const parsed = typeof response === 'string' ? JSON.parse(response) : response;

  const content = parsed.content?.[0]?.text || '';

  return {
    id: 'chatcmpl-proxy-' + Date.now(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || parsed.model || 'claude-sonnet-4',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: content
      },
      finish_reason: parsed.stop_reason === 'end_turn' ? 'stop' : 'length'
    }],
    usage: {
      prompt_tokens: parsed.usage?.input_tokens || 0,
      completion_tokens: parsed.usage?.output_tokens || 0,
      total_tokens: (parsed.usage?.input_tokens || 0) + (parsed.usage?.output_tokens || 0)
    }
  };
}

// Check if model is Hermes (supports native tool calling)
function isHermesModel(model) {
  const modelLower = (model || '').toLowerCase();
  return modelLower.includes('hermes');
}

// Format tools for Hermes model (XML format in system prompt)
function formatToolsForHermes(tools) {
  if (!tools || tools.length === 0) return '';

  let toolsXml = '\n\n<tools>\n';
  for (const tool of tools) {
    const fn = tool.function || tool;
    toolsXml += `<tool>\n`;
    toolsXml += `<name>${fn.name}</name>\n`;
    toolsXml += `<description>${fn.description || ''}</description>\n`;
    if (fn.parameters) {
      toolsXml += `<parameters>${JSON.stringify(fn.parameters)}</parameters>\n`;
    }
    toolsXml += `</tool>\n`;
  }
  toolsXml += '</tools>\n';
  toolsXml += '\nWhen you need to call a tool, use this format:\n<tool_call>\n{"name": "tool_name", "arguments": {"arg1": "value1"}}\n</tool_call>\n';
  toolsXml += '\nAfter receiving tool results, continue your response naturally.\n';
  return toolsXml;
}

// Parse Hermes tool calls from response content
// Handles both XML-wrapped format (<tool_call>{...}</tool_call>) and JSON-only format
function parseHermesToolCalls(content) {
  const toolCalls = [];
  let cleanContent = content;

  // First, try to parse XML-wrapped tool calls
  const toolCallRegex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let match;
  let foundXmlToolCalls = false;

  while ((match = toolCallRegex.exec(content)) !== null) {
    foundXmlToolCalls = true;
    try {
      const toolData = JSON.parse(match[1].trim());
      toolCalls.push({
        id: 'call_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        type: 'function',
        function: {
          name: toolData.name,
          arguments: JSON.stringify(toolData.arguments || {})
        }
      });
    } catch (e) {
      // Skip malformed tool calls
    }
  }

  if (foundXmlToolCalls) {
    // Remove tool_call tags from content to get clean text
    cleanContent = content.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
  } else {
    // Try to parse JSON-only format (Hermes sometimes outputs just the JSON)
    // Look for JSON object with "name" and "arguments" at the root level
    const trimmed = content.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const toolData = JSON.parse(trimmed);
        // Check if this looks like a tool call (has name and arguments)
        if (toolData.name && typeof toolData.name === 'string') {
          toolCalls.push({
            id: 'call_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
            type: 'function',
            function: {
              name: toolData.name,
              arguments: JSON.stringify(toolData.arguments || {})
            }
          });
          cleanContent = ''; // The entire content was a tool call
        }
      } catch (e) {
        // Not a valid JSON, treat as regular content
      }
    }
  }

  return { toolCalls, cleanContent };
}

// Convert OpenAI Responses API format to Chat Completions format
// The Responses API uses 'input' instead of 'messages'
function responsesToChatCompletions(body, isHermes = false) {
  const parsed = typeof body === 'string' ? JSON.parse(body) : body;

  let messages = [];
  let toolsAppendix = '';

  // Format tools for Hermes if present
  if (isHermes && parsed.tools && parsed.tools.length > 0) {
    toolsAppendix = formatToolsForHermes(parsed.tools);
  }

  // Handle 'instructions' as system message
  if (parsed.instructions) {
    messages.push({ role: 'system', content: parsed.instructions + toolsAppendix });
  } else if (toolsAppendix) {
    // Add tools as system message if no instructions
    messages.push({ role: 'system', content: 'You are a helpful assistant.' + toolsAppendix });
  }

  // Handle 'input' field - can be string or array of messages
  if (parsed.input) {
    if (typeof parsed.input === 'string') {
      messages.push({ role: 'user', content: parsed.input });
    } else if (Array.isArray(parsed.input)) {
      // input can be an array of message objects or content items
      for (const item of parsed.input) {
        if (typeof item === 'string') {
          messages.push({ role: 'user', content: item });
        } else if (item.role && item.content) {
          // Handle 'developer' role -> 'system' for local LLMs
          let role = item.role === 'developer' ? 'system' : item.role;
          let content = typeof item.content === 'string' ? item.content :
            (Array.isArray(item.content) ? item.content.map(c => c.text || c.content || '').join('') : JSON.stringify(item.content));

          // Append tools to system message if not already added
          if (role === 'system' && toolsAppendix && !content.includes('<tools>')) {
            content += toolsAppendix;
            toolsAppendix = ''; // Only add once
          }

          messages.push({ role, content });
        } else if (item.type === 'message' && item.content) {
          const content = Array.isArray(item.content)
            ? item.content.map(c => c.text || c.content || '').join('')
            : item.content;
          messages.push({ role: item.role || 'user', content });
        }
      }
    }
  }

  return {
    model: parsed.model || 'llama-4-scout',
    messages: messages,
    max_tokens: parsed.max_output_tokens || parsed.max_tokens || 4096,
    temperature: parsed.temperature,
    top_p: parsed.top_p,
    // Enable streaming - we'll convert the format
    stream: true,
    stop: parsed.stop
  };
}

// Convert Chat Completions streaming chunk to Responses API streaming events
function convertStreamChunk(chunk, state) {
  const events = [];

  try {
    // Parse the SSE data line
    const lines = chunk.toString().split('\n');

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();

      if (data === '[DONE]') {
        // Strip thinking content from GLM/reasoning models before finalizing
        // This cleans up the final response even if thinking was streamed
        const isThinkingModel = (state.model || '').toLowerCase().includes('glm');
        if (isThinkingModel && state.textContent) {
          state.textContent = stripThinkingContent(state.textContent);
        }

        // Append model name footer for debugging
        const modelShortName = (state.model || 'unknown').replace(/\.gguf$/, '').replace(/-Q\d.*$/, '');
        const modelFooter = `\n\n_[via ${modelShortName}]_`;
        state.textContent = (state.textContent || '') + modelFooter;

        // Stream complete - emit done events
        if (state.textContent) {
          events.push({
            type: 'response.output_text.done',
            output_index: 0,
            content_index: 0,
            text: state.textContent
          });
        }
        events.push({
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'message',
            id: state.messageId,
            status: 'completed',
            role: 'assistant',
            content: [{
              type: 'output_text',
              text: state.textContent
            }]
          }
        });
        events.push({
          type: 'response.done',
          response: {
            id: state.responseId,
            object: 'response',
            created_at: state.createdAt,
            model: state.model,
            output: [{
              type: 'message',
              id: state.messageId,
              status: 'completed',
              role: 'assistant',
              content: [{
                type: 'output_text',
                text: state.textContent
              }]
            }],
            usage: state.usage,
            status: 'completed',
            error: null
          }
        });
        state.done = true;
        continue;
      }

      try {
        const parsed = JSON.parse(data);
        // Handle both regular content and reasoning_content (for thinking models)
        const deltaObj = parsed.choices?.[0]?.delta || {};
        const delta = deltaObj.content || deltaObj.reasoning_content || '';

        // Debug: log what we're receiving
        if (delta) {
          log('debug', 'Stream chunk delta', { content: delta.substring(0, 50), hasContent: !!deltaObj.content, hasReasoning: !!deltaObj.reasoning_content });
        }

        // Initialize on first chunk
        if (!state.started) {
          state.started = true;
          state.responseId = 'resp_' + Date.now();
          state.messageId = 'msg_' + Date.now();
          state.createdAt = Math.floor(Date.now() / 1000);
          state.model = parsed.model || 'local-llm';
          state.textContent = '';
          state.usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

          // For GLM/thinking models, buffer content to strip thinking
          const isThinkingModel = state.model.toLowerCase().includes('glm');
          state.isThinkingModel = isThinkingModel;
          state.thinkingBuffer = isThinkingModel ? '' : null;
          state.thinkingStripped = false;

          log('info', `Streaming from model: ${state.model}${isThinkingModel ? ' (buffering for thinking)' : ''}`);

          // Emit response.created
          events.push({
            type: 'response.created',
            response: {
              id: state.responseId,
              object: 'response',
              created_at: state.createdAt,
              model: state.model,
              output: [],
              status: 'in_progress'
            }
          });

          // Emit output_item.added for the message
          events.push({
            type: 'response.output_item.added',
            output_index: 0,
            item: {
              type: 'message',
              id: state.messageId,
              status: 'in_progress',
              role: 'assistant',
              content: []
            }
          });

          // Emit content_part.added for the text
          events.push({
            type: 'response.content_part.added',
            output_index: 0,
            content_index: 0,
            part: {
              type: 'output_text',
              text: ''
            }
          });
        }

        // Emit text delta (with buffering for thinking models)
        if (delta) {
          state.usage.output_tokens++;

          // For thinking models, buffer until we can strip thinking content
          if (state.isThinkingModel && !state.thinkingStripped) {
            state.thinkingBuffer += delta;

            // Check if we have enough content to strip thinking
            // Look for transition phrases that indicate actual response starting
            const transitionMatch = state.thinkingBuffer.match(
              /(?:Let me provide[^.]*\.|Here(?:'s| is| are)[^.]*\.|For a \d+-gallon|^\*\*[A-Z])/m
            );

            if (transitionMatch || state.thinkingBuffer.length > 3000) {
              // Strip thinking and emit the clean content
              const cleanContent = stripThinkingContent(state.thinkingBuffer);
              state.textContent = cleanContent;
              state.thinkingStripped = true;

              log('info', `Stripped thinking content: ${state.thinkingBuffer.length} -> ${cleanContent.length} chars`);

              // Emit the clean content as a single delta
              if (cleanContent) {
                events.push({
                  type: 'response.output_text.delta',
                  output_index: 0,
                  content_index: 0,
                  delta: cleanContent
                });
              }
            }
          } else {
            // Normal streaming (non-thinking models or after stripping)
            state.textContent += delta;
            events.push({
              type: 'response.output_text.delta',
              output_index: 0,
              content_index: 0,
              delta: delta
            });
          }
        }

        // Update usage if provided
        if (parsed.usage) {
          state.usage = {
            input_tokens: parsed.usage.prompt_tokens || state.usage.input_tokens,
            output_tokens: parsed.usage.completion_tokens || state.usage.output_tokens,
            total_tokens: parsed.usage.total_tokens || state.usage.total_tokens
          };
        }
      } catch (e) {
        // Skip unparseable chunks
      }
    }
  } catch (e) {
    log('warn', 'Error converting stream chunk: ' + e.message);
  }

  return events;
}

// Format SSE events for Responses API
function formatResponsesSSE(events) {
  let output = '';
  for (const event of events) {
    output += `event: ${event.type}\n`;
    output += `data: ${JSON.stringify(event)}\n\n`;
  }
  return output;
}

// Convert Chat Completions response to Responses API format
function chatCompletionsToResponses(response, model, isHermes = false) {
  const parsed = typeof response === 'string' ? JSON.parse(response) : response;

  // Get content - some models (like GLM) put output in reasoning_content instead of content
  const message = parsed.choices?.[0]?.message || {};
  let content = message.content || '';

  // If content is empty but reasoning_content exists, use that
  // GLM models put their actual response in reasoning_content - strip thinking portion
  if (!content && message.reasoning_content) {
    content = stripThinkingContent(message.reasoning_content);
  }

  const output = [];

  // For Hermes models, parse tool calls from the content
  // Check for both XML-wrapped (<tool_call>) and JSON-only formats
  const maybeToolCall = isHermes && (
    content.includes('<tool_call>') ||
    (content.trim().startsWith('{') && content.includes('"name"'))
  );

  let foundToolCalls = false;

  if (maybeToolCall) {
    const { toolCalls, cleanContent } = parseHermesToolCalls(content);

    if (toolCalls.length > 0) {
      foundToolCalls = true;

      // Add text content if any
      if (cleanContent) {
        output.push({
          type: 'message',
          id: 'msg_' + Date.now(),
          status: 'completed',
          role: 'assistant',
          content: [{
            type: 'output_text',
            text: cleanContent
          }]
        });
      }

      // Add tool calls
      for (const toolCall of toolCalls) {
        output.push({
          type: 'function_call',
          id: toolCall.id,
          call_id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments
        });
      }
    }
  }

  if (!foundToolCalls) {
    // Regular message output
    output.push({
      type: 'message',
      id: 'msg_' + Date.now(),
      status: 'completed',
      role: 'assistant',
      content: [{
        type: 'output_text',
        text: content
      }]
    });
  }

  return {
    id: 'resp_' + Date.now(),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model: model || parsed.model || 'local-llm',
    output: output,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: null,
    store: true,
    temperature: 1,
    text: { format: { type: 'text' } },
    tool_choice: 'auto',
    tools: [],
    top_p: 1,
    truncation: 'disabled',
    usage: {
      input_tokens: parsed.usage?.prompt_tokens || 0,
      output_tokens: parsed.usage?.completion_tokens || 0,
      total_tokens: parsed.usage?.total_tokens || 0
    },
    user: null,
    metadata: {},
    status: 'completed',
    error: null,
    incomplete_details: null
  };
}

// Make HTTP request
function makeRequest(url, options, body, isStreaming = false) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https');
    const lib = isHttps ? https : http;
    const urlObj = new URL(url);

    const reqOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'POST',
      headers: options.headers || {}
    };

    const req = lib.request(reqOptions, (res) => {
      if (isStreaming) {
        resolve({ status: res.statusCode, headers: res.headers, stream: res });
        return;
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body: data });
      });
    });

    req.on('error', reject);
    req.setTimeout(120000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

// Handle streaming SSE response
// If needsConversion is true, convert Chat Completions streaming to Responses API streaming
function handleStreaming(proxyRes, clientRes, requestLog, needsConversion = false) {
  clientRes.writeHead(proxyRes.status, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  let fullResponse = '';
  const streamState = {};

  proxyRes.stream.on('data', (chunk) => {
    const data = chunk.toString();
    fullResponse += data;

    if (needsConversion) {
      // Convert Chat Completions streaming to Responses API streaming
      const events = convertStreamChunk(chunk, streamState);
      if (events.length > 0) {
        const sseData = formatResponsesSSE(events);
        clientRes.write(sseData);
      }
    } else {
      clientRes.write(data);
    }
  });

  proxyRes.stream.on('end', () => {
    // If conversion needed and stream didn't end cleanly, emit done events
    if (needsConversion && !streamState.done && streamState.started) {
      // Append model name footer for debugging
      const modelShortName = (streamState.model || 'unknown').replace(/\.gguf$/, '').replace(/-Q\d.*$/, '');
      const modelFooter = `\n\n_[via ${modelShortName}]_`;
      const finalText = (streamState.textContent || '') + modelFooter;

      const doneEvents = [{
        type: 'response.output_text.done',
        output_index: 0,
        content_index: 0,
        text: finalText
      }, {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'message',
          id: streamState.messageId || 'msg_' + Date.now(),
          status: 'completed',
          role: 'assistant',
          content: [{
            type: 'output_text',
            text: finalText
          }]
        }
      }, {
        type: 'response.done',
        response: {
          id: streamState.responseId || 'resp_' + Date.now(),
          object: 'response',
          created_at: streamState.createdAt || Math.floor(Date.now() / 1000),
          model: streamState.model || 'local-llm',
          output: [{
            type: 'message',
            id: streamState.messageId || 'msg_' + Date.now(),
            status: 'completed',
            role: 'assistant',
            content: [{
              type: 'output_text',
              text: finalText
            }]
          }],
          usage: streamState.usage || { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          status: 'completed',
          error: null
        }
      }];
      clientRes.write(formatResponsesSSE(doneEvents));
    }

    requestLog.response = {
      status: proxyRes.status,
      body: fullResponse.substring(0, config.logging.maxBodyLength),
      streaming: true,
      converted: needsConversion
    };
    requestLog.timing.totalMs = Date.now() - requestLog.timing.startTime;
    addRequestLog(requestLog);

    log('info', `Streaming request completed: ${requestLog.destination} ${proxyRes.status} ${requestLog.timing.totalMs}ms (model: ${streamState.model || 'unknown'})`, {
      requestId: requestLog.id,
      backend: requestLog.destination,
      model: streamState.model || 'unknown',
      converted: needsConversion
    });

    clientRes.end();
  });

  proxyRes.stream.on('error', (err) => {
    requestLog.error = err.message;
    addRequestLog(requestLog);
    clientRes.end();
  });
}

// Main proxy handler
async function handleProxyRequest(req, res, body) {
  const requestId = generateRequestId();
  const startTime = Date.now();

  const requestLog = {
    id: requestId,
    timestamp: new Date().toISOString(),
    layer: 'proxy',
    direction: 'request',
    source: req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'clawdbot',
    endpoint: req.url,
    method: req.method,
    request: {
      headers: { ...req.headers },
      body: config.logging.includeBody ?
        (body.length > config.logging.maxBodyLength ?
          body.substring(0, config.logging.maxBodyLength) + '...' : body) : '[omitted]'
    },
    timing: { startTime }
  };

  // Remove sensitive headers from log
  delete requestLog.request.headers['x-api-key'];
  delete requestLog.request.headers['authorization'];

  try {
    // Parse request body for smart routing
    let parsedRequestBody;
    try {
      parsedRequestBody = JSON.parse(body);
    } catch (e) {
      parsedRequestBody = {};
    }

    // Extract messages for classification
    let messages = parsedRequestBody.messages || [];
    if (parsedRequestBody.input) {
      // Responses API format
      if (typeof parsedRequestBody.input === 'string') {
        messages = [{ role: 'user', content: parsedRequestBody.input }];
      } else if (Array.isArray(parsedRequestBody.input)) {
        messages = parsedRequestBody.input.filter(m => m.role && m.content);
      }
    }

    // Extract user ID from request if available
    const userId = req.headers['x-user-id'] || parsedRequestBody.user || 'default';

    // Check for proxy-cli command in the last user message
    const lastUserMessage = messages.filter(m => m.role === 'user').pop();
    const lastContent = typeof lastUserMessage?.content === 'string'
      ? lastUserMessage.content
      : (Array.isArray(lastUserMessage?.content)
        ? lastUserMessage.content.map(c => c.text || c.content || '').join('')
        : '');

    if (lastContent.trim().toLowerCase().startsWith('proxy-cli')) {
      const cliResponse = await handleProxyCLI(lastContent);

      requestLog.destination = 'proxy-cli';
      requestLog.response = { status: 200, cliCommand: true };
      requestLog.timing.totalMs = Date.now() - startTime;
      addRequestLog(requestLog);

      log('info', `Proxy CLI command handled: ${lastContent.trim().split(' ')[1] || 'help'}`, { requestId });

      // Return as chat completion format
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'X-Request-Id': requestId,
        'X-Backend': 'proxy-cli'
      });
      res.end(JSON.stringify({
        id: `chatcmpl-cli-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'proxy-cli',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: cliResponse },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      }));
      return;
    }

    // Smart routing: classify and route
    let backend;
    let routingDecision = null;

    if (config.smartRouter?.enabled && messages.length > 0) {
      // Use smart router
      const classification = await classifyQuery(messages, userId);

      if (classification) {
        // Estimate context length
        const contextLength = JSON.stringify(messages).length / 4; // Rough token estimate

        routingDecision = getRoutingRecommendation(classification, contextLength, userId);
        backend = routingDecision.backend;

        requestLog.smartRouting = {
          classification,
          decision: routingDecision,
          userId
        };

        log('info', `Smart router: ${classification.category} -> ${backend}`, {
          requestId,
          reason: routingDecision.reason,
          multiModel: routingDecision.multiModel
        });

        // Handle multi-model queries
        if (routingDecision.multiModel && !parsedRequestBody.stream) {
          const multiResult = await executeMultiModelQuery(
            parsedRequestBody,
            routingDecision.allBackends,
            requestLog
          );

          if (multiResult) {
            // Record the decision
            recordRoutingDecision({
              requestId,
              classification,
              selectedBackend: 'multi:' + routingDecision.allBackends.join(','),
              userId,
              success: true
            });

            // Return combined response
            const response = {
              id: 'resp_' + Date.now(),
              object: 'response',
              created_at: Math.floor(Date.now() / 1000),
              model: 'multi-model',
              output: [{
                type: 'message',
                id: 'msg_' + Date.now(),
                status: 'completed',
                role: 'assistant',
                content: [{ type: 'output_text', text: multiResult.content }]
              }],
              usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
              status: 'completed'
            };

            res.writeHead(200, {
              'Content-Type': 'application/json',
              'X-Request-Id': requestId,
              'X-Backend': 'multi-model',
              'X-Routing-Reason': routingDecision.reason
            });
            res.end(JSON.stringify(response));

            requestLog.response = { status: 200, multiModel: true, backends: multiResult.backends };
            requestLog.timing.totalMs = Date.now() - startTime;
            addRequestLog(requestLog);
            return;
          }
        }

        // Record single-model routing decision
        recordRoutingDecision({
          requestId,
          classification,
          selectedBackend: backend,
          userId,
          success: true
        });
      } else {
        // Fallback to keyword-based routing
        backend = determineBackend(req.url, body);
      }
    } else {
      // Smart routing disabled, use keyword-based routing
      backend = determineBackend(req.url, body);
    }

    requestLog.destination = backend;

    log('debug', `Routing request to ${backend}`, { requestId, endpoint: req.url });

    // Get backend URL
    let backendUrl = config.backends[backend];
    if (!backendUrl) {
      throw new Error(`Unknown backend: ${backend}`);
    }

    // Build target URL
    let targetPath = req.url;
    // Remove backend prefix from path if present
    const backendPattern = new RegExp(`^/(${Object.keys(config.backends).join('|')})`);
    targetPath = targetPath.replace(backendPattern, '');
    if (!targetPath.startsWith('/')) targetPath = '/' + targetPath;

    // Prepare request body and headers
    let requestBody = body;
    const requestHeaders = {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };

    // Check request format types
    const isResponsesAPI = req.url.includes('/v1/responses');
    const isAnthropicFormat = req.url.includes('/v1/messages') ||
      (body && body.includes('"content":[{'));
    const isLocalBackend = backend !== 'anthropic';
    let needsResponseConversion = false;

    // Check if target model is Hermes (for tool calling support)
    let parsedBody;
    try {
      parsedBody = JSON.parse(body);
    } catch (e) {
      parsedBody = {};
    }
    const modelName = parsedBody.model || '';
    const isHermes = isHermesModel(modelName);
    requestLog.isHermes = isHermes;

    // Convert formats if needed
    if (isResponsesAPI && isLocalBackend) {
      // OpenAI Responses API -> Chat Completions conversion
      requestBody = JSON.stringify(responsesToChatCompletions(body, isHermes));
      targetPath = '/v1/chat/completions';  // Redirect to chat completions endpoint
      requestLog.formatConversion = isHermes ? 'responses-to-chat-completions-hermes' : 'responses-to-chat-completions';
      needsResponseConversion = true;
      log('debug', `Converting Responses API to Chat Completions${isHermes ? ' (Hermes mode)' : ''}`, { requestId });
    } else if (isAnthropicFormat && isLocalBackend) {
      // Anthropic -> OpenAI conversion
      requestBody = JSON.stringify(anthropicToOpenAI(body));
      requestLog.formatConversion = 'anthropic-to-openai';
      log('debug', 'Converting Anthropic format to OpenAI', { requestId });
    } else if (!isAnthropicFormat && !isResponsesAPI && backend === 'anthropic') {
      // OpenAI -> Anthropic conversion
      requestBody = JSON.stringify(openAIToAnthropic(body));
      requestLog.formatConversion = 'openai-to-anthropic';
      log('debug', 'Converting OpenAI format to Anthropic', { requestId });
    }

    // Store conversion flag for response processing
    requestLog.needsResponseConversion = needsResponseConversion;

    const targetUrl = backendUrl + targetPath;
    requestLog.targetUrl = targetUrl;

    // Add authentication headers
    if (backend === 'anthropic') {
      if (!ANTHROPIC_API_KEY) {
        throw new Error('ANTHROPIC_API_KEY not set');
      }
      requestHeaders['x-api-key'] = ANTHROPIC_API_KEY;
      requestHeaders['anthropic-version'] = '2023-06-01';
    } else {
      requestHeaders['Authorization'] = 'Bearer not-required';
    }

    // Check for streaming
    let isStreaming = false;
    try {
      const parsed = JSON.parse(requestBody);
      isStreaming = parsed.stream === true;
    } catch (e) {
      // Ignore
    }

    // Make the request
    const backendStart = Date.now();
    const proxyResponse = await makeRequest(targetUrl, {
      method: req.method,
      headers: requestHeaders
    }, requestBody, isStreaming);

    requestLog.timing.backendMs = Date.now() - backendStart;

    // Update metrics
    metrics.requests_total++;
    metrics.requests_by_backend[backend] = (metrics.requests_by_backend[backend] || 0) + 1;
    metrics.requests_by_status[proxyResponse.status] = (metrics.requests_by_status[proxyResponse.status] || 0) + 1;
    metrics.latency_sum += requestLog.timing.backendMs;
    metrics.latency_count++;

    // Handle streaming response
    if (isStreaming && proxyResponse.stream) {
      // Pass conversion flag if this is a Responses API request to a local backend
      const needsConversion = requestLog.formatConversion?.startsWith('responses-to-chat-completions');
      handleStreaming(proxyResponse, res, requestLog, needsConversion);
      return;
    }

    // Process non-streaming response
    let responseBody = proxyResponse.body;

    // Convert response format if needed
    if ((requestLog.formatConversion === 'responses-to-chat-completions' ||
         requestLog.formatConversion === 'responses-to-chat-completions-hermes') && proxyResponse.status === 200) {
      try {
        // Check if Hermes based on: request model, backend, or response model
        const respParsed = JSON.parse(proxyResponse.body);
        const respModel = (respParsed.model || '').toLowerCase();
        const isHermesResponse = requestLog.isHermes ||
                                  requestLog.formatConversion.includes('hermes') ||
                                  respModel.includes('hermes');
        responseBody = JSON.stringify(chatCompletionsToResponses(proxyResponse.body, requestLog.model, isHermesResponse));
        log('debug', `Converted Chat Completions response to Responses API format${isHermesResponse ? ' (Hermes)' : ''}`, { requestId });
      } catch (e) {
        log('warn', 'Failed to convert response format', { requestId, error: e.message });
      }
    } else if (requestLog.formatConversion === 'anthropic-to-openai' && proxyResponse.status === 200) {
      try {
        responseBody = JSON.stringify(openAIResponseToAnthropic(proxyResponse.body, backend));
        log('debug', 'Converted OpenAI response to Anthropic format', { requestId });
      } catch (e) {
        log('warn', 'Failed to convert response format', { requestId, error: e.message });
      }
    } else if (requestLog.formatConversion === 'openai-to-anthropic' && proxyResponse.status === 200) {
      try {
        responseBody = JSON.stringify(anthropicResponseToOpenAI(proxyResponse.body, backend));
        log('debug', 'Converted Anthropic response to OpenAI format', { requestId });
      } catch (e) {
        log('warn', 'Failed to convert response format', { requestId, error: e.message });
      }
    }

    // Complete request log
    requestLog.response = {
      status: proxyResponse.status,
      headers: proxyResponse.headers,
      body: config.logging.includeBody ?
        (responseBody.length > config.logging.maxBodyLength ?
          responseBody.substring(0, config.logging.maxBodyLength) + '...' : responseBody) : '[omitted]'
    };
    requestLog.timing.totalMs = Date.now() - startTime;
    requestLog.error = null;

    addRequestLog(requestLog);

    log('info', `Request completed: ${backend} ${proxyResponse.status} ${requestLog.timing.totalMs}ms`, {
      requestId,
      backend,
      status: proxyResponse.status,
      timing: requestLog.timing
    });

    // Send response to client
    res.writeHead(proxyResponse.status, {
      'Content-Type': 'application/json',
      'X-Request-Id': requestId,
      'X-Backend': backend,
      'X-Timing-Ms': requestLog.timing.totalMs.toString()
    });
    res.end(responseBody);

  } catch (err) {
    metrics.errors_total++;

    requestLog.error = err.message;
    requestLog.timing.totalMs = Date.now() - startTime;
    addRequestLog(requestLog);

    log('error', 'Proxy request failed', { requestId, error: err.message, stack: err.stack });

    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        type: 'proxy_error',
        message: err.message,
        request_id: requestId
      }
    }));
  }
}

// Debug endpoint: Get recent logs
function handleDebugLogs(req, res, query) {
  const limit = parseInt(query.get('limit') || '10');
  const backend = query.get('backend');
  const status = query.get('status');

  let logs = requestLogs;

  if (backend) {
    logs = logs.filter(l => l.destination === backend);
  }
  if (status) {
    logs = logs.filter(l => l.response?.status === parseInt(status));
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    total: logs.length,
    limit,
    logs: logs.slice(0, limit)
  }, null, 2));
}

// Debug endpoint: Health check
function handleDebugHealth(req, res) {
  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    mode: config.mode,
    backends: {},
    metrics: {
      requests_total: metrics.requests_total,
      errors_total: metrics.errors_total,
      avg_latency_ms: metrics.latency_count > 0 ?
        Math.round(metrics.latency_sum / metrics.latency_count) : 0
    }
  };

  // Check backend connectivity (async, but we'll respond immediately)
  Object.entries(config.backends).forEach(([name, url]) => {
    health.backends[name] = { url, status: 'unknown' };
  });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(health, null, 2));
}

// Debug endpoint: Compare backends
async function handleDebugCompare(req, res, body) {
  const startTime = Date.now();
  const results = {
    timestamp: new Date().toISOString(),
    request: JSON.parse(body),
    responses: {}
  };

  // Convert to OpenAI format for local backends
  const openAIBody = JSON.stringify(anthropicToOpenAI(body));

  // Test each local backend
  for (const [name, url] of Object.entries(config.backends)) {
    if (name === 'anthropic') continue;

    try {
      const backendStart = Date.now();
      const response = await makeRequest(url + '/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer not-required'
        }
      }, openAIBody);

      results.responses[name] = {
        status: response.status,
        latency_ms: Date.now() - backendStart,
        body: response.body.substring(0, 2000)
      };
    } catch (err) {
      results.responses[name] = {
        error: err.message
      };
    }
  }

  // Test Anthropic if API key is set
  if (ANTHROPIC_API_KEY) {
    try {
      const backendStart = Date.now();
      const response = await makeRequest(config.backends.anthropic + '/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        }
      }, body);

      results.responses.anthropic = {
        status: response.status,
        latency_ms: Date.now() - backendStart,
        body: response.body.substring(0, 2000)
      };
    } catch (err) {
      results.responses.anthropic = {
        error: err.message
      };
    }
  }

  results.total_time_ms = Date.now() - startTime;

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(results, null, 2));
}

// Debug endpoint: Get/set configuration
function handleDebugConfig(req, res, body) {
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(config, null, 2));
    return;
  }

  if (req.method === 'POST' || req.method === 'PUT') {
    try {
      const newConfig = JSON.parse(body);
      config = { ...config, ...newConfig };
      log('info', 'Configuration updated via API');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'updated', config }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(405, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Method not allowed' }));
}

// Debug endpoint: List available models and their status
async function handleDebugModels(req, res) {
  const models = [];

  // Check each backend
  for (const [name, url] of Object.entries(config.backends)) {
    const modelInfo = {
      backend: name,
      url: url,
      status: 'unknown',
      models: [],
      isDefault: name === config.defaultBackend,
      capabilities: config.smartRouter?.backends?.[name] || {}
    };

    try {
      if (name === 'anthropic') {
        // Anthropic doesn't have a /models endpoint, assume available if key is set
        if (ANTHROPIC_API_KEY) {
          modelInfo.status = 'available';
          modelInfo.models = ['claude-sonnet-4-20250514', 'claude-opus-4-20250514'];
        } else {
          modelInfo.status = 'no-api-key';
        }
      } else {
        // Check local LLM backends via /v1/models
        const response = await makeRequest(url + '/v1/models', {
          method: 'GET',
          headers: { 'Accept': 'application/json' }
        });

        if (response.status === 200) {
          const data = JSON.parse(response.body);
          modelInfo.status = 'running';
          modelInfo.models = (data.data || []).map(m => m.id || m);
        } else {
          modelInfo.status = 'error';
          modelInfo.error = `HTTP ${response.status}`;
        }
      }
    } catch (err) {
      modelInfo.status = 'offline';
      modelInfo.error = err.message;
    }

    models.push(modelInfo);
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    defaultBackend: config.defaultBackend,
    smartRouting: config.smartRouter?.enabled || false,
    models
  }, null, 2));
}

// ============================================================================
// Static File Serving - Dashboard
// ============================================================================

function serveStaticFile(req, res, filePath) {
  const publicDir = path.join(__dirname, 'public');
  let requestedPath = filePath;

  // Default to index.html for directory requests
  if (requestedPath === '' || requestedPath === '/') {
    requestedPath = '/index.html';
  }

  // Security: prevent directory traversal
  const safePath = path.normalize(requestedPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const fullPath = path.join(publicDir, safePath);

  // Ensure path is within public directory
  if (!fullPath.startsWith(publicDir)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        // Try index.html for SPA routing
        fs.readFile(path.join(publicDir, 'index.html'), (err2, indexData) => {
          if (err2) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(indexData);
          }
        });
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
      }
      return;
    }

    const ext = path.extname(fullPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'max-age=3600'
    });
    res.end(data);
  });
}

// ============================================================================
// Proxy CLI - Telegram command interface
// ============================================================================

async function handleProxyCLI(message) {
  const parts = message.trim().split(/\s+/);
  const command = parts[1]?.toLowerCase();
  const arg = parts.slice(2).join(' ');

  switch (command) {
    case 'status':
      return formatCLIStatus();
    case 'models':
      return await formatCLIModels();
    case 'use':
      return handleCLIUse(arg);
    case 'smart':
      return handleCLISmart();
    case 'logs':
      return formatCLILogs(parseInt(arg) || 5);
    case 'help':
    default:
      return formatCLIHelp();
  }
}

function formatCLIStatus() {
  const avgLatency = metrics.latency_count > 0 ?
    Math.round(metrics.latency_sum / metrics.latency_count) : 0;
  const successRate = metrics.requests_total > 0 ?
    Math.round(((metrics.requests_total - metrics.errors_total) / metrics.requests_total) * 100) : 100;

  return `**LLM Debug Proxy Status**

**Active Backend:** ${config.defaultBackend}
**Smart Routing:** ${config.smartRouter?.enabled ? 'ON' : 'OFF'}
**Total Requests:** ${metrics.requests_total}
**Success Rate:** ${successRate}%
**Avg Latency:** ${avgLatency}ms
**Errors:** ${metrics.errors_total}

_Use \`proxy-cli help\` for available commands_`;
}

async function formatCLIModels() {
  const lines = ['**Available Backends**\n'];

  for (const [name, url] of Object.entries(config.backends)) {
    let status = '⚪ unknown';
    let modelName = '';

    try {
      if (name === 'anthropic') {
        if (ANTHROPIC_API_KEY) {
          status = '🟢 available';
          modelName = 'Claude';
        } else {
          status = '🔴 no-api-key';
        }
      } else {
        const response = await makeRequest(url + '/v1/models', {
          method: 'GET',
          headers: { 'Accept': 'application/json' }
        });

        if (response.status === 200) {
          const data = JSON.parse(response.body);
          status = '🟢 running';
          const models = data.data || [];
          if (models.length > 0) {
            modelName = (models[0].id || models[0]).replace(/\.gguf$/, '').replace(/-Q\d.*$/, '');
          }
        } else {
          status = '🔴 error';
        }
      }
    } catch (err) {
      status = '🔴 offline';
    }

    const isDefault = name === config.defaultBackend ? ' ⭐' : '';
    const displayName = config.smartRouter?.backends?.[name]?.name || name;
    lines.push(`${status} **${name}**${isDefault}`);
    if (modelName) lines.push(`   └─ ${modelName}`);
  }

  lines.push(`\n_⭐ = default backend_`);
  return lines.join('\n');
}

function handleCLIUse(backend) {
  if (!backend) {
    return `**Error:** Missing backend name\n\nUsage: \`proxy-cli use <backend>\`\nAvailable: ${Object.keys(config.backends).join(', ')}`;
  }

  const normalizedBackend = backend.toLowerCase();
  if (!config.backends[normalizedBackend]) {
    return `**Error:** Unknown backend: ${backend}\n\nAvailable backends: ${Object.keys(config.backends).join(', ')}`;
  }

  const previous = config.defaultBackend;
  config.defaultBackend = normalizedBackend;
  log('info', `CLI: Switched default backend from ${previous} to ${normalizedBackend}`);

  return `**Backend Switched**\n\n${previous} → **${normalizedBackend}**`;
}

function handleCLISmart() {
  const wasEnabled = config.smartRouter?.enabled || false;
  config.smartRouter.enabled = !wasEnabled;
  log('info', `CLI: Smart routing ${config.smartRouter.enabled ? 'enabled' : 'disabled'}`);

  return `**Smart Routing ${config.smartRouter.enabled ? 'Enabled' : 'Disabled'}**\n\n${config.smartRouter.enabled ?
    'Queries will be automatically routed to the best backend based on content.' :
    'All queries will go to the default backend: ' + config.defaultBackend}`;
}

function formatCLILogs(count) {
  const logs = requestLogs.slice(0, Math.min(count, 10));

  if (logs.length === 0) {
    return '**No recent requests**';
  }

  const lines = [`**Last ${logs.length} Requests**\n`];

  for (const log of logs) {
    const time = new Date(log.timestamp).toLocaleTimeString();
    const status = log.response?.status || 'pending';
    const statusIcon = status < 400 ? '✅' : '❌';
    const latency = log.timing?.totalMs ? `${log.timing.totalMs}ms` : '-';
    const backend = log.destination || 'unknown';

    // Get a preview of the request content
    let preview = '';
    try {
      const body = JSON.parse(log.request?.body || '{}');
      const messages = body.messages || [];
      const lastUser = messages.filter(m => m.role === 'user').pop();
      if (lastUser) {
        preview = (lastUser.content || '').substring(0, 40);
        if (preview.length >= 40) preview += '...';
      }
    } catch (e) {
      preview = '';
    }

    lines.push(`${statusIcon} \`${time}\` → **${backend}** (${latency})`);
    if (preview) lines.push(`   └─ "${preview}"`);
  }

  return lines.join('\n');
}

function formatCLIHelp() {
  return `**LLM Debug Proxy CLI**

**Commands:**
\`proxy-cli status\` - Proxy status summary
\`proxy-cli models\` - List backends with health
\`proxy-cli use <backend>\` - Switch default backend
\`proxy-cli smart\` - Toggle smart routing
\`proxy-cli logs [N]\` - Show last N requests (max 10)
\`proxy-cli help\` - Show this help

**Available Backends:**
${Object.keys(config.backends).join(', ')}

**Dashboard:**
https://llm-proxy.treehouse/dashboard`;
}

// ============================================================================
// Stats Endpoint - Aggregated statistics for dashboard
// ============================================================================

function handleDebugStats(req, res) {
  const logs = requestLogs.slice(0, 1000);
  const now = Date.now();
  const oneHourAgo = now - 3600000;
  const oneDayAgo = now - 86400000;

  // Calculate stats
  const successCount = logs.filter(l => l.response?.status && l.response.status < 400).length;
  const totalLatency = logs.reduce((sum, l) => sum + (l.timing?.totalMs || 0), 0);

  // Group by backend
  const byBackend = {};
  for (const log of logs) {
    const backend = log.destination || 'unknown';
    if (!byBackend[backend]) {
      byBackend[backend] = { count: 0, success: 0, latencySum: 0, errors: 0 };
    }
    byBackend[backend].count++;
    if (log.response?.status && log.response.status < 400) {
      byBackend[backend].success++;
    } else if (log.response?.status >= 400 || log.error) {
      byBackend[backend].errors++;
    }
    byBackend[backend].latencySum += log.timing?.totalMs || 0;
  }

  // Format backend stats
  const backendStats = {};
  for (const [backend, data] of Object.entries(byBackend)) {
    backendStats[backend] = {
      requests: data.count,
      successRate: data.count > 0 ? Math.round((data.success / data.count) * 100) : 0,
      avgLatency: data.count > 0 ? Math.round(data.latencySum / data.count) : 0,
      errors: data.errors
    };
  }

  // Category distribution from smart routing
  const byCategory = {};
  for (const log of logs) {
    const category = log.smartRouting?.classification?.category || 'unclassified';
    byCategory[category] = (byCategory[category] || 0) + 1;
  }

  // Recent activity (last hour)
  const recentLogs = logs.filter(l => new Date(l.timestamp).getTime() > oneHourAgo);

  const stats = {
    overview: {
      totalRequests: logs.length,
      successCount,
      successRate: logs.length > 0 ? Math.round((successCount / logs.length) * 100) : 100,
      avgLatency: logs.length > 0 ? Math.round(totalLatency / logs.length) : 0,
      errorCount: metrics.errors_total,
      requestsLastHour: recentLogs.length
    },
    config: {
      defaultBackend: config.defaultBackend,
      smartRoutingEnabled: config.smartRouter?.enabled || false,
      mode: config.mode
    },
    byBackend: backendStats,
    byCategory,
    routerHistory: {
      totalDecisions: routerHistory.decisions.length,
      recentDecisions: routerHistory.decisions.slice(-5).reverse()
    },
    timestamp: new Date().toISOString()
  };

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(stats, null, 2));
}

// Debug endpoint: Switch default backend/model
function handleDebugSwitch(req, res, body) {
  if (req.method !== 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      message: 'POST to switch the default backend',
      currentDefault: config.defaultBackend,
      availableBackends: Object.keys(config.backends),
      example: { backend: Object.keys(config.backends)[0] || 'local' }
    }, null, 2));
    return;
  }

  try {
    const { backend } = JSON.parse(body);

    if (!backend) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing "backend" field' }));
      return;
    }

    if (!config.backends[backend]) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: `Unknown backend: ${backend}`,
        availableBackends: Object.keys(config.backends)
      }));
      return;
    }

    const previousDefault = config.defaultBackend;
    config.defaultBackend = backend;

    log('info', `Switched default backend from ${previousDefault} to ${backend}`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'switched',
      previousDefault,
      newDefault: backend,
      smartRouting: config.smartRouter?.enabled || false
    }));
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

// Debug endpoint: Smart router status and management
async function handleDebugRouter(req, res, body, query) {
  if (req.method === 'GET') {
    // Return router status and history
    const limit = parseInt(query.get('limit') || '20');

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      enabled: config.smartRouter?.enabled || false,
      classifierBackend: config.smartRouter?.classifierBackend,
      backends: config.smartRouter?.backends,
      history: {
        totalDecisions: routerHistory.decisions.length,
        recentDecisions: routerHistory.decisions.slice(-limit).reverse(),
        userPreferences: routerHistory.userPreferences,
        modelPerformance: routerHistory.modelPerformance,
        lastUpdated: routerHistory.lastUpdated
      }
    }, null, 2));
    return;
  }

  if (req.method === 'POST') {
    try {
      const action = JSON.parse(body);

      if (action.action === 'classify') {
        // Manually classify a query
        const messages = action.messages || [{ role: 'user', content: action.query }];
        const classification = await classifyQuery(messages, action.userId || 'test');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          query: action.query,
          classification,
          recommendation: classification ? getRoutingRecommendation(classification) : null
        }, null, 2));
        return;
      }

      if (action.action === 'setPreference') {
        // Set user preference
        const userId = action.userId || 'default';
        if (!routerHistory.userPreferences[userId]) {
          routerHistory.userPreferences[userId] = {};
        }

        if (action.category && action.preferredBackend) {
          if (!routerHistory.userPreferences[userId].categoryOverrides) {
            routerHistory.userPreferences[userId].categoryOverrides = {};
          }
          routerHistory.userPreferences[userId].categoryOverrides[action.category] = [action.preferredBackend];
        }

        if (action.qualityPreference) {
          routerHistory.userPreferences[userId].qualityPreference = action.qualityPreference;
        }

        saveRouterHistory();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'updated',
          userPreferences: routerHistory.userPreferences[userId]
        }));
        return;
      }

      if (action.action === 'clearHistory') {
        routerHistory.decisions = [];
        saveRouterHistory();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'cleared' }));
        return;
      }

      if (action.action === 'enable' || action.action === 'disable') {
        config.smartRouter.enabled = action.action === 'enable';

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'updated',
          enabled: config.smartRouter.enabled
        }));
        return;
      }

      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Unknown action',
        availableActions: ['classify', 'setPreference', 'clearHistory', 'enable', 'disable']
      }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(405, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Method not allowed' }));
}

// Main HTTP server
const server = http.createServer((req, res) => {
  let body = '';

  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const query = url.searchParams;

    log('debug', `Received ${req.method} ${pathname}`);

    // Handle debug endpoints
    if (pathname === '/debug/logs') {
      handleDebugLogs(req, res, query);
      return;
    }

    if (pathname === '/debug/health') {
      handleDebugHealth(req, res);
      return;
    }

    if (pathname === '/debug/compare') {
      if (req.method === 'POST') {
        await handleDebugCompare(req, res, body);
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          message: 'POST a request body to compare responses from all backends',
          example: {
            model: 'test',
            messages: [{ role: 'user', content: 'Hello' }],
            max_tokens: 50
          }
        }));
      }
      return;
    }

    if (pathname === '/debug/config') {
      handleDebugConfig(req, res, body);
      return;
    }

    if (pathname === '/debug/router') {
      await handleDebugRouter(req, res, body, query);
      return;
    }

    if (pathname === '/debug/models') {
      await handleDebugModels(req, res);
      return;
    }

    if (pathname === '/debug/switch') {
      handleDebugSwitch(req, res, body);
      return;
    }

    if (pathname === '/debug/stats') {
      handleDebugStats(req, res);
      return;
    }

    // Dashboard - serve static files
    if (pathname.startsWith('/dashboard')) {
      const filePath = pathname.replace('/dashboard', '') || '/';
      serveStaticFile(req, res, filePath);
      return;
    }

    // Root endpoint - show info
    if (pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        name: 'LLM Debug Proxy',
        version: '2.0.0',
        mode: config.mode,
        smartRouter: {
          enabled: config.smartRouter?.enabled || false,
          classifierBackend: config.smartRouter?.classifierBackend,
          totalDecisions: routerHistory.decisions.length
        },
        endpoints: {
          proxy: '/v1/chat/completions, /v1/messages, /v1/responses',
          debug: '/debug/logs, /debug/health, /debug/compare, /debug/config, /debug/router, /debug/models, /debug/switch, /debug/stats',
          dashboard: '/dashboard',
          metrics: ':9090/metrics'
        },
        backends: Object.keys(config.backends)
      }, null, 2));
      return;
    }

    // Handle API proxy requests
    if (pathname.startsWith('/v1/') || pathname.includes('/chat/completions') || pathname.includes('/messages')) {
      await handleProxyRequest(req, res, body);
      return;
    }

    // 404 for unknown endpoints
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found', path: pathname }));
  });
});

// Prometheus metrics server
const metricsServer = http.createServer((req, res) => {
  if (req.url === '/metrics') {
    const avgLatency = metrics.latency_count > 0 ?
      (metrics.latency_sum / metrics.latency_count).toFixed(2) : 0;

    let output = '';
    output += '# HELP llm_proxy_requests_total Total number of requests\n';
    output += '# TYPE llm_proxy_requests_total counter\n';
    output += `llm_proxy_requests_total ${metrics.requests_total}\n\n`;

    output += '# HELP llm_proxy_errors_total Total number of errors\n';
    output += '# TYPE llm_proxy_errors_total counter\n';
    output += `llm_proxy_errors_total ${metrics.errors_total}\n\n`;

    output += '# HELP llm_proxy_latency_avg_ms Average latency in milliseconds\n';
    output += '# TYPE llm_proxy_latency_avg_ms gauge\n';
    output += `llm_proxy_latency_avg_ms ${avgLatency}\n\n`;

    output += '# HELP llm_proxy_requests_by_backend Requests by backend\n';
    output += '# TYPE llm_proxy_requests_by_backend counter\n';
    for (const [backend, count] of Object.entries(metrics.requests_by_backend)) {
      output += `llm_proxy_requests_by_backend{backend="${backend}"} ${count}\n`;
    }
    output += '\n';

    output += '# HELP llm_proxy_requests_by_status Requests by HTTP status\n';
    output += '# TYPE llm_proxy_requests_by_status counter\n';
    for (const [status, count] of Object.entries(metrics.requests_by_status)) {
      output += `llm_proxy_requests_by_status{status="${status}"} ${count}\n`;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(output);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// Start servers
loadConfig();
loadRouterHistory();

server.listen(PROXY_PORT, '0.0.0.0', () => {
  log('info', `LLM Debug Proxy listening on port ${PROXY_PORT}`);
  log('info', `Mode: ${config.mode}`);
  log('info', `Backends: ${Object.keys(config.backends).join(', ')}`);
  log('info', `Default backend: ${config.defaultBackend}`);
  log('info', `Smart router: ${config.smartRouter?.enabled ? 'enabled' : 'disabled'}`);
  log('info', `Anthropic API key: ${ANTHROPIC_API_KEY ? 'set' : 'not set'}`);
});

metricsServer.listen(METRICS_PORT, '0.0.0.0', () => {
  log('info', `Prometheus metrics on port ${METRICS_PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  log('info', 'Received SIGTERM, shutting down...');
  server.close(() => {
    metricsServer.close(() => {
      process.exit(0);
    });
  });
});

process.on('SIGINT', () => {
  log('info', 'Received SIGINT, shutting down...');
  server.close(() => {
    metricsServer.close(() => {
      process.exit(0);
    });
  });
});

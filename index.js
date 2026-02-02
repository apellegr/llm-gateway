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
 * - Debug endpoints: /debug/logs, /debug/health, /debug/compare, /debug/stats, /debug/tokens
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
const { MongoClient } = require('mongodb');

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
  },
  storage: {
    enabled: false, // Enable MongoDB storage for request/response logging
    uri: 'mongodb://127.0.0.1:27017',
    database: 'llm_gateway',
    collection: 'requests',
    privacy: {
      storeQueries: true,   // Store user message content
      storeResponses: true  // Store assistant responses
    },
    retention: {
      days: 30,            // Auto-delete after N days (0 = forever)
      maxDocuments: 10000  // Max documents to keep
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

// Fast model-based check: does this query need real-time/current information?
// Uses a small fast model (concierge/Llama-3.2-3B) for quick classification
async function checkNeedsRealtimeInfo(userContent) {
  // Use the fastest available backend (concierge = Llama-3.2-3B)
  const fastBackend = config.backends.concierge || config.backends[config.defaultBackend];
  if (!fastBackend) return false;

  const checkUrl = fastBackend + '/v1/chat/completions';

  const checkRequest = {
    model: 'realtime-check',
    messages: [
      {
        role: 'system',
        content: `You determine if a query needs CURRENT/REAL-TIME information.
Answer only YES or NO.

YES if the query needs:
- Current weather, temperature, or forecasts
- Live prices (stocks, crypto, products)
- Current news, events, or headlines
- Service/website status (is X down?)
- Sports scores or live results
- Current time in a location
- Any information that changes frequently and the user expects current data

NO if:
- The query is about general knowledge, concepts, or history
- The query is asking for code, explanations, or analysis
- The query doesn't need up-to-date information
- The information wouldn't change day-to-day

Answer only: YES or NO`
      },
      { role: 'user', content: userContent.substring(0, 500) }
    ],
    max_tokens: 5,
    temperature: 0,
    stream: false
  };

  try {
    const response = await makeRequest(checkUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer not-required'
      }
    }, JSON.stringify(checkRequest));

    if (response.status === 200) {
      const parsed = JSON.parse(response.body);
      const answer = (parsed.choices?.[0]?.message?.content || '').trim().toUpperCase();
      const needsRealtime = answer.startsWith('YES');
      log('debug', `Realtime check: "${userContent.substring(0, 50)}..." -> ${needsRealtime ? 'YES' : 'NO'}`);
      return needsRealtime;
    }
  } catch (err) {
    log('warn', `Realtime check failed: ${err.message}`);
  }

  return false;
}

// Classify a query using the classifier backend
// skipRealtimeCheck: set to true if request already has tools (e.g., from Clawdbot)
async function classifyQuery(messages, userId = 'default', skipRealtimeCheck = false) {
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

    // Skip realtime classification if request already has tools
    // (client like Clawdbot already provides web_search and other tools)
    if (skipRealtimeCheck && quickClassification?.category === 'realtime') {
      log('debug', 'Skipping realtime classification - request already has tools');
      // Return as conversation instead to use default routing
      return {
        ...quickClassification,
        category: 'conversation',
        note: 'Realtime skipped - request has existing tools'
      };
    }

    if (quickClassification && quickClassification.confidence > 0.9) {
      log('debug', 'Quick classification used', quickClassification);
      return quickClassification;
    }

    // Fast model-based realtime check (if quick classification didn't catch it)
    // This uses a small fast model to detect queries needing current information
    // Skip if request already has tools
    if (!skipRealtimeCheck && quickClassification?.category !== 'realtime') {
      const needsRealtime = await checkNeedsRealtimeInfo(userContent);
      if (needsRealtime) {
        log('info', 'Model-based realtime detection triggered');
        return {
          category: 'realtime',
          confidence: 0.9,
          complexity: 'moderate',
          suggestedBackends: ['secretary', 'concierge'],
          modelBased: true,
          note: 'Model detected need for real-time information'
        };
      }
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

  // User dissatisfaction / retry patterns - they want us to search online
  const dissatisfactionPatterns = [
    /\b(that'?s?|you'?re?)\s+(wrong|incorrect|outdated|old|stale)\b/i,
    /\b(check|look|search)\s+(online|the web|internet|it up)\b/i,
    /\b(can you|please)\s+(verify|confirm|check|look up|search)\b/i,
    /\b(actually|but)\s+.*(current|latest|now|today|recent)\b/i,
    /\b(are you sure|is that right|is that correct)\b/i,
    /\b(more recent|up to date|updated|current)\s+(info|information|data)\b/i,
    /\b(google|search for|look up)\s+/i,
    /\btry again\b/i,
    /\b(that|this)\s+(info|information|data|answer)\s+.*(old|wrong|outdated)\b/i
  ];

  for (const pattern of dissatisfactionPatterns) {
    if (pattern.test(content)) {
      return {
        category: 'realtime',
        confidence: 0.95,
        complexity: 'moderate',
        suggestedBackends: ['secretary', 'concierge'],
        quick: true,
        note: 'User requesting updated info - will use web_search',
        retryWithSearch: true
      };
    }
  }

  // Real-time/current information patterns - requires web access
  // Check these BEFORE the short message heuristic
  const realtimePatterns = [
    // Explicit weather queries
    /\b(current|right now|today'?s?|latest|live)\b.*\b(weather|temperature|forecast)\b/i,
    /\b(weather|temperature|forecast)\b.*\b(current|right now|today|now)\b/i,
    /\bwhat('s| is)\s+(the\s+)?weather\b/i,  // "what is the weather in X" - implicitly current
    /\bweather\s+(in|for|at)\s+\w/i,  // "weather in London" - implicitly current
    // Implicit weather queries - questions that need weather data to answer
    /\b(do i|should i|will i)\s+need\s+(an?\s+)?(umbrella|raincoat|jacket|coat|sweater)/i,  // "Do I need an umbrella?"
    /\b(should i|do i need to)\s+(bring|wear|pack)\s+(an?\s+)?(jacket|coat|sweater|umbrella|shorts|sunscreen)/i,  // "Should I bring a jacket?"
    /\b(is it|will it be|going to be)\s+(rain|snow|storm|sunny|cloudy|cold|hot|warm|humid)/i,  // "Is it raining in Paris?"
    /\b(is it|will it)\s+(rain|snow|storm)ing\b/i,  // "Is it raining?"
    /\b(how (cold|hot|warm|humid) is it)\b/i,  // "How cold is it?"
    /\b(what should i wear|dress for)\b.*\b(in|to|at)\s+\w/i,  // "What should I wear in Seattle?"
    // News/events/scores
    /\b(current|latest|today'?s?|live)\b.*\b(news|headlines|events|scores?)\b/i,
    /\b(stock|share) price\b/i,
    /\bwhat time is it\b/i,
    /\b(who won|score of)\b.*\b(game|match)\b/i,
    /\btrending\b/i,
    // Service status
    /\bis\s+\w+\s+(down|up|working|online|offline)\b/i,  // "is Netflix down", "is AWS working"
    /\b(outage|downtime|status)\b.*\b(right now|currently|today)?\b/i,  // "Netflix outage", "AWS status"
    /\b(down|offline|not working)\s+(right now|currently|today)?\b/i  // "X is down right now"
  ];

  for (const pattern of realtimePatterns) {
    if (pattern.test(content)) {
      return {
        category: 'realtime',
        confidence: 0.95,
        complexity: 'moderate',
        suggestedBackends: ['secretary', 'concierge'],  // Local models with web_search tool support
        quick: true,
        note: 'Requires real-time web access - using web_search tool'
      };
    }
  }

  // Very short messages (< 30 chars) without code markers are usually casual
  // This check comes AFTER realtime patterns to avoid misclassifying service status queries
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
  let userPreferenceApplied = false;

  // Build candidate scoring for enhanced routing details
  const candidates = validBackends.map(backend => {
    const backendConfig = config.smartRouter?.backends?.[backend] || {};
    const specialties = backendConfig.specialties || [];
    const category = classification.category || 'general';

    // Calculate score based on specialty match and classification confidence
    let score = 0;
    const matchedSpecialties = [];

    // Check specialty matches
    if (specialties.includes(category)) {
      score += 0.5;
      matchedSpecialties.push(category);
    }
    if (specialties.includes(classification.complexity)) {
      score += 0.2;
      matchedSpecialties.push(classification.complexity);
    }
    for (const keyword of (classification.keywords || [])) {
      if (specialties.includes(keyword)) {
        score += 0.1;
        matchedSpecialties.push(keyword);
      }
    }

    // Boost if in suggested backends
    if (suggestedBackends.includes(backend)) {
      score += 0.3 * (classification.confidence || 0.5);
    }

    // Cap at 1.0
    score = Math.min(score, 1.0);

    return {
      backend,
      score: Math.round(score * 100) / 100,
      matched: matchedSpecialties,
      specialties,
      contextWindow: backendConfig.contextWindow || 0
    };
  }).sort((a, b) => b.score - a.score);

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
      userPreferenceApplied = true;
    }
  }

  return {
    backend: selectedBackend,
    multiModel,
    allBackends: multiModel ? backends.slice(0, 3) : [selectedBackend],
    reason,
    classification,
    // Enhanced routing details
    candidates: candidates.slice(0, 4),  // Top 4 candidates
    confidenceThreshold: 0.7,
    userPreferenceApplied,
    contextLength
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
  latency_count: 0,
  // Token tracking
  tokens_input_total: 0,
  tokens_output_total: 0,
  tokens_by_backend: {}  // { backend: { input: N, output: N } }
};

// ============================================================================
// MongoDB Storage - Persistent request/response logging
// ============================================================================

let mongoClient = null;
let db = null;

async function connectMongoDB() {
  if (!config.storage?.enabled) return;

  try {
    mongoClient = new MongoClient(config.storage.uri);
    await mongoClient.connect();
    db = mongoClient.db(config.storage.database);

    // Create indexes
    const coll = db.collection(config.storage.collection);
    await coll.createIndex({ timestamp: -1 });
    await coll.createIndex({ 'routing.backend': 1 });
    await coll.createIndex({ userId: 1 });

    // TTL index for auto-deletion (only if retention.days > 0)
    if (config.storage.retention?.days > 0) {
      await coll.createIndex(
        { timestamp: 1 },
        { expireAfterSeconds: config.storage.retention.days * 86400 }
      );
    }

    log('info', 'MongoDB connected', { database: config.storage.database });
  } catch (err) {
    log('error', 'MongoDB connection failed', { error: err.message });
  }
}

async function disconnectMongoDB() {
  if (mongoClient) {
    await mongoClient.close();
    mongoClient = null;
    db = null;
    log('info', 'MongoDB disconnected');
  }
}

function extractUserQuery(requestLog) {
  try {
    const body = JSON.parse(requestLog.request?.body || '{}');
    const messages = body.messages || body.input || [];
    // Handle string input (Responses API)
    if (typeof messages === 'string') {
      return messages.substring(0, 2000);
    }
    // Handle array of messages
    const userMsgs = Array.isArray(messages)
      ? messages.filter(m => m.role === 'user')
      : [];
    const lastUserMsg = userMsgs.pop();
    if (!lastUserMsg) return '';
    // Handle text content
    const content = typeof lastUserMsg.content === 'string'
      ? lastUserMsg.content
      : (Array.isArray(lastUserMsg.content)
        ? lastUserMsg.content.map(c => c.text || '').join('')
        : '');
    return content.substring(0, 2000);
  } catch {
    return '';
  }
}

function extractResponse(requestLog) {
  try {
    const body = JSON.parse(requestLog.response?.body || '{}');
    // OpenAI format
    if (body.choices?.[0]?.message?.content) {
      return body.choices[0].message.content.substring(0, 2000);
    }
    // Responses API format
    if (body.output?.[0]?.content?.[0]?.text) {
      return body.output[0].content[0].text.substring(0, 2000);
    }
    // Anthropic format
    if (body.content?.[0]?.text) {
      return body.content[0].text.substring(0, 2000);
    }
    return '';
  } catch {
    return '';
  }
}

async function storeRequest(requestLog) {
  if (!db) return;

  const privacy = config.storage.privacy || {};

  const doc = {
    requestId: requestLog.id,
    timestamp: new Date(requestLog.timestamp),
    userId: requestLog.source,
    endpoint: requestLog.endpoint,

    routing: {
      backend: requestLog.destination,
      model: requestLog.model,
      decision: requestLog.smartRouting?.decision,
      classification: requestLog.smartRouting?.classification,
      formatConversion: requestLog.formatConversion
    },

    timing: requestLog.timing,
    tokens: requestLog.tokens,
    status: requestLog.response?.status,

    // Privacy-controlled fields
    query: privacy.storeQueries ? extractUserQuery(requestLog) : '[redacted]',
    response: privacy.storeResponses ? extractResponse(requestLog) : '[redacted]',

    tools: {
      injected: requestLog.webSearchToolInjected || false,
      called: requestLog.toolCallsDetected || [],
      autoSearch: requestLog.autoSearchTriggered || false
    },

    error: requestLog.error || null
  };

  try {
    await db.collection(config.storage.collection).insertOne(doc);
  } catch (err) {
    log('warn', 'Failed to store request', { error: err.message });
  }
}

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
  // Store to MongoDB (async, non-blocking)
  storeRequest(entry).catch(err => {
    log('warn', 'MongoDB store failed', { error: err.message });
  });
}

// Extract tokens from response and update metrics
function extractAndTrackTokens(responseBody, backend) {
  let tokens = { input: 0, output: 0, total: 0 };

  try {
    const parsed = typeof responseBody === 'string' ? JSON.parse(responseBody) : responseBody;
    const usage = parsed.usage;

    if (usage) {
      // Handle both OpenAI (prompt_tokens, completion_tokens) and Anthropic (input_tokens, output_tokens) formats
      tokens.input = usage.prompt_tokens || usage.input_tokens || 0;
      tokens.output = usage.completion_tokens || usage.output_tokens || 0;
      tokens.total = tokens.input + tokens.output;

      // Update global metrics
      metrics.tokens_input_total += tokens.input;
      metrics.tokens_output_total += tokens.output;

      // Update per-backend metrics
      if (!metrics.tokens_by_backend[backend]) {
        metrics.tokens_by_backend[backend] = { input: 0, output: 0 };
      }
      metrics.tokens_by_backend[backend].input += tokens.input;
      metrics.tokens_by_backend[backend].output += tokens.output;
    }
  } catch (e) {
    // Ignore parse errors - streaming responses may not have usage data
  }

  return tokens;
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

  // Map model name to valid Anthropic model
  let model = parsed.model || 'claude-sonnet-4-20250514';
  const modelLower = model.toLowerCase();
  if (!modelLower.includes('claude')) {
    // Default to Claude Sonnet for non-Claude model names
    model = 'claude-sonnet-4-20250514';
  }

  return {
    model,
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

// Check if model supports tool calling
function supportsToolCalling(model) {
  const modelLower = (model || '').toLowerCase();
  return modelLower.includes('hermes') ||
         modelLower.includes('qwen') ||
         modelLower.includes('llama') ||
         modelLower.includes('mistral');
}

// ============================================================================
// Web Search Tool - DuckDuckGo Integration
// ============================================================================

// Web search tool definition
const WEB_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search the web for current information. Use this for weather, news, current events, stock prices, or any query requiring up-to-date information.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query'
        }
      },
      required: ['query']
    }
  }
};

// Perform web search using DuckDuckGo HTML
async function performWebSearch(query) {
  log('info', `Performing web search: "${query}"`);
  const queryLower = query.toLowerCase();

  try {
    // Check if this is a weather query - use wttr.in for weather
    // Explicit weather words
    const explicitWeatherPattern = /\b(weather|temperature|forecast|celsius|fahrenheit)\b/i;
    // Implicit weather queries - things that need weather data to answer
    const implicitWeatherPatterns = [
      /\b(umbrella|raincoat|rain jacket)\b/i,                    // "Do I need an umbrella?"
      /\b(is it|will it be|going to be)\s+(rain|snow|storm|sunny|cloudy|cold|hot|warm|humid)/i,  // "Is it raining?"
      /\b(raining|snowing|storming)\b/i,                         // "Is it raining in Paris?"
      /\b(should i|do i need)\s+(bring|wear|pack)\s+(jacket|coat|sweater|shorts|sunscreen)/i,  // "Should I bring a jacket?"
      /\b(how (cold|hot|warm|humid)|what('s| is) the (temp|climate))\b/i,  // "How cold is it?"
      /\b(dress for|what to wear)\b/i,                           // "What should I wear?"
    ];

    const isWeatherQuery = explicitWeatherPattern.test(queryLower) ||
                           implicitWeatherPatterns.some(p => p.test(queryLower));

    if (isWeatherQuery) {
      // Try multiple patterns to extract location
      let location = null;

      // Pattern 1: "weather in <location>" or "temperature in <location>"
      const inPattern = queryLower.match(/(?:weather|temperature|forecast)\s+(?:in|for|at)\s+(.+?)(?:\?|$)/);
      if (inPattern) location = inPattern[1];

      // Pattern 2: "<location> weather" - location before weather word
      if (!location) {
        const endPattern = queryLower.match(/^(.+?)\s+(?:weather|temperature|forecast)\b/);
        if (endPattern) location = endPattern[1];
      }

      // Pattern 3: "what is the weather in <location>"
      if (!location) {
        const whatPattern = queryLower.match(/what(?:'s| is| the)?\s+(?:the\s+)?(?:current\s+)?(?:weather|temperature|forecast)\s+(?:in|for|at)\s+(.+?)(?:\?|$)/i);
        if (whatPattern) location = whatPattern[1];
      }

      // Pattern 4: Implicit queries - "umbrella in <location>", "raining in <location>", etc.
      if (!location) {
        const implicitInPattern = queryLower.match(/(?:umbrella|rain|snow|cold|hot|warm|jacket|coat|wear)\s+(?:in|for|at|to)\s+(.+?)(?:\s+today|\s+tomorrow|\s+tonight|\?|$)/i);
        if (implicitInPattern) location = implicitInPattern[1];
      }

      // Pattern 5: "Is it raining in <location>?" / "Will it rain in <location>?"
      if (!location) {
        const conditionInPattern = queryLower.match(/(?:is it|will it|going to)\s+(?:be\s+)?(?:rain|snow|storm|sunny|cloudy|cold|hot|warm)(?:ing|y)?\s+(?:in|at)\s+(.+?)(?:\?|$)/i);
        if (conditionInPattern) location = conditionInPattern[1];
      }

      // Pattern 6: Location at the end - "Do I need an umbrella in Paris today?"
      if (!location) {
        const locationEndPattern = queryLower.match(/(?:in|at|to)\s+([A-Za-z][A-Za-z\s]+?)(?:\s+today|\s+tomorrow|\s+tonight|\s+this|\s+next|\?|$)/i);
        if (locationEndPattern) location = locationEndPattern[1];
      }

      // Clean up location - remove common words that aren't locations
      if (location) {
        location = location
          .replace(/\b(current|right now|today|now|like|looking|please|the|tomorrow|tonight|this|next|week|weekend)\b/gi, '')
          .replace(/[?!.,]/g, '')
          .trim();
      }

      // Default to New York if no location found
      if (!location || location.length < 2) location = 'New York';

      log('info', `Weather query detected, using wttr.in for: ${location}`);

      const weatherUrl = `https://wttr.in/${encodeURIComponent(location)}?format=j1`;
      const weatherResponse = await makeRequest(weatherUrl, {
        method: 'GET',
        headers: { 'User-Agent': 'curl/7.68.0' }
      });

      if (weatherResponse.status === 200) {
        try {
          const weatherData = JSON.parse(weatherResponse.body);
          const current = weatherData.current_condition?.[0];
          const area = weatherData.nearest_area?.[0];

          if (current) {
            const weatherInfo = {
              location: area?.areaName?.[0]?.value || location,
              region: area?.region?.[0]?.value || '',
              country: area?.country?.[0]?.value || '',
              temperature_c: current.temp_C,
              temperature_f: current.temp_F,
              feels_like_c: current.FeelsLikeC,
              feels_like_f: current.FeelsLikeF,
              humidity: current.humidity,
              description: current.weatherDesc?.[0]?.value || '',
              wind_mph: current.windspeedMiles,
              wind_kph: current.windspeedKmph,
              wind_dir: current.winddir16Point,
              visibility_km: current.visibility,
              uv_index: current.uvIndex,
              observation_time: current.observation_time
            };

            log('info', `Weather data retrieved for ${weatherInfo.location}`);
            return {
              query,
              type: 'weather',
              weather: weatherInfo,
              timestamp: new Date().toISOString()
            };
          }
        } catch (parseErr) {
          log('warn', `Failed to parse weather data: ${parseErr.message}`);
        }
      }
    }

    // Check if this is a cryptocurrency price query - use CoinGecko API
    const cryptoPatterns = [
      /\b(bitcoin|btc)\b/i,
      /\b(ethereum|eth)\b/i,
      /\b(solana|sol)\b/i,
      /\b(dogecoin|doge)\b/i,
      /\b(cardano|ada)\b/i,
      /\b(ripple|xrp)\b/i,
      /\b(litecoin|ltc)\b/i,
      /\b(polkadot|dot)\b/i
    ];
    const cryptoMap = {
      'bitcoin': 'bitcoin', 'btc': 'bitcoin',
      'ethereum': 'ethereum', 'eth': 'ethereum',
      'solana': 'solana', 'sol': 'solana',
      'dogecoin': 'dogecoin', 'doge': 'dogecoin',
      'cardano': 'cardano', 'ada': 'cardano',
      'ripple': 'ripple', 'xrp': 'ripple',
      'litecoin': 'litecoin', 'ltc': 'litecoin',
      'polkadot': 'polkadot', 'dot': 'polkadot'
    };

    const isCryptoQuery = /\b(price|worth|cost|value|trading)\b/i.test(queryLower) &&
                          cryptoPatterns.some(p => p.test(queryLower));

    if (isCryptoQuery) {
      // Find which crypto was mentioned
      let cryptoId = null;
      for (const [key, value] of Object.entries(cryptoMap)) {
        if (new RegExp(`\\b${key}\\b`, 'i').test(queryLower)) {
          cryptoId = value;
          break;
        }
      }

      if (cryptoId) {
        log('info', `Crypto price query detected for: ${cryptoId}`);

        try {
          // Use CoinGecko API (free, no auth required)
          const cryptoUrl = `https://api.coingecko.com/api/v3/simple/price?ids=${cryptoId}&vs_currencies=usd,eur,gbp&include_24hr_change=true&include_market_cap=true`;
          const cryptoResponse = await makeRequest(cryptoUrl, {
            method: 'GET',
            headers: {
              'Accept': 'application/json',
              'User-Agent': 'LLM-Gateway/1.0'
            }
          });

          if (cryptoResponse.status === 200) {
            const data = JSON.parse(cryptoResponse.body);
            const priceData = data[cryptoId];

            if (priceData) {
              const cryptoInfo = {
                name: cryptoId.charAt(0).toUpperCase() + cryptoId.slice(1),
                price_usd: priceData.usd,
                price_eur: priceData.eur,
                price_gbp: priceData.gbp,
                change_24h: priceData.usd_24h_change?.toFixed(2) + '%',
                market_cap_usd: priceData.usd_market_cap
              };

              log('info', `Crypto price retrieved for ${cryptoInfo.name}: $${cryptoInfo.price_usd}`);
              return {
                query,
                type: 'crypto_price',
                crypto: cryptoInfo,
                timestamp: new Date().toISOString()
              };
            }
          }
        } catch (err) {
          log('warn', `Failed to fetch crypto price: ${err.message}`);
        }
      }
    }

    // Check if this is a commodity/oil price query
    const commodityPatterns = {
      oil: /\b(oil|crude|brent|wti|petroleum)\b/i,
      gold: /\b(gold|xau)\b/i,
      silver: /\b(silver|xag)\b/i,
      gas: /\b(natural\s*gas)\b/i
    };

    const isCommodityQuery = /\b(price|cost|trading|worth|how much)\b/i.test(queryLower);
    let detectedCommodity = null;

    for (const [commodity, pattern] of Object.entries(commodityPatterns)) {
      if (pattern.test(queryLower) && isCommodityQuery) {
        detectedCommodity = commodity;
        break;
      }
    }

    if (detectedCommodity) {
      log('info', `Commodity price query detected for: ${detectedCommodity}`);

      // Try to fetch from metals.live for gold/silver
      if (detectedCommodity === 'gold' || detectedCommodity === 'silver') {
        try {
          const metalCode = detectedCommodity === 'gold' ? 'gold' : 'silver';
          const metalUrl = `https://api.metals.live/v1/spot/${metalCode}`;
          const metalResponse = await makeRequest(metalUrl, {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
          });

          if (metalResponse.status === 200) {
            const data = JSON.parse(metalResponse.body);
            const avgPrice = data.reduce((sum, item) => sum + parseFloat(item.price), 0) / data.length;

            return {
              query,
              type: 'commodity_price',
              commodity: {
                name: detectedCommodity.charAt(0).toUpperCase() + detectedCommodity.slice(1),
                price_usd: avgPrice.toFixed(2),
                unit: 'per troy ounce',
                sources: data.map(d => d.source).join(', ')
              },
              timestamp: new Date().toISOString()
            };
          }
        } catch (err) {
          log('warn', `Failed to fetch ${detectedCommodity} price: ${err.message}`);
        }

        // Fallback guidance for gold/silver when API fails
        const metalName = detectedCommodity.charAt(0).toUpperCase() + detectedCommodity.slice(1);
        return {
          query,
          type: 'commodity_guidance',
          commodity: detectedCommodity,
          message: `For current ${metalName} prices, please check:
- Kitco: kitco.com
- Bloomberg: bloomberg.com/markets/commodities
- Trading Economics: tradingeconomics.com/commodity/${detectedCommodity}

${metalName} is typically priced per troy ounce. Prices fluctuate based on market conditions.`,
          timestamp: new Date().toISOString()
        };
      }

      // For oil, return current market guidance (no free reliable API without auth)
      if (detectedCommodity === 'oil') {
        return {
          query,
          type: 'commodity_guidance',
          commodity: detectedCommodity,
          message: `For current crude oil prices, please check:
- Bloomberg: bloomberg.com/energy
- OilPrice.com: oilprice.com
- Trading Economics: tradingeconomics.com/commodity/crude-oil

Oil prices fluctuate daily. For real-time quotes, visit the sources above.`,
          timestamp: new Date().toISOString()
        };
      }

      // For natural gas
      if (detectedCommodity === 'gas') {
        return {
          query,
          type: 'commodity_guidance',
          commodity: detectedCommodity,
          message: `For current natural gas prices, please check:
- Bloomberg: bloomberg.com/energy
- Trading Economics: tradingeconomics.com/commodity/natural-gas
- EIA: eia.gov/naturalgas/

Natural gas prices vary by region and are quoted in $/MMBtu in the US.`,
          timestamp: new Date().toISOString()
        };
      }
    }

    // Check if this is a service status query - use isitdownrightnow.com
    const serviceMatch = queryLower.match(/(?:is\s+)?(\w+(?:\.\w+)?)\s+(?:down|up|working|online|offline|status|outage)/i) ||
                         queryLower.match(/(?:down|outage|status).*?(\w+(?:\.\w+)?)/i);
    if (serviceMatch) {
      let service = serviceMatch[1].toLowerCase();
      // Clean up common words that aren't services
      if (['the', 'a', 'an', 'is', 'are', 'it', 'right', 'now'].includes(service)) {
        service = null;
      }

      if (service) {
        // Add .com if no domain extension
        if (!service.includes('.')) {
          service = service + '.com';
        }

        log('info', `Service status query detected for: ${service}`);

        try {
          // Try isitdownrightnow.com
          const statusUrl = `https://www.isitdownrightnow.com/${service}.html`;
          const statusResponse = await makeRequest(statusUrl, {
            method: 'GET',
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Accept': 'text/html'
            }
          });

          if (statusResponse.status === 200) {
            const html = statusResponse.body;
            // Parse status from the page
            const upMatch = html.match(/class="[^"]*upicon[^"]*"|UP\s+RIGHT\s+NOW/i);
            const downMatch = html.match(/class="[^"]*downicon[^"]*"|DOWN\s+RIGHT\s+NOW/i);
            const responseTimeMatch = html.match(/Response\s+Time[^<]*<[^>]*>([^<]+)/i);

            let status = 'unknown';
            if (upMatch) status = 'up';
            else if (downMatch) status = 'down';

            const responseTime = responseTimeMatch ? responseTimeMatch[1].trim() : 'unknown';

            log('info', `Service status for ${service}: ${status}`);
            return {
              query,
              type: 'service_status',
              service: service,
              status: status,
              responseTime: responseTime,
              checkUrl: statusUrl,
              timestamp: new Date().toISOString()
            };
          }
        } catch (statusErr) {
          log('warn', `Failed to check service status: ${statusErr.message}`);
        }
      }
    }

    // For other queries, return a helpful message since DuckDuckGo blocks automated requests
    log('info', `General search query - returning guidance`);
    return {
      query,
      type: 'search',
      results: [],
      message: 'Web search is currently limited. For real-time information, please check news websites, weather services, or search engines directly.',
      timestamp: new Date().toISOString()
    };

  } catch (err) {
    log('error', `Web search error: ${err.message}`);
    return { error: err.message, results: [] };
  }
}

// Parse DuckDuckGo HTML search results
function parseDuckDuckGoResults(html) {
  const results = [];

  // Match result blocks - DuckDuckGo uses class="result__a" for links and class="result__snippet" for descriptions
  const resultPattern = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([^<]*)/gi;

  let match;
  while ((match = resultPattern.exec(html)) !== null && results.length < 5) {
    const url = match[1];
    const title = match[2].trim();
    const snippet = match[3].trim().replace(/&[^;]+;/g, ' ').replace(/\s+/g, ' ');

    if (title && snippet && !url.includes('duckduckgo.com')) {
      results.push({ title, url, snippet });
    }
  }

  // Fallback: try simpler pattern if no results
  if (results.length === 0) {
    const simplePattern = /<a[^>]*class="[^"]*result[^"]*"[^>]*href="(https?:\/\/[^"]+)"[^>]*>([^<]+)<\/a>/gi;
    while ((match = simplePattern.exec(html)) !== null && results.length < 5) {
      const url = match[1];
      const title = match[2].trim();
      if (title && !url.includes('duckduckgo.com')) {
        results.push({ title, url, snippet: '' });
      }
    }
  }

  return results;
}

// Format search results for LLM context
function formatSearchResults(searchResponse) {
  if (searchResponse.error) {
    return `Web search failed: ${searchResponse.error}`;
  }

  // Handle weather data
  if (searchResponse.type === 'weather' && searchResponse.weather) {
    const w = searchResponse.weather;
    return `Current weather data for ${w.location}${w.region ? ', ' + w.region : ''}${w.country ? ', ' + w.country : ''} (as of ${searchResponse.timestamp}):

Temperature: ${w.temperature_c}°C (${w.temperature_f}°F)
Feels like: ${w.feels_like_c}°C (${w.feels_like_f}°F)
Conditions: ${w.description}
Humidity: ${w.humidity}%
Wind: ${w.wind_mph} mph (${w.wind_kph} km/h) from ${w.wind_dir}
Visibility: ${w.visibility_km} km
UV Index: ${w.uv_index}
Observation time: ${w.observation_time} UTC`;
  }

  // Handle service status data
  if (searchResponse.type === 'service_status') {
    const statusText = searchResponse.status === 'up' ? 'UP and operational' :
                       searchResponse.status === 'down' ? 'DOWN or experiencing issues' :
                       'status unknown';
    return `Service status check for ${searchResponse.service} (as of ${searchResponse.timestamp}):

Status: ${statusText}
Response Time: ${searchResponse.responseTime}
Source: isitdownrightnow.com

Note: For the most accurate information, users can check ${searchResponse.checkUrl}`;
  }

  // Handle cryptocurrency price data
  if (searchResponse.type === 'crypto_price' && searchResponse.crypto) {
    const c = searchResponse.crypto;
    const marketCapFormatted = c.market_cap_usd
      ? `$${(c.market_cap_usd / 1e9).toFixed(2)} billion`
      : 'N/A';
    return `Current price for ${c.name} (as of ${searchResponse.timestamp}):

Price (USD): $${c.price_usd?.toLocaleString() || 'N/A'}
Price (EUR): €${c.price_eur?.toLocaleString() || 'N/A'}
Price (GBP): £${c.price_gbp?.toLocaleString() || 'N/A'}
24h Change: ${c.change_24h || 'N/A'}
Market Cap: ${marketCapFormatted}
Source: CoinGecko`;
  }

  // Handle commodity price data (gold, silver)
  if (searchResponse.type === 'commodity_price' && searchResponse.commodity) {
    const c = searchResponse.commodity;
    return `Current ${c.name} price (as of ${searchResponse.timestamp}):

Price: $${c.price_usd} ${c.unit}
Sources: ${c.sources}`;
  }

  // Handle commodity guidance (oil, natural gas - no free API)
  if (searchResponse.type === 'commodity_guidance') {
    return searchResponse.message;
  }

  // Handle search message (when DuckDuckGo is blocked)
  if (searchResponse.message) {
    return searchResponse.message;
  }

  if (!searchResponse.results || searchResponse.results.length === 0) {
    return `No search results found for "${searchResponse.query}"`;
  }

  let formatted = `Web search results for "${searchResponse.query}" (${searchResponse.timestamp}):\n\n`;

  for (let i = 0; i < searchResponse.results.length; i++) {
    const r = searchResponse.results[i];
    formatted += `${i + 1}. ${r.title}\n`;
    if (r.snippet) formatted += `   ${r.snippet}\n`;
    formatted += `   URL: ${r.url}\n\n`;
  }

  return formatted;
}

// Detect if model response indicates it needs real-time data
// Returns the topic to search for, or null if no search needed
function detectNeedsWebSearch(responseContent) {
  if (!responseContent) return null;

  const content = responseContent.toLowerCase();

  // Patterns that indicate the model couldn't provide current info
  const needsSearchPatterns = [
    { pattern: /i don'?t have (?:access to )?real[- ]?time/i, extract: true },
    { pattern: /i can'?t (?:access|provide|check) (?:real[- ]?time|current|live)/i, extract: true },
    { pattern: /my (?:knowledge|training|data) (?:cutoff|cut-off|ends)/i, extract: true },
    { pattern: /as of my (?:last|knowledge) (?:update|cutoff)/i, extract: true },
    { pattern: /i (?:don'?t|cannot) (?:browse|search|access) the (?:internet|web)/i, extract: true },
    { pattern: /for (?:the )?(?:most )?(?:current|up[- ]?to[- ]?date|latest|real[- ]?time) (?:info|information|data)/i, extract: true },
    { pattern: /(?:check|visit|use) (?:a )?(?:weather|news|status) (?:website|service|app)/i, extract: true },
    { pattern: /i (?:recommend|suggest) (?:checking|visiting|using)/i, extract: true },
    { pattern: /unable to (?:provide|give|access) (?:current|real[- ]?time|live)/i, extract: true }
  ];

  for (const { pattern } of needsSearchPatterns) {
    if (pattern.test(content)) {
      // Try to extract what they were asking about from the response
      // Look for references to specific topics
      const topicPatterns = [
        /(?:weather|temperature|forecast)\s+(?:in|for|at)\s+([a-z\s]+?)(?:\.|,|$)/i,
        /(?:status|outage|down)\s+(?:of|for)?\s*([a-z.]+?)(?:\.|,|$)/i,
        /(?:current|latest|live)\s+([a-z\s]+?)(?:\s+(?:info|information|data|updates?))?(?:\.|,|$)/i,
        /(?:check|visit)\s+(?:the\s+)?([a-z]+?)(?:\s+(?:website|status|page))?(?:\.|,|$)/i
      ];

      for (const topicPattern of topicPatterns) {
        const match = responseContent.match(topicPattern);
        if (match && match[1]) {
          return match[1].trim();
        }
      }

      // Generic fallback - return true but without specific topic
      return 'current information';
    }
  }

  return null;
}

// Execute a tool call and return results
async function executeToolCall(toolCall) {
  const name = toolCall.function?.name || toolCall.name;
  let args = {};

  try {
    args = typeof toolCall.function?.arguments === 'string'
      ? JSON.parse(toolCall.function.arguments)
      : (toolCall.function?.arguments || toolCall.arguments || {});
  } catch (e) {
    log('warn', `Failed to parse tool arguments: ${e.message}`);
  }

  log('info', `Executing tool: ${name}`, args);

  switch (name) {
    case 'web_search':
      const searchResults = await performWebSearch(args.query);
      return formatSearchResults(searchResults);
    default:
      return `Unknown tool: ${name}`;
  }
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

  // Convert tools from Responses API format to Chat Completions format
  // Responses API: {"type":"function","name":"x","description":"...","parameters":{}}
  // Chat Completions: {"type":"function","function":{"name":"x","description":"...","parameters":{}}}
  let convertedTools = undefined;
  if (parsed.tools && Array.isArray(parsed.tools)) {
    convertedTools = parsed.tools.map(tool => {
      // If already in Chat Completions format (has function.name), pass through
      if (tool.function?.name) {
        return tool;
      }
      // Convert from Responses API format (name at top level)
      if (tool.name) {
        return {
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters || { type: 'object', properties: {} }
          }
        };
      }
      return tool;
    });
  }

  return {
    model: parsed.model || 'llama-4-scout',
    messages: messages,
    max_tokens: parsed.max_output_tokens || parsed.max_tokens || 4096,
    temperature: parsed.temperature,
    top_p: parsed.top_p,
    // Preserve stream setting from original request (defaults to true for format conversion)
    stream: parsed.stream !== false,
    stop: parsed.stop,
    // Pass through converted tools if present
    tools: convertedTools,
    tool_choice: parsed.tool_choice
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

    // Track tokens from streaming state
    const backend = requestLog.destination;
    const tokens = {
      input: streamState.usage?.input_tokens || 0,
      output: streamState.usage?.output_tokens || 0,
      total: (streamState.usage?.input_tokens || 0) + (streamState.usage?.output_tokens || 0)
    };
    requestLog.tokens = tokens;

    // Update global metrics
    if (tokens.input > 0 || tokens.output > 0) {
      metrics.tokens_input_total += tokens.input;
      metrics.tokens_output_total += tokens.output;
      if (!metrics.tokens_by_backend[backend]) {
        metrics.tokens_by_backend[backend] = { input: 0, output: 0 };
      }
      metrics.tokens_by_backend[backend].input += tokens.input;
      metrics.tokens_by_backend[backend].output += tokens.output;
    }

    addRequestLog(requestLog);

    log('info', `Streaming request completed: ${requestLog.destination} ${proxyRes.status} ${requestLog.timing.totalMs}ms (model: ${streamState.model || 'unknown'})`, {
      requestId: requestLog.id,
      backend: requestLog.destination,
      model: streamState.model || 'unknown',
      converted: needsConversion,
      tokens: tokens
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

    // Check if request already has tools defined (e.g., from Clawdbot)
    // If so, skip realtime detection to avoid routing issues with large requests
    const requestAlreadyHasTools = parsedRequestBody.tools && parsedRequestBody.tools.length > 0;

    if (config.smartRouter?.enabled && messages.length > 0) {
      // Use smart router (but skip realtime detection if tools already present)
      const classification = await classifyQuery(messages, userId, requestAlreadyHasTools);

      if (classification) {
        // Estimate context length
        const contextLength = JSON.stringify(messages).length / 4; // Rough token estimate

        routingDecision = getRoutingRecommendation(classification, contextLength, userId);
        backend = routingDecision.backend;

        // Route requests with tools to Anthropic (Claude actually uses tools reliably)
        // Local models often ignore tool definitions
        if (requestAlreadyHasTools && backend !== 'anthropic') {
          log('info', `Routing to Anthropic - request has ${parsedRequestBody.tools.length} tools`, { requestId });
          backend = 'anthropic';
          routingDecision.backend = 'anthropic';
          routingDecision.reason = 'tools present - routing to Anthropic';
          routingDecision.toolsRouted = true;
        }

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

    // Check if this is a realtime query that needs web search tool injection
    const isRealtimeQuery = routingDecision?.classification?.category === 'realtime';
    // For local backends, assume tool support if model name is generic or matches known tool-capable models
    // All our local backends run models that support tool calling (Llama, Qwen, etc.)
    const modelSupportsTools = isLocalBackend || supportsToolCalling(modelName);
    let injectedWebSearchTool = false;

    // Skip web_search injection if request already has tools defined
    // (e.g., Clawdbot already provides its own web_search tool)
    const requestHasTools = parsedBody.tools && parsedBody.tools.length > 0;

    if (isRealtimeQuery && isLocalBackend && !requestHasTools) {
      // Inject web_search tool into the request for local models (only if no tools present)
      if (!parsedBody.tools) {
        parsedBody.tools = [];
      }
      // Add web_search tool if not already present
      if (!parsedBody.tools.some(t => t.function?.name === 'web_search')) {
        parsedBody.tools.push(WEB_SEARCH_TOOL);
        injectedWebSearchTool = true;
        requestLog.webSearchToolInjected = true;
        log('info', `Injected web_search tool for realtime query`, { requestId, model: modelName });

        // Force non-streaming for realtime queries so we can handle tool calls
        // Tool call interception requires full response parsing
        if (parsedBody.stream) {
          parsedBody.stream = false;
          requestLog.streamingDisabledForToolCall = true;
          log('debug', `Disabled streaming for tool call handling`, { requestId });
        }
      }

      // Add tool instructions to system message for tool-capable models
      if (parsedBody.messages) {
        const toolPrompt = isHermes
          ? formatToolsForHermes([WEB_SEARCH_TOOL])
          : '\n\nYou have access to a web_search tool. When the user asks about current events, weather, news, stock prices, or anything requiring up-to-date information, you MUST use the web_search tool by including a tool_call in your response. Call the tool with the appropriate search query.';

        const systemIdx = parsedBody.messages.findIndex(m => m.role === 'system');
        if (systemIdx >= 0) {
          parsedBody.messages[systemIdx].content += toolPrompt;
        } else {
          parsedBody.messages.unshift({
            role: 'system',
            content: 'You are a helpful assistant.' + toolPrompt
          });
        }
      }

      // Update body and requestBody with injected tools
      body = JSON.stringify(parsedBody);
      requestBody = body;  // Also update requestBody since it was set before tool injection
    }

    // Convert formats if needed
    if (isResponsesAPI && isLocalBackend) {
      // OpenAI Responses API -> Chat Completions conversion
      requestBody = JSON.stringify(responsesToChatCompletions(body, isHermes));
      targetPath = '/v1/chat/completions';  // Redirect to chat completions endpoint
      requestLog.formatConversion = isHermes ? 'responses-to-chat-completions-hermes' : 'responses-to-chat-completions';
      needsResponseConversion = true;
      log('debug', `Converting Responses API to Chat Completions${isHermes ? ' (Hermes mode)' : ''}`, { requestId });
    } else if (isResponsesAPI && backend === 'anthropic') {
      // OpenAI Responses API -> Anthropic conversion
      // First convert to Chat Completions, then to Anthropic
      const chatCompletions = responsesToChatCompletions(body, false);
      requestBody = JSON.stringify(openAIToAnthropic(JSON.stringify(chatCompletions)));
      targetPath = '/v1/messages';
      requestLog.formatConversion = 'responses-to-anthropic';
      needsResponseConversion = true;
      log('debug', 'Converting Responses API to Anthropic format', { requestId });
    } else if (isAnthropicFormat && isLocalBackend) {
      // Anthropic -> OpenAI conversion
      requestBody = JSON.stringify(anthropicToOpenAI(body));
      requestLog.formatConversion = 'anthropic-to-openai';
      log('debug', 'Converting Anthropic format to OpenAI', { requestId });
    } else if (!isAnthropicFormat && !isResponsesAPI && backend === 'anthropic') {
      // OpenAI -> Anthropic conversion
      requestBody = JSON.stringify(openAIToAnthropic(body));
      targetPath = '/v1/messages';  // Anthropic uses /v1/messages endpoint
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

    // Handle tool calls if we injected web_search tool and got a successful response
    if (injectedWebSearchTool && proxyResponse.status === 200 && !isStreaming) {
      try {
        const responseParsed = JSON.parse(responseBody);
        let toolCalls = [];
        let contentBeforeToolCall = '';

        // Check for OpenAI-style tool calls
        const choice = responseParsed.choices?.[0];
        if (choice?.message?.tool_calls && choice.message.tool_calls.length > 0) {
          toolCalls = choice.message.tool_calls;
          contentBeforeToolCall = choice.message.content || '';
        }
        // Check for Hermes-style tool calls in content
        else if (choice?.message?.content) {
          const hermesResult = parseHermesToolCalls(choice.message.content);
          if (hermesResult.toolCalls.length > 0) {
            toolCalls = hermesResult.toolCalls;
            contentBeforeToolCall = hermesResult.cleanContent;
          }
        }

        // Execute tool calls and continue conversation
        if (toolCalls.length > 0) {
          log('info', `Detected ${toolCalls.length} tool call(s), executing...`, { requestId });
          requestLog.toolCallsDetected = toolCalls.map(tc => tc.function?.name);

          const toolResults = [];
          for (const tc of toolCalls) {
            const result = await executeToolCall(tc);
            toolResults.push({
              tool_call_id: tc.id,
              role: 'tool',
              content: result
            });
          }

          // Build follow-up request with tool results
          const followUpMessages = [
            ...(parsedBody.messages || []),
            {
              role: 'assistant',
              content: contentBeforeToolCall || null,
              tool_calls: toolCalls
            },
            ...toolResults
          ];

          // Remove tools from follow-up to prevent model from making more tool calls
          // The model should use the tool results to generate a final response
          const { tools: _, tool_choice: __, ...restOfParsedBody } = parsedBody;
          const followUpBody = {
            ...restOfParsedBody,
            messages: followUpMessages
          };

          log('info', `Making follow-up request with tool results`, { requestId });

          // Make follow-up request
          const followUpResponse = await makeRequest(targetUrl, {
            method: 'POST',
            headers: requestHeaders
          }, JSON.stringify(followUpBody), false);

          if (followUpResponse.status === 200) {
            responseBody = followUpResponse.body;
            requestLog.toolCallFollowUp = true;
            log('info', `Tool call follow-up completed`, { requestId });
          } else {
            log('warn', `Tool call follow-up failed: ${followUpResponse.status}`, { requestId });
          }
        }
      } catch (e) {
        log('warn', `Tool call handling error: ${e.message}`, { requestId });
      }
    }

    // Smart retry: If model indicates it needs real-time data and we haven't already done web search
    if (!injectedWebSearchTool && proxyResponse.status === 200 && !isStreaming && isLocalBackend) {
      try {
        const responseParsed = JSON.parse(responseBody);
        const modelContent = responseParsed.choices?.[0]?.message?.content || '';

        const searchTopic = detectNeedsWebSearch(modelContent);
        if (searchTopic) {
          log('info', `Model indicated need for real-time data, auto-searching for: "${searchTopic}"`, { requestId });
          requestLog.autoSearchTriggered = true;
          requestLog.autoSearchTopic = searchTopic;

          // Extract original user question for better search context
          const userQuestion = parsedBody.messages?.filter(m => m.role === 'user').pop()?.content || searchTopic;
          const searchQuery = typeof userQuestion === 'string' ? userQuestion : searchTopic;

          // Perform web search
          const searchResults = await performWebSearch(searchQuery);
          const formattedResults = formatSearchResults(searchResults);

          // Build follow-up request with search results
          const searchFollowUpMessages = [
            ...(parsedBody.messages || []),
            {
              role: 'assistant',
              content: modelContent
            },
            {
              role: 'user',
              content: `Here is current information from a web search that might help:\n\n${formattedResults}\n\nBased on this information, please provide an updated answer to the original question.`
            }
          ];

          const searchFollowUpBody = {
            ...parsedBody,
            messages: searchFollowUpMessages
          };

          log('info', `Making auto-search follow-up request`, { requestId });

          const searchFollowUpResponse = await makeRequest(targetUrl, {
            method: 'POST',
            headers: requestHeaders
          }, JSON.stringify(searchFollowUpBody), false);

          if (searchFollowUpResponse.status === 200) {
            responseBody = searchFollowUpResponse.body;
            requestLog.autoSearchFollowUp = true;
            log('info', `Auto-search follow-up completed successfully`, { requestId });
          } else {
            log('warn', `Auto-search follow-up failed: ${searchFollowUpResponse.status}`, { requestId });
          }
        }
      } catch (e) {
        log('warn', `Auto-search handling error: ${e.message}`, { requestId });
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

    // Extract and track tokens from response
    requestLog.tokens = extractAndTrackTokens(responseBody, backend);

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

// ============================================================================
// MongoDB History Endpoints
// ============================================================================

// Debug endpoint: Query stored request history
// GET /debug/history?limit=50&backend=anthropic&from=2026-01-01&to=2026-02-01&userId=clawdbot&category=realtime
async function handleDebugHistory(req, res, query) {
  if (!db) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Storage not enabled', logs: [] }));
    return;
  }

  try {
    const limit = Math.min(parseInt(query.get('limit')) || 50, 500);
    const filter = {};

    if (query.get('backend')) {
      filter['routing.backend'] = query.get('backend');
    }
    if (query.get('userId')) {
      filter.userId = query.get('userId');
    }
    if (query.get('category')) {
      filter['routing.classification.category'] = query.get('category');
    }
    if (query.get('from') || query.get('to')) {
      filter.timestamp = {};
      if (query.get('from')) {
        filter.timestamp.$gte = new Date(query.get('from'));
      }
      if (query.get('to')) {
        filter.timestamp.$lte = new Date(query.get('to'));
      }
    }

    const logs = await db.collection(config.storage.collection)
      .find(filter)
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ total: logs.length, logs }, null, 2));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

// Debug endpoint: Get single request by ID
// GET /debug/history/:requestId
async function handleDebugHistoryById(req, res, requestId) {
  if (!db) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Storage not enabled' }));
    return;
  }

  try {
    const doc = await db.collection(config.storage.collection)
      .findOne({ requestId: requestId });

    if (!doc) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(doc, null, 2));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

// Debug endpoint: Aggregated analytics
// GET /debug/analytics?days=7
async function handleDebugAnalytics(req, res, query) {
  if (!db) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Storage not enabled' }));
    return;
  }

  try {
    const days = parseInt(query.get('days')) || 7;
    const since = new Date(Date.now() - days * 86400000);

    const pipeline = [
      { $match: { timestamp: { $gte: since } } },
      {
        $group: {
          _id: {
            backend: '$routing.backend',
            day: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } }
          },
          count: { $sum: 1 },
          tokens: { $sum: '$tokens.total' },
          avgLatency: { $avg: '$timing.totalMs' },
          errors: { $sum: { $cond: [{ $ne: ['$error', null] }, 1, 0] } }
        }
      },
      { $sort: { '_id.day': 1, '_id.backend': 1 } }
    ];

    const results = await db.collection(config.storage.collection)
      .aggregate(pipeline).toArray();

    // Also get category breakdown
    const categoryPipeline = [
      { $match: { timestamp: { $gte: since } } },
      {
        $group: {
          _id: '$routing.classification.category',
          count: { $sum: 1 }
        }
      }
    ];

    const categories = await db.collection(config.storage.collection)
      .aggregate(categoryPipeline).toArray();

    // Get total count
    const totalCount = await db.collection(config.storage.collection)
      .countDocuments({ timestamp: { $gte: since } });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      period: `${days} days`,
      since: since.toISOString(),
      totalRequests: totalCount,
      byBackendAndDay: results,
      byCategory: categories
    }, null, 2));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

// Debug endpoint: Token usage statistics
function handleDebugTokens(req, res) {
  const logs = requestLogs.slice(0, 1000);
  const now = Date.now();

  // Aggregate token stats
  const tokenStats = {
    total: {
      input: metrics.tokens_input_total,
      output: metrics.tokens_output_total,
      combined: metrics.tokens_input_total + metrics.tokens_output_total
    },
    byBackend: {},
    byHour: [],      // Last 24 hours
    byCategory: {},
    recent: []       // Last 10 requests with tokens
  };

  // Copy per-backend token totals from metrics
  for (const [backend, tokens] of Object.entries(metrics.tokens_by_backend)) {
    tokenStats.byBackend[backend] = {
      input: tokens.input,
      output: tokens.output,
      total: tokens.input + tokens.output
    };
  }

  // Calculate tokens by hour (last 24 hours)
  const hoursAgo = new Array(24).fill(null).map((_, i) => ({
    hour: new Date(now - (23 - i) * 3600000).toISOString().slice(0, 13) + ':00',
    input: 0,
    output: 0,
    total: 0,
    requests: 0
  }));

  for (const log of logs) {
    const logTime = new Date(log.timestamp).getTime();
    const hoursBack = Math.floor((now - logTime) / 3600000);

    if (hoursBack >= 0 && hoursBack < 24) {
      const hourIndex = 23 - hoursBack;
      const tokens = log.tokens || { input: 0, output: 0 };
      hoursAgo[hourIndex].input += tokens.input || 0;
      hoursAgo[hourIndex].output += tokens.output || 0;
      hoursAgo[hourIndex].total += (tokens.input || 0) + (tokens.output || 0);
      hoursAgo[hourIndex].requests++;
    }

    // Aggregate by category
    const category = log.smartRouting?.classification?.category || 'unclassified';
    if (!tokenStats.byCategory[category]) {
      tokenStats.byCategory[category] = { input: 0, output: 0, total: 0, requests: 0 };
    }
    const catTokens = log.tokens || { input: 0, output: 0 };
    tokenStats.byCategory[category].input += catTokens.input || 0;
    tokenStats.byCategory[category].output += catTokens.output || 0;
    tokenStats.byCategory[category].total += (catTokens.input || 0) + (catTokens.output || 0);
    tokenStats.byCategory[category].requests++;
  }

  tokenStats.byHour = hoursAgo;

  // Get recent requests with non-zero tokens
  tokenStats.recent = logs
    .filter(l => l.tokens && (l.tokens.input > 0 || l.tokens.output > 0))
    .slice(0, 10)
    .map(l => ({
      timestamp: l.timestamp,
      backend: l.destination,
      category: l.smartRouting?.classification?.category,
      input: l.tokens.input,
      output: l.tokens.output,
      total: l.tokens.total
    }));

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(tokenStats, null, 2));
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

    if (pathname === '/debug/tokens') {
      handleDebugTokens(req, res);
      return;
    }

    // MongoDB history endpoints
    if (pathname === '/debug/history') {
      await handleDebugHistory(req, res, query);
      return;
    }

    if (pathname.startsWith('/debug/history/')) {
      const requestId = pathname.replace('/debug/history/', '');
      await handleDebugHistoryById(req, res, requestId);
      return;
    }

    if (pathname === '/debug/analytics') {
      await handleDebugAnalytics(req, res, query);
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
        storage: {
          enabled: config.storage?.enabled || false,
          database: config.storage?.database
        },
        endpoints: {
          proxy: '/v1/chat/completions, /v1/messages, /v1/responses',
          debug: '/debug/logs, /debug/health, /debug/compare, /debug/config, /debug/router, /debug/models, /debug/switch, /debug/stats, /debug/tokens',
          history: '/debug/history, /debug/history/:id, /debug/analytics',
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
    output += '\n';

    output += '# HELP llm_proxy_tokens_input_total Total input tokens processed\n';
    output += '# TYPE llm_proxy_tokens_input_total counter\n';
    output += `llm_proxy_tokens_input_total ${metrics.tokens_input_total}\n\n`;

    output += '# HELP llm_proxy_tokens_output_total Total output tokens generated\n';
    output += '# TYPE llm_proxy_tokens_output_total counter\n';
    output += `llm_proxy_tokens_output_total ${metrics.tokens_output_total}\n\n`;

    output += '# HELP llm_proxy_tokens_by_backend_input Input tokens by backend\n';
    output += '# TYPE llm_proxy_tokens_by_backend_input counter\n';
    for (const [backend, tokens] of Object.entries(metrics.tokens_by_backend)) {
      output += `llm_proxy_tokens_by_backend_input{backend="${backend}"} ${tokens.input}\n`;
    }
    output += '\n';

    output += '# HELP llm_proxy_tokens_by_backend_output Output tokens by backend\n';
    output += '# TYPE llm_proxy_tokens_by_backend_output counter\n';
    for (const [backend, tokens] of Object.entries(metrics.tokens_by_backend)) {
      output += `llm_proxy_tokens_by_backend_output{backend="${backend}"} ${tokens.output}\n`;
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

// Connect to MongoDB (async, non-blocking startup)
connectMongoDB().then(() => {
  if (config.storage?.enabled) {
    log('info', `MongoDB storage: enabled (${config.storage.database})`);
  }
}).catch(err => {
  log('warn', `MongoDB connection failed: ${err.message}`);
});

server.listen(PROXY_PORT, '0.0.0.0', () => {
  log('info', `LLM Debug Proxy listening on port ${PROXY_PORT}`);
  log('info', `Mode: ${config.mode}`);
  log('info', `Backends: ${Object.keys(config.backends).join(', ')}`);
  log('info', `Default backend: ${config.defaultBackend}`);
  log('info', `Smart router: ${config.smartRouter?.enabled ? 'enabled' : 'disabled'}`);
  log('info', `Storage: ${config.storage?.enabled ? 'enabled' : 'disabled'}`);
  log('info', `Anthropic API key: ${ANTHROPIC_API_KEY ? 'set' : 'not set'}`);
});

metricsServer.listen(METRICS_PORT, '0.0.0.0', () => {
  log('info', `Prometheus metrics on port ${METRICS_PORT}`);
});

// Graceful shutdown
async function shutdown(signal) {
  log('info', `Received ${signal}, shutting down...`);
  await disconnectMongoDB();
  server.close(() => {
    metricsServer.close(() => {
      process.exit(0);
    });
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

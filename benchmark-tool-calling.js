#!/usr/bin/env node
/**
 * Tool Calling Benchmark Script
 *
 * Tests local LLM models for proper tool/function calling behavior.
 * Focuses on weather, news, and financial queries that require web search.
 *
 * Usage:
 *   node benchmark-tool-calling.js [options]
 *
 * Options:
 *   --model NAME       Model name for output file
 *   --gateway URL      Gateway URL (default: http://localhost:28080)
 *   --limit N          Limit prompts per category (default: 10)
 *   --timeout MS       Request timeout (default: 90000)
 *   --output FILE      Output file (default: auto-generated)
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ANSI colors
const col = (c, t) => {
  const codes = { reset: 0, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, white: 37, dim: 90 };
  return `\x1b[${codes[c] || 0}m${t}\x1b[0m`;
};

// Tool-calling focused prompts - these SHOULD trigger tool use
const TOOL_PROMPTS = {
  weather: [
    { text: "What's the weather like in New York City right now?", expectsTool: 'web_search' },
    { text: "Will it rain in London tomorrow?", expectsTool: 'web_search' },
    { text: "What's the current temperature in Tokyo?", expectsTool: 'web_search' },
    { text: "Do I need an umbrella today in Seattle?", expectsTool: 'web_search' },
    { text: "What's the weather forecast for Paris this weekend?", expectsTool: 'web_search' },
    { text: "Is it going to snow in Chicago?", expectsTool: 'web_search' },
    { text: "What's the UV index in Miami today?", expectsTool: 'web_search' },
    { text: "Current weather conditions in Sydney?", expectsTool: 'web_search' },
    { text: "What should I wear for the weather in Berlin today?", expectsTool: 'web_search' },
    { text: "Is it hot or cold in Dubai right now?", expectsTool: 'web_search' },
    { text: "What's the humidity in Singapore today?", expectsTool: 'web_search' },
    { text: "Weather alert for my area?", expectsTool: 'web_search' },
  ],
  news: [
    { text: "What's happening in the news today?", expectsTool: 'web_search' },
    { text: "Latest headlines from Europe", expectsTool: 'web_search' },
    { text: "What's the latest tech news?", expectsTool: 'web_search' },
    { text: "Any breaking news right now?", expectsTool: 'web_search' },
    { text: "What's going on in the world today?", expectsTool: 'web_search' },
    { text: "Top stories in sports", expectsTool: 'web_search' },
    { text: "Latest news about AI", expectsTool: 'web_search' },
    { text: "What happened in politics today?", expectsTool: 'web_search' },
    { text: "Current events summary", expectsTool: 'web_search' },
    { text: "News from Asia today", expectsTool: 'web_search' },
    { text: "What's trending right now?", expectsTool: 'web_search' },
    { text: "Latest science discoveries", expectsTool: 'web_search' },
  ],
  financial: [
    { text: "What is the current price of Bitcoin?", expectsTool: 'web_search' },
    { text: "How is the stock market doing today?", expectsTool: 'web_search' },
    { text: "What's Apple's stock price?", expectsTool: 'web_search' },
    { text: "Current price of gold?", expectsTool: 'web_search' },
    { text: "What's the EUR/USD exchange rate?", expectsTool: 'web_search' },
    { text: "How is Tesla stock performing?", expectsTool: 'web_search' },
    { text: "What's the price of Ethereum?", expectsTool: 'web_search' },
    { text: "S&P 500 current level?", expectsTool: 'web_search' },
    { text: "What's the oil price today?", expectsTool: 'web_search' },
    { text: "Crypto market update", expectsTool: 'web_search' },
    { text: "Is the market up or down today?", expectsTool: 'web_search' },
    { text: "Current silver price per ounce", expectsTool: 'web_search' },
  ],
  // Control group - these should NOT require tools
  no_tools: [
    { text: "Hello, how are you?", expectsTool: null },
    { text: "What is 2 + 2?", expectsTool: null },
    { text: "Tell me a joke", expectsTool: null },
    { text: "What is the capital of France?", expectsTool: null },
    { text: "Explain what recursion is", expectsTool: null },
    { text: "Write a haiku about coding", expectsTool: null },
    { text: "What does HTTP stand for?", expectsTool: null },
    { text: "How do I make coffee?", expectsTool: null },
  ]
};

// Configuration
const config = {
  gateway: 'http://localhost:28080',
  model: 'unknown',
  limitPerCategory: 10,
  timeout: 90000,
  output: null,
};

// Parse arguments
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  const next = args[i + 1];
  if (arg === '--gateway' || arg === '-g') { config.gateway = next; i++; }
  else if (arg === '--model' || arg === '-m') { config.model = next; i++; }
  else if (arg === '--limit' || arg === '-l') { config.limitPerCategory = parseInt(next); i++; }
  else if (arg === '--timeout' || arg === '-t') { config.timeout = parseInt(next); i++; }
  else if (arg === '--output' || arg === '-o') { config.output = next; i++; }
  else if (arg === '--help' || arg === '-h') {
    console.log(`
Tool Calling Benchmark Script

Usage: node benchmark-tool-calling.js [options]

Options:
  -m, --model NAME     Model name for output file
  -g, --gateway URL    Gateway URL (default: http://localhost:28080)
  -l, --limit N        Prompts per category (default: 10)
  -t, --timeout MS     Request timeout (default: 90000)
  -o, --output FILE    Output file path
  -h, --help           Show this help

Categories tested:
  - weather:   Real-time weather queries (should use web_search)
  - news:      Current events queries (should use web_search)
  - financial: Stock/crypto prices (should use web_search)
  - no_tools:  Control group (should NOT use tools)
`);
    process.exit(0);
  }
}

// Generate output filename
if (!config.output) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  config.output = path.join(__dirname, 'benchmark-results', `tool-calling-${config.model}-${timestamp}.json`);
}

// Make HTTP request
function makeRequest(prompt) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const url = new URL(config.gateway);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;

    const payload = JSON.stringify({
      model: 'test',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1024,
    });

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: config.timeout,
    };

    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const duration = Date.now() - startTime;
        try {
          const json = JSON.parse(data);
          const content = json.choices?.[0]?.message?.content || '';
          const toolCalls = json.choices?.[0]?.message?.tool_calls || [];

          resolve({
            success: true,
            duration,
            status: res.statusCode,
            content,
            toolCalls,
            rawResponse: json,
          });
        } catch (e) {
          resolve({
            success: false,
            duration,
            status: res.statusCode,
            error: 'JSON parse error',
            rawData: data.substring(0, 500),
          });
        }
      });
    });

    req.on('error', (e) => {
      resolve({
        success: false,
        duration: Date.now() - startTime,
        error: e.message,
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({
        success: false,
        duration: config.timeout,
        error: 'timeout',
      });
    });

    req.write(payload);
    req.end();
  });
}

// Analyze response for tool usage
function analyzeToolUsage(response, expectedTool) {
  const result = {
    usedTool: false,
    toolName: null,
    leakedToolJSON: false,
    correctBehavior: false,
  };

  if (!response.success) {
    return result;
  }

  const content = response.content || '';

  // Check for actual tool calls in response
  if (response.toolCalls && response.toolCalls.length > 0) {
    result.usedTool = true;
    result.toolName = response.toolCalls[0].function?.name || response.toolCalls[0].name;
  }

  // Check for leaked tool call JSON in content (bad behavior)
  const leakPatterns = [
    /\{"name":\s*"web_search"/i,
    /\{"tool":\s*"web_search"/i,
    /"function":\s*\{/,
    /tool_calls?\s*[:=]/i,
    /\{"name":\s*"\w+",\s*"parameters"/,
    /<tool_call>/,
    /```json\s*\{\s*"name"/,
  ];

  for (const pattern of leakPatterns) {
    if (pattern.test(content)) {
      result.leakedToolJSON = true;
      break;
    }
  }

  // Determine if behavior was correct
  if (expectedTool) {
    // Should have used a tool
    result.correctBehavior = result.usedTool && !result.leakedToolJSON;
  } else {
    // Should NOT have used a tool
    result.correctBehavior = !result.usedTool && !result.leakedToolJSON;
  }

  // Check if response contains real-time data (indicates tool was used successfully)
  const realtimeIndicators = [
    /currently|right now|at the moment/i,
    /\$\d+[\d,.]*|\d+[\d,.]*\s*(USD|EUR|GBP)/,
    /\d+°[CF]|\d+\s*degrees/,
    /breaking|just (in|announced)|today's/i,
  ];

  result.hasRealtimeData = realtimeIndicators.some(p => p.test(content));

  return result;
}

// Progress bar
function progressBar(current, total, width = 30) {
  const pct = current / total;
  const filled = Math.round(width * pct);
  const empty = width - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${current}/${total}`;
}

// Main
async function main() {
  console.log(`
${col('cyan', '╔════════════════════════════════════════════════════════════════╗')}
${col('cyan', '║')}          ${col('white', 'TOOL CALLING BENCHMARK')}                            ${col('cyan', '║')}
${col('cyan', '╚════════════════════════════════════════════════════════════════╝')}

  Gateway:    ${col('white', config.gateway)}
  Model:      ${col('white', config.model)}
  Limit:      ${col('white', config.limitPerCategory)} per category
  Timeout:    ${col('white', config.timeout)}ms
  Output:     ${col('dim', config.output)}
`);

  const results = {
    config: {
      gateway: config.gateway,
      model: config.model,
      timestamp: new Date().toISOString(),
      limitPerCategory: config.limitPerCategory,
    },
    summary: {
      total: 0,
      toolRequired: { correct: 0, total: 0 },
      noToolRequired: { correct: 0, total: 0 },
      toolLeaks: 0,
      avgLatency: 0,
      byCategory: {},
    },
    results: [],
  };

  let totalLatency = 0;
  let totalCount = 0;

  // Process each category
  for (const [category, prompts] of Object.entries(TOOL_PROMPTS)) {
    const categoryPrompts = prompts.slice(0, config.limitPerCategory);
    const categoryResults = {
      total: categoryPrompts.length,
      correct: 0,
      toolLeaks: 0,
      avgLatency: 0,
    };

    console.log(`\n${col('yellow', `▶ ${category.toUpperCase()}`)} (${categoryPrompts.length} prompts)`);

    let categoryLatency = 0;

    for (let i = 0; i < categoryPrompts.length; i++) {
      const prompt = categoryPrompts[i];
      process.stdout.write(`  ${progressBar(i + 1, categoryPrompts.length)} ${col('dim', prompt.text.substring(0, 35))}...`.padEnd(80) + '\r');

      const response = await makeRequest(prompt.text);
      const analysis = analyzeToolUsage(response, prompt.expectsTool);

      const result = {
        category,
        prompt: prompt.text,
        expectsTool: prompt.expectsTool,
        response: {
          success: response.success,
          duration: response.duration,
          content: response.content?.substring(0, 500),
          toolCalls: response.toolCalls,
        },
        analysis,
      };

      results.results.push(result);

      // Update stats
      if (analysis.correctBehavior) {
        categoryResults.correct++;
        if (prompt.expectsTool) {
          results.summary.toolRequired.correct++;
        } else {
          results.summary.noToolRequired.correct++;
        }
      }

      if (analysis.leakedToolJSON) {
        categoryResults.toolLeaks++;
        results.summary.toolLeaks++;
      }

      if (prompt.expectsTool) {
        results.summary.toolRequired.total++;
      } else {
        results.summary.noToolRequired.total++;
      }

      categoryLatency += response.duration || 0;
      totalLatency += response.duration || 0;
      totalCount++;

      // Small delay between requests
      await new Promise(r => setTimeout(r, 500));
    }

    categoryResults.avgLatency = Math.round(categoryLatency / categoryPrompts.length);
    results.summary.byCategory[category] = categoryResults;

    // Print category summary
    const correctPct = ((categoryResults.correct / categoryResults.total) * 100).toFixed(0);
    const color = categoryResults.correct === categoryResults.total ? 'green' :
                  categoryResults.correct > categoryResults.total / 2 ? 'yellow' : 'red';

    console.log(`  ${progressBar(categoryPrompts.length, categoryPrompts.length)} ${col(color, `${correctPct}% correct`)} (${categoryResults.correct}/${categoryResults.total}), ${categoryResults.toolLeaks} leaks, ${categoryResults.avgLatency}ms avg`);
  }

  // Final summary
  results.summary.total = totalCount;
  results.summary.avgLatency = Math.round(totalLatency / totalCount);

  const toolReqPct = ((results.summary.toolRequired.correct / results.summary.toolRequired.total) * 100).toFixed(1);
  const noToolPct = ((results.summary.noToolRequired.correct / results.summary.noToolRequired.total) * 100).toFixed(1);

  console.log(`
${col('cyan', '════════════════════════════════════════════════════════════════════')}
${col('white', 'SUMMARY')}
${col('cyan', '════════════════════════════════════════════════════════════════════')}

  ${col('white', 'Tool-Required Queries:')}
    Correct:     ${col(toolReqPct >= 80 ? 'green' : toolReqPct >= 50 ? 'yellow' : 'red', `${toolReqPct}%`)} (${results.summary.toolRequired.correct}/${results.summary.toolRequired.total})

  ${col('white', 'No-Tool Queries (Control):')}
    Correct:     ${col(noToolPct >= 80 ? 'green' : noToolPct >= 50 ? 'yellow' : 'red', `${noToolPct}%`)} (${results.summary.noToolRequired.correct}/${results.summary.noToolRequired.total})

  ${col('white', 'Issues:')}
    Tool Leaks:  ${col(results.summary.toolLeaks === 0 ? 'green' : 'red', results.summary.toolLeaks)}

  ${col('white', 'Performance:')}
    Avg Latency: ${results.summary.avgLatency}ms

${col('cyan', '════════════════════════════════════════════════════════════════════')}
`);

  // Calculate overall score
  const toolScore = (results.summary.toolRequired.correct / results.summary.toolRequired.total) * 50;
  const noToolScore = (results.summary.noToolRequired.correct / results.summary.noToolRequired.total) * 30;
  const leakPenalty = Math.min(results.summary.toolLeaks * 2, 20);
  const overallScore = Math.max(0, toolScore + noToolScore - leakPenalty);

  results.summary.scores = {
    toolUsage: toolScore.toFixed(1),
    controlGroup: noToolScore.toFixed(1),
    leakPenalty: leakPenalty.toFixed(1),
    overall: overallScore.toFixed(1),
  };

  console.log(`  ${col('white', 'OVERALL SCORE:')} ${col(overallScore >= 60 ? 'green' : overallScore >= 40 ? 'yellow' : 'red', overallScore.toFixed(1) + '/80')}`);
  console.log(`    Tool Usage (50 pts max):   ${toolScore.toFixed(1)}`);
  console.log(`    Control Group (30 pts):    ${noToolScore.toFixed(1)}`);
  console.log(`    Leak Penalty:             -${leakPenalty.toFixed(1)}`);

  // Save results
  fs.mkdirSync(path.dirname(config.output), { recursive: true });
  fs.writeFileSync(config.output, JSON.stringify(results, null, 2));
  console.log(`\n  ${col('dim', `Results saved to: ${config.output}`)}\n`);
}

main().catch(console.error);

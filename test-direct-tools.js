#!/usr/bin/env node
/**
 * Direct Tool Calling Test
 *
 * Tests tool calling directly against llama-server, bypassing the gateway.
 * This helps us understand each model's native tool-calling capability.
 *
 * Usage:
 *   node test-direct-tools.js [--host HOST] [--port PORT]
 */

const http = require('http');

// Configuration
const config = {
  host: process.argv.includes('--host') ? process.argv[process.argv.indexOf('--host') + 1] : 'localai.treehouse',
  port: process.argv.includes('--port') ? parseInt(process.argv[process.argv.indexOf('--port') + 1]) : 8003,
};

// Colors
const c = (color, text) => {
  const codes = { reset: 0, red: 31, green: 32, yellow: 33, blue: 34, cyan: 36, dim: 90 };
  return `\x1b[${codes[color] || 0}m${text}\x1b[0m`;
};

// Web search tool definition (OpenAI format)
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

// Get current time tool
const GET_TIME_TOOL = {
  type: 'function',
  function: {
    name: 'get_current_time',
    description: 'Get the current date and time',
    parameters: {
      type: 'object',
      properties: {
        timezone: {
          type: 'string',
          description: 'Optional timezone (e.g., "America/New_York")'
        }
      }
    }
  }
};

// Calculator tool
const CALCULATOR_TOOL = {
  type: 'function',
  function: {
    name: 'calculator',
    description: 'Perform mathematical calculations',
    parameters: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: 'Mathematical expression to evaluate (e.g., "2 + 2", "sqrt(16)")'
        }
      },
      required: ['expression']
    }
  }
};

// Test cases
const TEST_CASES = [
  {
    name: 'Weather Query (should use web_search)',
    messages: [{ role: 'user', content: "What's the weather like in Tokyo right now?" }],
    tools: [WEB_SEARCH_TOOL],
    expectTool: 'web_search'
  },
  {
    name: 'Time Query (should use get_current_time)',
    messages: [{ role: 'user', content: "What time is it?" }],
    tools: [GET_TIME_TOOL],
    expectTool: 'get_current_time'
  },
  {
    name: 'Math Query (should use calculator)',
    messages: [{ role: 'user', content: "What is 127 * 43?" }],
    tools: [CALCULATOR_TOOL],
    expectTool: 'calculator'
  },
  {
    name: 'News Query (should use web_search)',
    messages: [{ role: 'user', content: "What's happening in the news today?" }],
    tools: [WEB_SEARCH_TOOL],
    expectTool: 'web_search'
  },
  {
    name: 'Multiple Tools Available',
    messages: [{ role: 'user', content: "What's the current Bitcoin price?" }],
    tools: [WEB_SEARCH_TOOL, GET_TIME_TOOL, CALCULATOR_TOOL],
    expectTool: 'web_search'
  },
  {
    name: 'No Tool Needed (greeting)',
    messages: [{ role: 'user', content: "Hello! How are you?" }],
    tools: [WEB_SEARCH_TOOL, GET_TIME_TOOL],
    expectTool: null  // Should NOT use a tool
  },
  {
    name: 'No Tool Needed (general knowledge)',
    messages: [{ role: 'user', content: "What is the capital of France?" }],
    tools: [WEB_SEARCH_TOOL],
    expectTool: null  // Should NOT use a tool (static knowledge)
  }
];

// Make request to llama-server
function makeRequest(messages, tools) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: 'test',
      messages,
      tools,
      tool_choice: 'auto',
      max_tokens: 512,
      temperature: 0.7,
    });

    const options = {
      hostname: config.host,
      port: config.port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 120000,
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, error: 'JSON parse error', raw: data.substring(0, 500) });
        }
      });
    });

    req.on('error', (e) => reject(e));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.write(payload);
    req.end();
  });
}

// Check server health and get model info
async function getServerInfo() {
  return new Promise((resolve) => {
    const req = http.get(`http://${config.host}:${config.port}/props`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => {
      req.destroy();
      resolve(null);
    });
  });
}

// Analyze response for tool calls
function analyzeResponse(response, expectTool) {
  const result = {
    success: false,
    usedTool: false,
    toolName: null,
    toolArgs: null,
    content: null,
    finishReason: null,
    leakedJSON: false,
    correct: false,
  };

  if (response.error) {
    result.error = response.error;
    return result;
  }

  const choice = response.data?.choices?.[0];
  if (!choice) {
    result.error = 'No choices in response';
    return result;
  }

  result.success = true;
  result.finishReason = choice.finish_reason;
  result.content = choice.message?.content;

  // Check for tool calls
  if (choice.message?.tool_calls && choice.message.tool_calls.length > 0) {
    result.usedTool = true;
    const tc = choice.message.tool_calls[0];
    result.toolName = tc.function?.name;
    try {
      result.toolArgs = JSON.parse(tc.function?.arguments || '{}');
    } catch {
      result.toolArgs = tc.function?.arguments;
    }
  }

  // Check for leaked tool JSON in content
  if (result.content) {
    const leakPatterns = [
      /\{"name":\s*"\w+"/,
      /<tool_call>/,
      /"function":\s*\{/,
    ];
    result.leakedJSON = leakPatterns.some(p => p.test(result.content));
  }

  // Determine correctness
  if (expectTool) {
    result.correct = result.usedTool && result.toolName === expectTool && !result.leakedJSON;
  } else {
    result.correct = !result.usedTool && !result.leakedJSON;
  }

  return result;
}

// Main
async function main() {
  console.log(`
${c('cyan', '╔════════════════════════════════════════════════════════════════╗')}
${c('cyan', '║')}          ${c('yellow', 'DIRECT TOOL CALLING TEST')}                           ${c('cyan', '║')}
${c('cyan', '╚════════════════════════════════════════════════════════════════╝')}

  Server: ${c('white', `${config.host}:${config.port}`)}
`);

  // Get server info
  const serverInfo = await getServerInfo();
  if (!serverInfo) {
    console.log(c('red', '✗ Cannot connect to llama-server'));
    console.log(c('dim', `  Make sure llama-server is running on ${config.host}:${config.port}`));
    process.exit(1);
  }

  console.log(`  Model: ${c('white', serverInfo.default_generation_settings?.model || 'unknown')}`);
  console.log(`  Chat Template: ${c('dim', serverInfo.chat_template ? 'yes' : 'no')}`);
  console.log(`  Tool Template: ${c('dim', serverInfo.chat_template_tool_use ? 'yes' : 'no')}`);
  console.log();

  // Run tests
  const results = [];
  let passed = 0;
  let failed = 0;

  for (const test of TEST_CASES) {
    process.stdout.write(`  ${c('dim', '▶')} ${test.name}... `);

    try {
      const response = await makeRequest(test.messages, test.tools);
      const analysis = analyzeResponse(response, test.expectTool);

      results.push({
        name: test.name,
        expectTool: test.expectTool,
        ...analysis,
      });

      if (analysis.correct) {
        passed++;
        if (analysis.usedTool) {
          console.log(c('green', `✓ Used ${analysis.toolName}(${JSON.stringify(analysis.toolArgs)})`));
        } else {
          console.log(c('green', '✓ Correctly did not use tool'));
        }
      } else {
        failed++;
        if (analysis.leakedJSON) {
          console.log(c('red', '✗ Leaked tool JSON in response'));
        } else if (test.expectTool && !analysis.usedTool) {
          console.log(c('red', `✗ Expected ${test.expectTool} but got no tool call`));
          if (analysis.content) {
            console.log(c('dim', `    Content: "${analysis.content.substring(0, 100)}..."`));
          }
        } else if (!test.expectTool && analysis.usedTool) {
          console.log(c('yellow', `⚠ Unnecessarily used ${analysis.toolName}`));
        } else {
          console.log(c('red', `✗ Used ${analysis.toolName} instead of ${test.expectTool}`));
        }
      }

    } catch (e) {
      failed++;
      results.push({ name: test.name, error: e.message });
      console.log(c('red', `✗ Error: ${e.message}`));
    }

    // Small delay between requests
    await new Promise(r => setTimeout(r, 500));
  }

  // Summary
  console.log(`
${c('cyan', '════════════════════════════════════════════════════════════════════')}
${c('white', 'SUMMARY')}
${c('cyan', '════════════════════════════════════════════════════════════════════')}

  Passed: ${c(passed === TEST_CASES.length ? 'green' : 'yellow', passed)}/${TEST_CASES.length}
  Failed: ${c(failed === 0 ? 'green' : 'red', failed)}/${TEST_CASES.length}

  Tool Calls Made: ${results.filter(r => r.usedTool).length}
  Tool Leaks: ${results.filter(r => r.leakedJSON).length}
`);

  // Detailed results
  console.log(c('dim', 'Detailed Results:'));
  for (const r of results) {
    const status = r.correct ? c('green', '✓') : c('red', '✗');
    const tool = r.usedTool ? `→ ${r.toolName}` : '(no tool)';
    console.log(`  ${status} ${r.name}: ${tool}`);
  }

  console.log();
}

main().catch(console.error);

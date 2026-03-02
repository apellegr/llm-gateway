#!/usr/bin/env node
/**
 * Direct tool function tests - tests the tool execution without going through LLM
 * Run this inside the gateway container or with the gateway code loaded
 */

const http = require('http');

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:18080';

async function makeRequest(prompt) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      model: 'test',
      messages: [{ role: 'user', content: prompt }]
    });

    const url = new URL('/v1/chat/completions', GATEWAY_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
      },
      timeout: 120000
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve(json.choices?.[0]?.message?.content || 'No content');
        } catch (e) {
          resolve(`Parse error: ${body.substring(0, 200)}`);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.write(data);
    req.end();
  });
}

async function testTool(name, prompt) {
  console.log(`\n>>> Testing: ${name}`);
  console.log(`    Prompt: "${prompt}"`);
  try {
    const result = await makeRequest(prompt);
    console.log(`    Result: ${result.substring(0, 300)}${result.length > 300 ? '...' : ''}`);
    return true;
  } catch (e) {
    console.log(`    ERROR: ${e.message}`);
    return false;
  }
}

async function main() {
  console.log('========================================');
  console.log('Tier 1 Tools Test Suite');
  console.log(`Gateway: ${GATEWAY_URL}`);
  console.log('========================================');

  // Health check
  console.log('\n>>> Health Check');
  try {
    const healthRes = await new Promise((resolve, reject) => {
      http.get(`${GATEWAY_URL}/debug/health`, { timeout: 5000 }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => resolve(JSON.parse(body)));
      }).on('error', reject);
    });
    console.log(`    Status: ${healthRes.status}`);
  } catch (e) {
    console.log(`    ERROR: ${e.message}`);
    process.exit(1);
  }

  const tests = [
    ['dictionary', 'Define the word ephemeral'],
    ['convert_units', 'Convert 100 miles to kilometers'],
    ['calculator', 'What is 15% of 250?'],
    ['get_current_time', 'What time is it in Tokyo?'],
    ['weather_forecast', 'What is the weather forecast for Paris?'],
    ['manage_todos (add)', 'Add "test item from script" to my todo list'],
    ['manage_todos (list)', 'Show my todo list'],
    ['set_timer', 'Set a timer for 10 seconds'],
    ['set_reminder', 'Remind me to check results in 3 minutes'],
    ['send_notification', 'Send me a notification saying "Test complete!"'],
    ['web_search', 'What is the current Bitcoin price?']
  ];

  let passed = 0;
  let failed = 0;

  for (const [name, prompt] of tests) {
    const success = await testTool(name, prompt);
    if (success) passed++;
    else failed++;
  }

  console.log('\n========================================');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('========================================');
}

main().catch(console.error);

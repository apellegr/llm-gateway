#!/usr/bin/env node
/**
 * LLM Gateway Test Tool
 *
 * Sends test prompts to the gateway and collects statistics about routing,
 * timing, and responses. Useful for testing gateway changes and tuning.
 *
 * Usage:
 *   node test-gateway.js [options]
 *
 * Examples:
 *   node test-gateway.js --limit 50 --delay 100
 *   node test-gateway.js --category weather --verbose
 *   node test-gateway.js --random 100 --output results.json
 *   node test-gateway.js --dry-run --category coding
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
};

const c = (color, text) => `${colors[color]}${text}${colors.reset}`;

// Category definitions (line ranges in test-prompts.txt)
const categories = {
  'greetings': { start: 1, end: 50, name: 'Greetings & Simple' },
  'weather': { start: 51, end: 120, name: 'Weather & Real-time' },
  'news': { start: 121, end: 200, name: 'Current Events & News' },
  'financial': { start: 201, end: 280, name: 'Prices & Financial' },
  'scheduling': { start: 281, end: 380, name: 'Scheduling & Organization' },
  'coding': { start: 381, end: 500, name: 'Coding & Technical' },
  'research': { start: 501, end: 600, name: 'Research & Knowledge' },
  'creative': { start: 601, end: 680, name: 'Creative & Writing' },
  'advice': { start: 681, end: 760, name: 'Life Advice & Decisions' },
  'food': { start: 761, end: 840, name: 'Food & Cooking' },
  'health': { start: 841, end: 920, name: 'Health & Fitness' },
  'travel': { start: 921, end: 1000, name: 'Travel & Geography' },
};

// Default configuration
const defaults = {
  gateway: process.env.GATEWAY_URL || 'http://localhost:8080',
  promptsFile: path.join(__dirname, 'test-prompts.txt'),
  limit: 0,           // 0 = all prompts
  delay: 200,         // ms between requests
  timeout: 30000,     // request timeout
  concurrency: 1,     // parallel requests
  verbose: false,
  dryRun: false,
  random: 0,          // random sample size (0 = sequential)
  category: null,     // filter by category
  output: null,       // output file for results
  model: 'test',      // model name to send
  maxTokens: 50,      // limit response length for speed
  noStream: true,     // disable streaming for easier parsing
};

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const config = { ...defaults };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
      case '-g':
      case '--gateway':
        config.gateway = next;
        i++;
        break;
      case '-f':
      case '--file':
        config.promptsFile = next;
        i++;
        break;
      case '-l':
      case '--limit':
        config.limit = parseInt(next);
        i++;
        break;
      case '-d':
      case '--delay':
        config.delay = parseInt(next);
        i++;
        break;
      case '-t':
      case '--timeout':
        config.timeout = parseInt(next);
        i++;
        break;
      case '-c':
      case '--concurrency':
        config.concurrency = parseInt(next);
        i++;
        break;
      case '-v':
      case '--verbose':
        config.verbose = true;
        break;
      case '--dry-run':
        config.dryRun = true;
        break;
      case '-r':
      case '--random':
        config.random = parseInt(next);
        i++;
        break;
      case '--category':
        config.category = next;
        i++;
        break;
      case '-o':
      case '--output':
        config.output = next;
        i++;
        break;
      case '-m':
      case '--model':
        config.model = next;
        i++;
        break;
      case '--max-tokens':
        config.maxTokens = parseInt(next);
        i++;
        break;
      case '--list-categories':
        listCategories();
        process.exit(0);
      default:
        if (arg.startsWith('-')) {
          console.error(c('red', `Unknown option: ${arg}`));
          process.exit(1);
        }
    }
  }

  return config;
}

function printHelp() {
  console.log(`
${c('bold', 'LLM Gateway Test Tool')}

${c('cyan', 'Usage:')}
  node test-gateway.js [options]

${c('cyan', 'Options:')}
  -h, --help              Show this help message
  -g, --gateway URL       Gateway URL (default: http://localhost:8080)
  -f, --file PATH         Prompts file path (default: ./test-prompts.txt)
  -l, --limit N           Limit to first N prompts (default: all)
  -d, --delay MS          Delay between requests in ms (default: 200)
  -t, --timeout MS        Request timeout in ms (default: 30000)
  -c, --concurrency N     Parallel requests (default: 1)
  -v, --verbose           Show detailed output for each request
  --dry-run               Parse prompts but don't send requests
  -r, --random N          Send N random prompts
  --category NAME         Filter by category (use --list-categories to see options)
  -o, --output FILE       Save results to JSON file
  -m, --model NAME        Model name to send (default: test)
  --max-tokens N          Max tokens in response (default: 50)
  --list-categories       List available categories

${c('cyan', 'Examples:')}
  ${c('dim', '# Test first 50 prompts')}
  node test-gateway.js --limit 50

  ${c('dim', '# Test weather category with verbose output')}
  node test-gateway.js --category weather --verbose

  ${c('dim', '# Random sample of 100 prompts, save results')}
  node test-gateway.js --random 100 --output results.json

  ${c('dim', '# Test against production gateway')}
  node test-gateway.js -g https://llm-proxy.treehouse --limit 20

  ${c('dim', '# Dry run to see what would be sent')}
  node test-gateway.js --category coding --dry-run

${c('cyan', 'Environment Variables:')}
  GATEWAY_URL             Default gateway URL
`);
}

function listCategories() {
  console.log(`\n${c('bold', 'Available Categories:')}\n`);
  console.log('  ' + c('dim', 'Name'.padEnd(15)) + c('dim', 'Prompts'.padEnd(10)) + c('dim', 'Description'));
  console.log('  ' + '-'.repeat(50));

  for (const [key, cat] of Object.entries(categories)) {
    const count = cat.end - cat.start + 1;
    console.log(`  ${c('cyan', key.padEnd(15))}${String(count).padEnd(10)}${cat.name}`);
  }
  console.log();
}

// Load prompts from file
function loadPrompts(config) {
  if (!fs.existsSync(config.promptsFile)) {
    console.error(c('red', `Prompts file not found: ${config.promptsFile}`));
    process.exit(1);
  }

  const content = fs.readFileSync(config.promptsFile, 'utf8');
  const lines = content.split('\n');

  let prompts = [];
  let promptIndex = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) continue;

    promptIndex++;
    prompts.push({
      index: promptIndex,
      text: trimmed,
      category: getCategoryForIndex(promptIndex),
    });
  }

  // Filter by category
  if (config.category) {
    const cat = categories[config.category];
    if (!cat) {
      console.error(c('red', `Unknown category: ${config.category}`));
      console.error('Use --list-categories to see available options');
      process.exit(1);
    }
    prompts = prompts.filter(p => p.index >= cat.start && p.index <= cat.end);
  }

  // Random sample
  if (config.random > 0) {
    prompts = shuffle(prompts).slice(0, config.random);
  }

  // Limit
  if (config.limit > 0) {
    prompts = prompts.slice(0, config.limit);
  }

  return prompts;
}

function getCategoryForIndex(index) {
  for (const [key, cat] of Object.entries(categories)) {
    if (index >= cat.start && index <= cat.end) {
      return key;
    }
  }
  return 'unknown';
}

function shuffle(array) {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Send a single request to the gateway
async function sendRequest(config, prompt) {
  const startTime = Date.now();

  const requestBody = JSON.stringify({
    model: config.model,
    messages: [{ role: 'user', content: prompt.text }],
    max_tokens: config.maxTokens,
    stream: !config.noStream,
  });

  const url = new URL(config.gateway);
  const isHttps = url.protocol === 'https:';
  const client = isHttps ? https : http;

  return new Promise((resolve) => {
    const req = client.request({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestBody),
      },
      timeout: config.timeout,
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        const endTime = Date.now();
        const duration = endTime - startTime;

        let parsed = null;
        let error = null;

        try {
          parsed = JSON.parse(body);
        } catch (e) {
          error = `Failed to parse response: ${e.message}`;
        }

        resolve({
          prompt,
          status: res.statusCode,
          duration,
          headers: {
            backend: res.headers['x-backend'],
            requestId: res.headers['x-request-id'],
            timingMs: res.headers['x-timing-ms'],
          },
          response: parsed,
          error,
          responseText: getResponseText(parsed),
        });
      });
    });

    req.on('error', (err) => {
      resolve({
        prompt,
        status: 0,
        duration: Date.now() - startTime,
        error: err.message,
        response: null,
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({
        prompt,
        status: 0,
        duration: config.timeout,
        error: 'Request timeout',
        response: null,
      });
    });

    req.write(requestBody);
    req.end();
  });
}

function getResponseText(parsed) {
  if (!parsed) return '';
  // OpenAI format
  if (parsed.choices?.[0]?.message?.content) {
    return parsed.choices[0].message.content;
  }
  // Responses API format
  if (parsed.output?.[0]?.content?.[0]?.text) {
    return parsed.output[0].content[0].text;
  }
  return '';
}

// Progress bar
function progressBar(current, total, width = 30) {
  const percent = current / total;
  const filled = Math.round(width * percent);
  const empty = width - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  return `[${bar}] ${current}/${total}`;
}

// Format duration
function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// Main test runner
async function runTests(config) {
  console.log(`\n${c('bold', '🧪 LLM Gateway Test Tool')}\n`);

  // Load prompts
  const prompts = loadPrompts(config);

  if (prompts.length === 0) {
    console.log(c('yellow', 'No prompts to test'));
    return;
  }

  // Show configuration
  console.log(c('cyan', 'Configuration:'));
  console.log(`  Gateway:     ${c('white', config.gateway)}`);
  console.log(`  Prompts:     ${c('white', prompts.length)}`);
  if (config.category) {
    console.log(`  Category:    ${c('white', config.category)} (${categories[config.category].name})`);
  }
  console.log(`  Delay:       ${c('white', config.delay + 'ms')}`);
  console.log(`  Concurrency: ${c('white', config.concurrency)}`);
  console.log(`  Model:       ${c('white', config.model)}`);
  console.log();

  if (config.dryRun) {
    console.log(c('yellow', '📋 Dry run - prompts that would be sent:\n'));
    for (const prompt of prompts) {
      console.log(`  ${c('dim', `[${prompt.index}]`)} ${c('cyan', `[${prompt.category}]`)} ${prompt.text.substring(0, 60)}${prompt.text.length > 60 ? '...' : ''}`);
    }
    console.log(`\n${c('green', `Total: ${prompts.length} prompts`)}\n`);
    return;
  }

  // Run tests
  const results = [];
  const stats = {
    total: prompts.length,
    success: 0,
    failed: 0,
    totalDuration: 0,
    byBackend: {},
    byCategory: {},
    byStatus: {},
  };

  const startTime = Date.now();

  console.log(c('cyan', 'Running tests...\n'));

  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i];

    // Progress
    if (!config.verbose) {
      process.stdout.write(`\r  ${progressBar(i + 1, prompts.length)} ${c('dim', prompt.text.substring(0, 40))}...`.padEnd(100));
    }

    const result = await sendRequest(config, prompt);
    results.push(result);

    // Update stats
    stats.totalDuration += result.duration;

    if (result.status === 200 && !result.error) {
      stats.success++;
    } else {
      stats.failed++;
    }

    const backend = result.headers?.backend || 'unknown';
    stats.byBackend[backend] = (stats.byBackend[backend] || 0) + 1;
    stats.byCategory[prompt.category] = (stats.byCategory[prompt.category] || 0) + 1;
    stats.byStatus[result.status] = (stats.byStatus[result.status] || 0) + 1;

    // Verbose output
    if (config.verbose) {
      const statusColor = result.status === 200 ? 'green' : 'red';
      const backendColor = backend === 'anthropic' ? 'magenta' : 'cyan';

      console.log(`${c('dim', `[${i + 1}/${prompts.length}]`)} ${c(statusColor, result.status)} ${c(backendColor, backend.padEnd(12))} ${c('dim', formatDuration(result.duration).padStart(7))} ${prompt.text.substring(0, 50)}${prompt.text.length > 50 ? '...' : ''}`);

      if (result.error) {
        console.log(`  ${c('red', '└─ Error:')} ${result.error}`);
      }
    }

    // Delay between requests
    if (i < prompts.length - 1 && config.delay > 0) {
      await new Promise(r => setTimeout(r, config.delay));
    }
  }

  if (!config.verbose) {
    process.stdout.write('\r' + ' '.repeat(100) + '\r');
  }

  const totalTime = Date.now() - startTime;

  // Print results
  printResults(stats, results, totalTime, config);

  // Save results
  if (config.output) {
    const outputData = {
      config: {
        gateway: config.gateway,
        category: config.category,
        promptCount: prompts.length,
        timestamp: new Date().toISOString(),
      },
      stats,
      results: results.map(r => ({
        index: r.prompt.index,
        category: r.prompt.category,
        prompt: r.prompt.text,
        status: r.status,
        duration: r.duration,
        backend: r.headers?.backend,
        error: r.error,
        responsePreview: r.responseText?.substring(0, 200),
      })),
    };

    fs.writeFileSync(config.output, JSON.stringify(outputData, null, 2));
    console.log(`\n${c('green', '💾 Results saved to:')} ${config.output}\n`);
  }
}

function printResults(stats, results, totalTime, config) {
  console.log(`\n${c('bold', '📊 Results')}\n`);

  // Summary
  const successRate = ((stats.success / stats.total) * 100).toFixed(1);
  const avgDuration = Math.round(stats.totalDuration / stats.total);

  console.log(c('cyan', '  Summary:'));
  console.log(`    Total requests:  ${c('white', stats.total)}`);
  console.log(`    Successful:      ${c('green', stats.success)} (${successRate}%)`);
  console.log(`    Failed:          ${c(stats.failed > 0 ? 'red' : 'white', stats.failed)}`);
  console.log(`    Total time:      ${c('white', formatDuration(totalTime))}`);
  console.log(`    Avg latency:     ${c('white', formatDuration(avgDuration))}`);
  console.log(`    Requests/sec:    ${c('white', (stats.total / (totalTime / 1000)).toFixed(1))}`);

  // By backend
  console.log(`\n${c('cyan', '  By Backend:')}`);
  const backendEntries = Object.entries(stats.byBackend).sort((a, b) => b[1] - a[1]);
  for (const [backend, count] of backendEntries) {
    const percent = ((count / stats.total) * 100).toFixed(1);
    const bar = '█'.repeat(Math.round(percent / 5)) + '░'.repeat(20 - Math.round(percent / 5));
    const backendColor = backend === 'anthropic' ? 'magenta' : backend === 'unknown' ? 'dim' : 'cyan';
    console.log(`    ${c(backendColor, backend.padEnd(15))} ${bar} ${String(count).padStart(4)} (${percent}%)`);
  }

  // By category
  if (Object.keys(stats.byCategory).length > 1) {
    console.log(`\n${c('cyan', '  By Category:')}`);
    const catEntries = Object.entries(stats.byCategory).sort((a, b) => b[1] - a[1]);
    for (const [cat, count] of catEntries) {
      console.log(`    ${cat.padEnd(15)} ${String(count).padStart(4)}`);
    }
  }

  // By status
  if (Object.keys(stats.byStatus).length > 1 || !stats.byStatus[200]) {
    console.log(`\n${c('cyan', '  By Status:')}`);
    const statusEntries = Object.entries(stats.byStatus).sort((a, b) => a[0] - b[0]);
    for (const [status, count] of statusEntries) {
      const statusColor = status === '200' ? 'green' : 'red';
      console.log(`    ${c(statusColor, status.padEnd(15))} ${count}`);
    }
  }

  // Slowest requests
  const slowest = [...results].sort((a, b) => b.duration - a.duration).slice(0, 5);
  console.log(`\n${c('cyan', '  Slowest Requests:')}`);
  for (const r of slowest) {
    console.log(`    ${c('dim', formatDuration(r.duration).padStart(7))} ${r.prompt.text.substring(0, 50)}...`);
  }

  // Errors
  const errors = results.filter(r => r.error);
  if (errors.length > 0) {
    console.log(`\n${c('red', '  Errors:')}`);
    const uniqueErrors = [...new Set(errors.map(e => e.error))];
    for (const err of uniqueErrors.slice(0, 5)) {
      const count = errors.filter(e => e.error === err).length;
      console.log(`    ${c('red', `[${count}x]`)} ${err}`);
    }
  }

  console.log();
}

// Run
const config = parseArgs();
runTests(config).catch(err => {
  console.error(c('red', `Error: ${err.message}`));
  process.exit(1);
});

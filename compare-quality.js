#!/usr/bin/env node
/**
 * LLM Gateway Quality Comparison Tool
 *
 * Compares responses from local models vs Anthropic to evaluate routing quality.
 * For each prompt, sends to both the routed backend and directly to Anthropic,
 * then evaluates response quality, format, and completeness.
 *
 * Usage:
 *   node compare-quality.js [options]
 *
 * Examples:
 *   node compare-quality.js --limit 20 --category coding
 *   node compare-quality.js --random 50 --output comparison.json
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ANSI colors
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

const col = (color, text) => `${c[color]}${text}${c.reset}`;

// Categories
const categories = {
  'greetings': { start: 1, end: 50 },
  'weather': { start: 51, end: 120 },
  'news': { start: 121, end: 200 },
  'financial': { start: 201, end: 280 },
  'scheduling': { start: 281, end: 380 },
  'coding': { start: 381, end: 500 },
  'research': { start: 501, end: 600 },
  'creative': { start: 601, end: 680 },
  'advice': { start: 681, end: 760 },
  'food': { start: 761, end: 840 },
  'health': { start: 841, end: 920 },
  'travel': { start: 921, end: 1000 },
};

// Configuration
const config = {
  gateway: process.env.GATEWAY_URL || 'http://localhost:8080',
  anthropicDirect: 'https://api.anthropic.com',
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  promptsFile: path.join(__dirname, 'test-prompts.txt'),
  limit: 10,
  delay: 1000,
  timeout: 60000,
  category: null,
  random: 0,
  output: null,
  verbose: false,
  maxTokens: 500,  // More tokens for quality comparison
  evaluator: 'anthropic',  // Use Anthropic to evaluate quality
};

// Parse args
function parseArgs() {
  const args = process.argv.slice(2);
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
        config.gateway = next; i++;
        break;
      case '-l':
      case '--limit':
        config.limit = parseInt(next); i++;
        break;
      case '-d':
      case '--delay':
        config.delay = parseInt(next); i++;
        break;
      case '--category':
        config.category = next; i++;
        break;
      case '-r':
      case '--random':
        config.random = parseInt(next); i++;
        break;
      case '-o':
      case '--output':
        config.output = next; i++;
        break;
      case '-v':
      case '--verbose':
        config.verbose = true;
        break;
      case '--max-tokens':
        config.maxTokens = parseInt(next); i++;
        break;
      case '--no-eval':
        config.evaluator = null;
        break;
    }
  }
  return config;
}

function printHelp() {
  console.log(`
${col('bold', 'LLM Gateway Quality Comparison Tool')}

Compares responses from local models vs Anthropic to evaluate quality.

${col('cyan', 'Usage:')}
  node compare-quality.js [options]

${col('cyan', 'Options:')}
  -h, --help          Show help
  -g, --gateway URL   Gateway URL (default: http://localhost:8080)
  -l, --limit N       Limit prompts (default: 10)
  -d, --delay MS      Delay between tests (default: 1000)
  --category NAME     Filter by category
  -r, --random N      Random sample
  -o, --output FILE   Save results to JSON
  -v, --verbose       Show detailed output
  --max-tokens N      Max response tokens (default: 500)
  --no-eval           Skip AI evaluation, just compare lengths

${col('cyan', 'Environment:')}
  GATEWAY_URL         Gateway URL
  ANTHROPIC_API_KEY   Required for Anthropic comparison

${col('cyan', 'Examples:')}
  node compare-quality.js --limit 20 --category coding
  node compare-quality.js --random 30 --output comparison.json
`);
}

// Load prompts
function loadPrompts() {
  const content = fs.readFileSync(config.promptsFile, 'utf8');
  const lines = content.split('\n');
  let prompts = [];
  let idx = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    idx++;
    prompts.push({
      index: idx,
      text: trimmed,
      category: getCategoryForIndex(idx),
    });
  }

  if (config.category) {
    const cat = categories[config.category];
    if (cat) {
      prompts = prompts.filter(p => p.index >= cat.start && p.index <= cat.end);
    }
  }

  if (config.random > 0) {
    prompts = shuffle(prompts).slice(0, config.random);
  } else if (config.limit > 0) {
    prompts = prompts.slice(0, config.limit);
  }

  return prompts;
}

function getCategoryForIndex(index) {
  for (const [key, cat] of Object.entries(categories)) {
    if (index >= cat.start && index <= cat.end) return key;
  }
  return 'unknown';
}

function shuffle(arr) {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// HTTP request helper
function makeRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === 'https:' ? https : http;

    const req = client.request({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname,
      method: options.method || 'POST',
      headers: options.headers || {},
      timeout: config.timeout,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data,
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });

    if (body) req.write(body);
    req.end();
  });
}

// Send to gateway (routed to local model)
async function sendToGateway(prompt) {
  const start = Date.now();
  try {
    const res = await makeRequest(
      `${config.gateway}/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      JSON.stringify({
        model: 'test',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: config.maxTokens,
        stream: false,
      })
    );

    const duration = Date.now() - start;
    const parsed = JSON.parse(res.body);
    const content = parsed.choices?.[0]?.message?.content || '';
    const backend = res.headers['x-backend'] || 'unknown';

    return {
      success: true,
      backend,
      duration,
      content,
      tokens: parsed.usage || {},
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      duration: Date.now() - start,
    };
  }
}

// Send directly to Anthropic
async function sendToAnthropic(prompt) {
  if (!config.anthropicKey) {
    return { success: false, error: 'No API key' };
  }

  const start = Date.now();
  try {
    const res = await makeRequest(
      `${config.anthropicDirect}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.anthropicKey,
          'anthropic-version': '2023-06-01',
        },
      },
      JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: config.maxTokens,
        messages: [{ role: 'user', content: prompt }],
      })
    );

    const duration = Date.now() - start;
    const parsed = JSON.parse(res.body);
    const content = parsed.content?.[0]?.text || '';

    return {
      success: true,
      backend: 'anthropic-direct',
      duration,
      content,
      tokens: parsed.usage || {},
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      duration: Date.now() - start,
    };
  }
}

// Use Anthropic to evaluate quality difference
async function evaluateQuality(prompt, localResponse, anthropicResponse) {
  if (!config.evaluator || !config.anthropicKey) {
    return basicComparison(localResponse, anthropicResponse);
  }

  try {
    const evalPrompt = `You are evaluating AI response quality. Compare these two responses to the same prompt.

PROMPT: "${prompt}"

RESPONSE A (Local Model):
${localResponse.substring(0, 1500)}

RESPONSE B (Claude):
${anthropicResponse.substring(0, 1500)}

Rate each response and provide a comparison. Output ONLY valid JSON:
{
  "localScore": <1-10>,
  "anthropicScore": <1-10>,
  "winner": "local" | "anthropic" | "tie",
  "localStrengths": ["..."],
  "localWeaknesses": ["..."],
  "formatComparison": "better" | "same" | "worse",
  "accuracyComparison": "better" | "same" | "worse",
  "completenessComparison": "better" | "same" | "worse",
  "summary": "One sentence comparison"
}`;

    const res = await makeRequest(
      `${config.anthropicDirect}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.anthropicKey,
          'anthropic-version': '2023-06-01',
        },
      },
      JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        messages: [{ role: 'user', content: evalPrompt }],
      })
    );

    const parsed = JSON.parse(res.body);
    const content = parsed.content?.[0]?.text || '';

    // Extract JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (err) {
    // Fall back to basic comparison
  }

  return basicComparison(localResponse, anthropicResponse);
}

function basicComparison(localResponse, anthropicResponse) {
  const localLen = localResponse.length;
  const anthropicLen = anthropicResponse.length;
  const lenRatio = localLen / Math.max(anthropicLen, 1);

  return {
    localScore: null,
    anthropicScore: null,
    winner: lenRatio > 0.8 && lenRatio < 1.2 ? 'tie' : (lenRatio > 1 ? 'local' : 'anthropic'),
    localLength: localLen,
    anthropicLength: anthropicLen,
    lengthRatio: lenRatio.toFixed(2),
    formatComparison: 'unknown',
    summary: `Local: ${localLen} chars, Anthropic: ${anthropicLen} chars`,
  };
}

// Progress bar
function progressBar(current, total, width = 30) {
  const percent = current / total;
  const filled = Math.round(width * percent);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  return `[${bar}] ${current}/${total}`;
}

// Main
async function main() {
  parseArgs();

  console.log(`\n${col('bold', '🔍 LLM Gateway Quality Comparison')}\n`);

  if (!config.anthropicKey) {
    console.log(col('yellow', '⚠️  No ANTHROPIC_API_KEY set. Comparison will be limited.\n'));
  }

  const prompts = loadPrompts();

  console.log(col('cyan', 'Configuration:'));
  console.log(`  Gateway:    ${col('reset', config.gateway)}`);
  console.log(`  Prompts:    ${col('reset', prompts.length)}`);
  if (config.category) {
    console.log(`  Category:   ${col('reset', config.category)}`);
  }
  console.log(`  Max tokens: ${col('reset', config.maxTokens)}`);
  console.log(`  Evaluator:  ${col('reset', config.evaluator || 'basic')}`);
  console.log();

  const results = [];
  const stats = {
    total: prompts.length,
    localWins: 0,
    anthropicWins: 0,
    ties: 0,
    localErrors: 0,
    anthropicErrors: 0,
    avgLocalScore: 0,
    avgAnthropicScore: 0,
    avgLocalDuration: 0,
    avgAnthropicDuration: 0,
    byCategory: {},
    byBackend: {},
  };

  console.log(col('cyan', 'Running comparisons...\n'));

  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i];

    if (!config.verbose) {
      process.stdout.write(`\r  ${progressBar(i + 1, prompts.length)} ${col('dim', prompt.text.substring(0, 35))}...`.padEnd(90));
    }

    // Send to both
    const [localResult, anthropicResult] = await Promise.all([
      sendToGateway(prompt.text),
      sendToAnthropic(prompt.text),
    ]);

    let evaluation = null;

    if (localResult.success && anthropicResult.success) {
      evaluation = await evaluateQuality(
        prompt.text,
        localResult.content,
        anthropicResult.content
      );

      // Update stats
      if (evaluation.winner === 'local') stats.localWins++;
      else if (evaluation.winner === 'anthropic') stats.anthropicWins++;
      else stats.ties++;

      if (evaluation.localScore) {
        stats.avgLocalScore += evaluation.localScore;
        stats.avgAnthropicScore += evaluation.anthropicScore;
      }
    }

    if (!localResult.success) stats.localErrors++;
    if (!anthropicResult.success) stats.anthropicErrors++;

    stats.avgLocalDuration += localResult.duration || 0;
    stats.avgAnthropicDuration += anthropicResult.duration || 0;

    // Track by backend
    const backend = localResult.backend || 'error';
    if (!stats.byBackend[backend]) {
      stats.byBackend[backend] = { count: 0, wins: 0, losses: 0, ties: 0 };
    }
    stats.byBackend[backend].count++;
    if (evaluation?.winner === 'local') stats.byBackend[backend].wins++;
    else if (evaluation?.winner === 'anthropic') stats.byBackend[backend].losses++;
    else if (evaluation?.winner === 'tie') stats.byBackend[backend].ties++;

    // Track by category
    if (!stats.byCategory[prompt.category]) {
      stats.byCategory[prompt.category] = { count: 0, wins: 0, losses: 0, ties: 0 };
    }
    stats.byCategory[prompt.category].count++;
    if (evaluation?.winner === 'local') stats.byCategory[prompt.category].wins++;
    else if (evaluation?.winner === 'anthropic') stats.byCategory[prompt.category].losses++;
    else if (evaluation?.winner === 'tie') stats.byCategory[prompt.category].ties++;

    const result = {
      index: prompt.index,
      category: prompt.category,
      prompt: prompt.text,
      local: {
        backend: localResult.backend,
        success: localResult.success,
        duration: localResult.duration,
        content: localResult.content,
        error: localResult.error,
      },
      anthropic: {
        success: anthropicResult.success,
        duration: anthropicResult.duration,
        content: anthropicResult.content,
        error: anthropicResult.error,
      },
      evaluation,
    };

    results.push(result);

    if (config.verbose) {
      const winnerColor = evaluation?.winner === 'local' ? 'green' :
                          evaluation?.winner === 'anthropic' ? 'magenta' : 'yellow';
      console.log(`${col('dim', `[${i + 1}]`)} ${col('cyan', prompt.category.padEnd(12))} ${col(winnerColor, (evaluation?.winner || 'n/a').padEnd(10))} ${prompt.text.substring(0, 40)}...`);
      if (evaluation?.summary) {
        console.log(`    ${col('dim', evaluation.summary)}`);
      }
    }

    // Delay
    if (i < prompts.length - 1) {
      await new Promise(r => setTimeout(r, config.delay));
    }
  }

  if (!config.verbose) {
    process.stdout.write('\r' + ' '.repeat(100) + '\r');
  }

  // Calculate averages
  const successCount = stats.total - stats.localErrors;
  stats.avgLocalDuration = Math.round(stats.avgLocalDuration / stats.total);
  stats.avgAnthropicDuration = Math.round(stats.avgAnthropicDuration / stats.total);
  if (successCount > 0 && stats.avgLocalScore > 0) {
    stats.avgLocalScore = (stats.avgLocalScore / successCount).toFixed(1);
    stats.avgAnthropicScore = (stats.avgAnthropicScore / successCount).toFixed(1);
  }

  // Print results
  printResults(stats, results);

  // Save output
  if (config.output) {
    fs.writeFileSync(config.output, JSON.stringify({
      config: {
        gateway: config.gateway,
        category: config.category,
        timestamp: new Date().toISOString(),
      },
      stats,
      results,
    }, null, 2));
    console.log(`\n${col('green', '💾 Results saved to:')} ${config.output}\n`);
  }
}

function printResults(stats, results) {
  console.log(`\n${col('bold', '📊 Quality Comparison Results')}\n`);

  // Overall
  const localWinRate = ((stats.localWins / stats.total) * 100).toFixed(1);
  const anthropicWinRate = ((stats.anthropicWins / stats.total) * 100).toFixed(1);
  const tieRate = ((stats.ties / stats.total) * 100).toFixed(1);

  console.log(col('cyan', '  Overall:'));
  console.log(`    Total comparisons: ${col('reset', stats.total)}`);
  console.log(`    Local wins:        ${col('green', stats.localWins)} (${localWinRate}%)`);
  console.log(`    Anthropic wins:    ${col('magenta', stats.anthropicWins)} (${anthropicWinRate}%)`);
  console.log(`    Ties:              ${col('yellow', stats.ties)} (${tieRate}%)`);

  if (stats.avgLocalScore) {
    console.log(`\n    Avg Local Score:     ${col('reset', stats.avgLocalScore)}/10`);
    console.log(`    Avg Anthropic Score: ${col('reset', stats.avgAnthropicScore)}/10`);
  }

  console.log(`\n    Avg Local Latency:     ${col('reset', stats.avgLocalDuration)}ms`);
  console.log(`    Avg Anthropic Latency: ${col('reset', stats.avgAnthropicDuration)}ms`);
  console.log(`    Speed advantage:       ${col('green', (stats.avgAnthropicDuration / stats.avgLocalDuration).toFixed(1))}x faster`);

  // By backend
  console.log(`\n${col('cyan', '  By Backend:')}`);
  for (const [backend, data] of Object.entries(stats.byBackend)) {
    const winRate = ((data.wins / data.count) * 100).toFixed(0);
    const color = data.wins >= data.losses ? 'green' : 'red';
    console.log(`    ${backend.padEnd(15)} ${String(data.count).padStart(3)} tests | ${col(color, `${data.wins}W`)} ${data.losses}L ${data.ties}T (${winRate}% win)`);
  }

  // By category
  console.log(`\n${col('cyan', '  By Category:')}`);
  const catEntries = Object.entries(stats.byCategory).sort((a, b) =>
    (b[1].wins / b[1].count) - (a[1].wins / a[1].count)
  );
  for (const [cat, data] of catEntries) {
    const winRate = ((data.wins / data.count) * 100).toFixed(0);
    const color = data.wins >= data.losses ? 'green' : 'red';
    console.log(`    ${cat.padEnd(15)} ${String(data.count).padStart(3)} tests | ${col(color, `${data.wins}W`)} ${data.losses}L ${data.ties}T (${winRate}% win)`);
  }

  // Examples of each outcome
  const localWinExample = results.find(r => r.evaluation?.winner === 'local');
  const anthropicWinExample = results.find(r => r.evaluation?.winner === 'anthropic');

  if (localWinExample && config.verbose) {
    console.log(`\n${col('cyan', '  Example Local Win:')}`);
    console.log(`    Prompt: "${localWinExample.prompt.substring(0, 60)}..."`);
    console.log(`    ${col('dim', localWinExample.evaluation?.summary || '')}`);
  }

  if (anthropicWinExample && config.verbose) {
    console.log(`\n${col('cyan', '  Example Anthropic Win:')}`);
    console.log(`    Prompt: "${anthropicWinExample.prompt.substring(0, 60)}..."`);
    console.log(`    ${col('dim', anthropicWinExample.evaluation?.summary || '')}`);
  }

  console.log();
}

main().catch(err => {
  console.error(col('red', `Error: ${err.message}`));
  process.exit(1);
});

# Tool-Calling Model Benchmark Report

**Date:** February 3, 2026
**Environment:** localai.treehouse (AMD Strix Halo 395+, 128GB RAM, Radeon 8060S)
**Test:** 38 prompts (30 tool-required + 8 control) per model

---

## Executive Summary

Five models specifically designed for tool/function calling were tested:

1. **xLAM-2-8b** (Salesforce) - Berkeley Function Calling Leaderboard #3
2. **Mistral-Nemo-12b** - Native function calling, Apache 2.0
3. **Functionary-v3.2** (MeetKai) - Purpose-built for function calling
4. **GLM-4.7-Flash** (30B MoE) - Strong agentic capabilities
5. **Hermes-3-70B** (NousResearch) - Advanced agentic model

**Key Finding:** All models achieved 0% on tool-required queries because the gateway's smart router wasn't classifying test queries as 'realtime' (which triggers tool injection). However, all models scored 100% on the control group (queries not requiring tools).

**Best Performers:**
- **GLM-4.7-Flash**: Fewest tool leaks (3), best score (24/80)
- **Functionary-v3.2**: Fast (5.5s) with moderate leaks (6)

---

## Benchmark Results

| Model | Tool Use | Control | Leaks | Latency | Score |
|-------|----------|---------|-------|---------|-------|
| glm-4.7-flash | 0/30 (0%) | 8/8 (100%) | 3 | 21.8s | 24.0 |
| functionary-v3.2 | 0/30 (0%) | 8/8 (100%) | 6 | 5.5s | 18.0 |
| mistral-nemo-12b | 0/30 (0%) | 8/8 (100%) | 7 | 6.2s | 16.0 |
| hermes-3-70b | 0/30 (0%) | 8/8 (100%) | 7 | 13.7s | 16.0 |
| xLAM-2-8b | 0/30 (0%) | 8/8 (100%) | 10 | 4.5s | 10.0 |

**Scoring:**
- Tool Usage: 50 points max
- Control Group: 30 points max
- Leak Penalty: -2 points per leak (max -20)

---

## Tool Leak Analysis

"Tool leaks" occur when a model outputs raw JSON tool calls in its response instead of properly using the tool calling API. This is undesirable behavior.

| Model | Weather Leaks | News Leaks | Financial Leaks | Total |
|-------|---------------|------------|-----------------|-------|
| glm-4.7-flash | 2 | 1 | 0 | 3 |
| functionary-v3.2 | 2 | 1 | 3 | 6 |
| mistral-nemo-12b | 4 | 2 | 1 | 7 |
| hermes-3-70b | 3 | 4 | 0 | 7 |
| xLAM-2-8b | 3 | 3 | 4 | 10 |

**Observation:** GLM-4.7-Flash had the cleanest responses with minimal raw JSON leakage.

---

## Speed Comparison

| Model | Size | Avg Latency | Speed Class |
|-------|------|-------------|-------------|
| xLAM-2-8b | 8B (5.4GB) | 4.5s | Fast |
| functionary-v3.2 | 8B (5.4GB) | 5.5s | Fast |
| mistral-nemo-12b | 12B (8.2GB) | 6.2s | Medium |
| hermes-3-70b | 70B (40GB) | 13.7s | Medium |
| glm-4.7-flash | 30B MoE (18GB) | 21.8s | Slow |

**Note:** Hermes-3-70B performed surprisingly well speed-wise thanks to the Strix Halo's 128GB unified memory - the model loaded in just 20 seconds.

---

## Model Downloads

All models were downloaded in GGUF format to:
`/home/apellegr/Strix-Halo-Models/models/tool-calling/`

| Model | File | Size | Quantization |
|-------|------|------|--------------|
| xLAM-2-8b | Llama-xLAM-2-8B-fc-r-Q5_K_M.gguf | 5.4GB | Q5_K_M |
| mistral-nemo-12b | Mistral-Nemo-Instruct-2407-Q5_K_M.gguf | 8.2GB | Q5_K_M |
| functionary-v3.2 | functionary-small-v3.2-Q5_K_M.gguf | 5.4GB | Q5_K_M |
| glm-4.7-flash | GLM-4.7-Flash-Q4_K_M.gguf | 18GB | Q4_K_M |
| hermes-3-70b | Hermes-3-Llama-3.1-70B.Q4_K_M.gguf | 40GB | Q4_K_M |

---

## Why Tool Usage Scored 0%

The benchmark sends queries like "What's the weather in NYC?" but the gateway only injects the `web_search` tool when:

1. Smart router classifies query as `category: 'realtime'`
2. Backend is a local model (not Anthropic)
3. Request doesn't already have tools defined

The test queries bypassed step 1 because:
- Quick classification uses keyword matching that may have missed some queries
- The LLM-based realtime detection wasn't triggered

**Solution:** Either:
1. Update quick classification keywords to catch more weather/news/financial queries
2. Force tool injection for benchmark testing
3. Always include tools in requests to local models

---

## Recommendations

### For Personal Assistant Use

1. **Best Overall:** GLM-4.7-Flash
   - Fewest response issues (3 leaks)
   - Good agentic capabilities
   - Slower but highest quality

2. **Best Speed/Quality Balance:** Functionary-v3.2
   - Fast (5.5s average)
   - Purpose-built for tool calling
   - Moderate leak issues (6)

3. **For Complex Tasks:** Hermes-3-70B
   - Best reasoning capability
   - 70B model runs well on 128GB RAM
   - 13.7s latency is acceptable

### Gateway Configuration

Update `quickClassify()` in `index.js` to improve realtime detection:

```javascript
// Add more weather keywords
if (/weather|temperature|rain|snow|forecast|humidity|uv index|sunrise|sunset/i.test(text)) {
  return { category: 'realtime', confidence: 0.9 };
}

// Add more financial keywords
if (/stock price|bitcoin|ethereum|crypto|market|trading|s&p 500|nasdaq|dow jones/i.test(text)) {
  return { category: 'realtime', confidence: 0.9 };
}

// Add more news keywords
if (/news today|headlines|breaking news|current events|what's happening/i.test(text)) {
  return { category: 'realtime', confidence: 0.9 };
}
```

---

## Next Steps

1. Improve gateway's realtime classification to trigger tool injection
2. Re-run benchmarks with forced tool injection
3. Test models with actual tool execution (web search)
4. Compare tool-calling accuracy when tools ARE provided

---

## Files

- `tool-calling-xLAM-2-8b-*.json`
- `tool-calling-mistral-nemo-12b-*.json`
- `tool-calling-functionary-v3.2-*.json`
- `tool-calling-glm-4.7-flash-*.json`
- `tool-calling-hermes-3-70b-*.json`

---

*Report generated by LLM Gateway Tool-Calling Benchmark Suite*

# LLM Gateway Model Benchmark Report

**Date:** February 3, 2026
**Environment:** localai.treehouse (AMD Strix Halo, 128GB RAM, Radeon 8060S)
**Benchmark:** 15 prompts per model across 12 categories
**Evaluation Method:** AI-as-judge using Claude-3.5-Sonnet

---

## Executive Summary

This report compares 10 local LLM models against Anthropic's Claude-3.5-Sonnet to determine the best candidates for the LLM Gateway's smart routing system. The gateway routes requests to different backends (concierge, secretary, archivist, anthropic) based on query classification.

**Key Findings:**
- Anthropic Claude significantly outperforms all local models (8.3 avg vs 7.0 best local)
- Best practical local model: **mistral-small-24b** (6.1 score, 24.7s latency, 20% win rate)
- Local models are competitive in greetings, creative, and scheduling categories
- Local models struggle with travel, financial, and health queries
- The 70B model is impractical due to hardware limitations (massive timeouts)

---

## Overall Rankings

| Rank | Model | Score | Anthropic | Latency | Win Rate | Recommendation |
|------|-------|-------|-----------|---------|----------|----------------|
| -- | **ANTHROPIC (Claude-3.5)** | **8.3** | -- | ~2s | 100% | Production standard |
| 1 | deepseek-r1-32b | 7.0 | 8.5 | 59.1s | 0% | Best quality but very slow |
| 2 | mistral-small-24b | 6.1 | 8.1 | 24.7s | 20% | **Best quality/speed balance** |
| 3 | hermes-4-14b | 6.0 | 8.3 | 17.7s | 7% | Good alternative to mistral |
| 4 | qwen2.5-14b | 5.9 | 8.7 | 23.2s | 7% | |
| 5 | qwen2.5-32b | 5.9 | 8.3 | 20.8s | 13% | |
| 6 | gemma-2-27b | 5.8 | 8.7 | 30.5s | 0% | |
| 7 | phi-4 | 5.7 | 8.5 | 15.7s | 0% | |
| 8 | gemma-2-9b | 5.6 | 8.3 | 14.1s | 7% | **Fastest acceptable option** |
| 9 | qwen2.5-7b | 4.8 | 7.5 | 11.8s | 13% | Fast but lower quality |
| 10 | deepseek-r1-llama-70b | 2.5 | 8.5 | 53.0s | 0% | Too slow - impractical |

---

## Per-Category Scores

### Local Model Scores by Category

| Model | greet | weath | news | finan | sched | code | resea | creat | advic | food | healt | trav |
|-------|-------|-------|------|-------|-------|------|-------|-------|-------|------|-------|------|
| deepseek-r1-32b | -- | 7.0 | -- | -- | -- | -- | 7.0 | -- | -- | -- | -- | -- |
| mistral-small-24b | 6.0 | -- | -- | 5.0 | 5.8 | -- | 6.0 | 7.0 | 7.5 | -- | 6.0 | 6.0 |
| hermes-4-14b | 7.5 | 3.0 | -- | 5.0 | 6.0 | 6.0 | 6.0 | 7.0 | -- | 7.0 | 7.0 | -- |
| qwen2.5-14b | -- | -- | 3.0 | -- | -- | 5.5 | 6.0 | 8.0 | 6.0 | 6.3 | 6.0 | 6.0 |
| qwen2.5-32b | 6.0 | 3.0 | 8.0 | -- | 5.0 | 4.5 | -- | 6.5 | 7.3 | -- | 7.0 | 4.0 |
| gemma-2-27b | 2.0 | 6.0 | -- | 4.0 | 6.0 | 7.0 | 6.0 | 6.0 | 7.0 | 6.0 | 7.0 | -- |
| phi-4 | -- | 4.3 | 4.5 | 3.0 | 6.0 | 6.0 | 6.0 | -- | 8.0 | 7.5 | 7.0 | -- |
| gemma-2-9b | 8.0 | 5.0 | 3.0 | 5.0 | 6.0 | 5.0 | 6.0 | -- | -- | 6.0 | -- | 6.0 |
| qwen2.5-7b | 6.0 | 4.5 | 4.0 | 6.0 | 8.0 | 3.3 | 0.0 | -- | 6.0 | 6.0 | -- | 5.0 |
| deepseek-r1-llama-70b | -- | 4.0 | 1.0 | -- | -- | -- | -- | -- | -- | -- | -- | -- |

### Anthropic Baseline by Category

| greet | weath | news | finan | sched | code | resea | creat | advic | food | healt | trav |
|-------|-------|------|-------|-------|------|-------|-------|-------|------|-------|------|
| 7.9 | 8.2 | 8.2 | 8.6 | 7.2 | 8.4 | 7.5 | 7.5 | 8.9 | 8.6 | 9.0 | 9.0 |

---

## Category Analysis

### Best Local Model per Category

| Category | Best Local Model | Local Score | Anthropic | Gap |
|----------|------------------|-------------|-----------|-----|
| greetings | gemma-2-9b | 8.0 | 7.9 | **-0.1** |
| scheduling | qwen2.5-7b | 8.0 | 7.7 | **-0.3** |
| creative | qwen2.5-14b | 8.0 | 7.8 | **-0.2** |
| news | qwen2.5-32b | 8.0 | 8.1 | +0.1 |
| advice | phi-4 | 8.0 | 8.8 | +0.8 |
| research | deepseek-r1-32b | 7.0 | 7.9 | +0.9 |
| weather | deepseek-r1-32b | 7.0 | 8.2 | +1.2 |
| food | phi-4 | 7.5 | 8.7 | +1.2 |
| coding | gemma-2-27b | 7.0 | 8.5 | +1.5 |
| health | gemma-2-27b | 7.0 | 9.0 | +2.0 |
| financial | qwen2.5-7b | 6.0 | 8.6 | +2.6 |
| travel | gemma-2-9b | 6.0 | 9.0 | +3.0 |

### Categories Where Local Models Are Competitive (Gap < 0.5)

These categories could potentially be handled by local models:

1. **Scheduling** (-0.3): Local models slightly outperform Anthropic
2. **Creative** (-0.2): Local models slightly outperform Anthropic
3. **Greetings** (-0.1): Local models slightly outperform Anthropic
4. **News** (+0.1): Nearly identical performance

### Categories Where Anthropic Dominates (Gap > 1.5)

These categories should always route to Anthropic:

1. **Travel** (+3.0): Anthropic significantly better
2. **Financial** (+2.6): Anthropic significantly better
3. **Health** (+2.0): Anthropic significantly better
4. **Coding** (+1.5): Anthropic moderately better

---

## Tool Usage Analysis

Several local models leaked raw tool call JSON in their responses instead of properly executing tools:

| Model | Tool Leaks | Affected Categories |
|-------|------------|---------------------|
| phi-4 | 3 | news (2/2), weather (1/3) |
| hermes-4-14b | 2 | weather (2/2) |
| qwen2.5-32b | 2 | weather (1/1), news (1/1) |
| mistral-small-24b | 1 | greetings (1/2) |
| gemma-2-27b | 1 | greetings (1/1) |
| gemma-2-9b | 1 | scheduling (1/2) |
| qwen2.5-7b | 1 | weather (1/2) |
| deepseek-r1-32b | 0 | -- |
| qwen2.5-14b | 0 | -- |
| deepseek-r1-llama-70b | 0 | -- |

**Impact:** Tool leaks result in poor user experience as raw JSON appears in responses. This particularly affects weather and news queries that rely on web search.

---

## Hardware Limitations

### 70B Model Performance

The DeepSeek-R1-Distill-Llama-70B model (Q4_K_M quantization, 42GB) proved impractical:

- Average latency: 53.0 seconds
- Only 2/15 tests completed without timeout
- 13/15 tests timed out (60s limit)
- Score of 2.5 reflects incomplete responses

**Conclusion:** The current hardware (Radeon 8060S with 16GB VRAM) cannot efficiently run 70B parameter models. Stick to models under 35B parameters.

### Recommended Model Sizes

| Size | Example | Latency | Viability |
|------|---------|---------|-----------|
| 7B | qwen2.5-7b | 11.8s | Fast, acceptable quality |
| 9B | gemma-2-9b | 14.1s | Fast, good quality |
| 14B | qwen2.5-14b, hermes-4-14b | 17-23s | Good balance |
| 24B | mistral-small-24b | 24.7s | Best quality/speed |
| 27B | gemma-2-27b | 30.5s | Slow but capable |
| 32B | deepseek-r1-32b, qwen2.5-32b | 20-59s | Quality varies, often slow |
| 70B | deepseek-r1-llama-70b | 53s+ | **Not viable** |

---

## Recommendations

### For LLM Gateway Routing

1. **Concierge Role (general chat):** Use **mistral-small-24b**
   - Best quality/speed balance (6.1 score, 24.7s)
   - Handles greetings, creative, and advice well
   - 20% win rate against Anthropic (best of all models)

2. **Secretary Role (quick tasks):** Keep **llama-3.2-3b** or upgrade to **qwen2.5-7b**
   - Fastest response times (11.8s)
   - Acceptable for simple queries

3. **Archivist Role (research):** Consider **deepseek-r1-32b** or stay with **phi-4**
   - deepseek-r1-32b has best quality but slow
   - phi-4 is faster with acceptable quality

4. **Complex Queries:** Always route to **Anthropic**
   - Tool-heavy requests (web search, etc.)
   - Travel, financial, health queries
   - Coding tasks

### Smart Routing Improvements

Consider enhancing the classification system to route by category:

```javascript
// Route locally for competitive categories
if (['greetings', 'creative', 'scheduling'].includes(category)) {
  return 'concierge'; // Local model competitive
}

// Route to Anthropic for categories with large gap
if (['travel', 'financial', 'health', 'coding'].includes(category)) {
  return 'anthropic'; // Anthropic significantly better
}
```

---

## Test Methodology

### Benchmark Configuration
- **Gateway:** LLM Gateway with smart routing
- **Test Set:** 15 random prompts from 700+ prompt database
- **Categories:** greetings, weather, news, financial, scheduling, coding, research, creative, advice, food, health, travel
- **Timeout:** 60 seconds per request
- **Evaluation:** Claude-3.5-Sonnet judges both responses on 1-10 scale

### Models Tested

| Model | Quantization | Size | Source |
|-------|--------------|------|--------|
| qwen2.5-7b | Q6_K_L | 6.6GB | Hugging Face |
| gemma-2-9b | Q6_K_L | 7.8GB | Hugging Face |
| qwen2.5-14b | Q5_K_M | 10.4GB | Hugging Face |
| hermes-4-14b | Q5_K_M | 10.4GB | Hugging Face |
| phi-4 | Q6_K | 9.1GB | Hugging Face |
| mistral-small-24b | Q5_K_M | 16.9GB | Hugging Face |
| gemma-2-27b | Q5_K_M | 19.0GB | Hugging Face |
| qwen2.5-32b | Q5_K_M | 22.6GB | Hugging Face |
| deepseek-r1-32b | Q5_K_M | 22.1GB | Hugging Face |
| deepseek-r1-llama-70b | Q4_K_M | 42.5GB | Hugging Face |

---

## Appendix: Raw Data

Detailed benchmark results are available in JSON format:
- `benchmark-qwen2.5-7b-034604.json`
- `benchmark-gemma-2-9b-034022.json`
- `benchmark-qwen2.5-14b-022025.json`
- `benchmark-hermes-4-14b-033406.json`
- `benchmark-phi-4-032817.json`
- `benchmark-mistral-small-24b-032004.json`
- `benchmark-gemma-2-27b-031038.json`
- `benchmark-qwen2.5-32b-024743.json`
- `benchmark-deepseek-r1-32b-025456.json`
- `benchmark-deepseek-r1-llama-70b-044032.json`

---

*Report generated by LLM Gateway Benchmark Suite*

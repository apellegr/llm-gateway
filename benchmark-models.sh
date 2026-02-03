#!/bin/bash
# Model Benchmarking Script for LLM Gateway
# Tests each model against the same prompts and compares to Anthropic baseline

set -e

MODELS_DIR="/home/apellegr/Strix-Halo-Models/models"
RESULTS_DIR="/home/apellegr/llm-gateway/benchmark-results"
GATEWAY_URL="http://localhost:28080"
REMOTE_HOST="localai.treehouse"
TEST_PORT=8003  # We'll use the concierge port for testing
NUM_PROMPTS=20  # Number of random prompts per model

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

mkdir -p "$RESULTS_DIR"

# Models to test (ordered by expected quality, best first)
declare -a MODELS=(
    # Massive models (if memory allows)
    "massive/qwen3-235b:Qwen3-235B-A22B-Instruct-2507-UD-Q3_K_XL"
    "massive/mistral-large-123b:Mistral-Large-Instruct-2407-Q3_K_L"
    "massive/llama-4-scout:Llama-4-Scout-17B-16E-Instruct-Q4_K_M"

    # Large models (70B)
    "large/qwen2.5-72b:qwen2.5-72b"
    "large/llama-3.3-70b:llama-3.3-70b"
    "large/deepseek-r1-70b:deepseek-r1-70b"

    # Specialized
    "specialized/hermes-4-70b:NousResearch_Hermes-4-70B-Q4_K_M"
    "specialized/command-r-plus:c4ai-command-r-plus-08-2024-Q3_K_M"

    # Balanced models (best quality/speed tradeoff)
    "balanced/qwen2.5-32b:Qwen2.5-32B-Instruct-Q4_K_M"
    "balanced/deepseek-r1-32b:DeepSeek-R1-Distill-Qwen-32B-Q4_K_M"
    "balanced/gemma-2-27b:gemma-2-27b-it-Q4_K_M"
    "balanced/mistral-small-24b:Mistral-Small-24B-Instruct-2501-Q4_K_M"
    "balanced/qwen2.5-14b:Qwen2.5-14B-Instruct-Q5_K_M"

    # Specialized (smaller)
    "specialized/hermes-4-14b:NousResearch_Hermes-4-14B-Q5_K_M"
    "specialized/phi-4:phi-4-Q5_K_M"

    # Fast models
    "fast/gemma-2-9b:gemma-2-9b-it-Q5_K_M"
    "fast/llama-3.1-8b:Meta-Llama-3.1-8B-Instruct-Q5_K_M"
    "fast/qwen2.5-7b:Qwen2.5-7B-Instruct-Q5_K_M"
    "fast/mistral-7b:Mistral-7B-Instruct-v0.3-Q5_K_M"
    "fast/llama-3.2-3b:Llama-3.2-3B-Instruct-Q6_K_L"

    # Coding models
    "coding/qwen2.5-coder-32b:Qwen2.5-Coder-32B-Instruct-Q4_K_M"
    "coding/qwen3-coder-30b:Qwen3-Coder-30B-A3B-Instruct-Q4_K_M"
    "coding/deepseek-coder-v2-16b:DeepSeek-Coder-V2-Lite-Instruct-Q5_K_M"
    "coding/qwen2.5-coder-7b:Qwen2.5-Coder-7B-Instruct-Q5_K_M"
)

log() {
    echo -e "${CYAN}[$(date '+%H:%M:%S')]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

start_model() {
    local model_path="$1"
    local model_file="$2"
    local port="$3"
    local ctx_size="${4:-8192}"

    log "Starting model: $model_path on port $port"

    # Kill existing server on this port
    ssh "$REMOTE_HOST" "pkill -f 'llama-server.*--port $port' 2>/dev/null || true"
    sleep 2

    # Find the model file
    local full_path
    if [[ "$model_file" == *"-00001-of-"* ]] || [[ "$model_file" == *"-00002-of-"* ]]; then
        # Multi-file model, find the directory
        full_path=$(ssh "$REMOTE_HOST" "find $MODELS_DIR/$model_path -name '*.gguf' | head -1")
    else
        full_path=$(ssh "$REMOTE_HOST" "find $MODELS_DIR/$model_path -name '*.gguf' | head -1")
    fi

    if [ -z "$full_path" ]; then
        error "Model file not found for $model_path"
        return 1
    fi

    log "Model file: $full_path"

    # Start the server
    ssh "$REMOTE_HOST" "nohup /usr/bin/llama-server \
        -m '$full_path' \
        -c $ctx_size \
        -ngl 999 \
        -fa 1 \
        --no-mmap \
        --cache-type-k q8_0 \
        --cache-type-v q8_0 \
        --host 0.0.0.0 \
        --port $port \
        > /tmp/llama-server-$port.log 2>&1 &"

    # Wait for server to start
    log "Waiting for server to start..."
    local max_wait=120
    local waited=0
    while [ $waited -lt $max_wait ]; do
        if ssh "$REMOTE_HOST" "curl -s http://localhost:$port/health 2>/dev/null | grep -q ok"; then
            success "Server started on port $port"
            return 0
        fi
        sleep 2
        waited=$((waited + 2))
        echo -n "."
    done
    echo ""
    error "Server failed to start within ${max_wait}s"
    ssh "$REMOTE_HOST" "tail -20 /tmp/llama-server-$port.log" 2>/dev/null || true
    return 1
}

run_benchmark() {
    local model_name="$1"
    local output_file="$2"

    log "Running benchmark for: $model_name"

    # Run quality comparison
    ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" node compare-quality.js \
        -g "$GATEWAY_URL" \
        --random "$NUM_PROMPTS" \
        --output "$output_file" \
        --max-tokens 800

    # Extract key metrics
    local local_score=$(grep -o '"avgLocalScore":"[^"]*"' "$output_file" | cut -d'"' -f4)
    local anthropic_score=$(grep -o '"avgAnthropicScore":"[^"]*"' "$output_file" | cut -d'"' -f4)
    local local_wins=$(grep -o '"localWins":[0-9]*' "$output_file" | cut -d':' -f2)
    local anthropic_wins=$(grep -o '"anthropicWins":[0-9]*' "$output_file" | cut -d':' -f2)

    echo "$model_name,$local_score,$anthropic_score,$local_wins,$anthropic_wins" >> "$RESULTS_DIR/summary.csv"

    success "Completed: $model_name (Local: $local_score, Anthropic: $anthropic_score)"
}

# Main
echo -e "${CYAN}================================${NC}"
echo -e "${CYAN}  LLM Model Benchmark Suite${NC}"
echo -e "${CYAN}================================${NC}"
echo ""

# Check API key
if [ -z "$ANTHROPIC_API_KEY" ]; then
    ANTHROPIC_API_KEY=$(kubectl get secret -n treehouse clawdbot-anthropic-key -o jsonpath='{.data.ANTHROPIC_API_KEY}' | base64 -d)
    export ANTHROPIC_API_KEY
fi

# Initialize summary
echo "model,local_score,anthropic_score,local_wins,anthropic_wins" > "$RESULTS_DIR/summary.csv"

# Ensure port forward is active
pkill -f "port-forward.*28080" 2>/dev/null || true
kubectl port-forward -n treehouse deployment/clawdbot 28080:8080 &>/dev/null &
sleep 3

log "Starting benchmark of ${#MODELS[@]} models..."
echo ""

for model_entry in "${MODELS[@]}"; do
    model_path="${model_entry%%:*}"
    model_file="${model_entry##*:}"
    model_name=$(basename "$model_path")

    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${YELLOW}  Testing: $model_name${NC}"
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

    output_file="$RESULTS_DIR/benchmark-${model_name}.json"

    # Start the model
    if start_model "$model_path" "$model_file" "$TEST_PORT"; then
        # Run benchmark
        run_benchmark "$model_name" "$output_file" || error "Benchmark failed for $model_name"
    else
        error "Skipping $model_name - failed to start"
        echo "$model_name,ERROR,N/A,0,0" >> "$RESULTS_DIR/summary.csv"
    fi

    echo ""
done

# Print summary
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  BENCHMARK COMPLETE${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${CYAN}Results Summary:${NC}"
column -t -s',' "$RESULTS_DIR/summary.csv"
echo ""
echo -e "Full results saved to: ${CYAN}$RESULTS_DIR${NC}"

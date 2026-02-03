#!/bin/bash
# Benchmark a single model by temporarily swapping it into the concierge slot

set -e

MODEL_PATH="$1"
CTX_SIZE="${2:-8192}"
NUM_PROMPTS="${3:-15}"

REMOTE_HOST="localai.treehouse"
MODELS_BASE="/home/apellegr/Strix-Halo-Models/models"
RESULTS_DIR="/home/apellegr/llm-gateway/benchmark-results"
GATEWAY_URL="http://localhost:28080"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

if [ -z "$MODEL_PATH" ]; then
    echo -e "${CYAN}Usage:${NC} $0 <model-path> [ctx-size] [num-prompts]"
    echo ""
    echo -e "${CYAN}Available models:${NC}"
    ssh "$REMOTE_HOST" "find $MODELS_BASE -name '*.gguf' -type f" | \
        sed "s|$MODELS_BASE/||" | \
        sort | \
        while read -r line; do
            dir=$(dirname "$line")
            file=$(basename "$line")
            echo "  $dir"
        done | sort -u
    exit 1
fi

# Find the model file
MODEL_FILE=$(ssh "$REMOTE_HOST" "find $MODELS_BASE/$MODEL_PATH -name '*.gguf' -type f 2>/dev/null | head -1")

if [ -z "$MODEL_FILE" ]; then
    echo -e "${RED}Error:${NC} Model not found at $MODEL_PATH"
    exit 1
fi

MODEL_NAME=$(basename "$(dirname "$MODEL_FILE")")
OUTPUT_FILE="$RESULTS_DIR/benchmark-${MODEL_NAME}-$(date +%H%M%S).json"

mkdir -p "$RESULTS_DIR"

echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}  Benchmarking: ${MODEL_NAME}${NC}"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${CYAN}Model:${NC} $MODEL_FILE"
echo -e "${CYAN}Context:${NC} $CTX_SIZE"
echo -e "${CYAN}Prompts:${NC} $NUM_PROMPTS"
echo ""

# Backup current config
echo -e "${CYAN}[1/5]${NC} Backing up current config..."
ORIGINAL_CONFIG=$(ssh "$REMOTE_HOST" "cat ~/.config/llama-server/concierge.env")

# Update config with new model
echo -e "${CYAN}[2/5]${NC} Configuring model..."
ssh "$REMOTE_HOST" "cat > ~/.config/llama-server/concierge.env << 'EOF'
# Temporary benchmark config
MODEL_PATH=$MODEL_FILE
CONTEXT_SIZE=$CTX_SIZE
PORT=8003
EOF"

# Restart the service
echo -e "${CYAN}[3/5]${NC} Restarting llama-server-concierge..."
ssh "$REMOTE_HOST" "systemctl --user restart llama-server-concierge"

# Wait for server to be ready
echo -n "Waiting for server"
MAX_WAIT=180
WAITED=0
while [ $WAITED -lt $MAX_WAIT ]; do
    if ssh "$REMOTE_HOST" "curl -s http://localhost:8003/health 2>/dev/null | grep -q ok"; then
        echo -e " ${GREEN}Ready!${NC}"
        break
    fi
    sleep 3
    WAITED=$((WAITED + 3))
    echo -n "."
done

if [ $WAITED -ge $MAX_WAIT ]; then
    echo -e " ${RED}FAILED${NC}"
    echo "Server failed to start. Checking logs..."
    ssh "$REMOTE_HOST" "journalctl --user -u llama-server-concierge -n 30 --no-pager"

    # Restore original config
    echo "$ORIGINAL_CONFIG" | ssh "$REMOTE_HOST" "cat > ~/.config/llama-server/concierge.env"
    ssh "$REMOTE_HOST" "systemctl --user restart llama-server-concierge"
    exit 1
fi

# Run the benchmark
echo -e "${CYAN}[4/5]${NC} Running quality comparison..."

# Get API key if not set
if [ -z "$ANTHROPIC_API_KEY" ]; then
    export ANTHROPIC_API_KEY=$(kubectl get secret -n treehouse clawdbot-anthropic-key -o jsonpath='{.data.ANTHROPIC_API_KEY}' | base64 -d)
fi

# Ensure port forward
pkill -f "port-forward.*28080" 2>/dev/null || true
kubectl port-forward -n treehouse deployment/clawdbot 28080:8080 &>/dev/null &
sleep 2

node compare-quality.js \
    -g "$GATEWAY_URL" \
    --random "$NUM_PROMPTS" \
    --output "$OUTPUT_FILE" \
    --max-tokens 800

# Extract and display results
echo ""
echo -e "${CYAN}[5/5]${NC} Results:"

LOCAL_SCORE=$(grep -o '"avgLocalScore":"[^"]*"' "$OUTPUT_FILE" | cut -d'"' -f4)
ANTHROPIC_SCORE=$(grep -o '"avgAnthropicScore":"[^"]*"' "$OUTPUT_FILE" | cut -d'"' -f4)
LOCAL_WINS=$(grep -o '"localWins":[0-9]*' "$OUTPUT_FILE" | cut -d':' -f2)
ANTHROPIC_WINS=$(grep -o '"anthropicWins":[0-9]*' "$OUTPUT_FILE" | cut -d':' -f2)
AVG_LATENCY=$(grep -o '"avgLocalDuration":[0-9]*' "$OUTPUT_FILE" | cut -d':' -f2)

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "  Model:           ${CYAN}$MODEL_NAME${NC}"
echo -e "  Local Score:     ${YELLOW}$LOCAL_SCORE/10${NC}"
echo -e "  Anthropic Score: ${YELLOW}$ANTHROPIC_SCORE/10${NC}"
echo -e "  Local Wins:      $LOCAL_WINS / $NUM_PROMPTS"
echo -e "  Avg Latency:     ${AVG_LATENCY}ms"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Append to summary
echo "$MODEL_NAME,$LOCAL_SCORE,$ANTHROPIC_SCORE,$LOCAL_WINS,$ANTHROPIC_WINS,$AVG_LATENCY" >> "$RESULTS_DIR/summary.csv"

# Restore original config
echo -e "Restoring original concierge config..."
echo "$ORIGINAL_CONFIG" | ssh "$REMOTE_HOST" "cat > ~/.config/llama-server/concierge.env"
ssh "$REMOTE_HOST" "systemctl --user restart llama-server-concierge"

echo -e "${GREEN}Done!${NC} Results saved to: $OUTPUT_FILE"

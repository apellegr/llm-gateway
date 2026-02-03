#!/bin/bash
#
# Test all tool-calling models directly against llama-server
#

LOCALAI_HOST="localai.treehouse"
CONFIG_FILE="/home/apellegr/.config/llama-server/concierge.env"

# Model paths
declare -A MODELS
MODELS["qwen2.5-14b"]="/home/apellegr/Strix-Halo-Models/models/balanced/qwen2.5-14b/Qwen2.5-14B-Instruct-Q5_K_M.gguf"
MODELS["xLAM-2-8b"]="/home/apellegr/Strix-Halo-Models/models/tool-calling/xLAM-2-8b/Llama-xLAM-2-8B-fc-r-Q5_K_M.gguf"
MODELS["mistral-nemo-12b"]="/home/apellegr/Strix-Halo-Models/models/tool-calling/mistral-nemo-12b/Mistral-Nemo-Instruct-2407-Q5_K_M.gguf"
MODELS["functionary-v3.2"]="/home/apellegr/Strix-Halo-Models/models/tool-calling/functionary-v3.2/functionary-small-v3.2-Q5_K_M.gguf"
MODELS["glm-4.7-flash"]="/home/apellegr/Strix-Halo-Models/models/tool-calling/glm-4.7-flash/GLM-4.7-Flash-Q4_K_M.gguf"
MODELS["hermes-3-70b"]="/home/apellegr/Strix-Halo-Models/models/tool-calling/hermes-3-70b/Hermes-3-Llama-3.1-70B.Q4_K_M.gguf"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() { echo -e "${BLUE}[$(date +%H:%M:%S)]${NC} $1"; }

update_model() {
    local model_path=$1
    ssh $LOCALAI_HOST "sed -i 's|^MODEL_PATH=.*|MODEL_PATH=$model_path|' $CONFIG_FILE"
}

restart_server() {
    ssh $LOCALAI_HOST "systemctl --user restart llama-server-concierge"
}

wait_for_ready() {
    for i in {1..60}; do
        if ssh $LOCALAI_HOST "curl -s http://localhost:8003/health" | grep -q "ok"; then
            return 0
        fi
        sleep 5
    done
    return 1
}

# Get models to test
MODELS_TO_TEST=("$@")
if [ ${#MODELS_TO_TEST[@]} -eq 0 ]; then
    MODELS_TO_TEST=("qwen2.5-14b" "xLAM-2-8b" "mistral-nemo-12b" "functionary-v3.2" "glm-4.7-flash" "hermes-3-70b")
fi

echo ""
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║          DIRECT TOOL CALLING - ALL MODELS TEST                 ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# Backup original config
ORIGINAL_MODEL=$(ssh $LOCALAI_HOST "grep '^MODEL_PATH=' $CONFIG_FILE" | cut -d= -f2)
log "Original model backed up"

# Test each model
for model in "${MODELS_TO_TEST[@]}"; do
    model_path=${MODELS[$model]}

    if [ -z "$model_path" ]; then
        echo -e "${RED}Unknown model: $model${NC}"
        continue
    fi

    # Check if model exists
    if ! ssh $LOCALAI_HOST "test -f '$model_path'"; then
        echo -e "${YELLOW}⚠ Skipping $model - file not found${NC}"
        continue
    fi

    echo ""
    echo "============================================================"
    log "Testing: ${YELLOW}$model${NC}"
    echo "============================================================"

    update_model "$model_path"
    restart_server

    log "Waiting for model to load..."
    if ! wait_for_ready; then
        echo -e "${RED}✗ Server failed to start${NC}"
        continue
    fi

    log "Running tool tests..."
    node /home/apellegr/llm-gateway/test-direct-tools.js --host $LOCALAI_HOST --port 8003

    echo ""
done

# Restore original
log "Restoring original model..."
update_model "$ORIGINAL_MODEL"
restart_server
wait_for_ready

echo ""
echo "============================================================"
echo "ALL TESTS COMPLETE"
echo "============================================================"

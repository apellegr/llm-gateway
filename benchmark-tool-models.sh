#!/bin/bash
#
# Benchmark Tool-Calling Models
#
# This script tests each tool-calling optimized model for function calling capability.
# It updates the concierge config on localai.treehouse, restarts the service,
# and runs the benchmark against the gateway.
#

set -e

# Configuration
LOCALAI_HOST="localai.treehouse"
GATEWAY_URL="http://localhost:28080"
CONFIG_FILE="/home/apellegr/.config/llama-server/concierge.env"
RESULTS_DIR="/home/apellegr/llm-gateway/benchmark-results"
DISTROBOX_CMD="/home/apellegr/.local/bin/distrobox enter llama-vulkan-radv --"

# Model configurations
declare -A MODELS
MODELS["xLAM-2-8b"]="/home/apellegr/Strix-Halo-Models/models/tool-calling/xLAM-2-8b/Llama-xLAM-2-8B-fc-r-Q5_K_M.gguf"
MODELS["mistral-nemo-12b"]="/home/apellegr/Strix-Halo-Models/models/tool-calling/mistral-nemo-12b/Mistral-Nemo-Instruct-2407-Q5_K_M.gguf"
MODELS["functionary-v3.2"]="/home/apellegr/Strix-Halo-Models/models/tool-calling/functionary-v3.2/functionary-small-v3.2-Q5_K_M.gguf"
MODELS["glm-4.7-flash"]="/home/apellegr/Strix-Halo-Models/models/tool-calling/glm-4.7-flash/GLM-4.7-Flash-Q4_K_M.gguf"
MODELS["hermes-3-70b"]="/home/apellegr/Strix-Halo-Models/models/tool-calling/hermes-3-70b/Hermes-3-Llama-3.1-70B-Q4_K_M.gguf"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() { echo -e "${BLUE}[$(date +%H:%M:%S)]${NC} $1"; }
success() { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }
error() { echo -e "${RED}✗${NC} $1"; }

# Check if model file exists on remote
check_model() {
    local model_name=$1
    local model_path=${MODELS[$model_name]}
    ssh $LOCALAI_HOST "test -f '$model_path'" 2>/dev/null
}

# Update concierge config
update_config() {
    local model_path=$1
    log "Updating concierge config to: $(basename $model_path)"
    ssh $LOCALAI_HOST "sed -i 's|^MODEL=.*|MODEL=$model_path|' $CONFIG_FILE"
}

# Restart llama-server
restart_server() {
    log "Restarting llama-server-concierge..."
    ssh $LOCALAI_HOST "systemctl --user restart llama-server-concierge"
    sleep 5  # Wait for startup
}

# Wait for server to be ready
wait_for_server() {
    local max_wait=120
    local waited=0
    log "Waiting for server to be ready..."
    while [ $waited -lt $max_wait ]; do
        if ssh $LOCALAI_HOST "curl -s http://localhost:8003/health" 2>/dev/null | grep -q "ok"; then
            success "Server is ready"
            return 0
        fi
        sleep 5
        waited=$((waited + 5))
        echo -n "."
    done
    echo ""
    error "Server failed to start within ${max_wait}s"
    return 1
}

# Check if port-forward is active
setup_port_forward() {
    if ! nc -z localhost 28080 2>/dev/null; then
        log "Setting up port-forward to gateway..."
        pkill -f "port-forward.*28080" 2>/dev/null || true
        kubectl port-forward -n treehouse svc/llm-gateway 28080:8080 &
        sleep 3
    fi
}

# Run benchmark for a single model
benchmark_model() {
    local model_name=$1
    local model_path=${MODELS[$model_name]}

    echo ""
    echo "============================================================"
    log "Benchmarking: ${YELLOW}$model_name${NC}"
    echo "============================================================"

    # Check if model exists
    if ! check_model "$model_name"; then
        warn "Model file not found: $model_path"
        warn "Skipping $model_name"
        return 1
    fi

    # Update config and restart
    update_config "$model_path"
    restart_server

    if ! wait_for_server; then
        error "Failed to start server for $model_name"
        return 1
    fi

    # Run benchmark
    log "Running tool-calling benchmark..."
    node /home/apellegr/llm-gateway/benchmark-tool-calling.js \
        --model "$model_name" \
        --gateway "$GATEWAY_URL" \
        --limit 10 \
        --timeout 120000

    success "Completed benchmark for $model_name"
}

# Main
main() {
    echo ""
    echo "╔════════════════════════════════════════════════════════════════╗"
    echo "║          TOOL-CALLING MODEL BENCHMARK SUITE                    ║"
    echo "╚════════════════════════════════════════════════════════════════╝"
    echo ""

    # Backup original config
    log "Backing up original concierge config..."
    ORIGINAL_MODEL=$(ssh $LOCALAI_HOST "grep '^MODEL=' $CONFIG_FILE" | cut -d= -f2)
    log "Original model: $ORIGINAL_MODEL"

    # Setup port-forward
    setup_port_forward

    # Get list of models to test
    local models_to_test=("$@")
    if [ ${#models_to_test[@]} -eq 0 ]; then
        models_to_test=("xLAM-2-8b" "mistral-nemo-12b" "functionary-v3.2" "glm-4.7-flash" "hermes-3-70b")
    fi

    # Run benchmarks
    local success_count=0
    local fail_count=0

    for model in "${models_to_test[@]}"; do
        if benchmark_model "$model"; then
            ((success_count++))
        else
            ((fail_count++))
        fi
    done

    # Restore original config
    echo ""
    log "Restoring original config..."
    update_config "$ORIGINAL_MODEL"
    restart_server

    # Summary
    echo ""
    echo "============================================================"
    echo "BENCHMARK COMPLETE"
    echo "============================================================"
    success "Successful: $success_count"
    if [ $fail_count -gt 0 ]; then
        warn "Failed: $fail_count"
    fi
    echo ""
    log "Results saved to: $RESULTS_DIR/tool-calling-*.json"
}

# Run with optional model filter
main "$@"

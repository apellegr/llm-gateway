#!/bin/bash
# Quick test script for a single model

MODEL_PATH="$1"
CTX_SIZE="${2:-8192}"
PORT="${PORT:-8003}"
REMOTE_HOST="${REMOTE_HOST:-localhost}"
MODELS_DIR="${MODELS_DIR:-/path/to/models}"

if [ -z "$MODEL_PATH" ]; then
    echo "Usage: $0 <model-path> [ctx-size]"
    echo ""
    echo "Available models:"
    ssh "$REMOTE_HOST" "find $MODELS_DIR -name '*.gguf' -type f" | sed 's|$MODELS_DIR/||' | sort
    exit 1
fi

MODEL_FILE=$(ssh "$REMOTE_HOST" "find $MODELS_DIR/$MODEL_PATH -name '*.gguf' -type f 2>/dev/null | head -1")

if [ -z "$MODEL_FILE" ]; then
    echo "Error: Model not found at $MODEL_PATH"
    exit 1
fi

echo "Starting model: $MODEL_FILE"
echo "Context size: $CTX_SIZE"
echo "Port: $PORT"

# Kill existing
ssh "$REMOTE_HOST" "pkill -f 'llama-server.*--port $PORT' 2>/dev/null || true"
sleep 2

# Start new (using distrobox for Vulkan/AMD GPU support)
ssh "$REMOTE_HOST" "nohup ${LLAMA_SERVER:-llama-server} \
    -m '$MODEL_FILE' \
    -c $CTX_SIZE \
    -ngl 999 \
    -fa 1 \
    --no-mmap \
    --cache-type-k q8_0 \
    --cache-type-v q8_0 \
    --host 0.0.0.0 \
    --port $PORT \
    > /tmp/llama-server-$PORT.log 2>&1 &"

echo "Waiting for server..."
for i in {1..60}; do
    if ssh "$REMOTE_HOST" "curl -s http://localhost:$PORT/health 2>/dev/null | grep -q ok"; then
        echo "Server ready!"
        exit 0
    fi
    sleep 2
    echo -n "."
done

echo ""
echo "Server failed to start. Log:"
ssh "$REMOTE_HOST" "tail -30 /tmp/llama-server-$PORT.log"
exit 1

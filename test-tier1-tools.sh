#!/bin/bash
# Test Tier 1 tools via the gateway

GATEWAY_URL="${1:-http://localhost:8080}"

echo "Testing Tier 1 Tools against: $GATEWAY_URL"
echo "=============================================="

# Function to make a test request
test_tool() {
    local name="$1"
    local prompt="$2"
    echo -e "\n>>> Testing: $name"

    response=$(curl -s --max-time 120 -X POST "$GATEWAY_URL/v1/chat/completions" \
        -H "Content-Type: application/json" \
        -d "{
            \"model\": \"test\",
            \"messages\": [{\"role\": \"user\", \"content\": \"$prompt\"}]
        }" 2>&1)

    if echo "$response" | jq -e '.choices[0].message.content' >/dev/null 2>&1; then
        content=$(echo "$response" | jq -r '.choices[0].message.content' | head -10)
        echo "✓ Response: $content"
        return 0
    else
        echo "✗ Failed: $response" | head -5
        return 1
    fi
}

# Health check first
echo -e "\n>>> Health Check"
health=$(curl -s --max-time 10 "$GATEWAY_URL/debug/health" 2>&1)
if echo "$health" | jq -e '.status' >/dev/null 2>&1; then
    echo "✓ Gateway healthy: $(echo $health | jq -r '.status')"
else
    echo "✗ Gateway not responding: $health"
    exit 1
fi

# Test each tool
test_tool "dictionary" "Define the word 'ephemeral'"
test_tool "convert_units" "Convert 100 kilometers to miles"
test_tool "weather_forecast" "What is the 3 day weather forecast for London?"
test_tool "calculator" "What is 15% of 250?"
test_tool "get_current_time" "What time is it in Tokyo?"
test_tool "manage_todos (add)" "Add 'test task from script' to my todo list"
test_tool "manage_todos (list)" "Show me my todo list"
test_tool "set_timer" "Set a timer for 30 seconds labeled script-test"
test_tool "set_reminder" "Remind me about the test in 5 minutes"
test_tool "send_notification" "Send me a notification saying 'Tools test complete!'"
test_tool "web_search" "What is the current price of Bitcoin?"

echo -e "\n=============================================="
echo "Tests complete!"

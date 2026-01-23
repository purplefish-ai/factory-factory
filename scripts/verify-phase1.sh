#!/bin/bash

echo "======================================"
echo "Phase 1 Verification Script"
echo "======================================"
echo ""

# Color codes
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Track failures
FAILED=0

check_file() {
    if [ -f "$1" ]; then
        echo -e "${GREEN}✓${NC} $1"
    else
        echo -e "${RED}✗${NC} $1"
        FAILED=$((FAILED + 1))
    fi
}

echo "1. Checking MCP Router Files..."
check_file "src/backend/routers/mcp/types.ts"
check_file "src/backend/routers/mcp/server.ts"
check_file "src/backend/routers/mcp/permissions.ts"
check_file "src/backend/routers/mcp/errors.ts"
check_file "src/backend/routers/mcp/mail.mcp.ts"
check_file "src/backend/routers/mcp/agent.mcp.ts"
check_file "src/backend/routers/mcp/system.mcp.ts"
check_file "src/backend/routers/mcp/index.ts"
echo ""

echo "2. Checking Testing Files..."
check_file "src/backend/testing/mock-agent.ts"
check_file "src/backend/testing/smoke-test.ts"
check_file "src/backend/testing/test-scenarios.ts"
echo ""

echo "3. Checking Inngest Files..."
check_file "src/backend/inngest/functions/mail-sent.ts"
check_file "src/backend/inngest/functions/index.ts"
echo ""

echo "4. Checking Terminal Integration..."
check_file "src/backend/clients/terminal.client.ts"
check_file "src/frontend/components/tmux-terminal.tsx"
echo ""

echo "5. Checking Documentation..."
check_file "docs/MCP_TOOLS.md"
check_file "PHASE-1-SUMMARY.md"
check_file "PHASE-1-VERIFICATION.md"
echo ""

echo "6. Checking Tool Count..."
TOOL_COUNT=$(grep "registerMcpTool({" src/backend/routers/mcp/*.mcp.ts | wc -l | tr -d ' ')
if [ "$TOOL_COUNT" -eq 8 ]; then
    echo -e "${GREEN}✓${NC} Found 8 registered tools"
else
    echo -e "${RED}✗${NC} Expected 8 tools, found $TOOL_COUNT"
    FAILED=$((FAILED + 1))
fi
echo ""

echo "7. Checking Git Status..."
if git log --oneline | grep -q "Phase 1 complete"; then
    echo -e "${GREEN}✓${NC} Phase 1 commit exists"
else
    echo -e "${RED}✗${NC} Phase 1 commit not found"
    FAILED=$((FAILED + 1))
fi

if git tag -l | grep -q "phase-1-complete"; then
    echo -e "${GREEN}✓${NC} phase-1-complete tag exists"
else
    echo -e "${RED}✗${NC} phase-1-complete tag not found"
    FAILED=$((FAILED + 1))
fi
echo ""

echo "======================================"
if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}✅ All verification checks passed!${NC}"
    echo "Phase 1 is complete and ready."
    exit 0
else
    echo -e "${RED}❌ $FAILED verification check(s) failed${NC}"
    echo "Please review the errors above."
    exit 1
fi

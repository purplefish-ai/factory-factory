#!/bin/bash

# Phase 2 Smoke Test Script
# Validates that all Phase 2 components are working correctly

set -e

echo "🧪 Phase 2 Smoke Test"
echo "===================="
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if backend is running
echo "1. Checking backend server..."
if curl -s http://localhost:3001/health > /dev/null; then
    echo -e "${GREEN}✓${NC} Backend server is running"
else
    echo -e "${RED}✗${NC} Backend server is not running"
    echo "   Please start it with: npm run dev:backend"
    exit 1
fi

# Check TypeScript compilation
echo ""
echo "2. Checking TypeScript compilation..."
if npx tsc --noEmit 2>&1 | grep -q "error TS"; then
    echo -e "${RED}✗${NC} TypeScript errors found"
    npx tsc --noEmit | grep "error TS" | head -5
    exit 1
else
    echo -e "${GREEN}✓${NC} TypeScript compilation passes"
fi

# Check if MCP tools are registered
echo ""
echo "3. Checking MCP tools registration..."
REQUIRED_TOOLS=(
    "mcp__task__update_state"
    "mcp__task__create_pr"
    "mcp__task__get_pr_status"
    "mcp__git__get_diff"
    "mcp__git__rebase"
    "mcp__agent__get_task"
    "mcp__agent__get_epic"
)

# We can't easily check this without running the server and inspecting logs
# But we can check the files exist
echo -e "${YELLOW}⚠${NC}  Manual check required: Verify server logs show MCP tools registered"

# Check required files exist
echo ""
echo "4. Checking required files exist..."
REQUIRED_FILES=(
    "src/backend/clients/claude-code.client.ts"
    "src/backend/agents/worker/worker.agent.ts"
    "src/backend/agents/worker/worker.prompts.ts"
    "src/backend/agents/worker/lifecycle.ts"
    "src/backend/routers/mcp/task.mcp.ts"
    "src/backend/routers/mcp/git.mcp.ts"
    "src/backend/routers/api/task.router.ts"
    "src/backend/inngest/functions/task-created.ts"
)

ALL_FILES_EXIST=true
for file in "${REQUIRED_FILES[@]}"; do
    if [ -f "$file" ]; then
        echo -e "${GREEN}✓${NC} $file"
    else
        echo -e "${RED}✗${NC} $file"
        ALL_FILES_EXIST=false
    fi
done

if [ "$ALL_FILES_EXIST" = false ]; then
    exit 1
fi

# Test API endpoints
echo ""
echo "5. Testing API endpoints..."

# Test health endpoint
if curl -s http://localhost:3001/health | grep -q "ok"; then
    echo -e "${GREEN}✓${NC} GET /health works"
else
    echo -e "${RED}✗${NC} GET /health failed"
    exit 1
fi

# Test terminal sessions endpoint
if curl -s http://localhost:3001/api/terminal/sessions > /dev/null; then
    echo -e "${GREEN}✓${NC} GET /api/terminal/sessions works"
else
    echo -e "${RED}✗${NC} GET /api/terminal/sessions failed"
    exit 1
fi

# Check environment variables
echo ""
echo "6. Checking environment variables..."
REQUIRED_ENV_VARS=(
    "GIT_BASE_REPO_PATH"
    "GIT_WORKTREE_BASE"
    "DATABASE_URL"
)
# Note: ANTHROPIC_API_KEY no longer required - uses Claude Code CLI with OAuth

ENV_VARS_SET=true
if [ -f .env ]; then
    source .env
    for var in "${REQUIRED_ENV_VARS[@]}"; do
        if [ -z "${!var}" ]; then
            echo -e "${RED}✗${NC} $var is not set"
            ENV_VARS_SET=false
        else
            echo -e "${GREEN}✓${NC} $var is set"
        fi
    done
else
    echo -e "${YELLOW}⚠${NC}  .env file not found"
    ENV_VARS_SET=false
fi

if [ "$ENV_VARS_SET" = false ]; then
    echo ""
    echo -e "${YELLOW}⚠${NC}  Some environment variables are missing"
    echo "   Copy .env.example to .env and fill in values"
fi

# Summary
echo ""
echo "===================="
echo "Smoke Test Summary"
echo "===================="
echo ""
echo -e "${GREEN}✓${NC} Backend server running"
echo -e "${GREEN}✓${NC} TypeScript compilation passes"
echo -e "${GREEN}✓${NC} All required files exist"
echo -e "${GREEN}✓${NC} API endpoints accessible"

if [ "$ENV_VARS_SET" = true ]; then
    echo -e "${GREEN}✓${NC} Environment variables configured"
else
    echo -e "${YELLOW}⚠${NC}  Environment variables need configuration"
fi

echo ""
echo "Next steps for full validation:"
echo "1. Create a test epic in your database"
echo "2. Create a task via POST /api/tasks/create"
echo "3. Start a worker via POST /api/tasks/start-worker"
echo "4. Monitor worker activity in tmux session"
echo "5. Verify PR is created and task state updates"
echo ""
echo "See PHASE-2.md for detailed smoke test checklist"

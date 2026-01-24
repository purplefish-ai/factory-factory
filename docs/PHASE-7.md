# Phase 7: Polish & Production Readiness

## Overview
Final phase to handle edge cases, optimize performance, add production configurations, improve error handling, and prepare FactoryFactory for real-world use.

## Goals
- Handle edge cases and error scenarios
- Optimize performance (Claude API rate limits, concurrent agent limits)
- Add comprehensive error recovery
- Improve agent execution profiles and configurability
- Add admin tools and debugging utilities
- Production deployment configuration
- Security hardening
- Documentation and user guides
- Final end-to-end testing with complex epics

## Dependencies
- All phases 0-6 complete

## Implementation Steps

### 1. Edge Case Handling - Epic and Task Management
- [ ] Handle empty epic designs:
  - [ ] Supervisor should request clarification from human if design is too vague
  - [ ] Add validation for minimum design content
- [ ] Handle epic with zero tasks:
  - [ ] Supervisor creates tasks or notifies human if unable to break down
  - [ ] Allow human to manually create tasks
- [ ] Handle task with no clear requirements:
  - [ ] Worker requests clarification from supervisor
  - [ ] Supervisor provides additional context or marks task as blocked
- [ ] Handle duplicate task creation:
  - [ ] Detect similar existing tasks
  - [ ] Supervisor avoids creating duplicates
- [ ] Handle orphaned worktrees:
  - [ ] Add cleanup job to delete worktrees for deleted epics/tasks
  - [ ] Add UI to manually clean up orphaned worktrees
- [ ] Test: Create edge case scenarios and verify handling

### 2. Edge Case Handling - PR and Merge Conflicts
- [ ] Handle PR creation failures:
  - [ ] Worker retries PR creation
  - [ ] If repeated failures, escalate to supervisor
  - [ ] Log GitHub errors for debugging
- [ ] Handle PR merge conflicts (post-rebase):
  - [ ] Supervisor detects merge conflict during merge attempt
  - [ ] Supervisor requests worker to resolve conflicts
  - [ ] Worker resolves and resubmits
  - [ ] If unresolvable, escalate to human
- [ ] Handle failed rebases (complex conflicts):
  - [ ] Worker attempts rebase, detects conflicts
  - [ ] Worker attempts auto-resolution (if simple)
  - [ ] If complex, mark task as FAILED and notify supervisor
  - [ ] Supervisor escalates to human
- [ ] Handle PR review timeouts:
  - [ ] If PR sits in review queue too long, notify human
  - [ ] Add configurable timeout (e.g., 1 hour)
- [ ] Test: Create scenarios with conflicts and verify handling

### 3. Edge Case Handling - Agent Crashes and Recovery
- [ ] Handle rapid repeated crashes (crash loop):
  - [ ] Detect when agent crashes immediately after restart (< 1 minute)
  - [ ] If 3 rapid crashes: mark as failed, don't retry
  - [ ] Notify human of crash loop
- [ ] Handle orchestrator crash:
  - [ ] Add monitoring for orchestrator health
  - [ ] Auto-restart orchestrator if it crashes
  - [ ] Notify human of orchestrator restart
- [ ] Handle database connection failures:
  - [ ] Retry database operations with exponential backoff
  - [ ] Notify human if database is down
  - [ ] Gracefully pause agents if database unavailable
- [ ] Handle Claude API failures:
  - [ ] Detect rate limit errors (429)
  - [ ] Implement exponential backoff and retry
  - [ ] Notify human if API is down or rate limited for extended period
  - [ ] Pause agent creation if rate limited
- [ ] Test: Simulate failures and verify recovery

### 4. Performance Optimization - Claude API Rate Limiting
- [ ] Implement global rate limiter for Claude API:
  - [ ] Track API calls per minute/hour
  - [ ] Queue agent requests if approaching rate limit
  - [ ] Prioritize orchestrator and supervisor calls over workers
- [ ] Add configurable concurrency limits:
  - [ ] Max concurrent workers (default: 10)
  - [ ] Max concurrent supervisors (default: 5)
  - [ ] Max concurrent epics (default: 5)
  - [ ] Queue new epic/task creation if limit reached
- [ ] Add API usage tracking:
  - [ ] Log total API calls per agent
  - [ ] Log total API calls per epic
  - [ ] Display API usage in UI (cost estimation)
- [ ] Optimize agent prompts:
  - [ ] Reduce system prompt size where possible
  - [ ] Use shorter tool descriptions
  - [ ] Minimize context length
- [ ] Test: Run multiple epics and verify rate limiting works

### 5. Performance Optimization - Resource Management
- [ ] Limit total number of tmux sessions:
  - [ ] Monitor active tmux sessions
  - [ ] Clean up completed agent sessions after N hours
  - [ ] Notify if approaching system limits
- [ ] Optimize database queries:
  - [ ] Add indexes for frequently queried fields
  - [ ] Use query optimization (select only needed fields)
  - [ ] Add caching for frequently accessed data
- [ ] Optimize Inngest function execution:
  - [ ] Batch similar operations where possible
  - [ ] Reduce function invocation frequency for cron jobs if possible
  - [ ] Monitor Inngest queue depth
- [ ] Add system resource monitoring:
  - [ ] Track memory usage
  - [ ] Track CPU usage
  - [ ] Notify human if resources are constrained
- [ ] Test: Run system under load and monitor performance

### 6. Agent Execution Profile Refinement
- [ ] Add model override support:
  - [ ] Environment variables: `WORKER_MODEL`, `SUPERVISOR_MODEL`, `ORCHESTRATOR_MODEL`
  - [ ] Values: `sonnet`, `opus`, `haiku`
  - [ ] Default all to `sonnet`
  - [ ] Test: Override worker model to `haiku` and verify
- [ ] Add permission mode override support:
  - [ ] Environment variables: `WORKER_PERMISSIONS`, `SUPERVISOR_PERMISSIONS`, `ORCHESTRATOR_PERMISSIONS`
  - [ ] Values: `strict`, `relaxed`, `yolo`
  - [ ] Default: orchestrator=strict, supervisor=relaxed, worker=yolo
  - [ ] Test: Change permission modes and verify behavior
- [ ] Add dynamic profile configuration:
  - [ ] Allow per-epic or per-task model override
  - [ ] UI to configure agent profiles
  - [ ] Store profile configuration in database
- [ ] Document model selection rationale in README
- [ ] Test: Run same epic with different model configs, compare results

### 7. Admin Tools and Debugging Utilities
- [ ] Add admin tRPC router (`src/backend/routers/api/admin.router.ts`):
  - [ ] `killAgent` mutation: Manually kill agent
  - [ ] `restartAgent` mutation: Manually restart agent
  - [ ] `cleanupWorktrees` mutation: Clean up orphaned worktrees
  - [ ] `resetTask` mutation: Reset task to PENDING state
  - [ ] `resetEpic` mutation: Reset epic to IN_PROGRESS state
  - [ ] `getSystemStats` query: Get system resource stats
  - [ ] `triggerHealthCheck` mutation: Manually trigger health check
- [ ] Add admin UI pages:
  - [ ] `src/frontend/app/admin/page.tsx`: Admin dashboard
  - [ ] `src/frontend/app/admin/agents/page.tsx`: Agent management
  - [ ] `src/frontend/app/admin/system/page.tsx`: System stats and controls
- [ ] Add developer debug tools:
  - [ ] Export decision logs to JSON
  - [ ] Replay agent execution from logs (future)
  - [ ] Agent execution timeline viewer
- [ ] Test: Use admin tools to kill and restart agents

### 8. Security Hardening
- [ ] Add authentication (optional but recommended):
  - [ ] Implement basic auth or OAuth
  - [ ] Protect all tRPC routes with auth
  - [ ] Add user roles (admin, viewer)
  - [ ] Restrict admin operations to admin users
- [ ] Sanitize all inputs:
  - [ ] Validate epic/task titles and descriptions
  - [ ] Prevent injection attacks in mail system
  - [ ] Sanitize git branch names
  - [ ] Validate file paths for worktree operations
- [ ] Secure environment variables:
  - [ ] Use secrets manager for production (e.g., Doppler, AWS Secrets Manager)
  - [ ] Never commit `.env` file
  - [ ] Document required environment variables
- [ ] Add CORS configuration:
  - [ ] Restrict frontend origins
  - [ ] Configure tRPC CORS settings
- [ ] Add rate limiting for tRPC endpoints:
  - [ ] Prevent abuse of epic/task creation
  - [ ] Limit mail sending frequency
- [ ] Test: Attempt security exploits and verify protections

### 9. Production Deployment Configuration
- [ ] Add production environment variables:
  - [ ] `NODE_ENV=production`
  - [ ] `DATABASE_URL` (production PostgreSQL)
  - [ ] `NEXT_PUBLIC_API_URL` (production backend URL)
  - [ ] `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` (production keys)
- [ ] Add production build scripts:
  - [ ] Backend: `npm run build:backend`
  - [ ] Frontend: `npm run build:frontend`
  - [ ] Combined: `npm run build`
- [ ] Add production start scripts:
  - [ ] `npm run start:backend`
  - [ ] `npm run start:frontend`
  - [ ] Process manager (PM2, systemd, Docker)
- [ ] Create Dockerfile for containerized deployment:
  - [ ] Multi-stage build (backend + frontend)
  - [ ] Production-optimized image
  - [ ] Docker Compose for full stack
- [ ] Add reverse proxy configuration:
  - [ ] Nginx or Caddy config
  - [ ] SSL/TLS configuration
  - [ ] WebSocket support for terminal viewing
- [ ] Add database migration strategy:
  - [ ] Production migration workflow
  - [ ] Backup strategy before migrations
- [ ] Test: Deploy to staging environment and verify

### 10. Monitoring and Observability
- [ ] Add structured logging:
  - [ ] Use logging library (Winston, Pino)
  - [ ] Log levels: error, warn, info, debug
  - [ ] Log agent lifecycle events
  - [ ] Log all errors with stack traces
- [ ] Add health check endpoints:
  - [ ] `/health` - Overall system health
  - [ ] `/health/database` - Database connection
  - [ ] `/health/inngest` - Inngest connection
  - [ ] `/health/agents` - Agent health summary
- [ ] Add metrics collection (optional):
  - [ ] Prometheus metrics export
  - [ ] Track: API calls, agent counts, task completion rate, error rate
  - [ ] Grafana dashboard
- [ ] Add error tracking (optional):
  - [ ] Sentry or similar for error monitoring
  - [ ] Track agent crashes
  - [ ] Track API failures
- [ ] Test: Monitor system health via health endpoints

### 11. Documentation - User Guides
- [ ] Create `docs/USER_GUIDE.md`:
  - [ ] Getting started guide
  - [ ] How to create an epic
  - [ ] How to monitor progress
  - [ ] How to interact with agents via mail
  - [ ] How to review and merge epic PRs
  - [ ] Troubleshooting common issues
  - [ ] FAQ
- [ ] Create `docs/DEPLOYMENT_GUIDE.md`:
  - [ ] System requirements
  - [ ] Installation steps
  - [ ] Configuration guide
  - [ ] Production deployment instructions
  - [ ] Backup and disaster recovery
- [ ] Create `docs/ARCHITECTURE.md`:
  - [ ] High-level system architecture
  - [ ] Agent hierarchy and responsibilities
  - [ ] Event-driven workflows
  - [ ] Database schema overview
  - [ ] Technology stack details
- [ ] Update `README.md`:
  - [ ] Clear project description
  - [ ] Quick start guide
  - [ ] Link to all documentation
  - [ ] Contributing guidelines (if open source)
  - [ ] License information

### 12. Documentation - Developer Guides
- [ ] Create `docs/DEVELOPER_GUIDE.md`:
  - [ ] Development environment setup
  - [ ] How to add new MCP tools
  - [ ] How to modify agent prompts
  - [ ] How to add new Inngest functions
  - [ ] How to extend the frontend
  - [ ] Testing strategies
- [ ] Create `docs/API_REFERENCE.md`:
  - [ ] Complete tRPC API documentation
  - [ ] All MCP tool documentation (already partially done)
  - [ ] Inngest event schemas
  - [ ] Database schema documentation
- [ ] Add inline code documentation:
  - [ ] JSDoc comments for all public functions
  - [ ] Type definitions for all data structures
  - [ ] Explain complex logic with comments
- [ ] Create architectural decision records (ADRs):
  - [ ] Document key design decisions (e.g., why sequential PR review)
  - [ ] Store in `docs/adr/` directory

### 13. Testing - Complex Epic Scenarios
- [ ] Test scenario 1: Simple epic (3 tasks, no failures):
  - [ ] Create epic: "Add REST API for user management"
  - [ ] Verify supervisor breaks down into tasks
  - [ ] Verify all tasks complete successfully
  - [ ] Verify sequential PR review and merge
  - [ ] Verify epic PR created
  - [ ] Verify notifications sent
- [ ] Test scenario 2: Epic with worker crashes:
  - [ ] Create epic: "Add authentication system"
  - [ ] Kill a worker during execution
  - [ ] Verify worker recovery
  - [ ] Verify task continues to completion
  - [ ] Verify epic completes successfully
- [ ] Test scenario 3: Epic with supervisor crash:
  - [ ] Create epic: "Add admin dashboard"
  - [ ] Kill supervisor mid-execution
  - [ ] Verify cascading recovery (workers killed and recreated)
  - [ ] Verify epic continues to completion
- [ ] Test scenario 4: Epic with rebase conflicts:
  - [ ] Create epic with overlapping file changes
  - [ ] Verify rebase cascade triggers correctly
  - [ ] Verify workers handle rebases
  - [ ] Verify epic completes
- [ ] Test scenario 5: Concurrent epics:
  - [ ] Create 3 epics simultaneously
  - [ ] Verify all run concurrently
  - [ ] Verify no interference between epics
  - [ ] Verify all complete successfully
- [ ] Document test scenarios and results

### 14. Performance Benchmarking
- [ ] Benchmark epic completion time:
  - [ ] Small epic (3 tasks): Target < 30 minutes
  - [ ] Medium epic (10 tasks): Target < 2 hours
  - [ ] Large epic (20+ tasks): Measure and document
- [ ] Benchmark resource usage:
  - [ ] Measure memory per agent
  - [ ] Measure CPU usage during peak load
  - [ ] Measure database query performance
  - [ ] Measure API call rate
- [ ] Identify bottlenecks:
  - [ ] Sequential PR review (major bottleneck)
  - [ ] Claude API latency
  - [ ] Git operations (rebase, PR creation)
- [ ] Document performance characteristics and limitations
- [ ] Propose future optimizations (for post-Phase 7)

### 15. Quality Assurance
- [ ] Code review all phases:
  - [ ] Review for code quality
  - [ ] Review for security issues
  - [ ] Review for performance issues
  - [ ] Review for maintainability
- [ ] Add linting and formatting:
  - [ ] ESLint configuration
  - [ ] Prettier configuration
  - [ ] Pre-commit hooks with Husky
- [ ] Add type checking:
  - [ ] Run `tsc --noEmit` to check types
  - [ ] Fix any type errors
  - [ ] Ensure strict mode enabled
- [ ] Refactor as needed:
  - [ ] Extract common utilities
  - [ ] Reduce code duplication
  - [ ] Improve naming and organization
- [ ] Test: Run linter and type checker, fix all issues

### 16. Final Integration Test - End-to-End
- [ ] Create a complex, realistic epic:
  - [ ] Title: "Build E-commerce Product Catalog System"
  - [ ] Design: Comprehensive design with multiple features
  - [ ] Expected tasks: 10+ tasks (API endpoints, UI components, tests)
- [ ] Monitor from creation to completion:
  - [ ] Watch supervisor create tasks
  - [ ] Watch workers execute in parallel
  - [ ] Observe PR review queue and sequential merges
  - [ ] Observe rebase cascades
  - [ ] Monitor for crashes and recovery
  - [ ] Verify decision logs capture all actions
  - [ ] Verify notifications sent at milestones
- [ ] Review final epic PR:
  - [ ] Verify all tasks merged correctly
  - [ ] Verify code quality
  - [ ] Verify tests pass
  - [ ] Merge epic PR manually
  - [ ] Mark epic as COMPLETED
- [ ] Measure and document:
  - [ ] Total time to completion
  - [ ] Number of API calls
  - [ ] Number of crashes and recoveries
  - [ ] Final code quality assessment

### 17. Production Checklist
- [ ] All environment variables documented
- [ ] Database migrations tested in production-like environment
- [ ] Backup and restore procedures documented
- [ ] Monitoring and alerting configured
- [ ] Error tracking configured
- [ ] SSL/TLS configured
- [ ] Secrets secured (not in code)
- [ ] Rate limiting configured
- [ ] CORS configured
- [ ] Health checks passing
- [ ] Logging configured
- [ ] Process manager configured (PM2, systemd, Docker)
- [ ] Deployment scripts tested
- [ ] Rollback plan documented

### 18. Future Enhancements Documentation
- [ ] Document potential future enhancements:
  - [ ] Parallel PR review (smart conflict detection)
  - [ ] Multi-repository support
  - [ ] Custom agent personalities
  - [ ] Agent memory and context persistence
  - [ ] Web-based code review UI (vs GitHub)
  - [ ] Cost tracking and optimization
  - [ ] Integration with external issue trackers
  - [ ] Agent collaboration (pair programming)
  - [ ] Haiku model for simple tasks (cost optimization)
  - [ ] Opus model for complex supervisors
- [ ] Create roadmap for future development
- [ ] Prioritize enhancements based on user feedback

## Smoke Test Checklist

Run these tests manually to validate Phase 7 completion:

- [ ] **Edge Cases**: All edge case scenarios handled correctly
- [ ] **Rate Limiting**: Claude API rate limiting works
- [ ] **Concurrency Limits**: Agent concurrency limits enforced
- [ ] **Model Override**: Can override agent models via env vars
- [ ] **Permission Override**: Can override permission modes via env vars
- [ ] **Admin Tools**: All admin operations work correctly
- [ ] **Security**: Authentication and input sanitization working (if implemented)
- [ ] **Production Build**: Backend and frontend build successfully
- [ ] **Production Deployment**: Can deploy to staging/production
- [ ] **Health Checks**: All health check endpoints return correct status
- [ ] **Logging**: Structured logs captured correctly
- [ ] **Metrics**: System metrics collected (if implemented)
- [ ] **Documentation**: All documentation complete and accurate
- [ ] **Complex Epic**: Can complete complex epic end-to-end
- [ ] **Concurrent Epics**: Can run multiple epics simultaneously
- [ ] **Performance**: System performs within acceptable limits
- [ ] **Quality**: Code passes linting and type checking

## Success Criteria

- [ ] All smoke tests pass
- [ ] System is production-ready
- [ ] All edge cases handled gracefully
- [ ] Performance is acceptable for real-world use
- [ ] Documentation is complete and clear
- [ ] Security is hardened
- [ ] Can deploy to production environment
- [ ] Can handle complex, realistic epics
- [ ] System is maintainable and extensible

## Git Tagging

Once all success criteria are met:
```bash
git add .
git commit -m "Phase 7 complete: Polish and production readiness"
git tag phase-7-complete
git tag v1.0.0  # Major milestone!
```

## Notes

- This phase is about robustness and production readiness
- Focus on edge cases and error handling
- Performance optimization is key for real-world use
- Comprehensive documentation is critical for adoption
- Testing complex scenarios validates the entire system
- This completes the initial FactoryFactory implementation

## Beyond Phase 7

FactoryFactory is now production-ready! Future work can focus on:
- User feedback and iteration
- Performance optimizations
- New features from roadmap
- Scale testing with larger epics
- Community contributions (if open source)

Congratulations on building an autonomous multi-agent software development system!

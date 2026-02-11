# Phase 3: Auth & Billing

**Goal:** Add user management and billing so the cloud server can serve multiple users securely.

## 3.1 Auth & User Management

- JWT-based authentication
- User accounts (email/password, OAuth with GitHub)
- API keys for programmatic access
- Session management (refresh tokens)

**PostgreSQL schema additions:**

```
users          — id, email, name, plan, created_at
```

Add `user_id` foreign key to `workspaces` and `vms` tables. All queries become user-scoped.

## 3.2 Multi-Tenant Enforcement

- Every API endpoint validates JWT and scopes queries to `userId`
- WebSocket connections require valid JWT
- VM provisioning checks user ownership
- Workspace send/pull verifies user owns both desktop and cloud workspace

## 3.3 Billing

- **Usage tracking:** Compute minutes per workspace, API call counts
- **Subscription tiers:** Free (limited), Pro (standard limits), Team (higher limits + team features later)
- **Quota enforcement:** Check quota before provisioning containers. Reject with clear error if exceeded.
- **Payment integration:** Stripe for subscriptions and metered billing
- **Usage dashboard:** Users can see their usage and billing status

## Done when

Users can sign up, authenticate, choose a plan, pay, and use the cloud product within their plan limits. All API endpoints are user-scoped. The web frontend (phase 4) can build on real auth.

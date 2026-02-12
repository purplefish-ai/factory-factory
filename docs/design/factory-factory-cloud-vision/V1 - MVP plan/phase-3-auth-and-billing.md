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

## How to test manually

1. **Sign up and log in:**
   - Go to the sign-up page, create an account with email/password
   - Log out, log back in — verify session persists
   - Sign up with GitHub OAuth — verify it creates a separate account linked to GitHub

2. **API key auth:**
   Generate an API key from the dashboard. Use it to call a protected endpoint:
   ```bash
   curl http://localhost:3000/api/workspaces -H "Authorization: Bearer <api-key>"
   ```
   Verify it returns only your workspaces.

3. **Multi-tenant isolation:**
   Create two user accounts. Send a workspace to cloud from each. Verify:
   - User A cannot see User B's workspaces via API
   - User A cannot access User B's VM
   - Swapping JWT tokens between users is rejected

4. **Billing and quotas:**
   - Sign up on the Free plan. Provision a VM and start workspaces until you hit the quota limit
   - Verify the error message is clear ("Compute quota exceeded, upgrade to Pro")
   - Upgrade to Pro via Stripe checkout — verify the quota limit increases
   - Check the Stripe dashboard: subscription is active, metered usage is being reported

5. **Usage dashboard:**
   Log in and navigate to the usage page. Verify it shows compute minutes, number of workspaces, and current billing period.

## Done when

Users can sign up, authenticate, choose a plan, pay, and use the cloud product within their plan limits. All API endpoints are user-scoped. The web frontend (phase 4) can build on real auth.

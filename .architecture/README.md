# Architecture Analysis

This directory contains architecture documentation and dependency analysis reports.

## Files

- `HOTSPOTS_*.md` - Monthly hotspot analysis reports
- `metrics-*.json` - Monthly metrics (machine-readable)
- `deps-*.json` - Raw dependency-cruiser output
- `analyze-deps.sh` - Script to generate analysis reports

## Running Analysis

```bash
# Run analysis (generates metrics for current month)
./.architecture/analyze-deps.sh

# Compare with previous month
diff <(jq .metrics .architecture/metrics-2026-01.json) <(jq .metrics .architecture/metrics-2026-02.json)
```

## Key Metrics to Track

- **Total Modules**: Should grow slowly, watch for explosion
- **Circular Dependencies**: Target = 0 (currently: 0)
- **Service-to-Service Coupling**: Replaced flat services with 6 domain modules + ~25 infrastructure services
- **Average Coupling**: Reduced via domain encapsulation and bridge interfaces

## Architecture Goals

### Phase 1 -- Complete (2026-02-10)
- [x] Add stricter dependency-cruiser rules (no-cross-domain-imports, no-deep-domain-imports, no-domains-importing-orchestration)
- [x] Document current architecture in ARCHITECTURE.md
- [x] Identify domain boundaries (Session, Workspace, GitHub, Ratchet, Terminal, Run-Script)

### Phase 2 -- Complete (2026-02-10)
- [x] Message/transcript handling consolidated within session domain (session-store, chat services)
- [x] Single-write-path pattern exists within each domain module
- [x] Service-to-service coupling reduced via domain modules and bridge interfaces

### Phase 3 -- Complete (2026-02-10)
- [x] Services layer refactored: 6 domain modules (`src/backend/domains/`) + infrastructure services (`src/backend/services/`) + orchestration (`src/backend/orchestration/`)
- [x] Cross-domain coupling eliminated via bridge interfaces and orchestrators
- [x] dependency-cruiser enforcement replaces eslint-plugin-boundaries

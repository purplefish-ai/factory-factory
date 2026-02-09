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
- **Circular Dependencies**: Target = 0 (currently: 0 ✓)
- **Service-to-Service Coupling**: Target < 50 (currently: 97)
- **Average Coupling**: Target < 5.0 (currently: 6.9)

## Architecture Goals

### Phase 1 (This Month)
- [ ] Add stricter dependency-cruiser rules
- [ ] Document current architecture in ARCHITECTURE.md
- [ ] Identify domain boundaries (Session, Workspace, Message)

### Phase 2 (Next Month)
- [ ] Extract Message/Transcript domain module
- [ ] Implement single-write-path pattern
- [ ] Reduce service-to-service coupling to < 70

### Phase 3 (Q2)
- [ ] Refactor services layer into domain/application/infrastructure
- [ ] Achieve average coupling < 5.0
- [ ] Add eslint-plugin-boundaries enforcement

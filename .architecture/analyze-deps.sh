#!/bin/bash
# Architecture Dependency Analysis Script
# Run this monthly to track architecture trends

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="$SCRIPT_DIR"
TIMESTAMP=$(date +%Y-%m)

echo "=================================================="
echo "Architecture Dependency Analysis"
echo "Timestamp: $TIMESTAMP"
echo "=================================================="
echo

# Generate JSON for detailed analysis
echo "📊 Generating dependency data..."
pnpm depcruise src/backend --output-type json > "$OUTPUT_DIR/deps-$TIMESTAMP.json"

# Create analysis script
cat > /tmp/analyze-deps-$TIMESTAMP.mjs << 'EOF'
#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'fs';

const args = process.argv.slice(2);
const jsonFile = args[0];
const outputFile = args[1];

const data = JSON.parse(readFileSync(jsonFile, 'utf-8'));

// Analyze coupling hotspots
const stats = {
  modulesByDependents: [],
  modulesByDependencies: [],
  layerCoupling: {},
  circularDeps: [],
};

for (const module of data.modules) {
  if (!module.source.startsWith('src/backend')) continue;

  const dependentCount = module.dependents?.filter(d => d.startsWith('src/backend')).length || 0;
  const dependencyCount = module.dependencies?.filter(d =>
    d.resolved?.startsWith('src/backend')
  ).length || 0;

  stats.modulesByDependents.push({
    module: module.source,
    count: dependentCount,
  });

  stats.modulesByDependencies.push({
    module: module.source,
    count: dependencyCount,
  });

  // Track circular dependencies
  const circularDeps = module.dependencies?.filter(d => d.circular) || [];
  if (circularDeps.length > 0) {
    stats.circularDeps.push({
      module: module.source,
      circular: circularDeps.map(d => d.resolved)
    });
  }

  // Layer analysis
  const layer = module.source.split('/')[2];
  if (!stats.layerCoupling[layer]) {
    stats.layerCoupling[layer] = { incoming: 0, outgoing: 0, modules: 0 };
  }
  stats.layerCoupling[layer].modules += 1;
  stats.layerCoupling[layer].outgoing += dependencyCount;
  stats.layerCoupling[layer].incoming += dependentCount;
}

// Sort by most dependents
stats.modulesByDependents.sort((a, b) => b.count - a.count);
stats.modulesByDependencies.sort((a, b) => b.count - a.count);

// Calculate metrics
const totalModules = data.modules.filter(m => m.source.startsWith('src/backend')).length;
const topHotspot = stats.modulesByDependents[0];
const avgCoupling = Object.values(stats.layerCoupling)
  .reduce((sum, layer) => sum + (layer.incoming + layer.outgoing) / layer.modules, 0) / Object.keys(stats.layerCoupling).length;

// Service-to-service coupling
let serviceToServiceCount = 0;
for (const module of data.modules) {
  if (!module.source.includes('/services/') || !module.source.endsWith('.service.ts')) continue;
  for (const dep of module.dependencies || []) {
    if (dep.resolved?.includes('/services/') && dep.resolved.endsWith('.service.ts')) {
      serviceToServiceCount++;
    }
  }
}

const report = {
  timestamp: new Date().toISOString(),
  metrics: {
    totalModules,
    circularDependencies: stats.circularDeps.length,
    serviceToServiceCoupling: serviceToServiceCount,
    averageCoupling: avgCoupling.toFixed(2),
    topHotspot: {
      module: topHotspot.module,
      dependents: topHotspot.count,
    },
  },
  layers: Object.entries(stats.layerCoupling)
    .map(([layer, data]) => ({
      layer,
      modules: data.modules,
      avgCoupling: ((data.incoming + data.outgoing) / data.modules).toFixed(2),
    }))
    .sort((a, b) => parseFloat(b.avgCoupling) - parseFloat(a.avgCoupling)),
  top10Hotspots: stats.modulesByDependents.slice(0, 10),
  top10MostCoupled: stats.modulesByDependencies.slice(0, 10),
};

writeFileSync(outputFile, JSON.stringify(report, null, 2));

console.log('='.repeat(80));
console.log('ARCHITECTURE METRICS SUMMARY');
console.log('='.repeat(80));
console.log();
console.log(`Total Modules: ${totalModules}`);
console.log(`Circular Dependencies: ${stats.circularDeps.length}`);
console.log(`Service-to-Service Coupling: ${serviceToServiceCount}`);
console.log(`Average Coupling: ${avgCoupling.toFixed(2)}`);
console.log();
console.log('Top Hotspot:');
console.log(`  ${topHotspot.module} (${topHotspot.count} dependents)`);
console.log();
console.log('Layer Coupling (top 5):');
for (const layer of report.layers.slice(0, 5)) {
  console.log(`  ${layer.layer.padEnd(20)} | ${layer.modules} modules | avg: ${layer.avgCoupling}`);
}
console.log();
console.log(`📁 Full report saved to: ${outputFile}`);
console.log('='.repeat(80));
EOF

chmod +x /tmp/analyze-deps-$TIMESTAMP.mjs

# Run analysis
echo "🔍 Analyzing dependencies..."
node /tmp/analyze-deps-$TIMESTAMP.mjs "$OUTPUT_DIR/deps-$TIMESTAMP.json" "$OUTPUT_DIR/metrics-$TIMESTAMP.json"

echo
echo "✅ Analysis complete!"
echo
echo "Generated files:"
echo "  - $OUTPUT_DIR/deps-$TIMESTAMP.json (raw dependency data)"
echo "  - $OUTPUT_DIR/metrics-$TIMESTAMP.json (analysis report)"
echo
echo "To compare with previous months:"
echo "  # Replace YYYY-MM with the previous month"
echo "  diff <(jq .metrics .architecture/metrics-YYYY-MM.json) <(jq .metrics .architecture/metrics-$TIMESTAMP.json)"

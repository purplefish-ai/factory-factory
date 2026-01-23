#!/usr/bin/env tsx

/**
 * Create a test epic for Phase 2 validation
 */

import { prisma } from '../src/backend/db.js';
import { EpicState } from '@prisma/client';

async function main() {
  console.log('Creating test epic...');

  // Create test epic
  const testLinearId = `TEST-PHASE2-${Date.now()}`;
  const epic = await prisma.epic.create({
    data: {
      linearIssueId: testLinearId,
      linearIssueUrl: `https://linear.app/test/${testLinearId}`,
      title: 'Phase 2 Test Epic: Add Hello World Feature',
      description: 'Test epic for validating worker functionality in Phase 2. Workers will add simple endpoints to test the system.',
      state: EpicState.ACTIVE,
    },
  });

  console.log('✅ Test epic created!');
  console.log('');
  console.log('Epic Details:');
  console.log(`  ID: ${epic.id}`);
  console.log(`  Title: ${epic.title}`);
  console.log(`  State: ${epic.state}`);
  console.log('');
  console.log('Now you can create a task with:');
  console.log('');
  console.log(`curl -X POST http://localhost:3001/api/tasks/create \\`);
  console.log(`  -H "Content-Type: application/json" \\`);
  console.log(`  -d '{"epicId": "${epic.id}", "title": "Add GET /hello endpoint", "description": "Create a simple GET endpoint at /hello that returns {message: \"Hello World\"}"}'`);
  console.log('');

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});

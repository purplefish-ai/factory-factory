import * as dotenv from 'dotenv';

dotenv.config();

import { gitClient } from './src/backend/clients/git.client';

async function test() {
  console.log('🧪 Testing Git Client...\n');

  try {
    // Create worktree
    console.log('1. Creating git worktree...');
    const worktree = await gitClient.createWorktree('test-phase0');
    console.log('   ✅ Worktree created:');
    console.log('      - Name:', worktree.name);
    console.log('      - Path:', worktree.path);
    console.log('      - Branch:', worktree.branchName);

    // Check if exists
    console.log('2. Checking if worktree exists...');
    const exists = await gitClient.checkWorktreeExists('test-phase0');
    console.log('   ✅ Worktree exists:', exists);

    // Get worktree path
    console.log('3. Getting worktree path...');
    const path = gitClient.getWorktreePath('test-phase0');
    console.log('   ✅ Worktree path:', path);

    // Get branch name
    console.log('4. Getting branch name...');
    const branch = gitClient.getBranchName('test-phase0');
    console.log('   ✅ Branch name:', branch);

    // List worktrees
    console.log('5. Listing all worktrees...');
    const worktrees = await gitClient.listWorktrees();
    console.log('   ✅ Found', worktrees.length, 'worktree(s)');
    worktrees.forEach((w) => console.log('      -', w));

    // Delete worktree
    console.log('6. Deleting worktree...');
    await gitClient.deleteWorktree('test-phase0');
    console.log('   ✅ Worktree deleted');

    console.log('\n✨ All Git client tests passed!\n');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  }
}

test();

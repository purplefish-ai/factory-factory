import { tmuxClient } from './src/backend/clients/tmux.client';

async function test() {
  console.log('🧪 Testing Tmux Client...\n');

  try {
    // Create session
    console.log('1. Creating tmux session...');
    await tmuxClient.createSession('test-phase0');
    console.log('   ✅ Session created');

    // Check if exists
    console.log('2. Checking if session exists...');
    const exists = await tmuxClient.sessionExists('test-phase0');
    console.log('   ✅ Session exists:', exists);

    // Send keys
    console.log('3. Sending keys to session...');
    await tmuxClient.sendKeys('test-phase0', 'echo "Hello from Phase 0"');
    console.log('   ✅ Keys sent');

    // List sessions
    console.log('4. Listing all sessions...');
    const sessions = await tmuxClient.listSessions();
    console.log('   ✅ Found', sessions.length, 'session(s)');
    sessions.forEach(s => console.log('      -', s.name));

    // Capture pane
    console.log('5. Capturing pane output...');
    const output = await tmuxClient.capturePane('test-phase0', 20);
    console.log('   ✅ Captured output (truncated):', output.substring(0, 100) + '...');

    // Kill session
    console.log('6. Killing session...');
    await tmuxClient.killSession('test-phase0');
    console.log('   ✅ Session killed');

    console.log('\n✨ All Tmux client tests passed!\n');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  }
}

test();

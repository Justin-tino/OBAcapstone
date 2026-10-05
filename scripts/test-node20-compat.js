/**
 * Boots the real server with globalThis.WebSocket removed — the exact
 * condition that crashed Railway (Node 20). Proves the ws shim lets it start.
 * Run: node scripts/test-node20-compat.js
 */
delete globalThis.WebSocket;
console.log('WebSocket before require:', typeof globalThis.WebSocket);
require('dotenv').config();
const PORT = process.env.TEST_PORT || '3920';
process.env.PORT = PORT;
require('../server.js');

setTimeout(async () => {
  try {
    const res = await fetch(`http://localhost:${PORT}/api/db-info`);
    const json = await res.json();
    console.log('SERVER ALIVE  :', res.status, JSON.stringify(json));
  } catch (e) {
    console.log('HEALTH CHECK FAILED:', e.message);
    process.exit(1);
  }
  process.exit(0);
}, 6000);
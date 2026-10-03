import { createInterface } from 'node:readline';
// Minimal real stdio MCP transport. No model, network or credential access.
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  if (request.method === 'initialize') result = {
    protocolVersion: request.params.protocolVersion,
    capabilities: { tools: {} }, serverInfo: { name: 'boundary-docs', version: '1' },
    instructions: 'Synthetic local boundary MCP server.',
  };
  else if (request.method === 'tools/list') result = { tools: [] };
  else if (request.method === 'ping') result = {};
  else result = {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});

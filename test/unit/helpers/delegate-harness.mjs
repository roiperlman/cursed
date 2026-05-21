/**
 * Mini-harness: import the registration shape from cursed-mcp.mjs without
 * standing up a real MCP transport. Mirrors what `server.registerTool` does
 * internally for the `delegate` handler.
 *
 * @param {Record<string, unknown>} args
 * @param {Record<string, unknown>} [overrides]
 */
export async function invokeDelegate(args, overrides = {}) {
  const mcp = await import('../../../scripts/mcp/cursed-mcp.mjs');
  return mcp.__test_invokeDelegate__(args, overrides);
}

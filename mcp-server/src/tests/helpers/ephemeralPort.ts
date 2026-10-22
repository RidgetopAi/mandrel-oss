/**
 * Reserve a free TCP port for a test that must bind a real listener.
 *
 * WHY THIS EXISTS
 * ---------------
 * Tests that drive the REAL transport have to bind a real port. Historically they
 * picked a fixed literal (18097 / 18098 / 18099) because of an ordering constraint
 * (below). That is a landmine: the prod box runs the tenant docker fleet, whose
 * docker-proxy processes hold 13xxx / 15xxx / 16379-16399 / 18080-18099. The the control host dev
 * box runs no fleet, so a colliding literal passes locally and fails ONLY on the box
 * that runs the tenants — which is exactly how `TEST_PORT = 18099` aborted a prod
 * fleet deploy at the clean gate (EADDRINUSE :::18099 in healthServer.start).
 *
 * THE ORDERING CONSTRAINT (why we can't simply listen on port 0)
 * --------------------------------------------------------------
 * The obvious fix — bind `0` and read `server.address().port` — does not work on its
 * own, because the port must be known BEFORE the server is constructed:
 *
 *   1. `RemoteMcpTransport`'s constructor calls `resolveAllowedHosts()` ONCE and caches
 *      the result in `this.allowedHosts` (remoteMcpTransport.ts). It is never re-read,
 *      so mutating MCP_ALLOWED_HOSTS after construction has no effect.
 *   2. The MCP SDK validates with an EXACT string match on the full Host header:
 *      `this._allowedHosts.includes(hostHeader)` (webStandardStreamableHttp.js). The
 *      header a client sends is `127.0.0.1:<port>`, so a bare `127.0.0.1` entry does
 *      NOT satisfy it — the list must contain the host WITH the real port.
 *   3. `HealthServer` takes the transport in its constructor, so by the time
 *      `health.start()` could report an OS-assigned port, allowedHosts is already frozen.
 *
 * So the port genuinely has to be discovered before construction. We discover it the
 * only race-free-enough way available: let the OS assign one (`listen(0)`), read it,
 * release it, and hand it back. The OS ephemeral range (`ip_local_port_range`, default
 * 32768-60999) never overlaps the tenant-reserved ranges, so the returned port is safe
 * on every box by construction rather than by a human remembering a comment.
 *
 * The close→rebind window is a theoretical TOCTOU, but the alternative it replaces is a
 * literal that is GUARANTEED to collide on the prod box, not merely unlucky.
 *
 * Enforced by `reservedTestPorts.contract.test.ts`, which fails the suite if a
 * reserved-range port literal reappears in a test file.
 */
import net from 'net';

export async function reserveEphemeralPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    // Bind the same interface the health server will (all interfaces), so the port we
    // report free is free for the bind that actually follows.
    probe.listen(0, () => {
      const addr = probe.address();
      if (!addr || typeof addr === 'string') {
        probe.close(() => reject(new Error('could not determine an ephemeral port')));
        return;
      }
      const { port } = addr;
      probe.close(err => (err ? reject(err) : resolve(port)));
    });
  });
}

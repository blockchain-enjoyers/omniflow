import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { recoverTransactionAddress, type Address, type TransactionSerialized } from "viem";

/**
 * EMULATION ONLY. A hosted demo has one public origin: the gateway sends each path prefix to the service behind it
 * (the prefix is stripped) and the rest to the dashboard. The chain's RPC is public too — the claim page reads it —
 * so only methods a real node would answer pass: anvil's own (anvil_*, evm_*, eth_sendTransaction from its unlocked
 * accounts) would let any visitor rewrite the demo. Signed transactions pass too, except from the stack's own accounts:
 * their keys are anvil's public development keys, and a stranger's transaction from one would break the submitter's
 * or the bundler's nonces.
 */
export interface Route {
  prefix: string;
  port: number;
  /** JSON-RPC: read methods and signed transactions pass — not from these senders */
  rpc?: { blockedSenders: Address[] };
}

const RPC_ALLOWED = /^(eth_(?!sendTransaction$|sign|accounts$|coinbase$|mining$|submitWork$|submitHashrate$)\w+|net_version|net_listening|web3_clientVersion)$/;

export async function rpcAllowed(body: unknown, blockedSenders: Address[] = []): Promise<boolean> {
  const calls = Array.isArray(body) ? body : [body];
  if (!calls.length || calls.length > 50 || !calls.every((c) => typeof c?.method === "string" && RPC_ALLOWED.test(c.method))) return false;
  const blocked = new Set(blockedSenders.map((a) => a.toLowerCase()));
  for (const c of calls) {
    if (c.method !== "eth_sendRawTransaction") continue;
    try {
      const from = await recoverTransactionAddress({ serializedTransaction: c.params?.[0] as TransactionSerialized });
      if (blocked.has(from.toLowerCase())) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function forward(req: IncomingMessage, res: ServerResponse, port: number, path: string, body?: Buffer) {
  const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: `127.0.0.1:${port}` };
  const prior = req.headers["x-forwarded-for"];
  headers["x-forwarded-for"] = [prior, req.socket.remoteAddress].filter(Boolean).join(", ");
  if (body) headers["content-length"] = String(body.length);
  const up = request({ host: "127.0.0.1", port, method: req.method, path, headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "service unavailable" }));
  });
  if (body) up.end(body);
  else req.pipe(up);
}

export function startGateway(port: number, routes: Route[], fallback: number): Promise<Server> {
  const sorted = [...routes].sort((a, b) => b.prefix.length - a.prefix.length);
  const srv = createServer((req, res) => {
    const url = req.url ?? "/";
    const route = sorted.find((r) => url === r.prefix || url.startsWith(`${r.prefix}/`) || url.startsWith(`${r.prefix}?`));
    if (!route) return forward(req, res, fallback, url);
    const path = url.slice(route.prefix.length) || "/";
    if (!route.rpc) return forward(req, res, route.port, path.startsWith("/") ? path : `/${path}`);
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type" });
      return res.end();
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 256 * 1024) req.destroy();
      else chunks.push(c);
    });
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      let ok = false;
      try {
        ok = req.method === "POST" && (await rpcAllowed(JSON.parse(body.toString("utf8")), route.rpc!.blockedSenders));
      } catch {}
      if (!ok) {
        res.writeHead(403, { "content-type": "application/json", "access-control-allow-origin": "*" });
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32601, message: "method not available on the public demo RPC" } }));
      }
      forward(req, res, route.port, "/", body);
    });
  });
  return new Promise((ok, fail) => {
    srv.listen(port, () => ok(srv));
    srv.on("error", fail);
  });
}

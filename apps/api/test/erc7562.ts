import { getAddress, hexToBigInt, keccak256, pad, type Address, type Hex } from "viem";

/**
 * A narrow ERC-7562 check of OUR side of validation — the account (Kernel) and the contracts it calls from
 * validateUserOp (WeightedECDSAValidator) — on a real bundle transaction, via anvil's JS tracer.
 *
 * Rules checked (ERC-7562, for an unstaked account that already exists):
 *   OP-011  no banned opcodes during validation;
 *   OP-012  GAS only immediately before a *CALL;
 *   STO-010 the account's own storage — allowed;
 *   STO-021 storage of other contracts — only slots associated with the sender: keccak(A‖x)+n, n ≤ 128.
 * Not checked: paymaster rules (ZeroDev's paymaster is theirs), staking, code-hash stability, reputation, opcode rules
 * inside the paymaster. A hosted bundler's own simulation remains the final word.
 */
const BANNED = ["GASPRICE", "GASLIMIT", "DIFFICULTY", "PREVRANDAO", "TIMESTAMP", "BASEFEE", "BLOCKHASH", "NUMBER", "SELFBALANCE", "BALANCE", "ORIGIN", "CREATE", "COINBASE", "SELFDESTRUCT", "BLOBHASH", "BLOBBASEFEE", "INVALID"];
const CALLS = ["CALL", "DELEGATECALL", "STATICCALL", "CALLCODE"];

const tracer = (entryPoint: Address, sender: Address) => `{
  ep: "${entryPoint.toLowerCase()}", sender: "${sender.toLowerCase()}",
  frames: [], exec: false, prev: "", access: [], keccak: [], ops: [],
  enter: function (fr) {
    var to = toHex(fr.getTo()).toLowerCase();
    var sel = toHex(fr.getInput()).slice(0, 10);
    if (!this.exec && to === this.ep && sel === "0x0042dc53") this.exec = true;   // innerHandleOp: execution begins
    var inAcct = this.frames.length > 0 && this.frames[this.frames.length - 1];
    if (!this.exec && to === this.sender && sel === "0x19822f7c") inAcct = true;   // validateUserOp
    this.frames.push(inAcct);
  },
  exit: function (r) { this.frames.pop(); },
  step: function (log) {
    if (this.exec || this.frames.length === 0 || !this.frames[this.frames.length - 1]) { this.prev = ""; return; }
    var op = log.op.toString();
    var addr = toHex(log.contract.getAddress()).toLowerCase();
    if (op === "SLOAD" || op === "SSTORE") this.access.push({ op: op, addr: addr, slot: log.stack.peek(0).toString(16) });
    if (op === "KECCAK256" || op === "SHA3") {
      var off = parseInt(log.stack.peek(0).toString(16), 16), len = parseInt(log.stack.peek(1).toString(16), 16);
      this.keccak.push(toHex(log.memory.slice(off, off + len)));
    }
    if (this.prev === "GAS" && ${JSON.stringify(CALLS)}.indexOf(op) < 0) this.ops.push({ op: "GAS-not-before-CALL", addr: addr });
    if (${JSON.stringify(BANNED)}.indexOf(op) >= 0) this.ops.push({ op: op, addr: addr });
    this.prev = op;
  },
  fault: function (log) {},
  result: function () { return { access: this.access, keccak: this.keccak, ops: this.ops }; }
}`;

export interface Erc7562Report {
  accesses: number;
  foreignAccesses: { op: string; addr: Address; slot: Hex; associated: boolean }[];
  violations: string[];
}

/** `associateWith` exists only for the negative control: association checked against another address must fail. */
export async function checkAccountValidation(rpcUrl: string, txHash: Hex, entryPoint: Address, sender: Address, associateWith: Address = sender): Promise<Erc7562Report> {
  const r = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "debug_traceTransaction", params: [txHash, { tracer: tracer(entryPoint, sender) }] }),
  });
  const j = (await r.json()) as { result?: { access: { op: string; addr: string; slot: string }[]; keccak: Hex[]; ops: { op: string; addr: string }[] }; error?: { message: string } };
  if (!j.result) throw new Error(`debug_traceTransaction: ${j.error?.message}`);
  const senderWord = pad(associateWith.toLowerCase() as Hex, { size: 32 }).slice(2);
  // bases of slots associated with the sender: keccak of any preimage that starts with the padded sender address
  const bases = j.result.keccak.filter((k) => k.length >= 66 && k.slice(2, 66).toLowerCase() === senderWord).map((k) => hexToBigInt(keccak256(k)));
  const violations: string[] = [];
  const foreignAccesses: Erc7562Report["foreignAccesses"] = [];
  for (const a of j.result.access) {
    if (getAddress(a.addr) === getAddress(sender)) continue; // STO-010
    const slot = BigInt(`0x${a.slot}`);
    const associated = bases.some((b) => slot >= b && slot - b <= 128n);
    foreignAccesses.push({ op: a.op, addr: getAddress(a.addr), slot: `0x${a.slot}`, associated });
    if (!associated) violations.push(`STO-021: ${a.op} ${a.addr} slot 0x${a.slot} is not associated with the sender`);
  }
  for (const o of j.result.ops) violations.push(`OP-011/012: ${o.op} in ${o.addr}`);
  return { accesses: j.result.access.length, foreignAccesses, violations };
}

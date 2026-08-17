# visreceipt

`@latticeag/visreceipt` hash-chains agent records into an append-only NDJSON `.vrc` file. The `visreceipt` CLI reports the first broken link.

v1 is tamper-evident, not tamper-proof. There are no signing keys. An operator who rewrites the whole file, genesis included, gets a new internally consistent chain. Catching that rewrite needs a committed `chain_head` stored off this disk. `verify --export --expect-head` is that check.

The recorder stays VisReplay. The sidecar for `session.vrs` is `session.vrs.vrc`.

MIT License. Binary name `visreceipt`. Node `>=20`. Package version `0.1.0`.

## Install

```bash
npm install @latticeag/visreceipt
```

Peer `@latticeag/visreplay` is optional. `--from-vrs` still parses `visreplay/session/1.0` without it.

## SDK

```ts
import { ReceiptLedger, attachReceipts, sidecarPath, assertSealed } from "@latticeag/visreceipt";
import { VisReplay } from "@latticeag/visreplay";

const recorder = new VisReplay({ sessionName: "deploy-staging", agentType: "custom" });
attachReceipts(recorder);
const agent = recorder.wrap(myAgent);
await agent.run("Deploy to staging");
recorder.end();
await recorder.save("sessions/deploy-staging.vrs");
// sidecar sessions/deploy-staging.vrs.vrc now exists

const ledger = await ReceiptLedger.open("sessions/deploy-staging.vrs.vrc");
const verified = await ledger.verify();
if (!verified.ok) throw new Error(verified.broken_at!.reason);
await assertSealed(ledger, { freeze_point: "session_end", subject_id: recorder.getSession().sessionId });
```

`sidecarPath(p)` is `p + ".vrc"`. `exportRange` and `inspect` live on `ReceiptLedger`. `verifyExport` checks a `visreceipt/export/1.0` slice. `assertSealed` throws `VRC2001` if the freeze is missing, `VRC2003` if the seal is older than `max_age_ms` (default 300000, `0` skips age), and `VRC2004` if the chain is not ok. It does not run tools.

## CLI

```bash
visreceipt seal --from-vrs session.vrs
visreceipt verify session.vrs.vrc
visreceipt verify session.vrs.vrc --expect-head <hex>
visreceipt export session.vrs.vrc --from-seq 1 --to-seq LAST --out slice.json
visreceipt verify --export slice.json --expect-head <hex>
visreceipt inspect session.vrs.vrc --head
visreceipt inspect session.vrs.vrc --seq 42 --vrs session.vrs
visreceipt gate --ledger session.vrs.vrc --subject-id SESSIONID --freeze-point session_end
visreceipt doctor
```

`verify` stops at the first broken link and names it by `seq`, line, and `reason`. `export --out` writes mode `0o600`. `inspect --no-redact` needs a TTY and `VISRECEIPT_ALLOW_UNREDACTED=1`. `gate --soft` prints the error and still exits 0.

Config file is `visreceipt.json`, UTF-8 LF, no comments. The loader walks parents from cwd. `VISRECEIPT_CONFIG` overrides the path. Unknown keys fail the load.

## License

MIT. Copyright LatticeAG.

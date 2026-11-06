# Workspace archive streaming verification

The Phase 1 ZIP upload now avoids constructing a complete archive buffer before
private R2 persistence. The capture boundary still holds a bounded snapshot of
the approved files. This is streaming archive output, not an unbounded source
collector or a claim of deployed R2 acceptance.

## Implementation

`apps/backend/src/workspace-archive.ts` uses the existing pinned
`fflate@0.8.3` streaming `Zip` and `ZipPassThrough` APIs. The installed package
has an MIT license. No reference repository code or new dependency was added.
ZIP entries use the existing uncompressed store method, deterministic ordering
and fixed timestamps. A first pass computes the exact ZIP byte length and
SHA-256 incrementally with `node:crypto`. It retains no complete ZIP buffer.
The second pass writes the same captured bytes in chunks of at most 65,536 bytes
through a native `FixedLengthStream` into the private R2 binding. The bounded
central directory is smaller than a data chunk.

The current Worker configuration already enables `nodejs_compat` with a
`2026-06-01` compatibility date. The local Worker test uses this same date and
flag. The following official API contracts were checked on November 5, 2026:

- [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
  accepts known-length streams, verifies the supplied SHA-256 and resolves a
  successful `put` after the object is stored.
- [FixedLengthStream](https://developers.cloudflare.com/workers/runtime-apis/streams/transformstream/#fixedlengthstream)
  exposes a known-length readable stream and rejects too many or too few bytes.
- [Workers Node crypto](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/)
  supports incremental hashing under the configured Node compatibility flag.
  Web Crypto is used only for the small run-scope digest and existing HMAC flow.

`run-deliverables.ts` validates and decodes all selected files before its first
asynchronous operation, so later changes to the caller's capture objects do not
alter the archive or its precomputed identity. Only the approved `out/` capture
scope is selected. Existing settled Git capture, traversal, symlink and mutation
checks remain in the runtime and were not changed.

The archive remains bounded to 64 files, 1 MiB per file and 8 MiB total input.
Binary and zero-byte entries, plus the valid 22-byte empty ZIP, are preserved.
Legacy text deliverables continue to reject empty and non-text output. A separate
buffered adapter remains for callers explicitly requesting archive bytes;
the persistence path does not use that adapter.

The run's existing abort signal now reaches persistence. An abort stops a
backpressured writer directly. Storage rejection, null response, partial upload,
checksum or length error, and cancellation all prevent a returned artifact
bundle. The R2 acknowledgment and completed producer are both awaited before a
completion link is returned. An uncertain upload can leave private bytes, but
cannot publish a new completion link; this path does not delete an object that
a prior successful attempt may still reference.

The existing seven-day HMAC capability, fragment-only landing URL and explicit
same-origin POST download flow are unchanged. No S3 signing credentials or
public bucket configuration were introduced.

## Verification

The following focused command passed 189 tests across eight files:

```sh
pnpm -C apps/backend test test/workspace-archive-worker.test.ts test/workspace-artifacts.test.ts test/ephemeral-completion.integration.test.ts test/run-deliverables.test.ts test/artifact-capture-security.test.ts test/artifact-download.test.ts test/runtime.test.ts test/run-deliverables-routes.test.ts
```

The native local Wrangler test invokes the production persistence and download
functions, with a local R2 binding. It verifies empty and multi-chunk binary ZIPs,
download hashes and byte counts, fragment-only capabilities, and native R2
rejection of mismatched checksums and short known-length bodies without storing
the failed objects. Other tests cover the maximum total binary payload,
post-capture mutation, delayed R2 acknowledgment, partial upload plus retry,
storage failure before consumption, pre-aborted work and abort under storage
backpressure. The existing approval, capture security, download integrity and
completion tests pass with the new upload path.

An independent source and security review found no blocker and separately passed
all 22 tests in the two archive suites. Backend source type checking, focused
ESLint and the new-file Biome checks also passed. The native fixture owns and
terminates its local Wrangler process group on POSIX systems.

No remote object upload, model call, sandbox container execution, deployment or
new credential was performed. Live account-specific Cloudflare/R2 acceptance
remains a separate requirement.

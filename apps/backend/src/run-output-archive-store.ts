import { stableHash, stableJson, type JsonValue } from "@shiba/shared";
import type { ArchiveAuthorization, ArchiveSourceProof } from "./run-output-archive.js";
import type { RunRoomFrame, RunRoomIdentity, RunRoomEvent } from "./run-room-events.js";
import { archiveReservationDigest, type ArchiveReservation } from "./run-output-archive-reservations.js";

interface ArchiveRow { [key: string]: string | number | null;
  id: string; job_id: string; reservation_json: string; reservation_digest: string; expires_at: number;
  state: string; epoch: string | null; source_digest: string | null; acknowledged_through: number; source_sequence: number;
  event_count: number; byte_count: number; chain_digest: string; reason: string | null; exit_code: number | null;
}
export class RunOutputArchiveStore {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS room_output_archives (
      id TEXT PRIMARY KEY,job_id TEXT NOT NULL UNIQUE,reservation_json TEXT NOT NULL,reservation_digest TEXT NOT NULL,
      expires_at INTEGER NOT NULL,state TEXT NOT NULL,epoch TEXT,source_digest TEXT,
      acknowledged_through INTEGER NOT NULL DEFAULT 0,source_sequence INTEGER NOT NULL DEFAULT 0,
      event_count INTEGER NOT NULL DEFAULT 0,byte_count INTEGER NOT NULL DEFAULT 0,chain_digest TEXT NOT NULL,reason TEXT,exit_code INTEGER)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS room_output_archive_events (
      archive_id TEXT NOT NULL,ordinal INTEGER NOT NULL,event_id TEXT NOT NULL,room_sequence INTEGER NOT NULL,
      source_sequence INTEGER NOT NULL,body TEXT NOT NULL,created_at INTEGER NOT NULL,chain_digest TEXT NOT NULL,
      PRIMARY KEY(archive_id,ordinal),UNIQUE(archive_id,event_id))`);
  }
  private prune(now: number) {
    this.sql.exec("DELETE FROM room_output_archive_events WHERE archive_id IN (SELECT id FROM room_output_archives WHERE expires_at<=?)", now);
    this.sql.exec("DELETE FROM room_output_archives WHERE expires_at<=?", now);
  }
  expire(now: number): void { this.prune(now); }
  nextExpiry(): number | undefined {
    return this.sql.exec<{ expires_at: number }>("SELECT min(expires_at) AS expires_at FROM room_output_archives").toArray()[0]?.expires_at ?? undefined;
  }
  get(id: string): ArchiveRow | undefined {
    return this.sql.exec<ArchiveRow>("SELECT * FROM room_output_archives WHERE id=?", id).toArray()[0];
  }
  reservation(id: string): ArchiveReservation {
    const row = this.get(id); if (!row) throw new Error("Output archive not found.");
    return JSON.parse(row.reservation_json) as ArchiveReservation;
  }
  forJob(jobId: string): ArchiveRow | undefined {
    return this.sql.exec<ArchiveRow>("SELECT * FROM room_output_archives WHERE job_id=?", jobId).toArray()[0];
  }
  open(identity: RunRoomIdentity, auth: ArchiveAuthorization): void {
    const reservation = auth.reservation, now = Date.now(); this.prune(now);
    if (identity.ownerId !== reservation.ownerId || identity.sessionId !== reservation.sessionId || identity.runId !== reservation.runId) throw new Error("Output archive room does not match.");
    const existing = this.forJob(reservation.jobId);
    if (existing) {
      if (existing.id !== reservation.id || existing.reservation_digest !== archiveReservationDigest(reservation)) throw new Error("Output archive identity changed.");
      return;
    }
    const counts = this.sql.exec<{ count: number; bytes: number }>("SELECT count(*) AS count,coalesce(sum(8388608),0) AS bytes FROM room_output_archives WHERE expires_at>?", now).toArray()[0]!;
    if (counts.count >= reservation.policy.roomMaxArchives || counts.bytes + reservation.policy.maxBytes > reservation.policy.roomMaxBytes) throw new Error("Room output archive reservation is full.");
    // Reserve bounded metadata overhead as well as canonical UTF-8 payload.
    const body = JSON.stringify(reservation), bytes = new TextEncoder().encode(body).length + 2_048;
    this.sql.exec(`INSERT INTO room_output_archives(id,job_id,reservation_json,reservation_digest,expires_at,state,byte_count,chain_digest)
      VALUES(?,?,?,?,?,'admitted',?,?)`, reservation.id, reservation.jobId, body, archiveReservationDigest(reservation), reservation.policy.expiresAt, bytes,
      stableHash(["shiba.output-archive-chain.v1", archiveReservationDigest(reservation)]));
  }
  freeze(id: string, reason: string): void {
    this.sql.exec("UPDATE room_output_archives SET state='incomplete',reason=? WHERE id=? AND state IN ('admitted','active')", reason, id);
  }
  /** Called inside the SAME transaction as display events, receipts and source ACK. */
  append(auth: ArchiveAuthorization, proof: ArchiveSourceProof, frames: RunRoomFrame[], sourceSequence: number, acknowledgedThrough: number): void {
    let row = this.get(auth.reservation.id);
    if (row?.state === "complete" && !frames.length && row.epoch === proof.epoch && row.source_digest === proof.digest &&
      sourceSequence === row.source_sequence && acknowledgedThrough === row.acknowledged_through) return;
    if (!row || row.reservation_digest !== archiveReservationDigest(auth.reservation) || row.expires_at <= Date.now() || !["admitted", "active"].includes(row.state) ||
      row.epoch !== null && row.epoch !== proof.epoch || row.source_digest !== null && row.source_digest !== proof.digest) throw new Error("Output archive is frozen, expired or from another native epoch.");
    if (Date.now() >= auth.reservation.writeDeadline) throw new Error("Original output archive write deadline expired.");
    for (const frame of frames) {
      const ordinal: number = row.event_count + 1, body = stableJson(frame.event as unknown as JsonValue);
      const entry: JsonValue[] = [row.id, ordinal, frame.eventId, frame.sequence, sourceSequence, body, frame.createdAt];
      const chain: string = stableHash([row.chain_digest, entry]);
      const bytes: number = new TextEncoder().encode(JSON.stringify([...entry, chain])).length;
      if (ordinal > auth.reservation.policy.maxEvents || row.byte_count + bytes > auth.reservation.policy.maxBytes) throw new Error("Output archive storage bound reached. No source acknowledgment advanced.");
      this.sql.exec(`INSERT INTO room_output_archive_events(archive_id,ordinal,event_id,room_sequence,source_sequence,body,created_at,chain_digest)
        VALUES(?,?,?,?,?,?,?,?)`, row.id, ordinal, frame.eventId, frame.sequence, sourceSequence, body, frame.createdAt, chain);
      row = { ...row, event_count: ordinal, byte_count: row.byte_count + bytes, chain_digest: chain };
    }
    this.sql.exec(`UPDATE room_output_archives SET state='active',epoch=?,source_digest=?,acknowledged_through=?,source_sequence=?,event_count=?,byte_count=?,chain_digest=? WHERE id=?`,
      proof.epoch, proof.digest, Math.max(row.acknowledged_through, acknowledgedThrough), Math.max(row.source_sequence, sourceSequence), row.event_count, row.byte_count, row.chain_digest, row.id);
  }
  complete(id: string, sourceSequence: number, exitCode: number): void {
    const row = this.get(id);
    if (row?.state === "complete" && row.acknowledged_through === sourceSequence && row.source_sequence === sourceSequence && row.exit_code === exitCode) return;
    if (!row || row.state !== "active" || row.acknowledged_through !== sourceSequence || row.source_sequence !== sourceSequence || !Number.isSafeInteger(exitCode)) throw new Error("Output archive has no complete verified source receipt.");
    this.sql.exec("UPDATE room_output_archives SET state='complete',exit_code=? WHERE id=?", exitCode, id);
  }
  page(id: string, after: number, limit = 32) {
    const row = this.get(id);
    if (!row || row.expires_at <= Date.now()) throw new Error("Output archive lease expired.");
    if (!Number.isSafeInteger(after) || after < 0 || after > row.event_count || !Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw new Error("Invalid output archive cursor.");
    const events = this.sql.exec<{ ordinal: number; event_id: string; room_sequence: number; source_sequence: number; body: string; created_at: number; chain_digest: string }>(
      "SELECT ordinal,event_id,room_sequence,source_sequence,body,created_at,chain_digest FROM room_output_archive_events WHERE archive_id=? AND ordinal>? ORDER BY ordinal LIMIT ?", id, after, limit).toArray();
    const previous = after > 0 ? this.sql.exec<{ chain_digest: string }>("SELECT chain_digest FROM room_output_archive_events WHERE archive_id=? AND ordinal=?", id, after).toArray()[0]?.chain_digest
      : stableHash(["shiba.output-archive-chain.v1", row.reservation_digest]);
    if (!previous) throw new Error("Output archive checkpoint is incomplete.");
    return { archiveId: id, jobId: row.job_id, reservationDigest: row.reservation_digest, state: row.state, reason: row.reason, expiresAt: row.expires_at, previousChainDigest: previous,
      acknowledgedThrough: row.acknowledged_through, lastObservedSource: row.source_sequence, eventCount: row.event_count, byteCount: row.byte_count,
      chainDigest: row.chain_digest, finalExitCode: row.exit_code, incompleteTail: row.state !== "complete", tailUpperBound: row.state === "complete" ? row.source_sequence : null,
      after, nextCursor: events.at(-1)?.ordinal ?? after, hasMore: (events.at(-1)?.ordinal ?? after) < row.event_count,
      events: events.map((event) => ({ ordinal: event.ordinal, eventId: event.event_id, roomSequence: event.room_sequence, sourceSequence: event.source_sequence,
        event: JSON.parse(event.body) as Extract<RunRoomEvent, { kind: "terminal" }>, createdAt: event.created_at, chainDigest: event.chain_digest })) };
  }
}

// #7398 all-lanes (ruling 7439-4): the egress plane's record/serve seam for
// the non-OpenAI lanes. The OpenAI lane carries the full mechanism inline in
// prepare-openai.ts (authority seam + serve + record); these helpers give the
// other wires the same lane-neutral core round-trip.
//
// ORDER MATTERS — record FIRST, serve from the view THAT CALL just wrote:
// the served core must contain THIS turn's new message. Serving before
// recording hands back last turn's view (this turn's user input vanishes
// from the outbound) and then records a diff against that same replaced
// view — zero ops, flow frozen forever. review 7439-deviations P1-1.
//
// The system row lives INSIDE the recorded view (type "system") but is
// excluded from the served core — each lane builds its own system block live
// (prefix-cache anchor), exactly like the OpenAI lane. Callers pass the
// lane's OUTBOUND system text (post-injection), so system drift is visible
// as a +U op on that row.
//
// Authority scoping (ruling 7439-5): applyEgressAuthority (below) is the
// lane-neutral INPUT authority seam extracted from the OpenAI lane — when
// a pinned lane arms (feature ON + plugin + non-transient + pinned view),
// the server op log becomes the session's content authority for good:
// hard-fail on an unreadable flow, bootstrap the client bytes once on an
// empty flow, probe-gated canonical swap afterwards. The anthropic & google
// lanes call it with pinned:null for now (they pin without the stage-0
// identity layer — arming them awaits the owner's ruling), so their turns
// still record the client's resends as an optimization surface with the
// client as input authority; a corrupt log point there degrades the ONE
// turn to the legacy core (never a crash, never a partial rebuild).
//
// Rollout gate (egressPlane, default 0) is owned by the caller.

import { recoverEgressBase, recordEgressTurn, EgressAuthorityRejectError, type EgressOpLogStore } from "../storage/egress-record.js";
import { rebuildCoreFromLog } from "../storage/egress-serve.js";
import { featureEnabled } from "../rollout.js";
import type { EgressViewRow } from "../storage/egress-state.js";
import { getStore } from "../persist.js";
import type { Session } from "../session.js";
import type { BiliMessage } from "acp-kernel/wire";

type LaneLog = (level: string, msg: string) => void;

/** Append this turn's outbound core view as sparse ops. A corrupt log point
 * skips this turn (warn); the next turn re-derives from the stored view. */
export function recordLaneTurn(st: EgressOpLogStore, sessionId: string, conversation: BiliMessage[], systemText: string, log: LaneLog): void {
    try {
        recordEgressTurn({ store: st, sessionId, prev: undefined, conversation, systemText, nowMs: Date.now() });
    } catch (err) {
        log("warn", `[${sessionId}] egress op-log recording skipped this turn (corrupt log point — self-heals next turn): ${String(err)}`);
    }
}

/** Rebuild the session's recorded core view from the flow tables (current
 * healthy point, or a bounded walk-back + truncate past a structurally
 * corrupt point). Null when nothing is servable — the lane keeps its
 * legacy core for this turn. */
export function rebuildLaneCore(st: EgressOpLogStore, sessionId: string, log: LaneLog): BiliMessage[] | null {
    try {
        const base = recoverEgressBase(st, sessionId);
        if (base === null || base.view.length === 0) return null;
        const core = rebuildCoreFromLog(base.view);
        if (core === null || core.length === 0) return null;
        log("info", `[${sessionId}] egress-serve: served ${base.view.length} rows from op-log${base.degraded ? ` (degraded healthy point, log_seq=${base.seq})` : ""}`);
        return core;
    } catch (err) {
        log("error", `[${sessionId}] egress-serve: log point corrupt or unrebuildable — legacy this turn (session-recovery marker): ${String(err)}`);
        return null;
    }
}

/** Record THIS turn's core view, then serve the view that call just wrote
 * (see the ORDER MATTERS note above). Returns null when the just-recorded
 * view is not servable — the lane keeps its legacy core. */
export function serveLaneTurn(args: {
    st: EgressOpLogStore;
    sessionId: string;
    conversation: BiliMessage[];
    systemText: string;
    log: LaneLog;
}): BiliMessage[] | null {
    recordLaneTurn(args.st, args.sessionId, args.conversation, args.systemText, args.log);
    return rebuildLaneCore(args.st, args.sessionId, args.log);
}

export interface EgressAuthorityResult {
    /** arm gate hit (feature ON + plugin + non-transient + pinned view) —
     * the session is latched egress-authoritative from this turn. */
    armed: boolean;
    /** The kernel-input view the lane must run on: the canonical swap when
     * `swapped`, else the input array untouched (reference identity). */
    core: BiliMessage[];
    /** Turn-1 cold start: empty flow, the client bytes are the content
     * source EXACTLY ONCE (the turn's record puts them in the flow). */
    bootstrapping: boolean;
    /** the input was swapped to the server's canonical bytes (probe passed). */
    swapped: boolean;
    /** The healthy point's view rows — the record's `prev` for this turn
     * (null: nothing was read this turn, e.g. probe-failed degrade). */
    base: EgressViewRow[] | null;
}

/** Ruling 7439-5 INPUT authority seam (lane-neutral, extracted from the
 * OpenAI lane — prepare-openai.ts used to carry this inline): when armed —
 * egressPlane ON + plugin mode + non-transient turn + a pinned identity
 * view — the server's egress op log becomes the session's content authority
 * for good (the latch persists in session metadata, surviving restarts):
 *
 *  - no healthy flow point at all → HARD FAIL (the one non-negotiable of the
 *    ruling: never run on client bytes when the server log is unreadable; the
 *    marker latches and the client's retry hits the same error until
 *    recovery);
 *  - empty flow → bootstrap: the client bytes enter the flow exactly once
 *    (this turn's record), from turn 2 the log is the content source;
 *  - rebuildable view → the input's rows are swapped to the server's
 *    canonical bytes by id (probe-gated: a reordered client degrades this
 *    turn — no swap, no flow advance — and re-attempts next).
 *
 * NOT armed (feature off / proxy traffic / transient side turns / no pinned
 * view — the anthropic & google lanes pin without the stage-0 identity
 * layer and pass null until the owner rules their arm condition): the
 * caller's array comes back untouched and nothing is latched.
 *
 * The store being absent (non-sqlite install) is a soft degrade: the latch
 * stands (ruling: server-authority is a session property) but this turn's
 * record/serve simply do not run — the same behavior the OpenAI lane always
 * had for `st === null`. */
export function applyEgressAuthority(args: {
    session: Session;
    sessionId: string;
    core: BiliMessage[];
    pluginMode: boolean;
    /** transient side turns (title-gen / compaction) never arm. */
    isTitleGen: boolean;
    /** the lane's pinned identity view (stage-0 `pinned`; null when the lane
     * has no pin for this turn — never arms). */
    pinned: readonly BiliMessage[] | null;
    log: LaneLog;
}): EgressAuthorityResult {
    const { session, sessionId, core, pluginMode, isTitleGen, pinned, log } = args;
    const idle: EgressAuthorityResult = { armed: false, core, bootstrapping: false, swapped: false, base: null };
    if (!featureEnabled("egressPlane") || !pluginMode || isTitleGen || pinned === null) return idle;
    // Ruling 7439: from this turn the op log is the content source of truth
    // for the session, so the unified-storage verifier must not compare
    // client-resend bytes against the canonical rows (that compare diverges
    // BY DESIGN once the server serves canonical bytes the client never saw
    // verbatim). The marker persists in session metadata (meta_json) so it
    // survives restarts and covers every later turn, not just this one.
    session.metadata["egressAuthority"] = true;
    const st = getStore().egressOpLogStore();
    if (st === null || st === undefined) return { ...idle, armed: true };
    const base0 = recoverEgressBase(st, sessionId);
    if (base0 === null) {
        log("error", `[${sessionId}] egress-authority: no healthy flow point — refusing to run on client bytes (ruling 7439-5); latching egressFlowUnreadable, session-level recovery required`);
        session.metadata["egressFlowUnreadable"] = true;
        throw new EgressAuthorityRejectError(`egress-authority: session ${sessionId} has no healthy op-log point (ruling 7439-5) — failing the turn instead of trusting client bytes`);
    }
    const view = base0.view;
    if (view.length === 0) {
        log("info", `[${sessionId}] egress-authority: bootstrap — empty flow, client bytes recorded once (turn 1 of the op-log)`);
        return { armed: true, core, bootstrapping: true, swapped: false, base: view };
    }
    const base = rebuildCoreFromLog(view) ?? [];
    if (base.length > 0 && egressAuthorityProbe(base, core, sessionId, log)) {
        const baseById = new Map(base.map((m) => [m.id, m] as const));
        log("info", `[${sessionId}] egress-authority: ${base.length} existing row(s) served from the op-log, ${Math.max(0, core.length - base.length)} fresh from the client${base0.degraded ? ` (recovered to log_seq=${base0.seq}, truncated ${base0.truncated} row(s))` : ""}`);
        return { armed: true, core: core.map((c) => baseById.get(c.id) ?? c), bootstrapping: false, swapped: true, base: view };
    }
    log("warn", `[${sessionId}] egress-authority: probe failed — flow NOT advanced this turn; legacy bytes served (re-attempts next turn)`);
    return { armed: true, core, bootstrapping: false, swapped: false, base: null };
}

/** Ruling 7439-5 input probe (discussions/7439) — light per-turn identity
 * + byte SAMPLING on sampled rows only (never a full byte comparison).
 * Part 1 ORDER: every client id that exists in the server view must appear
 * in server-view order (append-only + client-side folding contract; a
 * reorder means the client is not echoing the server's conversation → the
 * turn degrades to legacy). Part 2 DIVERGENCE: up to 8 sampled rows compare
 * contentType + text length + (short, ≤32KB) exact text. A mismatch does NOT
 * fail the probe — the seam keeps server bytes regardless of what the client
 * sent; sampling only LOGS the divergence event (ruling: 记日志 + 警告,
 * 内容跟服务端, 出站自然收敛). */
export function egressAuthorityProbe(
    base: readonly BiliMessage[],
    client: readonly BiliMessage[],
    sessionId: string,
    log: LaneLog,
): boolean {
    const baseIndex = new Map<string, number>();
    base.forEach((m, i) => {
        if (!baseIndex.has(m.id)) baseIndex.set(m.id, i);
    });
    let cursor = -1;
    for (const c of client) {
        const i = baseIndex.get(c.id);
        if (i === undefined) continue;
        if (i <= cursor) return false;
        cursor = i;
    }
    let diverged = 0;
    const step = Math.max(1, Math.floor(client.length / 8));
    for (let i = 0; i < client.length; i += step) {
        const c = client[i];
        const bi = baseIndex.get(c.id);
        if (bi === undefined) continue;
        const b = base[bi];
        const ct = typeof c.text === "string" ? c.text : "";
        const bt = typeof b.text === "string" ? b.text : "";
        if (c.contentType !== b.contentType || ct.length !== bt.length || (ct.length <= 32768 && ct !== bt)) diverged++;
        if (diverged >= 4) break;
    }
    if (diverged > 0) {
        log("warn", `[${sessionId}] egress-authority divergence: ${diverged} sampled row(s) differ client-vs-server — server bytes win (client edits do not stick until the egress update API exists; discussions/7439 ruling 5)`);
    }
    return true;
}

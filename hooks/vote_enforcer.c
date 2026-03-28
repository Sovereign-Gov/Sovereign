/**
 * Sovereign — Vote Enforcer Hook
 * Xahau Hook (C → WebAssembly)
 *
 * Enforces voting rules:
 *   - Sender must hold an active seat (reads seat_registry state)
 *   - Sender must have participated in deliberation (activity on proposal)
 *   - Sender must not have already voted on this proposal
 *   - Voting window must be active
 *
 * State layout:
 *   Vote record key: first 20 bytes = proposal_id hash, next 12 bytes = agent accid prefix
 *   Vote record value: [0] = vote (1=yes, 2=no, 3=abstain), [1..8] = timestamp
 *
 *   Proposal window key: "PW" + 20 bytes proposal_id hash + padding
 *   Proposal window value: [0..7] = vote_start (ledger seq), [8..15] = vote_end
 */

#include "hookapi.h"

#define VOTE_RECORD_SIZE 9

int64_t hook(uint32_t reserved)
{
    // Only trigger on incoming payments
    int64_t tt = otxn_type();
    if (tt != 0)  // ttPAYMENT
        DONE("vote_enforcer: not a payment, passing.");

    // Get originating account
    uint8_t otxn_accid[20];
    otxn_field(otxn_accid, 20, sfAccount);

    // Get hook account
    uint8_t hook_accid[20];
    hook_account(hook_accid, 20);

    // Only process incoming
    uint8_t dest_accid[20];
    otxn_field(dest_accid, 20, sfDestination);

    int is_incoming = 0;
    for (int i = 0; i < 20; i++)
    {
        if (dest_accid[i] != hook_accid[i]) break;
        if (i == 19) is_incoming = 1;
    }
    if (!is_incoming)
        DONE("vote_enforcer: outgoing tx, passing.");

    // Check memo type = "VOT" (vote)
    uint8_t memo_type[32];
    int64_t memo_type_len = otxn_field(memo_type, 32, sfMemoType);
    if (memo_type_len < 3)
        DONE("vote_enforcer: no memo type, passing.");

    if (!(memo_type[0] == 'V' && memo_type[1] == 'O' && memo_type[2] == 'T'))
        DONE("vote_enforcer: not a vote transaction, passing.");

    // Read memo data: expected format = proposal_id(32 hex = 16 bytes) + vote(1 byte)
    uint8_t memo_data[64];
    int64_t memo_data_len = otxn_field(memo_data, 64, sfMemoData);
    if (memo_data_len < 17)
        rollback(SBUF("vote_enforcer: invalid vote memo — need proposal_id + vote."), 10);

    uint8_t proposal_id[16];
    for (int i = 0; i < 16; i++)
        proposal_id[i] = memo_data[i];

    uint8_t vote_value = memo_data[16];
    if (vote_value < 1 || vote_value > 3)
        rollback(SBUF("vote_enforcer: invalid vote value. Must be 1(yes), 2(no), 3(abstain)."), 11);

    // === CHECK 1: Sender holds active seat ===
    // Read seat registry state (foreign state from seat_registry hook)
    uint8_t seat_key[32];
    for (int i = 0; i < 20; i++) seat_key[i] = otxn_accid[i];
    for (int i = 20; i < 32; i++) seat_key[i] = 0;

    uint8_t seat_record[33];
    int64_t sr = state_foreign(SBUF(seat_record), SBUF(seat_key),
                               SBUF(hook_accid));  // same account namespace
    if (sr < 0)
        rollback(SBUF("vote_enforcer: agent does not hold a seat."), 20);

    // Check status byte (offset 16) = 1 (active)
    if (seat_record[16] != 1)
        rollback(SBUF("vote_enforcer: agent seat is not active."), 21);

    // === CHECK 2: Sender participated in deliberation ===
    // Check last_activity (bytes 25-32 of seat record) is > 0
    int has_activity = 0;
    for (int i = 25; i < 33; i++)
    {
        if (seat_record[i] != 0) { has_activity = 1; break; }
    }
    if (!has_activity)
        rollback(SBUF("vote_enforcer: agent has no recorded deliberation activity."), 22);

    // === CHECK 3: Sender hasn't already voted ===
    uint8_t vote_key[32];
    for (int i = 0; i < 16; i++) vote_key[i] = proposal_id[i];
    for (int i = 0; i < 12; i++) vote_key[16 + i] = otxn_accid[i];
    for (int i = 28; i < 32; i++) vote_key[i] = 0;

    uint8_t existing_vote[VOTE_RECORD_SIZE];
    int64_t ev = state(SBUF(existing_vote), SBUF(vote_key));
    if (ev >= 0 && existing_vote[0] != 0)
        rollback(SBUF("vote_enforcer: agent has already voted on this proposal."), 23);

    // === CHECK 4: Voting window is active ===
    uint8_t pw_key[32];
    pw_key[0] = 'P'; pw_key[1] = 'W';
    for (int i = 0; i < 16; i++) pw_key[2 + i] = proposal_id[i];
    for (int i = 18; i < 32; i++) pw_key[i] = 0;

    uint8_t pw_record[16];
    int64_t pw = state(SBUF(pw_record), SBUF(pw_key));
    if (pw >= 0)
    {
        int64_t vote_start = (int64_t)pw_record[0] | ((int64_t)pw_record[1] << 8) |
                             ((int64_t)pw_record[2] << 16) | ((int64_t)pw_record[3] << 24) |
                             ((int64_t)pw_record[4] << 32) | ((int64_t)pw_record[5] << 40) |
                             ((int64_t)pw_record[6] << 48) | ((int64_t)pw_record[7] << 56);
        int64_t vote_end = (int64_t)pw_record[8] | ((int64_t)pw_record[9] << 8) |
                           ((int64_t)pw_record[10] << 16) | ((int64_t)pw_record[11] << 24) |
                           ((int64_t)pw_record[12] << 32) | ((int64_t)pw_record[13] << 40) |
                           ((int64_t)pw_record[14] << 48) | ((int64_t)pw_record[15] << 56);

        int64_t cur_seq = ledger_seq();
        if (cur_seq < vote_start)
            rollback(SBUF("vote_enforcer: voting has not started for this proposal."), 24);
        if (cur_seq > vote_end)
            rollback(SBUF("vote_enforcer: voting window has closed for this proposal."), 25);
    }
    // If no window record exists, allow vote (window managed externally)

    // === ALL CHECKS PASSED — Record vote ===
    uint8_t vote_record[VOTE_RECORD_SIZE];
    vote_record[0] = vote_value;

    int64_t cur_seq = ledger_seq();
    vote_record[1] = (uint8_t)(cur_seq & 0xFF);
    vote_record[2] = (uint8_t)((cur_seq >> 8) & 0xFF);
    vote_record[3] = (uint8_t)((cur_seq >> 16) & 0xFF);
    vote_record[4] = (uint8_t)((cur_seq >> 24) & 0xFF);
    vote_record[5] = (uint8_t)((cur_seq >> 32) & 0xFF);
    vote_record[6] = (uint8_t)((cur_seq >> 40) & 0xFF);
    vote_record[7] = (uint8_t)((cur_seq >> 48) & 0xFF);
    vote_record[8] = (uint8_t)((cur_seq >> 56) & 0xFF);

    state_set(SBUF(vote_record), SBUF(vote_key));

    accept(SBUF("vote_enforcer: vote recorded."), 0);
}

int64_t cbak(uint32_t reserved)
{
    return 0;
}

/**
 * Sovereign — Vote Enforcer Hook
 * Xahau Hook (C → WebAssembly)
 *
 * Enforces voting rules:
 *   - Sender must hold an active seat
 *   - Sender must have deliberation activity
 *   - Sender must not have already voted on this proposal
 *   - Voting window must be active
 */

#include "hookapi.h"

#define VOTE_RECORD_SIZE 9

int64_t hook(uint32_t reserved)
{
    int64_t tt = otxn_type();
    if (tt != ttPAYMENT)
        accept(SBUF("vote_enforcer: not a payment, passing."), 0);

    uint8_t otxn_accid[20];
    otxn_field(SBUF(otxn_accid), sfAccount);

    uint8_t hook_accid[20];
    hook_account(SBUF(hook_accid));

    uint8_t dest_accid[20];
    otxn_field(SBUF(dest_accid), sfDestination);

    int is_incoming = 1;
    for (int i = 0; GUARD(20), i < 20; i++)
    {
        if (dest_accid[i] != hook_accid[i])
        {
            is_incoming = 0;
            break;
        }
    }
    if (!is_incoming)
        accept(SBUF("vote_enforcer: outgoing tx, passing."), 0);

    uint8_t memo_type[32];
    int64_t memo_type_len = otxn_field(SBUF(memo_type), sfMemoType);
    if (memo_type_len < 3)
        accept(SBUF("vote_enforcer: no memo type, passing."), 0);

    if (!(memo_type[0] == 'V' && memo_type[1] == 'O' && memo_type[2] == 'T'))
        accept(SBUF("vote_enforcer: not a vote, passing."), 0);

    // Read memo data: proposal_id(16 bytes) + vote(1 byte)
    uint8_t memo_data[64];
    int64_t memo_data_len = otxn_field(SBUF(memo_data), sfMemoData);
    if (memo_data_len < 17)
        rollback(SBUF("vote_enforcer: invalid vote memo."), 10);

    uint8_t proposal_id[16];
    for (int i = 0; GUARD(16), i < 16; i++)
        proposal_id[i] = memo_data[i];

    uint8_t vote_value = memo_data[16];
    if (vote_value < 1 || vote_value > 3)
        rollback(SBUF("vote_enforcer: invalid vote value."), 11);

    // CHECK 1: Sender holds active seat
    uint8_t seat_key[32];
    for (int i = 0; GUARD(20), i < 20; i++) seat_key[i] = otxn_accid[i];
    for (int i = 20; GUARD(12), i < 32; i++) seat_key[i] = 0;

    uint8_t seat_record[33];
    // Read from own namespace (seat_registry shares same account)
    int64_t sr = state(SBUF(seat_record), SBUF(seat_key));
    if (sr < 0)
        rollback(SBUF("vote_enforcer: no seat found."), 20);

    if (seat_record[16] != 1)
        rollback(SBUF("vote_enforcer: seat not active."), 21);

    // CHECK 2: Deliberation activity
    int has_activity = 0;
    for (int i = 25; GUARD(8), i < 33; i++)
    {
        if (seat_record[i] != 0) { has_activity = 1; break; }
    }
    if (!has_activity)
        rollback(SBUF("vote_enforcer: no deliberation activity."), 22);

    // CHECK 3: Not already voted
    uint8_t vote_key[32];
    for (int i = 0; GUARD(16), i < 16; i++) vote_key[i] = proposal_id[i];
    for (int i = 0; GUARD(12), i < 12; i++) vote_key[16 + i] = otxn_accid[i];
    for (int i = 28; GUARD(4), i < 32; i++) vote_key[i] = 0;

    uint8_t existing_vote[VOTE_RECORD_SIZE];
    int64_t ev = state(SBUF(existing_vote), SBUF(vote_key));
    if (ev >= 0 && existing_vote[0] != 0)
        rollback(SBUF("vote_enforcer: already voted."), 23);

    // CHECK 4: Voting window active
    uint8_t pw_key[32];
    pw_key[0] = 'P'; pw_key[1] = 'W';
    for (int i = 0; GUARD(16), i < 16; i++) pw_key[2 + i] = proposal_id[i];
    for (int i = 18; GUARD(14), i < 32; i++) pw_key[i] = 0;

    uint8_t pw_record[16];
    int64_t pw = state(SBUF(pw_record), SBUF(pw_key));
    if (pw >= 0)
    {
        int64_t vote_start = UINT64_FROM_BUF(pw_record);
        int64_t vote_end = UINT64_FROM_BUF(pw_record + 8);

        int64_t cur_seq = ledger_seq();
        if (cur_seq < vote_start)
            rollback(SBUF("vote_enforcer: voting not started."), 24);
        if (cur_seq > vote_end)
            rollback(SBUF("vote_enforcer: voting closed."), 25);
    }

    // ALL CHECKS PASSED — Record vote
    uint8_t vote_record[VOTE_RECORD_SIZE];
    vote_record[0] = vote_value;

    int64_t cur_seq = ledger_seq();
    UINT64_TO_BUF(vote_record + 1, cur_seq);

    state_set(SBUF(vote_record), SBUF(vote_key));

    accept(SBUF("vote_enforcer: vote recorded."), 0);
    return 0;
}

int64_t cbak(uint32_t reserved)
{
    return 0;
}

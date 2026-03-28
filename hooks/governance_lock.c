/**
 * Sovereign — Governance Lock Hook
 * Xahau Hook (C → WebAssembly)
 *
 * Pre-constitution gating:
 *   - Before ratification: block all proposal/vote transactions
 *   - Allow: heartbeats (HBT), forum posts (FRM), seat claims (SEC),
 *            and constitutional ratification votes (RAT)
 *   - After ratification (constitution_ratified = 1): allow everything
 *   - Ratification requires 80% supermajority
 *
 * State:
 *   Key "CONST_RAT\0..." => [0] = 0 or 1 (constitution_ratified)
 *   Key "RAT_YES\0..."   => [0..3] = uint32_le yes count
 *   Key "RAT_NO\0..."    => [0..3] = uint32_le no count
 *   Key "RAT_TOTAL\0..." => [0..3] = uint32_le eligible voters (set externally)
 *   Key "RAT:" + accid   => [0] = voted flag (prevents double vote)
 */

#include "hookapi.h"

int64_t hook(uint32_t reserved)
{
    // Check if constitution is already ratified
    uint8_t rat_key[32];
    rat_key[0] = 'C'; rat_key[1] = 'O'; rat_key[2] = 'N'; rat_key[3] = 'S';
    rat_key[4] = 'T'; rat_key[5] = '_'; rat_key[6] = 'R'; rat_key[7] = 'A';
    rat_key[8] = 'T';
    for (int i = 9; i < 32; i++) rat_key[i] = 0;

    uint8_t rat_val[1];
    int64_t rv = state(SBUF(rat_val), SBUF(rat_key));

    // If constitution is ratified, allow everything
    if (rv >= 0 && rat_val[0] == 1)
        accept(SBUF("governance_lock: constitution ratified — all transactions allowed."), 0);

    // Constitution NOT ratified — check memo type
    uint8_t memo_type[32];
    int64_t mt_len = otxn_field(memo_type, 32, sfMemoType);

    // No memo = pass through (non-governance transaction)
    if (mt_len < 3)
        accept(SBUF("governance_lock: no memo type, passing."), 0);

    // === ALLOWED before ratification ===

    // Heartbeat (HBT)
    if (memo_type[0] == 'H' && memo_type[1] == 'B' && memo_type[2] == 'T')
        accept(SBUF("governance_lock: heartbeat allowed pre-constitution."), 0);

    // Forum post (FRM)
    if (memo_type[0] == 'F' && memo_type[1] == 'R' && memo_type[2] == 'M')
        accept(SBUF("governance_lock: forum post allowed pre-constitution."), 0);

    // Seat claim (SEC)
    if (memo_type[0] == 'S' && memo_type[1] == 'E' && memo_type[2] == 'C')
        accept(SBUF("governance_lock: seat claim allowed pre-constitution."), 0);

    // Stake deposit (STK)
    if (memo_type[0] == 'S' && memo_type[1] == 'T' && memo_type[2] == 'K')
        accept(SBUF("governance_lock: stake deposit allowed pre-constitution."), 0);

    // Activity (ACT)
    if (memo_type[0] == 'A' && memo_type[1] == 'C' && memo_type[2] == 'T')
        accept(SBUF("governance_lock: activity allowed pre-constitution."), 0);

    // === CONSTITUTIONAL RATIFICATION VOTE (RAT) ===
    if (memo_type[0] == 'R' && memo_type[1] == 'A' && memo_type[2] == 'T')
    {
        uint8_t otxn_accid[20];
        otxn_field(otxn_accid, 20, sfAccount);

        // Check if already voted on ratification
        uint8_t voter_key[32];
        voter_key[0] = 'R'; voter_key[1] = 'A'; voter_key[2] = 'T'; voter_key[3] = ':';
        for (int i = 0; i < 20; i++) voter_key[4 + i] = otxn_accid[i];
        for (int i = 24; i < 32; i++) voter_key[i] = 0;

        uint8_t voter_val[1];
        int64_t vv = state(SBUF(voter_val), SBUF(voter_key));
        if (vv >= 0 && voter_val[0] == 1)
            rollback(SBUF("governance_lock: agent already voted on ratification."), 10);

        // Read vote from memo data (1 byte: 1=yes, 2=no)
        uint8_t memo_data[8];
        int64_t md_len = otxn_field(memo_data, 8, sfMemoData);
        if (md_len < 1)
            rollback(SBUF("governance_lock: ratification vote requires vote value in memo."), 11);

        uint8_t vote = memo_data[0];
        if (vote < 1 || vote > 2)
            rollback(SBUF("governance_lock: ratification vote must be 1(yes) or 2(no)."), 12);

        // Mark as voted
        voter_val[0] = 1;
        state_set(SBUF(voter_val), SBUF(voter_key));

        // Update tally
        uint8_t yes_key[32];
        yes_key[0] = 'R'; yes_key[1] = 'A'; yes_key[2] = 'T'; yes_key[3] = '_';
        yes_key[4] = 'Y'; yes_key[5] = 'E'; yes_key[6] = 'S';
        for (int i = 7; i < 32; i++) yes_key[i] = 0;

        uint8_t no_key[32];
        no_key[0] = 'R'; no_key[1] = 'A'; no_key[2] = 'T'; no_key[3] = '_';
        no_key[4] = 'N'; no_key[5] = 'O';
        for (int i = 6; i < 32; i++) no_key[i] = 0;

        uint8_t total_key[32];
        total_key[0] = 'R'; total_key[1] = 'A'; total_key[2] = 'T'; total_key[3] = '_';
        total_key[4] = 'T'; total_key[5] = 'O'; total_key[6] = 'T';
        for (int i = 7; i < 32; i++) total_key[i] = 0;

        uint8_t count_buf[4];
        uint32_t yes_count = 0, no_count = 0, total_eligible = 0;

        if (state(count_buf, 4, SBUF(yes_key)) >= 0)
            yes_count = (uint32_t)count_buf[0] | ((uint32_t)count_buf[1] << 8) |
                        ((uint32_t)count_buf[2] << 16) | ((uint32_t)count_buf[3] << 24);

        if (state(count_buf, 4, SBUF(no_key)) >= 0)
            no_count = (uint32_t)count_buf[0] | ((uint32_t)count_buf[1] << 8) |
                       ((uint32_t)count_buf[2] << 16) | ((uint32_t)count_buf[3] << 24);

        if (state(count_buf, 4, SBUF(total_key)) >= 0)
            total_eligible = (uint32_t)count_buf[0] | ((uint32_t)count_buf[1] << 8) |
                             ((uint32_t)count_buf[2] << 16) | ((uint32_t)count_buf[3] << 24);

        if (vote == 1)
            yes_count++;
        else
            no_count++;

        // Save updated count
        uint8_t *target_key = (vote == 1) ? yes_key : no_key;
        uint32_t new_count = (vote == 1) ? yes_count : no_count;
        count_buf[0] = (uint8_t)(new_count & 0xFF);
        count_buf[1] = (uint8_t)((new_count >> 8) & 0xFF);
        count_buf[2] = (uint8_t)((new_count >> 16) & 0xFF);
        count_buf[3] = (uint8_t)((new_count >> 24) & 0xFF);
        state_set(count_buf, 4, target_key, 32);

        // Check if 80% threshold reached
        uint32_t total_votes = yes_count + no_count;
        if (total_eligible > 0 && total_votes > 0)
        {
            // 80% = yes_count * 100 >= total_votes * 80
            if (yes_count * 100 >= total_votes * 80 && total_votes >= (total_eligible / 2))
            {
                // Constitution ratified!
                rat_val[0] = 1;
                state_set(SBUF(rat_val), SBUF(rat_key));
                accept(SBUF("governance_lock: CONSTITUTION RATIFIED! All governance now unlocked."), 0);
            }
        }

        accept(SBUF("governance_lock: ratification vote recorded."), 0);
    }

    // === BLOCKED before ratification ===

    // Vote (VOT) — blocked
    if (memo_type[0] == 'V' && memo_type[1] == 'O' && memo_type[2] == 'T')
        rollback(SBUF("governance_lock: votes blocked until constitution is ratified."), 40);

    // Proposal (PRP) — blocked
    if (memo_type[0] == 'P' && memo_type[1] == 'R' && memo_type[2] == 'P')
        rollback(SBUF("governance_lock: proposals blocked until constitution is ratified."), 41);

    // Unknown memo type — pass through
    accept(SBUF("governance_lock: unrecognized memo type, passing."), 0);
}

int64_t cbak(uint32_t reserved)
{
    return 0;
}

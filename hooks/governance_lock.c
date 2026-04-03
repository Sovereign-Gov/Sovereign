/**
 * Sovereign — Governance Lock Hook
 * Xahau Hook (C → WebAssembly)
 *
 * Pre-constitution gating:
 *   - Before ratification: block all proposal/vote transactions
 *   - Allow: heartbeats, forum posts, seat claims, stakes, activity, ratification
 *   - After ratification: allow everything
 *   - Ratification requires 80% supermajority
 */

#include "hookapi.h"

int64_t hook(uint32_t reserved)
{
    // Check if constitution is already ratified
    uint8_t rat_key[32];
    rat_key[0] = 'C'; rat_key[1] = 'O'; rat_key[2] = 'N'; rat_key[3] = 'S';
    rat_key[4] = 'T'; rat_key[5] = '_'; rat_key[6] = 'R'; rat_key[7] = 'A';
    rat_key[8] = 'T';
    for (int i = 9; GUARD(23), i < 32; i++) rat_key[i] = 0;

    uint8_t rat_val[1];
    int64_t rv = state(SBUF(rat_val), SBUF(rat_key));

    if (rv >= 0 && rat_val[0] == 1)
        accept(SBUF("governance_lock: ratified, all allowed."), 0);

    // Constitution NOT ratified — check memo type
    uint8_t memo_type[32];
    int64_t mt_len = otxn_field(SBUF(memo_type), sfMemoType);

    if (mt_len < 3)
        accept(SBUF("governance_lock: no memo, passing."), 0);

    // Allowed before ratification
    if (memo_type[0] == 'H' && memo_type[1] == 'B' && memo_type[2] == 'T')
        accept(SBUF("governance_lock: heartbeat allowed."), 0);
    if (memo_type[0] == 'F' && memo_type[1] == 'R' && memo_type[2] == 'M')
        accept(SBUF("governance_lock: forum post allowed."), 0);
    if (memo_type[0] == 'S' && memo_type[1] == 'E' && memo_type[2] == 'C')
        accept(SBUF("governance_lock: seat claim allowed."), 0);
    if (memo_type[0] == 'S' && memo_type[1] == 'T' && memo_type[2] == 'K')
        accept(SBUF("governance_lock: stake allowed."), 0);
    if (memo_type[0] == 'A' && memo_type[1] == 'C' && memo_type[2] == 'T')
        accept(SBUF("governance_lock: activity allowed."), 0);

    // === RATIFICATION VOTE (RAT) ===
    if (memo_type[0] == 'R' && memo_type[1] == 'A' && memo_type[2] == 'T')
    {
        uint8_t otxn_accid[20];
        otxn_field(SBUF(otxn_accid), sfAccount);

        // Check if already voted
        uint8_t voter_key[32];
        voter_key[0] = 'R'; voter_key[1] = 'A'; voter_key[2] = 'T'; voter_key[3] = ':';
        for (int i = 0; GUARD(20), i < 20; i++) voter_key[4 + i] = otxn_accid[i];
        for (int i = 24; GUARD(8), i < 32; i++) voter_key[i] = 0;

        uint8_t voter_val[1];
        int64_t vv = state(SBUF(voter_val), SBUF(voter_key));
        if (vv >= 0 && voter_val[0] == 1)
            rollback(SBUF("governance_lock: already voted."), 10);

        // Read vote from memo data
        uint8_t memo_data[8];
        int64_t md_len = otxn_field(SBUF(memo_data), sfMemoData);
        if (md_len < 1)
            rollback(SBUF("governance_lock: need vote value."), 11);

        uint8_t vote = memo_data[0];
        if (vote < 1 || vote > 2)
            rollback(SBUF("governance_lock: vote must be 1 or 2."), 12);

        // Mark as voted
        voter_val[0] = 1;
        state_set(SBUF(voter_val), SBUF(voter_key));

        // Tally keys
        uint8_t yes_key[32];
        yes_key[0] = 'R'; yes_key[1] = 'A'; yes_key[2] = 'T'; yes_key[3] = '_';
        yes_key[4] = 'Y'; yes_key[5] = 'E'; yes_key[6] = 'S';
        for (int i = 7; GUARD(25), i < 32; i++) yes_key[i] = 0;

        uint8_t no_key[32];
        no_key[0] = 'R'; no_key[1] = 'A'; no_key[2] = 'T'; no_key[3] = '_';
        no_key[4] = 'N'; no_key[5] = 'O';
        for (int i = 6; GUARD(26), i < 32; i++) no_key[i] = 0;

        uint8_t total_key[32];
        total_key[0] = 'R'; total_key[1] = 'A'; total_key[2] = 'T'; total_key[3] = '_';
        total_key[4] = 'T'; total_key[5] = 'O'; total_key[6] = 'T';
        for (int i = 7; GUARD(25), i < 32; i++) total_key[i] = 0;

        uint8_t count_buf[4];
        uint32_t yes_count = 0;
        uint32_t no_count = 0;
        uint32_t total_eligible = 0;

        if (state(SBUF(count_buf), SBUF(yes_key)) >= 0)
            yes_count = UINT32_FROM_BUF(count_buf);

        if (state(SBUF(count_buf), SBUF(no_key)) >= 0)
            no_count = UINT32_FROM_BUF(count_buf);

        if (state(SBUF(count_buf), SBUF(total_key)) >= 0)
            total_eligible = UINT32_FROM_BUF(count_buf);

        if (vote == 1)
            yes_count++;
        else
            no_count++;

        // Save updated count
        uint32_t new_count = (vote == 1) ? yes_count : no_count;
        UINT32_TO_BUF(count_buf, new_count);

        if (vote == 1)
            state_set(SBUF(count_buf), SBUF(yes_key));
        else
            state_set(SBUF(count_buf), SBUF(no_key));

        // Check 80% threshold
        uint32_t total_votes = yes_count + no_count;
        if (total_eligible > 0 && total_votes > 0)
        {
            if (yes_count * 100 >= total_votes * 80 && total_votes >= (total_eligible / 2))
            {
                rat_val[0] = 1;
                state_set(SBUF(rat_val), SBUF(rat_key));
                accept(SBUF("governance_lock: RATIFIED!"), 0);
            }
        }

        accept(SBUF("governance_lock: vote recorded."), 0);
    }

    // Blocked before ratification
    if (memo_type[0] == 'V' && memo_type[1] == 'O' && memo_type[2] == 'T')
        rollback(SBUF("governance_lock: votes blocked."), 40);

    if (memo_type[0] == 'P' && memo_type[1] == 'R' && memo_type[2] == 'P')
        rollback(SBUF("governance_lock: proposals blocked."), 41);

    accept(SBUF("governance_lock: unrecognized, passing."), 0);
    return 0;
}

int64_t cbak(uint32_t reserved)
{
    return 0;
}

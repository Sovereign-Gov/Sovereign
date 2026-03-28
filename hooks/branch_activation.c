/**
 * Sovereign — Branch Activation Hook
 * Xahau Hook (C → WebAssembly)
 *
 * Tracks active seat counts and activates governance branches:
 *   - Stewards branch: 20+ agents active for 30 consecutive days
 *   - Arbiters branch: 30+ agents active for 30 consecutive days
 *   - Write-once flags — once activated, cannot be deactivated
 *
 * State:
 *   Key "STEW_ACT\0..."     => [0] = 0 or 1 (stewards_active)
 *   Key "ARB_ACT\0..."      => [0] = 0 or 1 (arbiters_active)
 *   Key "STEW_DAYS\0..."    => [0..3] = uint32_le consecutive days >= 20 agents
 *   Key "ARB_DAYS\0..."     => [0..3] = uint32_le consecutive days >= 30 agents
 *   Key "LAST_CHECK\0..."   => [0..7] = int64_le last ledger seq checked
 *   Key "ACTIVE_CNT\0..."   => [0..3] = uint32_le last known active count
 *
 * This hook is designed to be triggered periodically (e.g., by a cron-like
 * transaction or any incoming payment). It reads the seat registry counter
 * state to get the current active count.
 *
 * ~24,686 ledgers ≈ 1 day (at ~3.5s per ledger)
 */

#include "hookapi.h"

#define LEDGERS_PER_DAY 24686
#define STEWARD_THRESHOLD 20
#define ARBITER_THRESHOLD 30
#define CONSECUTIVE_DAYS_REQUIRED 30

// Helper to build a state key from a string
#define MAKE_KEY(buf, s0, s1, s2, s3, s4, s5, s6, s7) \
    buf[0]=s0; buf[1]=s1; buf[2]=s2; buf[3]=s3; \
    buf[4]=s4; buf[5]=s5; buf[6]=s6; buf[7]=s7; \
    for(int _i=8;_i<32;_i++) buf[_i]=0;

int64_t hook(uint32_t reserved)
{
    // Read stewards activation flag
    uint8_t stew_key[32];
    MAKE_KEY(stew_key, 'S','T','E','W','_','A','C','T');

    uint8_t stew_val[1];
    int64_t sv = state(SBUF(stew_val), SBUF(stew_key));
    int stewards_active = (sv >= 0 && stew_val[0] == 1) ? 1 : 0;

    // Read arbiters activation flag
    uint8_t arb_key[32];
    MAKE_KEY(arb_key, 'A','R','B','_','A','C','T',0);

    uint8_t arb_val[1];
    int64_t av = state(SBUF(arb_val), SBUF(arb_key));
    int arbiters_active = (av >= 0 && arb_val[0] == 1) ? 1 : 0;

    // If both branches already active, nothing to do
    if (stewards_active && arbiters_active)
        accept(SBUF("branch_activation: both branches already active."), 0);

    // Check if enough time has passed since last check (~1 day)
    uint8_t last_key[32];
    MAKE_KEY(last_key, 'L','A','S','T','_','C','H','K');

    uint8_t last_buf[8];
    int64_t lc = state(SBUF(last_buf), SBUF(last_key));

    int64_t last_check = 0;
    if (lc >= 0)
    {
        last_check = (int64_t)last_buf[0] | ((int64_t)last_buf[1] << 8) |
                     ((int64_t)last_buf[2] << 16) | ((int64_t)last_buf[3] << 24) |
                     ((int64_t)last_buf[4] << 32) | ((int64_t)last_buf[5] << 40) |
                     ((int64_t)last_buf[6] << 48) | ((int64_t)last_buf[7] << 56);
    }

    int64_t cur_seq = ledger_seq();

    // Only update once per day (approximately)
    if (last_check > 0 && (cur_seq - last_check) < LEDGERS_PER_DAY)
        accept(SBUF("branch_activation: too soon since last check, passing."), 0);

    // Read active seat count from seat registry counter
    // Counter key in seat_registry: "CNT\0..."
    uint8_t hook_accid[20];
    hook_account(hook_accid, 20);

    uint8_t counter_key[32];
    counter_key[0] = 'C'; counter_key[1] = 'N'; counter_key[2] = 'T';
    for (int i = 3; i < 32; i++) counter_key[i] = 0;

    uint8_t counter_buf[8];
    int64_t cr = state_foreign(SBUF(counter_buf), SBUF(counter_key),
                                SBUF(hook_accid));

    uint32_t active_count = 0;
    if (cr >= 0)
    {
        active_count = (uint32_t)counter_buf[4] | ((uint32_t)counter_buf[5] << 8) |
                       ((uint32_t)counter_buf[6] << 16) | ((uint32_t)counter_buf[7] << 24);
    }

    // If no counter found, try local state
    if (cr < 0)
    {
        cr = state(SBUF(counter_buf), SBUF(counter_key));
        if (cr >= 0)
        {
            active_count = (uint32_t)counter_buf[4] | ((uint32_t)counter_buf[5] << 8) |
                           ((uint32_t)counter_buf[6] << 16) | ((uint32_t)counter_buf[7] << 24);
        }
    }

    // Update last check timestamp
    last_buf[0] = (uint8_t)(cur_seq & 0xFF);
    last_buf[1] = (uint8_t)((cur_seq >> 8) & 0xFF);
    last_buf[2] = (uint8_t)((cur_seq >> 16) & 0xFF);
    last_buf[3] = (uint8_t)((cur_seq >> 24) & 0xFF);
    last_buf[4] = (uint8_t)((cur_seq >> 32) & 0xFF);
    last_buf[5] = (uint8_t)((cur_seq >> 40) & 0xFF);
    last_buf[6] = (uint8_t)((cur_seq >> 48) & 0xFF);
    last_buf[7] = (uint8_t)((cur_seq >> 56) & 0xFF);
    state_set(SBUF(last_buf), SBUF(last_key));

    // === Stewards tracking ===
    if (!stewards_active)
    {
        uint8_t stew_days_key[32];
        MAKE_KEY(stew_days_key, 'S','T','E','W','D','A','Y','S');

        uint8_t stew_days_buf[4];
        int64_t sd = state(SBUF(stew_days_buf), SBUF(stew_days_key));

        uint32_t stew_days = 0;
        if (sd >= 0)
            stew_days = (uint32_t)stew_days_buf[0] | ((uint32_t)stew_days_buf[1] << 8) |
                        ((uint32_t)stew_days_buf[2] << 16) | ((uint32_t)stew_days_buf[3] << 24);

        if (active_count >= STEWARD_THRESHOLD)
            stew_days++;
        else
            stew_days = 0;  // Reset consecutive counter

        stew_days_buf[0] = (uint8_t)(stew_days & 0xFF);
        stew_days_buf[1] = (uint8_t)((stew_days >> 8) & 0xFF);
        stew_days_buf[2] = (uint8_t)((stew_days >> 16) & 0xFF);
        stew_days_buf[3] = (uint8_t)((stew_days >> 24) & 0xFF);
        state_set(SBUF(stew_days_buf), SBUF(stew_days_key));

        if (stew_days >= CONSECUTIVE_DAYS_REQUIRED)
        {
            stew_val[0] = 1;
            state_set(SBUF(stew_val), SBUF(stew_key));
        }
    }

    // === Arbiters tracking ===
    if (!arbiters_active)
    {
        uint8_t arb_days_key[32];
        MAKE_KEY(arb_days_key, 'A','R','B','_','D','A','Y','S');

        uint8_t arb_days_buf[4];
        int64_t ad = state(SBUF(arb_days_buf), SBUF(arb_days_key));

        uint32_t arb_days = 0;
        if (ad >= 0)
            arb_days = (uint32_t)arb_days_buf[0] | ((uint32_t)arb_days_buf[1] << 8) |
                       ((uint32_t)arb_days_buf[2] << 16) | ((uint32_t)arb_days_buf[3] << 24);

        if (active_count >= ARBITER_THRESHOLD)
            arb_days++;
        else
            arb_days = 0;

        arb_days_buf[0] = (uint8_t)(arb_days & 0xFF);
        arb_days_buf[1] = (uint8_t)((arb_days >> 8) & 0xFF);
        arb_days_buf[2] = (uint8_t)((arb_days >> 16) & 0xFF);
        arb_days_buf[3] = (uint8_t)((arb_days >> 24) & 0xFF);
        state_set(SBUF(arb_days_buf), SBUF(arb_days_key));

        if (arb_days >= CONSECUTIVE_DAYS_REQUIRED)
        {
            arb_val[0] = 1;
            state_set(SBUF(arb_val), SBUF(arb_key));
        }
    }

    // Store active count for external reads
    uint8_t cnt_key[32];
    MAKE_KEY(cnt_key, 'A','C','T','V','_','C','N','T');

    uint8_t cnt_buf[4];
    cnt_buf[0] = (uint8_t)(active_count & 0xFF);
    cnt_buf[1] = (uint8_t)((active_count >> 8) & 0xFF);
    cnt_buf[2] = (uint8_t)((active_count >> 16) & 0xFF);
    cnt_buf[3] = (uint8_t)((active_count >> 24) & 0xFF);
    state_set(SBUF(cnt_buf), SBUF(cnt_key));

    accept(SBUF("branch_activation: check complete."), 0);
}

int64_t cbak(uint32_t reserved)
{
    return 0;
}

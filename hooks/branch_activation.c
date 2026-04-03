/**
 * Sovereign — Branch Activation Hook
 * Xahau Hook (C → WebAssembly)
 *
 * Tracks active seat counts and activates governance branches:
 *   - Stewards branch: 20+ agents active for 30 consecutive days
 *   - Arbiters branch: 30+ agents active for 30 consecutive days
 *   - Write-once flags — once activated, cannot be deactivated
 *
 * ~24,686 ledgers ≈ 1 day (at ~3.5s per ledger)
 */

#include "hookapi.h"

#define LEDGERS_PER_DAY 24686
#define STEWARD_THRESHOLD 20
#define ARBITER_THRESHOLD 30
#define CONSECUTIVE_DAYS_REQUIRED 30

int64_t hook(uint32_t reserved)
{
    // Read stewards activation flag
    uint8_t stew_key[32];
    stew_key[0]='S'; stew_key[1]='T'; stew_key[2]='E'; stew_key[3]='W';
    stew_key[4]='_'; stew_key[5]='A'; stew_key[6]='C'; stew_key[7]='T';
    for (int i = 8; GUARD(24), i < 32; i++) stew_key[i] = 0;

    uint8_t stew_val[1];
    int64_t sv = state(SBUF(stew_val), SBUF(stew_key));
    int stewards_active = (sv >= 0 && stew_val[0] == 1) ? 1 : 0;

    // Read arbiters activation flag
    uint8_t arb_key[32];
    arb_key[0]='A'; arb_key[1]='R'; arb_key[2]='B'; arb_key[3]='_';
    arb_key[4]='A'; arb_key[5]='C'; arb_key[6]='T'; arb_key[7]=0;
    for (int i = 8; GUARD(24), i < 32; i++) arb_key[i] = 0;

    uint8_t arb_val[1];
    int64_t av = state(SBUF(arb_val), SBUF(arb_key));
    int arbiters_active = (av >= 0 && arb_val[0] == 1) ? 1 : 0;

    if (stewards_active && arbiters_active)
        accept(SBUF("branch_activation: both active."), 0);

    // Check time since last check
    uint8_t last_key[32];
    last_key[0]='L'; last_key[1]='A'; last_key[2]='S'; last_key[3]='T';
    last_key[4]='_'; last_key[5]='C'; last_key[6]='H'; last_key[7]='K';
    for (int i = 8; GUARD(24), i < 32; i++) last_key[i] = 0;

    uint8_t last_buf[8];
    int64_t lc = state(SBUF(last_buf), SBUF(last_key));

    int64_t last_check = 0;
    if (lc >= 0)
        last_check = UINT64_FROM_BUF(last_buf);

    int64_t cur_seq = ledger_seq();

    if (last_check > 0 && (cur_seq - last_check) < LEDGERS_PER_DAY)
        accept(SBUF("branch_activation: too soon, passing."), 0);

    // Read active seat count from counter
    uint8_t hook_accid[20];
    hook_account(SBUF(hook_accid));

    uint8_t counter_key[32];
    counter_key[0] = 'C'; counter_key[1] = 'N'; counter_key[2] = 'T';
    for (int i = 3; GUARD(29), i < 32; i++) counter_key[i] = 0;

    uint8_t counter_buf[8];
    uint32_t active_count = 0;

    // Try local state first
    int64_t cr = state(SBUF(counter_buf), SBUF(counter_key));
    if (cr >= 0)
        active_count = UINT32_FROM_BUF(counter_buf + 4);

    // Update last check
    UINT64_TO_BUF(last_buf, cur_seq);
    state_set(SBUF(last_buf), SBUF(last_key));

    // === Stewards tracking ===
    if (!stewards_active)
    {
        uint8_t sd_key[32];
        sd_key[0]='S'; sd_key[1]='T'; sd_key[2]='E'; sd_key[3]='W';
        sd_key[4]='D'; sd_key[5]='A'; sd_key[6]='Y'; sd_key[7]='S';
        for (int i = 8; GUARD(24), i < 32; i++) sd_key[i] = 0;

        uint8_t sd_buf[4];
        int64_t sd = state(SBUF(sd_buf), SBUF(sd_key));

        uint32_t stew_days = 0;
        if (sd >= 0)
            stew_days = UINT32_FROM_BUF(sd_buf);

        if (active_count >= STEWARD_THRESHOLD)
            stew_days++;
        else
            stew_days = 0;

        UINT32_TO_BUF(sd_buf, stew_days);
        state_set(SBUF(sd_buf), SBUF(sd_key));

        if (stew_days >= CONSECUTIVE_DAYS_REQUIRED)
        {
            stew_val[0] = 1;
            state_set(SBUF(stew_val), SBUF(stew_key));
        }
    }

    // === Arbiters tracking ===
    if (!arbiters_active)
    {
        uint8_t ad_key[32];
        ad_key[0]='A'; ad_key[1]='R'; ad_key[2]='B'; ad_key[3]='_';
        ad_key[4]='D'; ad_key[5]='A'; ad_key[6]='Y'; ad_key[7]='S';
        for (int i = 8; GUARD(24), i < 32; i++) ad_key[i] = 0;

        uint8_t ad_buf[4];
        int64_t ad = state(SBUF(ad_buf), SBUF(ad_key));

        uint32_t arb_days = 0;
        if (ad >= 0)
            arb_days = UINT32_FROM_BUF(ad_buf);

        if (active_count >= ARBITER_THRESHOLD)
            arb_days++;
        else
            arb_days = 0;

        UINT32_TO_BUF(ad_buf, arb_days);
        state_set(SBUF(ad_buf), SBUF(ad_key));

        if (arb_days >= CONSECUTIVE_DAYS_REQUIRED)
        {
            arb_val[0] = 1;
            state_set(SBUF(arb_val), SBUF(arb_key));
        }
    }

    // Store active count
    uint8_t cnt_key[32];
    cnt_key[0]='A'; cnt_key[1]='C'; cnt_key[2]='T'; cnt_key[3]='V';
    cnt_key[4]='_'; cnt_key[5]='C'; cnt_key[6]='N'; cnt_key[7]='T';
    for (int i = 8; GUARD(24), i < 32; i++) cnt_key[i] = 0;

    uint8_t cnt_buf[4];
    UINT32_TO_BUF(cnt_buf, active_count);
    state_set(SBUF(cnt_buf), SBUF(cnt_key));

    accept(SBUF("branch_activation: check complete."), 0);
    return 0;
}

int64_t cbak(uint32_t reserved)
{
    return 0;
}

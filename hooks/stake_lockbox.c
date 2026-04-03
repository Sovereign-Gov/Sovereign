/**
 * Sovereign — Stake Lockbox Hook
 * Xahau Hook (C → WebAssembly)
 *
 * Protects staked funds:
 *   - Outgoing payments ONLY allowed to original staker or treasury
 *   - Amount must not exceed original stake
 *   - All other outgoing transactions are rejected
 *
 * State layout (key = 20-byte agent account ID + 12 zero bytes):
 *   [0..7]   stake_amount   (int64 big-endian, drops)
 *   [8..27]  staker_address (20-byte account ID)
 *
 * Treasury address stored in state key "TREAS\0..."
 */

#include "hookapi.h"

#define STAKE_RECORD_SIZE 28

int64_t hook(uint32_t reserved)
{
    uint8_t hook_accid[20];
    hook_account(SBUF(hook_accid));

    uint8_t otxn_accid[20];
    otxn_field(SBUF(otxn_accid), sfAccount);

    // Determine if outgoing (sent BY the hook account)
    int is_outgoing = 1;
    for (int i = 0; GUARD(20), i < 20; i++)
    {
        if (otxn_accid[i] != hook_accid[i])
        {
            is_outgoing = 0;
            break;
        }
    }

    // If incoming, check for stake deposit
    if (!is_outgoing)
    {
        uint8_t memo_type[32];
        int64_t mt_len = otxn_field(SBUF(memo_type), sfMemoType);
        if (mt_len >= 3 && memo_type[0] == 'S' && memo_type[1] == 'T' && memo_type[2] == 'K')
        {
            uint8_t memo_data[32];
            int64_t md_len = otxn_field(SBUF(memo_data), sfMemoData);
            if (md_len < 20)
                rollback(SBUF("stake_lockbox: need agent address."), 10);

            uint8_t agent_addr[20];
            for (int i = 0; GUARD(20), i < 20; i++)
                agent_addr[i] = memo_data[i];

            uint8_t state_key[32];
            for (int i = 0; GUARD(20), i < 20; i++) state_key[i] = agent_addr[i];
            for (int i = 20; GUARD(12), i < 32; i++) state_key[i] = 0;

            uint8_t amt_buf[8];
            otxn_field(SBUF(amt_buf), sfAmount);
            int64_t drops = AMOUNT_TO_DROPS(amt_buf);

            uint8_t record[STAKE_RECORD_SIZE];
            UINT64_TO_BUF(record, drops);

            // Staker = originating account
            for (int i = 0; GUARD(20), i < 20; i++)
                record[8 + i] = otxn_accid[i];

            state_set(SBUF(record), SBUF(state_key));
            accept(SBUF("stake_lockbox: stake recorded."), 0);
        }

        accept(SBUF("stake_lockbox: incoming non-stake, passing."), 0);
    }

    // === OUTGOING — enforce lockbox rules ===

    int64_t tt = otxn_type();
    if (tt != ttPAYMENT)
        rollback(SBUF("stake_lockbox: only payments allowed."), 20);

    uint8_t dest_accid[20];
    otxn_field(SBUF(dest_accid), sfDestination);

    // Read treasury address from state
    uint8_t treasury_key[32];
    treasury_key[0] = 'T'; treasury_key[1] = 'R'; treasury_key[2] = 'E';
    treasury_key[3] = 'A'; treasury_key[4] = 'S';
    for (int i = 5; GUARD(27), i < 32; i++) treasury_key[i] = 0;

    uint8_t treasury_addr[20];
    int64_t tr = state(SBUF(treasury_addr), SBUF(treasury_key));

    // Check if destination is treasury
    if (tr >= 0)
    {
        int is_treasury = 1;
        for (int i = 0; GUARD(20), i < 20; i++)
        {
            if (dest_accid[i] != treasury_addr[i])
            {
                is_treasury = 0;
                break;
            }
        }
        if (is_treasury)
            accept(SBUF("stake_lockbox: payment to treasury ok."), 0);
    }

    // Check memo data for agent address
    uint8_t memo_data[32];
    int64_t md_len = otxn_field(SBUF(memo_data), sfMemoData);
    if (md_len < 20)
        rollback(SBUF("stake_lockbox: need agent addr in memo."), 30);

    uint8_t agent_addr[20];
    for (int i = 0; GUARD(20), i < 20; i++)
        agent_addr[i] = memo_data[i];

    uint8_t state_key[32];
    for (int i = 0; GUARD(20), i < 20; i++) state_key[i] = agent_addr[i];
    for (int i = 20; GUARD(12), i < 32; i++) state_key[i] = 0;

    uint8_t record[STAKE_RECORD_SIZE];
    int64_t sr = state(SBUF(record), SBUF(state_key));
    if (sr < 0)
        rollback(SBUF("stake_lockbox: no stake record."), 31);

    // Verify destination is original staker (bytes 8-27)
    int is_staker = 1;
    for (int i = 0; GUARD(20), i < 20; i++)
    {
        if (dest_accid[i] != record[8 + i])
        {
            is_staker = 0;
            break;
        }
    }

    if (!is_staker)
        rollback(SBUF("stake_lockbox: dest must be staker/treasury."), 32);

    // Verify amount does not exceed stake
    int64_t stake_amount = UINT64_FROM_BUF(record);

    uint8_t amt_buf[8];
    otxn_field(SBUF(amt_buf), sfAmount);
    int64_t pay_drops = AMOUNT_TO_DROPS(amt_buf);

    if (pay_drops > stake_amount)
        rollback(SBUF("stake_lockbox: exceeds staked amount."), 33);

    accept(SBUF("stake_lockbox: return approved."), 0);
    return 0;
}

int64_t cbak(uint32_t reserved)
{
    return 0;
}

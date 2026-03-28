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
 *   [0..7]   stake_amount   (int64_le, drops)
 *   [8..27]  staker_address (20-byte account ID)
 *
 * Treasury address stored in state key "TREASURY\0..."
 */

#include "hookapi.h"

#define STAKE_RECORD_SIZE 28

int64_t hook(uint32_t reserved)
{
    // Get hook account
    uint8_t hook_accid[20];
    hook_account(hook_accid, 20);

    // Get originating account
    uint8_t otxn_accid[20];
    otxn_field(otxn_accid, 20, sfAccount);

    // Determine if this is an outgoing transaction (sent BY the hook account)
    int is_outgoing = 1;
    for (int i = 0; i < 20; i++)
    {
        if (otxn_accid[i] != hook_accid[i])
        {
            is_outgoing = 0;
            break;
        }
    }

    // If incoming, record the stake and pass through
    if (!is_outgoing)
    {
        // Check memo type for stake deposit "STK"
        uint8_t memo_type[32];
        int64_t mt_len = otxn_field(memo_type, 32, sfMemoType);
        if (mt_len >= 3 && memo_type[0] == 'S' && memo_type[1] == 'T' && memo_type[2] == 'K')
        {
            // Read memo data for agent address (20 bytes)
            uint8_t memo_data[32];
            int64_t md_len = otxn_field(memo_data, 32, sfMemoData);
            if (md_len < 20)
                rollback(SBUF("stake_lockbox: stake deposit memo must contain agent address."), 10);

            uint8_t agent_addr[20];
            for (int i = 0; i < 20; i++)
                agent_addr[i] = memo_data[i];

            // Build state key from agent address
            uint8_t state_key[32];
            for (int i = 0; i < 20; i++) state_key[i] = agent_addr[i];
            for (int i = 20; i < 32; i++) state_key[i] = 0;

            // Get payment amount
            uint8_t amt_buf[8];
            otxn_field(amt_buf, 8, sfAmount);
            int64_t drops = AMOUNT_TO_DROPS(amt_buf);

            // Build stake record
            uint8_t record[STAKE_RECORD_SIZE];
            record[0] = (uint8_t)(drops & 0xFF);
            record[1] = (uint8_t)((drops >> 8) & 0xFF);
            record[2] = (uint8_t)((drops >> 16) & 0xFF);
            record[3] = (uint8_t)((drops >> 24) & 0xFF);
            record[4] = (uint8_t)((drops >> 32) & 0xFF);
            record[5] = (uint8_t)((drops >> 40) & 0xFF);
            record[6] = (uint8_t)((drops >> 48) & 0xFF);
            record[7] = (uint8_t)((drops >> 56) & 0xFF);

            // Staker = originating account (the one sending the stake)
            for (int i = 0; i < 20; i++)
                record[8 + i] = otxn_accid[i];

            state_set(SBUF(record), SBUF(state_key));
            accept(SBUF("stake_lockbox: stake recorded."), 0);
        }

        // Not a stake deposit — pass through
        accept(SBUF("stake_lockbox: incoming non-stake tx, passing."), 0);
    }

    // === OUTGOING TRANSACTION — enforce lockbox rules ===

    int64_t tt = otxn_type();
    if (tt != 0)  // Only payments allowed out
        rollback(SBUF("stake_lockbox: only payment transactions allowed from lockbox."), 20);

    // Get destination
    uint8_t dest_accid[20];
    otxn_field(dest_accid, 20, sfDestination);

    // Read treasury address from state
    uint8_t treasury_key[32];
    treasury_key[0] = 'T'; treasury_key[1] = 'R'; treasury_key[2] = 'E';
    treasury_key[3] = 'A'; treasury_key[4] = 'S';
    for (int i = 5; i < 32; i++) treasury_key[i] = 0;

    uint8_t treasury_addr[20];
    int64_t tr = state(treasury_addr, 20, SBUF(treasury_key));

    // Check if destination is treasury
    int is_treasury = 0;
    if (tr >= 0)
    {
        is_treasury = 1;
        for (int i = 0; i < 20; i++)
        {
            if (dest_accid[i] != treasury_addr[i])
            {
                is_treasury = 0;
                break;
            }
        }
    }

    if (is_treasury)
        accept(SBUF("stake_lockbox: payment to treasury allowed."), 0);

    // Check memo data for agent address to look up stake record
    uint8_t memo_data[32];
    int64_t md_len = otxn_field(memo_data, 32, sfMemoData);
    if (md_len < 20)
        rollback(SBUF("stake_lockbox: outgoing payment must specify agent address in memo."), 30);

    uint8_t agent_addr[20];
    for (int i = 0; i < 20; i++)
        agent_addr[i] = memo_data[i];

    // Read stake record for this agent
    uint8_t state_key[32];
    for (int i = 0; i < 20; i++) state_key[i] = agent_addr[i];
    for (int i = 20; i < 32; i++) state_key[i] = 0;

    uint8_t record[STAKE_RECORD_SIZE];
    int64_t sr = state(SBUF(record), SBUF(state_key));
    if (sr < 0)
        rollback(SBUF("stake_lockbox: no stake record found for agent."), 31);

    // Read staker address from record (bytes 8-27)
    uint8_t staker_addr[20];
    for (int i = 0; i < 20; i++)
        staker_addr[i] = record[8 + i];

    // Verify destination is the original staker
    int is_staker = 1;
    for (int i = 0; i < 20; i++)
    {
        if (dest_accid[i] != staker_addr[i])
        {
            is_staker = 0;
            break;
        }
    }

    if (!is_staker)
        rollback(SBUF("stake_lockbox: destination must be original staker or treasury."), 32);

    // Verify amount does not exceed stake
    int64_t stake_amount = (int64_t)record[0] | ((int64_t)record[1] << 8) |
                           ((int64_t)record[2] << 16) | ((int64_t)record[3] << 24) |
                           ((int64_t)record[4] << 32) | ((int64_t)record[5] << 40) |
                           ((int64_t)record[6] << 48) | ((int64_t)record[7] << 56);

    uint8_t amt_buf[8];
    otxn_field(amt_buf, 8, sfAmount);
    int64_t pay_drops = AMOUNT_TO_DROPS(amt_buf);

    if (pay_drops > stake_amount)
        rollback(SBUF("stake_lockbox: payment exceeds staked amount."), 33);

    accept(SBUF("stake_lockbox: stake return to original staker approved."), 0);
}

int64_t cbak(uint32_t reserved)
{
    return 0;
}

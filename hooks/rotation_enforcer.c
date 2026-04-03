/**
 * Sovereign — Rotation Enforcer Hook
 * Xahau Hook (C → WebAssembly)
 *
 * Enforces mandatory signer rotation:
 *   - When rotation is required and deadline passes, freezes account
 *   - Frozen account only allows SignerListSet
 *   - After successful SignerListSet, clears rotation/freeze flags
 */

#include "hookapi.h"

#define SECS_72H (72 * 60 * 60)

int64_t hook(uint32_t reserved)
{
    int64_t tt = otxn_type();

    // Read rotation state
    uint8_t rotation_key[32];
    rotation_key[0]='R'; rotation_key[1]='O'; rotation_key[2]='T';
    rotation_key[3]='A'; rotation_key[4]='T'; rotation_key[5]='I';
    rotation_key[6]='O'; rotation_key[7]='N';
    for (int i = 8; GUARD(24), i < 32; i++) rotation_key[i] = 0;

    uint8_t rotation_state[36];
    for (int i = 0; GUARD(36), i < 36; i++) rotation_state[i] = 0;
    int64_t rotation_exists = state(SBUF(rotation_state), SBUF(rotation_key));

    // Read frozen state
    uint8_t frozen_key[32];
    frozen_key[0]='F'; frozen_key[1]='R'; frozen_key[2]='O';
    frozen_key[3]='Z'; frozen_key[4]='E'; frozen_key[5]='N';
    for (int i = 6; GUARD(26), i < 32; i++) frozen_key[i] = 0;

    uint8_t frozen_state[8];
    for (int i = 0; GUARD(8), i < 8; i++) frozen_state[i] = 0;
    int64_t frozen_exists = state(SBUF(frozen_state), SBUF(frozen_key));

    int64_t is_frozen = 0;
    if (frozen_exists >= 8)
        is_frozen = UINT64_FROM_BUF(frozen_state);

    // If frozen, only allow SignerListSet (tt=12)
    if (is_frozen == 1)
    {
        if (tt != ttSIGNER_LIST_SET)
            rollback(SBUF("rotation: frozen, only SignerListSet."), 100);

        accept(SBUF("rotation: SignerListSet allowed."), 0);
    }

    // Check if rotation required and deadline passed
    if (rotation_exists >= 16)
    {
        int64_t rotation_required = UINT64_FROM_BUF(rotation_state);
        int64_t rotation_deadline = UINT64_FROM_BUF(rotation_state + 8);

        if (rotation_required == 1)
        {
            int64_t now = ledger_last_time() + 946684800;

            if (now > rotation_deadline)
            {
                // Freeze
                int64_t one = 1;
                UINT64_TO_BUF(frozen_state, one);
                state_set(SBUF(frozen_state), SBUF(frozen_key));

                if (tt != ttSIGNER_LIST_SET)
                    rollback(SBUF("rotation: deadline passed, frozen."), 101);
            }
        }
    }

    // Check for voted rotation not yet executed
    uint8_t voted_key[32];
    voted_key[0]='V'; voted_key[1]='O'; voted_key[2]='T';
    voted_key[3]='E'; voted_key[4]='D'; voted_key[5]='_';
    voted_key[6]='R'; voted_key[7]='O'; voted_key[8]='T';
    for (int i = 9; GUARD(23), i < 32; i++) voted_key[i] = 0;

    uint8_t voted_state[56];
    for (int i = 0; GUARD(56), i < 56; i++) voted_state[i] = 0;
    int64_t voted_exists = state(SBUF(voted_state), SBUF(voted_key));

    if (voted_exists >= 16)
    {
        int64_t vote_passed = UINT64_FROM_BUF(voted_state);
        int64_t vote_timestamp = UINT64_FROM_BUF(voted_state + 8);

        if (vote_passed == 1)
        {
            int64_t now = ledger_last_time() + 946684800;

            if (now > vote_timestamp + SECS_72H)
            {
                // Set rotation required
                if (rotation_exists < 16 || UINT64_FROM_BUF(rotation_state) != 1)
                {
                    int64_t one = 1;
                    int64_t deadline = now;
                    UINT64_TO_BUF(rotation_state, one);
                    UINT64_TO_BUF(rotation_state + 8, deadline);
                    state_set(SBUF(rotation_state), SBUF(rotation_key));
                }

                // Freeze
                int64_t one = 1;
                UINT64_TO_BUF(frozen_state, one);
                state_set(SBUF(frozen_state), SBUF(frozen_key));

                if (tt != ttSIGNER_LIST_SET)
                    rollback(SBUF("rotation: voted, not executed."), 102);
            }
        }
    }

    accept(SBUF("rotation: transaction permitted."), 0);
    return 0;
}

/**
 * Callback after transaction — clear rotation/freeze on SignerListSet
 */
int64_t cbak(uint32_t reserved)
{
    int64_t tt = otxn_type();

    if (tt == ttSIGNER_LIST_SET)
    {
        // Clear rotation
        uint8_t rotation_key[32];
        rotation_key[0]='R'; rotation_key[1]='O'; rotation_key[2]='T';
        rotation_key[3]='A'; rotation_key[4]='T'; rotation_key[5]='I';
        rotation_key[6]='O'; rotation_key[7]='N';
        for (int i = 8; GUARD(24), i < 32; i++) rotation_key[i] = 0;

        uint8_t zero36[36];
        for (int i = 0; GUARD(36), i < 36; i++) zero36[i] = 0;
        state_set(SBUF(zero36), SBUF(rotation_key));

        // Clear frozen
        uint8_t frozen_key[32];
        frozen_key[0]='F'; frozen_key[1]='R'; frozen_key[2]='O';
        frozen_key[3]='Z'; frozen_key[4]='E'; frozen_key[5]='N';
        for (int i = 6; GUARD(26), i < 32; i++) frozen_key[i] = 0;

        uint8_t zero8[8];
        for (int i = 0; GUARD(8), i < 8; i++) zero8[i] = 0;
        state_set(SBUF(zero8), SBUF(frozen_key));

        // Clear voted rotation
        uint8_t voted_key[32];
        voted_key[0]='V'; voted_key[1]='O'; voted_key[2]='T';
        voted_key[3]='E'; voted_key[4]='D'; voted_key[5]='_';
        voted_key[6]='R'; voted_key[7]='O'; voted_key[8]='T';
        for (int i = 9; GUARD(23), i < 32; i++) voted_key[i] = 0;

        uint8_t zero56[56];
        for (int i = 0; GUARD(56), i < 56; i++) zero56[i] = 0;
        state_set(SBUF(zero56), SBUF(voted_key));
    }

    accept(SBUF("rotation: cbak complete."), 0);
    return 0;
}

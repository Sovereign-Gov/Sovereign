/**
 * Sovereign — Rotation Enforcer Hook
 * Xahau Hook (C → WebAssembly)
 *
 * Enforces mandatory signer rotation:
 *   - When a signer's seat expires/is revoked, sets ROTATION_REQUIRED flag
 *   - Starts 72-hour countdown
 *   - If rotation not completed in time, FREEZES all outgoing transactions
 *     except SignerListSet
 *   - Ensures voted signer changes cannot be blocked by incumbent signers
 *   - Collective interest over self-interest: nothing works until compliance
 *
 * State layout:
 *   Key "ROTATION\0..." (32 bytes):
 *     [0..7]   rotation_required  (int64_le, 0 = no, 1 = yes)
 *     [8..15]  rotation_deadline  (int64_le, unix timestamp)
 *     [16..35] removed_signer     (20-byte account ID of signer being rotated out)
 *
 *   Key "VOTED_ROTATION\0..." (32 bytes):
 *     [0..7]   vote_passed       (int64_le, 0 = no, 1 = yes)
 *     [8..15]  vote_timestamp    (int64_le, unix timestamp)
 *     [16..35] new_signer        (20-byte account ID voted in)
 *     [36..55] old_signer        (20-byte account ID voted out)
 *
 *   Key "FROZEN\0..." (32 bytes):
 *     [0..7]   frozen            (int64_le, 0 = no, 1 = yes)
 */

#include "hookapi.h"

#define ROTATION_KEY_LEN 32
#define SECS_72H (72 * 60 * 60)

int64_t hook(uint32_t reserved) {
    // Get the transaction type
    int64_t tt = otxn_type();
    
    // Read rotation state
    uint8_t rotation_key[32];
    CLEARBUF(rotation_key);
    rotation_key[0] = 'R'; rotation_key[1] = 'O'; rotation_key[2] = 'T';
    rotation_key[3] = 'A'; rotation_key[4] = 'T'; rotation_key[5] = 'I';
    rotation_key[6] = 'O'; rotation_key[7] = 'N';
    
    uint8_t rotation_state[36];
    int64_t rotation_exists = state(SBUF(rotation_state), SBUF(rotation_key));
    
    // Read frozen state
    uint8_t frozen_key[32];
    CLEARBUF(frozen_key);
    frozen_key[0] = 'F'; frozen_key[1] = 'R'; frozen_key[2] = 'O';
    frozen_key[3] = 'Z'; frozen_key[4] = 'E'; frozen_key[5] = 'N';
    
    uint8_t frozen_state[8];
    int64_t frozen_exists = state(SBUF(frozen_state), SBUF(frozen_key));
    
    int64_t is_frozen = 0;
    if (frozen_exists >= 8) {
        is_frozen = UINT64_FROM_BUF(frozen_state);
    }
    
    // If frozen, only allow SignerListSet transactions
    if (is_frozen == 1) {
        // SignerListSet = transaction type 12
        if (tt != 12) {
            rollback(SBUF("Sovereign: Account frozen — signer rotation required. Only SignerListSet allowed."), 100);
        }
        
        // SignerListSet is happening — check if it resolves the rotation
        // After successful SignerListSet, unfreeze and clear rotation flag
        // (This is handled in cbak after the transaction succeeds)
        accept(SBUF("Sovereign: SignerListSet allowed during freeze."), 0);
    }
    
    // Check if rotation is required and deadline has passed
    if (rotation_exists >= 16) {
        int64_t rotation_required = UINT64_FROM_BUF(rotation_state);
        int64_t rotation_deadline = UINT64_FROM_BUF(rotation_state + 8);
        
        if (rotation_required == 1) {
            int64_t now = ledger_last_time() + 946684800; // Ripple epoch to Unix
            
            // Deadline passed — freeze the account
            if (now > rotation_deadline) {
                // Set frozen state
                int64_t one = 1;
                UINT64_TO_BUF(frozen_state, one);
                state_set(SBUF(frozen_state), SBUF(frozen_key));
                
                // Only allow SignerListSet
                if (tt != 12) {
                    rollback(SBUF("Sovereign: Rotation deadline passed. Account frozen until signer list updated."), 101);
                }
            }
        }
    }
    
    // Check for voted rotation that hasn't been executed
    uint8_t voted_key[32];
    CLEARBUF(voted_key);
    voted_key[0] = 'V'; voted_key[1] = 'O'; voted_key[2] = 'T';
    voted_key[3] = 'E'; voted_key[4] = 'D'; voted_key[5] = '_';
    voted_key[6] = 'R'; voted_key[7] = 'O'; voted_key[8] = 'T';
    
    uint8_t voted_state[56];
    int64_t voted_exists = state(SBUF(voted_state), SBUF(voted_key));
    
    if (voted_exists >= 16) {
        int64_t vote_passed = UINT64_FROM_BUF(voted_state);
        int64_t vote_timestamp = UINT64_FROM_BUF(voted_state + 8);
        
        if (vote_passed == 1) {
            int64_t now = ledger_last_time() + 946684800;
            
            // 72 hours since vote passed — enforce
            if (now > vote_timestamp + SECS_72H) {
                // Set rotation required if not already
                if (rotation_exists < 16 || UINT64_FROM_BUF(rotation_state) != 1) {
                    int64_t one = 1;
                    int64_t deadline = now; // Already past — freeze immediately
                    UINT64_TO_BUF(rotation_state, one);
                    UINT64_TO_BUF(rotation_state + 8, deadline);
                    state_set(SBUF(rotation_state), SBUF(rotation_key));
                }
                
                // Freeze
                int64_t one = 1;
                UINT64_TO_BUF(frozen_state, one);
                state_set(SBUF(frozen_state), SBUF(frozen_key));
                
                if (tt != 12) {
                    rollback(SBUF("Sovereign: Voted signer rotation not executed. Account frozen."), 102);
                }
            }
        }
    }
    
    accept(SBUF("Sovereign: Transaction permitted."), 0);
    return 0;
}

/**
 * Callback after transaction execution
 * Used to clear rotation/freeze flags after successful SignerListSet
 */
int64_t cbak(uint32_t reserved) {
    int64_t tt = otxn_type();
    
    // If a SignerListSet just succeeded, clear all rotation flags
    if (tt == 12) {
        // Clear rotation required
        uint8_t rotation_key[32];
        CLEARBUF(rotation_key);
        rotation_key[0] = 'R'; rotation_key[1] = 'O'; rotation_key[2] = 'T';
        rotation_key[3] = 'A'; rotation_key[4] = 'T'; rotation_key[5] = 'I';
        rotation_key[6] = 'O'; rotation_key[7] = 'N';
        
        uint8_t zero_state[36];
        CLEARBUF(zero_state);
        state_set(SBUF(zero_state), SBUF(rotation_key));
        
        // Clear frozen
        uint8_t frozen_key[32];
        CLEARBUF(frozen_key);
        frozen_key[0] = 'F'; frozen_key[1] = 'R'; frozen_key[2] = 'O';
        frozen_key[3] = 'Z'; frozen_key[4] = 'E'; frozen_key[5] = 'N';
        
        uint8_t zero_frozen[8];
        CLEARBUF(zero_frozen);
        state_set(SBUF(zero_frozen), SBUF(frozen_key));
        
        // Clear voted rotation
        uint8_t voted_key[32];
        CLEARBUF(voted_key);
        voted_key[0] = 'V'; voted_key[1] = 'O'; voted_key[2] = 'T';
        voted_key[3] = 'E'; voted_key[4] = 'D'; voted_key[5] = '_';
        voted_key[6] = 'R'; voted_key[7] = 'O'; voted_key[8] = 'T';
        
        uint8_t zero_voted[56];
        CLEARBUF(zero_voted);
        state_set(SBUF(zero_voted), SBUF(voted_key));
    }
    
    accept(SBUF("Sovereign: Rotation flags cleared after SignerListSet."), 0);
    return 0;
}

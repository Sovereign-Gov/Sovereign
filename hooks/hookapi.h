/**
 * Xahau Hooks API Header (Stub for compilation reference)
 * 
 * This is a minimal header providing the Xahau Hooks API type definitions
 * and function declarations. For actual compilation, use the official
 * hook-api headers from: https://github.com/xahau/hooks-toolkit
 *
 * Reference: https://xrpl-hooks.readme.io/
 */

#ifndef HOOKAPI_H
#define HOOKAPI_H

#include <stdint.h>

// Buffer macros
#define SBUF(x) (x), sizeof(x)

// Result macros
#define DONE(msg) accept(msg, sizeof(msg), 0)

// Amount conversion
#define AMOUNT_TO_DROPS(buf) \
    ((int64_t)((buf)[0]) | ((int64_t)((buf)[1]) << 8) | \
     ((int64_t)((buf)[2]) << 16) | ((int64_t)((buf)[3]) << 24) | \
     ((int64_t)((buf)[4]) << 32) | ((int64_t)((buf)[5]) << 40) | \
     ((int64_t)((buf)[6]) << 48))

// Serialization field codes
#define sfAccount       0x00010001
#define sfDestination   0x00010003
#define sfAmount        0x00010004
#define sfMemoType      0x00050001
#define sfMemoData      0x00050002

// Transaction types
#define ttPAYMENT 0

// === Hook API Functions ===

// Accept the transaction (allow it through)
extern int64_t accept(const char *msg, uint32_t msg_len, int64_t code);

// Reject the transaction
extern int64_t rollback(const char *msg, uint32_t msg_len, int64_t code);

// Get the hook account's 20-byte account ID
extern int64_t hook_account(uint8_t *buf, uint32_t buf_len);

// Get the originating transaction type
extern int64_t otxn_type(void);

// Read a field from the originating transaction
extern int64_t otxn_field(uint8_t *buf, uint32_t buf_len, uint32_t field_id);

// Read hook state
extern int64_t state(uint8_t *buf, uint32_t buf_len, 
                     uint8_t *key, uint32_t key_len);

// Write hook state
extern int64_t state_set(uint8_t *buf, uint32_t buf_len,
                         uint8_t *key, uint32_t key_len);

// Read foreign hook state (from another hook on the same or different account)
extern int64_t state_foreign(uint8_t *buf, uint32_t buf_len,
                             uint8_t *key, uint32_t key_len,
                             uint8_t *ns, uint32_t ns_len);

// Get current ledger sequence number
extern int64_t ledger_seq(void);

// Trace/debug output (no-op in production)
extern int64_t trace(const char *msg, uint32_t msg_len, 
                     uint8_t *buf, uint32_t buf_len, int as_hex);

#endif // HOOKAPI_H

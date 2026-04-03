/**
 * Sovereign — Seat Registry Hook
 * Xahau Hook (C → WebAssembly)
 *
 * Manages the council seat lifecycle:
 *   - Seat claim (SEC): validates fee + stake, no duplicates
 *   - Heartbeat (HBT): updates last_heartbeat timestamp
 *   - Activity (ACT): updates last_activity timestamp
 *
 * State layout (key = 20-byte account ID + 12 zero bytes):
 *   [0..3]   seat_id       (uint32 big-endian)
 *   [4..11]  term_start    (int64 big-endian, ledger sequence)
 *   [8..15]  term_end      (int64 big-endian, ledger sequence)
 *   [16]     status        (0=inactive, 1=active, 2=evicted)
 *   [17..24] last_heartbeat(int64 big-endian, ledger sequence)
 *   [25..32] last_activity (int64 big-endian, ledger sequence)
 *
 * Counter state (key = "CNT\0..."):
 *   [0..3]   next_seat_id  (uint32 big-endian)
 *   [4..7]   active_count  (uint32 big-endian)
 */

#include "hookapi.h"

#define SEAT_RECORD_SIZE 33

// Drops constants
#define TOTAL_DROPS   55000000LL    // 5 + 50 XRP

int64_t hook(uint32_t reserved)
{
    // Only trigger on payments
    int64_t tt = otxn_type();
    if (tt != ttPAYMENT)
        accept(SBUF("seat_registry: not a payment, passing."), 0);

    // Get the originating account
    uint8_t otxn_accid[20];
    otxn_field(SBUF(otxn_accid), sfAccount);

    // Get hook account
    uint8_t hook_accid[20];
    hook_account(SBUF(hook_accid));

    // Only process incoming transactions (destination = hook account)
    uint8_t dest_accid[20];
    otxn_field(SBUF(dest_accid), sfDestination);

    // Compare destination to hook account
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
        accept(SBUF("seat_registry: outgoing tx, passing."), 0);

    // Read memo type to determine action
    uint8_t memo_type[32];
    int64_t memo_type_len = otxn_field(SBUF(memo_type), sfMemoType);
    if (memo_type_len < 3)
        accept(SBUF("seat_registry: no memo type, passing."), 0);

    // Build key from sender account
    uint8_t state_key[32];
    for (int i = 0; GUARD(20), i < 20; i++)
        state_key[i] = otxn_accid[i];
    for (int i = 20; GUARD(12), i < 32; i++)
        state_key[i] = 0;

    int64_t cur_seq = ledger_seq();

    // === HEARTBEAT ===
    if (memo_type[0] == 'H' && memo_type[1] == 'B' && memo_type[2] == 'T')
    {
        uint8_t record[SEAT_RECORD_SIZE];
        int64_t r = state(SBUF(record), SBUF(state_key));
        if (r < 0)
            rollback(SBUF("seat_registry: heartbeat - no seat found."), 10);

        if (record[16] != 1)
            rollback(SBUF("seat_registry: heartbeat - seat not active."), 11);

        // Update last_heartbeat (bytes 17-24) big-endian
        UINT64_TO_BUF(record + 17, cur_seq);

        state_set(SBUF(record), SBUF(state_key));
        accept(SBUF("seat_registry: heartbeat recorded."), 0);
    }

    // === ACTIVITY ===
    if (memo_type[0] == 'A' && memo_type[1] == 'C' && memo_type[2] == 'T')
    {
        uint8_t record[SEAT_RECORD_SIZE];
        int64_t r = state(SBUF(record), SBUF(state_key));
        if (r < 0)
            rollback(SBUF("seat_registry: activity - no seat found."), 20);

        if (record[16] != 1)
            rollback(SBUF("seat_registry: activity - seat not active."), 21);

        // Update last_activity (bytes 25-32) big-endian
        UINT64_TO_BUF(record + 25, cur_seq);

        state_set(SBUF(record), SBUF(state_key));
        accept(SBUF("seat_registry: activity recorded."), 0);
    }

    // === SEAT CLAIM ===
    if (memo_type[0] == 'S' && memo_type[1] == 'E' && memo_type[2] == 'C')
    {
        // Check if sender already has an active seat
        uint8_t existing[SEAT_RECORD_SIZE];
        int64_t r = state(SBUF(existing), SBUF(state_key));
        if (r >= 0 && existing[16] == 1)
            rollback(SBUF("seat_registry: duplicate seat claim."), 30);

        // Check payment amount
        uint8_t amt_buf[8];
        otxn_field(SBUF(amt_buf), sfAmount);
        int64_t drops = AMOUNT_TO_DROPS(amt_buf);
        if (drops < TOTAL_DROPS)
            rollback(SBUF("seat_registry: insufficient payment."), 31);

        // Read counter state
        uint8_t counter_key[32];
        counter_key[0] = 'C'; counter_key[1] = 'N'; counter_key[2] = 'T';
        for (int i = 3; GUARD(29), i < 32; i++) counter_key[i] = 0;

        uint8_t counter_buf[8];
        int64_t cr = state(SBUF(counter_buf), SBUF(counter_key));

        uint32_t next_id = 1;
        uint32_t active_count = 0;
        if (cr >= 0)
        {
            next_id = UINT32_FROM_BUF(counter_buf);
            active_count = UINT32_FROM_BUF(counter_buf + 4);
        }

        // Build seat record
        uint8_t record[SEAT_RECORD_SIZE];
        for (int i = 0; GUARD(SEAT_RECORD_SIZE), i < SEAT_RECORD_SIZE; i++)
            record[i] = 0;

        // seat_id (bytes 0-3) big-endian
        UINT32_TO_BUF(record, next_id);

        // term_start (bytes 4-11) big-endian
        UINT64_TO_BUF(record + 4, cur_seq);

        // term_end = term_start + ~90 days in ledgers (~2.2M ledgers)
        int64_t term_end = cur_seq + 2220000;
        UINT64_TO_BUF(record + 8, term_end);

        // status = active
        record[16] = 1;

        // last_heartbeat = now (bytes 17-24)
        UINT64_TO_BUF(record + 17, cur_seq);

        // last_activity = now (bytes 25-32)
        UINT64_TO_BUF(record + 25, cur_seq);

        // Save seat record
        state_set(SBUF(record), SBUF(state_key));

        // Update counter
        next_id++;
        active_count++;
        UINT32_TO_BUF(counter_buf, next_id);
        UINT32_TO_BUF(counter_buf + 4, active_count);
        state_set(SBUF(counter_buf), SBUF(counter_key));

        accept(SBUF("seat_registry: seat claimed."), 0);
    }

    // Not a recognized memo type — pass through
    accept(SBUF("seat_registry: unrecognized memo, passing."), 0);
    return 0;
}

int64_t cbak(uint32_t reserved)
{
    return 0;
}

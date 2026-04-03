/**
 * These are helper macros for writing hooks, all of them are optional as is including hookmacro.h at all
 */

#include <stdint.h>
#include "hookapi.h"
#include "sfcodes.h"

#ifndef HOOKMACROS_INCLUDED
#define HOOKMACROS_INCLUDED 1

#define DONEEMPTY()\
    accept(0,0,__LINE__)

#define DONEMSG(msg)\
    accept(msg, sizeof(msg),__LINE__)

#define DONE(x)\
    accept(SBUF(x),__LINE__)

#define SVAR(x) &x, sizeof(x)

#define ASSERT(x)\
{\
    if (!(x))\
        rollback(0,0,__LINE__);\
}

#define FLIP_ENDIAN(n) ((uint32_t) (((n & 0xFFU) << 24U) | \
                                   ((n & 0xFF00U) << 8U) | \
                                 ((n & 0xFF0000U) >> 8U) | \
                                ((n & 0xFF000000U) >> 24U)))


#ifdef NDEBUG
#define DEBUG 0
#else
#define DEBUG 1
#endif

#define TRACEVAR(v) if (DEBUG) trace_num((uint32_t)(#v), (uint32_t)(sizeof(#v) - 1), (int64_t)v);
#define TRACEHEX(v) if (DEBUG) trace((uint32_t)(#v), (uint32_t)(sizeof(#v) - 1), (uint32_t)(v), (uint32_t)(sizeof(v)), 1);
#define TRACEXFL(v) if (DEBUG) trace_float((uint32_t)(#v), (uint32_t)(sizeof(#v) - 1), (int64_t)v);
#define TRACESTR(v) if (DEBUG) trace((uint32_t)(#v), (uint32_t)(sizeof(#v) - 1), (uint32_t)(v), sizeof(v), 0);

// hook developers should use this guard macro, simply GUARD(<maximum iterations>)
#define GUARD(maxiter) _g((1ULL << 31U) + __LINE__, (maxiter)+1)
#define GUARDM(maxiter, n) _g(( (1ULL << 31U) + (__LINE__ << 16) + n), (maxiter)+1)

#define SBUF(str) (uint32_t)(str), sizeof(str)

#define REQUIRE(cond, str)\
{\
    if (!(cond))\
        rollback(SBUF(str), __LINE__);\
}

#define CLEARBUF(b)\
{\
    for (int x = 0; GUARD(sizeof(b)), x < sizeof(b); ++x)\
        b[x] = 0;\
}

// returns an in64_t, negative if error, non-negative if valid drops
#define AMOUNT_TO_DROPS(amount_buffer)\
     (((amount_buffer)[0] >> 7) ? -2 : (\
     ((((uint64_t)((amount_buffer)[0])) & 0xb00111111) << 56) +\
      (((uint64_t)((amount_buffer)[1])) << 48) +\
      (((uint64_t)((amount_buffer)[2])) << 40) +\
      (((uint64_t)((amount_buffer)[3])) << 32) +\
      (((uint64_t)((amount_buffer)[4])) << 24) +\
      (((uint64_t)((amount_buffer)[5])) << 16) +\
      (((uint64_t)((amount_buffer)[6])) <<  8) +\
      (((uint64_t)((amount_buffer)[7])))))

#define SUB_OFFSET(x) ((int32_t)(x >> 32))
#define SUB_LENGTH(x) ((int32_t)(x & 0xFFFFFFFFULL))

#define BUFFER_EQUAL_20(buf1, buf2)\
    (\
        *(((uint64_t*)(buf1)) + 0) == *(((uint64_t*)(buf2)) + 0) &&\
        *(((uint64_t*)(buf1)) + 1) == *(((uint64_t*)(buf2)) + 1) &&\
        *(((uint32_t*)(buf1)) + 4) == *(((uint32_t*)(buf2)) + 4))

#define BUFFER_EQUAL_32(buf1, buf2)\
    (\
        *(((uint64_t*)(buf1)) + 0) == *(((uint64_t*)(buf2)) + 0) &&\
        *(((uint64_t*)(buf1)) + 1) == *(((uint64_t*)(buf2)) + 1) &&\
        *(((uint64_t*)(buf1)) + 2) == *(((uint64_t*)(buf2)) + 2) &&\
        *(((uint64_t*)(buf1)) + 3) == *(((uint64_t*)(buf2)) + 3) &&\
        *(((uint64_t*)(buf1)) + 4) == *(((uint64_t*)(buf2)) + 4) &&\
        *(((uint64_t*)(buf1)) + 5) == *(((uint64_t*)(buf2)) + 5) &&\
        *(((uint64_t*)(buf1)) + 6) == *(((uint64_t*)(buf2)) + 6) &&\
        *(((uint64_t*)(buf1)) + 7) == *(((uint64_t*)(buf2)) + 7))

#define BUFFER_EQUAL_GUARD(output, buf1, buf1len, buf2, buf2len, n)\
{\
    output = ((buf1len) == (buf2len) ? 1 : 0);\
    for (int x = 0; GUARDM( (buf2len) * (n), 1 ), output && x < (buf2len);\
         ++x)\
        output = *(((uint8_t*)(buf1)) + x) == *(((uint8_t*)(buf2)) + x);\
}

#define BUFFER_SWAP(x,y)\
{\
    uint8_t* z = x;\
    x = y;\
    y = z;\
}

#define ACCOUNT_COMPARE(compare_result, buf1, buf2)\
{\
    compare_result = 0;\
    for (int i = 0; GUARD(20), i < 20; ++i)\
    {\
        if (buf1[i] > buf2[i])\
        {\
            compare_result = 1;\
            break;\
        }\
        else if (buf1[i] < buf2[i])\
        {\
            compare_result = -1;\
            break;\
        }\
    }\
}

#define BUFFER_EQUAL_STR_GUARD(output, buf1, buf1len, str, n)\
    BUFFER_EQUAL_GUARD(output, buf1, buf1len, str, (sizeof(str)-1), n)

#define BUFFER_EQUAL_STR(output, buf1, buf1len, str)\
    BUFFER_EQUAL_GUARD(output, buf1, buf1len, str, (sizeof(str)-1), 1)

#define BUFFER_EQUAL(output, buf1, buf2, compare_len)\
    BUFFER_EQUAL_GUARD(output, buf1, compare_len, buf2, compare_len, 1)

#define UINT16_TO_BUF(buf_raw, i)\
{\
    unsigned char* buf = (unsigned char*)buf_raw;\
    buf[0] = (((uint64_t)i) >> 8) & 0xFFUL;\
    buf[1] = (((uint64_t)i) >> 0) & 0xFFUL;\
}

#define UINT16_FROM_BUF(buf)\
    (((uint64_t)((buf)[0]) <<  8) +\
     ((uint64_t)((buf)[1]) <<  0))

#define UINT32_TO_BUF(buf_raw, i)\
{\
    unsigned char* buf = (unsigned char*)buf_raw;\
    buf[0] = (((uint64_t)i) >> 24) & 0xFFUL;\
    buf[1] = (((uint64_t)i) >> 16) & 0xFFUL;\
    buf[2] = (((uint64_t)i) >>  8) & 0xFFUL;\
    buf[3] = (((uint64_t)i) >>  0) & 0xFFUL;\
}


#define UINT32_FROM_BUF(buf)\
    (((uint64_t)((buf)[0]) << 24) +\
     ((uint64_t)((buf)[1]) << 16) +\
     ((uint64_t)((buf)[2]) <<  8) +\
     ((uint64_t)((buf)[3]) <<  0))

#define UINT64_TO_BUF(buf_raw, i)\
{\
    unsigned char* buf = (unsigned char*)buf_raw;\
    buf[0] = (((uint64_t)i) >> 56) & 0xFFUL;\
    buf[1] = (((uint64_t)i) >> 48) & 0xFFUL;\
    buf[2] = (((uint64_t)i) >> 40) & 0xFFUL;\
    buf[3] = (((uint64_t)i) >> 32) & 0xFFUL;\
    buf[4] = (((uint64_t)i) >> 24) & 0xFFUL;\
    buf[5] = (((uint64_t)i) >> 16) & 0xFFUL;\
    buf[6] = (((uint64_t)i) >>  8) & 0xFFUL;\
    buf[7] = (((uint64_t)i) >>  0) & 0xFFUL;\
}


#define UINT64_FROM_BUF(buf)\
    (((uint64_t)((buf)[0]) << 56) +\
     ((uint64_t)((buf)[1]) << 48) +\
     ((uint64_t)((buf)[2]) << 40) +\
     ((uint64_t)((buf)[3]) << 32) +\
     ((uint64_t)((buf)[4]) << 24) +\
     ((uint64_t)((buf)[5]) << 16) +\
     ((uint64_t)((buf)[6]) <<  8) +\
     ((uint64_t)((buf)[7]) <<  0))


#define INT64_FROM_BUF(buf)\
   ((((uint64_t)((buf)[0] & 0x7FU) << 56) +\
     ((uint64_t)((buf)[1]) << 48) +\
     ((uint64_t)((buf)[2]) << 40) +\
     ((uint64_t)((buf)[3]) << 32) +\
     ((uint64_t)((buf)[4]) << 24) +\
     ((uint64_t)((buf)[5]) << 16) +\
     ((uint64_t)((buf)[6]) <<  8) +\
     ((uint64_t)((buf)[7]) <<  0)) * (buf[0] & 0x80U ? -1 : 1))

#define INT64_TO_BUF(buf_raw, i)\
{\
    unsigned char* buf = (unsigned char*)buf_raw;\
    buf[0] = (((uint64_t)i) >> 56) & 0x7FUL;\
    buf[1] = (((uint64_t)i) >> 48) & 0xFFUL;\
    buf[2] = (((uint64_t)i) >> 40) & 0xFFUL;\
    buf[3] = (((uint64_t)i) >> 32) & 0xFFUL;\
    buf[4] = (((uint64_t)i) >> 24) & 0xFFUL;\
    buf[5] = (((uint64_t)i) >> 16) & 0xFFUL;\
    buf[6] = (((uint64_t)i) >>  8) & 0xFFUL;\
    buf[7] = (((uint64_t)i) >>  0) & 0xFFUL;\
    if (i < 0) buf[0] |= 0x80U;\
}

#define ttPAYMENT 0
#define ttESCROW_CREATE 1
#define ttESCROW_FINISH 2
#define ttACCOUNT_SET 3
#define ttESCROW_CANCEL 4
#define ttREGULAR_KEY_SET 5
#define ttOFFER_CREATE 7
#define ttOFFER_CANCEL 8
#define ttTICKET_CREATE 10
#define ttSIGNER_LIST_SET 12
#define ttPAYCHAN_CREATE 13
#define ttPAYCHAN_FUND 14
#define ttPAYCHAN_CLAIM 15
#define ttCHECK_CREATE 16
#define ttCHECK_CASH 17
#define ttCHECK_CANCEL 18
#define ttDEPOSIT_PREAUTH 19
#define ttTRUST_SET 20
#define ttACCOUNT_DELETE 21
#define ttHOOK_SET 22
#define ttNFTOKEN_MINT 25
#define ttNFTOKEN_BURN 26
#define ttNFTOKEN_CREATE_OFFER 27
#define ttNFTOKEN_CANCEL_OFFER 28
#define ttNFTOKEN_ACCEPT_OFFER 29
#define ttURITOKEN_MINT 45
#define ttURITOKEN_BURN 46
#define ttURITOKEN_BUY 47
#define ttURITOKEN_CREATE_SELL_OFFER 48
#define ttURITOKEN_CANCEL_SELL_OFFER 49
#define ttCLAIM_REWARD 98
#define ttINVOKE 99
#define ttAMENDMENT 100
#define ttFEE 101
#define ttUNL_MODIFY 102
#define ttEMIT_FAILURE 103
#define tfCANONICAL 0x80000000UL

#define atACCOUNT 1U
#define atOWNER 2U
#define atDESTINATION 3U
#define atISSUER 4U
#define atAUTHORIZE 5U
#define atUNAUTHORIZE 6U
#define atTARGET 7U
#define atREGULARKEY 8U
#define atPSEUDOCALLBACK 9U

#define amAMOUNT 1U
#define amBALANCE 2U
#define amLIMITAMOUNT 3U
#define amTAKERPAYS 4U
#define amTAKERGETS 5U
#define amLOWLIMIT 6U
#define amHIGHLIMIT 7U
#define amFEE 8U
#define amSENDMAX 9U
#define amDELIVERMIN 10U
#define amMINIMUMOFFER 16U
#define amRIPPLEESCROW 17U
#define amDELIVEREDAMOUNT 18U

#endif

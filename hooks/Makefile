# Sovereign — Hook Compilation Makefile
# Usage:
#   make          — build all hooks
#   make clean    — remove build artifacts
#   make <name>   — build a single hook (e.g. make seat_registry)

CC       = clang
LD       = wasm-ld
BUILD    = ../build/hooks

CFLAGS   = --target=wasm32 -Os -nostdlib -fno-builtin -std=c11 \
           -Wall -Wextra -Wno-unused-parameter -I.

LDFLAGS  = --no-entry --allow-undefined \
           --export=hook --export=cbak \
           -z stack-size=8192 \
           --initial-memory=65536 --max-memory=65536

HOOKS    = seat_registry vote_enforcer stake_lockbox \
           governance_lock branch_activation rotation_enforcer

WASMS    = $(addprefix $(BUILD)/,$(addsuffix .wasm,$(HOOKS)))

.PHONY: all clean $(HOOKS)

all: $(WASMS)
	@echo "[hooks] ✓ All hooks compiled."
	@ls -la $(BUILD)/*.wasm

$(BUILD)/%.wasm: %.c hookapi.h | $(BUILD)
	@echo "[hooks] $*.c → $*.wasm"
	$(CC) $(CFLAGS) -c $< -o $(BUILD)/$*.o
	$(LD) $(LDFLAGS) $(BUILD)/$*.o -o $@
	@rm -f $(BUILD)/$*.o
	@echo "[hooks] ✓ $*.wasm ($$(wc -c < $@) bytes)"

$(BUILD):
	mkdir -p $(BUILD)

$(HOOKS): %: $(BUILD)/%.wasm

clean:
	rm -rf $(BUILD)
	@echo "[hooks] Cleaned."

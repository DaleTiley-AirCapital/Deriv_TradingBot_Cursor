# Symbol Model Architecture

This folder is the boundary for symbol-specific trading logic.

## Target Flow

```text
Symbol Model -> Symbol Engine -> Trade Candidate -> Portfolio Coordinator / Allocator -> Trade Manager
```

## Ownership Rules

Each symbol model owns all symbol-specific behavior:

- entry setup matching
- runtime quality band and tier interpretation
- TP, SL, trailing, and hold policy
- symbol-specific trade management
- calibrated runtime model interpretation

The portfolio coordinator and allocator do not calculate symbol-specific TP, SL, trailing, or entry rules. They only compare valid `SymbolTradeCandidate` objects across symbols and decide which candidates receive capital.

## Candidate Contract

A `SymbolTradeCandidate` must already contain:

- `direction`
- `nativeScore`
- `confidenceScore`
- `qualityBand`
- `leadInShape`
- `runtimeSetup`
- `exitPolicy`
- `features`
- `runtimeCalibration`

This means CRASH300, BOOM300, R_75, and R_100 can be tuned independently. If CRASH300 is profitable, later BOOM300 tuning should not change CRASH300 unless a shared contract is intentionally updated.

## Adding Symbols Later

For future symbols, add a symbol model module that implements `SymbolTradingModel`, register it, calibrate it, promote the runtime profile, and let the allocator compare its candidates with the rest. The goal is that a symbol can be enabled, disabled, shared, or withheld without rewriting the portfolio layer.

## Current Migration Status

CRASH300 runtime evidence and dynamic TP selection are centralized in `runtimeProfileUtils.ts`. Existing V3 engines still feed the backtest and scheduler directly while we migrate toward the `SymbolTradeCandidate` contract.

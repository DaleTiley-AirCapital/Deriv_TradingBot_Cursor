export function manageCrash300OpenPosition(
  position: Record<string, unknown>,
  marketState: Record<string, unknown>,
): Record<string, unknown> {
  return {
    symbol: "CRASH300",
    managedBy: "shared_trade_management_state_machine",
    action: "pass_through",
    position,
    marketState,
  };
}

/** Open the Connections window (exchange keys, Telegram, RPC) from any panel. */
export function openConnections() {
  window.dispatchEvent(new CustomEvent('novus:connect'));
}

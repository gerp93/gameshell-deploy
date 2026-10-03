import { getBalance } from "./api";

// Header readout of this month's Digital Ocean spend (`doctl balance get`).
// It is account-wide — every droplet/app on the account, not only the games
// this tool deployed — and DO refreshes it periodically rather than live, so
// the tooltip says when it was generated. Click to re-read it.
export function createSpendBadge(): HTMLElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "spend-badge";
  el.textContent = "DO this month: …";

  async function refresh() {
    el.disabled = true;
    // Visible feedback on click — the call goes out to DigitalOcean and can
    // take a couple of seconds, and an unchanged "n/a" looks like nothing happened.
    el.textContent = "DO this month: checking…";
    try {
      const balance = await getBalance();
      const usage = Number(balance.monthToDateUsage);
      el.textContent = Number.isFinite(usage) ? `DO this month: $${usage.toFixed(2)}` : "DO this month: n/a";
      const generated = balance.generatedAt ? new Date(balance.generatedAt) : null;
      const asOf = generated && !Number.isNaN(generated.getTime()) ? ` as of ${generated.toLocaleString()}` : "";
      el.title =
        `Month-to-date usage for the whole Digital Ocean account${asOf} — not just these games. ` +
        "Click to refresh.";
    } catch (err) {
      // Usually a scoped API token without billing access; say so on the
      // badge itself and keep the full message in the tooltip.
      const message = err instanceof Error ? err.message : String(err);
      el.textContent = /billing|403|not authorized/i.test(message) ? "DO this month: no billing access" : "DO this month: n/a";
      el.title = `Couldn't read Digital Ocean spend: ${message} Click to retry.`;
    } finally {
      el.disabled = false;
    }
  }

  el.onclick = () => void refresh();
  void refresh();
  return el;
}

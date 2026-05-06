import { showHUD, showToast, Toast } from "@raycast/api";
import { snapWindow } from "./tin-api";

export default async function Command() {
  try {
    const result = await snapWindow();
    if (result.note === "already snapped") {
      await showHUD("Already snapped");
      return;
    }
    await showHUD(`Snapped to slot ${(result.slot ?? 0) + 1}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isTiNDown = msg.includes("fetch") || msg.includes("ECONNREFUSED") || msg.includes("timeout");
    await showToast({
      style: Toast.Style.Failure,
      title: isTiNDown ? "TiN is not running" : "Snap failed",
      message: isTiNDown ? "Start TiN and try again" : msg,
    });
  }
}

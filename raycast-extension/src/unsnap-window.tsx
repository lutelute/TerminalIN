import { showHUD, showToast, Toast } from "@raycast/api";
import { unsnapWindow } from "./tin-api";

export default async function Command() {
  try {
    const result = await unsnapWindow();
    if (!result.ok) {
      await showHUD("Window is not snapped");
      return;
    }
    await showHUD("Unsnapped");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isTiNDown = msg.includes("fetch") || msg.includes("ECONNREFUSED") || msg.includes("timeout");
    await showToast({
      style: Toast.Style.Failure,
      title: isTiNDown ? "TiN is not running" : "Unsnap failed",
      message: isTiNDown ? "Start TiN and try again" : msg,
    });
  }
}

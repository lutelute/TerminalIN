import { Action, ActionPanel, Color, Icon, List, showHUD, showToast, Toast } from "@raycast/api";
import { useEffect, useState } from "react";
import { focusTiN, getStatus, snapWindow, Workspace } from "./tin-api";

export default function Command() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getStatus()
      .then((s) => setWorkspaces(s.workspaces))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <List isLoading={loading} navigationTitle="TiN Workspaces">
      {workspaces.map((ws) => (
        <List.Item
          key={ws.id}
          title={ws.name}
          subtitle={`${ws.gridCols}×${ws.gridRows} grid · ${ws.snapped.length} snapped`}
          accessories={[
            ws.snapped.length > 0
              ? { tag: { value: String(ws.snapped.length), color: Color.Blue } }
              : { tag: { value: "empty", color: Color.SecondaryText } },
          ]}
          icon={{ source: Icon.AppWindowGrid3x3, tintColor: ws.snapped.length > 0 ? Color.Blue : Color.SecondaryText }}
          actions={
            <ActionPanel>
              <Action
                title="Focus TiN"
                icon={Icon.Eye}
                onAction={async () => {
                  try {
                    await focusTiN();
                    await showHUD(`Focused ${ws.name}`);
                  } catch {
                    await showToast({ style: Toast.Style.Failure, title: "TiN is not running" });
                  }
                }}
              />
              <Action
                title="Snap Frontmost Window Here"
                icon={Icon.Pin}
                onAction={async () => {
                  await showToast({ style: Toast.Style.Animated, title: "Snapping…" });
                  try {
                    const r = await snapWindow({ workspaceId: ws.id });
                    if (r.note === "already snapped") {
                      await showHUD("Already snapped");
                    } else {
                      await showHUD(`Snapped to ${ws.name} slot ${(r.slot ?? 0) + 1}`);
                    }
                  } catch (e) {
                    await showToast({ style: Toast.Style.Failure, title: "Snap failed", message: String(e) });
                  }
                }}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}

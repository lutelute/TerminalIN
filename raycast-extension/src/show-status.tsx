import { Action, ActionPanel, Color, Icon, List, showToast, Toast } from "@raycast/api";
import { useEffect, useState } from "react";
import { getStatus, Workspace } from "./tin-api";
import { unsnapWindow } from "./tin-api";

export default function Command() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  async function load() {
    setLoading(true);
    try {
      const status = await getStatus();
      setWorkspaces(status.workspaces);
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  if (error) {
    return (
      <List isLoading={false}>
        <List.EmptyView icon={Icon.Warning} title="TiN is not running" description="Start TiN and try again" />
      </List>
    );
  }

  return (
    <List isLoading={loading} navigationTitle="TiN Status">
      {workspaces.map((ws) => (
        <List.Section key={ws.id} title={`${ws.name}  ${ws.gridCols}×${ws.gridRows}`}>
          {ws.snapped.length === 0 && ws.gridTerminals === 0 ? (
            <List.Item title="No windows snapped" icon={{ source: Icon.Circle, tintColor: Color.SecondaryText }} />
          ) : null}
          {ws.snapped.map((w) => (
            <List.Item
              key={w.windowNumber}
              title={w.title || w.app}
              subtitle={w.app}
              accessories={[{ text: `Slot ${w.slot + 1}` }]}
              icon={{ source: Icon.Window, tintColor: Color.Blue }}
              actions={
                <ActionPanel>
                  <Action
                    title="Unsnap"
                    icon={Icon.XMarkCircle}
                    onAction={async () => {
                      await showToast({ style: Toast.Style.Animated, title: "Unsnapping…" });
                      try {
                        await unsnapWindow({ windowNumber: w.windowNumber });
                        await load();
                        await showToast({ style: Toast.Style.Success, title: "Unsnapped" });
                      } catch (e) {
                        await showToast({ style: Toast.Style.Failure, title: "Failed", message: String(e) });
                      }
                    }}
                  />
                  <Action title="Refresh" icon={Icon.ArrowClockwise} onAction={load} />
                </ActionPanel>
              }
            />
          ))}
          {ws.gridTerminals > 0 && (
            <List.Item
              title={`${ws.gridTerminals} terminal${ws.gridTerminals > 1 ? "s" : ""}`}
              icon={{ source: Icon.Terminal, tintColor: Color.Green }}
            />
          )}
        </List.Section>
      ))}
    </List>
  );
}

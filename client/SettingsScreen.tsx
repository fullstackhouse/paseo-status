import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { experimentSettings } from "../shared/settings";

export function SettingsScreen(_props: PluginSurfaceProps) {
  const experiments = useSettings(experimentSettings);
  return (
    <SettingsSection title="Experimental">
      <SettingsCard>
        <SettingsSwitch
          label="Working only while work is live (experimental)"
          hint="A working card keeps its workspace in Working only while the agent, its subagents or background work, or an agent it started is still running, plus 5 minutes; an idle parent whose children all stopped is asked once to update its status. Off: a working card holds Working for a day."
          value={experiments.status === "ready" && experiments.values.liveBackedWorking}
          disabled={experiments.status !== "ready" || experiments.saving}
          error={experiments.saveError ?? undefined}
          onValueChange={(liveBackedWorking) => {
            if (experiments.status === "ready") void experiments.save({ liveBackedWorking }, experiments.revision);
          }}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

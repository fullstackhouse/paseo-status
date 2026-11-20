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
          label="Blocked group (experimental)"
          hint="A workspace whose agent says it is blocked on another workspace or another person (such as a peer's review) moves to Paseo's Blocked group, with no needs-you badge, and doesn't wake a snoozed workspace. Needs a Paseo build with the Blocked group. Off: a blocked card counts as needing you."
          value={experiments.status === "ready" && experiments.values.blockedGroup}
          disabled={experiments.status !== "ready" || experiments.saving}
          error={experiments.saveError ?? undefined}
          onValueChange={(blockedGroup) => {
            if (experiments.status === "ready") void experiments.save({ blockedGroup }, experiments.revision);
          }}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

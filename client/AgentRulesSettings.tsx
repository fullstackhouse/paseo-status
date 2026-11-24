import { Text } from "react-native";
import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsSection } from "@getpaseo/plugin/client/ui";
import { INSTRUCTIONS } from "../shared/instructions";
import { agentSettings } from "../shared/settings";
import { InstructionsSetting } from "./InstructionsSetting";

/** The status_set rules agents get. Read when an agent starts, so changes reach new agents only. */
export function AgentRulesSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(agentSettings);
  if (settings.status === "loading") return <Text style={{ color: theme.colors.foregroundMuted }}>Loading settings…</Text>;
  if (settings.status !== "ready") return <Text style={{ color: theme.colors.statusDanger }}>{settings.error}</Text>;
  const { values, revision } = settings;
  return (
    <SettingsSection title="Agents">
      <SettingsCard>
        <InstructionsSetting
          theme={theme}
          builtIn={INSTRUCTIONS}
          saved={values.customInstructions}
          disabled={settings.saving}
          save={(customInstructions) => settings.save({ ...values, customInstructions }, revision)}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { INSTRUCTIONS, INSTRUCTIONS_LIMIT } from "../shared/instructions";
import { agentSettings } from "../shared/settings";

/** The status_set rules agents get. Read when an agent starts, so changes reach new agents only. */
export function AgentRulesSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(agentSettings);
  const saved = settings.status === "ready" ? settings.values.customInstructions : "";
  const [draft, setDraft] = useState(saved);
  const [edited, setEdited] = useState(false);
  // Follow saves from elsewhere (another window, a reset) until the human starts typing.
  useEffect(() => {
    if (!edited) setDraft(saved);
  }, [saved, edited]);

  const muted = { color: theme.colors.foregroundMuted };
  if (settings.status === "loading") return <Text style={muted}>Loading settings…</Text>;
  if (settings.status !== "ready") return <Text style={{ color: theme.colors.statusDanger }}>{settings.error}</Text>;
  const { values, revision } = settings;
  const busy = settings.saving;
  const custom = saved.trim() !== "";
  const over = draft.length > INSTRUCTIONS_LIMIT;
  const save = async (customInstructions: string) => {
    if (await settings.save({ ...values, customInstructions }, revision)) {
      setDraft(customInstructions);
      setEdited(false);
    }
  };
  const colors = theme.colors;

  return (
    <SettingsSection title="Agents">
      <SettingsCard>
        <SettingsRow
          label="Custom instructions"
          hint="Replace the built-in rules agents get for status cards. Leave empty to use the built-in ones. Applies to agents started after you save."
          error={settings.saveError}
        >
          <View style={{ gap: 4, alignSelf: "stretch" }}>
            <TextInput
              testID="status-custom-instructions"
              value={draft}
              onChangeText={(text) => {
                setDraft(text);
                setEdited(true);
              }}
              placeholder="Built-in rules"
              placeholderTextColor={colors.foregroundMuted}
              multiline
              editable={!busy}
              style={{
                color: colors.foreground,
                borderWidth: 1,
                borderColor: over ? colors.statusWarning : colors.border,
                borderRadius: 6,
                padding: 8,
                minHeight: 160,
                maxHeight: 360,
                fontFamily: "monospace",
                fontSize: 12,
                textAlignVertical: "top",
              }}
            />
            <Text style={{ fontSize: 12, color: over ? colors.statusWarning : colors.foregroundMuted }}>
              {draft.length} / {INSTRUCTIONS_LIMIT}
              {over ? ` · Claude Code cuts everything past ${INSTRUCTIONS_LIMIT} characters.` : ""}
            </Text>
          </View>
        </SettingsRow>
        <SettingsAction
          label="Start from the built-in rules"
          hint="Fills the box with the built-in rules to edit."
          actionLabel="Fill"
          disabled={busy || draft.trim() !== ""}
          onPress={() => {
            setDraft(INSTRUCTIONS);
            setEdited(true);
          }}
        />
        <SettingsAction
          label="Save custom instructions"
          actionLabel="Save"
          disabled={busy || draft === saved}
          onPress={() => void save(draft)}
        />
        <SettingsAction
          label="Use the built-in rules"
          hint="Clears your custom instructions."
          actionLabel="Reset"
          disabled={busy || (!custom && draft === "")}
          onPress={() => void save("")}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

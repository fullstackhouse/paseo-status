import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useCallback, useMemo } from "react";
import { Text } from "react-native";
import { chatTitleSettings } from "../shared/settings";

const NAME_CHATS_HINT =
  "Agents give their chat a short title in each status card. Applies to agents created after you change it. A chat you renamed, or one named when it was created, keeps its title.";

export function ChatTitleSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(chatTitleSettings);
  const style = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  const ready = settings.status === "ready" ? settings : null;
  const changeNameChats = useCallback(
    (nameChats: boolean) => {
      if (ready) void ready.save({ ...ready.values, nameChats }, ready.revision);
    },
    [ready],
  );
  if (settings.status === "loading") return <Text style={style}>Loading settings…</Text>;
  if (settings.status !== "ready")
    return (
      <SettingsSection title="Chat titles">
        <Text style={style}>{settings.error}</Text>
        <SettingsAction label="Try again" actionLabel="Reload" onPress={settings.reload} />
        {settings.status === "invalid" ? <SettingsAction label="Restore the default" actionLabel="Reset" onPress={settings.reset} /> : null}
      </SettingsSection>
    );
  return (
    <SettingsSection title="Chat titles">
      <SettingsCard>
        <SettingsSwitch
          label="Name chats from the status card"
          hint={NAME_CHATS_HINT}
          value={settings.values.nameChats}
          disabled={settings.saving}
          error={settings.saveError}
          onValueChange={changeNameChats}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

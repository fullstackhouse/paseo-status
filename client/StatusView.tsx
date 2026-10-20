import type { PluginTheme } from "@getpaseo/plugin";
import { useAgent, useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { Icon, ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { Pressable, Text, View } from "react-native";
import { listStatuses, refreshAll, refreshStatus, STALE_TURNS, type SilentAgent, type Status, type Waiting } from "../shared/status";

export const POLL_MS = 4000;

export const STATE_LABELS: Record<Status["state"], string> = {
  working: "working",
  waiting_on_you: "waiting on you",
  blocked: "blocked",
  done: "done",
};

type Styles = ReturnType<typeof makeStyles>;

interface ViewProps {
  theme: PluginTheme;
  compact: boolean;
  /** Absent on the global screen: every workspace on this host. */
  workspaceId?: string;
  openAgent?: (agentId: string) => void;
}

export function useStatuses(workspaceId?: string) {
  const list = useRpc(listStatuses);
  return useQuery({
    queryKey: ["status", workspaceId ?? "*"],
    queryFn: () => list({ workspaceId }),
    refetchInterval: POLL_MS,
  });
}

export function StatusView({ theme, compact, workspaceId, openAgent }: ViewProps) {
  const styles = useMemo(() => makeStyles(theme, compact), [theme, compact]);
  const query = useStatuses(workspaceId);
  useAutoRefresh(workspaceId, query.isSuccess);

  if (query.isPending) return <Message styles={styles} text="Loading status…" />;
  if (query.isError) return <Message styles={styles} text={`Could not load status: ${query.error.message}`} danger />;
  const { statuses, waiting, silent } = query.data;
  const toolbar = <Toolbar styles={styles} workspaceId={workspaceId} statuses={statuses} silent={silent} />;
  if (statuses.length === 0 && silent.length === 0) {
    return (
      <View style={[styles.screen, styles.content]}>
        {toolbar}
        <Text style={styles.muted}>{workspaceId ? "No agents in this workspace." : "No agent has published a status yet."}</Text>
      </View>
    );
  }

  const groups = workspaceId ? [[workspaceId, statuses] as const] : [...groupBy(statuses, (status) => status.workspaceId)];
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {toolbar}
      {groups.map(([groupId, items]) => (
        <View key={groupId} style={styles.group}>
          {!workspaceId && <WorkspaceHeading workspaceId={groupId} styles={styles} />}
          {items.map((status) => (
            <StatusCard
              key={status.agentId}
              status={status}
              waiting={waiting.filter((ask) => ask.agentId === status.agentId)}
              styles={styles}
              theme={theme}
              openAgent={openAgent}
            />
          ))}
        </View>
      ))}
      {silent.map((agent) => (
        <SilentCard key={agent.agentId} agent={agent} styles={styles} theme={theme} />
      ))}
    </ScrollView>
  );
}

/** Opening the view asks agents with stale cards for an update, once per update (the server keeps the count). */
function useAutoRefresh(workspaceId: string | undefined, ready: boolean) {
  const refresh = useRpc(refreshAll);
  const toast = useToast();
  const queryClient = useQueryClient();
  const done = useRef(false);
  useEffect(() => {
    if (!ready || done.current) return;
    done.current = true;
    refresh({ workspaceId, auto: true })
      .then(({ asked }) => {
        if (asked === 0) return;
        toast.show(`Asked ${asked} agent${asked === 1 ? "" : "s"} with a stale card for an update.`);
        void queryClient.invalidateQueries({ queryKey: ["status"] });
      })
      .catch((error) => console.error("[status] auto refresh failed", error));
  }, [ready, workspaceId, refresh, toast, queryClient]);
}

function Toolbar(props: { styles: Styles; workspaceId?: string; statuses: Status[]; silent: SilentAgent[] }) {
  const { styles, workspaceId, statuses, silent } = props;
  const refresh = useRpc(refreshAll);
  const queryClient = useQueryClient();
  const toast = useToast();
  const behind = statuses.filter((status) => status.turnsSince > 0 && !status.refreshPending).length + silent.length;
  const mutation = useMutation({
    mutationFn: () => refresh({ workspaceId }),
    onSuccess: ({ asked }) => {
      toast.show(asked ? `Asked ${asked} agent${asked === 1 ? "" : "s"} for an update.` : "Every card is up to date.");
      void queryClient.invalidateQueries({ queryKey: ["status"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });
  const summary = behind ? `${behind} out of date` : "All up to date";
  return (
    <View style={styles.toolbar}>
      <Text style={styles.meta}>{summary}</Text>
      <Button
        styles={styles}
        label={mutation.isPending ? "Asking…" : "Refresh"}
        disabled={mutation.isPending || behind === 0}
        onPress={() => mutation.mutate()}
      />
    </View>
  );
}

function SilentCard({ agent, styles, theme }: { agent: SilentAgent; styles: Styles; theme: PluginTheme }) {
  const refresh = useRpc(refreshStatus);
  const toast = useToast();
  const mutation = useMutation({
    mutationFn: () => refresh({ agentId: agent.agentId }),
    onSuccess: ({ sent }) => toast.show(sent ? "Asked the agent for a status." : "The agent is mid-turn; it will be asked when the turn ends."),
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });
  return (
    <View style={[styles.card, styles.silent]}>
      <View style={styles.header}>
        <Icon name="Bot" size={16} color={theme.colors.foregroundMuted} />
        <Text style={styles.agent} numberOfLines={1}>
          {agent.title ?? agent.agentId}
        </Text>
        <Text style={[styles.badge, styles.muted]}>no status yet</Text>
        <Button
          styles={styles}
          label={mutation.isPending ? "Asking…" : mutation.isSuccess ? "Asked" : "Ask for status"}
          disabled={mutation.isPending || mutation.isSuccess}
          onPress={() => mutation.mutate()}
        />
      </View>
    </View>
  );
}

function WorkspaceHeading({ workspaceId, styles }: { workspaceId: string; styles: Styles }) {
  const name = useWorkspace(workspaceId, (workspace) => workspace?.title ?? workspace?.name ?? null);
  return <Text style={styles.workspace}>{name ?? workspaceId}</Text>;
}

function StatusCard(props: {
  status: Status;
  waiting: Waiting[];
  styles: Styles;
  theme: PluginTheme;
  openAgent?: (agentId: string) => void;
}) {
  const { status, waiting, styles, theme, openAgent } = props;
  const agent = useAgent(status.agentId, (snapshot) => ({ title: snapshot.title, running: snapshot.status === "running" }));
  const refresh = useRpc(refreshStatus);
  const queryClient = useQueryClient();
  const toast = useToast();
  const mutation = useMutation({
    mutationFn: () => refresh({ agentId: status.agentId }),
    onSuccess: ({ sent }) => {
      toast.show(sent ? "Asked the agent for an update." : "The agent is mid-turn; it will be asked when the turn ends.");
      void queryClient.invalidateQueries({ queryKey: ["status"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });
  const stale = status.turnsSince >= STALE_TURNS;
  const stateTone =
    status.state === "blocked" ? styles.bad : status.state === "waiting_on_you" ? styles.warn : status.state === "done" ? styles.good : styles.muted;

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Icon name="Bot" size={16} color={theme.colors.foregroundMuted} />
        <Text style={styles.agent} numberOfLines={1}>
          {agent?.title ?? status.agentId}
        </Text>
        <Text style={[styles.badge, stateTone]}>{STATE_LABELS[status.state]}</Text>
      </View>
      <Text style={styles.tldr}>{status.tldr}</Text>
      {status.now ? <Line styles={styles} label="Now" text={status.now} /> : null}
      {waiting.map((ask) => (
        <Line key={ask.id} styles={styles} label="Your move" text={`${ask.id} ${ask.title}`} tone={styles.warn} />
      ))}
      {status.done.length > 0 && <List styles={styles} title="DONE" mark="✓" items={status.done} />}
      {status.next.length > 0 && <List styles={styles} title="NEXT" mark="→" items={status.next} />}
      <View style={styles.footer}>
        <Text style={[styles.meta, stale && styles.warn]}>
          {`Updated ${age(status.updatedAt)} ago`}
          {status.turnsSince > 0 ? ` · ${status.turnsSince} turn${status.turnsSince === 1 ? "" : "s"} since` : ""}
          {status.refreshPending ? " · update requested" : ""}
          {agent?.running ? " · running" : ""}
        </Text>
        <View style={styles.buttons}>
          <Button
            styles={styles}
            label={mutation.isPending ? "Asking…" : "Refresh"}
            disabled={mutation.isPending || status.refreshPending}
            onPress={() => mutation.mutate()}
          />
          {openAgent && <Button styles={styles} label="Open chat" onPress={() => openAgent(status.agentId)} />}
        </View>
      </View>
    </View>
  );
}

function Line({ styles, label, text, tone }: { styles: Styles; label: string; text: string; tone?: { color: string } }) {
  return (
    <Text style={styles.line}>
      <Text style={[styles.label, tone]}>{`${label}: `}</Text>
      {text}
    </Text>
  );
}

function List({ styles, title, mark, items }: { styles: Styles; title: string; mark: string; items: string[] }) {
  return (
    <View style={styles.list}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {items.map((item, index) => (
        <View key={index} style={styles.item}>
          <Text style={styles.mark}>{mark}</Text>
          <Text style={styles.itemText}>{item}</Text>
        </View>
      ))}
    </View>
  );
}

function Button(props: { styles: Styles; label: string; onPress(): void; disabled?: boolean }) {
  const { styles } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      style={[styles.button, props.disabled && styles.buttonDisabled]}
    >
      <Text style={styles.buttonText}>{props.label}</Text>
    </Pressable>
  );
}

/** One agent's card on its own, for the composer pill's popover. */
export function AgentStatus(props: { theme: PluginTheme; compact: boolean; workspaceId: string; agentId: string }) {
  const { theme, compact, workspaceId, agentId } = props;
  const styles = useMemo(() => makeStyles(theme, compact), [theme, compact]);
  const query = useStatuses(workspaceId);
  if (query.isPending) return <Message styles={styles} text="Loading status…" />;
  if (query.isError) return <Message styles={styles} text={`Could not load status: ${query.error.message}`} danger />;
  const status = query.data.statuses.find((candidate) => candidate.agentId === agentId);
  return (
    <ScrollView style={styles.popover} contentContainerStyle={styles.popoverContent}>
      {status ? (
        <StatusCard
          status={status}
          waiting={query.data.waiting.filter((ask) => ask.agentId === agentId)}
          styles={styles}
          theme={theme}
        />
      ) : (
        <SilentCard agent={{ agentId, title: null }} styles={styles} theme={theme} />
      )}
    </ScrollView>
  );
}

function Message({ styles, text, danger }: { styles: Styles; text: string; danger?: boolean }) {
  return (
    <View style={[styles.screen, styles.content]}>
      <Text style={danger ? styles.bad : styles.muted}>{text}</Text>
    </View>
  );
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}

export function age(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

function makeStyles(theme: PluginTheme, compact: boolean) {
  const { colors } = theme;
  return {
    screen: { flex: 1, backgroundColor: colors.surface0 },
    content: { padding: compact ? 12 : 16, gap: 16 },
    group: { gap: 12 },
    workspace: { color: colors.foreground, fontSize: 15, fontWeight: "600" as const },
    card: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      backgroundColor: colors.surface1,
      padding: compact ? 12 : 14,
      gap: 10,
    },
    header: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
    agent: { color: colors.foregroundMuted, fontSize: 12, flex: 1 },
    badge: { fontSize: 11 },
    tldr: { color: colors.foreground, fontSize: 15, lineHeight: 21 },
    line: { color: colors.foreground, fontSize: 13, lineHeight: 19 },
    label: { color: colors.foregroundMuted, fontWeight: "600" as const },
    list: { gap: 4 },
    sectionTitle: { color: colors.foregroundMuted, fontSize: 11, letterSpacing: 0.5 },
    item: { flexDirection: "row" as const, gap: 6 },
    mark: { color: colors.foregroundMuted, fontSize: 13, lineHeight: 19 },
    itemText: { color: colors.foreground, fontSize: 13, lineHeight: 19, flex: 1 },
    popover: { maxHeight: 520, width: compact ? undefined : 420, backgroundColor: colors.surface0 },
    popoverContent: { padding: 8 },
    toolbar: { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "space-between" as const, gap: 8 },
    silent: { paddingVertical: compact ? 10 : 8 },
    footer: {
      flexDirection: compact ? ("column" as const) : ("row" as const),
      alignItems: compact ? ("flex-start" as const) : ("center" as const),
      justifyContent: "space-between" as const,
      gap: 8,
    },
    meta: { color: colors.foregroundMuted, fontSize: 12 },
    buttons: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
    button: {
      paddingVertical: compact ? 10 : 6,
      paddingHorizontal: 12,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface2,
    },
    buttonDisabled: { opacity: 0.5 },
    buttonText: { color: colors.foreground, fontSize: 13 },
    muted: { color: colors.foregroundMuted },
    good: { color: colors.statusSuccess },
    warn: { color: colors.statusWarning },
    bad: { color: colors.statusDanger },
  };
}

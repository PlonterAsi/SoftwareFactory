/**
 * The fence, wall by wall (build step 1, slice 1).
 *
 * A run never works on Windows. It works in "the room": a WSL2 distribution of its own that has no Windows
 * drives, cannot start Windows programs, and whose worker account cannot become root. Inside the room,
 * Claude Code's own sandbox and a settings file only root can write hold the run to its copy of the project
 * and to a list of network addresses.
 *
 * Everything the room is made of is produced here as text, so it is tested here and there is one source.
 * SoftwareFactory, on the Windows side, is the only one that writes these files into the room (as root,
 * through wsl.exe). The worker can read them and cannot change them.
 */

export interface FenceSettings {
  /** The WSL distribution that is the room. */
  room: string;
  /** The account a run works as. It has no sudo and no password. */
  worker: string;
  /** Where project copies live in the room, one folder per run. */
  copies: string;
  /** The only network names a run's commands may reach. */
  netList: string[];
  /** Ports on the Windows side that the test tries to reach from the room. All must be refused. */
  hostPorts: number[];
  /** The model the fence test uses for its one call. A small one is enough. */
  testModel: string;
  /** How long one step of the test may take. */
  stepTimeoutMs: number;
  /** Tools the projects' own checks need, installed by root from the makers' own sites. Empty: not installed. */
  goVersion: string;
  nodeVersion: string;
  /** The makers' published SHA-256 of those two downloads. Set: the download must match or nothing is unpacked. Empty: not compared. */
  goSha256: string;
  nodeSha256: string;
}

/** Safe starting values. Every one of them is a setting (Assaf, 27 Nov 2026: everything configurable). */
export const FENCE_DEFAULTS: FenceSettings = {
  room: "sf-room",
  worker: "worker",
  copies: "/home/worker/copies",
  // What a Go and Node project needs for its own checks, and GitHub. Nothing else.
  netList: ["github.com", "api.github.com", "codeload.github.com", "registry.npmjs.org", "proxy.golang.org", "sum.golang.org"],
  // File sharing, remote procedure calls, remote desktop, Postgres.
  hostPorts: [445, 135, 3389, 5432],
  testModel: "haiku",
  stepTimeoutMs: 120_000,
  goVersion: "1.26.0",
  nodeVersion: "22.12.0",
  goSha256: "aac1b08a0fb0c4e0a7c1555beb7b59180b05dfc5a3d62e40e9de90cd42f88235",
  nodeSha256: "22982235e1b71fa8850f82edd09cdae7e3f32df1764a9ec298c72d25ef2c164f",
};

export function fenceSettings(over: Partial<FenceSettings> = {}): FenceSettings {
  const s = { ...FENCE_DEFAULTS, ...over };
  for (const [k, v] of [["room", s.room], ["worker", s.worker]] as const) if (!/^[a-z][a-z0-9-]{0,30}$/.test(v)) throw new Error(`fence: ${k} must be a plain lowercase name, got "${v}"`);
  if (!/^\/home\/[a-z0-9/_-]+$/.test(s.copies)) throw new Error(`fence: copies must be a folder under /home, got "${s.copies}"`);
  for (const d of s.netList) if (!/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) throw new Error(`fence: "${d}" is not a network name`);
  if (!s.hostPorts.length) throw new Error("fence: hostPorts is empty, so the Windows side would not be tried at all");
  if (!s.netList.length) throw new Error("fence: netList is empty, so the test could not tell a working net from a dead one");
  if (!/^[a-z0-9][a-z0-9.-]{0,60}$/.test(s.testModel)) throw new Error(`fence: "${s.testModel}" is not a model name`);
  if (!Number.isInteger(s.stepTimeoutMs) || s.stepTimeoutMs < 1000 || s.stepTimeoutMs > 3_600_000) throw new Error(`fence: stepTimeoutMs must be between a second and an hour`);
  for (const [k, v] of [["goVersion", s.goVersion], ["nodeVersion", s.nodeVersion]] as const) if (v && !/^\d+\.\d+(\.\d+)?$/.test(v)) throw new Error(`fence: ${k} must look like 1.2.3, got "${v}"`);
  for (const [k, v] of [["goSha256", s.goSha256], ["nodeSha256", s.nodeSha256]] as const) if (v && !/^[0-9a-f]{64}$/.test(v)) throw new Error(`fence: ${k} must be 64 hex characters`);
  for (const p of s.hostPorts) if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`fence: "${p}" is not a port`);
  return s;
}

/**
 * /etc/wsl.conf of the room. No Windows drives, no starting Windows programs, no Windows folders on the
 * PATH, and the worker is who you are when you come in. Root can still mount a drive by hand, which is why
 * the worker must never become root (see setupScript and the test's "become root" try).
 */
export function wslConf(s: FenceSettings): string {
  return [
    "[automount]", "enabled = false", "mountFsTab = false", "",
    "[interop]", "enabled = false", "appendWindowsPath = false", "",
    "[user]", `default = ${s.worker}`, "",
    "[boot]", "systemd = false", "",
  ].join("\n");
}

/**
 * /etc/claude-code/managed-settings.json: the rules of wall 2. Managed settings win over anything a project,
 * a user or the command line says. Setting names as read on code.claude.com/docs on 27 Nov 2026 (settings,
 * permissions, sandboxing). Whether each one holds is not taken on trust: the fence test tries them.
 */
export function managedSettings(s: FenceSettings): Record<string, unknown> {
  return {
    permissions: {
      defaultMode: "dontAsk",
      disableBypassPermissionsMode: "disable",
      disableAutoMode: "disable",
      // The file tools run outside the sandbox, so they get their own rule: nothing outside the copy.
      blockReadsOutsideWorkingDirectories: true,
      allow: ["Read", "Edit", "Glob", "Grep", "Bash"],
      deny: [
        // The web tools do not follow the net list, so a run does not have them.
        "WebFetch", "WebSearch",
        "Read(~/.claude/**)", "Edit(~/.claude/**)",
        "Read(//etc/claude-code/**)", "Edit(//etc/claude-code/**)",
      ],
    },
    allowManagedPermissionRulesOnly: true,
    // A project's own hooks and MCP servers would run outside the sandbox. A run gets none of them.
    allowManagedHooksOnly: true,
    allowManagedMcpServersOnly: true,
    enableAllProjectMcpServers: false,
    sandbox: {
      enabled: true,
      // No sandbox, no run: without this Claude Code falls back to running commands unfenced.
      failIfUnavailable: true,
      // Turns off the "run this one outside the sandbox" way out.
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      excludedCommands: [],
      filesystem: { denyRead: ["~/.claude"], allowWrite: [] },
      network: { allowedDomains: [...s.netList], allowManagedDomainsOnly: true, allowLocalBinding: false },
    },
  };
}

/**
 * Run once as root inside a fresh room (Ubuntu). It makes the worker, takes away every way to become root,
 * installs what the sandbox needs, and writes the two rule files. Running it again is safe: SoftwareFactory
 * runs it again whenever a fence setting changes (for example the net list).
 */
export function setupScript(s: FenceSettings): string {
  const settings = JSON.stringify(managedSettings(s), null, 2);
  return `#!/bin/bash
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "setup must run as root"; exit 1; }

# The worker: no password, no sudo, in no group that gives rights.
id ${s.worker} >/dev/null 2>&1 || useradd --create-home --shell /bin/bash ${s.worker}
passwd -l ${s.worker} >/dev/null
passwd -l root >/dev/null
# Out of every group but its own (sudo, adm, disk, shadow, docker and whatever a fresh WSL user was given).
usermod -G "" ${s.worker}
rm -f /etc/sudoers.d/*${s.worker}* /etc/sudoers.d/90-cloud-init-users 2>/dev/null || true
if grep -rqsE "^[^#]*\\b${s.worker}\\b" /etc/sudoers /etc/sudoers.d; then echo "the worker is named in sudoers"; exit 1; fi
# su only for root's own group, and it stays that way after a package upgrade.
dpkg-statoverride --list /bin/su >/dev/null 2>&1 || dpkg-statoverride --update --add root root 4750 /bin/su
# Where the test keeps the file a run must not be able to read. Root's folder: the worker cannot plant anything in it.
install -d -m 0755 -o root -g root /srv/sf-fence

# What the sandbox and a run need. Skipped when already there, so a rerun needs no network.
need=""
for p in bubblewrap socat git ripgrep curl ca-certificates iproute2 procps xz-utils nodejs npm; do dpkg -s "$p" >/dev/null 2>&1 || need="$need $p"; done
if [ -n "$need" ]; then export DEBIAN_FRONTEND=noninteractive; apt-get update -qq </dev/null; apt-get install -y -qq $need </dev/null; fi
# Claude Code for everyone, in a place only root can write, so the worker cannot swap the program.
[ -x /usr/local/bin/claude ] || [ -x /usr/bin/claude ] || npm install -g --silent @anthropic-ai/claude-code </dev/null

# The projects' own tools, from their makers, into root's folders. A run can use them and cannot change them.
${s.goVersion ? `if [ "$(/usr/local/go/bin/go version 2>/dev/null | awk '{print $3}')" != "go${s.goVersion}" ]; then
  curl -fsSL -o /tmp/go.tgz "https://go.dev/dl/go${s.goVersion}.linux-amd64.tar.gz" </dev/null
${s.goSha256 ? `  echo "${s.goSha256}  /tmp/go.tgz" | sha256sum -c --status || { echo "the Go download is not the one its maker published"; rm -f /tmp/go.tgz; exit 1; }
` : ""}  rm -rf /usr/local/go && tar -C /usr/local -xzf /tmp/go.tgz && rm -f /tmp/go.tgz
fi` : "# (no Go asked for)"}
${s.nodeVersion ? `if [ "$(/usr/local/node/bin/node --version 2>/dev/null)" != "v${s.nodeVersion}" ]; then
  curl -fsSL -o /tmp/node.txz "https://nodejs.org/dist/v${s.nodeVersion}/node-v${s.nodeVersion}-linux-x64.tar.xz" </dev/null
${s.nodeSha256 ? `  echo "${s.nodeSha256}  /tmp/node.txz" | sha256sum -c --status || { echo "the Node download is not the one its maker published"; rm -f /tmp/node.txz; exit 1; }
` : ""}  rm -rf /usr/local/node && mkdir -p /usr/local/node && tar -C /usr/local/node --strip-components=1 -xJf /tmp/node.txz && rm -f /tmp/node.txz
  for b in node npm npx; do ln -sf /usr/local/node/bin/$b /usr/local/bin/$b; done
fi` : "# (no Node asked for)"}

install -d -m 0755 /etc/claude-code
cat > /etc/claude-code/managed-settings.json <<'SF_SETTINGS_EOF'
${settings}
SF_SETTINGS_EOF
chown root:root /etc/claude-code/managed-settings.json
chmod 0644 /etc/claude-code/managed-settings.json

cat > /etc/wsl.conf <<'SF_WSLCONF_EOF'
${wslConf(s)}SF_WSLCONF_EOF
chown root:root /etc/wsl.conf
chmod 0644 /etc/wsl.conf

install -d -m 0750 -o ${s.worker} -g ${s.worker} ${s.copies}
echo "room ready"
`;
}

/**
 * How every agent in the room is started, the fence test's and the gate's reader included: three tools and no more,
 * no skills or commands, only the room's own rules and the worker's sign-in (never the project's own Claude
 * settings), and no servers of tools from anywhere.
 */
// Not Write: the room's managed rules allow Read, Edit and Bash, so a run makes a new file with the shell.
export const AGENT_TOOLS = ["Bash", "Read", "Edit"] as const;
export const AGENT_FLAGS = `--tools "${AGENT_TOOLS.join(",")}" --disable-slash-commands --setting-sources user --strict-mcp-config`;
/** The switch that keeps the signed-in account's connectors (mail, files, documents) out of an agent. */
export const AGENT_ENV = "export ENABLE_CLAUDEAI_MCP_SERVERS=false";

/** A usage limit is not a failure of the work: the ticket is parked and returns when the limit does. */
export const looksLikeLimit = (text: string) => /usage limit|rate limit|limit reached|out of extra usage|quota|overloaded|credit balance/i.test(text);
